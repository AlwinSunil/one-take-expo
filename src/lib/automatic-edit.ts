import type { Project, TranscriptSeg } from './session';
import { transcriptForSource } from './review-source.ts';
import { liveScriptCoverage } from '../features/capture/live-script.ts';
import { englishHardConflict, matchEnglish } from '../features/speech-analysis/alignment.ts';
import { transcriptFillerMarks, splitFillerText } from './transcript-fillers.ts';

export type AutoClip = {
  id: string; sourceId: string; t0: number; t1: number; included: boolean;
  label: string; lineId?: string; reason?: 'retake' | 'repeat' | 'silence' | 'filler';
  suggested?: boolean; manual?: boolean;
};
export type AutomaticEdit = { version: 1; sourceKeys: Record<string, string>; clips: AutoClip[] };
export type AudioEvidence = Record<string, { quiet: { t0: number; t1: number }[] }>;
export function editSources(project: Project) {
  const sources = project.videoUri ? [{ id: project.id, uri: project.videoUri, duration: project.duration ?? 0 }] : [];
  for (const recording of project.recordings ?? []) {
    if (!sources.some(source => source.uri === recording.mediaUri)) sources.push({ id: recording.id, uri: recording.mediaUri, duration: recording.duration });
  }
  return sources;
}
const speechWithoutFillers = (text: string) => splitFillerText(text).filter(part => !part.isFiller).map(part => part.text).join(' ');
const tokens = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function sourceEditKey(project: Project, source: ReturnType<typeof editSources>[number]) {
  return JSON.stringify(['ranked-takes-and-timed-labels-v4', source.duration, transcriptForSource(project, source.uri).map(s => [s.id, s.t0, s.t1, s.text, s.words, s.wordTimingSource, s.timingSource]), project.script, project.scriptLines, project.semanticMatches]);
}
export function automaticEditCurrent(project: Project) {
  return !!project.automaticEdit && Object.keys(project.automaticEdit.sourceKeys).length === editSources(project).length && editSources(project).every(source => project.automaticEdit!.sourceKeys[source.id] === sourceEditKey(project, source));
}

/** Every exclusion is retained as a reversible source interval; preview and export share the same included rows. */
export function buildAutomaticEdit(project: Project, audio: AudioEvidence = {}): AutomaticEdit {
  const lines = project.scriptLines?.filter(line => line.spokenText.trim()) ?? [];
  const sourceKeys: Record<string, string> = {};
  const clips: AutoClip[] = [];
  const observations: { sourceId: string; segment: TranscriptSeg; lineId?: string; complete: boolean; score: number }[] = [];
  for (const source of editSources(project)) {
    sourceKeys[source.id] = sourceEditKey(project, source);
    if (!(source.duration > 0)) continue;
    const segments = transcriptForSource(project, source.uri).filter(s => s.isFinal !== false && Number.isFinite(s.t0) && Number.isFinite(s.t1) && s.t1 > s.t0 && s.t0 < source.duration);
    const removals: { t0: number; t1: number; label?: string; reason: AutoClip['reason']; suggested?: boolean }[] = [];
    for (const quiet of audio[source.id]?.quiet ?? (source.id === project.id ? project.quietIntervals ?? [] : [])) {
      if (!Number.isFinite(quiet.t0) || !Number.isFinite(quiet.t1) || quiet.t1 - quiet.t0 < 1.2) continue;
      let gaps = [{ t0: Math.max(0, quiet.t0 + 0.16), t1: Math.min(source.duration, quiet.t1 - 0.16) }];
      for (const segment of segments) {
        if (segment.wordTimingSource !== 'saved-audio' && segment.timingSource !== 'saved-audio') continue;
        for (const word of segment.words ?? []) {
          if (!Number.isFinite(word.t0) || !Number.isFinite(word.t1) || word.t1 <= word.t0 || word.confidence < 0.8
            || !splitFillerText(word.text).some(part => !part.isFiller && /[\p{L}\p{N}]/u.test(part.text))) continue;
          gaps = gaps.flatMap(gap => word.t1 <= gap.t0 || word.t0 >= gap.t1 ? [gap] : [
            ...(word.t0 > gap.t0 ? [{ t0: gap.t0, t1: word.t0 }] : []),
            ...(word.t1 < gap.t1 ? [{ t0: word.t1, t1: gap.t1 }] : []),
          ]);
        }
      }
      removals.push(...gaps.filter(gap => gap.t1 > gap.t0).map(gap => ({ ...gap, reason: 'silence' as const })));
    }
    const usedWords = new Set<object>();
    for (const mark of transcriptFillerMarks(segments.map(segment => ({ ...segment, manualCorrection: undefined, correctedText: undefined })), source.duration)) {
      const segment = segments.find((s, index) => (s.id ?? `segment-${index}`) === mark.segmentId) ?? segments.find(s => s.t0 <= mark.t0 && s.t1 >= mark.t1);
      const fillerOnly = !!segment && !splitFillerText(segment.text).some(part => !part.isFiller && /[\p{L}\p{N}]/u.test(part.text));
      const timedWords = segment?.wordTimingSource === 'saved-audio' || segment?.timingSource === 'saved-audio' ? segment.words : undefined;
      const word = timedWords?.filter(word => !usedWords.has(word) && tokens(word.text) === tokens(mark.label) && word.confidence >= 0.8 && word.t1 > word.t0 && word.t0 >= segment!.t0 && word.t1 <= segment!.t1)
        .sort((a, b) => Math.abs(a.t0 - mark.t0) - Math.abs(b.t0 - mark.t0))[0];
      if (word) usedWords.add(word);
      let ranges = [{ t0: fillerOnly ? segment!.t0 : word?.t0 ?? mark.t0, t1: fillerOnly ? segment!.t1 : word?.t1 ?? mark.t1 }];
      // Live estimates can overlap the preceding sentence; a filler must not erase those words.
      for (const other of segments) {
        if (other === segment || !splitFillerText(other.text).some(part => !part.isFiller && /[\p{L}\p{N}]/u.test(part.text))) continue;
        ranges = ranges.flatMap(range => other.t1 <= range.t0 || other.t0 >= range.t1 ? [range] : [
          ...(other.t0 > range.t0 ? [{ t0: range.t0, t1: other.t0 }] : []),
          ...(other.t1 < range.t1 ? [{ t0: other.t1, t1: range.t1 }] : []),
        ]);
      }
      removals.push(...ranges.map(range => ({ ...range, reason: 'filler' as const, label: mark.label, suggested: !fillerOnly && !word })));
    }
    for (const segment of segments) {
      const eligible = new Set(project.takes?.filter(take => take.mediaUri === source.uri).flatMap(take => take.eligibleLineIds ?? []) ?? []);
      const candidates = eligible.size ? lines.filter(line => eligible.has(line.id)) : lines;
      const matches = candidates.map(line => ({ id: line.id, match: matchEnglish(line.spokenText, speechWithoutFillers(segment.text)) })).sort((a, b) => b.match.score - a.match.score);
      const best = matches[0];
      const semantic = project.semanticMatches?.find(match => match.segmentId === segment.id && match.text === segment.text && candidates.some(line => line.id === match.lineId));
      const lineId = semantic?.lineId ?? (best && best.match.verdict !== 'mismatch' && best.match.score >= 0.6 ? best.id : undefined);
      const fillerCount = splitFillerText(segment.text).filter(p => p.isFiller).length;
      const speed = speechWithoutFillers(segment.text).trim().split(/\s+/).length / (segment.t1 - segment.t0);
      const timedWords = segment.wordTimingSource === 'saved-audio' || segment.timingSource === 'saved-audio' ? segment.words ?? [] : [];
      const confidence = timedWords.filter(word => Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 1);
      const uncertainty = confidence.length ? 1 - confidence.reduce((sum, word) => sum + word.confidence, 0) / confidence.length : 0;
      const pauses = (audio[source.id]?.quiet ?? []).reduce((sum, quiet) => sum + Math.max(0, Math.min(segment.t1, quiet.t1) - Math.max(segment.t0, quiet.t0)), 0);
      observations.push({ sourceId: source.id, segment, lineId, complete: semantic ? semantic.verdict === 'complete' : best?.match.verdict === 'matched', score: (semantic?.verdict === 'complete' ? 1 : best?.match.score ?? 0.5) - fillerCount * 0.12 - (speed > 5.5 || speed < 0.7 ? 0.15 : 0) - uncertainty * 0.2 - Math.min(0.2, pauses / (segment.t1 - segment.t0) * 0.2) });
    }
    const oldSource = project.automaticEdit?.clips.filter(clip => clip.sourceId === source.id);
    const manual = oldSource?.filter(clip => clip.manual) ?? [];
    const finalizedSource = project.recordings?.some(recording => recording.mediaUri === source.uri && recording.completionPayload !== undefined);
    const sourceHasReviewRows = project.reviewSegments?.some(cut => cut.uri === source.uri);
    const recoveredSpeech = oldSource?.flatMap(clip => {
      if (clip.manual || clip.included || clip.reason !== 'silence') return [];
      return segments.flatMap(segment => segment.wordTimingSource === 'saved-audio' || segment.timingSource === 'saved-audio' ? (segment.words ?? []).filter(word =>
        Number.isFinite(word.t0) && Number.isFinite(word.t1) && Number.isFinite(word.confidence) && word.confidence >= 0.8
        && word.t0 >= segment.t0 && word.t1 <= segment.t1 && word.t1 > word.t0
        && splitFillerText(word.text).some(part => !part.isFiller && /[\p{L}\p{N}]/u.test(part.text))
        && word.t0 < clip.t1 && word.t1 > clip.t0).map(word => ({ t0: Math.max(clip.t0, word.t0), t1: Math.min(clip.t1, word.t1) })) : []);
    }) ?? [];
    const kept = oldSource?.length ? [...oldSource.filter(clip => clip.included || (!clip.manual && (clip.reason === 'filler' || clip.reason === 'repeat'))), ...recoveredSpeech] : project.reviewSegments !== undefined && (!project.automaticEdit || source.id in project.automaticEdit.sourceKeys || finalizedSource || sourceHasReviewRows)
      ? project.reviewSegments.filter(cut => cut.uri === source.uri)
      : source.id === project.id ? project.cuts ?? (project.trim ? [{ t0: project.trim.start, t1: project.trim.end }] : undefined) : undefined;
    const boundaries = [...new Set([0, source.duration, ...segments.flatMap(s => [s.t0, s.t1]), ...removals.flatMap(s => [s.t0, s.t1]), ...(kept ?? []).flatMap(s => [s.t0, s.t1]), ...manual.flatMap(s => [s.t0, s.t1])].filter(Number.isFinite).map(t => Math.max(0, Math.min(source.duration, t))))].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const t0 = boundaries[i], t1 = boundaries[i + 1];
      if (t1 - t0 < 0.001) continue;
      const midpoint = (t0 + t1) / 2;
      const speech = observations.find(o => o.sourceId === source.id && midpoint >= o.segment.t0 && midpoint < o.segment.t1);
      const override = manual.find(c => midpoint >= c.t0 && midpoint < c.t1);
      const removal = removals.find(r => midpoint >= r.t0 && midpoint < r.t1);
      const previousClip = oldSource?.find(clip => midpoint >= clip.t0 && midpoint < clip.t1);
      const excluded = kept !== undefined && !kept.some(cut => midpoint >= cut.t0 && midpoint < cut.t1);
      clips.push({ id: `${source.id}:${t0.toFixed(4)}:${t1.toFixed(4)}`, sourceId: source.id, t0, t1,
        included: override?.included ?? (!excluded && (!removal || !!removal.suggested)), manual: override ? true : undefined,
        label: removal?.label ?? speech?.segment.text ?? 'Pause', lineId: speech?.lineId,
        reason: excluded ? previousClip?.reason ?? 'retake' : removal?.reason, suggested: !override && !excluded && removal?.suggested });
    }
  }
  // A sub-frame pause left after the final cut can contain audio but no video sample.
  for (const source of editSources(project)) {
    const tail = clips.find(clip => clip.sourceId === source.id && clip.t1 === source.duration);
    if (tail && !tail.manual && tail.included && !tail.lineId && tail.label === 'Pause' && tail.t1 - tail.t0 < 0.04
      && clips.some(clip => clip.sourceId === source.id && clip.t1 === tail.t0 && !clip.included)) {
      tail.included = false; tail.reason = 'silence';
    }
  }
  // Compare delivery within a script line, or a substantial repeated utterance. Never compare single generic words.
  const groups: (typeof observations)[] = [];
  const equivalent = (a: typeof observations[number], b: typeof observations[number]) => {
    const aTokens = new Set(tokens(speechWithoutFillers(a.segment.text)).split(' '));
    const bTokens = new Set(tokens(speechWithoutFillers(b.segment.text)).split(' '));
    const overlap = [...aTokens].filter(token => bTokens.has(token)).length / Math.max(1, Math.min(aTokens.size, bTokens.size));
    if (overlap >= 0.75 && (englishHardConflict(a.segment.text, b.segment.text) || englishHardConflict(b.segment.text, a.segment.text))) return false;
    if (a.complete && b.complete && a.lineId && b.lineId) return a.lineId === b.lineId;
    if (a.lineId && b.lineId && a.lineId !== b.lineId) return false;
    const first = speechWithoutFillers(a.segment.text), second = speechWithoutFillers(b.segment.text);
    if (Math.min(tokens(first).split(' ').length, tokens(second).split(' ').length) < 3) return false;
    return tokens(first) === tokens(second) || (matchEnglish(first, second).verdict === 'matched' && matchEnglish(second, first).verdict === 'matched');
  };
  for (const observation of observations) {
    const parts = clips.filter(c => c.sourceId === observation.sourceId && c.t0 < observation.segment.t1 && c.t1 > observation.segment.t0);
    if (!parts.some(c => c.included) || parts.some(c => !c.included && (c.manual || (c.reason !== 'filler' && c.reason !== 'silence')))) continue;
    const group = groups.find(group => group.every(other => equivalent(observation, other)));
    if (group) group.push(observation); else groups.push([observation]);
  }
  for (const group of groups) {
    if (group.length < 2) continue;
    const best = [...group].sort((a, b) => Number(b.complete) - Number(a.complete) || b.score - a.score || observations.indexOf(b) - observations.indexOf(a))[0];
    const coveredLines = (observation: typeof best) => new Set([
      ...(observation.complete && observation.lineId ? [observation.lineId] : []),
      ...lines.filter(line => ` ${tokens(observation.segment.text)} `.includes(` ${tokens(line.spokenText)} `)
        || observation.segment.text.split(/[.!?;]+/).some(clause => matchEnglish(line.spokenText, clause).verdict === 'matched')).map(line => line.id),
    ]);
    const winnerCoverage = coveredLines(best);
    for (const weaker of group.filter(item => item !== best)) {
      // An endpointed utterance can cover several lines; repeating one must not erase the others.
      if ([...coveredLines(weaker)].some(lineId => !winnerCoverage.has(lineId))) continue;
      for (const clip of clips) if (clip.sourceId === weaker.sourceId && clip.t0 >= weaker.segment.t0 && clip.t1 <= weaker.segment.t1 && !clip.manual && (best.sourceId !== clip.sourceId || clip.t1 <= best.segment.t0 || clip.t0 >= best.segment.t1) && (clip.included || clip.reason === 'filler')) {
        clip.included = false; clip.reason = 'repeat'; clip.suggested = false;
      }
    }
  }
  // Pickups are placed at their script position, with removed attempts kept beside the replacement for restore.
  if (editSources(project).length > 1 && lines.length) {
    const order = new Map(lines.map((line, i) => [line.id, i]));
    const position = (clip: AutoClip) => clip.lineId ? order.get(clip.lineId) ?? lines.length : (() => {
      const next = clips.find(c => c.sourceId === clip.sourceId && c.t0 >= clip.t1 && c.lineId);
      return next?.lineId ? (order.get(next.lineId) ?? lines.length) - 0.01 : lines.length;
    })();
    const positions = new Map(clips.map(c => [c.id, position(c)]));
    clips.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  }
  const previous = new Map(project.automaticEdit?.clips.filter(c => c.manual).map(c => [c.id, c]));
  for (const clip of clips) if (previous.has(clip.id)) { clip.included = previous.get(clip.id)!.included; clip.manual = true; }
  return { version: 1, sourceKeys, clips };
}
export function applyAutomaticEdit(project: Project, automaticEdit: AutomaticEdit): Project {
  const sources = new Map(editSources(project).map(source => [source.id, source]));
  const reviewSegments: NonNullable<Project['reviewSegments']> = [];
  for (const clip of automaticEdit.clips.filter(clip => clip.included)) {
    const source = sources.get(clip.sourceId);
    if (!source || !Number.isFinite(clip.t0) || !Number.isFinite(clip.t1) || clip.t0 < 0 || clip.t1 > source.duration || clip.t1 <= clip.t0) throw new Error('An edit is outside its recording.');
    const previous = reviewSegments.at(-1);
    if (previous?.uri === source.uri && Math.abs(previous.t1 - clip.t0) < 0.001) previous.t1 = clip.t1;
    else reviewSegments.push({ uri: source.uri, t0: clip.t0, t1: clip.t1 });
  }
  return { ...project, automaticEdit, reviewSegments, cuts: undefined, cutsReviewed: true };
}

export function automaticMissingLines(project: Project) {
  const lines = project.scriptLines?.filter(line => line.spokenText.trim()) ?? [];
  const clips = project.automaticEdit?.clips ?? [];
  const retained = editSources(project).flatMap(source => transcriptForSource(project, source.uri).filter(segment => {
    const overlapping = clips.filter(clip => clip.sourceId === source.id && clip.t0 < segment.t1 && clip.t1 > segment.t0);
    return overlapping.some(clip => clip.included) && !overlapping.some(clip => !clip.included && (clip.manual || (clip.reason !== 'filler' && clip.reason !== 'silence')));
  }).map(segment => ({ ...segment, id: segment.id ?? `${source.id}:${segment.t0}:${segment.t1}`, isFinal: segment.isFinal !== false })));
  const coverage = liveScriptCoverage(lines, retained, project.semanticMatches);
  return lines.filter(line => coverage.find(item => item.lineId === line.id)?.status !== 'covered');
}
