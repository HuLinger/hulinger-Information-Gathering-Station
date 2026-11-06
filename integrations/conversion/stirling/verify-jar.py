"""Check the fixed upstream core artifact before it enters the runtime image."""

import hashlib
import io
from pathlib import Path
import sys
import zipfile

EXPECTED_SHA256 = "5cb59682f93bd7d48312d36a87585ef2e8ca9ddfa64bc210dea6bd882925557c"
EXPECTED_SIZE = 232311287


def verify(path: Path) -> None:
    if path.stat().st_size != EXPECTED_SIZE:
        raise ValueError("Unexpected Stirling core JAR size")
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != EXPECTED_SHA256:
            raise ValueError("Unexpected Stirling core JAR SHA-256")

    def check_members(archive: zipfile.ZipFile) -> None:
        for name in archive.namelist():
            normalized = "/" + name.lower()
            if "/stirling/software/proprietary/" in normalized or "/stirling/software/saas/" in normalized:
                raise ValueError("The artifact contains a non-core Stirling module")

    with zipfile.ZipFile(path) as archive:
        check_members(archive)
        for name in archive.namelist():
            if name.startswith("BOOT-INF/lib/") and name.endswith(".jar"):
                with zipfile.ZipFile(io.BytesIO(archive.read(name))) as library:
                    check_members(library)
    print("Verified Stirling-PDF v3.3.0 core JAR checksum and module boundary.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: verify-jar.py /path/to/server.jar")
    verify(Path(sys.argv[1]))
