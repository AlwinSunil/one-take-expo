#!/usr/bin/env python3
"""Verify that the APK contains the exact benchmarked Moonshine runtime and models."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def verify(apk: Path, manifest: Path) -> None:
    hashes = json.loads(manifest.read_text())
    with zipfile.ZipFile(apk) as archive:
        entries = archive.namelist()
        for group, prefix in (("native", "lib/arm64-v8a/"), ("models", "assets/moonshine-tiny/")):
            for name, expected in hashes[group].items():
                path = prefix + name
                if entries.count(path) != 1:
                    raise ValueError(f"Expected exactly one APK entry: {path}")
                with archive.open(path) as source:
                    actual = hashlib.file_digest(source, "sha256").hexdigest()
                if actual != expected:
                    raise ValueError(f"Packaged artifact checksum mismatch: {path}")
            print(f"{group}: {len(hashes[group])} packaged SHA-256 hashes match")
        for name in hashes["native"]:
            unexpected = [entry for entry in entries if entry.startswith("lib/")
                          and entry.endswith("/" + name) and entry != "lib/arm64-v8a/" + name]
            if unexpected:
                raise ValueError(f"Unverified native variants packaged: {unexpected}")
    print("APK contains the verified arm64 Moonshine Tiny Streaming artifacts.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("moonshine-artifacts.json"))
    args = parser.parse_args()
    verify(args.apk, args.manifest)
