#!/usr/bin/env python3
"""Stage the pinned Moonshine Tiny model and the verified Android runtime.

The published Moonshine AAR contains a stock ONNX Runtime that is not safe on
the benchmarked SM8850 device. This script creates a deterministic Java-only
copy of that AAR and supplies the rebuilt arm64 libraries separately.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import ssl
import urllib.request
import zipfile


MODEL_URL = (
    "https://download.moonshine.ai/model/tiny-streaming-en/"
    "quantized_26_08_21/"
)
MOONSHINE_AAR_URL = (
    "https://repo1.maven.org/maven2/ai/moonshine/moonshine-voice/0.1.5/"
    "moonshine-voice-0.1.5.aar"
)
MOONSHINE_AAR_SHA256 = (
    "ee2d95c21150683c743db8f3aef66281fd5408bcefc94be3ca1d2545ada1f571"
)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def stage_bytes(target: Path, content: bytes, expected: str) -> None:
    if target.is_file() and digest(target) == expected:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part")
    try:
        temporary.write_bytes(content)
        if digest(temporary) != expected:
            raise RuntimeError(f"Artifact checksum mismatch: {target.name}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def stage_file(target: Path, source: Path, expected: str) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Missing native library: {source}")
    if digest(source) != expected:
        raise RuntimeError(f"Native library checksum mismatch: {source.name}")
    if target.is_file() and digest(target) == expected:
        return
    stage_bytes(target, source.read_bytes(), expected)


def download_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "one-take-build/1"})
    context = None
    try:
        # The macOS framework Python does not always include the system CA
        # bundle. certifi is already present in the development environment,
        # while the fallback keeps the script dependency-free elsewhere.
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    with urllib.request.urlopen(request, context=context) as response:
        return response.read()


def find_cached_aar() -> Path | None:
    roots = []
    configured_gradle_home = os.environ.get("GRADLE_USER_HOME")
    if configured_gradle_home:
        roots.append(Path(configured_gradle_home))
    roots.append(Path.home() / ".gradle")
    relative = Path(
        "caches/modules-2/files-2.1/ai.moonshine/moonshine-voice/0.1.5"
    )
    for root in roots:
        candidates = sorted((root / relative).glob("*/*.aar"))
        if candidates:
            return candidates[0]
    return None


def java_only_aar(source: bytes) -> bytes:
    """Remove native files and the source AAR's minSdk/network manifest."""
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(source)) as source_zip, zipfile.ZipFile(
        output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as target_zip:
        names = sorted(name for name in source_zip.namelist() if not name.startswith("jni/"))
        for name in names:
            if name == "AndroidManifest.xml":
                content = b'''<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="ai.moonshine.voice" />
'''
            else:
                content = source_zip.read(name)
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            target_zip.writestr(info, content)
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--native-dir",
        type=Path,
        required=True,
        help="Directory containing the verified rebuilt arm64 libraries",
    )
    parser.add_argument(
        "--moonshine-aar",
        type=Path,
        help="Optional path to the downloaded Moonshine 0.1.5 AAR",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    manifest = json.loads((project_root / "tools/moonshine-artifacts.json").read_text())
    cache_root = project_root / "tools/.cache/moonshine"
    model_root = cache_root / "assets/moonshine-tiny"
    native_root = cache_root / "jniLibs/arm64-v8a"

    for name, expected in manifest["models"].items():
        target = model_root / name
        if target.is_file() and digest(target) == expected:
            continue
        content = download_bytes(MODEL_URL + name)
        if hashlib.sha256(content).hexdigest() != expected:
            raise RuntimeError(f"Model checksum mismatch: {name}")
        stage_bytes(target, content, expected)

    for name, expected in manifest["native"].items():
        stage_file(native_root / name, args.native_dir / name, expected)

    aar_path = args.moonshine_aar or find_cached_aar()
    if aar_path is not None:
        aar_bytes = aar_path.read_bytes()
    else:
        aar_bytes = download_bytes(MOONSHINE_AAR_URL)
    if hashlib.sha256(aar_bytes).hexdigest() != MOONSHINE_AAR_SHA256:
        raise RuntimeError("Moonshine 0.1.5 AAR checksum mismatch")
    stripped = java_only_aar(aar_bytes)
    with zipfile.ZipFile(io.BytesIO(stripped)) as archive:
        if any(name.startswith("jni/") for name in archive.namelist()):
            raise RuntimeError("Stripped Moonshine AAR still contains native libraries")
        if "classes.jar" not in archive.namelist():
            raise RuntimeError("Stripped Moonshine AAR has no classes.jar")
    stage_bytes(
        project_root / "modules/one-take-captions/android/libs/moonshine-voice-0.1.5-java.aar",
        stripped,
        hashlib.sha256(stripped).hexdigest(),
    )
    print("Moonshine Tiny model, Java facade, and rebuilt arm64 libraries are staged and verified.")


if __name__ == "__main__":
    main()
