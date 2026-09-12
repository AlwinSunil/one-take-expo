# Session 3 additive contract proposal

Branch: `feat/t1-review-wrap-reframe`, based on merged `e050a0d`.
The first contract commit is published in the draft PR commit history.
These are proposed transport seams, not agreement about recognition or vision semantics.
Sessions 1 and 2 must review and reply with producer branch/commit references before integrated acceptance.
No unmerged Tier 0 work is included.

`src/lib/t1-contracts.ts` defines optional project evidence and wrap acknowledgement.
`src/lib/t1-gates.ts` is the common default-off gate for all lanes.
Call `tier1Enabled(feature, __DEV__, explicitTestOptIn)`; production always remains off.
An explicit editor development toggle will exercise fixtures without persisting feature enablement.
Absent project fields preserve legacy behavior and original media recovery.

## Session 1 requested handoff

Supply immutable `Tier1Evidence` snapshots keyed by projectId and a fresh revision for each changed result.
Use globally stable take, line and segment IDs within the project; do not reuse an ID for a different utterance or recognition job.
Reasons retain producer text, status and optional source footage.
Must-say statuses are producer verdicts; the editor will not infer precise wording from caption corrections.
Missing or pending evidence never grants all-clear.
Scratch events retain the command segment and target take even after restore.
Cleanup choices retain suggestions and footage; boundariesReviewed requires creator listening, not recognition timestamps.
Do not change existing transcript/review helpers concurrently; propose additive exports and migration requirements here first.

Example footage: `{ recordingId: 'recording-1', t0: 1.2, t1: 4.8 }`.
All footage times are finite source-local seconds in the original media, not wall clock or recognizer delivery time.
Never split a one-breath multi-line take implicitly.
Consumer verifies source availability at use time; supplied evidence does not establish file existence.

## Session 2 requested handoff

Capture supplies firstTakeStartedAt and wrapRequestedAt as epoch milliseconds from the same clock.
Omit unknown timing; do not substitute project creation or editor-open time.
Persist wrap acknowledgement only after explicit Wrap anyway, retaining flags and the evidence revision.
Capture must honor the same gate and keep optional coaching outside wrap blockers.
Required actions remain explicit creator confirmations separate from must-say evidence.
Direct pickup launch remains unavailable until #20/#26 capture contract is merged and advertised.
Request owner-authored capture entry wiring after the report component is available.
Framing proposal follows separately; no live vision semantics are assumed.

## Incoming Tier 0 dependencies

PR #49 changes shared persistence, editor composition and multi-source identity.
After it merges, rebase/merge merged main, map footage recordingId to recordings, and route review/export through its common native composition.
Do not cherry-pick that unmerged PR.
PRs #46/#48/#50 supply script/coverage/recognition identity changes; #54/#56/#55/#57 supply capture integration.
PR #52 and issue #34 remain baseline acceptance dependencies.
Preserve legacy API compatibility until every consumer migrates.
