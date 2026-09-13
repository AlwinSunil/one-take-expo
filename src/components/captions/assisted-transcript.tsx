import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';

import { buildLiveTranscriptView, type LiveTranscriptSegment, type LiveTranscriptStatus } from '@/features/speech-control/live-transcript';
import { splitFillerText } from '@/lib/transcript-fillers';

export interface AssistedTranscriptProps {
  /** Tier 1 is opt-in. The parent must explicitly enable this overlay. */
  enabled?: boolean;
  text?: string;
  isFinal?: boolean;
  status?: LiveTranscriptStatus | string;
  message?: string;
  segments?: readonly LiveTranscriptSegment[];
  defaultCollapsed?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  maxHeight?: number;
  maxCharacters?: number;
  testID?: string;
}

/**
 * A bounded, collapsible live transcript surface for Assisted capture.
 * It is deliberately props-only so capture owns session lifecycle and can
 * keep recording when recognition is delayed or unavailable.
 */
export function AssistedTranscript({
  enabled = false,
  text = '',
  isFinal = false,
  status = 'idle',
  message = '',
  segments = [],
  defaultCollapsed = true,
  collapsed,
  onCollapsedChange,
  maxHeight = 160,
  maxCharacters = 4_000,
  testID,
}: AssistedTranscriptProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const scroll = useRef<ScrollView>(null);
  const { height } = useWindowDimensions();
  const isCollapsed = collapsed ?? internalCollapsed;
  const boundedHeight = Number.isFinite(maxHeight) && maxHeight > 0 ? Math.min(maxHeight, height * 0.24) : Math.min(160, height * 0.24);

  if (!enabled) return null;

  const view = buildLiveTranscriptView({ text, isFinal, status: normalizeStatus(status), message, segments }, maxCharacters);

  function toggle() {
    const next = !isCollapsed;
    if (collapsed === undefined) setInternalCollapsed(next);
    onCollapsedChange?.(next);
  }

  return <View testID={testID} className="mx-4 mt-3 self-center w-[92%] max-w-[480px] rounded-xl bg-black/85 px-3">
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${isCollapsed ? 'Expand' : 'Collapse'} live transcript`}
      accessibilityState={{ expanded: !isCollapsed }}
      onPress={toggle}
      className="min-h-[44px] flex-row items-center justify-between py-3"
    >
      <Text className="flex-1 text-xs text-neutral-200">{view.label}</Text>
      <Text className="ml-3 text-xs text-white">{isCollapsed ? 'Show' : 'Hide'}</Text>
    </Pressable>
    {!isCollapsed && <ScrollView
      ref={scroll}
      nestedScrollEnabled
      showsVerticalScrollIndicator
      style={{ maxHeight: boundedHeight }}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
    >
      {!!view.text && <Text accessibilityLiveRegion="polite" accessibilityLabel={`${view.label} text: ${view.text}`} selectable className="pb-2 text-base text-white">
        {renderFillerText(view.text)}
      </Text>}
      {!view.text && <Text accessibilityLiveRegion="polite" className="pb-2 text-sm text-neutral-200">{view.hint}</Text>}
      {!!view.text && <Text className={view.state === 'unavailable' || view.state === 'delayed' ? 'pb-2 text-xs text-amber-200' : 'pb-2 text-xs text-neutral-400'}>
        {view.hint}{view.truncated ? ' Older transcript text is hidden while recording.' : ''}
      </Text>}
    </ScrollView>}
  </View>;
}

function renderFillerText(text: string) {
  return splitFillerText(text).map((part, index) => part.isFiller
    ? <Text key={`${index}:filler`} style={{ color: '#f87171' }}>{part.text}</Text>
    : <Text key={`${index}:text`}>{part.text}</Text>);
}

function normalizeStatus(status: LiveTranscriptStatus | string): LiveTranscriptStatus {
  if (status === 'error') return 'error';
  if (status === 'unavailable') return 'unavailable';
  if (status === 'preparing' || status === 'listening' || status === 'delayed' || status === 'stopping' || status === 'stopped' || status === 'idle') return status;
  return 'unavailable';
}
