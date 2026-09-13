"""Synthetic plumbing tests; these establish no filler recognition accuracy."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/acoustic_fillers"))
from audio import inspect_wave, windows
from run import detect, read_manifest, sha256, same_path


def manifest():
    return {"schemaVersion": 1, "id": "synthetic-plumbing-only", "version": "1", "modelFile": "model.onnx",
            "sha256": "0" * 64, "inputName": "audio", "outputName": "scores", "license": "test-only",
            "source": "generated-test", "labels": ["other", "um", "uh"], "sampleRate": 16000,
            "windowSamples": 1600, "hopSamples": 800, "frameSamples": 160,
            "inputKind": "pcm-float32", "outputKind": "frame-scores"}


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "audio.wav"
        self.write_audio(2400)

    def tearDown(self):
        self.tmp.cleanup()

    def write_audio(self, count, rate=16000):
        with wave.open(str(self.path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(rate)
            audio.writeframes(struct.pack("<" + "h" * count, *([16384] * count)))

    def test_overlapping_windows_do_not_duplicate_or_shift_events(self):
        calls = []
        def predict(samples):
            calls.append(samples)
            return [[0.01, 0.98, 0.01]] * 10
        before = sha256(self.path)
        result = detect(self.path, manifest(), predict, "source-a", 2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0], 0.5)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["startSeconds"], 0)
        self.assertEqual(result["events"][0]["endSeconds"], 0.15)
        self.assertEqual(before, sha256(self.path))
        self.assertFalse(result["provenance"]["releaseValidated"])

    def test_final_padding_never_becomes_source_time(self):
        self.write_audio(1701)
        chunks = list(windows(self.path, 16000, 1600, 800))
        self.assertEqual(chunks[-1].valid_samples, 901)
        self.assertEqual(chunks[-1].samples[-1], 0)
        result = detect(self.path, manifest(), lambda _: [[0, 0, 1]] * 10, "b", 1)
        self.assertEqual(result["events"][-1]["endSeconds"], 1701 / 16000)

    def test_source_replacement_during_inference_discards_results(self):
        replacement = Path(self.tmp.name) / "replacement.wav"
        replacement.write_bytes(self.path.read_bytes().replace(b'\x00\x40', b'\x00\x20'))
        def predict(_):
            if replacement.exists():
                os.replace(replacement, self.path)
            return [[0, 1, 0]] * 10
        with self.assertRaisesRegex(ValueError, "changed"):
            detect(self.path, manifest(), predict, "a", 0)

    def test_alias_guard_detects_same_inode(self):
        alias = Path(self.tmp.name) / "alias.wav"
        os.link(self.path, alias)
        self.assertTrue(same_path(alias, self.path))
        case_alias = self.path.with_name("AUDIO.WAV")
        if case_alias.exists():
            self.assertTrue(same_path(case_alias, self.path))

    def test_excessive_work_is_rejected_before_inference(self):
        self.write_audio(100001)
        tiny_hop = {**manifest(), "hopSamples": 1, "frameSamples": 1}
        with self.assertRaisesRegex(ValueError, "window budget"):
            detect(self.path, tiny_hop, lambda _: self.fail("must not run"), "a", 0)

    def test_empty_detection_is_completed_analysis_not_unavailable(self):
        result = detect(self.path, manifest(), lambda _: [[1, 0, 0]] * 10, "a", 0)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["events"], [])

    def test_ties_and_subthreshold_scores_are_not_fillers(self):
        for scores in ([0, 0.5, 0.5], [0.1, 0.8, 0.1], [0.9, 0.9, 0]):
            self.assertEqual(detect(self.path, manifest(), lambda _: [scores] * 10, "a", 0)["events"], [])

    def test_label_change_splits_and_negative_frame_ends_event(self):
        self.write_audio(1600)
        scores = [[0, 1, 0]] * 3 + [[1, 0, 0]] * 2 + [[0, 0, 1]] * 5
        result = detect(self.path, manifest(), lambda _: scores, "a", 0)
        self.assertEqual([(e["label"], e["startSeconds"], e["endSeconds"]) for e in result["events"]],
                         [("um", 0, 0.03), ("uh", 0.05, 0.1)])

    def test_model_failure_and_malformed_output_never_return_success(self):
        for scores in ([[0, float("nan"), 1]] * 10, [[0, -1, 2]] * 10, [[0, True, 0]] * 10, [[0, 1]] * 10, []):
            with self.assertRaises(ValueError):
                detect(self.path, manifest(), lambda _: scores, "a", 0)
        def failure(_):
            raise RuntimeError("inference failed")
        with self.assertRaises(RuntimeError):
            detect(self.path, manifest(), failure, "a", 0)

    def test_invalid_audio_and_request(self):
        for threshold in (float("nan"), 0, 1.1, True):
            with self.assertRaises(ValueError):
                detect(self.path, manifest(), lambda _: [], "a", 0, threshold)
        self.write_audio(1, 8000)
        with self.assertRaises(ValueError):
            inspect_wave(self.path, 16000)
        self.write_audio(0)
        with self.assertRaises(ValueError):
            inspect_wave(self.path, 16000)

    def test_truncated_audio_rejected(self):
        self.path.write_bytes(self.path.read_bytes()[:-20])
        with self.assertRaisesRegex(ValueError, "Truncated"):
            list(windows(self.path, 16000, 1600, 800))

    def test_manifest_validation(self):
        path = Path(self.tmp.name) / "manifest.json"
        path.write_text(json.dumps(manifest()))
        self.assertEqual(read_manifest(path), manifest())
        for key, value in [("sampleRate", True), ("sha256", "wrong"), ("labels", ["um", "other", "uh"]),
                           ("frameSamples", 161), ("hopSamples", 1601), ("outputKind", "logits")]:
            path.write_text(json.dumps({**manifest(), key: value}))
            with self.assertRaises(ValueError):
                read_manifest(path)

    def test_cli_missing_model_preserves_prior_result(self):
        model = Path(self.tmp.name) / "manifest.json"
        model.write_text(json.dumps(manifest()))
        output = Path(self.tmp.name) / "result.json"
        output.write_text("previous result")
        result = subprocess.run([sys.executable, str(ROOT / "tools/acoustic_fillers/run.py"), str(self.path),
                                 "--manifest", str(model), "--source-id", "a", "--revision", "1", "--output", str(output)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unavailable", result.stderr)
        self.assertEqual(output.read_text(), "previous result")

    @unittest.skipUnless(importlib.util.find_spec("onnx") and importlib.util.find_spec("onnxruntime"),
                         "optional ONNX runtime smoke dependencies are not installed")
    def test_real_onnx_execution_is_only_synthetic_plumbing_evidence(self):
        import onnx
        from onnx import helper, TensorProto
        from run import OnnxModel
        # Synthetic constant graph exercises actual runtime/CLI, not recognition.
        output_tensor = helper.make_tensor("constant_scores", TensorProto.FLOAT, [1, 10, 3], [1, 0, 0] * 10)
        graph = helper.make_graph([helper.make_node("Constant", [], ["scores"], value=output_tensor)],
                                  "synthetic-not-a-filler-detector",
                                  [helper.make_tensor_value_info("audio", TensorProto.FLOAT, [1, 1600])],
                                  [helper.make_tensor_value_info("scores", TensorProto.FLOAT, [1, 10, 3])])
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
        model.ir_version = 9
        model_path = Path(self.tmp.name) / "model.onnx"
        onnx.save(model, model_path)
        config = {**manifest(), "sha256": sha256(model_path)}
        manifest_path = Path(self.tmp.name) / "manifest.json"
        manifest_path.write_text(json.dumps(config))
        backend = OnnxModel(config, manifest_path)
        self.assertEqual(detect(self.path, config, backend.predict, "runtime-test", 0)["events"], [])
        output = Path(self.tmp.name) / "result.json"
        result = subprocess.run([sys.executable, str(ROOT / "tools/acoustic_fillers/run.py"), str(self.path),
                                 "--manifest", str(manifest_path), "--source-id", "runtime-test", "--revision", "0",
                                 "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(output.read_text())
        self.assertEqual(payload["events"], [])
        self.assertIn("CPUExecutionProvider", payload["provenance"]["runtime"])
        good_result = output.read_bytes()
        self.path.write_bytes(b"garbage")
        command = [sys.executable, str(ROOT / "tools/acoustic_fillers/run.py"), str(self.path),
                   "--manifest", str(manifest_path), "--source-id", "runtime-test", "--revision", "0",
                   "--output", str(output)]
        failure = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(failure.returncode, 2)
        self.assertIn("unavailable", failure.stderr)
        self.assertNotIn("Traceback", failure.stderr)
        self.assertEqual(output.read_bytes(), good_result)
        model_path.write_bytes(b"invalid graph")
        manifest_path.write_text(json.dumps({**config, "sha256": sha256(model_path)}))
        failure = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(failure.returncode, 2)
        self.assertNotIn("Traceback", failure.stderr)
        self.assertEqual(output.read_bytes(), good_result)
        model_path.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "hash"):
            OnnxModel(config, manifest_path)


if __name__ == "__main__":
    unittest.main()
