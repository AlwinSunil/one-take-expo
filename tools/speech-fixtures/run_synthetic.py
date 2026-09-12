#!/usr/bin/env python3
"""Run the checked-in synthetic speech evaluation fixture."""

from __future__ import annotations

import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

from evaluate_speech import evaluate_records, load_path  # noqa: E402


def main() -> int:
    fixture = Path(__file__).with_name("synthetic-small.jsonl")
    records = load_path(fixture)
    report = evaluate_records(records)
    if not report["dataset"]["synthetic_only"]:
        raise AssertionError("fixture must contain synthetic rows only")
    if report["leakage"]["has_leakage"]:
        raise AssertionError("synthetic fixture has an unexpected split leak")
    if report["minimums"]["met"]:
        raise AssertionError("small synthetic fixture must remain below human minimums")
    if report["dataset"]["sample_count"] == 0:
        raise AssertionError("synthetic fixture is empty")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
