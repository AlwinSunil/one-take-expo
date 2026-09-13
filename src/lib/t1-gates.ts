export type Tier1Feature = 'takeReview' | 'wrapReport' | 'reframing' | 'speech' | 'coaching';
/** No release acceptance has been granted. Never derive release gates from saved projects. */
export const TIER1_RELEASE_GATES: Readonly<Record<Tier1Feature, boolean>> = Object.freeze({
  takeReview: false, wrapReport: false, reframing: false, speech: false, coaching: false,
});
export function tier1Enabled(feature: Tier1Feature, development: boolean, explicitTestOptIn = false): boolean {
  return TIER1_RELEASE_GATES[feature] || (development && explicitTestOptIn);
}
