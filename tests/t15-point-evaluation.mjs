/** Synthetic diagnostic, not held-out human semantic/STT acceptance. */
import { parseScript } from '../src/lib/script-lines.ts';
import { suggestImportantPoints } from '../src/features/speech-analysis/important-points.ts';
import { matchEnglish } from '../src/features/speech-analysis/alignment.ts';
const matching = [
  ['The guide will show the result.', 'The guide will demonstrate the outcome.', true],
  ['We start the camera.', 'We begin the camera.', true],
  ['We keep the original video.', 'We preserve the original video.', true],
  ['Save the clip on your device.', 'Store the clip locally.', true],
  ['You can review the recording before sharing it.', 'Before you share, you can check the recording.', true],
  ['Alice saves twelve videos.', 'Bob saves twelve videos.', false],
  ['We keep audio and video.', 'We keep audio or video.', false],
  ['We will upload the video.', 'We might upload the video.', false],
  ['We do not upload recordings.', 'We upload recordings.', false],
  ['We record in 4K.', 'We record in 1080p.', false],
  ['The clip lasts 1.5 seconds.', 'The clip lasts 15 seconds.', false],
  ['I pay you.', 'You pay me.', false],
].map(([script, spoken, expectedMatch]) => ({ script, spoken, expectedMatch, actual: matchEnglish(script, spoken) }));
const salience = [
  ['Welcome to this video. The recording stays on your device. Thank you for watching.', [false, true, false]],
  ['The price is twelve dollars. Shipping is not included.', [true, true]],
  ['Hello! We preserve the original recording. See you next time.', [false, true, false]],
].flatMap(([script, labels]) => suggestImportantPoints(parseScript(script), 'evaluation:1').map((point, index) => ({ text: point.text, expectedImportant: labels[index], suggestedImportant: point.importance === 'important', reason: point.reason })));
const report = {
  provenance: { origin: 'synthetic', referenceAuthor: 'agent-authored diagnostic labels', humanRows: 0, sttExecuted: false, modelAdded: false, eligibleForHumanAcceptance: false },
  matching: { cases: matching.length, expectedMatches: matching.filter(row => row.expectedMatch).length, falseMatches: matching.filter(row => !row.expectedMatch && row.actual.verdict === 'matched').length, missedMatches: matching.filter(row => row.expectedMatch && row.actual.verdict !== 'matched').length, rows: matching },
  extraction: { cases: salience.length, falseImportant: salience.filter(row => !row.expectedImportant && row.suggestedImportant).length, missedImportant: salience.filter(row => row.expectedImportant && !row.suggestedImportant).length, rows: salience },
  limits: ['Small synthetic diagnostic only.', 'Extractive baseline overselects complete lines; creator review remains required.', 'Reordered and unlisted paraphrases may remain unresolved.', 'Real-read matching and line-end-to-visible-advance latency are unmeasured.'],
};
console.log(JSON.stringify(report, null, 2));
if (report.matching.falseMatches) process.exitCode = 1;
