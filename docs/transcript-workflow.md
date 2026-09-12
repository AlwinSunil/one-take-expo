# Transcript workflow domain

`src/lib/transcript-workflow.ts` is the pure data layer for script coverage, assisted review suggestions, and reversible caption decisions.

It does not access files, call Moonshine, inspect camera frames, or edit media.

The native bridge or a future saved-audio job supplies observations, and the React Native review screens consume the derived state.

## Time and evidence

Every `t0` and `t1` value is a non-negative number of seconds relative to the recording source.

`TranscriptSegment.id` is assigned by the capture layer and must stay stable when provisional text becomes final or when saved-audio refinement updates the segment.

The native capture layer must preserve or explicitly align ids when a separate saved-audio job returns results.

This module does not infer identity across independent recognizer jobs from time overlap.

`TranscriptSegment.text` is raw recognizer output.

`manualCorrection` is separate display text and is never used for the spoken-script verdict.

`source` identifies `live` or `refined` output.

`timingSource` identifies live timing estimates or saved-audio timing.

Use `createTranscriptSegment` for the native payload `{ id, t0, t1, text, isFinal }`.

Use `applyTranscriptRefinement` for a later revision with the same id.

Older revisions are ignored, final state is sticky, and existing manual corrections survive newer raw text.

A newer provisional result cannot downgrade or replace a segment that is already final.

```ts
const live = createTranscriptSegment({
  id: 'recording-17:utterance-2',
  t0: 1.2,
  t1: 3.0,
  text: 'open ai released pixel nine',
  isFinal: false,
});

const corrected = editCaption([live], live.id, 'OpenAI released Pixel 9');
const refined = applyTranscriptRefinement(corrected, [{
  ...live,
  text: 'OpenAI released Pixel 9',
  isFinal: true,
  revision: 1,
  source: 'refined',
  timingSource: 'saved-audio',
}]);

displayTranscriptText(refined[0]);
// The creator correction is displayed while refined[0].text remains raw evidence.
```

## Script lines and action cues

Create every script line with an explicit id through `createScriptLine`.

Bracketed text such as `[smile]` is removed from `spokenText` and retained as an optional `ActionCue`.

Action cues are not passed to the speech matcher.

Mark a cue `required: true` only when the creator expects manual confirmation.

A required cue remains unresolved until a caller sets `resolved: true`.

`applyScriptEdits` accepts explicit update, insert, delete, and complete reorder operations.

Update and reorder operations preserve existing line ids.

The function does not receive takes, so deleting or reordering visible lines cannot delete historical take evidence.

Reorder input must contain every current line id exactly once.

## Conservative matching

`matchTranscriptToScript` compares whole canonical token sequences.

It never treats a substring, a token overlap, or an invented confidence score as coverage evidence.

Canonicalization lowercases text, removes punctuation, converts ordinary number words such as `nine` to `9`, and handles common whole-token brand forms such as `open ai` and `OpenAI`.

Project-specific whole-token aliases can be supplied through `ScriptMatchOptions.aliases`.

An exact final utterance can match one line or a consecutive run of lines.

The run is returned as one `lineIds` array, allowing one media take to cover two lines read in one breath.

Ambiguous duplicate matches return `kind: 'ambiguous'` with no line ids.

Provisional segments can be matched for pending display, but they cannot establish coverage in `deriveReviewState`.

Matching always uses raw `text`, so a manual caption correction cannot change a spoken-script verdict.

## Coverage and takes

`deriveReviewState` returns one `LineReview` for every current script line.

Each line has `needed`, `pending`, or `covered` status.

`covered` requires all of the following:

- a clean take;
- a final transcript segment whose whole utterance matches the line;
- `playable: true`; and
- a non-empty `mediaUri`.

Provisional text, missing media, expired timers, flubbed takes, and scratched takes never satisfy those conditions.

Matching clean evidence with provisional text or unavailable media is `pending`.

No usable evidence, or only flubbed or scratched attempts, is `needed`.

All takes remain in the input and in the returned state.

An earlier playable clean take remains eligible after a later bad reread.

When no explicit choice exists, an in-frame clean take wins, then the earliest take is used as a deterministic tie-breaker.

`LineReview.eligibleTakeIds` lists the takes that could still be selected for that line: clean, playable and backed by final transcript evidence.

`selectTake` records a creator choice under a stable `take:<lineId>` decision id.

The selected take still needs final transcript evidence when review state is derived.

Selecting unavailable media throws and cannot produce coverage.

`restoreDecision` removes the explicit choice and returns selection to the derived default.

## Review-only cleanup

`generateReviewSuggestions` can report long quiet intervals, repeated final utterances, and filler marks with independently verified boundaries.

Suggestions contain times, related segment ids, a reason, and `safeBoundary` evidence.

Repeated attempts and recognizer-only timing are `uncertain` by default.

Filler marks without a verified boundary are omitted from cut suggestions, which leaves mid-sentence fillers in the original transcript for human review.

`acceptSuggestion` records an explicit review decision only.

It does not remove a segment or splice a file.

An editor or native cut planner may use an accepted suggestion after its own media-boundary checks, while retaining the original take for undo.

`restoreDecision` removes an accepted cleanup decision as well as a take selection.

## Safe-to-wrap state

`safeToWrap` is true only when every current line is covered and every required action cue is resolved.

Optional cues never block it.

Missing media can remain in historical takes without being promoted to playable coverage.

This module does not claim speech accuracy, camera framing, audio/video sync, NPU execution, or export correctness.

Those properties require the native and device checks described in the other workflow documents.

## Coverage updates

`src/lib/coverage-updates.ts` answers the separate question of what happens to a derived verdict when the script changes or a recording disappears.

`coverageLedger(review)` snapshots the derived state as one `CoverageEntry` per line, each with a `reason` code and the full take history for that line.

History records keep the take id, quality, framing, playability, times, whether the take is still eligible, and whether it is `stale`, so losing coverage never loses evidence.

`CoverageEntry.explicitTakeId` records the take the creator chose through `selectTake`, whether or not that take is currently usable.

`applyScriptChangeIntent(ledger, intent)` consumes the script editor's published `{ editedLineIds, deletedLineIds, addedLineIds, reorderedFrom }` object.

Editing a line returns it to `needed` with reason `script-edited`, because the recorded words no longer match the script, while its takes stay in history.

Those takes are marked `stale: true` and `eligible: false`, since they were recorded against the earlier wording, so no later recomputation can promote one of them back into coverage.

An edit also clears `explicitTakeId`, because a choice made for the earlier wording is not a choice for the new wording.

Deleting a line moves its entry to `ledger.retired` with reason `line-deleted`, so its takes remain available for review and never gate a wrap.

Adding a line appends a `needed` entry with reason `line-added` and no history; an added id that already exists is rejected.

`reorderedFrom` is the line order *before* the change, and coverage is keyed by line id, so a reorder preserves every id and every verdict and is only validated here.

A `reorderedFrom` list that is not exactly the current set of line ids, or an edited or deleted id that the ledger does not know, throws.

`applyMediaAvailability(ledger, takeIds)` recomputes coverage after the capture layer reports that media is gone.

The affected history records become unplayable and ineligible.

Losing a file can only ever take coverage away, so a replacement is chosen in exactly one case: the line was covered by a take this module picked itself, and that take is the one that disappeared.

A line with an `explicitTakeId` is never silently reassigned; if the creator's take is the one that vanished the line returns to `needed` with reason `media-missing`, and the creator chooses again.

A line that was not covered is never promoted by a media loss; it keeps its own reason while it still has playable evidence, and otherwise returns to `needed` with reason `media-missing`.

That is deliberately different from the `media-unavailable` pending state: a file that never became playable may still arrive, while a file the capture layer reports as gone will not.

`selectedCutOrder(ledger)` returns the selected takes in script order, never in recording order.

Consecutive lines covered by one take stay one unbroken cut, and a take covering non-adjacent lines is still played once, at its first script position.

That last case has a deliberate limit: if one take covers lines 1 and 3 while another covers line 2, the cut list is `[take(1, 3), take(2)]`, so line 3 is heard before line 2.

Coverage will not repeat source audio or invent a split inside a continuous take, so resolving that ordering is an editor decision with a real media boundary, not a coverage decision.

`coverageSafeToWrap(ledger, unresolvedRequiredActionCueIds)` requires at least one line, every current line covered, and no unresolved required cue.

## Scenario replay

`src/development/coverage/scenarios.ts` defines ten deterministic scenarios: `clean`, `flub-reread`, `pending-timer`, `out-of-order`, `missing-file`, `two-lines-one-breath`, `off-frame-vs-in-frame`, `scratched-take`, `script-edit-after-coverage` and `required-action`.

Each scenario declares its script lines, recognizer utterances, takes with media availability and framing, any script change or media loss, and the coverage and cut order it must produce.

Framing values in a scenario are declared fixture observations and are never a vision or NPU measurement.

`runScenario` is pure, so replaying a scenario returns identical coverage, identical history and an identical cut order every time.

`ScenarioOptions.nowSeconds` is a simulated clock that coverage never reads.

The replay reports `timedOutTakeIds` for pending takes whose analysis window has elapsed, which lets a test advance the clock past any timeout and show that the pending line is still pending.

No production function accepts a clock at all, so that invariant is structural rather than guarded: the test documents it, and it would only regress if someone added a time argument to the coverage path.

## Local verification

Run the behavior tests with:

```sh
npm test
npm run coverage:report
```

The tests cover refinement ordering, manual correction preservation, number and brand normalization, whole-utterance multi-line coverage, stable script edits, needed/pending/covered state, missing media, scratched takes, take ranking, required cues, review-only suggestions, and explicit undo.

`tests/coverage-updates.test.mjs` covers the ledger, script change intents and media loss, and `tests/coverage-scenarios.test.mjs` replays every scenario twice.

`npm run coverage:report` prints precision and recall per coverage verdict from the synthetic fixture rows.

That report is labeled `synthetic fixtures, not human held-out data` and is not a human accuracy measurement.
