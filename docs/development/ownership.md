# Three-person development

Starting issue: [#6](https://github.com/AlwinSunil/one-take-expo/issues/6). Baseline: `400e56f`.
This is a proposed handoff for peer review, not an agreed engine API. Sabari and Alwin must run the starter and review these examples before production consumers integrate them.

| Lane | Owner | Existing files | New feature work |
| --- | --- | --- | --- |
| Capture | Alwin | `src/app/camera.tsx`, Android build/manifest integration | Capture/input/vision/multicam components and native capture module |
| Script and coverage | Sabari | `src/app/script.tsx` | Script/actions, speech, coverage decisions, prompter/transcript, speech native module |
| Review and export | Melvin | `src/app/{editor,projects,index,_layout}.tsx`, `src/lib/{store,session}.ts` | Projects, review, playback, captions/export, media native module |
| Shared seams | Melvin integrates owner-authored changes | Theme, package/lock/config/CI, shared types | Starter examples in `src/development/sessions`; later fixtures live with the owning feature |

Keep one active implementation branch per lane. No production file moves are needed for this split. Propose a small shared edit rather than changing another owner's route or native integration. New code should live behind each owner's feature modules and remain compatible with the existing `Project` shape until a reviewed migration is ready. Model/runtime choices belong to the research issues.

## Baseline behavior, before changes

This inventory comes from source inspection; it is not a claim that these paths all passed a new device regression.

- **Recording:** `camera.tsx` obtains camera and microphone permission, uses `recordAsync`, and shows an in-memory video preview on stop. Retrying recording can discard that unsaved preview. Continue copies the video to durable storage through `saveProject`, then opens the editor by project ID. Newly captured projects currently have empty clips and transcript arrays. The saved setting `last_video_uri` backs the recent thumbnail.
- **Draft:** `script.tsx` restores `script_draft` from SQLite; changes debounce for 400 ms. Continue writes `script_accepted` and deletes the draft in one transaction. The draft timer is independent of acceptance, and pending saves are not flushed on unmount. Preserve this behavior in readiness; investigate draft race/error handling in the owning lane rather than silently changing it here.
- **Projects:** `onetake.db` has `projects(id, data)` and `kv(key, value)`. Each project is a JSON `Project`. Saving copies the source into `Paths.document/videos/<encoded-id>.mp4` if the destination does not exist, then upserts the JSON. There is no schema migration, deletion or sample insertion in this change.
- **Review and trim:** the editor loads a project or direct URI, plays the original through `expo-video`, generates eight filmstrip thumbnails, and saves `{ start, end }` selection metadata. Dragging seeks; playback stops at the selected boundary. Saving a trim does **not** render/export a new video. Missing projects/media show errors. Existing stored JSON remains compatible.
- **Advertised analysis:** Assisted Mode's live transcript copy is not backed by a speech engine yet. Samples must never be presented as real inference.

## Proposed minimum handoff

`src/development/sessions/contracts.ts` is deliberately separate from production `session.ts` and SQLite. No production consumer migrates in this PR.

- Script items distinguish spoken lines from action cues. Required actions are manually confirmed; optional actions do not gate wrap. Action text never appears in sample speech or cut captions.
- Speech exposes ready/pending/unavailable plus text. There are no assumed ASR word boundaries, model names or fabricated confidence scores.
- A take can cover multiple line IDs with one source-audio interval. Times are finite seconds relative to recording start. Coverage points to clean takes; pending verdicts do not count as covered.
- Camera/vision state is separate from spoken coverage. All sample processors are explicitly `fixture`, never NPU/CPU evidence.
- Cuts reference supplied source intervals. The clean example has two covered lines in **one** continuous audio segment. The re-read preserves the flagged take and its reason while selecting the replacement. These are synthetic timings, not measured safe-splice evidence.
- Export failure preserves source/ledger/cut data. Sample media has no URI; the runner cannot play, export, or save it as a real recording.

The proposed `summarizeSession` and `validateSession` helpers support fixture work only. They are not a complete production coverage engine, export state machine, versioned storage format or security boundary.

## Review still needed

Both peers must reproduce the starter, agree the shared examples and review ownership before their consumers integrate. The named reviewer is Sabari. Melvin explicitly requested Milestone 0 closure; personal reproduction remains a Milestone 1 handoff check and is not claimed here. The separate #9 real-device evidence is linked from the milestone closeout; fixtures do not substitute for it.
