#!/usr/bin/env python3
"""Deterministic tests for the independent acoustic filler evaluator."""

from __future__ import annotations

import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools" / "acoustic_fillers"
sys.path.insert(0, str(TOOLS))

from evaluate import (  # noqa: E402
    DEFAULT_IOU_THRESHOLD,
    EvaluationInputError,
    evaluate_dataset,
    interval_iou,
    load_json,
    maximum_cardinality_matches,
)


def event(
    event_id: str,
    start: float,
    end: float,
    label: str = "um",
    *,
    score: float | None = None,
) -> dict[str, object]:
    value: dict[str, object] = {
        "id": event_id,
        "startSeconds": start,
        "endSeconds": end,
        "label": label,
    }
    if score is not None:
        value["score"] = score
    return value


def recording(
    source_id: str = "source-1",
    *,
    duration: float = 60,
    split: str = "test",
    speaker: str = "speaker-1",
    consented: bool = True,
    synthetic: bool = False,
    annotations: list[dict[str, object]] | None = None,
    predictions: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "sourceId": source_id,
        "durationSeconds": duration,
        "split": split,
        "speakerId": speaker,
        "consented": consented,
        "synthetic": synthetic,
        "annotations": annotations or [],
        "predictions": predictions or [],
    }


def payload(*recordings_to_score: dict[str, object]) -> dict[str, object]:
    return {"recordings": list(recordings_to_score)}


class AcousticFillerEvaluationTests(unittest.TestCase):
    def test_checked_in_fixture_has_separate_human_and_synthetic_metrics(self) -> None:
        fixture = ROOT / "tools" / "acoustic_fillers" / "fixtures" / "evaluation-example.json"
        report = evaluate_dataset(json.loads(fixture.read_text(encoding="utf-8")))

        self.assertEqual(report["schema"], "one-take-acoustic-filler-evaluation/v1")
        self.assertEqual(report["iou_threshold"], DEFAULT_IOU_THRESHOLD)
        self.assertEqual(report["dataset"]["recording_count"], 4)
        self.assertEqual(report["dataset"]["annotation_count"], 4)
        self.assertEqual(report["dataset"]["prediction_count"], 5)
        self.assertTrue(report["human_eligibility"]["eligible"])
        self.assertEqual(report["metrics"]["human"]["true_positive_count"], 2)
        self.assertEqual(report["metrics"]["human"]["false_positive_count"], 1)
        self.assertFalse(report["synthetic_is_ineligible"] is False)

    def test_exact_iou_boundary_is_inclusive(self) -> None:
        annotation = event("a", 0, 2)
        prediction = event("p", 0, 1, score=0.7)
        self.assertEqual(interval_iou(annotation, prediction), 0.5)
        self.assertEqual(
            len(
                maximum_cardinality_matches(
                    [annotation], [prediction], iou_threshold=0.5
                )
            ),
            1,
        )
        report = evaluate_dataset(
            payload(
                recording(
                    annotations=[annotation],
                    predictions=[prediction],
                )
            )
        )
        self.assertEqual(report["metrics"]["human"]["true_positive_count"], 1)

    def test_maximum_cardinality_beats_greedy_overlap_choice(self) -> None:
        # The first annotation has a stronger edge to p1 but can use p2.  The
        # second annotation can use only p1.  An augmenting path is required
        # to retain both matches.
        annotations = [event("a1", 0, 4), event("a2", 2, 6)]
        predictions = [
            event("p1", 1, 5, score=0.8),
            event("p2", 0, 2.2, score=0.7),
        ]
        matches = maximum_cardinality_matches(annotations, predictions)
        self.assertEqual(len(matches), 2)
        self.assertEqual(
            {(annotation["id"], prediction["id"]) for annotation, prediction, _ in matches},
            {("a1", "p2"), ("a2", "p1")},
        )

    def test_same_label_and_source_are_required(self) -> None:
        report = evaluate_dataset(
            payload(
                recording(
                    "source-a",
                    speaker="speaker-a",
                    annotations=[event("ann-a", 1, 2, "um")],
                    predictions=[],
                ),
                recording(
                    "source-b",
                    speaker="speaker-b",
                    annotations=[],
                    predictions=[event("pred-b", 1, 2, "um", score=0.9)],
                ),
            )
        )
        metrics = report["metrics"]["human"]
        self.assertEqual(metrics["true_positive_count"], 0)
        self.assertEqual(metrics["false_positive_count"], 1)
        self.assertEqual(metrics["false_negative_count"], 1)

        wrong_label = evaluate_dataset(
            payload(
                recording(
                    annotations=[event("ann", 1, 2, "um")],
                    predictions=[event("pred", 1, 2, "uh", score=1)],
                )
            )
        )
        self.assertEqual(wrong_label["metrics"]["human"]["matched_count"], 0)

        self.assertEqual(
            maximum_cardinality_matches(
                [{**event("ann-source", 1, 2), "sourceId": "source-a"}],
                [{**event("pred-source", 1, 2, score=0.9), "sourceId": "source-b"}],
            ),
            [],
        )

    def test_duplicate_predictions_are_one_tp_and_one_false_positive(self) -> None:
        report = evaluate_dataset(
            payload(
                recording(
                    annotations=[event("ann", 10, 11)],
                    predictions=[
                        event("pred-1", 10, 11, score=0.91),
                        event("pred-2", 10.1, 10.9, score=0.89),
                    ],
                )
            )
        )
        metrics = report["metrics"]["human"]
        self.assertEqual(metrics["true_positive_count"], 1)
        self.assertEqual(metrics["false_positive_count"], 1)
        self.assertEqual(metrics["false_negative_count"], 0)

    def test_metrics_report_errors_and_false_positives_per_minute(self) -> None:
        report = evaluate_dataset(
            payload(
                recording(
                    duration=120,
                    annotations=[event("ann", 1, 3)],
                    predictions=[
                        event("pred-match", 1.5, 3.5, score=0.9),
                        event("pred-fp", 80, 81, score=0.4),
                    ],
                )
            )
        )
        metrics = report["metrics"]["human"]
        self.assertEqual(metrics["precision"], 0.5)
        self.assertEqual(metrics["recall"], 1.0)
        self.assertEqual(metrics["f1"], round(2 / 3, 6))
        self.assertEqual(metrics["false_positives_per_minute"], 0.5)
        self.assertEqual(metrics["onset_error_abs_seconds"], 0.5)
        self.assertEqual(metrics["offset_error_abs_seconds"], 0.5)

    def test_empty_denominators_are_null(self) -> None:
        report = evaluate_dataset(
            payload(recording(duration=0, annotations=[], predictions=[]))
        )
        metrics = report["metrics"]["human"]
        for field in (
            "precision",
            "recall",
            "f1",
            "false_positives_per_minute",
            "onset_error_abs_seconds",
            "offset_error_abs_seconds",
        ):
            self.assertIsNone(metrics[field], field)
        self.assertFalse(report["human_eligibility"]["eligible"])

    def test_duplicate_recording_and_event_ids_are_rejected(self) -> None:
        duplicate_recording = payload(
            recording("same", speaker="one"), recording("same", speaker="two")
        )
        with self.assertRaisesRegex(EvaluationInputError, "sourceId duplicates"):
            evaluate_dataset(duplicate_recording)

        duplicate_event = payload(
            recording(
                annotations=[event("same-event", 1, 2)],
                predictions=[event("same-event", 3, 4, score=0.3)],
            )
        )
        with self.assertRaisesRegex(EvaluationInputError, "duplicates event id"):
            evaluate_dataset(duplicate_event)

    def test_negative_nonfinite_and_out_of_range_values_are_rejected(self) -> None:
        invalid_payloads = [
            payload(recording(duration=-1)),
            payload(
                recording(
                    annotations=[event("ann", -0.1, 1)],
                )
            ),
            payload(
                recording(
                    annotations=[event("ann", 1, 2)],
                    predictions=[event("pred", 1, 2, score=float("nan"))],
                )
            ),
            payload(
                recording(
                    annotations=[event("ann", 1, 2)],
                    predictions=[event("pred", 1, 2, score=1.1)],
                )
            ),
        ]
        for invalid in invalid_payloads:
            with self.assertRaises(EvaluationInputError):
                evaluate_dataset(invalid)

    def test_event_must_fit_inside_recording_and_have_positive_duration(self) -> None:
        cases = [
            recording(annotations=[event("ann", 1, 1)]),
            recording(annotations=[event("ann", 1, 61)]),
            recording(predictions=[event("pred", 0, 61, score=0.3)]),
        ]
        for case in cases:
            with self.assertRaises(EvaluationInputError):
                evaluate_dataset(payload(case))

    def test_speaker_split_leakage_is_rejected(self) -> None:
        with self.assertRaisesRegex(EvaluationInputError, "multiple splits"):
            evaluate_dataset(
                payload(
                    recording(
                        "train-source",
                        split="train",
                        speaker="leaked-speaker",
                    ),
                    recording(
                        "test-source",
                        split="test",
                        speaker="leaked-speaker",
                    ),
                )
            )

    def test_human_gate_excludes_unconsented_and_synthetic_rows(self) -> None:
        report = evaluate_dataset(
            payload(
                recording(
                    "synthetic",
                    speaker="synthetic-speaker",
                    synthetic=True,
                    consented=False,
                    annotations=[event("synthetic-ann", 1, 2)],
                    predictions=[event("synthetic-pred", 1, 2, score=1)],
                ),
                recording(
                    "unconsented",
                    speaker="unconsented-speaker",
                    synthetic=False,
                    consented=False,
                    annotations=[event("unconsented-ann", 1, 2)],
                    predictions=[event("unconsented-pred", 1, 2, score=1)],
                ),
            )
        )
        self.assertFalse(report["human_eligibility"]["eligible"])
        self.assertEqual(report["metrics"]["human"]["recording_count"], 0)
        self.assertEqual(report["metrics"]["synthetic"]["matched_count"], 1)
        self.assertEqual(report["metrics"]["all"]["matched_count"], 2)

    def test_optional_event_source_id_cannot_cross_recordings(self) -> None:
        bad = payload(
            recording(
                annotations=[
                    {**event("ann", 1, 2), "sourceId": "other-source"}
                ]
            )
        )
        with self.assertRaisesRegex(EvaluationInputError, "must equal"):
            evaluate_dataset(bad)

    def test_cli_prints_json_and_writes_optional_output(self) -> None:
        fixture = ROOT / "tools" / "acoustic_fillers" / "fixtures" / "evaluation-example.json"
        evaluator = TOOLS / "evaluate.py"
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(evaluator),
                    str(fixture),
                    "--iou-threshold",
                    "0.5",
                    "--output",
                    str(output),
                ],
                cwd=ROOT,
                text=True,
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            stdout_report = json.loads(result.stdout)
            file_report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(stdout_report, file_report)

    def test_cli_cannot_overwrite_annotation_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            dataset = Path(temporary) / "dataset.json"
            original = '{"recordings":[]}'
            dataset.write_text(original)
            result = subprocess.run([sys.executable, str(ROOT / "tools/acoustic_fillers/evaluate.py"),
                                     str(dataset), "--output", str(dataset)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("overwrite", result.stderr)
            self.assertEqual(dataset.read_text(), original)

    def test_cli_rejects_nonfinite_json_constant(self) -> None:
        with self.assertRaises(EvaluationInputError):
            load_json(
                io.StringIO(
                    '{"recordings":[{"sourceId":"x","durationSeconds":NaN,'
                    '"split":"test","speakerId":"s","consented":true,'
                    '"synthetic":false,"annotations":[],"predictions":[]}]}'
                )
            )


if __name__ == "__main__":
    unittest.main()
