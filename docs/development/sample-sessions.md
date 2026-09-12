# Sample sessions

Use the debug app's Home → **Sample sessions · Dev**. No new route, native module, engine, account or network data is required. The runner is guarded by `__DEV__`; release Home does not load it. Samples are created fresh in memory; they never call SQLite, the camera, filesystem or exporter. Android Back returns from detail to the list and from the list to Home.

## Setup on a physical Android phone

Follow the SDK/JDK/NDK prerequisites in the root README. Use Node 24 for the shared-check CLI; it is also the CI version.

```sh
npm ci
npm run android -- --device
```

Select the connected iQOO. With an existing installed debug build and Metro:

```sh
npm start -- --localhost
# Separate terminal; replace SERIAL with the value from adb devices -l.
adb -s SERIAL reverse tcp:8081 tcp:8081
adb -s SERIAL shell am start -n com.anonymous.onetake/.MainActivity
```

On this Mac, `adb` is `/Users/melvin/Library/Android/sdk/platform-tools/adb`. No emulator is needed. Do not clear app data or uninstall to run the starter; that would erase existing projects.

## Seven replayable examples

| Sample | Expected result | Recovery / interaction |
| --- | --- | --- |
| Clean read | Two spoken lines covered, one continuous audio segment | Reset recreates the example |
| Flub & re-read | Original flagged take and reason remain; replacement supplies the cut | Inspect both take records |
| Pending analysis | One of two covered; never safe to wrap | Replay completed analysis loads the explicit clean fixture |
| Missing recording | Ledger remains visible, recording unavailable | Restore original is the production next action; no fake restore button |
| Action cue | Two spoken lines covered; required action still blocks wrap | Manually confirm, undo, reset; optional cue never blocks |
| Off-frame signal | Framing hint appears without invalidating speech | Keep intentional framing; no claim of real vision inference |
| Export failure | Low-space message, original/cut preserved | Replay export-ready state changes only fixture state; Reset restores the failure |

**Run handoff checks** executes 19 checks in the current device's JavaScript runtime and displays individual pass/fail results. Checks exercise fixture validation, dangling coverage, invalid/action references, repeated/out-of-range audio, pending/unavailable/empty states, action confirmation, replay isolation and one-breath segmentation. This is not real recording, audio-sync, thermal, NPU or export acceptance.

**Run on-device storage checks** uses the dedicated [media fixture](../research/review-export/f3/device-evidence.md) to exercise seven existing SQLite/filesystem behaviors. It creates uniquely named research projects, checks durable originals, trim persistence, missing-source failure and draft preservation, then removes only those fixture rows/files. It does not change the user's draft or existing projects. Cleanup uses a separate database connection so the app's shared connection remains open.

**Run coaching policy checks** executes the 14 [research policy examples](../research/capture-vision/f4/cue-policy.ts), including intent suppression, stale/pending inputs, prompt priority and recovery. These are policy checks, not image-model accuracy measurements.

For future CI or laptop work, the same checks are available without native modules:

```sh
npm run typecheck
npm run test:samples
npx expo export --platform android --output-dir dist
```

GitHub Actions runs these after `npm ci`. The Android export command checks production JavaScript bundling, **not** a native APK build. For this session, the user's testing constraint is the connected iQOO; host test/typecheck/bundle commands are documented/configured, not claimed as executed.

## Repeatable device UI check

With the debug app on Home and the device unlocked:

```sh
python3 scripts/check-samples-android.py --serial SERIAL --output /tmp/one-take-samples
```

Pass `--adb /absolute/path/to/adb` if platform-tools is not on PATH. The script drives the physical device, checks all seven states and recovery/back interactions, and captures the on-device 19/19 result. It writes screenshots and a JSON result into the output directory. Keep the phone available until it completes.

## Manual UX path

1. Open each sample, inspect its summary, lines, ledger and supplied cut. Use Back to return to the list.
2. Confirm the required action, undo it, and reset. Coverage must not erase the required-action state.
3. Replay pending analysis and export-ready states. They are explicitly labeled replays, not real engine/export completion.
4. Run checks; inspect the total and individual results. Back twice returns to Home.
5. Repeat with larger system text and on a compact display. Scroll must reach all controls; header Back and Reset remain reachable. Restore display settings afterward.
6. Confirm existing Projects and draft content are unchanged. Independently exercise baseline recording, preview, save/reopen and trim before integrated acceptance.

See `issue-6-device-evidence.md` for the actual checks and remaining review limits.
