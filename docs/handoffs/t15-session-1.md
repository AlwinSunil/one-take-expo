# Tier 1.5 Session 1 producer contract

Branch: `feat/t15-speech-analysis`, based on merged main `15d80d6`.
Initial proposal, not an agreement from another session.
PR #58 remains open and is not incorporated.
Producer DTOs live in `src/features/speech-analysis/contracts.ts`.
Session 3 owns durable schema adaptation, jobs and canonical timeline application.
Session 2 owns capture and camera integration.

## Identity and time

Every analysis carries projectId, immutable sourceId, scriptRevision and editRevision captured when work starts.
Consumers reject mismatches against current revisions before offering application.
Never stamp current revisions onto historical evidence.
ScriptSpan retains original stable lineId and a span id with UTF-16 start/end offsets into captured spokenText, text and script order.
Point ids survive re-analysis; point revisions change when creator intent changes, and removed points remain tombstones.
Observation ids identify utterances within a source; takeId remains the existing captured take identity.
Job ids identify an invocation; proposal revision identifies its result.
SourceTiming is seconds relative to the original with provenance and nullable uncertaintySeconds.
Unknown uncertainty is null, never invented zero.
Existing framing milliseconds must be divided by 1000 explicitly with its original clock offset/provenance retained by the consumer.
Recognition boundaries are not verified cut boundaries.

## Alignment and reading position

The follower consumes existing session/sequence-filtered CaptionUpdate segments, a captured stable-line script snapshot, and the requested pickup line subset.
Its independent reading cursor emits matched line ids, skipped ids and provisional/pending/unavailable status.
Only final, unambiguous evidence commits movement.
Manual Previous/Next/remote movement starts a new evidence epoch and rejects utterances already buffered or started before its source-time barrier.
Reset on new source, retry, script revision, lens/route lifecycle or resume.
Reading movement never marks coverage, accepts a take, resolves actions or declares Wrap.
Session 2 must retain unresolved action controls and existing coverage/retake decisions separately.
A toggle/status component will be supplied; keep access explicitly development-only until #62 acceptance.

## Points and pickups

ImportantPoint suggestions quote actual spans with reasons; baseline extraction is a conservative rule policy, not Moonshine semantic output.
Creator edit/remove/importance choices survive re-analysis; changed script spans become pending for review.
PointMatch has independent spoken evidence; must-say and physical action completion are not inferred from importance.
Missing-point requests retain original project, point, line and source context plus unresolved actions.
Example A,C plus pickup B requests original B, then produces insertion intent at B's original script order.
Reverse capture order is resolved by script order, never timestamp order across sources.
One utterance covering adjacent B,C supplies one indivisible range linked to both points.
Nonadjacent shared utterances, stale script/edit revisions or manual target edits produce conflicts for consumer review.
Session 3 implements preview/accept/reject/undo, persistence and insertion; Session 2 records and saves pickup originals first.

## Final analysis

Reuse speech-control/cleanup.ts for silence/filler/restart observations.
Source-scoped related-attempt groups preserve partial, fuzzy, complete and nonadjacent alternatives.
Ranking reports supported completeness/adherence and explicit unknown optional gaze/delivery/silence evidence.
RangeProposal is revision-addressable and contains retained/excluded recommendations only.
Recognition-only boundaries remain retained with review reasons; exclusion requires verified whole-utterance boundaries.
Deliberate repeats and pauses remain preserved.
Consumers may accept the displayed proposal as a whole, without per-exclusion approval, while preserving undo and originals.
Session 3 owns cancellable durable job status and stale-result suppression; the producer accepts cancellation and never writes storage.
Session 2 saves original media before starting optional analysis and supplies complete stop transcript rather than bounded visible text.
Unknown, provisional, pending and unavailable are distinct from available evidence and never successful coverage.

## Integration requests

Session 3: supply atomic draft/project important-point persistence and revision snapshot interfaces before script-route wiring.
Session 2: adapt source clock and existing caption events, manual reanchors and lifecycle resets into follower; retain all Stop transcript observations.
Session 3: adapt proposed point pickup and range outputs to existing pickup journal and canonical timeline; keep originals accessible on failure.
No consumer edits or unmerged dependency code are copied into this branch.
Real-read matching, line-end-to-advance latency, integrated capture/export and named human review remain pending.
