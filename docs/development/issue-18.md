# Issue #18 composition coach handoff

Date: 2026-09-13.

This lane adds an isolated policy and reusable React Native view for the Tier 0 composition coach.

The implementation does not edit `src/app/camera.tsx`, open a camera, inspect frames, install a model, or own a native runtime.

The future capture and vision owner supplies the evidence contract below.

## User flow

The creator first chooses one intent: Talking head, Product, Subject, or Intentional look.

The coach does not select a face, product, or subject on the creator's behalf.

Intentional look is an explicit override that reports that automatic suggestions are off without making an image-quality claim.

After an intent is selected, the card shows at most one suggestion.

The card includes a short action, a plain reason, and a 44 dp minimum dismiss control.

Dismissal is local to the current take and the parent may also persist it in `dismissedCues`.

The card is normal layout content, so the integration owner can place it below script or caption content and above the record controls.

It has no modal, camera setting, timer, animation, or recording side effect.

When recording, the policy stays silent while speech is speaking or unknown.

It only permits a new suggestion after the capture owner reports an actual between-lines interval.

## Evidence contract

The producer imports the types from [`src/features/coach/policy.ts`](../../src/features/coach/policy.ts).

The exact top-level contract is:

```ts
export type CoachVisionEvidence =
  | {
      status: 'ready';
      frameCapturedAtMs: number;
      observations: Partial<Record<CoachCue, CueObservation>>;
    }
  | { status: 'pending'; reason?: VisionUnavailableReason }
  | { status: 'unavailable'; reason: VisionUnavailableReason };
```

`frameCapturedAtMs` and the policy `nowMs` must use the same monotonic clock.

The producer sends an observation only when it can name the detector, detector version, selected target, and calibration state.

The measured observation shape is:

```ts
export interface MeasuredCueObservation {
  state: 'issue' | 'clear';
  stableForMs: number;
  measurement: {
    source: 'on-device-vision';
    detectorId: string;
    detectorVersion: string;
    target: 'selected-face' | 'selected-subject' | 'selected-product';
    calibrated: boolean;
    // Required only for face-clipping, and must be at least 0.9.
    confidence?: number;
  };
}
```

An unsupported cue is explicit:

```ts
export interface UnsupportedCueObservation {
  state: 'unsupported';
  reason: string;
}
```

The policy rejects an issue or clear observation unless `source` is `on-device-vision`, detector identity is non-empty, `calibrated` is true, and the target matches the selected intent.

For `face-clipping`, confidence must be finite and at least `0.9`.

The policy does not display confidence values.

The producer must not fabricate confidence for backlight or background observations.

Those cues need camera-calibrated, selected-subject evidence before they can be sent as measured.

Until that validation exists, send `{ state: 'unsupported', reason: 'camera-calibration-pending' }` or an equivalent precise reason.

Missing or unsupported observations do not produce an all-good message.

The producer should send `status: 'pending'` while loading and `status: 'unavailable'` for runtime failure, unsupported devices, thermal pressure, or a missing frame pipeline.

The recording path remains available for every pending or unavailable state.

## Policy behavior

The policy uses the following proposed research windows from `docs/research/capture-vision/f4`:

| Rule | Value | Result |
| --- | ---: | --- |
| Fresh frame | 500 ms maximum age | Older or future-dated frames pause suggestions. |
| Issue stability | 1.5 s minimum | A transient detector result does not prompt. |
| Clear stability | 1 s minimum | The all-good state does not hide an unsettled signal. |
| Prompt cooldown | 15 s | Distinct prompts stay quiet during a take. |
| Face confidence floor | 0.9 | Low-confidence face clipping abstains. |

Priority is face clipping, selected subject clipping, backlight, then background distraction.

The priority is a product hypothesis from the research handoff and is not a model accuracy claim.

Talking-head intent evaluates the selected face.

Product intent evaluates a selected product.

Subject intent evaluates a selected subject.

No-face product shots therefore do not produce a face prompt.

The all-good state is emitted only when every cue required by the selected intent is measured clear for at least one second.

If a specific cue is measured and actionable, the UI may show that cue even when another requested cue is missing or unsupported.

Only the all-good state requires every requested cue to be validated and clear.

If no actionable measured cue is available and any required cue is missing, unsupported, invalid, or unstable, the UI reports analysis unavailable or paused.

## Integration handoff

The #15 vision producer should adapt its single CameraX `ImageAnalysis` owner to the evidence contract after the shared capture API is ready.

It should publish the newest completed observation and drop stale work instead of queueing frames.

It should use `target: 'selected-face'` only after the creator has selected a talking-head target.

It should use `target: 'selected-product'` or `target: 'selected-subject'` only after the corresponding intent and target selection are explicit.

The parent camera owner supplies `recording`, `speechState`, `betweenLines`, `nowMs`, `lastPromptAtMs`, `activeCue`, `dismissedCues`, and `takeId`.

`nowMs` is required on `CompositionCoach` and must use the same clock as `frameCapturedAtMs`.

The caller should advance `nowMs` while the component is mounted or publish a fresh pending/unavailable state when frame production stops so a stale card can expire.

The component deliberately does not create a timer or inference loop to age frames.

The parent should update `lastPromptAtMs` and `activeCue` from `onPromptShown` so the cooldown is owned by the take state.

`activeCue` is the cue paired with `lastPromptAtMs` and keeps that same cue visible while its evidence remains valid.

A different cue remains gated until the cooldown expires.

The parent must reset the take ID on a new take or camera switch so a stale dismissal cannot leak into another capture.

The parent should place `CompositionCoach` outside record, script, coverage, and Safe to wrap controls.

The parent should pass `showIntentPicker={false}` when another owner renders the intent control.

The component's local dismissal state is keyed by `takeId` and therefore resets synchronously when `takeId` changes.

No effect starts inference or updates parent prompt timestamps, so rendering the component cannot create a render/state feedback loop.

## What the research proves and what remains open

The f4 work provides sourced composition guidance, intent exceptions, a small licensed photo corpus, and isolated policy checks.

Its iQOO checks are geometry and policy exercises, not production camera-frame accuracy.

The capture-vision report has one actual-camera positive and one actual-camera negative detector observation.

That pair cannot establish precision, recall, subgroup performance, full-body or headroom accuracy, lighting quality, or background quality.

Backlight and background distraction remain unavailable by default because the target-phone calibration and representative actual-camera pairs are not complete.

NPU acceleration is not claimed here.

The current parent architecture plans a bundled face detector with CPU fallback through the shared CameraX analysis path while NPU and ORT collision work remains open.

The following integrated evidence remains required after #11 and #15 handoffs:

- actual front and rear camera frames across indoor, outdoor, low-light, backlight, group, handheld, hands-only, and intentional-composition scenes;
- detection-loss recovery and camera-switch stale-frame checks;
- large-text and screen-reader traversal with record controls reachable;
- recording, draft, trim, wrap, and export behavior while vision is pending or unavailable;
- measured CPU and accelerated latency, thermal, battery, and frame-rate impact on the target phone;
- named non-author reproduction and review.

The implementation therefore provides a safe integration surface and truthful unavailable states.

## Local checks

Run the focused behavior suite with:

```sh
node --experimental-strip-types --test tests/coach-policy.test.mjs
```

Run the repository TypeScript check with:

```sh
npm run typecheck
```

These checks exercise policy timing, stale frames, invalid evidence, intent suppression, speech quieting, dismissal, cooldown, all-good, and pending/unavailable states.

They do not establish camera-frame, NPU, thermal, A/V, or integrated recording correctness.

## Camera integration

The Suggestions sheet now renders the intent picker, enable switch, automatic-cue availability, and manual setup tips.
The sheet cannot be opened during preparation, recording, or saving, so it cannot cover an active read.
The shared vision hook supplies real face presence, but no calibrated composition cue is inferred from that alone.
Automatic cues therefore remain unavailable until the producer supplies the measured evidence required by this policy.
