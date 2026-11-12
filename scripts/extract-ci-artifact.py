"""Extract a verified Actions ZIP into a new directory, with bounded safe paths."""
import pathlib
import stat
import sys
import zipfile


def extract(archive, destination):
    target = pathlib.Path(destination)
    if target.exists():
        raise ValueError("Artifact output directory must not already exist")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > 256:
            raise ValueError("Unexpected artifact ZIP file count")
        names = set()
        total = 0
        for entry in entries:
            name = entry.filename.rstrip("/") if entry.is_dir() else entry.filename
            parts = name.split("/")
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (not name or "\\" in name or ":" in name or name in names
                    or any(part in ("", ".", "..") for part in parts)
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or (kind == stat.S_IFDIR and not entry.is_dir())
                    or entry.flag_bits & 1
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ValueError("Unsafe artifact ZIP entry")
            names.add(name)
            total += entry.file_size
            if total > 1024 * 1024 * 1024:
                raise ValueError("Artifact ZIP expands beyond its size limit")
        target.mkdir(parents=True, exist_ok=False)
        for entry in entries:
            path = target.joinpath(*entry.filename.rstrip("/").split("/"))
            if entry.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with source.open(entry) as incoming, path.open("xb") as outgoing:
                written = 0
                while chunk := incoming.read(1024 * 1024):
                    written += len(chunk)
                    if written > entry.file_size:
                        raise ValueError("Artifact ZIP entry exceeded its declared size")
                    outgoing.write(chunk)
                if written != entry.file_size:
                    raise ValueError("Artifact ZIP entry was truncated")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 scripts/extract-ci-artifact.py archive.zip output-directory")
    extract(sys.argv[1], sys.argv[2])
