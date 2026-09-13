"""Experimental local ONNX acoustic benchmark. No bundled/selected filler model.

Models must implement the explicitly documented raw-waveform frame-score ABI.
This runner does not turn quiet audio, transcript omissions or random weights
into filler evidence. Predictions are review marks, never safe cut boundaries.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import tempfile
import time
import wave

from audio import inspect_wave, windows

MAX_WINDOWS = 100_000
MAX_EVENTS = 100_000


def same_path(left, right):
    """Resolve aliases, including case/normalization aliases on APFS."""
    return Path(left).resolve() == Path(right).resolve() or (
        Path(left).exists() and Path(right).exists() and os.path.samefile(left, right)
    )


def integer(value, name, low=1, high=1_000_000):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer in [{low}, {high}]")
    return value


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_manifest(path):
    manifest = json.loads(Path(path).read_text())
    if not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1:
        raise ValueError("Expected model manifest schemaVersion 1")
    for key in ("id", "version", "modelFile", "inputName", "outputName", "license", "source"):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip():
            raise ValueError(f"Missing model manifest {key}")
    if not isinstance(manifest.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"]):
        raise ValueError("Model sha256 must be a lowercase SHA-256 digest")
    if manifest.get("labels") != ["other", "um", "uh"]:
        raise ValueError("Output labels must be ordered [other, um, uh]")
    integer(manifest.get("sampleRate"), "sampleRate", 8000, 48000)
    integer(manifest.get("windowSamples"), "windowSamples", 1, 480000)
    integer(manifest.get("hopSamples"), "hopSamples", 1, manifest["windowSamples"])
    integer(manifest.get("frameSamples"), "frameSamples", 1, manifest["hopSamples"])
    if manifest["windowSamples"] % manifest["frameSamples"] or manifest["hopSamples"] % manifest["frameSamples"]:
        raise ValueError("Window and hop must be multiples of frameSamples")
    if manifest.get("outputKind") != "frame-scores" or manifest.get("inputKind") != "pcm-float32":
        raise ValueError("Only pcm-float32 -> frame-scores models are supported")
    return manifest


class OnnxModel:
    def __init__(self, manifest, manifest_path):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        self.manifest = manifest
        model_path = Path(manifest_path).resolve().parent / manifest["modelFile"]
        if model_path.stat().st_size > 256 * 1024 * 1024:
            raise ValueError("Benchmark model exceeds 256 MiB limit")
        model_bytes = model_path.read_bytes()
        if hashlib.sha256(model_bytes).hexdigest() != manifest["sha256"]:
            raise ValueError("Model hash does not match manifest")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        # Loading the verified bytes also excludes unpinned external-data files.
        try:
            self.session = ort.InferenceSession(model_bytes, sess_options=options, providers=["CPUExecutionProvider"])
        except Exception as error:
            raise ValueError(f"Cannot load verified ONNX model: {error}") from error
        inputs = self.session.get_inputs()
        if len(inputs) != 1 or inputs[0].name != manifest["inputName"] or inputs[0].type != "tensor(float)":
            raise ValueError("Model must have one named float32 waveform input")
        shape = inputs[0].shape
        if len(shape) != 2 or any(isinstance(actual, int) and actual != expected
                                  for actual, expected in zip(shape, [1, manifest["windowSamples"]])):
            raise ValueError("Expected model input [1, windowSamples]")
        self.runtime_version = ort.__version__

    def predict(self, samples):
        m = self.manifest
        try:
            output = self.session.run([m["outputName"]], {m["inputName"]: self.np.asarray([samples], dtype=self.np.float32)})[0]
        except Exception as error:
            raise ValueError(f"ONNX inference failed: {error}") from error
        expected = (1, m["windowSamples"] // m["frameSamples"], 3)
        if output.shape != expected:
            raise ValueError(f"Expected output shape {expected}, got {output.shape}")
        return output[0].tolist()


def detect(path, manifest, predict, source_id, revision, threshold=0.9):
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("sourceId must be non-empty")
    integer(revision, "analysisRevision", 0, 2**53 - 1)
    if isinstance(threshold, bool) or not isinstance(threshold, (float, int)) or not math.isfinite(threshold) or not 0 < threshold <= 1:
        raise ValueError("threshold must be finite in (0, 1]")
    m = manifest
    rate, frame = m["sampleRate"], m["frameSamples"]
    count = inspect_wave(path, rate)
    if math.ceil(count / m["hopSamples"]) > MAX_WINDOWS:
        raise ValueError("Audio/model combination exceeds analysis window budget")
    source_hash = sha256(path)
    duration = count / rate
    events = []
    active = None
    window_count = 0
    next_sample = 0
    started = time.perf_counter()
    for window in windows(path, rate, m["windowSamples"], m["hopSamples"]):
        scores = predict(window.samples)
        window_count += 1
        if len(scores) != m["windowSamples"] // frame:
            raise ValueError("Incorrect frame-score count")
        # Each source frame is owned by exactly one window. No duplicate event
        # or artificial confidence boost from overlapping inference windows.
        last = window.start_sample + window.valid_samples >= count
        owned = window.valid_samples if last else m["hopSamples"]
        for index, row in enumerate(scores):
            if not isinstance(row, (list, tuple)) or len(row) != 3 or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in row
            ):
                raise ValueError("Model must return finite scores in [0, 1]")
            offset = index * frame
            if offset >= owned:
                continue
            start = window.start_sample + offset
            if start != next_sample:
                raise ValueError("Non-contiguous source frame mapping")
            end = min(start + frame, count)
            next_sample = end
            winner = max(range(3), key=lambda i: row[i])
            # Ties are ambiguous. A raw model score is not calibrated confidence.
            label = m["labels"][winner] if winner and row[winner] >= threshold and row.count(row[winner]) == 1 else None
            if active and (label is None or label != active["label"]):
                events.append(active)
                if len(events) >= MAX_EVENTS:
                    raise ValueError("Analysis exceeds event budget")
                active = None
            if label:
                if active is None:
                    active = {"id": f"{source_id}:filler:{revision}:{start}:{label}", "startSeconds": start / rate,
                              "endSeconds": end / rate, "label": label, "score": row[winner],
                              "timingUncertaintySeconds": None, "timingResolutionSeconds": frame / rate}
                else:
                    active["endSeconds"] = end / rate
                    active["score"] = min(active["score"], row[winner])
    if active:
        events.append(active)
    if next_sample != count:
        raise ValueError("Incomplete audio analysis")
    if sha256(path) != source_hash:
        raise ValueError("Source audio changed during analysis; discard results and retry")
    elapsed = time.perf_counter() - started
    return {"schemaVersion": 1, "status": "ready", "sourceId": source_id, "analysisRevision": revision,
            "durationSeconds": duration, "model": {"id": m["id"], "version": m["version"]},
            "actualProcessor": "cpu", "events": events,
            "provenance": {"source": "host-audio", "audioSha256": source_hash, "modelSha256": m["sha256"],
                           "sampleRate": rate, "threshold": threshold, "timingSource": "decoded-pcm-samples",
                           "scoreMeaning": "uncalibrated-model-score", "boundaryStatus": "unverified",
                           "timingNote": "Frame quantization only; model boundary error is not measured.",
                           "releaseValidated": False},
            "benchmark": {"windowCount": window_count, "processingSeconds": elapsed,
                          "realTimeFactor": elapsed / duration, "host": platform.machine()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="Mono PCM16 WAV at model sample rate")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--revision", required=True, type=int)
    parser.add_argument("--threshold", type=float, default=0.9)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = read_manifest(args.manifest)
        model_path = args.manifest.resolve().parent / manifest["modelFile"]
        protected = (args.audio, args.manifest, model_path)
        if any(same_path(args.output, path) for path in protected):
            raise ValueError("Output must not overwrite audio, manifest or model")
        model = OnnxModel(manifest, args.manifest)
        result = detect(args.audio, manifest, model.predict, args.source_id, args.revision, args.threshold)
        result["provenance"]["runtime"] = f"onnxruntime-{model.runtime_version}-CPUExecutionProvider"
        # Publish complete results only. Failure never writes an empty success.
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, delete=False) as stream:
                temporary = stream.name
                json.dump(result, stream, indent=2, allow_nan=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            if any(same_path(args.output, path) for path in protected):
                raise ValueError("Output aliases a protected source")
            os.replace(temporary, args.output)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    except (ValueError, OSError, ImportError, RuntimeError, EOFError, wave.Error) as error:
        parser.exit(2, f"Acoustic analysis unavailable: {error}\n")


if __name__ == "__main__":
    main()
