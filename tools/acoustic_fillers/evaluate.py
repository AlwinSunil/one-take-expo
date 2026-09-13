#!/usr/bin/env python3
"""Evaluate timestamped acoustic filler events.

The evaluator deliberately scores event predictions only.  It does not load a
model, inspect audio, or infer whether a detected filler should be removed.
Input is a JSON object with a ``recordings`` array.  Each recording contains
ground-truth ``annotations`` and detector ``predictions`` in source-relative
seconds.

The matching rule is one-to-one, same-recording, same-label interval IoU.  A
maximum-cardinality bipartite matching is used so an early greedy choice cannot
hide a later valid match.  Synthetic recordings are scored separately and can
never make the human eligibility gate pass.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable, Mapping, Sequence
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from typing import Any, TextIO


SCHEMA = "one-take-acoustic-filler-evaluation/v1"
ALLOWED_SPLITS = frozenset({"train", "validation", "test"})
ALLOWED_LABELS = frozenset({"um", "uh"})
DEFAULT_IOU_THRESHOLD = 0.5


class EvaluationInputError(ValueError):
    """Raised when an evaluation payload violates its JSON contract."""


def _path(index: int, field: str | None = None) -> str:
    return f"recordings[{index}]" if field is None else f"recordings[{index}].{field}"


def _identifier(value: Any, field: str) -> str:
    """Normalize an identifier while rejecting ambiguous JSON values."""

    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise EvaluationInputError(f"{field} must be a nonempty string or integer")
    identifier = str(value).strip()
    if not identifier:
        raise EvaluationInputError(f"{field} must be nonempty")
    return identifier


def _finite_number(
    value: Any,
    field: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    """Return a finite JSON number, optionally constrained to an interval."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvaluationInputError(f"{field} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise EvaluationInputError(f"{field} must be finite")
    if minimum is not None and number < minimum:
        raise EvaluationInputError(f"{field} must be >= {minimum:g}")
    if maximum is not None and number > maximum:
        raise EvaluationInputError(f"{field} must be <= {maximum:g}")
    return number


def _object(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvaluationInputError(f"{field} must be a JSON object")
    return value


def _array(value: Any, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise EvaluationInputError(f"{field} must be a JSON array")
    return value


def _required(record: Mapping[str, Any], field: str, path: str) -> Any:
    if field not in record:
        raise EvaluationInputError(f"{path} is required")
    return record[field]


def _validate_threshold(value: Any) -> float:
    return _finite_number(
        value,
        "iou_threshold",
        minimum=0.0,
        maximum=1.0,
    )


def _validate_event(
    value: Any,
    *,
    recording_index: int,
    event_index: int,
    event_kind: str,
    source_id: str,
    duration_seconds: float,
    seen_event_ids: dict[str, str],
) -> dict[str, Any]:
    field_prefix = f"recordings[{recording_index}].{event_kind}[{event_index}]"
    event = _object(value, field_prefix)

    event_id = _identifier(_required(event, "id", field_prefix), f"{field_prefix}.id")
    previous = seen_event_ids.get(event_id)
    if previous is not None:
        raise EvaluationInputError(
            f"{field_prefix}.id duplicates event id {event_id!r} at {previous}"
        )
    seen_event_ids[event_id] = f"{field_prefix}.id"

    # The public input contract nests events under a source.  If a producer
    # includes an optional sourceId for debugging, validate that it cannot
    # silently move an event into another recording.
    if "sourceId" in event:
        event_source = _identifier(
            event["sourceId"], f"{field_prefix}.sourceId"
        )
        if event_source != source_id:
            raise EvaluationInputError(
                f"{field_prefix}.sourceId must equal its recording sourceId"
            )

    start = _finite_number(
        _required(event, "startSeconds", field_prefix),
        f"{field_prefix}.startSeconds",
        minimum=0.0,
    )
    end = _finite_number(
        _required(event, "endSeconds", field_prefix),
        f"{field_prefix}.endSeconds",
        minimum=0.0,
    )
    if end <= start:
        raise EvaluationInputError(
            f"{field_prefix}.endSeconds must be greater than startSeconds"
        )
    if end > duration_seconds:
        raise EvaluationInputError(
            f"{field_prefix}.endSeconds must be <= recording durationSeconds"
        )

    label = _required(event, "label", field_prefix)
    if not isinstance(label, str) or label not in ALLOWED_LABELS:
        raise EvaluationInputError(
            f"{field_prefix}.label must be one of: {', '.join(sorted(ALLOWED_LABELS))}"
        )

    normalized: dict[str, Any] = {
        "id": event_id,
        "sourceId": source_id,
        "startSeconds": start,
        "endSeconds": end,
        "label": label,
    }
    if event_kind == "predictions":
        normalized["score"] = _finite_number(
            _required(event, "score", field_prefix),
            f"{field_prefix}.score",
            minimum=0.0,
            maximum=1.0,
        )
    return normalized


def validate_dataset(payload: Any) -> list[dict[str, Any]]:
    """Validate and normalize a payload, returning recording dictionaries.

    IDs are unique across the complete payload, including annotation and
    prediction IDs.  Keeping one namespace makes event references safe when a
    report is persisted or joined with a later review decision.
    """

    root = _object(payload, "input")
    recordings_raw = _array(_required(root, "recordings", "input"), "recordings")

    recordings: list[dict[str, Any]] = []
    seen_source_ids: dict[str, int] = {}
    seen_event_ids: dict[str, str] = {}
    speaker_splits: dict[str, set[str]] = {}

    for recording_index, raw_recording in enumerate(recordings_raw):
        recording_path = _path(recording_index)
        recording = _object(raw_recording, recording_path)
        source_id = _identifier(
            _required(recording, "sourceId", recording_path),
            f"{recording_path}.sourceId",
        )
        if source_id in seen_source_ids:
            raise EvaluationInputError(
                f"{recording_path}.sourceId duplicates recordings[{seen_source_ids[source_id]}]"
            )
        seen_source_ids[source_id] = recording_index

        duration_seconds = _finite_number(
            _required(recording, "durationSeconds", recording_path),
            f"{recording_path}.durationSeconds",
            minimum=0.0,
        )
        split = _required(recording, "split", recording_path)
        if not isinstance(split, str) or split not in ALLOWED_SPLITS:
            raise EvaluationInputError(
                f"{recording_path}.split must be one of: {', '.join(sorted(ALLOWED_SPLITS))}"
            )
        speaker_id = _identifier(
            _required(recording, "speakerId", recording_path),
            f"{recording_path}.speakerId",
        )
        consented = _required(recording, "consented", recording_path)
        if not isinstance(consented, bool):
            raise EvaluationInputError(f"{recording_path}.consented must be boolean")
        synthetic = _required(recording, "synthetic", recording_path)
        if not isinstance(synthetic, bool):
            raise EvaluationInputError(f"{recording_path}.synthetic must be boolean")

        speaker_splits.setdefault(speaker_id, set()).add(split)

        annotations_raw = _array(
            _required(recording, "annotations", recording_path),
            f"{recording_path}.annotations",
        )
        predictions_raw = _array(
            _required(recording, "predictions", recording_path),
            f"{recording_path}.predictions",
        )
        annotations = [
            _validate_event(
                event,
                recording_index=recording_index,
                event_index=event_index,
                event_kind="annotations",
                source_id=source_id,
                duration_seconds=duration_seconds,
                seen_event_ids=seen_event_ids,
            )
            for event_index, event in enumerate(annotations_raw)
        ]
        predictions = [
            _validate_event(
                event,
                recording_index=recording_index,
                event_index=event_index,
                event_kind="predictions",
                source_id=source_id,
                duration_seconds=duration_seconds,
                seen_event_ids=seen_event_ids,
            )
            for event_index, event in enumerate(predictions_raw)
        ]
        recordings.append(
            {
                "sourceId": source_id,
                "durationSeconds": duration_seconds,
                "split": split,
                "speakerId": speaker_id,
                "consented": consented,
                "synthetic": synthetic,
                "annotations": annotations,
                "predictions": predictions,
            }
        )

    leakage = {
        speaker_id: sorted(splits)
        for speaker_id, splits in speaker_splits.items()
        if len(splits) > 1
    }
    if leakage:
        details = ", ".join(
            f"{speaker_id}: {', '.join(splits)}"
            for speaker_id, splits in sorted(leakage.items())
        )
        raise EvaluationInputError(
            f"speaker appears in multiple splits ({details})"
        )
    return recordings


def interval_iou(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
    """Return intersection-over-union for two validated time intervals."""

    intersection = max(
        0.0,
        min(float(left["endSeconds"]), float(right["endSeconds"]))
        - max(float(left["startSeconds"]), float(right["startSeconds"])),
    )
    if intersection <= 0.0:
        return 0.0
    union = max(float(left["endSeconds"]), float(right["endSeconds"])) - min(
        float(left["startSeconds"]), float(right["startSeconds"])
    )
    return intersection / union if union > 0.0 else 0.0


def _event_sort_key(event: Mapping[str, Any]) -> tuple[float, float, str, str]:
    return (
        float(event["startSeconds"]),
        float(event["endSeconds"]),
        str(event["label"]),
        str(event["id"]),
    )


def maximum_cardinality_matches(
    annotations: Sequence[Mapping[str, Any]],
    predictions: Sequence[Mapping[str, Any]],
    *,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
) -> list[tuple[Mapping[str, Any], Mapping[str, Any], float]]:
    """Match events one-to-one using a deterministic maximum-cardinality pass.

    Callers normally use :func:`score_recordings`, which groups by source and
    label first.  This function also checks labels so direct callers cannot
    accidentally pair ``um`` with ``uh``.
    """

    threshold = _validate_threshold(iou_threshold)
    ordered_annotations = sorted(annotations, key=_event_sort_key)
    ordered_predictions = sorted(predictions, key=_event_sort_key)

    adjacency: list[list[int]] = []
    for annotation in ordered_annotations:
        candidates = [
            prediction_index
            for prediction_index, prediction in enumerate(ordered_predictions)
            if annotation["label"] == prediction["label"]
            and (
                ("sourceId" not in annotation and "sourceId" not in prediction)
                or (
                    "sourceId" in annotation
                    and "sourceId" in prediction
                    and annotation["sourceId"] == prediction["sourceId"]
                )
            )
            and interval_iou(annotation, prediction) > 0.0
            and interval_iou(annotation, prediction) >= threshold
        ]
        # Prefer stronger overlap while retaining ID order for ties.  This is
        # only a deterministic tie-break; cardinality remains the objective.
        candidates.sort(
            key=lambda index: (
                -interval_iou(annotation, ordered_predictions[index]),
                _event_sort_key(ordered_predictions[index]),
            )
        )
        adjacency.append(candidates)

    matched_prediction_to_annotation = [-1] * len(ordered_predictions)
    matched_annotation_to_prediction = [-1] * len(ordered_annotations)

    def augment(annotation_index: int, visited: set[int]) -> bool:
        for prediction_index in adjacency[annotation_index]:
            if prediction_index in visited:
                continue
            visited.add(prediction_index)
            previous_annotation = matched_prediction_to_annotation[prediction_index]
            if previous_annotation == -1 or augment(previous_annotation, visited):
                matched_prediction_to_annotation[prediction_index] = annotation_index
                matched_annotation_to_prediction[annotation_index] = prediction_index
                return True
        return False

    for annotation_index in range(len(ordered_annotations)):
        augment(annotation_index, set())

    matches: list[tuple[Mapping[str, Any], Mapping[str, Any], float]] = []
    for annotation_index, prediction_index in enumerate(matched_annotation_to_prediction):
        if prediction_index == -1:
            continue
        annotation = ordered_annotations[annotation_index]
        prediction = ordered_predictions[prediction_index]
        matches.append((annotation, prediction, interval_iou(annotation, prediction)))
    return matches


def _nullable_ratio(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return numerator / denominator


def _round_metric(value: float | None) -> float | None:
    return None if value is None else round(value, 6)


def _empty_event_metrics() -> dict[str, Any]:
    return {
        "recording_count": 0,
        "duration_seconds": 0.0,
        "annotation_count": 0,
        "prediction_count": 0,
        "true_positive_count": 0,
        "false_positive_count": 0,
        "false_negative_count": 0,
        "matched_count": 0,
        "precision": None,
        "recall": None,
        "f1": None,
        "false_positives_per_minute": None,
        "onset_error_abs_seconds": None,
        "offset_error_abs_seconds": None,
        # Short aliases make the report convenient for a table without making
        # the meaning of the values ambiguous.
        "onset_error_seconds": None,
        "offset_error_seconds": None,
        "by_label": {
            label: {
                "annotation_count": 0,
                "prediction_count": 0,
                "true_positive_count": 0,
                "false_positive_count": 0,
                "false_negative_count": 0,
                "precision": None,
                "recall": None,
                "f1": None,
                "onset_error_abs_seconds": None,
                "offset_error_abs_seconds": None,
            }
            for label in sorted(ALLOWED_LABELS)
        },
    }


def _score_group(recordings: Iterable[Mapping[str, Any]], threshold: float) -> dict[str, Any]:
    selected = list(recordings)
    report = _empty_event_metrics()
    report["recording_count"] = len(selected)

    all_matches: list[tuple[Mapping[str, Any], Mapping[str, Any], float]] = []
    onset_errors: list[float] = []
    offset_errors: list[float] = []
    by_label_matches: dict[str, list[tuple[Mapping[str, Any], Mapping[str, Any], float]]] = {
        label: [] for label in ALLOWED_LABELS
    }
    for recording in selected:
        report["duration_seconds"] += float(recording["durationSeconds"])
        annotations = recording["annotations"]
        predictions = recording["predictions"]
        report["annotation_count"] += len(annotations)
        report["prediction_count"] += len(predictions)
        matches = maximum_cardinality_matches(
            annotations,
            predictions,
            iou_threshold=threshold,
        )
        all_matches.extend(matches)
        for annotation, prediction, _iou in matches:
            label = str(annotation["label"])
            by_label_matches[label].append((annotation, prediction, _iou))
            onset_errors.append(
                abs(
                    float(prediction["startSeconds"])
                    - float(annotation["startSeconds"])
                )
            )
            offset_errors.append(
                abs(
                    float(prediction["endSeconds"])
                    - float(annotation["endSeconds"])
                )
            )

    report["matched_count"] = len(all_matches)
    report["true_positive_count"] = len(all_matches)
    report["false_positive_count"] = report["prediction_count"] - len(all_matches)
    report["false_negative_count"] = report["annotation_count"] - len(all_matches)
    report["counts"] = {
        "annotations": report["annotation_count"],
        "predictions": report["prediction_count"],
        "matched": report["matched_count"],
        "true_positives": report["true_positive_count"],
        "false_positives": report["false_positive_count"],
        "false_negatives": report["false_negative_count"],
    }
    report["true_positives"] = report["true_positive_count"]
    report["false_positives"] = report["false_positive_count"]
    report["false_negatives"] = report["false_negative_count"]
    report["precision"] = _round_metric(
        _nullable_ratio(report["true_positive_count"], report["prediction_count"])
    )
    report["recall"] = _round_metric(
        _nullable_ratio(report["true_positive_count"], report["annotation_count"])
    )
    if report["precision"] is None or report["recall"] is None:
        report["f1"] = None
    elif report["precision"] + report["recall"] == 0:
        report["f1"] = 0.0
    else:
        report["f1"] = _round_metric(
            2.0
            * report["precision"]
            * report["recall"]
            / (report["precision"] + report["recall"])
        )
    duration_minutes = report["duration_seconds"] / 60.0
    report["false_positives_per_minute"] = _round_metric(
        _nullable_ratio(report["false_positive_count"], 1)
        / duration_minutes
        if duration_minutes > 0.0
        else None
    )
    report["onset_error_abs_seconds"] = _round_metric(
        sum(onset_errors) / len(onset_errors) if onset_errors else None
    )
    report["offset_error_abs_seconds"] = _round_metric(
        sum(offset_errors) / len(offset_errors) if offset_errors else None
    )
    report["onset_error_seconds"] = report["onset_error_abs_seconds"]
    report["offset_error_seconds"] = report["offset_error_abs_seconds"]

    for label in sorted(ALLOWED_LABELS):
        label_annotations = sum(
            1
            for recording in selected
            for annotation in recording["annotations"]
            if annotation["label"] == label
        )
        label_predictions = sum(
            1
            for recording in selected
            for prediction in recording["predictions"]
            if prediction["label"] == label
        )
        label_matches = by_label_matches[label]
        label_true_positive = len(label_matches)
        label_false_positive = label_predictions - label_true_positive
        label_false_negative = label_annotations - label_true_positive
        label_precision = _nullable_ratio(label_true_positive, label_predictions)
        label_recall = _nullable_ratio(label_true_positive, label_annotations)
        label_f1 = (
            None
            if label_precision is None or label_recall is None
            else (
                0.0
                if label_precision + label_recall == 0
                else 2.0
                * label_precision
                * label_recall
                / (label_precision + label_recall)
            )
        )
        label_onset = [
            abs(float(prediction["startSeconds"]) - float(annotation["startSeconds"]))
            for annotation, prediction, _iou in label_matches
        ]
        label_offset = [
            abs(float(prediction["endSeconds"]) - float(annotation["endSeconds"]))
            for annotation, prediction, _iou in label_matches
        ]
        report["by_label"][label] = {
            "annotation_count": label_annotations,
            "prediction_count": label_predictions,
            "true_positive_count": label_true_positive,
            "false_positive_count": label_false_positive,
            "false_negative_count": label_false_negative,
            "precision": _round_metric(label_precision),
            "recall": _round_metric(label_recall),
            "f1": _round_metric(label_f1),
            "onset_error_abs_seconds": _round_metric(
                sum(label_onset) / len(label_onset) if label_onset else None
            ),
            "offset_error_abs_seconds": _round_metric(
                sum(label_offset) / len(label_offset) if label_offset else None
            ),
            "counts": {
                "annotations": label_annotations,
                "predictions": label_predictions,
                "matched": label_true_positive,
                "true_positives": label_true_positive,
                "false_positives": label_false_positive,
                "false_negatives": label_false_negative,
            },
        }
    return report


def _human_eligible(recording: Mapping[str, Any]) -> bool:
    return bool(recording["consented"] is True and recording["synthetic"] is False)


def evaluate_dataset(
    payload: Any,
    *,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
) -> dict[str, Any]:
    """Validate and score an acoustic filler evaluation payload."""

    threshold = _validate_threshold(iou_threshold)
    recordings = validate_dataset(payload)
    all_metrics = _score_group(recordings, threshold)
    human_recordings = [recording for recording in recordings if _human_eligible(recording)]
    synthetic_recordings = [
        recording for recording in recordings if recording["synthetic"] is True
    ]

    by_split = {
        split: _score_group(
            [recording for recording in recordings if recording["split"] == split],
            threshold,
        )
        for split in sorted(ALLOWED_SPLITS)
    }
    human_by_split = {
        split: _score_group(
            [
                recording
                for recording in human_recordings
                if recording["split"] == split
            ],
            threshold,
        )
        for split in sorted(ALLOWED_SPLITS)
    }
    synthetic_by_split = {
        split: _score_group(
            [
                recording
                for recording in synthetic_recordings
                if recording["split"] == split
            ],
            threshold,
        )
        for split in sorted(ALLOWED_SPLITS)
    }

    human_test = human_by_split["test"]
    human_reasons: list[str] = []
    if (
        human_test["recording_count"] == 0
        or human_test["duration_seconds"] <= 0.0
    ):
        human_reasons.append(
            "no positive-duration consented non-synthetic test recordings"
        )
    if any(
        recording["synthetic"] is False and recording["consented"] is False
        for recording in recordings
    ):
        human_reasons.append("unconsented non-synthetic recordings are excluded")
    human_eligibility = {
        "eligible": not human_reasons,
        "recording_count": len(human_recordings),
        "test_recording_count": human_test["recording_count"],
        "annotation_count": sum(
            len(recording["annotations"]) for recording in human_recordings
        ),
        "prediction_count": sum(
            len(recording["predictions"]) for recording in human_recordings
        ),
        "reasons": human_reasons,
    }

    dataset = {
        "recording_count": len(recordings),
        "annotation_count": sum(len(recording["annotations"]) for recording in recordings),
        "prediction_count": sum(len(recording["predictions"]) for recording in recordings),
        "duration_seconds": _round_metric(
            sum(float(recording["durationSeconds"]) for recording in recordings)
        ),
        "human_recording_count": len(human_recordings),
        "synthetic_recording_count": len(synthetic_recordings),
        "by_split": {
            split: {
                "recording_count": by_split[split]["recording_count"],
                "annotation_count": by_split[split]["annotation_count"],
                "prediction_count": by_split[split]["prediction_count"],
                "duration_seconds": by_split[split]["duration_seconds"],
            }
            for split in sorted(ALLOWED_SPLITS)
        },
    }

    # ``metrics`` exposes all metrics directly for simple consumers and also
    # keeps explicit human/synthetic/split views in the same stable object.
    metrics = dict(all_metrics)
    metrics.update(
        {
            "all": all_metrics,
            "human": _score_group(human_recordings, threshold),
            "synthetic": _score_group(synthetic_recordings, threshold),
            "by_split": by_split,
            "human_by_split": human_by_split,
            "synthetic_by_split": synthetic_by_split,
        }
    )
    return {
        "schema": SCHEMA,
        "iou_threshold": threshold,
        "dataset": dataset,
        "metrics": metrics,
        "human_eligibility": human_eligibility,
        "synthetic_is_ineligible": True,
    }


# Short aliases make the module easy to discover from small scripts and keep
# compatibility if a caller naturally names the operation ``evaluate``.
evaluate = evaluate_dataset


def load_json(stream: TextIO) -> Any:
    """Load strict JSON, rejecting non-standard NaN and Infinity constants."""

    def reject_constant(value: str) -> None:
        raise EvaluationInputError(f"non-finite JSON constant {value} is not allowed")

    try:
        return json.load(stream, parse_constant=reject_constant)
    except json.JSONDecodeError as error:
        raise EvaluationInputError(f"invalid JSON ({error.msg})") from error


def load_path(path: Path) -> Any:
    if str(path) == "-":
        return load_json(sys.stdin)
    try:
        with path.open("r", encoding="utf-8") as stream:
            return load_json(stream)
    except OSError as error:
        raise EvaluationInputError(f"cannot read {path}: {error}") from error


def _write_json(path: Path, rendered: str) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = stream.name
            stream.write(rendered + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except OSError as error:
        raise EvaluationInputError(f"cannot write {path}: {error}") from error
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        default=Path("-"),
        help="JSON file, or -/omitted for stdin",
    )
    parser.add_argument(
        "--iou-threshold",
        "--threshold",
        type=float,
        default=DEFAULT_IOU_THRESHOLD,
        help="minimum same-label interval IoU (default: %(default)s)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="also write the JSON report to this path",
    )
    args = parser.parse_args(argv)
    try:
        if args.output is not None and str(args.input) != "-" and (
            args.output.resolve() == args.input.resolve()
            or (args.output.exists() and args.input.exists() and os.path.samefile(args.output, args.input))
        ):
            raise EvaluationInputError("output must not overwrite the annotated input dataset")
        report = evaluate_dataset(
            load_path(args.input),
            iou_threshold=args.iou_threshold,
        )
        rendered = json.dumps(report, indent=2, sort_keys=True, allow_nan=False)
        if args.output is not None:
            _write_json(args.output, rendered)
    except (EvaluationInputError, OSError, TypeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
