"""Uhm ABI/tail checks. Synthetic data is never accuracy evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/acoustic_fillers"))
from uhm import MANIFEST, benchmark, UhmModel


class UhmTests(unittest.TestCase):
    def test_final_twenty_ms_of_thirty_second_source_are_actually_inferred(self):
        class SyntheticModel:
            runtime_version = "synthetic-test-only"
            calls = 0
            def predict(self, samples):
                self.calls += 1
                return [[0, 1, 0]] * 1499
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.wav"
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"\0\0" * 480000)
            model = SyntheticModel()
            result = benchmark(path, model, "tail-test", 1)
            self.assertEqual(model.calls, 2)
            self.assertEqual(len(result["events"]), 1)
            self.assertEqual(result["events"][0]["endSeconds"], 30)
            self.assertIsNone(result["events"][0]["timingUncertaintySeconds"])
            self.assertFalse(result["provenance"]["releaseValidated"])

    @unittest.skipUnless(os.environ.get("UHM_TEST_MODEL") and os.environ.get("UHM_TEST_AUDIO"),
                         "Set local model/audio paths for optional real-model smoke")
    def test_real_model_cli_and_typescript_cleanup_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "result.json"
            result = subprocess.run([sys.executable, str(ROOT / "tools/acoustic_fillers/uhm.py"),
                os.environ["UHM_TEST_AUDIO"], "--model", os.environ["UHM_TEST_MODEL"],
                "--source-id", "synthetic-tts", "--revision", "1", "--output", str(result_path)],
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result_path.read_text())
            self.assertEqual(payload["status"], "ready")
            self.assertEqual(payload["actualProcessor"], "cpu")
            # No positive-event requirement: generated speech is not ground truth.
            javascript = """
import fs from 'node:fs';
import {adaptAcousticFillerResult} from './src/features/speech-control/acoustic-fillers.ts';
import {createCleanupPlan} from './src/features/speech-control/cleanup.ts';
const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const adapted=adaptAcousticFillerResult(data,{sourceId:'synthetic-tts',analysisRevision:1,durationSeconds:data.durationSeconds});
const plan=createCleanupPlan({recordingId:data.sourceId,segments:[],fillerMarks:adapted.marks});
if(plan.suggestions.some(s=>s.action!=='mark'||s.removal!==null)) throw Error('Acoustic event became a cut');
console.log(JSON.stringify({marks:adapted.marks.length,reviewOnly:true}));
"""
            handoff = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", javascript,
                                      str(result_path)], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(handoff.returncode, 0, handoff.stderr)


if __name__ == "__main__":
    unittest.main()
