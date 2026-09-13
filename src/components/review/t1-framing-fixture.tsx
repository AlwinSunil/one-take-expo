import { useState } from 'react';
import { Image } from 'expo-image';
import { Pressable, Text, View } from 'react-native';

/** Host-rendered geometry comparison only, never a claim of native export parity. */
export function T1FramingFixture() {
  const [enabled, setEnabled] = useState(false);
  return <View className="border-t border-neutral-800 py-4">
    <Text className="text-white font-semibold">Framing geometry fixture</Text>
    <Text className="text-amber-200 py-2">Synthetic host render. Native preview/export integration and live vision are unavailable.</Text>
    <View className="flex-row flex-wrap">
      <Pressable accessibilityRole="button" accessibilityState={{ selected: enabled }} className="p-3" onPress={() => setEnabled(true)}><Text className="text-white">Preview fixture punch-in</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityState={{ selected: !enabled }} className="p-3" onPress={() => setEnabled(false)}><Text className="text-white">Off / reset original frame</Text></Pressable>
    </View>
    <Image style={{ height: 320, width: '100%' }} contentFit="contain" accessibilityLabel={enabled ? 'Synthetic portrait with static crop' : 'Original synthetic portrait'}
      source={enabled ? require('../../../docs/validation/evidence/t1-session-3/framing/portrait-reframed.png') : require('../../../docs/validation/evidence/t1-session-3/framing/portrait-original.png')} />
    <Text className="text-neutral-400 py-2">One crop per cut. Moving or missing tracks fall back to the original. The host renderer consumes the tested framing plan.</Text>
  </View>;
}
