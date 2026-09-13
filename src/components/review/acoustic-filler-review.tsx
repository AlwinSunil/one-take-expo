import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { useAcousticFillerReview } from '@/hooks/use-acoustic-filler-review';
import type { AcousticFillerResult } from '@/features/speech-control/acoustic-fillers';
import type { Project } from '@/lib/session';

const EVENTS_PER_PAGE = 50;
type AcousticFillerEvent = AcousticFillerResult['events'][number];
type AcousticFillerSource = { id: string; uri: string; duration?: number; label: string };

export interface AcousticFillerReviewProps {
  project: Project;
  onChange: (project: Project) => Promise<void> | void;
  /** Preview a short source-local context window around a detector event. */
  onPreviewSource: (sourceId: string, timeSeconds: number) => void;
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  return `${value.toFixed(1)}s`;
}

function resultSourceLabel(
  sourceId: string | undefined,
  sources: ReadonlyArray<Pick<AcousticFillerSource, 'id' | 'label'>>,
): string {
  if (!sourceId) return 'saved source';
  return sources.find(source => source.id === sourceId)?.label ?? sourceId;
}

function AcousticFillerReviewBody({ project, onChange, onPreviewSource }: AcousticFillerReviewProps) {
  const review = useAcousticFillerReview(project, onChange);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const result = review.result;
  const resultMatchesSource = !!result && result.sourceId === review.sourceId;
  const currentEvents = useMemo(
    () => resultMatchesSource && result?.status === 'ready' ? result.events : [],
    [result, resultMatchesSource],
  );
  const pageCount = Math.max(1, Math.ceil(currentEvents.length / EVENTS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleEvents = currentEvents.slice(
    currentPage * EVENTS_PER_PAGE,
    (currentPage + 1) * EVENTS_PER_PAGE,
  );
  const currentSourceLabel = resultSourceLabel(review.sourceId, review.sources);

  useEffect(() => {
    setPage(0);
    setMessage('');
  }, [review.sourceId, result?.sourceId, result?.analysisRevision]);

  function togglePanel(): void {
    setExpanded(value => !value);
    setMessage('');
  }

  async function setDismissed(eventId: string, dismissed: boolean): Promise<void> {
    if (busyEventId) return;
    setBusyEventId(eventId);
    setMessage('');
    try {
      await review.setDismissed(eventId, dismissed);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save this filler marker choice.');
    } finally {
      setBusyEventId(null);
    }
  }

  async function analyze(): Promise<void> {
    setMessage('');
    try {
      await review.analyze();
    } catch (error) {
      // The hook exposes failed state for expected detector errors. This message
      // covers a provider that rejects before it can publish that state.
      setMessage(error instanceof Error ? error.message : 'Acoustic analysis could not start.');
    }
  }

  async function cancel(): Promise<void> {
    setMessage('');
    try {
      await review.cancel();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Acoustic analysis could not be cancelled.');
    }
  }

  async function openLicense(url: string): Promise<void> {
    try {
      await Linking.openURL(url);
    } catch {
      setMessage('The license link could not be opened.');
    }
  }

  return <View accessibilityLabel="Development acoustic filler review" className="border-t border-neutral-800 mt-4 pt-3">
    <View className="flex-row items-center justify-between gap-3">
      <View className="flex-1">
        <Text className="text-amber-200 text-xs font-semibold">Development tool</Text>
        <Text className="text-white text-base font-semibold mt-1">Acoustic filler detection</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Hide acoustic filler detection' : 'Try acoustic filler detection'}
        accessibilityState={{ expanded }}
        onPress={togglePanel}
        style={{ minHeight: 48, minWidth: 48 }}
        className="items-center justify-center rounded-lg bg-neutral-800 px-3 active:bg-neutral-700"
      >
        <Text className="text-white text-xs font-semibold">{expanded ? 'Hide' : 'Try acoustic filler detection'}</Text>
      </Pressable>
    </View>

    {!expanded && <Text className="text-neutral-400 text-xs mt-2">
      Saved-audio review is opt-in and does not run while recording.
    </Text>}

    {expanded && <View className="mt-3">
      <Text className="text-neutral-400 text-xs">
        Analyzes the saved audio after recording. It only marks possible “um” and “uh” sounds;
        detector boundaries are unverified and no media is trimmed here.
      </Text>
      <View className="mt-3 rounded-lg bg-neutral-900 px-3 py-2">
        <Text className="text-neutral-500 text-xs">Development model license</Text>
        <View className="flex-row flex-wrap gap-2 mt-1">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Powered by Desert Ant Labs"
            onPress={() => { void openLicense('https://desertant.com'); }}
            style={{ minHeight: 44 }}
            className="justify-center active:opacity-70"
          >
            <Text className="text-sky-300 text-xs underline">Powered by Desert Ant Labs</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open Desert Ant Labs model license"
            onPress={() => { void openLicense('https://license.desertant.com/1.0'); }}
            style={{ minHeight: 44 }}
            className="justify-center active:opacity-70"
          >
            <Text className="text-sky-300 text-xs underline">View license</Text>
          </Pressable>
        </View>
      </View>

      {review.sources.length > 1 && <View className="mt-3">
        <Text className="text-neutral-300 text-xs font-semibold mb-2">Source</Text>
        <View className="flex-row flex-wrap gap-2">
          {review.sources.map((source: AcousticFillerSource) => {
            const selected = source.id === review.sourceId;
            return <Pressable
              key={source.id}
              accessibilityRole="button"
              accessibilityLabel={`Analyze ${source.label}`}
              accessibilityState={{ selected, disabled: review.status === 'running' }}
              disabled={review.status === 'running'}
              onPress={() => { review.setSourceId(source.id); setPage(0); setMessage(''); }}
              style={{ minHeight: 44 }}
              className={`justify-center rounded-lg border px-3 py-2 ${selected ? 'border-amber-300 bg-amber-950' : 'border-neutral-700 bg-neutral-900'} disabled:opacity-40`}
            >
              <Text className={selected ? 'text-amber-100 text-xs font-semibold' : 'text-neutral-300 text-xs'}>
                {source.label}
              </Text>
            </Pressable>;
          })}
        </View>
      </View>}

      {review.available === null && <Text className="text-neutral-300 text-xs mt-3">
        Checking whether this development build can analyze saved audio…
      </Text>}
      {review.available === false && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-3">
        Acoustic filler detection is unavailable{review.unavailableReason ? `: ${review.unavailableReason}` : '.'}
      </Text>}

      {review.available === true && <View className="mt-3">
        {review.status === 'running' ? <View className="flex-row flex-wrap items-center gap-2">
          <Text accessibilityLiveRegion="polite" className="text-amber-200 text-xs flex-1">
            Analyzing {currentSourceLabel}…
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel acoustic filler analysis"
            onPress={() => { void cancel(); }}
            style={{ minHeight: 48 }}
            className="rounded-lg border border-neutral-700 px-3 py-3 active:bg-neutral-800"
          >
            <Text className="text-neutral-200 text-xs">Cancel</Text>
          </Pressable>
        </View> : <Pressable
          accessibilityRole="button"
          accessibilityLabel={review.status === 'failed' || review.status === 'cancelled' ? 'Retry acoustic filler analysis' : 'Analyze saved audio for fillers'}
          onPress={() => { void analyze(); }}
          style={{ minHeight: 48 }}
          className="items-center justify-center rounded-lg bg-amber-700 px-4 py-3 active:bg-amber-600 disabled:opacity-40"
        >
          <Text className="text-white text-xs font-semibold">
            {review.status === 'failed' || review.status === 'cancelled' ? 'Retry analysis' : 'Analyze audio'}
          </Text>
        </Pressable>}

        {review.status === 'failed' && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-2">
          {review.error ?? 'Acoustic analysis failed. The saved original is still available.'}
        </Text>}
        {!!review.error && review.status !== 'failed' && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-2">{review.error}</Text>}
        {review.status === 'cancelled' && <Text className="text-neutral-400 text-xs mt-2">
          Analysis cancelled. The saved original was not changed.
        </Text>}
        {!!message && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-2">{message}</Text>}

        {review.status === 'ready' && !resultMatchesSource && <Text className="text-neutral-300 text-xs mt-3">
          This source has not been analyzed yet. Tap Analyze audio to check it.
        </Text>}
        {review.status === 'ready' && resultMatchesSource && result?.status === 'unavailable' && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-3">
          Acoustic analysis was unavailable for {currentSourceLabel}{result.unavailableReason ? `: ${result.unavailableReason}` : '.'}
        </Text>}
        {review.status === 'ready' && resultMatchesSource && result?.status === 'ready' && !currentEvents.length && <Text className="text-neutral-300 text-xs mt-3">
          No possible “um” or “uh” detections were found in {currentSourceLabel}.
        </Text>}

        {review.status === 'ready' && resultMatchesSource && result?.status === 'ready' && !!currentEvents.length && <View className="mt-3">
          <View className="flex-row items-baseline justify-between gap-2">
            <Text className="text-neutral-300 text-xs font-semibold">Possible fillers</Text>
            <Text className="text-neutral-500 text-xs">{currentEvents.length} found</Text>
          </View>
          <Text className="text-neutral-500 text-xs mt-1">Analyzed source · {currentSourceLabel}</Text>
          <Text className="text-neutral-500 text-xs mt-1">
            Keep or dismiss each marker after listening. These choices never remove footage.
          </Text>

          {visibleEvents.map((event: AcousticFillerEvent) => {
            const dismissed = review.dismissedEventIds.includes(event.id);
            const eventBusy = busyEventId === event.id;
            return <View key={event.id} className="border-t border-neutral-800 py-3 mt-2">
              <View className="flex-row flex-wrap items-center gap-2">
                <Text className="text-white text-sm font-semibold flex-1">
                  Possible {event.label}
                </Text>
                <Text className={dismissed ? 'text-neutral-500 text-xs' : 'text-amber-200 text-xs'}>
                  {dismissed ? 'Dismissed' : 'Retained'}
                </Text>
              </View>
              <Text className="text-neutral-300 text-xs mt-1">
                {formatSeconds(event.startSeconds)}–{formatSeconds(event.endSeconds)} · acoustic boundary unverified
              </Text>
              <Text className="text-neutral-500 text-xs mt-1">
                Score {Number.isFinite(event.score) ? event.score.toFixed(2) : 'unknown'} · listen before deciding
              </Text>
              <View className="flex-row flex-wrap gap-2 mt-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Play context for possible ${event.label} at ${formatSeconds(event.startSeconds)}`}
                  disabled={eventBusy}
                  onPress={() => onPreviewSource(result.sourceId, event.startSeconds)}
                  style={{ minHeight: 44 }}
                  className="rounded-lg bg-neutral-800 px-3 py-3 active:bg-neutral-700 disabled:opacity-40"
                >
                  <Text className="text-neutral-200 text-xs">Play context</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Keep possible ${event.label}`}
                  accessibilityState={{ selected: !dismissed, disabled: eventBusy || !dismissed }}
                  disabled={eventBusy || !dismissed}
                  onPress={() => { void setDismissed(event.id, false); }}
                  style={{ minHeight: 44 }}
                  className="rounded-lg border border-neutral-700 px-3 py-3 active:bg-neutral-800 disabled:opacity-40"
                >
                  <Text className="text-neutral-300 text-xs">Keep</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Dismiss possible ${event.label}`}
                  accessibilityState={{ selected: dismissed, disabled: eventBusy || dismissed }}
                  disabled={eventBusy || dismissed}
                  onPress={() => { void setDismissed(event.id, true); }}
                  style={{ minHeight: 44 }}
                  className="rounded-lg border border-neutral-700 px-3 py-3 active:bg-neutral-800 disabled:opacity-40"
                >
                  <Text className="text-neutral-300 text-xs">Dismiss</Text>
                </Pressable>
              </View>
            </View>;
          })}

          {pageCount > 1 && <View className="flex-row flex-wrap gap-2 mt-2">
            {currentPage > 0 && <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show previous acoustic filler markers"
              onPress={() => setPage(value => Math.max(0, value - 1))}
              style={{ minHeight: 44 }}
              className="rounded-lg border border-neutral-700 px-3 py-3 active:bg-neutral-800"
            >
              <Text className="text-neutral-300 text-xs">Previous 50</Text>
            </Pressable>}
            {currentPage < pageCount - 1 && <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show more acoustic filler markers"
              onPress={() => setPage(value => Math.min(pageCount - 1, value + 1))}
              style={{ minHeight: 44 }}
              className="rounded-lg border border-neutral-700 px-3 py-3 active:bg-neutral-800"
            >
              <Text className="text-neutral-300 text-xs">Show more · {currentEvents.length - (currentPage + 1) * EVENTS_PER_PAGE} remaining</Text>
            </Pressable>}
          </View>}
        </View>}
      </View>}
    </View>}
  </View>;
}

/**
 * Development-only review UI. The wrapper keeps the hook out of production
 * bundles and ensures the detector cannot start without an explicit tap.
 */
export function AcousticFillerReview(props: AcousticFillerReviewProps) {
  if (!__DEV__) return null;
  return <AcousticFillerReviewBody {...props} />;
}

export { formatSeconds as formatAcousticFillerSeconds };

export default AcousticFillerReview;
