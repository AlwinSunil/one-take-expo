#!/usr/bin/env python3
"""Measure Tier 1 human evidence; never treat deterministic replays as accuracy."""
import argparse
import json
from pathlib import Path
import sys
from evaluate_speech import evaluate_records, EvaluationInputError


def evaluate(rows):
    baseline = evaluate_records(rows)
    problems = []
    if baseline['leakage']['has_leakage']:
        problems.append('identity or split leakage')
    if not baseline['identity']['complete']:
        problems.append('missing isolation identity')
    if not baseline['consent']['ok']:
        problems.append('invalid consent/source')
    if not baseline['split_checks']['both_splits_present']:
        problems.append('include the tuning manifest and held-out rows')
    if any(r.get('source') != 'consented' or r.get('consented') is not True for r in rows):
        problems.append('synthetic or unconsented data cannot qualify')
    human = [r for r in rows if r.get('split') == 'heldout' and r.get('source') == 'consented' and r.get('consented') is True]
    # Audio fingerprints identify individual read clips, not a reused full-session file.
    hashes = [str(r.get('audio_sha256', '')).strip().lower() for r in human]
    if len(set(hashes)) != len(hashes):
        problems.append('duplicate held-out read audio')
    for row in rows:
        for field in ('expected_command', 'detected_command', 'reason_matches', 'must_say'):
            if field in row and not isinstance(row[field], bool):
                raise EvaluationInputError(f'{field} must be boolean')
    evidence_fields = ('device', 'os', 'build', 'model_config', 'processor', 'reviewer', 'prediction_commit')
    if any(not all(isinstance(r.get(k), str) and r[k].strip() for k in evidence_fields) for r in human):
        problems.append('missing device/config/prediction/reviewer provenance')
    flags = [r for r in human if r.get('expected_flub') is True and r.get('detected_flub') is True]
    judged = [r for r in flags if isinstance(r.get('reason_matches'), bool)]
    matched = sum(r['reason_matches'] for r in judged)
    reason_rate = matched / len(flags) if flags else None
    reasons_pass = not problems and len(flags) >= 10 and len(judged) == len(flags) and reason_rate >= .8
    command_candidates = [r for r in human if 'expected_command' in r or 'detected_command' in r or r.get('label') == 'command']
    command_rows = [r for r in command_candidates if 'expected_command' in r and 'detected_command' in r]
    missing_commands = len(command_candidates) - len(command_rows)
    if missing_commands:
        problems.append('command rows missing expected or detected command')
    negatives = [r for r in command_rows if not r['expected_command']]
    positives = [r for r in command_rows if r['expected_command']]
    false_triggers = sum(r['detected_command'] for r in negatives)
    # The nominated run is scored in full, never search for a convenient passing suffix.
    reads = [r for r in human if r.get('must_say') is True]
    runs = {}
    for row in reads:
        run = row.get('evaluation_run')
        order = row.get('read_order')
        if not isinstance(run, str) or not run.strip() or type(order) is not int or order < 1:
            problems.append('must-say reads need evaluation_run and positive read_order')
            continue
        runs.setdefault(run, []).append(row)
    run_reports = []
    for run, group in sorted(runs.items()):
        group.sort(key=lambda r: r['read_order'])
        consecutive = [r['read_order'] for r in group] == list(range(1, len(group) + 1))
        clean = all(r.get('expected_flub') is False and r.get('label') == 'clean' for r in group)
        successful = sum(r.get('detected_flub') is False and r.get('must_say_status') == 'covered' for r in group)
        run_reports.append({'run': run, 'reads': len(group), 'successful_reads': successful,
                            'consecutive': consecutive, 'all_clean': clean,
                            'passes': not problems and consecutive and clean and len(group) >= 20 and successful == len(group)})
    return {'schema': 'one-take-t1-evaluation/v1', 'human_heldout_rows': len(human),
            'limitations': sorted(set(problems)),
            'reasons': {'correctly_detected_flags': len(flags), 'reviewed': len(judged), 'matching': matched,
                        'agreement': reason_rate, 'passes': reasons_pass and not problems},
            'commands': {'incomplete_rows': missing_commands, 'negative_reads': len(negatives), 'false_triggers': false_triggers,
                         'false_trigger_rate': false_triggers / len(negatives) if negatives else None,
                         'positive_reads': len(positives), 'missed_commands': sum(not r['detected_command'] for r in positives)},
            'must_say_runs': run_reports,
            'must_say_passes': bool(run_reports) and all(r['passes'] for r in run_reports) and not problems,
            'release_accepted': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    try:
        rows = [json.loads(line) for line in args.input.read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')]
        report = evaluate(rows)
    except (OSError, ValueError, TypeError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
