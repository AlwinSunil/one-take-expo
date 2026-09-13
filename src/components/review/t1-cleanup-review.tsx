import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { Project } from '@/lib/session';
import {
  applyCleanupReviewDecision,
  buildCleanupReview,
  resetCleanupReview,
  type CleanupReviewFootage,
  type CleanupReviewProject,
} from '@/lib/t1-cleanup-review';

export interface T1CleanupReviewProps {
  project: CleanupReviewProject;
  onChange: (project: Project) => Promise<void> | void;
  onPreviewFootage?: (footage: CleanupReviewFootage) => void;
  /** Tier 1 cleanup remains off until the shared acceptance gate is enabled. */
  enabled?: boolean;
  disabled?: boolean;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'accepted': return 'Removal prepared';
    case 'dismissed': return 'Kept';
    case 'review-only': return 'Review mark only';
    case 'unavailable': return 'Unavailable';
    case 'stale': return 'Stale evidence';
    default: return 'Needs review';
  }
}

export function T1CleanupReview({
  project,
  onChange,
  onPreviewFootage,
  enabled = false,
  disabled = false,
}: T1CleanupReviewProps) {
  const report = useMemo(() => buildCleanupReview(project, enabled), [project, enabled]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  if (!enabled) return null;

  async function choose(itemId: string, recordingId: string, action: 'accept' | 'dismiss') {
    if (disabled || busyId) return;
    const item = report.items.find(candidate => candidate.id === itemId && candidate.recordingId === recordingId);
    if (!item) return;
    const confirmation = { recordingId: item.recordingId, fingerprint: item.suggestion.fingerprint };
    setBusyId(itemId);
    setMessage('');
    try {
      const result = applyCleanupReviewDecision(project, item.id, action, confirmation);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      await onChange(result.project);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Cleanup choice could not be saved.');
    } finally {
      setBusyId(null);
    }
  }

  async function reset() {
    if (disabled || busyId || !project.cleanupReview) return;
    setBusyId('reset');
    setMessage('');
    try {
      await onChange(resetCleanupReview(project));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Cleanup reset could not be saved.');
    } finally {
      setBusyId(null);
    }
  }

  return <View accessibilityLabel="Tier 1 cleanup review" className="border-t border-neutral-800 mt-4 pt-4">
    <View className="flex-row flex-wrap items-start justify-between gap-3">
      <View className="flex-1">
        <Text className="text-white text-base font-semibold">Cleanup review</Text>
        <Text className={report.status === 'ready' ? 'text-neutral-300 text-xs mt-1' : 'text-amber-200 text-xs mt-1'}>
          {report.message}
        </Text>
      </View>
      {!!project.cleanupReview && <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reset cleanup review"
        accessibilityState={{ disabled: disabled || !!busyId }}
        disabled={disabled || !!busyId}
        onPress={() => { void reset(); }}
        className="px-3 py-2 rounded-lg bg-neutral-800 disabled:opacity-40">
        <Text className="text-neutral-200 text-xs">Off / reset</Text>
      </Pressable>}
    </View>

    {report.items.map(item => <View key={`${item.recordingId}:${item.id}`} className="border-t border-neutral-800 py-4 mt-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-white text-sm flex-1">{item.suggestion.kind}</Text>
        <Text className={item.status === 'accepted' ? 'text-emerald-300 text-xs' : item.status === 'pending' ? 'text-amber-200 text-xs' : 'text-neutral-400 text-xs'}>
          {statusLabel(item.status)}
        </Text>
      </View>
      <Text className="text-amber-200 text-xs mt-2">{item.reason}</Text>
      {!!item.evidence.length && <View className="mt-2">
        {item.evidence.map((evidence, index) => <Text key={`${evidence.type}:${index}`} className="text-neutral-400 text-xs mt-1">
          {evidence.type} · {evidence.source} · {evidence.detail}
        </Text>)}
      </View>}

      <View className="flex-row flex-wrap gap-2 mt-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.canPreview && onPreviewFootage ? 'Preview cleanup supporting footage' : 'Cleanup supporting footage unavailable'}
          accessibilityState={{ disabled: !item.canPreview || !onPreviewFootage || disabled || !!busyId }}
          disabled={!item.canPreview || !onPreviewFootage || disabled || !!busyId}
          onPress={() => { if (item.previewFootage && onPreviewFootage) onPreviewFootage(item.previewFootage); }}
          className="px-3 py-3 rounded-lg bg-neutral-800 disabled:opacity-40">
          <Text className="text-neutral-200 text-xs">{item.canPreview && onPreviewFootage ? 'Preview supporting footage' : 'Supporting footage unavailable'}</Text>
        </Pressable>
        {item.canAccept && <Pressable
          accessibilityRole="button"
          accessibilityLabel="Accept reversible cleanup removal"
          accessibilityState={{ disabled: disabled || !!busyId }}
          disabled={disabled || !!busyId}
          onPress={() => { void choose(item.id, item.recordingId, 'accept'); }}
          className="px-3 py-3 rounded-lg bg-amber-700 disabled:opacity-40">
          <Text className="text-white text-xs">Accept reversible removal</Text>
        </Pressable>}
        {item.status === 'pending' && <Pressable
          accessibilityRole="button"
          accessibilityLabel="Keep cleanup mark"
          accessibilityState={{ disabled: disabled || !!busyId }}
          disabled={disabled || !!busyId}
          onPress={() => { void choose(item.id, item.recordingId, 'dismiss'); }}
          className="px-3 py-3 rounded-lg border border-neutral-700 disabled:opacity-40">
          <Text className="text-neutral-300 text-xs">Keep marked</Text>
        </Pressable>}
        {item.status === 'accepted' && <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo cleanup removal"
          accessibilityState={{ disabled: disabled || !!busyId }}
          disabled={disabled || !!busyId}
          onPress={() => { void choose(item.id, item.recordingId, 'dismiss'); }}
          className="px-3 py-3 rounded-lg border border-neutral-700 disabled:opacity-40">
          <Text className="text-neutral-300 text-xs">Undo removal</Text>
        </Pressable>}
      </View>
      {!!item.unavailableReason && <Text className="text-neutral-500 text-xs mt-2">{item.unavailableReason}</Text>}
    </View>)}

    {!!message && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-3">{message}</Text>}
  </View>;
}

export default T1CleanupReview;
