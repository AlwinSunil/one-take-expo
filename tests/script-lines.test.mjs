import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctAmbiguousCue,
  deleteLine,
  formatReadTime,
  parseScript,
  reorderLines,
  restoreScriptDocument,
  scriptChangeIntent,
  serializeScriptDocument,
  setCueRequired,
  setCueStatus,
  unresolvedRequiredCueIds,
} from '../src/lib/script-lines.ts';

const CAMERA_CHUNKS = /[^.!?\n]+[.!?]?/g;

function cameraChunks(text) {
  return (text.match(CAMERA_CHUNKS) ?? []).map(s => s.trim()).filter(Boolean);
}

test('pasted text splits the same way the camera prompter chunks it', () => {
  const text = 'This is the camera. It records in 4K!\nAsk for the price?';
  const document = parseScript(text);
  assert.deepEqual(document.lines.map(line => line.text), cameraChunks(text));
  assert.equal(document.text, text);
  assert.deepEqual(document.lines.map(line => line.spokenText), [
    'This is the camera.',
    'It records in 4K!',
    'Ask for the price?',
  ]);
});

test('editing one line keeps the ids and the order of the untouched lines', () => {
  const first = parseScript('Line one. Line two. Line three.');
  const ids = first.lines.map(line => line.id);
  const second = parseScript('Line one. Line two rewritten. Line three.', first);

  assert.deepEqual(second.lines.map(line => line.id), ids);
  assert.equal(second.lines[1].spokenText, 'Line two rewritten.');
  assert.deepEqual(scriptChangeIntent(first, second), {
    editedLineIds: [ids[1]],
    deletedLineIds: [],
    addedLineIds: [],
  });
});

test('inserting a line keeps existing ids and mints one new id', () => {
  const first = parseScript('Line one. Line two.');
  const ids = first.lines.map(line => line.id);
  const second = parseScript('Line one. Brand new line. Line two.', first);

  assert.deepEqual([second.lines[0].id, second.lines[2].id], ids);
  assert.equal(ids.includes(second.lines[1].id), false);
  assert.deepEqual(scriptChangeIntent(first, second), {
    editedLineIds: [],
    deletedLineIds: [],
    addedLineIds: [second.lines[1].id],
  });
});

test('deleting a line keeps the deleted line in history and reports the intent', () => {
  const first = parseScript('Line one. Line two. Line three.');
  const removedId = first.lines[1].id;
  const second = deleteLine(first, removedId);

  assert.deepEqual(second.lines.map(line => line.id), [first.lines[0].id, first.lines[2].id]);
  assert.deepEqual(second.removedLines.map(line => line.id), [removedId]);
  assert.equal(second.removedLines[0].spokenText, 'Line two.');
  assert.deepEqual(scriptChangeIntent(first, second), {
    editedLineIds: [],
    deletedLineIds: [removedId],
    addedLineIds: [],
  });

  // Re-parsing the rebuilt text must not resurrect the deleted line or its id.
  const third = parseScript(second.text, second);
  assert.deepEqual(third.lines.map(line => line.id), second.lines.map(line => line.id));
  assert.deepEqual(third.removedLines.map(line => line.id), [removedId]);
});

test('reordering keeps every line id and reports the previous order', () => {
  const first = parseScript('Alpha. Beta. Gamma.');
  const [a, b, c] = first.lines.map(line => line.id);
  const second = reorderLines(first, [c, a, b]);

  assert.deepEqual(second.lines.map(line => line.id), [c, a, b]);
  assert.deepEqual(second.lines.map(line => line.spokenText), ['Gamma.', 'Alpha.', 'Beta.']);
  assert.deepEqual(scriptChangeIntent(first, second), {
    editedLineIds: [],
    deletedLineIds: [],
    addedLineIds: [],
    reorderedFrom: [a, b, c],
  });
  assert.deepEqual(parseScript(second.text, second).lines.map(line => line.id), [c, a, b]);
});

test('spoken word count excludes action cue text and read time uses 150 words per minute', () => {
  const document = parseScript('One two three four five. [hold up the product] Six seven.');
  assert.equal(document.spokenWordCount, 7);
  // 7 words / 150 wpm = 2.8 s, rounded up to a whole second.
  assert.equal(document.readTimeSeconds, 3);
  assert.equal(document.readTime, '0:03');

  const long = parseScript(`${'word '.repeat(300).trim()}.`);
  assert.equal(long.spokenWordCount, 300);
  assert.equal(long.readTimeSeconds, 120);
  assert.equal(long.readTime, '2:00');
});

test('read time formats minutes and zero padded seconds', () => {
  assert.equal(formatReadTime(0), '0:00');
  assert.equal(formatReadTime(9), '0:09');
  assert.equal(formatReadTime(61), '1:01');
  assert.equal(formatReadTime(600), '10:00');
});

test('an inline bracket becomes an action cue and leaves the spoken words intact', () => {
  const document = parseScript('This is the camera. [hold up the product] It records in 4K.');
  assert.deepEqual(document.lines.map(line => line.spokenText), [
    'This is the camera.',
    'It records in 4K.',
  ]);
  assert.deepEqual(document.lines[1].actionCues.map(cue => cue.text), ['hold up the product']);
  assert.equal(document.lines[1].kind, 'spoken');
  // "hold up the product" is a direction, so it never reaches the spoken count.
  assert.equal(document.spokenWordCount, 8);
});

test('a standalone bracketed line is an action-only line', () => {
  const document = parseScript('Say hello.\n[smile]\nThen continue.');
  assert.deepEqual(document.lines.map(line => line.kind), ['spoken', 'action-only', 'spoken']);
  assert.equal(document.lines[1].spokenText, '');
  assert.deepEqual(document.lines[1].actionCues.map(cue => cue.text), ['smile']);
  assert.equal(document.spokenWordCount, 4);
});

test('multiple brackets in one line become separate cues with distinct ids', () => {
  const line = parseScript('[smile] Welcome back [wave] everyone.').lines[0];
  assert.deepEqual(line.actionCues.map(cue => cue.text), ['smile', 'wave']);
  assert.equal(new Set(line.actionCues.map(cue => cue.id)).size, 2);
  assert.equal(line.spokenText, 'Welcome back everyone.');
});

test('an unclosed bracket stays spoken text and is flagged ambiguous', () => {
  const document = parseScript('Now [hold up the product');
  const line = document.lines[0];
  assert.deepEqual(line.actionCues, []);
  assert.deepEqual(line.ambiguousCues.map(cue => cue.text), ['hold up the product']);
  assert.equal(line.spokenText, 'Now [hold up the product');
  // Nothing is silently dropped from the spoken count while the text is ambiguous.
  assert.equal(document.spokenWordCount, 5);
});

test('nested and empty brackets never lose content', () => {
  const nested = parseScript('Say [hold [the] product] now.').lines[0];
  const nestedWords = [nested.spokenText, ...nested.actionCues.map(cue => cue.text)].join(' ');
  for (const word of ['Say', 'hold', 'the', 'product', 'now']) {
    assert.equal(nestedWords.includes(word), true, `nested bracket lost "${word}"`);
  }

  const empty = parseScript('Keep [] this.').lines[0];
  assert.deepEqual(empty.actionCues, []);
  assert.deepEqual(empty.ambiguousCues, []);
  assert.equal(empty.spokenText.includes('Keep'), true);
  assert.equal(empty.spokenText.includes('this.'), true);
});

test('an ambiguous bracket can be corrected to an action cue', () => {
  const first = parseScript('Now [hold up the product');
  const cueId = first.lines[0].ambiguousCues[0].id;
  const second = correctAmbiguousCue(first, cueId, 'action');

  assert.deepEqual(second.lines[0].ambiguousCues, []);
  assert.deepEqual(second.lines[0].actionCues.map(cue => cue.text), ['hold up the product']);
  assert.equal(second.lines[0].spokenText, 'Now');
  assert.equal(second.lines[0].id, first.lines[0].id);
  assert.equal(second.spokenWordCount, 1);
});

test('an ambiguous bracket can be marked actually spoken', () => {
  const first = parseScript('Now [hold up the product');
  const cueId = first.lines[0].ambiguousCues[0].id;
  const second = correctAmbiguousCue(first, cueId, 'spoken');

  assert.deepEqual(second.lines[0].ambiguousCues, []);
  assert.deepEqual(second.lines[0].actionCues, []);
  assert.equal(second.lines[0].spokenText, 'Now hold up the product');
  assert.equal(second.lines[0].id, first.lines[0].id);
  assert.equal(second.spokenWordCount, 5);
});

test('an actions only script asks for a spoken line', () => {
  const actionsOnly = parseScript('[smile]\n[wave]');
  assert.equal(actionsOnly.nextStep, 'add-spoken-line');
  assert.equal(actionsOnly.spokenWordCount, 0);

  assert.equal(parseScript('').nextStep, 'add-script');
  assert.equal(parseScript('[smile]\nSay hello.').nextStep, 'ready-to-record');
});

test('cues are optional until the creator marks them required', () => {
  const first = parseScript('Say hello. [smile]');
  const cue = first.lines[1].actionCues[0];
  assert.equal(cue.required, false);
  assert.equal(cue.status, 'pending');
  assert.deepEqual(unresolvedRequiredCueIds(first), []);

  const second = setCueRequired(first, cue.id, true);
  assert.equal(second.lines[1].actionCues[0].required, true);
  assert.deepEqual(unresolvedRequiredCueIds(second), [cue.id]);
});

test('required cue done and skipped statuses are manual and never inferred', () => {
  const first = parseScript('Say hello. [smile]');
  const cueId = first.lines[1].actionCues[0].id;
  const required = setCueRequired(first, cueId, true);

  const done = setCueStatus(required, cueId, 'done');
  assert.equal(done.lines[1].actionCues[0].status, 'done');
  assert.deepEqual(unresolvedRequiredCueIds(done), []);

  const skipped = setCueStatus(required, cueId, 'skipped');
  assert.equal(skipped.lines[1].actionCues[0].status, 'skipped');
  // Skipping is an honest record, not a resolution: wrap still sees it unresolved.
  assert.deepEqual(unresolvedRequiredCueIds(skipped), [cueId]);
});

test('cue required and status survive an edit to another line', () => {
  const first = parseScript('Say hello. [smile] Then pause.');
  const cueId = first.lines[1].actionCues[0].id;
  const marked = setCueStatus(setCueRequired(first, cueId, true), cueId, 'done');
  const edited = parseScript('Say hello there. [smile] Then pause.', marked);

  const cue = edited.lines[1].actionCues[0];
  assert.equal(cue.required, true);
  assert.equal(cue.status, 'done');
});

test('a saved draft restores text, line ids, order and cue statuses', () => {
  const first = parseScript('Say hello. [smile]\nWrap up.');
  const cueId = first.lines[1].actionCues[0].id;
  const marked = setCueStatus(setCueRequired(first, cueId, true), cueId, 'skipped');
  const removed = deleteLine(marked, marked.lines[2].id);

  const restored = restoreScriptDocument(removed.text, serializeScriptDocument(removed));
  assert.equal(restored.text, removed.text);
  assert.deepEqual(restored.lines.map(line => line.id), removed.lines.map(line => line.id));
  assert.deepEqual(restored.lines.map(line => line.spokenText), removed.lines.map(line => line.spokenText));
  assert.equal(restored.lines[1].actionCues[0].required, true);
  assert.equal(restored.lines[1].actionCues[0].status, 'skipped');
  assert.deepEqual(restored.removedLines.map(line => line.id), removed.removedLines.map(line => line.id));
  assert.deepEqual(scriptChangeIntent(removed, restored), {
    editedLineIds: [],
    deletedLineIds: [],
    addedLineIds: [],
  });
});

test('the raw draft text wins when the stored structure is missing or unreadable', () => {
  const text = 'Say hello. [smile]';
  for (const stored of [null, undefined, '', 'not json', '{"version":999}']) {
    const restored = restoreScriptDocument(text, stored);
    assert.equal(restored.text, text);
    assert.deepEqual(restored.lines.map(line => line.spokenText), ['Say hello.', '']);
  }
});

test('a stale stored structure never overrides the raw draft text', () => {
  const stale = parseScript('Old first line. Old second line.');
  const restored = restoreScriptDocument('Brand new only line.', serializeScriptDocument(stale));
  assert.equal(restored.text, 'Brand new only line.');
  assert.equal(restored.lines.length, 1);
  assert.equal(restored.lines[0].spokenText, 'Brand new only line.');
});

test('five thousand words parse in under 100 ms', () => {
  const text = Array.from({ length: 500 }, (_, i) => `Sentence ${i} with ten words in it right here now.`).join(' ');
  assert.equal(text.split(/\s+/).length, 5000);
  const started = performance.now();
  const document = parseScript(text);
  const elapsed = performance.now() - started;
  assert.equal(document.lines.length, 500);
  assert.equal(document.spokenWordCount, 5000);
  assert.ok(elapsed < 100, `parse took ${elapsed.toFixed(1)} ms`);
});

test('re-parsing a long script after one edit stays under 100 ms and keeps ids', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `Sentence ${i} with ten words in it right here now.`);
  const first = parseScript(lines.join(' '));
  const edited = [...lines];
  edited[250] = 'Sentence 250 was rewritten by the creator just now.';
  const started = performance.now();
  const second = parseScript(edited.join(' '), first);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 100, `re-parse took ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(second.lines.map(line => line.id), first.lines.map(line => line.id));
  assert.deepEqual(scriptChangeIntent(first, second).editedLineIds, [first.lines[250].id]);
});

test('the text handed to the camera route always chunks back into the same lines', () => {
  const pasted = 'This is the camera. [hold up the product] It records in 4K!\n[smile]\nAsk for the price? Now [wave';
  let document = parseScript(pasted);

  const ambiguousId = document.lines.at(-1).ambiguousCues[0].id;
  document = correctAmbiguousCue(document, ambiguousId, 'action');
  document = deleteLine(document, document.lines[1].id);
  document = reorderLines(document, [document.lines[1].id, document.lines[0].id, document.lines[2].id]);

  // camera.tsx receives only the raw string and re-chunks it with this regex.
  assert.deepEqual(cameraChunks(document.text), document.lines.map(line => line.text));
  assert.deepEqual(
    cameraChunks(document.text).map(text => parseScript(text).lines[0].spokenText),
    document.lines.map(line => line.spokenText),
  );
});
