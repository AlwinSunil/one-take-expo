import { PixelRatio, Text, View, useWindowDimensions } from 'react-native';

import { readableFontSize, type PromptDecision } from '@/lib/retake-prompts';

/**
 * The one line of guidance the creator may see during a take.  It renders a
 * decision that `decideRetakePrompt` already made and never decides anything
 * itself.  The live region stays mounted so a screen reader announces the
 * prompt as it appears, and there is no animation, so nothing has to be
 * suppressed for reduced motion.
 */
export function RetakePrompt({ decision }: { decision: PromptDecision | null }) {
  const window = useWindowDimensions();
  const fontScale = window.fontScale || PixelRatio.getFontScale();
  const size = readableFontSize(20, { width: window.width, fontScale });
  const again = decision?.kind === 'again';

  return <View accessibilityLiveRegion="polite" className="w-full">
    {decision && <View className={`rounded-xl px-4 py-3 ${again ? 'bg-white' : 'bg-black/80 border border-neutral-700'}`}>
      <View className="flex-row items-center">
        <Text className={`mr-2 ${again ? 'text-black' : 'text-neutral-300'}`} style={{ fontSize: size }}>
          {again ? '▲' : '◐'}
        </Text>
        <Text accessibilityLabel={decision.text} className={`flex-1 font-semibold ${again ? 'text-black' : 'text-white'}`}
          style={{ fontSize: size, lineHeight: Math.round(size * 1.3) }}>
          {decision.text}
        </Text>
      </View>
      <Text className={`text-xs mt-1 ${again ? 'text-neutral-700' : 'text-neutral-400'}`}>
        {again ? 'Take a breath, then read it again. Keep recording.' : 'Keep going. Nothing is confirmed until the take is checked.'}
      </Text>
    </View>}
  </View>;
}
