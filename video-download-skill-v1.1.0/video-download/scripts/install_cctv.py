"""Install the pinned upstream Windows CLI; never execute downloaded installers."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

VERSION = "v4.4.4"
URL = f"https://github.com/letr007/CCTVVideoDownloader/releases/download/{VERSION}/cctv-dl.{VERSION}.win.x64.zip"
SHA256 = "ed251185cab5ee49f1e8d7681937df3c3b4fb263c9c99963e5a33c8f5e811e24"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proxy", default="")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("This installer is Windows x64 only; install the matching upstream CLI and use --cctv-cli.")
    root = Path(__file__).resolve().parents[1] / "tools" / "cctv-dl" / VERSION
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": args.proxy}) if args.proxy else urllib.request.ProxyHandler())
    with tempfile.TemporaryDirectory(prefix="cctv-install-") as temporary:
        archive = Path(temporary) / "release.zip"
        with opener.open(URL, timeout=60) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
            raise RuntimeError("Release checksum mismatch; installation stopped")
        root.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as package:
            for item in package.infolist():
                if not (root / item.filename).resolve().is_relative_to(root.resolve()):
                    raise RuntimeError("Unsafe archive path")
            package.extractall(root)
    print(root / "cctv-dl" / "bin" / "cctv-dl.exe")


if __name__ == "__main__":
    main()
