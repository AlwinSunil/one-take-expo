import { useEffect, useRef, type ReactNode } from 'react';
import { Alert, AppState, BackHandler, ScrollView, Text, View } from 'react-native';
import { useNavigation } from 'expo-router';
import type { TimelineClip, TimelineReason, TimelineSnapshot } from './engine';
import { TimelineButton, TimelineControls, type ClipAction } from './controls';
import { shouldProtectTimelineBack, type SaveStatus } from './playback';

/** No persistence implementation here. The route supplies A's atomic save operation. */
export function useTimelineBackProtection(
  status: SaveStatus,
  save: () => Promise<void>,
  back: () => void,
  getSaveGeneration?: () => number | string,
  isSaveCurrent?: () => boolean,
) {
  const navigation = useNavigation();
  const latest = useRef({ status, save, back, getSaveGeneration, isSaveCurrent });
  latest.current = { status, save, back, getSaveGeneration, isSaveCurrent };
  const allowed = useRef(false);
  const prompting = useRef(false);
  function protect(leave: () => void) {
    if (!shouldProtectTimelineBack(latest.current.status) || allowed.current) { leave(); return; }
    if (prompting.current) return;
    prompting.current = true;
    const generation = latest.current.getSaveGeneration?.();
    const finishSaveAndLeave = () => {
      const current = latest.current;
      const sameGeneration = generation === undefined || current.getSaveGeneration?.() === generation;
      const saveIsCurrent = current.isSaveCurrent?.() ?? !shouldProtectTimelineBack(current.status);
      prompting.current = false;
      if (!sameGeneration || !saveIsCurrent) return;
      allowed.current = true;
      leave();
    };
    Alert.alert('Keep your timeline edits?', latest.current.status === 'saving' ? 'A save is still running. Stay here until it finishes.' : 'Your timeline has unsaved changes. Save and leave, or stay to keep editing.', [
      { text: 'Stay', style: 'cancel', onPress: () => { prompting.current = false; } },
      ...(latest.current.status === 'saving' ? [] : [
        { text: 'Discard unsaved changes', style: 'destructive' as const, onPress: () => { prompting.current = false; allowed.current = true; leave(); } },
        { text: 'Save and leave', onPress: () => {
          void latest.current.save().then(() => {
            // Let save-status refs publish before checking the navigation decision.
            // The generation/current-write checks still catch edits made while saving.
            setTimeout(finishSaveAndLeave, 0);
          }).catch(() => { prompting.current = false; });
        } },
      ]),
    ], { cancelable: false });
  }
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', event => {
      // Another guard may own the route during a staged workspace integration.
      if ((event as { defaultPrevented?: boolean }).defaultPrevented) return;
      if (!shouldProtectTimelineBack(latest.current.status) || allowed.current) return;
      event.preventDefault();
      protect(() => navigation.dispatch(event.data.action));
    });
    const hardware = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!shouldProtectTimelineBack(latest.current.status) || allowed.current) return false;
      protect(() => latest.current.back());
      return true;
    });
    return () => { unsubscribe(); hardware.remove(); };
  }, [navigation]);
  return () => protect(() => latest.current.back());
}

export type TimelineProposalReview = {
  id: string; title: string; reasons: string[]; conflicts: string[]; previewing: boolean;
  onPreview: () => void; onAccept: () => void; onReject: () => void; onResolve?: () => void;
};

/** Controlled editor feature. Slots are filled only by owner-published integrations. */
export function TimelineWorkspace({ snapshot, reasons, sources, playhead, canUndo, canRedo, saveStatus, saveError, message,
  onUndo, onRedo, onAction, onPreview, onSeek, onSave, onBack, onPause, preview, playbackControls, lifecycle, captionSettings, exportControls, proposals = [], legacyReview }: {
  snapshot: TimelineSnapshot; reasons: TimelineReason[];
  sources: Readonly<Record<string, { duration: number | null; available: boolean }>>;
  playhead: { clipId: string; sourceTime: number } | null; canUndo: boolean; canRedo: boolean;
  saveStatus: SaveStatus; saveError?: string; message?: string;
  onUndo: () => void; onRedo: () => void; onAction: (action: ClipAction) => void;
  onPreview: (clip: TimelineClip) => void; onSeek: (clip: TimelineClip, sourceTime: number) => void;
  onSave: () => Promise<void>; onBack: () => void; onPause: () => void;
  preview: ReactNode; playbackControls: ReactNode; lifecycle?: ReactNode; captionSettings?: ReactNode;
  exportControls: ReactNode; proposals?: TimelineProposalReview[]; legacyReview?: ReactNode;
}) {
  const back = useTimelineBackProtection(saveStatus, onSave, onBack);
  const pause = useRef(onPause); pause.current = onPause;
  const navigation = useNavigation();
  useEffect(() => {
    const app = AppState.addEventListener('change', state => { if (state !== 'active') pause.current(); });
    const blur = navigation.addListener('blur', () => pause.current());
    return () => { app.remove(); blur(); pause.current(); };
  }, [navigation]);
  return <View style={{ flex: 1, backgroundColor: '#000' }}>
    <View style={{ padding: 12, gap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
      <TimelineButton label="Back" onPress={back} />
      <Text style={{ color: '#fafafa', fontWeight: '600', fontSize: 18, flex: 1 }}>Review & export</Text>
      <TimelineButton label={saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Retry save' : 'Save project'} disabled={saveStatus === 'saving'} onPress={() => { onPause(); void onSave().catch(() => {}); }} />
    </View>
    <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 48, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
      <Text accessibilityLiveRegion="polite" style={{ color: saveStatus === 'error' ? '#fca5a5' : '#d4d4d4' }}>{saveStatus === 'saved' ? 'Saved' : saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed. Your edits are still here. Retry save.' : 'Unsaved changes'}</Text>
      {!!saveError && <Text accessibilityRole="alert" style={{ color: '#fca5a5' }}>{saveError}</Text>}
      {lifecycle}
      {preview}
      {playbackControls}
      {exportControls}
      {captionSettings}
      {!!message && <Text accessibilityRole="alert" style={{ color: '#fcd34d' }}>{message}</Text>}
      {proposals.map(proposal => <View key={proposal.id} style={{ padding: 14, gap: 10, borderRadius: 14, backgroundColor: '#171717', borderColor: '#525252', borderWidth: 1 }}>
        <Text style={{ color: '#fafafa', fontSize: 18 }}>{proposal.title}</Text>
        <Text style={{ color: '#d4d4d4' }}>{proposal.previewing ? 'Previewing recommendation. Your saved edit is unchanged.' : 'Recommendation waiting for your review.'}</Text>
        {proposal.reasons.map((reason, i) => <Text key={i} style={{ color: '#d4d4d4' }}>{reason}</Text>)}
        {proposal.conflicts.map((conflict, i) => <Text key={i} accessibilityRole="alert" style={{ color: '#fcd34d' }}>{conflict}</Text>)}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <TimelineButton label="Preview proposal" onPress={proposal.onPreview} disabled={saveStatus === 'saving' || proposal.conflicts.length > 0} />
          <TimelineButton label="Accept whole proposal" onPress={proposal.onAccept} disabled={saveStatus === 'saving' || proposal.conflicts.length > 0} />
          <TimelineButton label="Keep my edit / reject" onPress={proposal.onReject} disabled={saveStatus === 'saving'} />
          {!!proposal.onResolve && proposal.conflicts.length > 0 && <TimelineButton label="Review conflict" onPress={proposal.onResolve} disabled={saveStatus === 'saving'} />}
        </View>
      </View>)}
      <TimelineControls snapshot={snapshot} reasons={reasons} sources={sources} playhead={playhead} canUndo={canUndo} canRedo={canRedo} disabled={saveStatus === 'saving'}
        onUndo={onUndo} onRedo={onRedo} onAction={onAction} onPreview={onPreview} onSeek={onSeek} />
      {legacyReview}
    </ScrollView>
  </View>;
}
