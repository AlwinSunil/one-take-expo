import { useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { launchProjectPickup } from '@/features/capture/project-handoff';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import captions from '../../../modules/one-take-captions';
import type { Project } from '@/lib/session';
import { projectScriptLines, replaceWithRefined, toggleCaptionListening } from '@/lib/project-workflow';
import { cleanReview, selectedReviewSegments, pickupLineIds } from '@/lib/clean-review';
import { hasMultipleRecordingSources, transcriptForSource } from '@/lib/review-source';
import { excludeInterval } from '@/lib/review-cuts';
import { listProjects, mergePickupProject } from '@/lib/store';
import { restoreDecision, selectTake } from '@/lib/transcript-workflow';

export function TranscriptReview({ project, onChange, onSeek, onPreviewTake, onPreviewRecording, duration }: {
  project: Project; onChange: (p: Project) => Promise<void>; onSeek: (t: number) => void; onPreviewTake?: (takeId: string) => void; onPreviewRecording?: (uri: string, duration: number) => void; duration?: number;
}) {
  const [pickupChoices, setPickupChoices] = useState<Project[]>([]);
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showCaptions, setShowCaptions] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [openCaption, setOpenCaption] = useState<string | null>(null);
  const [openLine, setOpenLine] = useState<string | null>(null);
  const latest = useRef(project);
  latest.current = project;
  const refinementId = useRef<string | null>(null);
  const quietIntervals = useRef<Project['quietIntervals']>(undefined);
  const review = useMemo(() => cleanReview(project), [project]);
  const sourceDuration = [duration, project.duration].find(value =>
    typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  const multiSource = hasMultipleRecordingSources(project);
  const rawTranscript = project.rawTranscript ?? project.transcript.map(segment => ({
    ...segment,
    text: segment.rawText ?? segment.text,
  }));

  const covered = review.lines.filter(line => line.spokenText.trim() && line.selectedTakeId).length;
  const totalLines = review.lines.filter(line => line.spokenText.trim()).length;
  const isScript = project.mode === 'script' && review.lines.length > 0;
  const pickupIds = pickupLineIds(review);
  const rechecking = progress !== null;

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
    if (hasMultipleRecordingSources(latest.current)) { setMessage('Rechecking multiple recordings is not supported yet. Edit individual captions or attach a replacement take.'); return; }
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
      if (hasMultipleRecordingSources(current)) { await change({ ...current, refinement: { status: 'cancelled', model: modelName } }); setMessage('A pickup was attached during recheck. The existing captions were preserved.'); return; }
      const refined = replaceWithRefined(current, segments);
      const retainedCurrentTimeline = refined.transcript === current.transcript;
      if (!await change({ ...refined, quietIntervals: quietIntervals.current, refinement: { status: 'ready', model: modelName } })) return;
      setMessage(retainedCurrentTimeline
        ? (segments.length
          ? 'Saved audio rechecked. Your annotated transcript was kept; the new result is under History.'
          : 'Saved audio rechecked, but no captions were returned. Your current transcript was kept.')
        : 'Saved audio rechecked. Review the result; better accuracy is not guaranteed. Manual corrections were preserved.');
    } catch (e) {
      if (refinementId.current !== id) return;
      const error = e instanceof Error ? e.message : 'Could not recheck captions.';
      await change({ ...latest.current, refinement: { status: 'failed', error, model: modelName } });
      setMessage(error);
    } finally {
      if (refinementId.current === id) { refinementId.current = null; setProgress(null); }
    }
  }

  function seekSegment(segmentId: string | undefined, index: number, t0: number) {
    const segment = project.transcript[index];
    if (!segment) return;
    const take = review.takes.find(item => segmentId && item.transcriptSegmentIds.includes(segmentId));
    if (take && onPreviewTake) onPreviewTake(take.id);
    else if (transcriptForSource(project, project.videoUri).includes(segment)) onSeek(t0);
  }

  function renderCaptionRow(segment: Project['transcript'][number], index: number) {
    const key = segment.id ?? `idx:${index}`;
    const open = openCaption === key;
    const text = segment.manualCorrection ?? segment.correctedText ?? segment.text;
    const hasFiller = /\b(um+|uh+|erm|hmm)\b/i.test(segment.text);
    return <View key={key} className="mb-2 rounded-xl bg-neutral-900 px-3 py-2">
      <View className="flex-row items-center gap-2">
        <Pressable accessibilityRole="button" className="py-2 pr-1" disabled={project.mediaMissing}
          onPress={() => seekSegment(segment.id, index, segment.t0)}>
          <Text className="text-neutral-400 text-xs" style={{ fontVariant: ['tabular-nums'] }}>
            {segment.t0.toFixed(1)}–{segment.t1.toFixed(1)}s{segment.isFinal === false ? ' · draft' : ''}{segment.needsListening ? ' · unclear' : ''}{hasFiller ? ' · um?' : ''}
          </Text>
        </Pressable>
        <View className="flex-1" />
        <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Hide caption options' : 'Show caption options'}
          onPress={() => setOpenCaption(open ? null : key)} className="px-2 py-2">
          <Text className="text-neutral-400 text-sm">{open ? '···' : '···'}</Text>
        </Pressable>
      </View>
      <TextInput key={`${segment.id}:${segment.revision ?? 0}`} multiline accessibilityLabel={`Edit caption ${index + 1}`}
        value={text}
        className="text-white text-sm leading-5 py-1"
        onChangeText={value => {
          const current = latest.current;
          void change({ ...current, reviewSegments: undefined, cutsReviewed: false, captionRevision: (current.captionRevision ?? 0) + 1,
            transcript: current.transcript.map((s, i) => (segment.id ? s.id === segment.id : i === index) ? { ...s, manualCorrection: value } : s) });
        }} />
      {open && <>
        {hasFiller && <Text className="text-amber-200 text-xs mt-1">Possible filler — listen to confirm; mid-sentence removal stays off.</Text>}
        <View className="flex-row gap-4 mt-1">
          <Pressable className="py-2" onPress={() => change(toggleCaptionListening(latest.current, segment.id ?? index))}>
            <Text className="text-neutral-300 text-xs">{segment.needsListening ? 'Unmark unclear' : 'Mark unclear'}</Text>
          </Pressable>
          <Pressable className="py-2" onPress={() => { setOpenCaption(null); seekSegment(segment.id, index, segment.t0); }}>
            <Text className="text-neutral-300 text-xs">Listen</Text>
          </Pressable>
        </View>
      </>}
    </View>;
  }

  return <View className="border-t border-neutral-800 mt-4 pt-1">
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(v => !v)} className="py-3 flex-row items-baseline gap-2">
      <Text className="text-white text-base font-semibold flex-1">
        Fix & choose{isScript && totalLines > 0 ? ` · ${covered}/${totalLines}` : ''}
      </Text>
      <Text className="text-neutral-400 text-sm">{expanded ? 'Hide' : 'Show'}</Text>
    </Pressable>
    {!!pickupIds.length && !expanded && <Text className="text-amber-200 text-xs mb-2">{pickupIds.length} lines need pickup.</Text>}
    {expanded && <View pointerEvents={importing ? 'none' : 'auto'}>
      {!!project.recoveryMessage && <Text className="text-amber-200 text-xs mb-2">{project.recoveryMessage}</Text>}
      <View className="flex-row gap-2 mb-2">
        {rechecking ? <Pressable accessibilityRole="button" onPress={async () => {
          const id = refinementId.current;
          refinementId.current = null; setProgress(null);
          if (id) await captions?.cancelRefinement(id);
          await change({ ...latest.current, refinement: { status: 'cancelled', model: 'Moonshine Tiny Streaming' } });
        }} className="flex-1 items-center rounded-xl bg-neutral-800 py-3 active:opacity-70">
          <Text className="text-white text-xs font-semibold">Cancel · {Math.round((progress ?? 0) * 100)}%</Text>
        </Pressable> : <Pressable accessibilityRole="button" disabled={multiSource || !captions || project.mediaMissing}
          onPress={() => refine()} className="flex-1 items-center rounded-xl bg-neutral-800 py-3 active:opacity-70 disabled:opacity-40">
          <Text className="text-white text-xs font-semibold">Recheck audio</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" onPress={() => setShowHistory(v => !v)}
          className="items-center rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3 active:opacity-70">
          <Text className="text-neutral-300 text-xs">History</Text>
        </Pressable>
      </View>
      {__DEV__ && <Pressable disabled={multiSource || !captions || project.mediaMissing || rechecking}
        onPress={() => refine('small')} className="mb-2 disabled:opacity-40">
        <Text className="text-neutral-500 text-xs">Compare Small · experimental</Text>
      </Pressable>}
      {showHistory && <View className="mb-2 rounded-xl bg-neutral-950 border border-neutral-800 p-3">
        {project.refinementCandidate?.length ? <Text className="text-neutral-400 text-xs mb-2">
          Latest recognition: {project.refinementCandidate.map(s => s.text).join(' ').slice(0, 220)}
          {project.refinementCandidate.map(s => s.text).join(' ').length > 220 ? '…' : ''}
        </Text> : null}
        {rawTranscript.length > 0 && <Text className="text-neutral-500 text-xs mb-2">Raw transcript kept ({rawTranscript.length} segments).</Text>}
        {project.rawTranscript && !multiSource && <Pressable onPress={() => change({ ...latest.current, transcript: latest.current.rawTranscript!, rawTranscript: latest.current.transcript, reviewDecisions: latest.current.previousReviewDecisions, previousReviewDecisions: latest.current.reviewDecisions, cutsReviewed: false })} className="py-2">
          <Text className="text-white text-xs">Restore previous transcript</Text>
        </Pressable>}
        {!project.rawTranscript && !project.refinementCandidate?.length && <Text className="text-neutral-500 text-xs">No earlier versions yet. Rechecks that change the transcript appear here.</Text>}
      </View>}
      {multiSource && <Text className="text-amber-200 text-xs mb-2">Multiple recordings: recheck and rollback are off. Edit captions or attach a pickup.</Text>}
      {!project.transcript.length && <Text className="text-neutral-300 text-sm mb-2">No transcript saved. Recheck the recording or keep the original.</Text>}

      {project.recordings?.filter(recording => recording.mediaUri !== project.videoUri).map(recording => <View key={recording.id} className="mb-2 rounded-xl bg-neutral-900 px-3 py-2">
        <Text className="text-amber-200 text-xs">{recording.evidenceStatus === 'pending' ? 'Pickup saved, recognition unfinished — not counted yet.' : 'Pickup original preserved.'}</Text>
        <Pressable accessibilityRole="button" disabled={!onPreviewRecording} className="py-2" onPress={() => onPreviewRecording?.(recording.mediaUri, recording.duration)}>
          <Text className="text-white text-xs">{onPreviewRecording ? 'Peek pickup original' : 'Pickup preview needs the Android media build'}</Text>
        </Pressable>
      </View>)}

      {(pickupIds.length > 0 || project.pickupRequest) && <View className="mb-2 rounded-xl bg-neutral-900 border border-neutral-800 p-3">
        <Text className="text-white text-sm font-semibold">
          {pickupIds.length ? `${pickupIds.length} lines need pickup` : 'Pickup list saved'}
        </Text>
        <View className="flex-row gap-2 mt-2">
          {!!pickupIds.length && <Pressable accessibilityRole="button" className="flex-1 items-center rounded-xl bg-neutral-800 py-3 active:opacity-70" onPress={() => change({ ...latest.current,
            pickupRequest: { lineIds: pickupIds, requestedAt: Date.now() } })}>
            <Text className="text-white text-xs font-semibold">Save list</Text>
          </Pressable>}
          <Pressable accessibilityRole="button" disabled={importing || rechecking} className="flex-1 items-center rounded-xl bg-white py-3 active:opacity-80 disabled:opacity-40" onPress={async () => {
            setImporting(true);
            try { await launchProjectPickup(latest.current, change, route => router.push(route)); }
            finally { setImporting(false); }
          }}><Text className="text-black text-xs font-semibold">Record</Text></Pressable>
        </View>
        {project.pickupRequest && <View className="mt-2">
          <Pressable disabled={importing || rechecking} accessibilityRole="button" className="py-2" onPress={async () => {
            try {
              const choices = (await listProjects()).filter(item => item.id !== project.id && item.videoUri && !item.mediaMissing);
              setPickupChoices(choices);
              if (!choices.length) setMessage('No other saved recordings. Record a pickup, then return here.');
            } catch (error) { setMessage(`Could not load recordings: ${String(error)}`); }
          }}><Text className="text-white text-xs">Attach a saved pickup…</Text></Pressable>
          {pickupChoices.map(choice => <Pressable key={choice.id} disabled={importing} className="py-2" onPress={() => {
            Alert.alert('Attach pickup recording?', 'Copied into this project. The source project is preserved; only requested lines count.', [
              { text: 'Cancel', style: 'cancel' }, { text: 'Attach pickup', onPress: async () => {
                setImporting(true);
                try {
                  if (!await change(latest.current)) return;
                  const merged = await mergePickupProject(project.id, choice.id, latest.current.pickupRequest?.lineIds ?? []);
                  await change(merged); setPickupChoices([]); setMessage('Pickup attached. Review the takes below.');
                } catch (error) { setMessage(`Could not attach pickup: ${String(error)}`); }
                finally { setImporting(false); }
              } },
            ]);
          }}><Text className="text-neutral-200 text-xs">{new Date(choice.createdAt).toLocaleString()} · {choice.script?.slice(0, 60) || choice.mode}</Text></Pressable>)}
        </View>}
      </View>}

      {isScript ? <>
        {review.lines.map(line => {
          const expandedLine = openLine === line.id;
          const dot = !line.spokenText.trim() ? '#525252' : line.selectedTakeId ? '#34d399' : '#fbbf24';
          const take = review.takes.find(t => t.id === line.selectedTakeId);
          return <View key={line.id} className="mb-2 rounded-xl bg-neutral-900 px-3 py-2">
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: expandedLine }} onPress={() => setOpenLine(expandedLine ? null : line.id)} className="flex-row items-start gap-2 py-1">
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot, marginTop: 5 }} />
              <View className="flex-1">
                <Text numberOfLines={expandedLine ? undefined : 2} className="text-white text-sm leading-5">{line.spokenText || '(no speech)'}</Text>
                <Text className="text-neutral-400 text-xs mt-1">
                  {line.selectedTakeId ? `Take ${take ? `${take.t0.toFixed(1)}s` : ''} · ${line.candidateTakeIds.length} options` : line.candidateTakeIds.length ? `${line.candidateTakeIds.length} takes · pick one` : 'No takes yet'}
                  {line.pendingReasons.length ? ` · ${line.pendingReasons.length} check${line.pendingReasons.length > 1 ? 's' : ''}` : ''}
                </Text>
              </View>
              <Text className="text-neutral-500 text-xs py-1">{expandedLine ? 'Hide' : 'Takes'}</Text>
            </Pressable>
            {expandedLine && <>
              {line.pendingReasons.map(reason => <Text key={reason} className="text-amber-200 text-xs mt-1">{reason}</Text>)}
              {projectScriptLines(project).find(item => item.id === line.id)?.actionCues.map(cue => <View key={cue.id} className="flex-row items-center gap-2 mt-2">
                <Pressable className="rounded-lg bg-neutral-800 px-3 py-2 active:opacity-70" onPress={() => change({ ...latest.current, scriptLines: projectScriptLines(latest.current).map(item => item.id === line.id ? { ...item, actionCues: item.actionCues.map(c => c.id === cue.id ? { ...c, required: !c.required } : c) } : item) })}>
                  <Text className="text-neutral-200 text-xs">{cue.required ? 'Required' : 'Optional'}</Text>
                </Pressable>
                <Text className="text-neutral-300 text-xs flex-1" numberOfLines={2}>{cue.text}</Text>
                <Pressable className={`rounded-lg px-3 py-2 active:opacity-70 ${cue.resolved ? 'bg-neutral-800' : 'bg-white'}`} onPress={() => change({ ...latest.current, scriptLines: projectScriptLines(latest.current).map(item => item.id === line.id ? { ...item, actionCues: item.actionCues.map(c => c.id === cue.id ? { ...c, resolved: !c.resolved } : c) } : item) })}>
                  <Text className={`text-xs font-semibold ${cue.resolved ? 'text-neutral-300' : 'text-black'}`}>{cue.resolved ? 'Done · undo' : 'Done'}</Text>
                </Pressable>
              </View>)}
              <View className="flex-row flex-wrap gap-2 mt-2">
                {line.candidateTakeIds.map(id => {
                  const candidate = review.takes.find(t => t.id === id);
                  const playable = !!candidate && candidate.playable && !!candidate.mediaUri && (!!onPreviewTake || candidate.mediaUri === project.videoUri);
                  const selected = line.selectedTakeId === id;
                  return <Pressable key={id} disabled={!playable} className={`rounded-lg px-3 py-2.5 active:opacity-70 disabled:opacity-40 ${selected ? 'bg-white' : 'bg-neutral-800'}`} onPress={async () => {
                    if (!candidate || !playable) return;
                    if (onPreviewTake) onPreviewTake(candidate.id); else onSeek(candidate.t0);
                    await change({ ...latest.current,
                      reviewDecisions: selectTake(latest.current.reviewDecisions ?? [], line.id, id, review.takes),
                      cuts: undefined, reviewSegments: undefined, cutsReviewed: false,
                    });
                  }}><Text className={`text-xs font-semibold ${selected ? 'text-black' : 'text-white'}`}>
                    {playable ? (selected ? `✓ ${candidate ? `${candidate.t0.toFixed(1)}s` : ''}` : `Use ${candidate ? `${candidate.t0.toFixed(1)}s` : ''}`) : 'N/A'}
                  </Text></Pressable>;
                })}
              </View>
              {!!line.rejectedTakeIds.length && <Text className="text-neutral-500 text-xs mt-2">
                {line.rejectedTakeIds.length} earlier attempt{line.rejectedTakeIds.length > 1 ? 's' : ''} in history — choosing a new take keeps them.
              </Text>}
            </>}
          </View>;
        })}
        <Pressable accessibilityRole="button" onPress={() => setShowCaptions(v => !v)} className="py-2 mb-1">
          <Text className="text-neutral-400 text-xs">Captions ({project.transcript.length}) · {showCaptions ? 'hide' : 'edit text'}</Text>
        </Pressable>
        {showCaptions && project.transcript.map(renderCaptionRow)}
      </> : project.transcript.map(renderCaptionRow)}

      {!!review.lines.length && <Pressable accessibilityRole="button" className="mt-1 items-center rounded-xl bg-white py-3.5 active:opacity-80" onPress={() => {
        const { segments, unavailableTakeIds, conflicts } = selectedReviewSegments(project, review);
        if (conflicts.length) { setMessage('Selected takes repeat a spoken line. Use the same take for those lines first.'); return; }
        if (unavailableTakeIds.length) { setMessage('Some selected footage is unavailable. Keep the original while resolving media.'); return; }
        if (!segments.length) { setMessage('No covered takes available yet.'); return; }
        Alert.alert('Review cut boundaries', 'Timestamps are estimates. Listen to every cut before accepting it for export. The original stays available.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Prepare cuts', onPress: () => { void change({ ...latest.current, reviewSegments: segments, cuts: undefined, cutsReviewed: false }); } },
        ]);
      }}><Text className="text-black text-sm font-semibold">Prepare cuts in script order</Text></Pressable>}

      {(project.reviewSegments ?? []).map((segment, index) => <View key={`${segment.takeId}:${index}`} className="py-1">
        <Pressable className="py-2" onPress={() => segment.takeId && onPreviewTake?.(segment.takeId)}>
          <Text className="text-white text-xs">Cut {index + 1} · {segment.t0.toFixed(2)}–{segment.t1.toFixed(2)}s · tap to peek</Text>
        </Pressable>
      </View>)}
      {(project.cuts ?? []).map((cut, index) => <View key={index} className="mt-2 rounded-xl bg-neutral-900 p-3">
        <Pressable className="pb-2" onPress={() => onSeek(cut.t0)}><Text className="text-white text-xs font-semibold">Cut {index + 1} · tap to listen</Text></Pressable>
        <View className="flex-row gap-2">
          {(['t0', 't1'] as const).map(boundary => <View key={boundary} className="flex-1 flex-row items-center rounded-lg bg-neutral-800">
            <Pressable accessibilityLabel={`Cut ${index + 1} ${boundary} minus half second`} className="px-3 py-3" onPress={() => {
              const next = { ...cut, [boundary]: Math.max(0, cut[boundary] - 0.5) };
              if (next.t1 <= next.t0) { setMessage('End must stay after start.'); return; }
              void change({ ...latest.current, cutsReviewed: false, cuts: latest.current.cuts?.map((c, i) => i === index ? next : c) });
            }}><Text className="text-white text-sm">−</Text></Pressable>
            <TextInput keyboardType="decimal-pad" accessibilityLabel={`Cut ${index + 1} ${boundary === 't0' ? 'start' : 'end'} seconds`}
              defaultValue={cut[boundary].toFixed(2)} className="flex-1 text-white text-sm text-center"
              onEndEditing={e => {
                const value = Number(e.nativeEvent.text);
                const next = { ...cut, [boundary]: value };
                const exceedsDuration = sourceDuration !== undefined && (next.t0 > sourceDuration || next.t1 > sourceDuration);
                if (!Number.isFinite(value) || next.t0 < 0 || next.t1 <= next.t0 || exceedsDuration) {
                  setMessage('Enter valid start/end seconds inside the recording.'); return;
                }
                void change({ ...latest.current, cutsReviewed: false, cuts: latest.current.cuts?.map((c, i) => i === index ? next : c) });
              }} />
            <Pressable accessibilityLabel={`Cut ${index + 1} ${boundary} plus half second`} className="px-3 py-3" onPress={() => {
              const next = { ...cut, [boundary]: cut[boundary] + 0.5 };
              if (sourceDuration !== undefined && next[boundary] > sourceDuration) { setMessage('Past the end of the recording.'); return; }
              if (next.t1 <= next.t0) { setMessage('End must stay after start.'); return; }
              void change({ ...latest.current, cutsReviewed: false, cuts: latest.current.cuts?.map((c, i) => i === index ? next : c) });
            }}><Text className="text-white text-sm">+</Text></Pressable>
          </View>)}
        </View>
      </View>)}
      {(!!project.cuts?.length || !!project.reviewSegments?.length) && <View className="flex-row gap-2 mt-2">
        <Pressable accessibilityRole="button" className={`flex-1 items-center rounded-xl py-3 active:opacity-70 ${project.cutsReviewed ? 'bg-neutral-800' : 'bg-white'}`} onPress={() => change({ ...latest.current, cutsReviewed: true })}>
          <Text className={`text-xs font-semibold ${project.cutsReviewed ? 'text-neutral-300' : 'text-black'}`}>{project.cutsReviewed ? '✓ Cuts accepted' : 'Accept all cuts'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" className="items-center rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3 active:opacity-70" onPress={() => change({ ...latest.current, cuts: undefined, reviewSegments: undefined, cutsReviewed: false })}>
          <Text className="text-neutral-300 text-xs">Clear</Text>
        </Pressable>
      </View>}
      {!!review.suggestions.length && <View className="mt-2">
        <Pressable onPress={() => setShowSuggestions(v => !v)} className="py-2">
          <Text className="text-neutral-400 text-xs">Cleanup suggestions ({review.suggestions.length}) · {showSuggestions ? 'hide' : 'review'}</Text>
        </Pressable>
        {showSuggestions && review.suggestions.map(suggestion => <View key={suggestion.id} className="mb-2 rounded-xl bg-neutral-900 px-3 py-2">
          <Pressable onPress={() => onSeek(Math.max(0, suggestion.t0 - 0.5))} className="py-1">
            <Text className="text-amber-200 text-xs">{suggestion.reason} Tap to listen.</Text>
          </Pressable>
          <Pressable className="py-2" onPress={() => {
            const current = latest.current;
            const effectiveDuration = sourceDuration ?? current.duration;
            if (!effectiveDuration || !Number.isFinite(effectiveDuration) || effectiveDuration <= 0) { setMessage('Recording duration is unavailable. Keep the original.'); return; }
            Alert.alert('Prepare a removal?', 'Listen first — boundaries are estimates and need review before export.', [
              { text: 'Keep original', style: 'cancel' }, { text: 'Prepare', onPress: () => {
                const removal = suggestion.kind === 'repeated-attempt' ? current.transcript.find(s => s.id === suggestion.segmentIds[0]) : suggestion;
                if (!removal) { setMessage('This suggestion is no longer available.'); return; }
                const trimEnd = current.trim?.end;
                const fallbackEnd = typeof trimEnd === 'number' && Number.isFinite(trimEnd) && trimEnd > 0 ? trimEnd : effectiveDuration;
                const cuts = excludeInterval(current.cuts?.length ? current.cuts : [{ t0: current.trim?.start ?? 0, t1: fallbackEnd }], removal);
                if (!cuts.length) { setMessage('That would remove the entire recording.'); return; }
                void change({ ...latest.current, cuts, cutsReviewed: false });
              } },
            ]);
          }}><Text className="text-white text-xs font-semibold">{suggestion.kind === 'repeated-attempt' ? 'Keep latest · remove earlier' : 'Prepare removal'}</Text></Pressable>
        </View>)}
      </View>}
      {!!(project.reviewDecisions ?? []).length && <Pressable className="py-2" onPress={() => {
        const last = (project.reviewDecisions ?? [])[(project.reviewDecisions ?? []).length - 1];
        if (last) void change({ ...latest.current,
          cutsReviewed: last.type === 'take-selection' ? false : latest.current.cutsReviewed,
          reviewDecisions: restoreDecision(latest.current.reviewDecisions ?? [], last.id) });
      }}>
        <Text className="text-neutral-400 text-xs">Undo last take choice</Text>
      </Pressable>}
      {importing && <Text className="text-neutral-300 text-xs py-2">Attaching pickup…</Text>}
      {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-xs py-2">{message}</Text>}
    </View>}
  </View>;
}
