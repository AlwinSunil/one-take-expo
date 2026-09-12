# Milestone 0 closeout

Closed as a research/readiness milestone at Melvin’s explicit request on 2026-09-13. This records what was demonstrated and carries unverified acceptance into the implementation handoff; it does not claim named-human review or production feature completion.

| Issue | Delivered evidence |
| --- | --- |
| #6 | Seven dev samples; 19/19 handoff checks, 12/12 sample UI paths, large-text/compact-display checks; final 7/7 real storage checks and 14/14 coaching policy checks on iQOO. Ownership, setup, CI and PR checklist. |
| #7 | Isolated 122.5-second video/audio/frame run, 600 actual HTP inferences (median 19 ms), memory/thermal traces, decoded audio comparison at both ends, native playback, positive/negative detector output and vision-disabled recording fallback. |
| #8 | Existing offline speech research already closed; its recorded findings are retained, not independently re-certified here. |
| #9 | Native cut preview, separate captioned MP4, decoded phrase-boundary checks, cancellation, background completion, interrupted retry, missing source, gallery and share chooser. Actual synthetic output attached. |
| #10 | Sourced rubric, creative-intent exceptions, model/rules comparison, licensed photo pairs and heldouts, iQOO photo-policy checks and 14/14 device policy checks. See final corpus report for breadth and limits. |

All behavioral evidence in this work comes from the physical iQOO I2501 / Android 16. Host tools compiled artifacts and generated fixtures. CI configuration is not a claimed local test run.

## Carried into Milestone 1

- Named teammates have not personally reproduced/reviewed the handoffs; agent review must not be attributed to them.
- Capture audio correlation establishes stable recorded/consumer audio timing, not physical face/lip synchronization. Full-body pose ROI and diverse-scene detector accuracy need further work.
- Media decoded-audio checks establish the padded synthetic fixture’s retained phrase boundaries. Arbitrary human speech splice safety, physical lip sync and low-storage fault injection remain unverified.
- Coaching crop rules and small photo sets do not establish skin-tone fairness, real-camera prompt precision or temporal stability. Keep unsupported automatic cues disabled; no trained model is promised.
- Speech and vision used different ORT versions in separate experiments. Resolve shared native packaging before integrating both; do not copy the isolated QNN runtime into production blindly.
- Main received production speech/export changes during this research. Preserve those changes and keep the research media module separately named. Earlier device evidence describes its stated research build, not an end-to-end certification of the newly combined main branch.

See the [Milestone 1 handoff](milestone-1-handoff.md), [capture report](../research/capture-vision/f1/device-results.md), [media report](../research/review-export/f3/device-evidence.md), and [coaching report](../research/capture-vision/f4/README.md). These limits are implementation validation work, not checked research assertions.
