# iQOO media experiment — actual evidence

2026-09-13 local date; logs use UTC (2026-09-12T20:xxZ). iQOO I2501 / SM8850, Android 16, OS `PD2505F_EX_A_16.0.21.12.W30`. One Take native debug build 1.0.0 (1), rebuilt with the local Media3 1.9.0 experiment; Metro served the current working branch. All behavioral tests ran on this physical phone. Host FFmpeg/say generated the input; host Gradle compiled the APK. No emulator or host media inspection was used as test evidence.

## Source and cuts

The source is a 12-second, 360×640 H.264/AAC synthetic fixture (124,603 bytes) with source timecode, green/red/blue scene markers and three synthetic spoken phrases. Each phrase begins 500 ms into its four-second scene. Select `[0,4)` and `[8,12)`; the unwanted red middle scene is excluded. A caption is supplied per selected interval. No recognizer, word timestamps, human identity or live recording enters this fixture.

Generate and stage without touching Projects:

```sh
python3 scripts/generate-media-fixture.py
adb -s SERIAL push /tmp/one-take-media-fixture/media-sample.mp4 /data/local/tmp/onetake-research.mp4
adb -s SERIAL shell run-as com.anonymous.onetake mkdir -p files/research
adb -s SERIAL shell run-as com.anonymous.onetake cp /data/local/tmp/onetake-research.mp4 files/research/media-sample.mp4
```

The generator uses macOS `say` with Samantha, and FFmpeg with drawtext. Raw synthetic audio/video stays local; source instructions are provided for reproduction.

## Observed results

| Check | Actual result |
| --- | --- |
| Instant cut preview | Rendered before any export. First observed load reported **240 ms**; a later load reported **89 ms**. These are isolated load-to-first-frame observations, not stop-to-first-frame capture measurements or a distribution. Native timing was subsequently guarded against duplicate first-frame callbacks. |
| Non-adjacent sequence | [Device screenshot](evidence/cut-playing.png) shows output position 4.7 s while source timecode is 8.800 s, blue final scene and final caption. Preview reached its 8.0 s end. |
| Captioned MP4 | First short export completed about **1.2 s** after request, in one run. Original fixture remained. Both H.264 video and AAC mono audio tracks are present. |
| Output geometry | Android reports encoded 1280×720 with 90° rotation: displayed portrait **720×1280**. Same composition/caption bitmap is used for native preview and render. |
| Container timing | Android inspection reports video 8,000,000 µs, audio 8,054,400 µs, total 8,054 ms. 238 video samples and 175 AAC samples. AAC begins at negative priming timestamps; packet spans alone are not a lip-sync result. [Full original/output inspection](evidence/container-8s.json). |
| Missing source | Native export rejected an absent dedicated fixture path before creating a job; real source unchanged. Exact error is in [background report](evidence/background-report.json). |
| Cancel | 120 s job started, cancellation requested after about 200 ms, state became cancelled and partial output cleanup ran. Source retained. |
| Background | A 120 s repeated cut entered running state, the app was sent Home, and it completed on return (native duration field 120,021 ms). [App-state and job log](evidence/background-report.json). UI polling is not exact render-end instrumentation. |
| Force-stop | A job was first verified queued/running, then app force-stopped. On relaunch it became interrupted; explicit new 8 s retry completed. [Before](evidence/interruption-before.json), [after](evidence/interruption-after.json). An earlier too-fast stop occurred before native job creation and is not counted as interruption proof. |
| Gallery | Save completed for a dedicated research export; owned MediaStore URI persisted. No broad gallery-read permission requested. [Delivery report](evidence/delivery-report.json). |
| Share | OS chooser displayed the generated MP4 and Quick Share/iQOOshare/File Manager targets. No target/recipient was selected. [Chooser](evidence/share-targets.png). Initial OEM transfer onboarding was dismissed; opening it alone was not counted as target-sheet proof. |

Native code review also caught and fixed a required CompositionPlayer source-duration field, duplicate first-frame reporting, prior-process queued-job recovery, a queued deletion startup race, gallery retry after external removal, and guaranteed service cleanup if cancellation-state persistence fails. These defensive branches are not all fault-injected device tests.

## Decoded synthetic phrase boundaries — PASS

The isolated `dev.onetake.npu` Android harness subsequently decoded the source and another completed 8-second export with Android MediaCodec on the same iQOO. Both decoded to 22,050 Hz mono PCM. This comparison used the predeclared [fixture method and thresholds](harness/README.md), not host decoding. [Full device report](evidence/decoded-audio-result.txt) and [actual captioned MP4](evidence/captioned-cut.mp4) are attached. The attached MP4 is a later export (1,264,625 bytes), separate from the earlier container-inspection run above.

Provenance: unmodified bytes pulled from `com.anonymous.onetake/files/one-take-exports/893e5273-de37-4a26-922e-960360cde9d8.mp4` and `files/research/media-sample.mp4`. SHA-256: source `fe24d7e41dfb8832b970e217929ce0f88650f6c4fd63cdc0bfbac4c986d7d02b`; attached export `5be46ba133622c0295076959d61aded633eb39bb6dabedd0f42dfcad949fe48a`.

| Retained phrase | First / last voiced-window correlation | First / last output lag | Voice onset / offset error |
| --- | --- | --- | --- |
| Source 0–4 s → output 0–4 s | 0.9082 / 0.9375 | 20.45 / 20.27 ms | 19.95 / 19.95 ms |
| Source 8–12 s → output 4–8 s | 0.9994 / 0.9996 | 32.70 / 32.70 ms | 39.91 / 29.93 ms |

The splice's 3.85–4.35 s decoded RMS was zero, matching deliberate source silence. All four waveform correlations exceeded 0.8; all measured lags and energy-boundary errors were below the predeclared 100 ms bound. The probe reported `PCM_FIXTURE_RESULT=PASS`. This is evidence that the beginning and end of both padded synthetic phrases survived export with measured small audio offsets and a quiet splice. It does not establish zero lag, decoded video-to-audio alignment, phoneme alignment, or human lip sync.

Final source review also verified that loading the same preview again remounts the native view, output actions target the active completed job, and storage-check cleanup opens its own database connection. These are source-review findings; they do not substitute for device rechecks.

## Reproduce via the app

Home → **Playback & export research · Dev** provides original/cut preview, short/stress export, cancellation, missing-source rejection, gallery/share and on-device container inspection. Logs are written only to `files/research/media-report.json`; container data to `files/research/container-report.json`. Export jobs and outputs live in dedicated native research directories. Force-stop test:

1. Start the two-minute stress cut and wait until it is running.
2. `adb -s SERIAL shell am force-stop com.anonymous.onetake`
3. Relaunch, open research, verify interrupted and explicitly retry.
4. Never report success based on an output path or partial file alone.

## What this does not establish

- No perceptual human lip-sync/word-boundary acceptance. The fixture has deliberately padded synthetic speech and no speaking face. On-device compressed-sample inspection is not decoded audio comparison or proof against clipped syllables on arbitrary recordings.
- No low-storage fault injection (the phone was not filled), gallery-denial simulation, OEM long-running service survival distribution or iOS implementation.
- No NPU inference in this media experiment. Android media codecs and graphics are used; exact hardware codec utilization was not profiled.
- No production editing/export migration. Camera, editor, projects, store and shared session types remain unchanged. Research results do not mark later feature issues done.
