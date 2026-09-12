# Session 1 Tier 1 handoff

Branch: `feat/t1-speech-control`, based on merged `origin/main` at `e050a0d`.
This document and the implementation will be pushed on this branch; use the commit history, not another session's uncommitted files.
No Tier 0 branch is merged or cherry-picked here.

## Immediate owner requests

Session 3 owns `session.ts`, `store.ts`, `project-workflow.ts`, editor consumers and the common gate.
Please add an optional versioned speech-control envelope to draft/project persistence, preserving legacy records and rejecting malformed present metadata without silently downgrading required wording.
Keep the new features off by default until individual acceptance and Tier 0 regression evidence pass.
Session 1 supplies the isolated types and reducers below; exact exported signatures will be recorded after implementation.

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

- #12 / PR #46 provides stable script document lines and draft structure; Session 1 must wire the must-say toggle into `script.tsx` after it merges.
- #13 / PR #50 provides recognition lifecycle/retry identity; no new native confidence or silence guarantee is assumed.
- #16 / PR #48 provides coverage updates; Session 3 must compose strict must-say results into review/wrap rather than using ordinary normalized coverage alone.
- #26 / PR #57 capture integration is owned by Session 2; consume the supplied component and explicit take/scratch events there.
- #30 and #31 Session 3 consumers must persist/render reasons, unresolved requirements, reversible decisions and command exclusions.

## Acceptance constraints

Synthetic replay proves deterministic decisions only.
#22 still needs held-out human reason agreement of at least 8/10 correctly detected flags and command false-trigger measurements.
#23 still needs 20 consecutive clean held-out human must-say reads with zero false flags.
#24 needs listening and safe-boundary/caption export review.
#29 needs long-session, large-text and failure-state device review.
Named reviewer remains @AlwinSunil; shared handoffs require both peers.
