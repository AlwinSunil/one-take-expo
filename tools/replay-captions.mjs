import { readFileSync } from 'node:fs';
import { captionState, reduceCaption } from '../src/lib/live-caption-state.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/captions.json', import.meta.url), 'utf8'));
let state = captionState(fixture.sessionId);
for (const event of fixture.events) state = reduceCaption(state, event);
console.log(JSON.stringify({ synthetic: fixture.synthetic, ...state }, null, 2));
