import { readFileSync } from 'node:fs';
import { createFoundation, validateFoundation } from '../src/lib/t15-schema.ts';
import { producerScope } from '../src/lib/t15-jobs.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/t15-foundation.json', import.meta.url), 'utf8'));
const state = createFoundation(fixture.project);
validateFoundation(state, fixture.project);
const request = {
  id: 'job:fixture:1', projectId: fixture.project.id, sourceId: fixture.project.id,
  attempt: 1, idempotencyKey: 'fixture:analysis:1', base: state.revisions,
  producer: 'fixture', producerVersion: '1',
};
const result = {
  id: 'result:fixture:1', jobId: request.id, attempt: 1,
  projectId: request.projectId, sourceId: request.sourceId, base: request.base,
  status: 'partial', observationIds: [], proposalIds: [], reasonIds: [],
  payload: { version: 1, status: 'not-collected', note: 'No model ran in this fixture.' },
};
console.log(JSON.stringify({ version: 1, sources: state.sources, timeline: state.timeline,
  captions: state.captions, history: state.history, request, producerScope: producerScope(request), result }, null, 2));
