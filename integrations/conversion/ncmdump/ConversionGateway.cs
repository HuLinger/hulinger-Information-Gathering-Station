using System.Buffers;
using LibNCM;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Net.Http.Headers;

namespace NcmGateway;

public sealed class ConversionGateway(GatewayOptions options, ILogger<ConversionGateway> logger)
{
    private readonly SemaphoreSlim conversionSlot = new(1, 1);

    public async Task ConvertAsync(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        if (context.Request.Query.Count != 0)
        {
            await ErrorAsync(context, 400, "INVALID_REQUEST", "只接受一个 file 文件字段，不接受其他参数。");
            return;
        }
        if (context.Request.ContentLength > options.MaxFileBytes + GatewayOptions.MultipartOverheadBytes)
        {
            await ErrorAsync(context, 413, "FILE_TOO_LARGE", "文件超过转换服务大小限制。");
            return;
        }
        if (!await conversionSlot.WaitAsync(0, context.RequestAborted))
        {
            context.Response.Headers.RetryAfter = "2";
            await ErrorAsync(context, 429, "CONVERTER_BUSY", "转换服务正在处理其他文件，请稍后重试。");
            return;
        }

        string? requestDirectory = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(options.TimeoutSeconds));
        try
        {
            if (!MediaTypeHeaderValue.TryParse(context.Request.ContentType, out var contentType)
                || !string.Equals(contentType.MediaType.Value, "multipart/form-data", StringComparison.OrdinalIgnoreCase))
                throw new GatewayException(415, "INVALID_CONTENT_TYPE", "请使用 multipart/form-data 上传 NCM 文件。");
            var boundary = HeaderUtilities.RemoveQuotes(contentType.Boundary).Value;
            if (string.IsNullOrEmpty(boundary) || boundary.Length > 128)
                throw new GatewayException(400, "INVALID_MULTIPART", "上传请求格式不正确。");

            requestDirectory = Path.Combine(options.TempRoot, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(requestDirectory);
            var inputPath = Path.Combine(requestDirectory, "input.ncm");
            var reader = new MultipartReader(boundary, context.Request.Body)
            {
                HeadersCountLimit = 8,
                HeadersLengthLimit = 16 * 1024,
            };
            var section = await reader.ReadNextSectionAsync(timeout.Token);
            if (section is null
                || !ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition)
                || !disposition.IsFileDisposition()
                || HeaderUtilities.RemoveQuotes(disposition.Name).Value != "file")
                throw new GatewayException(400, "INVALID_REQUEST", "请上传一个名为 file 的 NCM 文件字段。");
            var suppliedName = HeaderUtilities.RemoveQuotes(disposition.FileNameStar.HasValue
                ? disposition.FileNameStar : disposition.FileName).Value ?? "";
            var downloadBase = SafeDownloadBase(suppliedName);
            await CopyInputAsync(section.Body, inputPath, timeout.Token);
            if (await reader.ReadNextSectionAsync(timeout.Token) is not null)
                throw new GatewayException(400, "INVALID_REQUEST", "一次只能上传一个 NCM 文件，不能附加其他字段。");

            NcmHeaderGuard.Validate(inputPath);
            var result = await NcmProcessor.ProcessAsync(inputPath, requestDirectory, "output",
                new NcmProcessOptions { FetchCoverArt = false },
                coverArtProvider: new NoNetworkCoverProvider(), cancellationToken: timeout.Token);
            timeout.Token.ThrowIfCancellationRequested();
            if (!result.Success || result.OutputPath is null)
                throw new GatewayException(422, "INVALID_NCM", "NCM 文件无效、损坏或无法解码。");
            if (result.Format is not (NcmFormat.Mp3 or NcmFormat.Flac))
                throw new GatewayException(422, "UNSUPPORTED_AUDIO", "NCM 中的音频格式不受支持。");

            var extension = result.Format == NcmFormat.Mp3 ? ".mp3" : ".flac";
            var mime = result.Format == NcmFormat.Mp3 ? "audio/mpeg" : "audio/flac";
            if (result.MetadataWarning is not null)
                context.Response.Headers["X-Conversion-Warning"] = "METADATA_NOT_WRITTEN";
            await using var output = File.OpenRead(result.OutputPath);
            if (output.Length == 0)
                throw new GatewayException(422, "EMPTY_AUDIO", "NCM 文件未产生有效音频。");
            // Execute the response before the finally block removes its backing file.
            await Results.File(output, mime, downloadBase + extension, enableRangeProcessing: false)
                .ExecuteAsync(context);
        }
        catch (GatewayException error)
        {
            await ErrorAsync(context, error.Status, error.Code, error.Message);
        }
        catch (BadHttpRequestException error)
        {
            var tooLarge = error.StatusCode == 413;
            await ErrorAsync(context, tooLarge ? 413 : 400, tooLarge ? "FILE_TOO_LARGE" : "INVALID_REQUEST",
                tooLarge ? "文件超过转换服务大小限制。" : "上传请求不完整或格式不正确。");
        }
        catch (InvalidDataException)
        {
            await ErrorAsync(context, 400, "INVALID_MULTIPART", "上传请求不完整或格式不正确。");
        }
        catch (OperationCanceledException)
        {
            if (!context.RequestAborted.IsCancellationRequested)
                await ErrorAsync(context, 504, "CONVERSION_TIMEOUT", "转换超时，请稍后重试。");
        }
        catch (Exception)
        {
            logger.LogError("Conversion failed with code {Code}", "CONVERSION_FAILED");
            await ErrorAsync(context, 500, "CONVERSION_FAILED", "转换服务处理失败，请稍后重试。");
        }
        finally
        {
            if (requestDirectory is not null)
            {
                try { Directory.Delete(requestDirectory, recursive: true); }
                catch (Exception) { logger.LogError("Temporary file cleanup failed with code {Code}", "CLEANUP_FAILED"); }
            }
            conversionSlot.Release();
        }
    }

    private async Task CopyInputAsync(Stream input, string destination, CancellationToken cancellationToken)
    {
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        long total = 0;
        try
        {
            int bytesRead;
            while ((bytesRead = await input.ReadAsync(buffer.AsMemory(), cancellationToken)) != 0)
            {
                total += bytesRead;
                if (total > options.MaxFileBytes)
                    throw new GatewayException(413, "FILE_TOO_LARGE", "文件超过转换服务大小限制。");
                await output.WriteAsync(buffer.AsMemory(0, bytesRead), cancellationToken);
            }
            if (total == 0)
                throw new GatewayException(422, "EMPTY_FILE", "上传的 NCM 文件为空。");
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    private static string SafeDownloadBase(string filename)
    {
        var basename = filename.Replace('\\', '/').Split('/').Last();
        if (!basename.EndsWith(".ncm", StringComparison.OrdinalIgnoreCase))
            throw new GatewayException(415, "UNSUPPORTED_FILE", "仅支持 .ncm 文件。");
        var name = basename[..^4];
        name = string.Concat(name.Where(character => !char.IsControl(character) && !"<>:\"/\\|?*".Contains(character)));
        name = name.Trim().Trim('.');
        if (name.Length > 100) name = name[..100];
        return string.IsNullOrWhiteSpace(name) ? "converted" : name;
    }

    private static async Task ErrorAsync(HttpContext context, int status, string code, string message)
    {
        if (context.Response.HasStarted) { context.Abort(); return; }
        await Results.Json(new { code, message }, statusCode: status).ExecuteAsync(context);
    }

    private sealed class NoNetworkCoverProvider : ICoverArtProvider
    {
        public Task<byte[]?> FetchAsync(string url, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("Remote cover fetching is disabled.");
    }
}

public sealed class GatewayException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}
