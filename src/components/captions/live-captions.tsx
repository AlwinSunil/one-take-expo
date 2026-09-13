import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';

import type { CaptionFailureReason } from '@/lib/live-caption-state';
import { splitFillerText } from '@/lib/transcript-fillers';

/**
 * What the person recording can do about each named failure.  The wording
 * stays specific so a staging mistake is not shown as the same problem as an
 * unsupported phone.
 */
const REASON_GUIDANCE: Record<CaptionFailureReason, string> = {
  'model-missing': 'The offline speech model is not installed in this build.',
  'model-corrupt': 'The offline speech model failed its checksum and was not loaded.',
  'initialization-failed': 'Recognition could not start for this take.',
  'unsupported-device': 'This device cannot run the offline speech model.',
  'permission-denied': 'Captions need microphone access.',
  unknown: 'Recognition stopped for an unknown reason.',
  'audio-focus-lost': 'Another app took the microphone.',
  'audio-route-changed': 'The audio route changed during this take.',
  'lifecycle-interrupted': 'Recording was interrupted.',
};

export function LiveCaptions({ text, isFinal, status, reason, retryable, onRetry }: {
  text: string;
  isFinal: boolean;
  status: string;
  reason?: CaptionFailureReason | null;
  retryable?: boolean;
  onRetry?: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const scroll = useRef<ScrollView>(null);
  const { height } = useWindowDimensions();
  const failed = status === 'unavailable' || status === 'interrupted';
  const label = status === 'preparing' ? 'Preparing captions'
    : status === 'unavailable' ? 'Captions unavailable'
    : status === 'interrupted' ? 'Captions interrupted'
    : status === 'delayed' ? 'Captions catching up'
    : !text ? 'Listening' : isFinal ? 'Captions' : 'Live draft';
  const explanation = reason ? REASON_GUIDANCE[reason] : 'Captions are unavailable for this take.';
  const displayText = failed ? `Video is still recording. ${explanation}`
    : text || (status === 'preparing' ? 'Getting ready…' : 'Speak clearly near the microphone to see captions.');
  return <View className="mx-4 mt-3 rounded-xl bg-black/80 px-3">
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Hide' : 'Show'} live captions`}
      accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
      className="flex-row justify-between items-center py-3" style={{ minHeight: 48 }}>
      <Text className="text-neutral-200 text-xs flex-1">{label}</Text>
      <Text className="text-white text-xs ml-3">{expanded ? 'Hide' : 'Show'}</Text>
    </Pressable>
    {expanded && <ScrollView ref={scroll} style={{ maxHeight: Math.min(160, height * 0.22) }}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
      <Text accessibilityLabel={`Live caption text: ${displayText}`} className="text-white text-base pb-3">
        {renderFillerText(displayText)}
      </Text>
      {failed && retryable && onRetry && <Pressable accessibilityRole="button" accessibilityLabel="Try captions again"
        onPress={onRetry} className="self-start rounded-lg bg-white/15 px-3 mb-3 justify-center" style={{ minHeight: 48 }}>
        <Text className="text-white text-xs">Try captions again</Text>
      </Pressable>}
      {status === 'delayed' && <Text className="text-amber-200 text-xs pb-3">Keep recording. Review the transcript after stopping.</Text>}
    </ScrollView>}
  </View>;
}

function renderFillerText(text: string) {
  return splitFillerText(text).map((part, index) => part.isFiller
    ? <Text key={`${index}:filler`} style={{ color: '#f87171' }}>{part.text}</Text>
    : <Text key={`${index}:text`}>{part.text}</Text>);
}
