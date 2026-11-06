namespace NcmGateway;

public sealed record GatewayOptions(long MaxFileBytes, int TimeoutSeconds, string TempRoot)
{
    public const long MultipartOverheadBytes = 64 * 1024;

    public static GatewayOptions FromEnvironment()
    {
        var maxBytes = ReadPositiveNumber("NCM_MAX_FILE_BYTES", 512L * 1024 * 1024, 512L * 1024 * 1024);
        var timeout = ReadPositiveNumber("NCM_TIMEOUT_SECONDS", 300, 3600);
        var tempRoot = Environment.GetEnvironmentVariable("NCM_TEMP_ROOT")
            ?? Path.Combine(Path.GetTempPath(), "hulinger-ncm");
        if (!Path.IsPathFullyQualified(tempRoot))
            throw new InvalidOperationException("NCM_TEMP_ROOT must be an absolute path.");
        Directory.CreateDirectory(tempRoot);
        return new GatewayOptions(maxBytes, (int)timeout, Path.GetFullPath(tempRoot));
    }

    private static long ReadPositiveNumber(string name, long fallback, long maximum)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (value is null) return fallback;
        if (!long.TryParse(value, out var parsed) || parsed < 1 || parsed > maximum)
            throw new InvalidOperationException($"{name} must be an integer between 1 and {maximum}.");
        return parsed;
    }
}
