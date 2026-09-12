# Session 1 held-out evaluation protocol

Run `python3 tools/evaluate_t1_speech.py /private/path/heldout.jsonl`.
This extends the existing `tools/evaluate_speech.py` input contract and its split/consent/identity checks.
The runner prints aggregate results without transcript text and never declares release acceptance.
The unit-test data is fabricated to test the evaluator, not a measured human result.

Freeze the implementation commit and model/config before collecting held-out predictions.
Keep the tuning manifest in the input so speaker, recording and audio overlap can be detected.
Human rows require `source: "consented"`, `consented: true`, disjoint speaker/recording/audio identities, and `device`, `os`, `build`, `model_config`, `processor`, `reviewer`, and `prediction_commit` strings.
Record the actual processor, including CPU fallback, without inferring it from hardware capability.
`audio_sha256` identifies the individual read clip; repeated copies of that clip cannot count as distinct clean reads.
Keep all human recordings, references and identifying metadata outside Git.
The tool validates declarations and scores observations; it cannot authenticate consent, device provenance, completeness of the submitted collection, or the reviewer's judgment.

## Issue 22

Include `expected_flub` from a blinded human review and `detected_flub` from the frozen app output.
For each correctly detected flag, the reviewer listens and compares the displayed reason and its raw script/transcript evidence against the recording, then supplies boolean `reason_matches`.
Missing judgments remain in the denominator and prevent a passing report.
The report requires at least ten correctly detected flags and agreement of at least 0.8 across all submitted correctly detected flags.
Keep missed flags and false flags in the input and run the baseline evaluator as well; reason agreement does not measure detection recall.

Command rows carry boolean `expected_command` and `detected_command` from the human label and actual app result.
Report positive reads, missed commands, ordinary-dialogue negative reads, false triggers and their denominator separately.
Include literal scripted “scratch that”, dialogue containing “cut”, quoted commands, noisy/short speech, provisional revisions, true standalone commands and recognition restarts.
The issue does not specify a numeric human command threshold, so the tool reports counts/rates without inventing one.

## Issue 23

Predeclare an `evaluation_run` and include every read in chronological `read_order`, starting at 1 with no omissions or duplicates.
Mark the tested requirements `must_say: true`, supply `must_say_status` from the implementation, and run the identical input through normal coverage separately for comparison.
A run qualifies only when all submitted reads are clean, at least twenty consecutive reads exist, and each is `covered` with `detected_flub: false`.
A pending/unavailable/missing verdict fails the clean-read run; it is not silently dropped.
A failed run cannot be salvaged by selecting a passing suffix.
Record any later run separately and report the failures too.
The tool cannot detect reads omitted before submission, so the named reviewer must check the capture manifest against the submitted sequence.

## Issues 24 and 29

Listen to original and previewed cleanup for quiet/noisy speech, stutters, intentional pauses/repeats, mid-sentence fillers and no speech.
Verify each approved splice against independent source-relative boundary evidence, then inspect exported captions and audio/video continuity.
No recognizer omission proves silence, and no synthetic timestamp proves a safe boundary.
On the integrated camera build test collapsed/expanded controls, long recordings, largest text setting, interrupted/unavailable/delayed recognition and no-speech guidance.
Report the physical device, OS, build, model/config and processor plus the named peer reproduction.

## Current measured evidence

`python3 tools/evaluate_t1_speech.py tools/speech-fixtures/synthetic-small.jsonl` reports zero human held-out rows, null reason agreement and command false-trigger rate, and `must_say_passes: false`.
No new human speech accuracy, safe-boundary listening, hardware/NPU, A/V or named peer evidence is supplied by this branch.
