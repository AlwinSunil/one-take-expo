# Recorded recognition event logs

Every file here is a **synthetic** recording of the events the caption bridge
sends to JavaScript. No audio, no recorded human speech and no user transcript
is stored. The transcripts are invented sentences written for these fixtures.

These logs exist so a recognition session can be replayed offline and compared
with itself. They do not establish device recognition accuracy, latency, or
quiet/noisy behavior on a phone. Those checks stay in
[`docs/issue-acceptance.md`](../../../docs/issue-acceptance.md).

## Format

```jsonc
{
  "synthetic": true,          // always true in this directory
  "name": "quiet-read",
  "sessionId": "quiet-read",  // the session the log is replayed as
  "description": "...",       // what the recording is meant to represent
  "capturedDurationMs": 6400, // recording wall-clock length
  "events": [                 // onCaption payloads, in delivery order
    {
      "atMs": 1200,           // delivery time on the session clock
      "sessionId": "quiet-read",
      "sequence": 1,
      "text": "the light is",
      "isFinal": false,
      "segments": [{ "id": "q1", "t0": 0.6, "t1": 1.4, "text": "the light is", "isFinal": false }]
    }
  ],
  "statusEvents": [           // onStatus payloads, in delivery order
    { "atMs": 0, "sessionId": "quiet-read", "status": "preparing" }
  ],
  "timingEvents": [           // stage observations for src/lib/caption-timing.ts
    { "utteranceId": "q1", "stage": "speech-end", "at": 2100 }
  ]
}
```

`events` may contain stale entries on purpose: an event from another session,
or a revision whose `sequence` is not newer than one already delivered. Replay
must drop them wherever they appear in the log.

## Replay

```sh
npm run samples                                       # every recording
node --experimental-strip-types tools/replay-captions.mjs tools/speech-fixtures/recordings/quiet-read.json
node --experimental-strip-types --test tests/caption-replay.test.mjs
```
