import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';

export function LiveCaptions({ text, isFinal, status }: {
  text: string; isFinal: boolean; status: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const scroll = useRef<ScrollView>(null);
  const { height } = useWindowDimensions();
  const label = status === 'preparing' ? 'Preparing captions'
    : status === 'error' ? 'Captions unavailable'
    : status === 'delayed' ? 'Captions catching up'
    : !text ? 'Listening' : isFinal ? 'Captions' : 'Live draft';
  return <View className="mx-4 mt-3 rounded-xl bg-black/80 px-3">
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Hide' : 'Show'} live captions`}
      accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
      className="flex-row justify-between items-center py-3" style={{ minHeight: 44 }}>
      <Text className="text-neutral-200 text-xs flex-1">{label}</Text>
      <Text className="text-white text-xs ml-3">{expanded ? 'Hide' : 'Show'}</Text>
    </Pressable>
    {expanded && <ScrollView ref={scroll} style={{ maxHeight: Math.min(160, height * 0.22) }}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
      <Text accessibilityLabel="Live caption text" className="text-white text-base pb-3">
        {status === 'error' ? 'Video is still recording. Captions are unavailable for this take.'
          : text || (status === 'preparing' ? 'Getting ready…' : 'Speak clearly near the microphone to see captions.')}
      </Text>
      {status === 'delayed' && <Text className="text-amber-200 text-xs pb-3">Keep recording. Review the transcript after stopping.</Text>}
    </ScrollView>}
  </View>;
}
