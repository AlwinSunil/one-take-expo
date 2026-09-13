import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

export function VisualHint({ message }: { message: string | null }) {
  return <View pointerEvents="none" className="absolute bottom-16 left-4 right-4 items-center">
    {message && <Animated.View key={message}
      entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
      style={{ maxWidth: 340, borderRadius: 14, backgroundColor: 'rgba(12,12,12,0.78)', paddingHorizontal: 14, paddingVertical: 10 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: '#f3e8c6', fontSize: 13, lineHeight: 18, textAlign: 'center' }}>{message}</Text>
    </Animated.View>}
  </View>;
}
