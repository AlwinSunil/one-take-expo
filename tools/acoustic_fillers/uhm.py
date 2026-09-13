"""Host-only Uhm acoustic benchmark; no bundled weights or Android enablement.

Model/license: https://huggingface.co/desert-ant-labs/uhm
This simple class-score threshold policy is an experimental benchmark policy,
not the vendor SDK's overlap averaging or an evaluated editing policy.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import wave

from run import detect, same_path

REVISION = "612592c10ad7b2a51f3237725448a1aad212480b"
MODEL_SHA256 = "c266faf7db4cdced6f18aa9119ff2800a20707d7159be645d487ec191a9d79ff"
MODEL_SIZE = 47_047_128
MANIFEST = {
    "id": "desert-ant-labs/uhm-web-fp16", "version": REVISION,
    "sha256": MODEL_SHA256, "sampleRate": 16000,
    # 1499 emitted frames cover 479680 samples, not all 480000 model inputs.
    # Add 320 zero context samples at inference; never invent a 1500th score.
    "windowSamples": 479680, "hopSamples": 240000, "frameSamples": 320,
    "labels": ["other", "um", "uh"],
}


class UhmModel:
    def __init__(self, path):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        if Path(path).stat().st_size != MODEL_SIZE:
            raise ValueError("Uhm model size differs from the pinned fp16 artifact")
        data = Path(path).read_bytes()
        if hashlib.sha256(data).hexdigest() != MODEL_SHA256:
            raise ValueError("Uhm model SHA-256 differs from the pinned artifact")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        try:
            self.session = ort.InferenceSession(data, sess_options=options, providers=["CPUExecutionProvider"])
        except Exception as error:
            raise ValueError(f"Cannot load Uhm: {error}") from error
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if len(inputs) != 1 or inputs[0].name != "audio" or inputs[0].shape != [1, 480000] or inputs[0].type != "tensor(float)":
            raise ValueError("Uhm input ABI does not match pinned model")
        if len(outputs) != 1 or outputs[0].name != "probs" or outputs[0].shape != [1, 1499, 6] or outputs[0].type != "tensor(float)":
            raise ValueError("Uhm output ABI does not match pinned model")
        self.runtime_version = ort.__version__

    def predict(self, samples):
        if len(samples) != MANIFEST["windowSamples"]:
            raise ValueError("Unexpected Uhm window length")
        audio = self.np.zeros((1, 480000), dtype=self.np.float32)
        audio[0, :len(samples)] = samples
        try:
            output = self.session.run(["probs"], {"audio": audio})[0]
        except Exception as error:
            raise ValueError(f"Uhm inference failed: {error}") from error
        if output.shape != (1, 1499, 6) or not self.np.isfinite(output).all() or (output < 0).any() or (output > 1).any():
            raise ValueError("Uhm output scores are malformed")
        # Preserve all competing categories: hmm/and/other are not um or uh.
        return [[max(row[0], row[3], row[4], row[5]), row[2], row[1]] for row in output[0].tolist()]


def benchmark(audio, model, source_id, revision, threshold=0.5):
    result = detect(audio, MANIFEST, model.predict, source_id, revision, threshold)
    result["provenance"]["runtime"] = f"onnxruntime-{model.runtime_version}-CPUExecutionProvider"
    result["provenance"]["timingNote"] = (
        "20 ms model frame coordinates; acoustic boundary error unmeasured. "
        "1499 output frames per 30 s input; each window has 20 ms zero context padding. "
        "15 s ownership hops cover the full source, including the final 20 ms."
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="Source-origin mono PCM16 16 kHz WAV")
    parser.add_argument("--model", required=True, type=Path, help="Locally obtained, licensed pinned fp16 ONNX")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--revision", required=True, type=int)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    temporary = None
    try:
        if any(same_path(args.output, source) for source in (args.audio, args.model)):
            raise ValueError("Output must not overwrite source audio or model")
        model = UhmModel(args.model)
        result = benchmark(args.audio, model, args.source_id, args.revision, args.threshold)
        with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, delete=False) as stream:
            temporary = stream.name
            json.dump(result, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if any(same_path(args.output, source) for source in (args.audio, args.model)):
            raise ValueError("Output aliases a protected source")
        os.replace(temporary, args.output)
    except (ValueError, OSError, ImportError, RuntimeError, EOFError, wave.Error) as error:
        parser.exit(2, f"Acoustic analysis unavailable: {error}\n")
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
