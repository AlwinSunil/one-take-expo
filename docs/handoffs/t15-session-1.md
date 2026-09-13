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

## Published consumer proposals inspected

Session 2 `aa8ec85` publishes capture scope and unknown-only current gaze semantics.
Session 3 `ccce524` publishes a design-only shared schema pending #58.
These documents were read from remote Git objects; no unmerged implementation was copied.
Session 1 will consume actual available gaze only, so the current face-only provider remains unknown.
Session 3's numeric script/timeline/transcript revisions can be converted to opaque strings in the producer adapter; `editRevision` corresponds to its timeline revision.
`AnalysisScope.transcriptRevision` carries the captured transcript revision for final jobs.
The consumer must map the entire revision vector and retain job attempt in its durable envelope.
A producer proposal does not claim owner agreement.

## Important-point API

`important-points.ts` exports `suggestImportantPoints(doc, scriptRevision, previous)`, `editImportantPoint`, `addImportantPoint`, `reattachImportantPoint`, `matchImportantPoints`, `createMissingPointPickup` and `proposePickupInsertion`.
The baseline suggests complete spoken lines of at least three words as important, and marks shorter/incomplete lines optional/unknown.
This intentionally overselects complete lines rather than inventing unsupported summaries or claiming learned importance estimation.
Its importance quality and broader paraphrase recall need human evaluation.
Every suggested text is copied from a stable captured line span; bracketed actions are excluded by the existing parser.
Creator changes are preserved, including removal tombstones.
A script revision change requires explicit reattachment before pickup coverage can be current.
Manual additions take a caller-minted durable id and an actual selected span.

`ImportantPoints` is a controlled, default-hidden component with edit/remove/importance, manual selection, re-analysis and stale-attachment callbacks.
The owner adapter must implement `onAdd` with a script-span selector, `onReviewSpan` with explicit attachment confirmation, and atomically persist the returned point list with the script before capture.
No second draft store is introduced to make the component appear integrated.

Point matching returns final covered, partial/provisional, pending or unavailable independently of must-say/action results.
One identical utterance cannot cover repeated identical point slots without context.
Adjacent points may share one whole-utterance observation id.
`createMissingPointPickup` retains only chosen unresolved important points and original line ids, plus caller-supplied local script context and unresolved actions.
`proposePickupInsertion` sorts indivisible ranges by script order and returns conflicts for stale scope, changed target points, missing observations, unverified boundaries, nonadjacent shared utterances and speech covering points outside the requested slot.
Its insertions are intent, not an exported sequence or a mutation of existing good footage.
Consumers still validate original availability, source duration, current point revision and timeline conflicts before application.

## Existing integration identity and clock cautions

The dependency audit found `capture/coverage.ts` derives segment-linked take ids, and `project-workflow.ts` still synthesizes take ids from segments.
Those adapters must be changed by Sessions 2 and 3 to preserve the durable capture-attempt take id supplied with each speech observation.
Do not derive a new take id from recognition text, segment index or analysis job.
Use the existing `recordingTranscript` capture adapter to shift audio-stream observations into video-relative source seconds before persistence/final analysis.
Its clipped boundary observations are non-final and must remain so.
The follower may use the live audio-stream clock only when its manual barrier uses that same clock; do not mix it with source-video seconds without the known offset.

`ScriptPointSelector` supplies the spoken-span selection surface for manual additions and reattachment.
`MissingPointReview` supplies controlled selected point ids and Record missed points / Review original / Continue editing actions.
Session 3 should render it against the current revisioned point results after Stop and preserve direct original access regardless of analysis state.
These components have no recorder, database or timeline side effects.

Point matches now carry their complete analysis scope, including source and transcript revision.
For `createMissingPointPickup`, same-source matches must match the current transcript revision; cross-source matches require `currentTranscriptRevisions` keyed by source id.
For `proposePickupInsertion`, pass `pickupTranscriptRevision` equal to the current pickup transcript snapshot and `currentPointRevisions` for edited/deleted-point checking.
Missing or mismatched supplied revisions do not establish pickup coverage.
Empty uncollected speech defaults to unknown; pass explicit `available` only for a completed no-speech analysis.
Distinct pickup observations with overlapping source ranges produce a boundary conflict even if each separately claims verified boundaries.
Caller-provided context must belong to the request's script revision.

Reproducible transport fixtures are in `evidence/t15-session-1/pickup-fixtures.json`, generated with `node --experimental-strip-types tests/t15-pickup-fixtures.mjs`.
They include original/matched point records, pickup requests, reverse-order sources and one whole B,C utterance.
Boundary flags are simulated fixture inputs, not human listening evidence, and no canonical timeline has been applied.

## Follower integration example

```ts
let follower = createAlignmentState({
  lines: scriptDocument.lines,
  sessionId: nativeCaptionSessionId,
  scriptRevision: capturedScriptRevision,
  pickupLineIds: requestedOriginalLineIds,
  enabled: voiceFollowEnabled,
});
follower = reduceCaptionAlignment(follower, acceptedCaptionUpdate);
follower = manualNext(follower, currentTimeOnCaptionClockSeconds);
follower = manualPrevious(follower, currentTimeOnCaptionClockSeconds);
follower = reanchorAlignment(follower, selectedStableLineId, currentTimeOnCaptionClockSeconds);
```

Use `reduceCaptionAlignment` for the existing `CaptionUpdate` containing multiple segments under one sequence number.
`reduceAlignment` is the lower-level single-segment/status reducer.
Do not loop over update segments while assigning the same sequence number to each call.
Use the current line id to resolve the existing prompter document, including pickup subsets; never reinterpret its cursor as the full script's array index.
Its `committedLineIds` are alignment evidence only, not the existing coverage/take/playability verdict.
Keep required actions accessible using the existing action controls regardless of cursor position.
Pass source-clock time on manual/remote movement so pre-override buffered speech cannot undo it.
Missing post-override timing remains unresolved rather than advancing.
`resetAlignment` resets for source/retry/script/pickup/lifecycle/resume changes; pass the new native session identity and captured revision.
Use explicit status events for preparing/delayed/unavailable/interrupted/stopped and listening recovery.
Final text corrections pause rather than advancing twice, while retaining correction history.
`VoiceFollowToggle` takes controlled enabled/change/status props and `featureEnabled`, which defaults false.

## Final-analysis integration example

```ts
const result = await analyzeFinalTake({
  scope: { projectId, sourceId, scriptRevision, editRevision, transcriptRevision },
  jobId,
  revision: resultRevision,
  sourceDuration: savedOriginalDurationSeconds,
  observations: completeSourceTranscript,
  scriptSpans: capturedScriptSpans, // omit in Assisted Mode
  silences: actualQuietObservations,
  marks: actualSpeechMarks,
}, { signal: abortSignal, getCurrentScope: readCurrentScope });
```

Call only after the original is durably saved; the producer never saves, renders, schedules durable work or navigates.
Final jobs require a transcript revision and reject stale current script/edit/transcript scopes.
Unknown source duration withholds the range proposal and returns pending rather than treating the last ASR timestamp as media duration.
Observation ids identify unique history records; `utteranceId` links revisions of the same utterance, with explicit revision numbers or `revisionOf` links.
Keep `takeId` as the original capture-attempt id, not a recognizer segment id.
The result retains every supplied transcript observation, related groups, ranked attempts, cleanup suggestions, source-wide optional signal states, reasons and a revisioned range proposal.
`producerVersion` identifies the baseline analysis policy.
When only final segment snapshots are available, pass the complete source snapshot; do not pretend discarded provisional revisions were collected.
No missing confidence, gaze or silence measurements are fabricated.
Source-wide optional signals do not rank individual attempts without attempt-level provenance.

Whole-utterance exclusion requires a stronger complete replacement that preserves the candidate's content, independently verified boundaries and no overlapping source observation.
A group relation alone never authorizes dropping unique adjacent content.
All source gaps and deliberate pauses/repeats remain retained; original observations and alternatives remain available.
The async API yields the event loop between phases and checks cancellation/current scope; large synchronous phases are cooperatively cancellable at phase boundaries, not hard realtime jobs.
Session 3 must keep original playback accessible while a job runs and preserve the last creator edit when results are stale/cancelled/failed.
Saving may accept the displayed proposal as one reversible creator action; no per-exclusion approval loop is required.


## Current published source

Initial contracts: `f097b0f`.
Alignment implementation: `170b4dc`; point/pickup implementation: `5a9710c`; final-analysis implementation: `9fcff29`.
Current source including safety review corrections: `5947706` on draft PR https://github.com/AlwinSunil/one-take-expo/pull/70.
Use the current branch head, not the initial contract-only commit, for consumer integration after merge.
Exact local evidence and the still-pending acceptance matrix are in `t15-session-1-acceptance.md`.
No Session 2 or Session 3 agreement is implied by these references.

The conservative matcher does not support arbitrary clause reordering or all English paraphrases.
Its synthetic diagnostic has one missed paraphrase and the extraction baseline overselects three greeting/sign-off lines; real-read evaluation remains pending.
Manual movement without a source-clock timestamp holds following until a timed reanchor or a new recognition lifecycle, while manual controls remain usable.


Merged-main refresh: `5bed4c7` incorporates upstream `faeda74` / PR #73 without conflicts.
The producer implementation remains `5947706`; use the current branch head with this merged UI baseline for later integration.
Final refreshed typecheck, 378 tests, 19 sample checks and Android JavaScript export pass.
PR #58 remains open; no unmerged consumer code was incorporated.
