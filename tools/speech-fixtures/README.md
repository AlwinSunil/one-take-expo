# Speech evaluation fixture

`synthetic-small.jsonl` is a deterministic fixture for checking JSONL parsing, WER, stratified counts, split leakage checks, and optional flub classification.

Every row is labeled `source: synthetic` and contains no audio or user transcript.
The fixture intentionally has fewer than 60 held-out clean and 30 held-out flub samples, so its report must remain ineligible for design-target accuracy claims.

Run the dependency-free fixture check from the repository root:

```sh
python3 tools/speech-fixtures/run_synthetic.py
```

Run the coverage verdict report, which sends the deterministic coverage scenarios and every fixture row through the real coverage domain:

```sh
npm run coverage:report
```

It prints precision and recall per coverage verdict and is labeled `synthetic fixtures, not human held-out data`.
It exits non-zero when a scenario replay disagrees with itself or a fixture row receives the wrong verdict.

Inspect the full report with:

```sh
python3 tools/evaluate_speech.py tools/speech-fixtures/synthetic-small.jsonl --pretty
```

For a human speech evaluation, obtain explicit consent, assign speakers and recordings to exactly one split, keep the audio fingerprint for leakage checks, and provide at least 60 held-out clean and 30 held-out flub samples.
Record `expected_flub` from review and `detected_flub` from the app's retake/flub decision when false-flag counts and recall are required.
Rows without both booleans remain valid WER inputs but cannot contribute to false-positive, false-negative, or recall metrics.
Do not commit those recordings or their reference transcripts.
