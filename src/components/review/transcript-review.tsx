import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import captions from '../../../modules/one-take-captions';
import type { Project } from '@/lib/session';
import { projectReview, projectScriptLines, replaceWithRefined } from '@/lib/project-workflow';
import { excludeInterval } from '@/lib/review-cuts';
import { restoreDecision, selectTake } from '@/lib/transcript-workflow';

export function TranscriptReview({ project, onChange, onSeek, duration }: {
  project: Project; onChange: (p: Project) => Promise<void>; onSeek: (t: number) => void; duration?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [original, setOriginal] = useState(false);
  const latest = useRef(project);
  latest.current = project;
  const refinementId = useRef<string | null>(null);
  const quietIntervals = useRef<Project['quietIntervals']>(undefined);
  const review = useMemo(() => projectReview(project), [project]);
  const sourceDuration = [duration, project.duration].find(value =>
    typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  const rawTranscript = project.rawTranscript ?? project.transcript.map(segment => ({
    ...segment,
    text: segment.rawText ?? segment.text,
  }));

  useEffect(() => {
    const listener = captions?.addListener('onRefinement', event => {
      if (event.id === refinementId.current) {
        setProgress(event.progress);
        if (event.quietIntervals) quietIntervals.current = event.quietIntervals;
      }
    });
    return () => {
      listener?.remove();
      if (refinementId.current) void captions?.cancelRefinement(refinementId.current);
      refinementId.current = null;
    };
  }, []);

  async function change(next: Project) {
    latest.current = next;
    try { await onChange(next); return true; }
    catch (e) { setMessage(`Could not save: ${e instanceof Error ? e.message : String(e)}`); return false; }
  }

  async function refine(model: 'tiny' | 'small' = 'tiny') {
    if (!captions || !project.videoUri || refinementId.current) return;
    const id = `${project.id}:${Date.now()}`;
    refinementId.current = id;
    quietIntervals.current = undefined;
    setProgress(0); setMessage('');
    const modelName = `Moonshine ${model === 'tiny' ? 'Tiny' : 'Small'} Streaming`;
    if (!await change({ ...latest.current, refinement: { status: 'running', model: modelName } })) {
      refinementId.current = null; setProgress(null); return;
    }
    try {
      const segments = await captions.refine(id, project.videoUri, model);
      if (refinementId.current !== id) return;
      const current = latest.current;
      const refined = replaceWithRefined(current, segments);
      const retainedCurrentTimeline = refined.transcript === current.transcript;
      if (!await change({ ...refined, quietIntervals: quietIntervals.current, refinement: { status: 'ready', model: modelName } })) return;
      setMessage(retainedCurrentTimeline
        ? (segments.length
          ? 'Saved audio rechecked. Your annotated transcript was kept; the new recognition result is shown below for comparison.'
          : 'Saved audio rechecked, but no captions were returned. Your current transcript was kept.')
        : 'Saved audio rechecked. Review the result; better accuracy is not guaranteed. Your manual corrections were preserved. The full new transcript is available below for comparison.');
    } catch (e) {
      if (refinementId.current !== id) return;
      const error = e instanceof Error ? e.message : 'Could not recheck captions.';
      await change({ ...latest.current, refinement: { status: 'failed', error, model: modelName } });
      setMessage(error);
    } finally {
      if (refinementId.current === id) { refinementId.current = null; setProgress(null); }
    }
  }

  return <View className="border-t border-neutral-800 mt-3">
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(v => !v)} className="py-3">
      <Text className="text-white font-semibold">Captions and coverage · {expanded ? 'Hide' : 'Show'}</Text>
    </Pressable>
    {expanded && <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
      {!!project.recoveryMessage && <Text className="text-amber-200 text-xs mb-3">{project.recoveryMessage}</Text>}
      <View className="flex-row flex-wrap gap-2 mb-3">
        <Pressable disabled={!captions || project.mediaMissing || progress !== null} onPress={() => refine()} className="bg-neutral-800 rounded-lg p-3 disabled:opacity-40">
          <Text className="text-white text-xs">Recheck saved audio</Text>
        </Pressable>
        {__DEV__ && <Pressable disabled={!captions || project.mediaMissing || progress !== null} onPress={() => refine('small')} className="p-3 disabled:opacity-40"><Text className="text-neutral-200 text-xs">Compare Small · experimental</Text></Pressable>}
        {progress !== null && <Pressable onPress={async () => {
          const id = refinementId.current;
          refinementId.current = null; setProgress(null);
          if (id) await captions?.cancelRefinement(id);
          await change({ ...latest.current, refinement: { status: 'cancelled', model: 'Moonshine Tiny Streaming' } });
        }} className="p-3"><Text className="text-white text-xs">Cancel · {Math.round(progress * 100)}%</Text></Pressable>}
        <Pressable onPress={() => setOriginal(v => !v)} className="p-3"><Text className="text-neutral-200 text-xs">{original ? 'Hide raw text' : 'Show raw text'}</Text></Pressable>
        {project.rawTranscript && <Pressable onPress={() => change({ ...latest.current, transcript: latest.current.rawTranscript!, rawTranscript: latest.current.transcript, reviewDecisions: latest.current.previousReviewDecisions, previousReviewDecisions: latest.current.reviewDecisions, cutsReviewed: false })} className="p-3"><Text className="text-white text-xs">Restore previous transcript</Text></Pressable>}
      </View>
      <Text className="text-neutral-400 text-xs mb-3">Rechecking works offline on recordings up to five minutes. Live caption timing is approximate until rechecked against saved audio.</Text>
      {!project.transcript.length && <Text className="text-neutral-300 text-sm mb-3">No speech transcript was saved. Recheck the recording or retain the original video.</Text>}
      {project.refinementCandidate && <View className="mb-3">
        <Text className="text-neutral-400 text-xs">Latest recognition result before preserving your edits</Text>
        <Text selectable className="text-neutral-200 text-sm">{project.refinementCandidate.map(s => s.text).join(' ')}</Text>
      </View>}
      {original && <View className="mb-3 bg-neutral-950 rounded-lg p-3">
        <Text className="text-neutral-400 text-xs mb-2">Previous raw transcript</Text>
        {rawTranscript.length ? rawTranscript.map((segment, index) => <View key={`${segment.id ?? 'raw'}:${index}`} className="mb-2">
          <Text className="text-neutral-500 text-xs">{segment.t0.toFixed(1)}s – {segment.t1.toFixed(1)}s</Text>
          <Text selectable className="text-neutral-200 text-sm">{segment.rawText ?? segment.text}</Text>
        </View>) : <Text className="text-neutral-300 text-sm">No raw transcript was saved.</Text>}
      </View>}
      {project.transcript.map((segment, index) => <View key={segment.id ?? index} className="mb-3">
        <Pressable disabled={project.mediaMissing} onPress={() => onSeek(segment.t0)} className="py-2">
          <Text className="text-neutral-400 text-xs">{segment.t0.toFixed(1)}s – {segment.t1.toFixed(1)}s · {segment.isFinal === false ? 'Draft' : 'Caption'}</Text>
        </Pressable>
        {/\b(um+|uh+|erm|hmm)\b/i.test(segment.text) && <Text className="text-amber-200 text-xs mb-1">A possible filler appears in the transcript. Listen to confirm; mid-sentence removal stays off.</Text>}
        <Pressable className="py-2" onPress={() => change({ ...latest.current, transcript: latest.current.transcript.map((s, i) => (segment.id ? s.id === segment.id : i === index) ? { ...s, needsListening: !s.needsListening } : s) })}>
          <Text className="text-neutral-400 text-xs">{segment.needsListening ? 'Marked unclear · listen and unmark' : 'Mark unclear speech for review'}</Text>
        </Pressable>
        <TextInput key={`${segment.id}:${segment.revision ?? 0}`} multiline accessibilityLabel={`Edit caption ${index + 1}`}
          value={segment.manualCorrection ?? segment.correctedText ?? segment.text}
          className="text-white bg-neutral-900 rounded-lg p-3"
          onChangeText={text => {
            const current = latest.current;
            void change({ ...current, captionRevision: (current.captionRevision ?? 0) + 1,
              transcript: current.transcript.map((s, i) => (segment.id ? s.id === segment.id : i === index) ? { ...s, manualCorrection: text } : s) });
          }} />
      </View>)}
      {review.lines.map(line => <View key={line.id} className="border-t border-neutral-800 py-3">
        <Text className="text-white text-sm">{line.spokenText}</Text>
        <Text className="text-neutral-300 text-xs mt-1">{line.status} · {line.candidateTakeIds.length} matching takes</Text>
        {line.pendingReasons.map(reason => <Text key={reason} className="text-amber-200 text-xs">{reason}</Text>)}
        {projectScriptLines(project).find(item => item.id === line.id)?.actionCues.map(cue => <View key={cue.id} className="flex-row flex-wrap">
          <Pressable className="p-3" onPress={() => change({ ...latest.current, scriptLines: projectScriptLines(latest.current).map(item => item.id === line.id ? { ...item, actionCues: item.actionCues.map(c => c.id === cue.id ? { ...c, required: !c.required } : c) } : item) })}>
            <Text className="text-neutral-200 text-xs">{cue.text} · {cue.required ? 'Required' : 'Optional'}</Text>
          </Pressable>
          <Pressable className="p-3" onPress={() => change({ ...latest.current, scriptLines: projectScriptLines(latest.current).map(item => item.id === line.id ? { ...item, actionCues: item.actionCues.map(c => c.id === cue.id ? { ...c, resolved: !c.resolved } : c) } : item) })}>
            <Text className="text-white text-xs">{cue.resolved ? 'Confirmed · undo' : 'Confirm action done'}</Text>
          </Pressable>
        </View>)}
        <View className="flex-row flex-wrap">
          {line.candidateTakeIds.map(id => {
            const take = review.takes.find(t => t.id === id);
            const playable = !!take && take.playable && !project.mediaMissing
              && typeof take.mediaUri === 'string' && take.mediaUri.trim().length > 0;
            return <Pressable key={id} disabled={!playable} className="p-3 disabled:opacity-40" onPress={async () => {
              if (!take || !playable) return;
              onSeek(take.t0);
              await change({ ...latest.current,
                reviewDecisions: selectTake(latest.current.reviewDecisions ?? [], line.id, id, review.takes),
                cutsReviewed: false,
              });
            }}><Text className="text-white text-xs">{playable ? (line.selectedTakeId === id ? 'Selected' : 'Choose') : 'Unavailable'} · {take ? `${take.t0.toFixed(1)}s` : 'unknown'}</Text></Pressable>;
          })}
        </View>
      </View>)}
      {!!review.lines.length && <Pressable className="py-3" onPress={() => {
        const ids = [...new Set(review.lines.flatMap(line => line.selectedTakeId ? [line.selectedTakeId] : []))];
        const cuts = ids.map(id => review.takes.find(t => t.id === id)!).map(t => ({ t0: t.t0, t1: t.t1 }));
        if (!cuts.length) { setMessage('No covered takes are available yet.'); return; }
        Alert.alert('Review cut boundaries', 'Speech timestamps are estimates. Listen to every cut and adjust its boundaries before accepting it for export. Your original video remains available.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Prepare review cuts', onPress: () => { void change({ ...latest.current, cuts, cutsReviewed: false }); } },
        ]);
      }}><Text className="text-white text-sm">Prepare selected takes in script order</Text></Pressable>}
      {(project.cuts ?? []).map((cut, index) => <View key={index} className="border-t border-neutral-800 py-2">
        <Pressable className="py-2" onPress={() => onSeek(cut.t0)}><Text className="text-white text-xs">Review cut {index + 1}</Text></Pressable>
        <View className="flex-row gap-3">
          {(['t0', 't1'] as const).map(boundary => <TextInput key={`${boundary}:${cut[boundary]}`} keyboardType="decimal-pad"
            accessibilityLabel={`Cut ${index + 1} ${boundary === 't0' ? 'start' : 'end'} seconds`}
            defaultValue={cut[boundary].toFixed(2)} className="text-white bg-neutral-800 rounded p-2 flex-1"
            onEndEditing={e => {
              const value = Number(e.nativeEvent.text);
              const next = { ...cut, [boundary]: value };
              const exceedsDuration = sourceDuration !== undefined && (next.t0 > sourceDuration || next.t1 > sourceDuration);
              if (!Number.isFinite(value) || next.t0 < 0 || next.t1 <= next.t0 || exceedsDuration) {
                setMessage('Enter valid start/end seconds inside the recording.'); return;
              }
              void change({ ...latest.current, cutsReviewed: false, cuts: latest.current.cuts?.map((c, i) => i === index ? next : c) });
            }} />)}
        </View>
      </View>)}
      {!!project.cuts?.length && <View className="flex-row flex-wrap">
        <Pressable className="py-3 pr-3" onPress={() => change({ ...latest.current, cutsReviewed: true })}><Text className="text-white text-xs">{project.cutsReviewed ? 'Cuts accepted' : 'I reviewed every cut · accept'}</Text></Pressable>
        <Pressable className="py-3" onPress={() => change({ ...latest.current, cuts: undefined, cutsReviewed: false })}><Text className="text-white text-xs">Undo cuts · use original trim</Text></Pressable>
      </View>}
      {review.suggestions.map(suggestion => <View key={suggestion.id} className="py-3">
        <Pressable onPress={() => onSeek(Math.max(0, suggestion.t0 - 0.5))} className="py-2">
          <Text className="text-amber-200 text-xs">{suggestion.reason} Listen before making any trim.</Text>
        </Pressable>
        <Pressable className="py-2" onPress={() => {
          const current = latest.current;
          const effectiveDuration = sourceDuration ?? current.duration;
          if (!effectiveDuration || !Number.isFinite(effectiveDuration) || effectiveDuration <= 0) { setMessage('Recording duration is unavailable. Keep the original.'); return; }
          Alert.alert('Prepare a removal for review?', 'This candidate may contain quiet speech or uncertain boundaries. The result needs playback and boundary review before export.', [
            { text: 'Keep original', style: 'cancel' }, { text: 'Prepare review', onPress: () => {
              const removal = suggestion.kind === 'repeated-attempt' ? current.transcript.find(s => s.id === suggestion.segmentIds[0]) : suggestion;
              if (!removal) { setMessage('This suggestion is no longer available.'); return; }
              const trimEnd = current.trim?.end;
              const fallbackEnd = typeof trimEnd === 'number' && Number.isFinite(trimEnd) && trimEnd > 0 ? trimEnd : effectiveDuration;
              const cuts = excludeInterval(current.cuts?.length ? current.cuts : [{ t0: current.trim?.start ?? 0, t1: fallbackEnd }], removal);
              if (!cuts.length) { setMessage('That would remove the entire recording.'); return; }
              void change({ ...latest.current, cuts, cutsReviewed: false });
            } },
          ]);
        }}><Text className="text-white text-xs">{suggestion.kind === 'repeated-attempt' ? 'Keep latest repeat · review removal of earlier take' : 'Prepare removal · review required'}</Text></Pressable>
      </View>)}
      {(project.reviewDecisions ?? []).map(decision => <Pressable key={decision.id} onPress={() => change({ ...latest.current,
        cutsReviewed: decision.type === 'take-selection' ? false : latest.current.cutsReviewed,
        reviewDecisions: restoreDecision(latest.current.reviewDecisions ?? [], decision.id) })} className="py-3">
        <Text className="text-white text-xs">Undo take choice</Text>
      </Pressable>)}
      {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-xs py-3">{message}</Text>}
    </ScrollView>}
  </View>;
}
