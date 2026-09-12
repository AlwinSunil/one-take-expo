#!/usr/bin/env python3
"""Standard-library tests for the speech evaluation tool and fixture."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from evaluate_speech import (  # noqa: E402
    EvaluationInputError,
    evaluate_records,
    load_jsonl,
    word_error_rate,
)


def record(
    row_id: str,
    split: str,
    *,
    speaker: str = "speaker-a",
    recording: str | None = None,
    audio: str | None = None,
    label: str = "clean",
    reference: str = "a small test",
    hypothesis: str = "a small test",
    source: str = "consented",
    consented: bool | None = True,
    expected_flub: bool | None = None,
    detected_flub: bool | None = None,
) -> dict[str, object]:
    row: dict[str, object] = {
        "id": row_id,
        "speaker_id": speaker,
        "recording_id": recording or f"recording-{row_id}",
        "audio_sha256": audio or f"audio-{row_id}",
        "split": split,
        "label": label,
        "reference": reference,
        "hypothesis": hypothesis,
        "source": source,
        "consented": consented,
    }
    if expected_flub is not None:
        row["expected_flub"] = expected_flub
    if detected_flub is not None:
        row["detected_flub"] = detected_flub
    return row


class SpeechEvaluationTests(unittest.TestCase):
    def test_word_error_rate_breakdown(self) -> None:
        score = word_error_rate("a b c", "a x c d")
        self.assertEqual(score["reference_words"], 3)
        self.assertEqual(score["hypothesis_words"], 4)
        self.assertEqual(score["substitutions"], 1)
        self.assertEqual(score["deletions"], 0)
        self.assertEqual(score["insertions"], 1)
        self.assertEqual(score["errors"], 2)
        self.assertAlmostEqual(score["wer"], 2 / 3, places=5)

    def test_stratified_counts_and_human_gate(self) -> None:
        records = [
            record("tuning-1", "tuning", speaker="tuning-speaker"),
            record(
                "heldout-clean-1",
                "heldout",
                speaker="heldout-speaker",
                label="clean",
            ),
            record(
                "heldout-flub-1",
                "heldout",
                speaker="heldout-speaker-2",
                label="flub",
                hypothesis="a test",
            ),
        ]
        report = evaluate_records(records)
        self.assertEqual(report["dataset"]["sample_count"], 3)
        self.assertEqual(report["metrics"]["by_split"]["heldout"]["sample_count"], 2)
        self.assertEqual(report["metrics"]["by_split_label"]["heldout"]["flub"]["sample_count"], 1)
        self.assertEqual(report["minimums"]["heldout_clean_count"], 1)
        self.assertEqual(report["minimums"]["heldout_flub_count"], 1)
        self.assertFalse(report["minimums"]["met"])
        self.assertFalse(report["quality_gate"]["eligible_for_design_targets"])

    def test_cross_split_identity_leakage_is_reported(self) -> None:
        rows = [
            record("tuning-1", "tuning", speaker="same-speaker", recording="same-recording", audio="same-audio"),
            record("heldout-1", "heldout", speaker="same-speaker", recording="same-recording-2", audio="same-audio-2"),
            record("heldout-2", "heldout", speaker="heldout-speaker", recording="same-recording", audio="same-audio"),
        ]
        report = evaluate_records(rows)
        self.assertEqual(report["leakage"]["cross_split_speaker_ids"], ["same-speaker"])
        self.assertEqual(report["leakage"]["cross_split_recording_ids"], ["same-recording"])
        self.assertEqual(report["leakage"]["cross_split_audio_sha256"], ["same-audio"])
        self.assertTrue(report["leakage"]["has_leakage"])
        self.assertFalse(report["quality_gate"]["eligible_for_design_targets"])

    def test_duplicate_ids_are_reported_without_printing_transcript(self) -> None:
        rows = [
            record("duplicate", "tuning", reference="private phrase one"),
            record("duplicate", "tuning", reference="private phrase two"),
            record("heldout", "heldout", speaker="other-speaker"),
        ]
        report = evaluate_records(rows)
        self.assertEqual(report["leakage"]["duplicate_ids"], ["duplicate"])
        rendered = json.dumps(report)
        self.assertNotIn("private phrase one", rendered)
        self.assertNotIn("private phrase two", rendered)

    def test_unconsented_real_row_fails_consent_check(self) -> None:
        report = evaluate_records(
            [
                record("one", "tuning", source="consented", consented=False),
                record("two", "heldout", speaker="other", source="synthetic", consented=False),
            ]
        )
        self.assertEqual(report["consent"]["unconsented_real_rows"], 1)
        self.assertFalse(report["consent"]["ok"])

    def test_synthetic_rows_cannot_satisfy_human_minimum_gate(self) -> None:
        rows = [
            record("synthetic-tuning", "tuning", source="synthetic", consented=False)
        ]
        rows.extend(
            record(
                f"synthetic-clean-{index}",
                "heldout",
                speaker=f"synthetic-clean-speaker-{index}",
                label="clean",
                source="synthetic",
                consented=False,
            )
            for index in range(60)
        )
        rows.extend(
            record(
                f"synthetic-flub-{index}",
                "heldout",
                speaker=f"synthetic-flub-speaker-{index}",
                label="flub",
                source="synthetic",
                consented=False,
            )
            for index in range(30)
        )
        report = evaluate_records(rows)
        self.assertEqual(report["minimums"]["heldout_clean_count"], 0)
        self.assertEqual(report["minimums"]["heldout_flub_count"], 0)
        self.assertEqual(report["minimums"]["heldout_synthetic_clean_count"], 60)
        self.assertEqual(report["minimums"]["heldout_synthetic_flub_count"], 30)
        self.assertFalse(report["minimums"]["met"])
        self.assertIn(
            "synthetic rows cannot qualify for human design targets",
            report["quality_gate"]["reasons"],
        )
        self.assertFalse(report["quality_gate"]["eligible_for_design_targets"])

    def test_flub_flags_report_confusion_counts_and_recall(self) -> None:
        report = evaluate_records(
            [
                record("true-negative", "tuning", label="clean", detected_flub=False),
                record("false-positive", "tuning", label="clean", detected_flub=True),
                record("true-positive", "heldout", label="flub", detected_flub=True),
                record("false-negative", "heldout", label="flub", detected_flub=False),
            ]
        )
        classification = report["classification"]
        self.assertEqual(classification["sample_count"], 4)
        self.assertEqual(classification["true_positive_count"], 1)
        self.assertEqual(classification["true_negative_count"], 1)
        self.assertEqual(classification["false_positive_count"], 1)
        self.assertEqual(classification["false_negative_count"], 1)
        self.assertEqual(classification["expected_flub_count"], 2)
        self.assertEqual(classification["detected_flub_count"], 2)
        self.assertEqual(classification["recall"], 0.5)
        self.assertEqual(classification["precision"], 0.5)
        self.assertEqual(
            classification["by_split"]["heldout"]["false_negative_count"], 1
        )
        self.assertTrue(classification["complete"])
        self.assertTrue(classification["eligible_for_false_flag_targets"])

    def test_flub_classification_is_optional_but_incomplete_rows_are_counted(self) -> None:
        report = evaluate_records(
            [
                record("declared-clean", "tuning", label="clean"),
                record("explicit-expected", "heldout", label="number", expected_flub=True),
            ]
        )
        classification = report["classification"]
        self.assertEqual(classification["sample_count"], 0)
        self.assertEqual(classification["rows_missing_detected_flub"], 2)
        self.assertEqual(classification["rows_missing_expected_flub"], 0)
        self.assertFalse(classification["complete"])
        self.assertFalse(classification["eligible_for_false_flag_targets"])

    def test_flub_boolean_fields_reject_non_boolean_values(self) -> None:
        with self.assertRaises(EvaluationInputError):
            load_jsonl(
                __import__("io").StringIO(
                    '{"id":"one","split":"tuning","reference":"a",'
                    '"hypothesis":"a","expected_flub":"false"}\n'
                )
            )

    def test_jsonl_schema_rejects_missing_required_field(self) -> None:
        with self.assertRaises(EvaluationInputError):
            load_jsonl(
                __import__("io").StringIO(
                    '{"id":"one","split":"tuning","reference":"a"}\n'
                )
            )

    def test_synthetic_fixture_runner(self) -> None:
        runner = ROOT / "tools/speech-fixtures/run_synthetic.py"
        result = subprocess.run(
            [sys.executable, str(runner)],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["dataset"]["synthetic_only"])
        self.assertFalse(report["quality_gate"]["eligible_for_design_targets"])

    def test_cli_minimum_gate_is_explicit(self) -> None:
        fixture = ROOT / "tools/speech-fixtures/synthetic-small.jsonl"
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools/evaluate_speech.py"),
                    str(fixture),
                    "--require-minimums",
                    "--output",
                    str(output),
                ],
                cwd=ROOT,
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(result.returncode, 2)
            self.assertTrue(output.is_file())
            self.assertFalse(json.loads(output.read_text())["minimums"]["met"])


if __name__ == "__main__":
    unittest.main()
