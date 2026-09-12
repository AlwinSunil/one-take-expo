# Issue #6 — iQOO evidence

Date: 2026-09-13. Branch: `feat/melvin-sample-sessions`, based on `400e56f`.

## Device and build

- Connected iQOO, Android model `I2501`, serial `10BFAT1U1Q000XP`.
- Android 16, OS build `PD2505F_EX_A_16.0.21.12.W30`, reported SoC `SM8850`.
- Installed native debug app `com.anonymous.onetake`, version 1.0.0 (1), with this branch's JavaScript served by the existing Metro on port 8081. No new native APK was built for this JavaScript-only change.
- Expo dependency `~57.0.22`, React Native `0.86.3`. Read the [exact SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/) before code changes.
- Processor/model for sample engines: **fixture / none**. Only shared-data checks ran in the phone's JavaScript runtime; this is not NPU, audio sync or export evidence.

## Actual results

- **12/12 device UI-path checks passed** using the committed automation script. [Recorded results](evidence/issue-6/device-results.json).

- **19/19 shared-handoff checks passed on the device**, via Home → Sample sessions · Dev → Run handoff checks. [Results screenshot](evidence/issue-6/checks.png).
- All seven sample details opened with their expected summary/error state and returned to the list with Android Back.
- Required action: confirm and undo worked. Pending analysis: explicit completed-sample replay worked. Export failure: replay removed the error state, Reset restored it. [Failure/recovery sample](evidence/issue-6/export-failure.png).
- Results start at the top even when Run handoff checks is reached by scrolling down the list. Android Back returns to the sample list, then Home.
- At **320 dp display width and 1.3× system font scale**, text wrapped, action controls stayed reachable by scrolling, confirmation/reset worked, and 19/19 checks still passed. [Large-text action screenshot](evidence/issue-6/large-text-action.png).
- Restored the user's original system font scale **1.0** and physical density **600** after the compact-display pass.

The first device pass exposed two defects, both fixed and rechecked: NativeWind did not apply Pressable style callbacks (changed to static styles and active-state classes), and the checks page retained the list's scroll offset (reset to top when checks run). A first automation attempt also excluded the fixed header from tap targeting; corrected the automation's bounds filter before testing Reset.

## Reproduction

Start the installed debug app with Metro connected, unlock the iQOO, and leave it on Home. The committed Python script drives **only the physical phone** via ADB; it does not run fixture logic on the host.

```sh
/Users/melvin/Library/Android/sdk/platform-tools/adb -s 10BFAT1U1Q000XP reverse tcp:8081 tcp:8081
/Users/melvin/Library/Android/sdk/platform-tools/adb -s 10BFAT1U1Q000XP shell am start -n com.anonymous.onetake/.MainActivity
python3 scripts/check-samples-android.py --serial 10BFAT1U1Q000XP --adb /Users/melvin/Library/Android/sdk/platform-tools/adb --output /tmp/one-take-issue-6/final
```

Expected: 12 UI-path checks, including the device-displayed **19/19** shared-data result; screenshots and `device-results.json` in the output directory. These are sample checks, not live-engine correctness checks.

For the compact-display manual pass:

```sh
adb -s SERIAL shell settings put system font_scale 1.3
adb -s SERIAL shell wm density 720
# Open samples, confirm/reset the action, run checks, use Android Back.
# Restore the original values recorded before the pass:
adb -s SERIAL shell settings put system font_scale 1.0
adb -s SERIAL shell wm density reset
```

Use the device's actual prior font/density values on other phones; do not assume these defaults.

## Not yet established

- Host TypeScript/CLI tests and production bundle command were **not run**, following the user's instruction to test on the connected iQOO. CI is configured to run them, but no CI run is claimed.
- No production coverage/storage consumer has adopted this proposed handoff. No persisted `Project` shape or database migration changed.
- This pass did not re-record audio or perform an end-to-end draft/record/save/reopen/trim regression. The baseline is documented by source inspection; those integrated acceptance checks remain outstanding.
- No recognition, native export, actual missing-file recovery, low-storage filesystem failure, background render, camera/NPU/thermal behavior or screen-reader traversal was verified.
- Both Alwin and Sabari still need to run the starter and review the shared examples. No issue was closed or acceptance box checked on their behalf.

## Final native-build regression — 2026-09-13

On the same iQOO with the rebuilt Media3 debug app and final working-tree JavaScript: **7/7 storage checks, 14/14 coaching policy checks and 19/19 handoff checks passed**. [Device output](evidence/final/results.json), [storage result](evidence/final/storage.png), [coaching result](evidence/final/coaching.png).

Storage checks exercise the existing store through real SQLite and file APIs, including durable originals, persisted trim/script, two independent projects, temporary missing-file metadata retention, failed-save preservation and unchanged draft. Only dedicated research fixture rows/files are removed; the shared database connection remains open. These checks add actual filesystem evidence beyond the earlier in-memory samples. Coaching checks establish suppression/priority behavior only, not a model's image accuracy.

The separate [media experiment](../research/review-export/f3/device-evidence.md) and [capture experiment](../research/capture-vision/f1/device-results.md) contain actual native results that were not part of the initial sample-only pass above.
