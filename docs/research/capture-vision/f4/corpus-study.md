# Real-photo crop feasibility corpus

Retrieved 2026-09-13. Five independently sourced actual photographs, three development sources and two source-level held-outs. [corpus.json](corpus.json) pins original URLs, bytes, SHA-256, source pages, authors, licenses and splits. Original JPEGs and source-page snapshots were downloaded to `/tmp/one-take-f4-corpus`; no binary photographs are added to git.

Public copyright permission is recorded individually, not inferred from Commons' site-wide metadata license. Four sources carry CC0-1.0; the NASA source carries US public-domain provenance. No separate model release, research consent or endorsement is claimed. This is an internal, attributed visual composition study, not advertising or identity recognition. Source images remain unchanged; the study displays full and cropped viewports of the same image. Cropped viewports are constructed counterexamples, **not separately captured before/after scenes**.

| Source | Provenance | Split and use |
| --- | --- | --- |
| Outdoor portrait | [Abhi Puthenpurackal, CC0](https://commons.wikimedia.org/wiki/File:Outdoors-man-portrait.jpg) | Development: centered talking-head proxy, blurred background accepted; manual face-region clipping pair |
| Travel mug | [Sprinno, CC0](https://commons.wikimedia.org/wiki/File:Coffeecup.jpg) | Development: product-only, reflective surface, white background, no-face normal; product clipping pair. Only 273×500; unsuitable for sharpness assessment. |
| Person in spacecraft workspace | [NASA, public domain](https://commons.wikimedia.org/wiki/File:Mae_Jemison_in_Space.jpg) | Development: indoor person/hands/equipment, meaningful busy background, mixed bright/dark regions; face clipping pair. Do not auto-level a microgravity scene. |
| Group photo | [Anuary Rajabu, CC0](https://commons.wikimedia.org/wiki/File:Group_photo01.jpg) | Held-out: downloaded and license read, pixels not inspected or fed to the study |
| Portrait | [Serene Zaina, CC0](https://commons.wikimedia.org/wiki/File:Gazzaniga.jpg) | Held-out: downloaded and license read, pixels not inspected or fed to the study |

Skin-tone labels are intentionally absent: no self-description or calibrated labeling procedure is available. Visible image brightness must not become a demographic label. This small corpus does **not** establish coverage across skin tones, lighting conditions or creators. The later [four-source supplement](corpus-breadth.md) adds backlight, low-key objects, hands-only and handheld-phone situations. Actual moving vlogs and intentionally blurred video clips remain acquisition gaps. Held-outs remain grouped by source; do not tune against them after evaluation and still call them unseen.

## Reproduce on the connected iQOO

The HTML is an isolated research fixture, not production UI. It evaluates rectangle containment from manually approximate selected regions, not detection. No model performance can be inferred. Host work below only downloads/serves artifacts; behavior checks run in physical-phone Chrome.

Copy `corpus.json` and `corpus-study.html` to `/tmp/one-take-f4-corpus`. To restore JPEGs, download each manifest `url` to its `localFile` and confirm SHA-256 before use. Keep source and attribution links with the corpus. Then:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory /tmp/one-take-f4-corpus
adb -s SERIAL reverse tcp:8766 tcp:8766
adb -s SERIAL shell am start -a android.intent.action.VIEW -d http://127.0.0.1:8766/corpus-study.html com.android.chrome
```

On iQOO: inspect all three full/clipped pairs and attribution; tap **Run crop feasibility checks**. Expected 3/3: all full-source selected regions remain inside the frame; all deliberately cropped variants clip them. Turn on **Intentional crop** and rerun: expected 3/3 with no advice for any variant. The positive crop is not a universal bad composition: changing intent suppresses it. Capture output and a screenshot for each state, including actual phone/OS/browser version. No camera permission or inference is involved. Disable networking after local assets load and repeat to confirm no remote runtime dependency.

## Actual device result

Physical iQOO I2501, serial `10BFAT1U1Q000XP`, Android 16, Chrome 140.0.7339.207. The browser reduces its user-agent Android version to 10; OS 16 was read independently from `ro.build.version.release`. The final run is recorded in [raw output](evidence/photo-study-results.json): **3/3 source-pair checks passed**, then **3/3 with intentional-crop suppression passed**. No held-out sources used. See [normal state](evidence/default.png), [intentional state](evidence/intentional.png) and [real viewport pairs](evidence/photo-pairs.png).

Device visual inspection caught an SVG letterboxing issue: pixels outside the intended crop could appear in the letterbox area. Added an explicit clipPath and repeated both checks on the physical phone. Final screenshot confirms actual clipping. This fix concerns the study viewer, not a camera crop pipeline. Default and intent states verify policy failure/recovery behavior only; no real image-quality model failed or recovered.

Chrome had no existing tabs and displayed first-run setup; used it without an account and declined notifications. No default-browser selection, personal tab edits, sharing, camera permissions or display-setting changes. Removed the study's adb reverse port after use. Network-disabled rerun was **not** performed. The root subsequently ran all **14/14 TypeScript policy checks** in the iQOO native app dev runner; [separate result evidence](../../../development/evidence/final/results.json). They are not included in these six browser checks and are not model precision measurements.

No precision/recall, real-camera temporal stability, skin-tone fairness, NPU or integrated capture claim. This complements the original geometric fixture and improves the research-ready subset; it does not satisfy all #10 acceptance checks. Current remaining issue requirements after the [breadth supplement](corpus-breadth.md): representative paired actual-camera scenes (the one camera-negative detector result establishes feasibility only); model/artifact license ledger if a model is selected; integrated nonblocking viewfinder evidence after #7; named non-author reproduction/review. The README's proposed 100+100 clip release gates are future production guidance, not additional research-milestone requirements.
