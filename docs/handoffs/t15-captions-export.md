# Tier 1.5 captions and export handoff

Status: isolated implementation in progress, not completed V1 or release acceptance.
Owner C, issue #68 under #62.
Branch: `feat/t15-independent-captions`, fresh worktree from merged main `3da03c4`.
Merged #58 and UI PR #73 are preserved.
No A/B files, other worktrees, environment files, capture/build/manifest configuration or release gates are changed.

## Published transport and dependencies

Initial caption planner/settings checkpoint: `35b1961`.
B's published handoff `904ccc5` defines `resolveTimeline(snapshot, sources)` in `src/features/timeline/engine.ts`.
C acknowledged the structural resolver output in [#67 comment](https://github.com/AlwinSunil/one-take-expo/issues/67#issuecomment-5649918017).
This acknowledges the output seam, not merged implementation or A's persisted schema.
Only merged dependencies may be integrated.
PR #72 remains a design proposal; #70/#71 are not incorporated.

A request: persist `showInEditor: boolean` and `burnIntoExport: boolean` per project through the #65 schema, with legacy defaults `true/true`.
Both defaults preserve the prior captioned editor/edited-export intent because no old independent preference exists to infer.
Legacy explicit Original mode retains its old separate behavior until B selects the new timeline workflow.
A must publish the exact field path, revision/CAS update API and migration/reopen tests.
The proposed `v15.captions` path is not an implemented contract in this branch.
Preference changes must preserve all transcript revisions, raw recognition, manual corrections and coverage; do not clear transcript arrays to hide overlays.
The owner-authored request is [#65 comment](https://github.com/AlwinSunil/one-take-expo/issues/65#issuecomment-5649911004).
No A response or persistence agreement is claimed yet.

## Exact component and planner APIs

```ts
<CaptionSettings
  showInEditor={preferences.showInEditor}
  burnIntoExport={preferences.burnIntoExport}
  onShowInEditorChange={(value: boolean) => updatePreference('showInEditor', value)}
  onBurnIntoExportChange={(value: boolean) => updatePreference('burnIntoExport', value)}
  disabled={saving}
/>
```

Import named `CaptionSettings` from `src/components/review/caption-settings.tsx`.
The component is controlled and has no storage, transcript mutation, route or feature gate.
`disabled` is optional and defaults false.
It uses native accessible switches with flexible wrapping and the current dark review styling.
B owns placing it behind explicit development access and wiring A's persisted updates, visible save failures and retry.
Do not mount it in the release editor merely because a project has a preference field.

```ts
buildTimelineExportPlan(project, sequence, burnIntoExport, framingEnabled = false): ExportPlan
buildTimelineEditorCaptions(project, sequence, showInEditor): ExportCaption[]
freezeExportPlan(plan): ExportPlan
```

All are exported from `src/lib/export-plan.ts`.
`CaptionExportSequence` is a structural consumer type until B's type is merged, not a second timeline engine or persisted model.
Its exact shape is:

```ts
{
  revision: number;
  segments: readonly {
    clipId: string; sourceId: string; uri: string;
    t0: number; t1: number; outputT0: number; outputT1: number;
    takeId?: string;
  }[];
  duration: number;
  issues: readonly unknown[];
}
```

B resolves inclusion, ordering, bounds, availability and output offsets once.
C rejects nonempty `issues`, empty segments, inconsistent offsets/duration, source identity mismatch and unavailable inventory.
B must pass the project with the existing refreshed `availableMediaUris` inventory; absent inventory fails closed for this new path.
An unavailable primary recording does not block an independently inventoried pickup selection.
C neither reorders nor restores clips and does not require `cutsReviewed` for this explicit selected sequence.
B's Save/accept operation remains responsible for persisting a displayed proposal as one creator decision.
The adapter ignores legacy `cuts` and `reviewSegments` when consuming this sequence.
It always sends explicit native `segments`, including when burn-in is false; it never selects the original as a captionless fallback.
Both burn modes carry identical source URI/ranges/order and framing.
Pass `framingEnabled` only when the existing development framing gate and `media.supportsFraming === true` permit it.
B should retain optional `takeId` to preserve take-specific framing.

The export plan includes `timelineRevision` and `burnIntoExport`, detached and deeply frozen together with cuts, captions, segments and crops.
Captions remain source-local in native segment requests.
Editor captions are mapped to the same resolver's output offsets; hide the overlay by returning no display cues, retaining the underlying transcript.
Use `activeCaptionAt` for the current output position.
If caption construction fails, show an honest caption-unavailable state and allow the creator to disable burn-in; do not fabricate replacement text.

```ts
<ExportControls
  project={project}
  start={start}
  end={end}
  timelinePlan={planOrNull}
  burnIntoExport={preferences.burnIntoExport}
  framingEnabled={framingAllowed}
/>
```

B must pass `timelinePlan` explicitly in its development timeline branch.
`undefined` preserves legacy selection; `null` explicitly disables invalid/empty timeline export.
Catch planner errors for the visible recovery message and pass `null`, never `undefined`, on failure.
The plan's burn choice is authoritative for its summary.
The request is captured before confirmation dialogs and asynchronous storage/native work, so later edits cannot change that export.
A callback from a different/unmounted project is ignored.
Existing native background, cancel, output recovery, gallery and explicit share paths remain in place.
A retry is a new request for the currently displayed selection, rather than an automatic rewrite of a running job.

## Source timing and mapping examples

Intervals are half-open source presentation seconds, not recognizer delivery or wall-clock timestamps.
Source identity is `recordings[].id`, mapped to the corresponding immutable original URI.
Existing `transcriptForSource` preserves recording/take ownership and legacy primary-source caption ownership.
Manual correction overrides corrected text, which overrides recognized text; blank manual correction intentionally omits a cue.
Draft/provisional segments are not fabricated into final captions.
Pending/unavailable recognition can export an explicit video sequence without captions.

Example: original source S has a corrected whole phrase `[0,4)` and excluded phrase `[5,8)`.
Pickup P has its own phrase `[0,2)` despite overlapping source timestamps.
B supplies P `[0,2)` at output `[0,2)`, S `[1,2)` at `[2,3)`, then S `[2,4)` at `[3,5)`.
C maps pickup text only to `[0,2)` and repeats the complete corrected S phrase over `[2,3)` and `[3,5)`.
The mid-cue split does not invent individual word boundaries.
The excluded S phrase contributes neither captions nor time.
An empty resolver sequence rejects rather than using legacy empty-cuts full-source semantics.

Existing Media3 clipping floors source endpoints to milliseconds.
B has been [asked to publish canonical millisecond precision](https://github.com/AlwinSunil/one-take-expo/issues/67#issuecomment-5649942669) so accumulated output offsets match native clipping across arbitrary splits.
No separate quantizing timeline implementation or agreement is claimed here.

## Acceptance matrix

| Requirement | Evidence in this branch | Remaining gate |
| --- | --- | --- |
| Four caption combinations | Planner/editor-overlay fixtures preserve identical video and unchanged text/corrections | A persistence, B installed controls, reopen |
| Source overlap, trims, splits, reorder, excluded clips, pickups | Source-isolated sequence fixture with corrected whole-phrase intersection | Merged B engine and actual pickup route |
| Empty sequence, no original fallback | Planner rejects empty/issues; controls use explicit null | Native guard/build and installed disabled control |
| Save whole proposal | Sequence planner ignores per-cut approval | A/B atomic whole-proposal Save |
| Frozen request | Deeply frozen selected revision survives later edit/correction/source mutations | Dialog/native lifecycle verification |
| Burn on/off parity | Identical requested intervals/order/crops | Fresh standalone decoded video/audio/frame comparison |
| Pending/unavailable captions | Empty/provisional transcript and burn-off malformed-text fixtures | Installed recognition unavailable path |
| Corrections and originals | Pure fixture input unchanged; existing T0/T1 tests | Actual saved/reopened preference/correction and source hashes |
| Existing lifecycle | Existing source tests retained; native implementation reused | Fresh gallery/share/background/cancel/retry/missing-output device runs |
| Accessibility/style | Accessible native switches, flexible labels | Large-system-text, safe areas, long text/light/dark footage and named review |

## Evidence and limits

`npm ci --ignore-scripts --no-audit --no-fund` completed in this worktree.
`npm test`: 431 passed, zero failed at initial checkpoint (424 baseline plus seven caption/export fixtures).
`npm run samples`: deterministic caption replay passed.
`npm run test:samples`: 19/19 passed.
`git diff --check`: passed before initial commit.
Git identity checked as `sabarinarayanakg@proton.me`, matching merged main's author email.
Read repository CLAUDE/AGENTS, exact [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/), issues #1/#62/#68/#65/#67 and relevant dependency/comment history, PR #72 handoff, T0/T1 validation and native evidence.
Historical device evidence is context only, not a fresh T1.5 result.

No physical device is reserved or mutated by C.
No new capture, source hash, rendered frame, audio sync, NPU or human accuracy evidence is claimed.
Synthetic output cannot prove real capture A/V correctness.
Native build, final test counts, published PR and A/B evidence delivery are recorded below when run.
Named NarayanaSabari review, both peer reproductions, integrated iQOO full flows, ten-clap spread, two-minute drift/listening, low-storage/denied-permission and large-text requirements remain pending.
A owns `docs/validation/T1.5.md`; C will send exact evidence through the issue handoff rather than edit it.

## Verification checkpoint and delivery

Draft [PR #74](https://github.com/AlwinSunil/one-take-expo/pull/74) publishes this lane.
`0f394dd` publishes controls and integration instructions; `bec6f99` adds native revision safety and stable-ID caption alias protection.
The native optional `timelineRevision` must be a nonnegative JavaScript safe integer and requires nonempty explicit segments.
It is stored with the exact native request and returned by `getExport`; legacy unmarked jobs keep their prior empty-cut behavior.
No changes to native capture/build/manifest integration were needed.

| Exact command | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 443 passed, zero failed (424 baseline + 10 mapping/framing/availability + 9 component cases) |
| `npm run samples` | Passed synthetic caption replay |
| `npm run test:samples` | 19/19 passed |
| `python3 tests/speech-evaluation.test.py` | 12 passed |
| `python3 tests/t1-speech-evaluation.test.py` | 11 passed |
| `python3 tools/speech-fixtures/run_synthetic.py` | 16 synthetic rows, no eligible held-out human accuracy claim |
| `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/t15-c-android-export` | Passed Android Hermes bundle |
| `python3 tools/prepare_moonshine.py --native-dir /tmp/t1-moonshine-native/arm64-v8a --with-small` | Pinned model/native artifacts staged and verified in this worktree |
| Full Gradle command below | Passed, 16 media + 15 caption JVM tests and arm64 debug APK |
| `python3 tools/verify_moonshine_apk.py android/app/build/outputs/apk/debug/app-debug.apk` | 3 native + 8 Tiny + 8 Small packaged hashes match |
| `shasum -a 256 android/app/build/outputs/apk/debug/app-debug.apk` | `4c18ea2510dd04db18e38e2b6b1a909fb673176505be6c1810659c2d11be0c48` |

```sh
EXPO_NO_DOTENV=1 JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ANDROID_HOME=/Users/sabari/Library/Android/sdk ./android/gradlew -p android :app:assembleDebug :one-take-captions:testDebugUnitTest :one-take-media:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a --console=plain
```

The first native test run failed in five new tests because JVM Android stubs cannot execute `Uri.parse` or `JSONObject.put`.
One proposed empty-segment test also accidentally retained nonempty segments.
Those tests were corrected to exercise the pure request invariant without adding test dependencies/configuration.
Native parser/JSON roundtrip is implemented but still requires Android runtime verification; constructor tests do not prove persistence or process-death recovery.
The successful build log is local `/tmp/t15-c-native-build-final.log`; bundle log is `/tmp/t15-c-bundle.log`.
The debug APK verifies native packaging/build, not a shipped standalone JS release or installed editor integration.

`tests/t15-export-controls.test.mjs` executes actual transpiled components and production export-plan helpers with a small test hook renderer and mocked native/store boundaries.
It checks empty disabling, burn-off alerts, confirmation freezing across edits/navigation, whole-proposal export, gallery/open/share, cancel/retry and missing-output recovery.
It also checks independent switch callbacks.
These are component behavior tests, not React Native rendering, SQLite reopen, Android accessibility or device lifecycle evidence.

A/B remain responsible for merged schema/type imports and explicit development route integration.
Fresh physical exports with burn-in on/off, decoded frame/audio/order/duration comparison, original before/after hashes and integrated capture/pickup remain unrun.
Native composition continues to use one audio/video sequence with only the caption overlay conditional; that source observation is not measured render parity.

Evidence sent to A in [#65 comment](https://github.com/AlwinSunil/one-take-expo/issues/65#issuecomment-5649980767) and integration instructions sent to B in [#67 comment](https://github.com/AlwinSunil/one-take-expo/issues/67#issuecomment-5649980828).
No response, named reviewer approval or completed integration is inferred from those messages.

Final source-ID review also scopes framing to the resolved recording when two records alias one URI.
Both burn modes retain the same safe crop/fallback, covered by an additional framing fixture.
The final Android JS export was rerun with `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/t15-c-android-export-final`.
CI passed on checkpoint `1548dbf`; final-head CI is tracked on PR #74.

A separate code review identified the source-availability override when inventory was absent.
The final adapter requires explicit inventoried availability, with missing/stale and independently available pickup regression coverage.
This review is not named human or cross-family acceptance.
