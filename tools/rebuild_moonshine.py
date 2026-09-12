#!/usr/bin/env python3
"""Reproduce the verified Moonshine 0.1.5 Android arm64 build.

The default mode is a read-only dry run.  Pass ``--execute`` only on a host
that has the pinned Android SDK tools and Git LFS installed.

The build is deliberately separate from the app Gradle build.  Moonshine
0.1.5's stock Android AAR carries ONNX Runtime 1.23.2, while the verified
SM8850 run used the v0.1.5 source rebuilt against the official ONNX Runtime
1.28.0 Android AAR.  This script fetches that runtime, stages its headers and
arm64 library, and builds only the JNI target with CMake.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import urllib.request
import zipfile


SOURCE_URL = "https://github.com/moonshine-ai/moonshine.git"
SOURCE_COMMIT = "234f60faa0eb388b01cdf7e60aca232af37aefda"
MOONSHINE_VERSION = "0.1.5"
ORT_VERSION = "1.28.0"
ORT_AAR_URL = (
    "https://repo1.maven.org/maven2/com/microsoft/onnxruntime/"
    "onnxruntime-android/1.28.0/onnxruntime-android-1.28.0.aar"
)
ORT_AAR_SHA256 = "f351a0638696f54b35184290dbc001d66daae17281ad0b548d2c70347d53b8a9"
ORT_ARM64_SHA256 = "f826d8efb03adf0a84f10e7ba408f9d4cd11b0a2ccd8d08aeb0f7451fb50cacc"
NDK_VERSION = "30.0.16248370"
CMAKE_VERSION = "4.1.2"
ANDROID_API = 26
ANDROID_ABI = "arm64-v8a"

# These are the Git LFS objects needed to satisfy the source build.  The old
# ORT 1.23.2 LFS object is intentionally not fetched; it is replaced by the
# verified ORT 1.28.0 library from ORT_AAR_URL below.
LFS_PREREQUISITES = {
    "core/cpp-annote/src/community1_cpp_annote_embedded.cpp": {
        "sha256": "9424da4176b33e67e4000ea2a776d64b6a78ee9bbf72d40405fb6805d12758c4",
        "size": 2535244,
    },
    "core/moonshine-tts/src/zipvoice-voices-data.cpp": {
        "sha256": "f3e4d62cae93c465e1de8521bc5706b9a20f834cbbf37404bf03f0d35dffa012",
        "size": 11695724,
    },
}

# Hashes from the verified build in /tmp/moonshine-native-rebuild.  Different
# compilers can produce byte-level differences, so these are reported and can
# be enforced with --strict-output after reproducing the pinned toolchain.
KNOWN_OUTPUT_SHA256 = {
    "libmoonshine.so": "a871c01b7fffbbe9f35926b6e70c0e70a9df04b95e95dd1080748d4d7192dc24",
    "libmoonshine-jni.so": "7daef883460c88f676ed2e651965a728631afddf3ea9684413b61a915bad2957",
    "libonnxruntime.so": ORT_ARM64_SHA256,
}


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def shell_command(command: list[str]) -> str:
    return " ".join(shlex_quote(part) for part in command)


def shlex_quote(value: str) -> str:
    """Small POSIX quote helper without importing a shell or executing it."""
    if value and all(char.isalnum() or char in "@%_+=:,./-" for char in value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def run(command: list[str], *, cwd: Path | None = None, execute: bool = True) -> str:
    location = f" (cd {cwd})" if cwd else ""
    print(f"$ {shell_command(command)}{location}")
    if not execute:
        return ""
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    return completed.stdout


def require_file(path: Path, description: str) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"{description} not found: {path}")


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    try:
        temporary.write_bytes(content)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def download_verified(url: str, destination: Path, expected_sha256: str) -> None:
    if destination.is_file() and sha256_file(destination) == expected_sha256:
        print(f"verified cached download: {destination}")
        return
    print(f"downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "one-take-rebuild/1"})
    context = None
    try:
        # Some macOS Python installations do not expose the system CA bundle.
        # certifi is optional so the script remains usable with stdlib only.
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    with urllib.request.urlopen(request, context=context) as response:
        content = response.read()
    actual = sha256_bytes(content)
    if actual != expected_sha256:
        raise RuntimeError(
            f"download checksum mismatch for {url}: expected {expected_sha256}, got {actual}"
        )
    atomic_write(destination, content)


def git_revision(source_dir: Path) -> str | None:
    if not (source_dir / ".git").exists():
        return None
    try:
        return run(["git", "rev-parse", "HEAD"], cwd=source_dir).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def verify_lfs_prerequisites(source_dir: Path) -> None:
    for relative, expected in LFS_PREREQUISITES.items():
        path = source_dir / relative
        require_file(path, "Git LFS prerequisite")
        actual_size = path.stat().st_size
        actual_hash = sha256_file(path)
        if actual_size != expected["size"] or actual_hash != expected["sha256"]:
            raise RuntimeError(
                f"Git LFS prerequisite mismatch: {relative}\n"
                f"  expected {expected['size']} bytes / {expected['sha256']}\n"
                f"  received {actual_size} bytes / {actual_hash}\n"
                "Run git lfs pull for the pinned checkout."
            )
        print(f"verified LFS object: {relative} ({actual_size} bytes)")


def stage_ort(aar_path: Path, source_dir: Path) -> Path:
    require_file(aar_path, "ONNX Runtime Android AAR")
    if sha256_file(aar_path) != ORT_AAR_SHA256:
        raise RuntimeError(f"ONNX Runtime AAR checksum mismatch: {aar_path}")
    ort_root = source_dir / "core/third-party/onnxruntime"
    header_root = ort_root / "include"
    library = ort_root / "lib/android/arm64/libonnxruntime.so"
    with zipfile.ZipFile(aar_path) as archive:
        library_name = "jni/arm64-v8a/libonnxruntime.so"
        try:
            library_bytes = archive.read(library_name)
        except KeyError as error:
            raise RuntimeError(f"ORT AAR has no {library_name}") from error
        if sha256_bytes(library_bytes) != ORT_ARM64_SHA256:
            raise RuntimeError("ONNX Runtime arm64 library checksum mismatch")
        headers = {
            name.removeprefix("headers/"): archive.read(name)
            for name in archive.namelist()
            if name.startswith("headers/") and not name.endswith("/")
        }
    if not headers:
        raise RuntimeError("ONNX Runtime AAR has no C/C++ headers")
    for name, content in headers.items():
        atomic_write(header_root / name, content)
    atomic_write(library, library_bytes)
    print(f"staged ORT {ORT_VERSION} headers: {len(headers)} files")
    print(f"staged verified ORT arm64 library: {library}")
    return library


def prepare_source(source_dir: Path, *, execute: bool) -> None:
    if not source_dir.exists():
        if not execute:
            print(f"dry-run: would clone {SOURCE_URL} at {SOURCE_COMMIT} into {source_dir}")
            return
        source_dir.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--filter=blob:none", "--no-checkout", SOURCE_URL, str(source_dir)])
        run(["git", "checkout", "--detach", SOURCE_COMMIT], cwd=source_dir)
    revision = git_revision(source_dir)
    if revision is not None and revision != SOURCE_COMMIT:
        raise RuntimeError(
            f"Moonshine source revision mismatch: expected {SOURCE_COMMIT}, got {revision}"
        )
    if not execute:
        print(f"dry-run: source revision {revision or '<checkout unavailable>'}")
        return
    require_file(source_dir / ".git/HEAD", "Moonshine Git checkout")
    run(["git", "lfs", "install", "--local"], cwd=source_dir)
    include = ",".join(LFS_PREREQUISITES)
    run(["git", "lfs", "pull", "--include", include], cwd=source_dir)
    verify_lfs_prerequisites(source_dir)


def find_tool(name: str, sdk_candidate: Path | None = None) -> str:
    if sdk_candidate is not None:
        if not sdk_candidate.is_file():
            raise FileNotFoundError(
                f"Pinned {name} executable not found: {sdk_candidate}"
            )
        if not os.access(sdk_candidate, os.X_OK):
            raise PermissionError(f"Pinned {name} is not executable: {sdk_candidate}")
        return str(sdk_candidate)
    found = shutil.which(name)
    if found is None:
        raise FileNotFoundError(f"Required tool not found: {name}")
    return found


def sdk_root(args: argparse.Namespace) -> Path:
    configured = args.sdk or os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME")
    return Path(configured).expanduser() if configured else Path.home() / "Library/Android/sdk"


def ndk_root(args: argparse.Namespace, sdk: Path) -> Path:
    configured = args.ndk or os.environ.get("ANDROID_NDK_ROOT") or os.environ.get("ANDROID_NDK_HOME")
    return Path(configured).expanduser() if configured else sdk / "ndk" / NDK_VERSION


def cmake_and_ninja(sdk: Path) -> tuple[str, str]:
    candidate_dir = sdk / "cmake" / CMAKE_VERSION / "bin"
    return (
        find_tool("cmake", candidate_dir / "cmake"),
        find_tool("ninja", candidate_dir / "ninja"),
    )


def verify_ndk_version(ndk: Path) -> None:
    properties = ndk / "source.properties"
    require_file(properties, "Android NDK metadata")
    revision = None
    for line in properties.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "Pkg.Revision":
            revision = value.strip()
            break
    if revision != NDK_VERSION:
        raise RuntimeError(
            f"Android NDK revision mismatch: expected {NDK_VERSION}, got {revision or '<missing>'}"
        )


def verify_cmake_version(cmake: str) -> None:
    output = run([cmake, "--version"])
    first_line = output.splitlines()[0] if output.splitlines() else ""
    if f"cmake version {CMAKE_VERSION}" not in first_line:
        raise RuntimeError(
            f"CMake version mismatch: expected {CMAKE_VERSION}, got {first_line or '<missing>'}"
        )


def build_native(
    source_dir: Path,
    build_dir: Path,
    output_dir: Path,
    *,
    ndk: Path,
    cmake: str,
    ninja: str,
    jobs: int,
    execute: bool,
) -> None:
    require_file(ndk / "build/cmake/android.toolchain.cmake", "Android NDK toolchain")
    toolchain = ndk / "build/cmake/android.toolchain.cmake"
    configure = [
        cmake,
        "-S",
        str(source_dir / "core"),
        "-B",
        str(build_dir),
        "-G",
        "Ninja",
        f"-DCMAKE_MAKE_PROGRAM={ninja}",
        f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
        f"-DANDROID_ABI={ANDROID_ABI}",
        f"-DANDROID_PLATFORM=android-{ANDROID_API}",
        "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",
        "-DCMAKE_BUILD_TYPE=RelWithDebInfo",
        "-DMOONSHINE_BUILD_SHARED=ON",
        "-DMOONSHINE_TTS_BUILD_ONNX=ON",
    ]
    run(configure, execute=execute)
    run(
        [cmake, "--build", str(build_dir), "--target", "moonshine-jni", "--parallel", str(jobs)],
        execute=execute,
    )
    if not execute:
        print(f"dry-run: native outputs would be copied to {output_dir}")
        return

    built = {
        "libmoonshine.so": build_dir / "libmoonshine.so",
        "libmoonshine-jni.so": build_dir / "moonshine-jni/libmoonshine-jni.so",
        "libonnxruntime.so": source_dir / "core/third-party/onnxruntime/lib/android/arm64/libonnxruntime.so",
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, path in built.items():
        require_file(path, f"native build output {name}")
        destination = output_dir / name
        shutil.copy2(path, destination)
        print(f"{name}: {sha256_file(destination)}")


def verify_known_outputs(output_dir: Path, *, strict: bool) -> None:
    mismatches = []
    for name, expected in KNOWN_OUTPUT_SHA256.items():
        path = output_dir / name
        require_file(path, "native output")
        actual = sha256_file(path)
        if actual != expected:
            mismatches.append(f"{name}: expected {expected}, got {actual}")
    if mismatches and strict:
        raise RuntimeError("Known output checksum mismatch:\n" + "\n".join(mismatches))
    if mismatches:
        print("output checksum differences (toolchain drift; not fatal):")
        for mismatch in mismatches:
            print(f"  {mismatch}")
    else:
        print("known native output checksums match the verified build")


def dry_run(args: argparse.Namespace) -> None:
    root = Path(__file__).resolve().parent.parent
    work = (args.work_dir or root / "tools/.cache/moonshine-rebuild").expanduser()
    source = (args.source_dir or work / "source").expanduser()
    aar = (args.ort_aar or work / "onnxruntime-android-1.28.0.aar").expanduser()
    build = (args.build_dir or work / "build-arm64").expanduser()
    output = (args.output_dir or work / "out/arm64-v8a").expanduser()
    print("Moonshine native rebuild dry run")
    print(f"source: {SOURCE_URL}@{SOURCE_COMMIT}")
    print(f"runtime: ONNX Runtime Android {ORT_VERSION} SHA-256 {ORT_AAR_SHA256}")
    print(f"target: {ANDROID_ABI}, Android API {ANDROID_API}, NDK {NDK_VERSION}, CMake {CMAKE_VERSION}")
    prepare_source(source, execute=False)
    if source.is_dir():
        for relative, expected in LFS_PREREQUISITES.items():
            path = source / relative
            if path.is_file():
                actual = sha256_file(path)
                print(f"LFS check {relative}: {actual == expected['sha256']}")
            else:
                print(f"dry-run: would fetch LFS object {relative}")
    if aar.is_file():
        print(f"ORT AAR present: {aar} ({sha256_file(aar) == ORT_AAR_SHA256})")
    else:
        print(f"dry-run: would download and verify {ORT_AAR_URL} -> {aar}")
    print(f"dry-run: would extract ORT headers and {ORT_ARM64_SHA256} to the pinned source tree")
    print(f"dry-run: would configure build directory {build}")
    print(f"dry-run: would copy verified outputs to {output}")
    print("No network, source mutation, CMake, Ninja, or Gradle command was run.")


def execute(args: argparse.Namespace) -> None:
    root = Path(__file__).resolve().parent.parent
    work = (args.work_dir or root / "tools/.cache/moonshine-rebuild").expanduser()
    source = (args.source_dir or work / "source").expanduser()
    aar = (args.ort_aar or work / "onnxruntime-android-1.28.0.aar").expanduser()
    build = (args.build_dir or work / "build-arm64").expanduser()
    output = (args.output_dir or work / "out/arm64-v8a").expanduser()
    sdk = sdk_root(args)
    ndk = ndk_root(args, sdk)
    cmake, ninja = cmake_and_ninja(sdk)
    verify_ndk_version(ndk)
    verify_cmake_version(cmake)

    prepare_source(source, execute=True)
    if not source.is_dir():
        raise RuntimeError(f"source checkout unavailable: {source}")
    verify_lfs_prerequisites(source)
    download_verified(ORT_AAR_URL, aar, ORT_AAR_SHA256)
    stage_ort(aar, source)
    build_native(
        source,
        build,
        output,
        ndk=ndk,
        cmake=cmake,
        ninja=ninja,
        jobs=args.jobs,
        execute=True,
    )
    verify_known_outputs(output, strict=args.strict_output)
    report = {
        "source": {"url": SOURCE_URL, "commit": SOURCE_COMMIT},
        "runtime": {
            "version": ORT_VERSION,
            "aar_url": ORT_AAR_URL,
            "aar_sha256": ORT_AAR_SHA256,
            "arm64_sha256": ORT_ARM64_SHA256,
        },
        "target": {
            "abi": ANDROID_ABI,
            "android_api": ANDROID_API,
            "ndk": NDK_VERSION,
            "cmake": CMAKE_VERSION,
        },
        "outputs": {name: sha256_file(output / name) for name in KNOWN_OUTPUT_SHA256},
    }
    output.joinpath("build-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"wrote {output / 'build-manifest.json'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="print and inspect the plan (default)")
    mode.add_argument("--execute", action="store_true", help="clone/download/configure/build the native target")
    parser.add_argument("--work-dir", type=Path, help="cache root for source, AAR, build, and outputs")
    parser.add_argument("--source-dir", type=Path, help="existing Moonshine checkout")
    parser.add_argument("--ort-aar", type=Path, help="cached official ORT 1.28.0 Android AAR")
    parser.add_argument("--build-dir", type=Path, help="CMake build directory")
    parser.add_argument("--output-dir", type=Path, help="directory for copied native outputs")
    parser.add_argument("--sdk", type=Path, help="Android SDK root")
    parser.add_argument("--ndk", type=Path, help="Android NDK root")
    parser.add_argument("--jobs", type=int, default=8, help="native build parallelism (default: 8)")
    parser.add_argument(
        "--strict-output",
        action="store_true",
        help="fail if output bytes differ from the recorded verified build",
    )
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    return args


def main() -> int:
    args = parse_args()
    try:
        if args.execute:
            execute(args)
        else:
            dry_run(args)
    except (FileNotFoundError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
