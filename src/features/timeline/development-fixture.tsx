import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { TimelineButton, type ClipAction } from './controls';
import { TimelineWorkspace, type TimelineProposalReview } from './workspace';
import { applyTimelineAction, createTimelineState, playheadAt, preserveTimelinePlayhead, redoTimeline, resolveTimeline, undoTimeline,
  type TimelineClip, type TimelinePlayhead, type TimelineSources, type TimelineState } from './engine';
import { acceptPickupProposal, buildPickupProposal,
  type ManualTimelineEdit, type PickupConflict, type PickupProposalResult, type PickupRevisionScope } from './proposals';
import { createTimelineSaveCoordinator } from './save-coordinator';

/** Synthetic fixture only. No source files, Project schema, or storage are created. */
export function createTimelineDevelopmentFixture() {
  return createTimelineState({ revision: 0, clips: [
    { id: 'fixture:A', sourceId: 'fixture:original', t0: 0, t1: 2, included: true, spanIds: ['span:A'], pointIds: ['point:A'], utteranceIds: ['utterance:A'], reasonIds: [] },
    { id: 'fixture:weaker', sourceId: 'fixture:original', t0: 2, t1: 3, included: false, spanIds: [], pointIds: [], utteranceIds: ['utterance:weaker'], reasonIds: ['reason:weaker'] },
    { id: 'fixture:C', sourceId: 'fixture:original', t0: 3, t1: 5, included: true, spanIds: ['span:C'], pointIds: ['point:C'], utteranceIds: ['utterance:C'], reasonIds: [] },
  ] }, [{ id: 'reason:weaker', kind: 'weaker-take', text: 'Weaker attempt (synthetic example).', actor: 'analysis' }]);
}
const fixtureSources: TimelineSources = {
  'fixture:original': { id: 'fixture:original', uri: 'fixture://original', duration: 5, available: true },
  'fixture:pickup-B': { id: 'fixture:pickup-B', uri: 'fixture://pickup-B', duration: 4, available: true },
};

const pickupPointOrder = { 'point:A': 0, 'point:B': 1, 'point:C': 2 } as const;

function pickupScope(editRevision: number): PickupRevisionScope {
  return {
    projectId: 'fixture:project',
    scriptRevision: 'fixture:script:1',
    editRevision,
    pointRevision: 'fixture:points:1',
    transcriptRevision: 'fixture:transcript:1',
    sourceTranscriptRevisions: {
      'fixture:original': 'fixture:transcript:original:1',
      'fixture:pickup-B': 'fixture:transcript:pickup-B:1',
    },
    pointRevisions: {
      'point:A': 'fixture:point:A:1',
      'point:B': 'fixture:point:B:1',
      'point:C': 'fixture:point:C:1',
    },
  };
}

function clipIdentity(clips: readonly TimelineClip[]) {
  return {
    clipIds: clips.map(clip => clip.id),
    pointIds: [...new Set(clips.flatMap(clip => clip.pointIds))],
    spanIds: [...new Set(clips.flatMap(clip => clip.spanIds))],
    utteranceIds: [...new Set(clips.flatMap(clip => clip.utteranceIds))],
  };
}

/** Keep creator history attached to a proposal so stale pickup work is reviewable. */
function manualEditsFor(state: TimelineState): ManualTimelineEdit[] {
  return state.history.entries.slice(0, state.history.cursor).flatMap(command => {
    if (command.kind !== 'reorder' && command.kind !== 'split' && command.kind !== 'exclude') return [];
    const removed = command.kind === 'split'
      ? command.before.filter(before => !command.after.some(after => after.id === before.id))
      : command.before.filter(before => command.after.some(after => after.id === before.id && JSON.stringify(after) !== JSON.stringify(before)));
    const touched = removed.length ? removed : command.before;
    const ids = clipIdentity(command.kind === 'reorder' ? command.before : touched);
    return [{
      id: command.id,
      kind: command.kind === 'exclude' ? 'delete' : command.kind,
      revision: command.revision,
      ...ids,
    } satisfies ManualTimelineEdit];
  });
}

const pickupIntents = [{
  id: 'fixture:intent:B',
  clipId: 'fixture:B',
  sourceId: 'fixture:pickup-B',
  t0: 0.5,
  t1: 2.5,
  pointIds: ['point:B'],
  spanIds: ['span:B'],
  utteranceIds: ['utterance:B'],
  takeId: 'fixture:take:B',
}] as const;

function proposalFor(state: TimelineState, sources: TimelineSources): PickupProposalResult {
  const scope = pickupScope(state.snapshot.revision);
  return buildPickupProposal({
    proposalId: 'fixture:pickup-proposal',
    snapshot: state.snapshot,
    sources: Object.values(sources),
    intents: pickupIntents,
    pointOrder: pickupPointOrder,
    scope: { captured: scope, current: scope },
    manualEdits: manualEditsFor(state),
    baseRevision: state.snapshot.revision,
    createdAt: state.snapshot.revision,
  });
}

function conflictText(conflict: PickupConflict) {
  return `${conflict.message} Recovery: ${conflict.recovery}.`;
}

function uniqueConflicts(conflicts: readonly PickupConflict[]) {
  const seen = new Set<string>();
  return conflicts.filter(conflict => {
    const key = `${conflict.kind}:${conflict.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function includedProposalClips(proposal: PickupProposalResult) {
  return proposal.previewClips.filter(clip => clip.included);
}

function proposalPreviewText(proposal: PickupProposalResult) {
  const contextOrder = proposal.previewClips.map(clip => `${clip.id} (${clip.sourceId}${clip.included ? '' : ', excluded context'})`).join(' → ');
  const outputOrder = includedProposalClips(proposal).map(clip => `${clip.id} (${clip.sourceId})`).join(' → ');
  return `Pickup proposal preview · source context order: ${contextOrder || 'empty'} · included output order: ${outputOrder || 'empty'}. Synthetic source preview only; no media plays and no export is produced.`;
}

export function TimelineDevelopmentFixture() {
  const initial = useMemo(createTimelineDevelopmentFixture, []);
  const [state, setState] = useState(initial);
  const current = useRef(state); current.current = state;
  const saved = useRef(initial);
  const failSave = useRef(false);
  const ids = useRef(0);
  const mint = () => `fixture:action:${++ids.current}`;
  const coordinator = useMemo(() => createTimelineSaveCoordinator(initial, async value => {
    if (failSave.current) { failSave.current = false; throw new Error('Simulated save failure. Retry keeps the same edit.'); }
    saved.current = value;
  }, mint), [initial]);
  const [, render] = useState(0);
  useEffect(() => coordinator.subscribe(() => render(value => value + 1)), [coordinator]);
  const save = coordinator.read();
  const [sources, setSources] = useState(fixtureSources);
  const sequence = useMemo(() => resolveTimeline(state.snapshot, sources), [state, sources]);
  const [playhead, setPlayhead] = useState<TimelinePlayhead | null>(() => playheadAt(resolveTimeline(initial.snapshot, sources), 1));
  const [message, setMessage] = useState('');
  const [peek, setPeek] = useState('');
  const [exportSummary, setExportSummary] = useState('');
  const [pickupProposal, setPickupProposal] = useState<PickupProposalResult | null>(null);
  const [proposalPreviewing, setProposalPreviewing] = useState(false);
  const currentScope = useMemo(() => pickupScope(state.snapshot.revision), [state.snapshot.revision]);

  function edit(next: TimelineState) {
    setPeek(''); setExportSummary('');
    setProposalPreviewing(false);
    setPlayhead(preserveTimelinePlayhead(playhead, next, sources));
    current.current = next; setState(next); coordinator.stage(next); setMessage('');
  }

  function act(action: ClipAction) {
    try {
      const id = mint(), baseRevision = current.current.snapshot.revision;
      edit(applyTimelineAction(current.current, action.kind === 'split' ? { ...action, id, baseRevision, leftId: `${id}:left`, rightId: `${id}:right` } : { ...action, id, baseRevision }, sources));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  function loadPickupProposal() {
    const result = proposalFor(current.current, sources);
    setPickupProposal(result);
    setProposalPreviewing(false);
    setPeek('');
    setMessage(result.conflicts.length
      ? `Pickup proposal needs review before it can be accepted. ${result.conflicts.map(conflictText).join(' ')}`
      : 'Pickup proposal loaded for review. Your timeline is unchanged until you accept it.');
  }

  function liveProposalConflicts(proposal: PickupProposalResult | null = pickupProposal) {
    if (!proposal) return [];
    if (proposal.status === 'conflict') return proposal.conflicts;
    const check = acceptPickupProposal({
      snapshot: current.current.snapshot,
      proposal: proposal.proposal,
      sources: Object.values(sources),
      currentScope,
    });
    return check.status === 'conflict' ? check.conflicts : [];
  }

  function refreshPickupProposal() {
    const result = proposalFor(current.current, sources);
    setPickupProposal(result);
    setProposalPreviewing(false);
    setPeek('');
    setMessage(result.conflicts.length
      ? `Pickup proposal still needs review. ${result.conflicts.map(conflictText).join(' ')}`
      : 'Pickup proposal refreshed against the current timeline. Review it before accepting.');
  }

  function acceptCurrentPickupProposal() {
    if (!pickupProposal) return false;
    const checked = acceptPickupProposal({
      snapshot: current.current.snapshot,
      proposal: pickupProposal.proposal,
      sources: Object.values(sources),
      currentScope,
      commandId: mint(),
      acceptedAt: current.current.snapshot.revision,
    });
    if (checked.status === 'conflict' || !checked.command) {
      setProposalPreviewing(false);
      setMessage(`Pickup proposal was not accepted. ${checked.conflicts.map(conflictText).join(' ')}`);
      return false;
    }
    try {
      const next = applyTimelineAction(current.current, checked.command, sources);
      edit(next);
      setPickupProposal(null);
      setProposalPreviewing(false);
      setMessage('Pickup proposal accepted as one undoable creator action.');
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function saveProject() {
    if (proposalPreviewing && pickupProposal && liveProposalConflicts().length === 0) acceptCurrentPickupProposal();
    await coordinator.save();
  }

  const proposalConflicts = useMemo(() => uniqueConflicts(liveProposalConflicts()), [pickupProposal, state, sources, currentScope]);
  const proposalReview = useMemo<TimelineProposalReview[]>(() => {
    if (!pickupProposal) return [];
    return [{
      id: pickupProposal.proposal.id,
      title: 'Pickup proposal · A → B → C',
      reasons: [
        `Included source order: ${includedProposalClips(pickupProposal).map(clip => `${clip.id} from ${clip.sourceId}`).join(' → ') || 'empty'}.`,
        'B is a synthetic pickup source. This proposal remains pending until the creator accepts it.',
        'Memory-only fixture: no real media plays, no source is restored by preview, and no fake export is created.',
      ],
      conflicts: proposalConflicts.map(conflictText),
      previewing: proposalPreviewing,
      onPreview: () => {
        if (proposalConflicts.length) {
          setMessage(`Preview is blocked until this pickup proposal is refreshed. ${proposalConflicts.map(conflictText).join(' ')}`);
          return;
        }
        setProposalPreviewing(true);
        setPeek(proposalPreviewText(pickupProposal));
        setMessage('Showing the proposed source order only. Your saved timeline is unchanged.');
      },
      onAccept: () => { acceptCurrentPickupProposal(); },
      onReject: () => {
        setPickupProposal(null);
        setProposalPreviewing(false);
        setPeek('');
        setMessage('Kept your current edit and rejected the pickup proposal.');
      },
      onResolve: proposalConflicts.length ? refreshPickupProposal : undefined,
    }];
  }, [pickupProposal, proposalConflicts, proposalPreviewing]);

  return <TimelineWorkspace snapshot={state.snapshot} reasons={state.reasons} sources={sources} playhead={playhead}
    canUndo={state.history.cursor > 0} canRedo={state.history.cursor < state.history.entries.length}
    saveStatus={save.status} saveError={save.error ?? undefined} message={message || sequence.issues.map(issue => `${issue.message} ${issue.recovery}`).join(' ')}
    onSave={saveProject} onBack={() => router.back()} onPause={() => {}}
    onUndo={() => edit(undoTimeline(current.current))} onRedo={() => edit(redoTimeline(current.current))} onAction={act}
    onPreview={clip => { setProposalPreviewing(false); setPeek(`Inspecting ${clip.sourceId} ${clip.t0.toFixed(2)}–${clip.t1.toFixed(2)}s. Inclusion is unchanged. This fixture has no media.`); }}
    onSeek={(clip, sourceTime) => { setProposalPreviewing(false); setPeek(''); const segment = sequence.segments.find(item => item.clipId === clip.id); if (segment) setPlayhead(playheadAt(sequence, segment.outputT0 + sourceTime - segment.t0)); }}
    lifecycle={<View style={{ padding: 14, gap: 8, borderWidth: 1, borderColor: '#a16207', borderRadius: 12 }}>
      <Text style={{ color: '#fcd34d', fontWeight: '600' }}>Timeline development fixture</Text>
      <Text style={{ color: '#d4d4d4' }}>Synthetic ranges only. Save/reopen uses temporary memory, not project storage. No media plays or exports. Pickup proposals are memory-only. A/C integration and Android acceptance are pending.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <TimelineButton label="Simulate save failure" onPress={() => { failSave.current = true; coordinator.stage(current.current); setMessage('The next fixture save will fail once.'); }} />
        <TimelineButton label="Reopen fixture checkpoint" disabled={save.status !== 'saved'} onPress={() => { current.current = saved.current; setState(saved.current); setPickupProposal(null); setProposalPreviewing(false); setPeek(''); setPlayhead(playheadAt(resolveTimeline(saved.current.snapshot, sources), 0)); setMessage('Reopened temporary fixture checkpoint. This is not a durable project reopen.'); }} />
        <TimelineButton label={sources['fixture:original'].available ? 'Simulate missing media' : 'Recover fixture media'} onPress={() => { setSources(previous => ({ ...previous, 'fixture:original': { ...fixtureSources['fixture:original'], available: !previous['fixture:original'].available } })); setPeek(''); }} />
        <TimelineButton label={sources['fixture:pickup-B'].available ? 'Simulate pickup missing media' : 'Recover pickup media'} onPress={() => { setSources(previous => ({ ...previous, 'fixture:pickup-B': { ...fixtureSources['fixture:pickup-B'], available: !previous['fixture:pickup-B'].available } })); setProposalPreviewing(false); setPeek(''); }} />
        <TimelineButton label={pickupProposal ? 'Refresh pickup proposal' : 'Load pickup proposal'} onPress={pickupProposal ? refreshPickupProposal : loadPickupProposal} />
      </View>
    </View>}
    preview={<View style={{ minHeight: 100, justifyContent: 'center', padding: 16, backgroundColor: '#171717', borderRadius: 14 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: '#fafafa', fontSize: 18 }}>{peek || (sequence.segments.length && !sequence.issues.length ? `${sequence.duration.toFixed(2)} seconds output · fixture preview` : 'Empty / unavailable preview · no original fallback')}</Text>
      <Text style={{ color: '#a3a3a3', marginTop: 8 }}>Revision {state.snapshot.revision} · {sequence.duration.toFixed(2)}s included</Text>
    </View>}
    playbackControls={<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <TimelineButton label="Seek back 0.5s" disabled={!sequence.segments.length || !!sequence.issues.length} onPress={() => { setProposalPreviewing(false); setPeek(''); setPlayhead(playheadAt(sequence, Math.max(0, (playhead?.outputTime ?? 0) - 0.5))); }} />
      <TimelineButton label="Seek forward 0.5s" disabled={!sequence.segments.length || !!sequence.issues.length} onPress={() => { setProposalPreviewing(false); setPeek(''); setPlayhead(playheadAt(sequence, Math.min(sequence.duration, (playhead?.outputTime ?? 0) + 0.5))); }} />
      {!!peek && <TimelineButton label="Return to edited sequence" onPress={() => { setProposalPreviewing(false); setPeek(''); }} />}
      <Text style={{ color: '#d4d4d4', padding: 12 }}>Playhead {playhead?.sourceTime.toFixed(2) ?? 'none'} source seconds</Text>
    </View>}
    exportControls={<View style={{ gap: 8 }}>
      <TimelineButton label="Inspect export intervals (fixture)" disabled={save.status !== 'saved' || !!sequence.issues.length || !sequence.segments.length || !!peek} onPress={() => setExportSummary(sequence.segments.map(segment => `${segment.clipId}: ${segment.sourceId} [${segment.t0}, ${segment.t1})`).join('\n'))} />
      {!!exportSummary && <Text selectable style={{ color: '#d4d4d4' }}>{exportSummary}</Text>}
    </View>} proposals={proposalReview} />;
}
