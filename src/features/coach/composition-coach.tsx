import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  chooseCoachView,
  createCoachTakeState,
  dismissCoachCue,
  getCoachTakeDismissals,
  type CoachCue,
  type CoachDecision,
  type CoachIntent,
  type CoachPolicyInput,
  type CoachVisionEvidence,
  type SpeechState,
} from './policy';

export interface CompositionCoachProps {
  enabled: boolean;
  /** Null asks the creator to choose an intent before analysis can speak. */
  intent: CoachIntent | null;
  evidence: CoachVisionEvidence;
  recording?: boolean;
  speechState?: SpeechState;
  betweenLines?: boolean;
  /** Pass the frame producer's clock for deterministic policy decisions. */
  nowMs: number;
  lastPromptAtMs?: number | null;
  /** Identity paired with lastPromptAtMs, allowing that cue to remain stable during cooldown. */
  activeCue: CoachCue | null;
  dismissedCues?: readonly CoachCue[];
  /** A new take clears locally dismissed cues. */
  takeId: string;
  onDismiss?: (cue: CoachCue) => void;
  /** Called once when a new prompt cue becomes visible. */
  onPromptShown?: (cue: CoachCue) => void;
  onIntentChange?: (intent: CoachIntent) => void;
  showIntentPicker?: boolean;
  style?: StyleProp<ViewStyle>;
}

const intents: readonly { value: CoachIntent; label: string }[] = [
  { value: 'talking-head', label: 'Talking head' },
  { value: 'product', label: 'Product' },
  { value: 'subject', label: 'Subject' },
  { value: 'intentional-look', label: 'Intentional look' },
];

function IntentPicker({ intent, onChange }: { intent: CoachIntent | null; onChange: (intent: CoachIntent) => void }) {
  return (
    <View style={styles.intentPicker} accessibilityLabel="Shot intent">
      <Text style={styles.intentLabel}>SHOT INTENT</Text>
      <View style={styles.intentOptions}>
        {intents.map(option => {
          const selected = intent === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              style={[styles.intentOption, selected && styles.intentOptionSelected]}>
              <Text style={[styles.intentOptionText, selected && styles.intentOptionTextSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function DecisionCard({ decision, onDismiss }: { decision: CoachDecision; onDismiss: (cue: CoachCue) => void }) {
  if (decision.kind === 'hidden') return null;

  if (decision.kind === 'prompt') {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.copy}>
          <Text style={styles.eyebrow}>SUGGESTION · {decision.title.toUpperCase()}</Text>
          <Text style={styles.message} numberOfLines={2}>{decision.message}</Text>
          <Text style={styles.reason} numberOfLines={2}>{decision.reason}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss suggestion"
          accessibilityHint="Hide this suggestion for the current take"
          onPress={() => onDismiss(decision.cue)}
          style={styles.dismissButton}>
          <Text style={styles.dismissText}>Dismiss</Text>
        </Pressable>
      </View>
    );
  }

  if (decision.kind === 'all-good') {
    return (
      <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
        <Text style={styles.statusLabel}>READY</Text>
        <Text style={styles.statusMessage} numberOfLines={2}>{decision.message}</Text>
      </View>
    );
  }

  if (decision.kind === 'intentional') {
    return (
      <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
        <Text style={styles.statusLabel}>SUGGESTIONS OFF</Text>
        <Text style={styles.statusMessage} numberOfLines={2}>{decision.message}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
      <Text style={styles.statusLabel}>SUGGESTIONS</Text>
      <Text style={styles.statusMessage} numberOfLines={2}>{decision.message}</Text>
    </View>
  );
}

/**
 * Non-blocking, one-card viewfinder coaching.
 *
 * Place this in normal layout flow below script/caption content and above the
 * recording controls. It has no camera, timer or inference side effects.
 */
export function CompositionCoach({
  enabled,
  intent,
  evidence,
  recording = false,
  speechState = 'silent',
  betweenLines = false,
  nowMs,
  lastPromptAtMs = null,
  activeCue,
  dismissedCues = [],
  takeId,
  onDismiss,
  onPromptShown,
  onIntentChange,
  showIntentPicker = true,
  style,
}: CompositionCoachProps) {
  const [takeState, setTakeState] = useState(() => createCoachTakeState(takeId));

  const dismissed = useMemo(() => {
    const values = new Set<CoachCue>(dismissedCues);
    for (const cue of getCoachTakeDismissals(takeState, takeId)) values.add(cue);
    return [...values];
  }, [dismissedCues, takeId, takeState]);

  const policyInput: CoachPolicyInput = {
    enabled,
    intent,
    recording,
    speechState,
    betweenLines,
    nowMs,
    lastPromptAtMs,
    activeCue,
    dismissed,
    evidence,
  };
  const decision = useMemo(() => chooseCoachView(policyInput), [
    enabled,
    intent,
    recording,
    speechState,
    betweenLines,
    nowMs,
    lastPromptAtMs,
    dismissed,
    evidence,
  ]);

  const promptCue = decision.kind === 'prompt' ? decision.cue : null;
  const promptKey = promptCue
    ? `${takeId ?? 'current-take'}:${promptCue}`
    : null;
  const shownPromptKey = useRef<string | null>(null);
  useEffect(() => {
    if (!promptKey) {
      shownPromptKey.current = null;
      return;
    }
    if (shownPromptKey.current === promptKey) return;
    shownPromptKey.current = promptKey;
    if (promptCue) onPromptShown?.(promptCue);
  }, [onPromptShown, promptCue, promptKey]);

  if (!enabled) return null;

  const canChooseIntent = showIntentPicker && !recording && !!onIntentChange;
  const picker = canChooseIntent && onIntentChange
    ? <IntentPicker intent={intent} onChange={onIntentChange} />
    : null;

  function dismiss(cue: CoachCue) {
    setTakeState(previous => dismissCoachCue(previous, takeId, cue));
    onDismiss?.(cue);
  }

  if (decision.kind === 'hidden') {
    if (!picker) return null;
    return <View style={[styles.root, style]}>{picker}</View>;
  }

  return (
    <View style={[styles.root, style]}>
      {picker}
      <DecisionCard decision={decision} onDismiss={dismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    gap: 8,
  },
  card: {
    minHeight: 64,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff26',
    backgroundColor: '#111827ee',
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  eyebrow: {
    color: '#fcd34d',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  message: {
    color: '#ffffff',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    flexShrink: 1,
  },
  reason: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 17,
    flexShrink: 1,
  },
  dismissButton: {
    minHeight: 44,
    minWidth: 64,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  dismissText: {
    color: '#fcd34d',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
  statusCard: {
    alignItems: 'flex-start',
  },
  statusLabel: {
    color: '#fcd34d',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  statusMessage: {
    flex: 1,
    color: '#e5e7eb',
    fontSize: 13,
    lineHeight: 18,
  },
  intentPicker: {
    width: '100%',
    padding: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff1f',
    backgroundColor: '#00000080',
  },
  intentLabel: {
    color: '#94a3b8',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  intentOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  intentOption: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff30',
    backgroundColor: '#111827cc',
  },
  intentOptionSelected: {
    borderColor: '#fcd34d',
    backgroundColor: '#fcd34d1f',
  },
  intentOptionText: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
  intentOptionTextSelected: {
    color: '#fef3c7',
  },
});
