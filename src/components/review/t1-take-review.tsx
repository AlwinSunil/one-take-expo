import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Project } from '@/lib/session';
import { projectReview } from '@/lib/project-workflow';
import { canReviewFootage, chooseReviewTake, takeFootage } from '@/lib/t1-review';

export function Tier1TakeReview({ project, onChange, onPreview }: {
  project: Project; onChange: (project: Project) => Promise<void>;
  onPreview: (range: { recordingId: string; t0: number; t1: number }) => void;
}) {
  const review = useMemo(() => projectReview(project), [project]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const evidence = project.tier1Evidence;
  const reasons = evidence?.version === 1 && evidence.projectId === project.id && Array.isArray(evidence.reasons) ? evidence.reasons : [];
  return <View className="border-t border-neutral-800 py-3">
    <Text className="text-white font-semibold">Take details</Text>
    <Text className="text-neutral-400 py-2">{evidence?.provider === 'fixture' ? 'Deterministic fixture evidence' : 'Supplied evidence'} · {evidence?.status ?? 'unavailable'}</Text>
    {reasons.filter(reason => reason && typeof reason.message === 'string').map((reason, index) => <View key={`reason:${index}`} className="py-2">
      <Text className="text-amber-200">{reason.message} · {reason.status}</Text>
      <Pressable accessibilityRole="button" disabled={!reason.footage || !canReviewFootage(project, reason.footage)} className="py-3 disabled:opacity-40" onPress={() => { if (reason.footage) onPreview(reason.footage); }}>
        <Text className="text-white">{reason.footage && canReviewFootage(project, reason.footage) ? 'Review supporting footage' : 'Supporting footage unavailable'}</Text>
      </Pressable>
    </View>)}
    {!!evidence?.scratchHistory?.length && <View className="py-3"><Text className="text-white">Scratch history</Text>{evidence.scratchHistory.map(event => <Text key={event.id} className="text-neutral-400 py-1">{event.takeId} · {event.state} · {event.source ?? 'supplied command'}</Text>)}</View>}
    {review.lines.map(line => <View key={line.id} className="py-2">
      <Text className="text-white">{line.spokenText}</Text>
      {line.candidateTakeIds.map(id => {
        const take = review.takes.find(item => item.id === id);
        if (!take) return null;
        const playable = take.playable && canReviewFootage(project, takeFootage(project, take));
        const flags = reasons.filter(reason => reason?.takeId === id && typeof reason.message === 'string');
        return <View key={id} className="py-2">
          <Text className="text-neutral-300">{take.t0.toFixed(1)}–{take.t1.toFixed(1)} seconds · {playable ? 'Available' : 'Media unavailable'}</Text>
          {!flags.length && <Text className="text-neutral-400">No producer explanation supplied.</Text>}
          {flags.map((reason, index) => <View key={`${reason.id}:${index}`}>
            <Text className="text-amber-200">{reason.message} · {reason.status}</Text>
            {reason.footage && <Pressable accessibilityRole="button" disabled={!canReviewFootage(project, reason.footage)} className="py-3 disabled:opacity-40" onPress={() => onPreview(reason.footage!)}>
              <Text className="text-white">Review supporting footage</Text>
            </Pressable>}
          </View>)}
          <Pressable accessibilityRole="button" disabled={!playable || busy} className="py-3 disabled:opacity-40" onPress={async () => {
            setBusy(true); setError('');
            try { await onChange(chooseReviewTake(project, line.id, id)); onPreview(takeFootage(project, take)); }
            catch (e) { setError(e instanceof Error ? e.message : 'Could not save take choice.'); }
            finally { setBusy(false); }
          }}><Text className="text-white">{line.selectedTakeId === id ? 'Selected · preview' : 'Choose and preview take'}</Text></Pressable>
        </View>;
      })}
    </View>)}
    {!!error && <Text accessibilityRole="alert" className="text-amber-200">{error}</Text>}
  </View>;
}
