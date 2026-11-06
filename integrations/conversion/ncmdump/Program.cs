using NcmGateway;
using System.Text.Json;

if (args.Length == 1 && args[0] == "--healthcheck")
{
    try
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        using var response = await client.GetAsync("http://127.0.0.1:8080/health");
        response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Environment.ExitCode = body.RootElement.GetProperty("status").GetString() == "ok" ? 0 : 1;
    }
    catch (Exception)
    {
        Environment.ExitCode = 1;
    }
    return;
}

var builder = WebApplication.CreateBuilder(args);
var options = GatewayOptions.FromEnvironment();
builder.WebHost.ConfigureKestrel(server =>
{
    server.Limits.MaxRequestBodySize = options.MaxFileBytes + GatewayOptions.MultipartOverheadBytes;
    server.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(15);
});
// Framework request logs may include untrusted URLs; this service logs only stable error codes.
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole();
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Services.AddSingleton(options);
builder.Services.AddSingleton<ConversionGateway>();

var app = builder.Build();
app.MapGet("/health", () => Results.Json(new { status = "ok" }));
app.MapPost("/convert", async (HttpContext context, ConversionGateway gateway) =>
    await gateway.ConvertAsync(context));
app.Run();
