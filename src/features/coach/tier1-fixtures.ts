import {
  gateTier1Coach,
  type Tier1CoachGate,
  type Tier1CoachGateInput,
  type Tier1Intent,
} from './tier1-policy.ts';

/**
 * Development-only replay inputs for the Tier 1 gate.
 *
 * These fixtures intentionally carry no frame rectangles, detector confidence,
 * or automatic "good" verdict. They exercise creator intent and lifecycle
 * suppression around the incoming Tier 0 coach. Fixture execution is host CPU
 * JavaScript and is not evidence of camera, model, NPU, or human accuracy.
 */
export interface Tier1DevelopmentFixture {
  id: string;
  label: 'synthetic-development-only';
  scene: 'intentional-good' | 'product-only' | 'speech-active' | 'coverage-priority' | 'missing-degraded';
  intent: Tier1Intent;
  /** A human-readable expectation for a replay report. */
  expected: 'intentional' | 'delegate' | 'hidden';
  input: Tier1CoachGateInput;
}

const baseInput: Tier1CoachGateInput = {
  enabled: true,
  intent: 'talking-head',
  recording: false,
  nowMs: 10_000,
  takeId: 'fixture-take-1',
  captureGeneration: 'fixture-front-generation-1',
  priority: {
    takeId: 'fixture-take-1',
    observedAtMs: 9_900,
    captureGeneration: 'fixture-front-generation-1',
    coverageOrActionRequired: false,
  },
  speech: {
    takeId: 'fixture-take-1',
    captureGeneration: 'fixture-front-generation-1',
    observedAtMs: 9_900,
    state: 'silent',
    betweenLines: false,
  },
};

export const TIER1_DEVELOPMENT_FIXTURES: readonly Tier1DevelopmentFixture[] = [
  {
    id: 'tier1-intentional-good',
    label: 'synthetic-development-only',
    scene: 'intentional-good',
    intent: 'intentional-look',
    expected: 'intentional',
    input: { ...baseInput, intent: 'intentional-look' },
  },
  {
    id: 'tier1-product-only',
    label: 'synthetic-development-only',
    scene: 'product-only',
    intent: 'product-demo',
    expected: 'delegate',
    input: { ...baseInput, intent: 'product-demo' },
  },
  {
    id: 'tier1-speech-active',
    label: 'synthetic-development-only',
    scene: 'speech-active',
    intent: 'vlog',
    expected: 'hidden',
    input: {
      ...baseInput,
      intent: 'vlog',
      recording: true,
      speech: { ...baseInput.speech!, state: 'speaking', betweenLines: true },
    },
  },
  {
    id: 'tier1-coverage-priority',
    label: 'synthetic-development-only',
    scene: 'coverage-priority',
    intent: 'talking-head',
    expected: 'hidden',
    input: {
      ...baseInput,
      recording: true,
      speech: { ...baseInput.speech!, betweenLines: true },
      priority: { ...baseInput.priority!, coverageOrActionRequired: true },
    },
  },
  {
    id: 'tier1-missing-degraded',
    label: 'synthetic-development-only',
    scene: 'missing-degraded',
    intent: 'product-demo',
    expected: 'hidden',
    input: {
      ...baseInput,
      intent: 'product-demo',
      recording: true,
      speech: null,
      priority: null,
    },
  },
] as const;

/** Replay one fixture through the gate; no automatic vision work is started. */
export function replayTier1DevelopmentFixture(fixture: Tier1DevelopmentFixture): Tier1CoachGate {
  return gateTier1Coach(fixture.input);
}
