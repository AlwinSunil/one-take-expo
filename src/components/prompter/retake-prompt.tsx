import { useEffect } from 'react';
import { AccessibilityInfo, PixelRatio, Text, View, useWindowDimensions } from 'react-native';

import { readableFontSize, type PromptDecision } from '@/lib/retake-prompts';

/**
 * The one line of guidance the creator may see.  It renders a decision that
 * `decideRetakePrompt` already made and never decides anything itself.  There
 * is no animation, so nothing has to be suppressed for reduced motion.
 *
 * `accessibilityLiveRegion` is Android-only, so the text is also announced
 * explicitly when it changes, which covers iOS and VoiceOver.  A `deferred`
 * decision is a quiet count shown during the take; the full batched list only
 * arrives once the take has ended.
 */
export function RetakePrompt({ decision }: { decision: PromptDecision | null }) {
  const window = useWindowDimensions();
  const fontScale = window.fontScale || PixelRatio.getFontScale();
  const size = readableFontSize(20, { width: window.width, fontScale });
  const again = decision?.kind === 'again';
  const deferred = decision?.kind === 'deferred';
  const text = decision?.text ?? '';

  useEffect(() => {
    if (text) AccessibilityInfo.announceForAccessibility(text);
  }, [text]);

  if (deferred) {
    return <View accessibilityLiveRegion="polite" className="w-full flex-row justify-end">
      <Text accessibilityLabel={text} numberOfLines={1} className="text-neutral-300 text-xs px-2 py-1 rounded-lg bg-black/70">
        ◐ {text}
      </Text>
    </View>;
  }

  return <View accessibilityLiveRegion="polite" className="w-full">
    {decision && <View className={`rounded-xl px-4 py-3 ${again ? 'bg-white' : 'bg-black/80 border border-neutral-700'}`}>
      <View className="flex-row items-center">
        <Text className={`mr-2 ${again ? 'text-black' : 'text-neutral-300'}`} style={{ fontSize: size }}>
          {again ? '▲' : '◐'}
        </Text>
        <Text accessibilityLabel={text} className={`flex-1 font-semibold ${again ? 'text-black' : 'text-white'}`}
          style={{ fontSize: size, lineHeight: Math.round(size * 1.3) }}>
          {text}
        </Text>
      </View>
      <Text className={`text-xs mt-1 ${again ? 'text-neutral-700' : 'text-neutral-400'}`}>
        {again ? 'Take a breath, then read it again. Keep recording.' : 'Listen back to these before you use this take.'}
      </Text>
    </View>}
  </View>;
}
