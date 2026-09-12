import { readFileSync, readdirSync } from 'node:fs';
import { summarizeCaptionTiming } from '../src/lib/caption-timing.ts';
import {
  liveCaptionSession,
  reduceLiveCaptionStatus,
  replayCaptionSession,
} from '../src/lib/live-caption-state.ts';

const recordingsDirectory = new URL('./speech-fixtures/recordings/', import.meta.url);

function load(url) {
  return { url, session: JSON.parse(readFileSync(url, 'utf8')) };
}

/**
 * Replay one recorded recognition log through the same reducers the camera
 * screen uses, so a recording always produces the transcript it produced live.
 */
function replay({ url, session }) {
  const merged = replayCaptionSession(session.sessionId, session.events);
  const state = (session.statusEvents ?? [])
    .reduce(reduceLiveCaptionStatus, liveCaptionSession(session.sessionId));
  const timing = summarizeCaptionTiming(session.timingEvents ?? []);
  return {
    synthetic: session.synthetic,
    source: url.pathname.split('/').slice(-2).join('/'),
    ...merged,
    status: state.status,
    reason: state.reason,
    timing: { delayed: timing.delayed, utterances: timing.utterances },
    timingLines: timing.lines.map(entry => entry.line),
  };
}

const requested = process.argv.slice(2);
const sessions = requested.length > 0
  ? requested.map(path => load(new URL(path, `file://${process.cwd()}/`)))
  : [
    load(new URL('./fixtures/captions.json', import.meta.url)),
    ...readdirSync(recordingsDirectory)
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => load(new URL(name, recordingsDirectory))),
  ];

console.log(JSON.stringify(sessions.map(replay), null, 2));
