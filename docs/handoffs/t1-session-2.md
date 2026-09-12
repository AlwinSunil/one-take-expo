# Session 2 additive handoff: framing v1

Branch: `feat/t1-coaching-framing`, based on merged `e050a0d`.
Contract publication is the first commit on this branch; implementation commits follow on the same branch.

## Framing contract for Session 3

Suggestions are optional edit metadata, never media mutations or splice boundaries.
A request identifies `sourceMediaId`, `takeId`, `analysisId` (new per analysis attempt), source `durationMs`, selected half-open `[startMs,endMs)` and creator `intent: talking-head | vlog | product-demo`.
All timestamps are milliseconds relative to the original source presentation timeline, before trims, speed changes or concatenation.
Never use recognition timestamps as crop or splice evidence.
Reject identity mismatches and invalidate results when media, selected interval, intent, orientation or analysis revision changes.

Coordinates are normalized `[0,1]` top-left x/y/width/height rectangles in the upright, unmirrored original frame after applying clockwise metadata rotation (0/90/180/270).
`uprightWidthPx` and `uprightHeightPx` specify that frame; `rotationDegrees` records the transform from encoded media.
Preview mirroring is a display transform only and must not be baked into stored crops.
Crops preserve the original upright aspect ratio; target-aspect conversion is outside v1 and must use original-frame fallback until separately validated.
Regions include stable `trackId`, `kind: face | subject | product | hand`, rectangle, confidence `[0,1]`, and explicit creator selection/relevance.
Provenance identifies fixture versus device, model/version and actual processor (`cpu | gpu | npu | unknown`); fixture rules run on host CPU and prove no inference hardware.

Produce one static crop per selected interval, enclosing the union of all relevant regions throughout that interval with margin.
No per-frame crop chasing; maximum zoom 1.35x.
Missing, low-confidence, off-frame, discontinuous or unsafe multi-subject evidence produces the full original rectangle `{x:0,y:0,width:1,height:1}` with a reason.
Product demos require selected product and relevant hands; never replace these with presenter-only crops.
Return confidence conservatively as minimum supporting confidence, reasons, source identities, interval and provenance.
Consumers must keep originals and explicit apply/undo decisions, validate the payload, and never auto-apply.

Examples: portrait 1080x1920 talking head uses a stable portrait crop containing all selected face positions; moving subjects use their temporal union or original fallback; two people require both faces preserved or original; product with hands preserves all three regions; missing detections returns original, never a guessed center crop.
Executable types and fixtures will live under `src/features/vision/framing*`.

## Owner-authored integration requests

Session 3: add a common default-false Tier 1 gate for coaching and framing, retaining false until individual acceptance and Tier 0 regression pass.
Persist framing metadata additively keyed by immutable source/take/analysis identity, and apply only in your preview/export lane after validation and explicit choice.
Session 1: supply a props-only transcript/priority seam with take identity, monotonic timestamp, speech `silent | speaking | unknown`, observed between-lines boolean, and coverage/action priority boolean.
Unknown or stale speech signals suppress recording coaching; coverage/action signals always outrank optional tips.
No transcript strings or microphone consumer are required by coaching.

## Pending Tier 0 dependencies

#28 depends on #10 research, #15 / PR #56 vision readiness, and #18 / PR #55 composition coach.
The existing policy consumes calibrated observations, not raw face rectangles; separation and lighting remain manual until real-frame validation exists.
Extend the existing coach after merge, do not mount a second coach.
PR #57 owns incoming capture integration and PR #54 recording hardening; resolve camera changes only after merge.
#35 additionally depends on #28 and selected-take/source identity from Session 3.
No unmerged Tier 0 changes are copied or cherry-picked here.
