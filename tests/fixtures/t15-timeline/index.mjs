export const source = (id, overrides = {}) => ({
  id,
  uri: `file:///${id}.mp4`,
  duration: 20,
  available: true,
  ...overrides,
});

export const clip = (id, sourceId, t0, t1, overrides = {}) => ({
  id,
  sourceId,
  t0,
  t1,
  included: true,
  reasonIds: [],
  spanIds: [`span:${id}`],
  pointIds: [`point:${id}`],
  utteranceIds: [`utterance:${id}`],
  ...overrides,
});

export const snapshot = (clips, revision = 0) => ({
  revision,
  clips: clips.map(item => ({
    ...item,
    reasonIds: [...item.reasonIds],
    spanIds: [...item.spanIds],
    pointIds: [...item.pointIds],
    utteranceIds: [...item.utteranceIds],
  })),
});

export const reasons = {
  silence: { id: 'reason:silence', kind: 'silence', text: 'Silence', actor: 'analysis' },
  creator: { id: 'reason:creator', kind: 'creator', text: 'Creator excluded this range', actor: 'creator' },
};
