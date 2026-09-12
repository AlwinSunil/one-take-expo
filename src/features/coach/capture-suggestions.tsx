import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CompositionCoach } from './composition-coach';
import type { CoachCue, CoachIntent, CoachVisionEvidence } from './policy';

const setupTips: Record<CoachIntent, string> = {
  'talking-head': 'Check headroom, face a soft light, and look behind you for objects crossing your outline. Centered framing is fine.',
  product: 'Keep the selected product and the hands demonstrating it visible. Check reflections and choose a background that makes the product easy to see.',
  subject: 'Choose what the viewer should notice, leave room for its movement, and check whether the background helps tell the story.',
  'intentional-look': 'Keep your chosen crop, lighting, and composition. Automatic composition advice stays off for this look.',
};

/** Setup guidance is explicitly manual until each automatic cue is validated. */
export function CaptureSuggestions({ enabled, onEnabledChange, intent, onIntentChange, evidence, nowMs }: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  intent: CoachIntent;
  onIntentChange: (intent: CoachIntent) => void;
  evidence: CoachVisionEvidence;
  nowMs: number;
}) {
  const [shown, setShown] = useState<{ intent: CoachIntent; cue: CoachCue; at: number } | null>(null);
  const current = shown?.intent === intent ? shown : null;
  return <View style={{ gap: 16, paddingTop: 16 }}>
    <Pressable accessibilityRole="switch" accessibilityLabel="Composition suggestions"
      accessibilityState={{ checked: enabled }} onPress={() => onEnabledChange(!enabled)}
      className="min-h-12 rounded-xl border border-neutral-700 px-4 py-3">
      <Text className="text-white text-sm">Composition suggestions · {enabled ? 'On' : 'Off'}</Text>
    </Pressable>
    {enabled && <>
      <CompositionCoach enabled intent={intent} onIntentChange={onIntentChange}
        evidence={evidence} nowMs={nowMs} recording={false} speechState="silent"
        takeId={`setup:${intent}`} activeCue={current?.cue ?? null} lastPromptAtMs={current?.at ?? null}
        onPromptShown={cue => setShown({ intent, cue, at: nowMs })} />
      <View className="rounded-xl bg-neutral-900 p-4">
        <Text className="text-neutral-200 text-sm font-semibold">Manual setup tips</Text>
        <Text className="text-neutral-300 text-sm leading-6 mt-2">{setupTips[intent]}</Text>
      </View>
    </>}
  </View>;
}
