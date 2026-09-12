# Session 1 Tier 1 handoff

Branch: `feat/t1-speech-control`, initially based on merged `origin/main` at `e050a0d` and subsequently updated through merged `11f4455` (including #12, #13, #16 and capture/review integration).
The implementation and this handoff are published on this branch; use the commit history, not another session's uncommitted files.
No Tier 0 branch is merged or cherry-picked here.

## Immediate owner requests

Session 3 owns `session.ts`, `store.ts`, `project-workflow.ts`, editor consumers and the common gate.
Please add an optional versioned speech-control envelope to draft/project persistence, preserving legacy records and rejecting malformed present metadata without silently downgrading required wording.
Keep the new features off by default until individual acceptance and Tier 0 regression evidence pass.
Session 1 supplies the isolated types, reducers and exported signatures below.

A take ID must be allocated once at the capture attempt boundary and persisted with its recording/source ID.
Never derive it from a recognition segment ID, text, array index or refinement job.
One take may link several recognition segments, and one segment may cover several script lines.
Refinement must retain take identity and raw evidence snapshots; changed segmentation requires explicit relinking, not equality of segment IDs across jobs.

`projectReview` currently makes `take:${segment.id}` and maps `needsListening` to `scratched`.
Please replace those behaviors for records carrying the new envelope.
Uncertain speech is review evidence, never a scratch event.
Legacy uncertain records must remain unresolved, with original media accessible, rather than being silently migrated into intentional discard history.
Keep old consumers compatible until migrated.

Manual and voice scratch must share one event reducer and persist explicit target take identity and append-only history.
Do not scratch earlier valid takes when the latest attempt is discarded.
Command observations use source-relative seconds and recognition provenance.
They can suppress a whole identified command caption, but they are NOT safe playback splice boundaries.
Playback exclusion stays pending until independently verified boundaries and creator review are supplied; never copy ASR times into a cut plan.

Must-say metadata is keyed by stable line identity, with a revision of the required spoken wording.
Retain the toggle through explicit edits and reorder; changing wording invalidates prior evidence.
Do not rematch metadata by similar text or attach it to a new line by position.
Bracket directions remain separate optional/manual actions.
Required actions marked skipped or pending remain unresolved.
Caption display corrections never establish spoken coverage.

## Incoming integration dependencies

- #12 / PR #46 merged during this session and was incorporated from `origin/main` at `b3240f2`; the real script document parser/serializer now has a passing must-say compatibility test.
  Session 1 route wiring remains dependent on Session 3's atomic persistence adapter and common gate.
- #13 / PR #50 is now merged and incorporated via `11f4455`; no new native confidence or silence guarantee is assumed.
- #16 / PR #48 is now merged and incorporated via `11f4455`; Session 3 must compose strict must-say results into review/wrap rather than using ordinary normalized coverage alone.
- #26 / PR #57 capture integration is now merged; Session 2 still owns Tier 1 component and explicit take/scratch event consumption there.
- #30 and #31 Session 3 consumers must persist/render reasons, unresolved requirements, reversible decisions and command exclusions.

## Acceptance constraints

Synthetic replay proves deterministic decisions only.
#22 still needs held-out human reason agreement of at least 8/10 correctly detected flags and command false-trigger measurements.
#23 still needs 20 consecutive clean held-out human must-say reads with zero false flags.
#24 needs listening and safe-boundary/caption export review.
#29 needs long-session, large-text and failure-state device review.
Named reviewer remains @AlwinSunil; shared handoffs require both peers.

## Audited capture seam and gate proposal

The initial handoff is commit `0eeef72`; evaluator/protocol is `52ca1b8`; draft PR is https://github.com/AlwinSunil/one-take-expo/pull/59.
PR #57 already allocates `captureTakeId` and routes manual scratch through `createCaptureCommandGate`.
Reuse its generation filtering and the recording-level identity when adapting Session 1 scratch events.
Its `deriveCaptureCoverage` still constructs `${takeId}:segment:${segment.id}` as take identity, so Session 2 must change that adapter to consume durable attempt records in the merged capture adapter.
Do not blindly rename existing persisted takes; retain a legacy mapping and preserve all originals.

The native `QuietIntervals.find` uses low-energy windows and reports candidate `t0`/`t1` only.
It does not provide independent verified boundary evidence.
Treat those candidates as review marks until a boundary verifier and creator review supply provenance.
No new native confidence, speech-presence, NPU or boundary guarantees are introduced by Session 1.

Proposed gate shape for Session 3 to author: one default-false release gate plus per-feature acceptance booleans for issues 22, 23, 24 and 29.
Camera/editor/script owners should pass `enabled = tier0RegressionPassed && featureAcceptancePassed && tier1Enabled` to isolated Tier 1 presentation and event adapters.
Persisted metadata must still round-trip while the gate is off, so toggling release availability never deletes creator intent or history.
Core pure functions remain callable by replay tests; no production route imports or invokes them in this branch.
The existing merged UI remains intact until the common gate and owner integration land.

Session 3 CI request: add `python3 tests/t1-speech-evaluation.test.py` alongside the existing speech evaluator command.
The current Python test naming does not match default unittest discovery; use that exact explicit invocation.
New `tests/t1-*.test.mjs` behavior tests are picked up by the existing `npm test` glob without package/config changes.

## Must-say contract for Sessions 2 and 3

Import from `src/features/speech-control/must-say.ts`.
`MustSayMetadata = { version: 1, requirements: MustSayRequirement[], archived: MustSayRequirement[] }`.
Each requirement is `{ lineId: string, enabled: boolean, requiredText: string, revision: number }`.
Use `createMustSayMetadata(lines)`, `reconcileMustSayMetadata(previous, lines)`, `setMustSayEnabled(metadata, lineId, enabled)`, and `serializeMustSayMetadata` / `deserializeMustSayMetadata`.
`lines` accepts stable `id` and cue-free `spokenText`; raw `text` is a legacy fallback.
Prefer #12's parsed `spokenText`, especially when a creator explicitly treats brackets as spoken words.
Missing metadata returns null; malformed present metadata throws and must surface a recoverable persistence error, not silently disable required wording.
Archive deleted IDs, retain intent on explicit edits/reorders, and never reuse an archived ID for an unrelated replacement line.
Normalization policy version is the envelope's version 1: NFKC/case and surface punctuation/space folding, while numeric symbols, internal decimals, hyphens and apostrophes retain meaning.
No number-word conversion, brand alias, synonym, fuzzy score or caption edit can satisfy a requirement.

`evaluateMustSay(requirement, { segments, recognitionStatus, mediaAvailable })` returns `MustSayEvaluation` with `status: 'off' | 'needed' | 'pending' | 'covered' | 'unavailable'`, `reason`, `missingTokens`, and raw evidence.
For coverage a segment needs explicit final raw `text`, `takeId`, `playable: true`, `quality: 'clean'`, nonempty `mediaUri`, finite source-relative seconds `t0 >= 0`, `t1 > t0`, and `requirementRevisions: { [lineId]: capturedRevision }`.
Allocate that revision snapshot when the take begins, including requirements currently toggled off; do not stamp current revisions onto old recognition during reopen/refinement.
Preserve the snapshot across recognition jobs.
Manual corrections are ignored.
For a single line, the entire utterance must match.
For several consecutive lines in one breath, the adapter must supply `lineIds` and `scriptContext: { lineIds, normalizedText }` from the captured SCRIPT snapshot, never from ASR output.
The entire raw utterance must match that complete context, and the required phrase must appear within it.
Do not split the media take to produce this evidence.
Evidence includes recognition segment IDs, durable take IDs, raw text, source timing, line ID and the captured requirement revision; `isCurrentMustSayEvidence` rejects stale revisions.

Example: required `This is sponsored.` revision 2 is covered by raw `This is sponsored!` on a final clean playable take carrying `{ 'disclosure': 2 }`.
Raw `This is an advertisement.` or a manual caption edit to the required text remains needed.
An exact provisional read remains pending; a missing revision snapshot remains unresolved.

Session 1 script integration after the persistence adapter lands (#12 is now merged): render `MustSayToggle` below each spoken `ScriptLineRow`, with `featureEnabled` from the common gate, controlled `enabled`, and `onChange(lineId, enabled)` using `setMustSayEnabled`.
The toggle is hidden by default and has a 44px minimum target.
Session 3 must author atomic raw script/structured lines/must-say draft persistence and project snapshot/reopen support before Session 1 wires the route.
A failed metadata read must not enable autosave that overwrites the saved required intent.
The current string-only `acceptDraft` route contract is retained pending that owner handoff.

Wrap composition requested from Session 3: ordinary spoken coverage must pass, every must-say result must be `off` or `covered`, global recognition must not be pending, and all required actions must be manually done.
`needed`, `pending`, `unavailable`, missing media or a skipped required action must appear in #31's unresolved report and Session 2's Wrap anyway confirmation.
An ordinary paraphrase verdict cannot override a must-say result.

## Cleanup and live transcript contracts

Must-say implementation is pushed at `b3f067f`; cleanup/live implementation is pushed at `fe15717`.
Use these committed references when consuming the branch.

Import cleanup helpers from `src/features/speech-control/cleanup.ts`.
`generateCleanupSuggestions({ recordingId, segments, silences, marks })` returns evidence-bearing `CleanupSuggestion[]`; `createCleanupPlan` also retains original observations and prior decisions.
Map capture's durable `sourceId` to `recordingId`; all times are seconds relative to that original recording, never output timeline time or wall-clock time.
Native quiet candidates map to `silences` with stable namespaced IDs and no verified boundary claims.
Suggested silence defaults to at least 1.2 seconds; `deliberate: true` suppresses the suggestion.
A restarted attempt needs an unfinished multiword prefix and a nearby suitable final continuation; a repeat prefers the later suitable final phrase only as a listening candidate.
Uncertain or low-confidence later repeats do not displace earlier evidence.
The heuristic thresholds are deterministic fixture policy, not measured human accuracy.
Pass `intentionalRepeat: true` to preserve deliberate repetitions.

Every suggestion includes `id`, recording identity, source interval, kind, reason, supporting segment IDs/evidence, boundary provenance, `removalInterval`, and an evidence `fingerprint`.
Recognition-only repeats/restarts have uncertain boundaries and cannot prepare a cut.
Filler/mumble marks need explicit `isMidSentence: false`, independent verified start/end boundary records and an explicit recording identity before a removal can be prepared.
Missing placement or mid-sentence placement remains a mark.
`source: 'saved-audio'` is timing provenance only and never establishes a verified boundary.
Only explicit `source: 'independent-silence'` or `source: 'manual-review'` with `verified: true` on BOTH endpoints is usable; adapters must retain the underlying detector/listening evidence for review.
For fillers, manual review must actually establish quiet boundary suitability, not merely acknowledge the text.

Use `applyCleanupDecision(decisions, suggestion, 'accept' | 'dismiss')`, `restoreCleanupDecision(decisions, decisionId)`, and `prepareCleanupRemoval(suggestion, decisions)`.
An accept is scoped to recording identity and the exact evidence fingerprint; changed timing/evidence requires a fresh decision.
`prepareCleanupRemoval` returns null until all checks pass, otherwise source-relative `{ t0, t1 }` for the owner to preview and apply reversibly.
It never mutates media, captions or originals.
Do not apply `removalInterval` directly or trust serialized `canPrepareRemoval` without re-deriving the current suggestion from validated observations.
Keep project-level undo/original-media controls and invalidate cuts when source evidence changes.

Example: `{ id: 'quiet-1', recordingId: 'recording-a', t0: 4, t1: 6 }` yields a review candidate but no preparable cut.
Adding independently verified start/end records and accepting its current fingerprint allows the owner to preview excluding 4–6 seconds.
A later changed interval 4.1–6 seconds does not inherit that acceptance.
No actual listening or A/V claim is made by this synthetic example.

Session 2 imports `AssistedTranscript` from `src/components/captions/assisted-transcript.tsx`.
Pass the accepted live hook's `text`, `isFinal`, `status`, optional user-facing `message`, and source segments with `enabled={commonGateFor29}`.
It defaults disabled and collapsed, limits text to 4,000 characters and content height to 160px or 24% of viewport height, and exposes controlled `collapsed`/`onCollapsedChange` if desired.
Place it in the existing camera overlay slot outside recording controls; do not render a second overlay alongside `LiveCaptions`.
It owns no microphone, recording lifecycle, persistence or coverage verdict.
Its bounded projection never replaces the hook's full transcript/stop result used for persistence.

`live-transcript.ts` also exports `createLiveTranscriptState`, `reduceLiveTranscript`, `visibleLiveTranscriptText` and `buildLiveTranscriptView` for deterministic replay.
The optional reducer is for an explicitly ordered event adapter; native status events currently have no sequence, so do not invent ASR ordering or feed them into the reducer without a session-scoped unified dispatch sequence.
Prefer the already accepted hook state for production component props using the merged #13 hook.
Raw technical failure messages must be mapped to user-facing copy by the capture adapter.

## Proposed shared persistence envelope

Session 3 should author the shared project/draft type and validation, using these isolated types rather than changing their existing consumers in Session 1's branch:

```ts
speechControl?: {
  version: 1;
  mustSay: MustSayMetadata;
  takeDecisions: TakeDecisionState[]; // one capture-session/source scope per entry
  cleanup: { recordingId: string; plan: CleanupPlan }[];
}
```

Drafts may store empty take/cleanup arrays; recording acceptance must snapshot the current script IDs, text, requirements and revisions atomically.
Do not use two independent unawaited setting writes for script text and must-say intent.
Projects without the envelope use compatible legacy rendering and original recovery, while must-say coverage remains unavailable until explicit metadata exists.
Validate present nested values before accepting them, reject duplicate source/line/take identities, and re-derive projected scratch/cleanup state from validated records and event/decision logs.
Never coerce invalid required booleans to false or legacy uncertainty into scratch history.

## Take reasons and scratch contract

Import from `src/features/speech-control/take-decisions.ts`.
`TakeScope = { sessionId, sourceId }` uses a CAPTURE session ID and durable original recording ID.
Recognition retries do not change that scope; native job identity belongs in the separate `recognitionSessionId` and namespaced recognition segment `id`.
Allocate `TakeRecord.id` once for each actual attempt, not once per ASR segment or refinement job.
`createTake` snapshots linked raw transcript evidence and retains `baseVerdict`, `verdict`, line IDs, source times, reasons and scratch-event IDs.
An open take's `t1` is the latest observed source time, not a promised media boundary; constructors require a nonempty finite interval, so allocate its durable ID before observations and materialize the record when an interval exists.
One attempt may cover several lines without splitting media.

`deriveTakeReasons({ take, scriptLines, transcriptSegments, confirmedRestartSegmentIds? })` returns plain `message`, reason code, evidence status, script text/line ID and raw transcript text/segment ID/source seconds.
Supply cue-free `spokenText` when available; bracket directions never belong to missing spoken wording.
Only creator-confirmed restarts are asserted; phrase-based restart evidence stays uncertain.
Missing-word copy refers to the transcript, not proof the creator omitted speech.
`flagTake(take, reasons)` preserves the raw snapshot and never becomes a scratch decision by itself.
C can display these records directly without reconstructing a reason from generic quality flags.

`detectScratchCommand(segment, { scriptText, scriptLines, minConfidence? })` requires exact final “scratch that” plus explicit `commandContext: 'standalone'`.
`'continuation'`, `'quoted'`, `'ambiguous'`, missing context, provisional, uncertain/noisy, ordinary “cut” and script-literal phrases are not commands.
The default optional confidence threshold is 0.8 when confidence is provided; no confidence score is synthesized for Moonshine.
This threshold and the context labels in checked-in fixtures are synthetic policy inputs, not human-accuracy evidence.
The existing native caption payload does NOT establish standalone command context.
Session 1's production voice adapter therefore remains unavailable until the Tier 1 capture adapter and an endpoint/context provider are supplied and validated; do not equate one ASR segment with one standalone command.
Manual scratch remains the available fallback.

`createVoiceScratchEvent({ id, scope, commandSegment, takes, scriptText })` chooses the eligible latest attempt at command onset, regardless of event arrival time.
It does not skip an already-scratched latest attempt to discard an earlier good one.
`createManualScratchEvent({ id, scope, takeId })` targets the same durable identity explicitly.
Feed both through `reduceTakeDecision(state, event)`; create/reopen with `createTakeDecisionState({ scope, takes, events })`.
`createRestoreScratchEvent({ id, scope, scratchEventId })` adds restoration history instead of deleting prior events.
Persist event IDs and capture/source scope; duplicate event IDs and duplicate voice command segment IDs are idempotent.
Optional `createdAt` is Unix wall-clock milliseconds for display only; event order and source times govern decisions.
State is projected from the event log, and raw original media is never deleted.

Voice events retain `CommandInterval` with source `t0`/`t1`, raw text, segment/capture/source identities, caption exclusion intent, playback exclusion intent, `playbackExclusion: 'pending-review'`, `boundaryProvenance: 'recognition'`, and `safeForSplice: false`.
Omit only the identified standalone command caption; preserve raw recognition evidence.
Never pass these ASR times straight to `excludeInterval` or native export.
Session 3 must resolve playback exclusions with separately verified boundaries and review, and show pending exclusion until then.
Restoring the take retains the command interval, because restoring an attempt does not turn a control utterance into spoken content.

Example: clean attempt A at 0–2 seconds and later attempt B at 5–7 seconds retain separate IDs.
A delayed command observed at 2.1–2.7 seconds targets A, not B.
If A was already scratched, replay cannot fall back to another earlier clean take.
The same source interval is never presented as a safe automatic splice.

Only accepted live capture events may drive `createVoiceScratchEvent`.
Saved-audio refinement is evidence for review, never a source of new executable voice commands.
Retain the live command event identity across retry/replay; do not re-execute a historical utterance under a new refinement/job segment ID, especially after a creator restored its take.

Dependency refresh: merged Tier 0 source is incorporated at `11f4455`.
`projectReview` still maps `needsListening` to scratched quality even with stored takes, so that Tier 1 owner migration remains required.
No shared storage envelope, common gate, or Tier 1 editor/camera consumer appeared in that merge.

Take/reason/scratch implementation is committed at `d23f0b8`; current must-say evidence fixes are at `b3c4ed1`.
The final lane report links reproducible synthetic output and exact checks from the completed branch.

Cleanup source validation and bounded retained live text are committed at `d026b8d`.
See `t1-session-1-acceptance.md` for final checks and unverified acceptance.
