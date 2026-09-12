# Speech evaluation protocol

This protocol addresses the accuracy evidence requested in issue #8.
There is no held-out human speech set in this repository yet.
The checked-in fixture is synthetic and is useful only for validating the evaluator and its data hygiene checks.
No accuracy claim should be made from that fixture.

The evaluator accepts one JSON object per line.
The required fields are `id`, `split`, `reference`, and `hypothesis`.
Production rows should also provide `speaker_id`, `recording_id`, `audio_sha256`, `label`, `source`, and `consented`.

| Field | Values | Purpose |
| --- | --- | --- |
| `id` | Unique string | Identifies one scored segment. |
| `speaker_id` | Stable pseudonymous ID | Keeps speakers disjoint between tuning and held-out data. |
| `recording_id` | Stable recording ID | Detects a recording copied into both splits. |
| `audio_sha256` | SHA-256 of the source audio | Detects byte-identical audio copied into both splits. |
| `split` | `tuning` or `heldout` | Keeps parameter selection separate from final measurement. |
| `label` | `clean`, `flub`, or another declared stratum | Supports clean/flub counts and WER stratification. |
| `reference` | Consent-approved transcription | The human reference used for WER. |
| `hypothesis` | Model output | The output captured from the same segment. |
| `source` | `consented` or `synthetic` | Prevents synthetic rows from being mistaken for human evidence. |
| `consented` | `true` for human rows | Records that the source may be used for evaluation. |
| `expected_flub` | Optional boolean | Reviewer-confirmed ground truth for whether the read should be treated as a flub. |
| `detected_flub` | Optional boolean | The app's actual flub/retake decision for that read. |

Use a pseudonymous speaker identifier rather than a name.
Keep recordings, reference transcripts, and identifiable metadata outside Git.
The evaluator reports counts and aggregate scores without echoing reference or hypothesis text.

Collect a tuning set first and use it only to choose model, decoding, VAD, or caption presentation parameters.
Collect held-out rows from speakers and recordings that do not occur in the tuning set.
Do not inspect held-out WER while changing a parameter.
When a parameter is changed, record the change and rerun the held-out set as a new evaluation.

Every held-out clean row must be labeled `clean` and every held-out disfluency row must be labeled `flub`.
The current design target is at least 60 held-out clean rows and 30 held-out flub rows.
The held-out minimum counts and design-target quality gate use only rows with `source: consented` and `consented: true`.
Synthetic rows are reported for parser and metric checks, but they cannot satisfy the human minimums or qualify a design-target report.
Keep synthetic rows in a separate fixture when measuring human accuracy so aggregate WER cannot mix the two evidence types.
The evaluator keeps the report ineligible until both counts are met.

The evaluator flags duplicate row IDs, cross-split speaker IDs, cross-split recording IDs, and cross-split audio hashes.
All three identity fields must be present for a report to pass the design-target gate.
It also flags missing or invalid consent metadata for non-synthetic rows.
Multiple segments from one recording are allowed within one split.

WER is computed after Unicode NFKC normalization, case folding, punctuation removal, and whitespace tokenization.
The report includes substitutions, deletions, insertions, reference word count, sample count, and aggregate WER.
Scores are available overall, by split, by label, and by split plus label.
WER is an aggregate transcription metric and does not by itself validate caption timing or the usefulness of utterance-final events.

False-flag reporting is separate from WER because a transcription error does not automatically mean that the app should request a retake.
Set `expected_flub` from the reviewed recording and `detected_flub` from the app decision when collecting a row.
For backwards-compatible WER-only rows, `expected_flub` is derived from `label` only when `label` is exactly `clean` or `flub`.
`detected_flub` is never inferred from the transcript.
Rows missing either boolean remain in WER and sample-count reports but are excluded from the confusion matrix and rates.
The report exposes true/false positive and negative counts, precision, flub recall, specificity, and the number of incomplete rows overall and by split.
Classification rows report human and synthetic counts separately, and synthetic rows make `classification.eligible_for_false_flag_targets` false.
`classification.eligible_for_false_flag_targets` is true only when every row has both fields and every classified row is a consented human row.
The recall denominator is the number of reviewed flub rows, and a false negative is a reviewed flub that the app did not flag.

Run the checks from the repository root:

```sh
python3 tools/speech-fixtures/run_synthetic.py
python3 tools/evaluate_speech.py tools/speech-fixtures/synthetic-small.jsonl --pretty
python3 tests/speech-evaluation.test.py
```

Evaluate a consented collection with:

```sh
python3 tools/evaluate_speech.py /path/to/consented-evaluation.jsonl --pretty --output /path/to/report.json
```

Use `--require-minimums` in a review or CI gate after the human collection is complete.
The command exits with status 2 when the held-out minimum, consent checks, split checks, or identity checks fail.
The synthetic fixture intentionally exits 2 with `--require-minimums`.

The current evidence status is:

| Evidence | Status |
| --- | --- |
| JSONL schema and WER implementation | Covered by standard-library tests. |
| Synthetic parser, stratification, and leakage runner | Covered by `tools/speech-fixtures/run_synthetic.py`. |
| False-flag counts and flub recall | Covered when rows include `detected_flub`; no human rows are collected yet. |
| Human held-out clean set of 60 samples | Pending collection. |
| Human held-out flub set of 30 samples | Pending collection. |
| Moonshine accuracy claim on this application | Not established. |
