using System.Buffers.Binary;

namespace NcmGateway;

// Reject oversized or truncated cover allocations before the upstream parser allocates its buffers.
public static class NcmHeaderGuard
{
    public static void Validate(string path)
    {
        using var stream = File.OpenRead(path);
        Span<byte> magic = stackalloc byte[8];
        try
        {
            stream.ReadExactly(magic);
            if (!magic.SequenceEqual("CTENFDAM"u8)) throw InvalidFile();
            Skip(stream, 2);
            var keyLength = ReadUInt32(stream);
            if (keyLength is 0 or > 1024) throw InvalidFile();
            Skip(stream, keyLength);
            var metadataLength = ReadUInt32(stream);
            if (metadataLength > 1024 * 1024) throw InvalidFile();
            Skip(stream, metadataLength);
            Skip(stream, 5);
            var coverFrameLength = ReadUInt32(stream);
            var coverDataLength = ReadUInt32(stream);
            if (coverDataLength > 16 * 1024 * 1024 || coverDataLength > coverFrameLength)
                throw InvalidFile();
            Skip(stream, coverFrameLength);
            if (stream.Length - stream.Position < 4) throw InvalidFile();
        }
        catch (EndOfStreamException) { throw InvalidFile(); }
    }

    private static uint ReadUInt32(Stream stream)
    {
        Span<byte> buffer = stackalloc byte[4];
        stream.ReadExactly(buffer);
        return BinaryPrimitives.ReadUInt32LittleEndian(buffer);
    }

    private static void Skip(Stream stream, long count)
    {
        if (count > stream.Length - stream.Position) throw InvalidFile();
        stream.Seek(count, SeekOrigin.Current);
    }

    private static GatewayException InvalidFile()
        => new(422, "INVALID_NCM", "NCM 文件头无效、损坏或内嵌封面超过 16 MiB。");
}
