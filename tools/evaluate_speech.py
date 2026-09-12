#!/usr/bin/env python3
"""Score consented speech JSONL without storing or printing transcript text.

Each input line is one scored segment.  The input contract is intentionally
small so a recording export can be evaluated with only the Python standard
library::

    {"id": "...", "speaker_id": "...", "recording_id": "...",
     "audio_sha256": "...", "split": "tuning"|"heldout",
     "label": "clean"|"flub", "expected_flub": false,
     "detected_flub": false, "reference": "...", "hypothesis": "...",
     "source": "consented", "consented": true}

Synthetic rows may use ``source: synthetic`` and ``consented: false``.  They
are useful for checking the runner and metric implementation, but they never
make the human speech minimum pass.  A report is eligible for design-target
accuracy only when held-out clean and flub minimums, split isolation, identity
checks, and consent checks all pass.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import sys
import unicodedata
from typing import Any, Iterable, Mapping, TextIO


MIN_HELDOUT_CLEAN = 60
MIN_HELDOUT_FLUB = 30
ALLOWED_SPLITS = frozenset({"tuning", "heldout"})
ALLOWED_SOURCES = frozenset({"consented", "synthetic"})
TOKEN_PATTERN = re.compile(r"[^\W_]+(?:['’][^\W_]+)?", re.UNICODE)


class EvaluationInputError(ValueError):
    """Raised when JSONL cannot satisfy the scoring input contract."""


def _text(value: Any, field: str, row_number: int) -> str:
    if not isinstance(value, str):
        raise EvaluationInputError(
            f"row {row_number}: {field} must be a string"
        )
    return value


def _identifier(value: Any, field: str, row_number: int) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise EvaluationInputError(
            f"row {row_number}: {field} must be a nonempty string or integer"
        )
    identifier = str(value).strip()
    if not identifier:
        raise EvaluationInputError(f"row {row_number}: {field} must be nonempty")
    return identifier


def _optional_identifier(
    record: Mapping[str, Any], field: str, row_number: int
) -> str | None:
    if field not in record or record[field] is None:
        return None
    return _identifier(record[field], field, row_number)


def _optional_bool(
    record: Mapping[str, Any], field: str, row_number: int
) -> bool | None:
    if field not in record or record[field] is None:
        return None
    value = record[field]
    if not isinstance(value, bool):
        raise EvaluationInputError(
            f"row {row_number}: {field} must be boolean when present"
        )
    return value


def normalize_tokens(text: str) -> list[str]:
    """Return stable case-folded word tokens for WER scoring."""

    normalized = unicodedata.normalize("NFKC", text).casefold()
    normalized = normalized.replace("’", "'")
    return TOKEN_PATTERN.findall(normalized)


def word_error_rate(reference: str, hypothesis: str) -> dict[str, int | float]:
    """Compute deterministic Levenshtein WER and its error breakdown."""

    reference_tokens = normalize_tokens(reference)
    hypothesis_tokens = normalize_tokens(hypothesis)
    rows = len(reference_tokens)
    columns = len(hypothesis_tokens)

    # Each cell stores (edit distance, substitutions, deletions, insertions).
    # Choosing the lexicographically smallest tuple makes ambiguous alignments
    # stable while preserving the minimum edit distance.
    matrix: list[list[tuple[int, int, int, int]]] = [
        [(0, 0, 0, 0) for _ in range(columns + 1)]
        for _ in range(rows + 1)
    ]
    for row in range(1, rows + 1):
        matrix[row][0] = (row, 0, row, 0)
    for column in range(1, columns + 1):
        matrix[0][column] = (column, 0, 0, column)

    for row in range(1, rows + 1):
        for column in range(1, columns + 1):
            if reference_tokens[row - 1] == hypothesis_tokens[column - 1]:
                diagonal = matrix[row - 1][column - 1]
            else:
                previous = matrix[row - 1][column - 1]
                diagonal = (
                    previous[0] + 1,
                    previous[1] + 1,
                    previous[2],
                    previous[3],
                )
            deletion_previous = matrix[row - 1][column]
            deletion = (
                deletion_previous[0] + 1,
                deletion_previous[1],
                deletion_previous[2] + 1,
                deletion_previous[3],
            )
            insertion_previous = matrix[row][column - 1]
            insertion = (
                insertion_previous[0] + 1,
                insertion_previous[1],
                insertion_previous[2],
                insertion_previous[3] + 1,
            )
            matrix[row][column] = min(diagonal, deletion, insertion)

    errors, substitutions, deletions, insertions = matrix[rows][columns]
    reference_words = len(reference_tokens)
    denominator = max(1, reference_words)
    return {
        "reference_words": reference_words,
        "hypothesis_words": len(hypothesis_tokens),
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "errors": errors,
        "wer": round(errors / denominator, 6),
    }


def _normalize_record(record: Mapping[str, Any], row_number: int) -> dict[str, Any]:
    if not isinstance(record, Mapping):
        raise EvaluationInputError(f"row {row_number}: expected a JSON object")

    missing = [
        field
        for field in ("id", "split", "reference", "hypothesis")
        if field not in record
    ]
    if missing:
        raise EvaluationInputError(
            f"row {row_number}: missing required field(s): {', '.join(missing)}"
        )

    row_id = _identifier(record["id"], "id", row_number)
    split = _text(record["split"], "split", row_number).strip().casefold()
    if split not in ALLOWED_SPLITS:
        raise EvaluationInputError(
            f"row {row_number}: split must be tuning or heldout"
        )
    reference = _text(record["reference"], "reference", row_number)
    hypothesis = _text(record["hypothesis"], "hypothesis", row_number)

    label_value = record.get("label", "unlabelled")
    label = _text(label_value, "label", row_number).strip().casefold()
    if not label:
        label = "unlabelled"

    source_value = record.get("source", "unspecified")
    source = _text(source_value, "source", row_number).strip().casefold()
    if not source:
        source = "unspecified"

    consented = record.get("consented")
    if consented is not None and not isinstance(consented, bool):
        raise EvaluationInputError(
            f"row {row_number}: consented must be boolean when present"
        )

    expected_flub = _optional_bool(record, "expected_flub", row_number)
    expected_flub_source = "expected_flub" if expected_flub is not None else None
    if expected_flub is None and label in {"clean", "flub"}:
        # The existing label is a useful declared ground-truth stratum.  Do
        # not infer the app's decision from WER: a transcript error is not a
        # flub/retake decision.
        expected_flub = label == "flub"
        expected_flub_source = "label"

    return {
        "id": row_id,
        "speaker_id": _optional_identifier(record, "speaker_id", row_number),
        "recording_id": _optional_identifier(record, "recording_id", row_number),
        "audio_sha256": _optional_identifier(record, "audio_sha256", row_number),
        "split": split,
        "label": label,
        "reference": reference,
        "hypothesis": hypothesis,
        "source": source,
        "consented": consented,
        "expected_flub": expected_flub,
        "expected_flub_source": expected_flub_source,
        "detected_flub": _optional_bool(record, "detected_flub", row_number),
    }


def load_jsonl(stream: TextIO) -> list[dict[str, Any]]:
    """Load and validate records from an open JSONL stream."""

    records: list[dict[str, Any]] = []
    for row_number, line in enumerate(stream, start=1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise EvaluationInputError(
                f"row {row_number}: invalid JSON ({error.msg})"
            ) from error
        records.append(_normalize_record(value, row_number))
    return records


def load_path(path: Path) -> list[dict[str, Any]]:
    if str(path) == "-":
        return load_jsonl(sys.stdin)
    with path.open("r", encoding="utf-8") as stream:
        return load_jsonl(stream)


def _metric_template() -> dict[str, int | float]:
    return {
        "sample_count": 0,
        "reference_words": 0,
        "hypothesis_words": 0,
        "substitutions": 0,
        "deletions": 0,
        "insertions": 0,
        "errors": 0,
        "wer": 0.0,
    }


def _add_metric(
    target: dict[str, int | float], score: Mapping[str, int | float]
) -> None:
    target["sample_count"] += 1
    for key in (
        "reference_words",
        "hypothesis_words",
        "substitutions",
        "deletions",
        "insertions",
        "errors",
    ):
        target[key] += int(score[key])


def _finish_metric(metric: dict[str, int | float]) -> dict[str, int | float]:
    denominator = max(1, int(metric["reference_words"]))
    metric["wer"] = round(int(metric["errors"]) / denominator, 6)
    return metric


def _group_metrics(
    scored: Iterable[tuple[Mapping[str, Any], Mapping[str, int | float]]],
    key: str,
) -> dict[str, dict[str, int | float]]:
    groups: dict[str, dict[str, int | float]] = defaultdict(_metric_template)
    for row, score in scored:
        group = str(row[key])
        _add_metric(groups[group], score)
    return {group: _finish_metric(groups[group]) for group in sorted(groups)}


def _cross_split_overlap(
    records: Iterable[Mapping[str, Any]], field: str
) -> list[str]:
    split_values: dict[str, set[str]] = defaultdict(set)
    for record in records:
        value = record.get(field)
        if value:
            split_values[str(value)].add(str(record["split"]))
    return sorted(
        value
        for value, splits in split_values.items()
        if "tuning" in splits and "heldout" in splits
    )


def _duplicate_values(
    records: Iterable[Mapping[str, Any]], field: str
) -> list[str]:
    values = Counter(
        str(record[field])
        for record in records
        if record.get(field) is not None and str(record[field])
    )
    return sorted(value for value, count in values.items() if count > 1)


def _classification_template() -> dict[str, int | float | None]:
    return {
        "sample_count": 0,
        "true_positive_count": 0,
        "true_negative_count": 0,
        "false_positive_count": 0,
        "false_negative_count": 0,
        "expected_flub_count": 0,
        "detected_flub_count": 0,
        "precision": None,
        "recall": None,
        "specificity": None,
        "accuracy": None,
    }


def _finish_rate(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return round(numerator / denominator, 6)


def _flub_classification(
    records: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Summarize reviewed flub labels against the app's flub decision.

    Both booleans are optional because existing WER-only rows remain useful.
    Incomplete rows stay in transcription metrics and are reported here, but
    are excluded from the confusion matrix and rates.
    """

    rows = list(records)
    complete = [
        row
        for row in rows
        if row.get("expected_flub") is not None
        and row.get("detected_flub") is not None
    ]
    metrics = _classification_template()
    for row in complete:
        expected = bool(row["expected_flub"])
        detected = bool(row["detected_flub"])
        if expected and detected:
            metrics["true_positive_count"] += 1
        elif expected:
            metrics["false_negative_count"] += 1
        elif detected:
            metrics["false_positive_count"] += 1
        else:
            metrics["true_negative_count"] += 1

    true_positive = int(metrics["true_positive_count"])
    true_negative = int(metrics["true_negative_count"])
    false_positive = int(metrics["false_positive_count"])
    false_negative = int(metrics["false_negative_count"])
    synthetic_complete = sum(row["source"] == "synthetic" for row in complete)
    metrics["sample_count"] = len(complete)
    metrics["expected_flub_count"] = true_positive + false_negative
    metrics["detected_flub_count"] = true_positive + false_positive
    metrics["precision"] = _finish_rate(
        true_positive, true_positive + false_positive
    )
    metrics["recall"] = _finish_rate(
        true_positive, true_positive + false_negative
    )
    metrics["specificity"] = _finish_rate(
        true_negative, true_negative + false_positive
    )
    metrics["accuracy"] = _finish_rate(
        true_positive + true_negative, len(complete)
    )
    return {
        **metrics,
        "rows_missing_expected_flub": sum(
            row.get("expected_flub") is None for row in rows
        ),
        "rows_missing_detected_flub": sum(
            row.get("detected_flub") is None for row in rows
        ),
        "synthetic_sample_count": synthetic_complete,
        "human_sample_count": len(complete) - synthetic_complete,
        "complete": len(complete) == len(rows),
        "eligible_for_false_flag_targets": bool(complete)
        and synthetic_complete == 0
        and all(
            row["source"] == "consented" and row["consented"] is True
            for row in complete
        ),
    }


def evaluate_records(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Return metrics, split checks, and quality gates for validated records."""

    normalized = [
        _normalize_record(record, index) for index, record in enumerate(records, start=1)
    ]
    scored = [(record, word_error_rate(record["reference"], record["hypothesis"])) for record in normalized]

    overall = _metric_template()
    for _, score in scored:
        _add_metric(overall, score)
    _finish_metric(overall)

    tuning_count = sum(record["split"] == "tuning" for record in normalized)
    heldout_count = sum(record["split"] == "heldout" for record in normalized)
    split_checks = {
        "tuning_count": tuning_count,
        "heldout_count": heldout_count,
        "both_splits_present": tuning_count > 0 and heldout_count > 0,
        "same_recording_in_both_splits": _cross_split_overlap(
            normalized, "recording_id"
        ),
        "same_speaker_in_both_splits": _cross_split_overlap(
            normalized, "speaker_id"
        ),
        "same_audio_in_both_splits": _cross_split_overlap(
            normalized, "audio_sha256"
        ),
    }

    duplicate_ids = _duplicate_values(normalized, "id")
    leakage = {
        "duplicate_ids": duplicate_ids,
        "cross_split_recording_ids": split_checks["same_recording_in_both_splits"],
        "cross_split_speaker_ids": split_checks["same_speaker_in_both_splits"],
        "cross_split_audio_sha256": split_checks["same_audio_in_both_splits"],
        "has_leakage": bool(
            duplicate_ids
            or split_checks["same_recording_in_both_splits"]
            or split_checks["same_speaker_in_both_splits"]
            or split_checks["same_audio_in_both_splits"]
        ),
    }

    source_counts = Counter(record["source"] for record in normalized)
    invalid_sources = sorted(
        source for source in source_counts if source not in ALLOWED_SOURCES
    )
    rows_without_speaker = sum(record["speaker_id"] is None for record in normalized)
    rows_without_recording = sum(record["recording_id"] is None for record in normalized)
    rows_without_audio_hash = sum(record["audio_sha256"] is None for record in normalized)
    unconsented_real_rows = sum(
        record["source"] == "consented" and record["consented"] is not True
        for record in normalized
    )
    synthetic_with_consent = sum(
        record["source"] == "synthetic" and record["consented"] is True
        for record in normalized
    )
    consent = {
        "source_counts": dict(sorted(source_counts.items())),
        "invalid_sources": invalid_sources,
        "unconsented_real_rows": unconsented_real_rows,
        "synthetic_rows_with_consent_flag": synthetic_with_consent,
        "ok": not invalid_sources and unconsented_real_rows == 0,
    }

    human_heldout = [
        record
        for record in normalized
        if record["split"] == "heldout"
        and record["source"] == "consented"
        and record["consented"] is True
    ]
    heldout_labels = Counter(record["label"] for record in human_heldout)
    synthetic_heldout_labels = Counter(
        record["label"]
        for record in normalized
        if record["split"] == "heldout" and record["source"] == "synthetic"
    )
    minimums = {
        "eligible_source": "consented",
        "heldout_clean_required": MIN_HELDOUT_CLEAN,
        "heldout_flub_required": MIN_HELDOUT_FLUB,
        "heldout_clean_count": heldout_labels.get("clean", 0),
        "heldout_flub_count": heldout_labels.get("flub", 0),
        "heldout_synthetic_clean_count": synthetic_heldout_labels.get("clean", 0),
        "heldout_synthetic_flub_count": synthetic_heldout_labels.get("flub", 0),
        "met": (
            heldout_labels.get("clean", 0) >= MIN_HELDOUT_CLEAN
            and heldout_labels.get("flub", 0) >= MIN_HELDOUT_FLUB
        ),
    }

    classification = _flub_classification(normalized)
    classification["by_split"] = {
        split: _flub_classification(
            record for record in normalized if record["split"] == split
        )
        for split in sorted(ALLOWED_SPLITS)
    }

    identity = {
        "rows_without_speaker_id": rows_without_speaker,
        "rows_without_recording_id": rows_without_recording,
        "rows_without_audio_sha256": rows_without_audio_hash,
        "complete": (
            rows_without_speaker == 0
            and rows_without_recording == 0
            and rows_without_audio_hash == 0
        ),
    }

    gate_reasons: list[str] = []
    if not minimums["met"]:
        gate_reasons.append("heldout minimums are not met")
    if leakage["has_leakage"]:
        gate_reasons.append("tuning and heldout data are not isolated")
    if not identity["complete"]:
        gate_reasons.append(
            "speaker_id, recording_id, and audio_sha256 are required for isolation"
        )
    if not consent["ok"]:
        gate_reasons.append("every non-synthetic row must carry consented: true")
    if not split_checks["both_splits_present"]:
        gate_reasons.append("both tuning and heldout rows are required")
    if any(record["source"] == "synthetic" for record in normalized):
        gate_reasons.append("synthetic rows cannot qualify for human design targets")

    return {
        "schema": "one-take-speech-evaluation/v1",
        "dataset": {
            "sample_count": len(normalized),
            "source_counts": dict(sorted(source_counts.items())),
            "synthetic_only": bool(normalized) and all(
                record["source"] == "synthetic" for record in normalized
            ),
        },
        "metrics": {
            "overall": overall,
            "by_split": _group_metrics(scored, "split"),
            "by_label": _group_metrics(scored, "label"),
            "by_split_label": {
                split: _group_metrics(
                    ((row, score) for row, score in scored if row["split"] == split),
                    "label",
                )
                for split in sorted(ALLOWED_SPLITS)
            },
        },
        "split_checks": split_checks,
        "leakage": leakage,
        "consent": consent,
        "identity": identity,
        "minimums": minimums,
        "classification": classification,
        "quality_gate": {
            "eligible_for_design_targets": not gate_reasons,
            "reasons": gate_reasons,
        },
    }


def _write_report(report: Mapping[str, Any], output: Path | None, pretty: bool) -> None:
    text = json.dumps(report, indent=2 if pretty else None, sort_keys=True) + "\n"
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
    sys.stdout.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="consented JSONL file, or - for stdin")
    parser.add_argument("--output", type=Path, help="also write the JSON report here")
    parser.add_argument("--pretty", action="store_true", help="indent the JSON report")
    parser.add_argument(
        "--require-minimums",
        action="store_true",
        help="exit 2 unless heldout clean/flub minimums and all quality gates pass",
    )
    parser.add_argument(
        "--allow-leakage",
        action="store_true",
        help="keep scoring when leakage is present, while retaining the warning",
    )
    args = parser.parse_args(argv)

    try:
        records = load_path(args.input)
        report = evaluate_records(records)
    except (OSError, EvaluationInputError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    _write_report(report, args.output, args.pretty)
    if report["leakage"]["has_leakage"] and not args.allow_leakage:
        return 2
    if args.require_minimums and not report["quality_gate"]["eligible_for_design_targets"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
