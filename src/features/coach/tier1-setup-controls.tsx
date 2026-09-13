import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  createTier1TipState,
  dismissTier1SetupTip,
  getNextTier1SetupTip,
  getTier1ManualSetupTips,
  revisitTier1SetupTips,
  type Tier1Intent,
  type Tier1ManualSetupTip,
  type Tier1SetupCue,
  type Tier1TipState,
} from './tier1-policy';

export interface Tier1SetupControlsProps {
  /** Optional controlled shot intent. Omitting it keeps this preview self-contained. */
  intent?: Tier1Intent | null;
  onIntentChange?: (intent: Tier1Intent) => void;
  /** Dismissals can be persisted by the owner; local state is used when omitted. */
  dismissedTips?: readonly Tier1SetupCue[];
  onDismissTip?: (cue: Tier1SetupCue) => void;
  onRevisitTips?: (intent: Tier1Intent) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const intentOptions: readonly { value: Tier1Intent; label: string }[] = [
  { value: 'talking-head', label: 'Talking head' },
  { value: 'vlog', label: 'Vlog' },
  { value: 'product-demo', label: 'Product demo' },
  { value: 'intentional-look', label: 'Intentional look' },
];

function mergeDismissals(
  intent: Tier1Intent,
  localState: Tier1TipState,
  controlledDismissals: readonly Tier1SetupCue[] | undefined,
): readonly Tier1SetupCue[] {
  const source = controlledDismissals ?? (localState.intent === intent ? localState.dismissed : []);
  const validCues = new Set(getTier1ManualSetupTips(intent).map(tip => tip.cue));
  return [...new Set(source.filter(cue => validCues.has(cue)))];
}

function IntentPicker({ intent, onChange }: {
  intent: Tier1Intent | null;
  onChange: (intent: Tier1Intent) => void;
}) {
  return (
    <View style={styles.intentPicker} accessibilityLabel="Tier 1 shot intent">
      <Text style={styles.label}>SHOT INTENT</Text>
      <Text style={styles.helper}>Choose what the viewer should notice.</Text>
      <View style={styles.intentOptions}>
        {intentOptions.map(option => {
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

function ManualTipCard({
  tip,
  onDismiss,
  onRevisit,
}: {
  tip: Tier1ManualSetupTip;
  onDismiss: () => void;
  onRevisit?: () => void;
}) {
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>MANUAL SETUP TIP · {tip.title.toUpperCase()}</Text>
        <Text style={styles.message}>{tip.message}</Text>
        <Text style={styles.reason}>{tip.reason}</Text>
        <Text style={styles.action}>Try: {tip.action}</Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss setup tip"
          accessibilityHint="Hide this manual tip until you revisit setup tips"
          onPress={onDismiss}
          style={styles.actionButton}>
          <Text style={styles.actionButtonText}>Dismiss</Text>
        </Pressable>
        {!!onRevisit && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Revisit setup tips"
            onPress={onRevisit}
            style={styles.actionButton}>
            <Text style={styles.secondaryButtonText}>Revisit</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/**
 * Development-only, props-optional setup controls for Tier 1.
 *
 * This component deliberately has no vision/evidence prop. Every card is
 * manual creator guidance with an explicit reason and action. The parent can
 * mount it behind its development route gate while the automatic Tier 0 coach
 * remains the single source of measured suggestions.
 */
export function Tier1SetupControls({
  intent,
  onIntentChange,
  dismissedTips,
  onDismissTip,
  onRevisitTips,
  style,
  testID,
}: Tier1SetupControlsProps = {}) {
  const [localIntent, setLocalIntent] = useState<Tier1Intent | null>(null);
  const [tipState, setTipState] = useState<Tier1TipState>(() => createTier1TipState('talking-head'));
  const selectedIntent = intent !== undefined ? intent : localIntent;

  useEffect(() => {
    if (selectedIntent && tipState.intent !== selectedIntent) {
      setTipState(createTier1TipState(selectedIntent));
    }
  }, [selectedIntent, tipState.intent]);

  const activeDismissals = useMemo(() => selectedIntent
    ? mergeDismissals(selectedIntent, tipState, dismissedTips)
    : [], [dismissedTips, selectedIntent, tipState]);
  const activeTip = selectedIntent
    ? getNextTier1SetupTip({ intent: selectedIntent, dismissed: activeDismissals })
    : null;
  const canRevisit = selectedIntent !== null
    && getTier1ManualSetupTips(selectedIntent).length > 0
    && activeDismissals.length > 0;

  function selectIntent(next: Tier1Intent) {
    setLocalIntent(next);
    setTipState(createTier1TipState(next));
    onIntentChange?.(next);
  }

  function dismissTip(cue: Tier1SetupCue) {
    if (!selectedIntent) return;
    setTipState(previous => dismissTier1SetupTip(previous, selectedIntent, cue));
    onDismissTip?.(cue);
  }

  function revisitTips() {
    if (!selectedIntent) return;
    setTipState(previous => revisitTier1SetupTips(previous, selectedIntent));
    onRevisitTips?.(selectedIntent);
  }

  return (
    <View style={[styles.root, style]} testID={testID}>
      <Text style={styles.previewLabel}>DEVELOPMENT COACHING PREVIEW</Text>
      <Text style={styles.disclaimer}>
        Manual setup guidance only · automatic analysis unavailable.
      </Text>
      <IntentPicker intent={selectedIntent} onChange={selectIntent} />

      {!selectedIntent && (
        <View style={styles.statusCard} accessibilityLiveRegion="polite">
          <Text style={styles.statusTitle}>Choose a shot type</Text>
          <Text style={styles.statusMessage}>
            Pick the intended look to see one short setup tip at a time.
          </Text>
        </View>
      )}

      {selectedIntent === 'intentional-look' && (
        <View style={styles.statusCard} accessibilityLiveRegion="polite">
          <Text style={styles.statusTitle}>Intentional look selected</Text>
          <Text style={styles.statusMessage}>
            Automatic composition suggestions are off. Keep your chosen crop and lighting.
          </Text>
        </View>
      )}

      {!!activeTip && selectedIntent !== 'intentional-look' && (
        <ManualTipCard
          tip={activeTip}
          onDismiss={() => dismissTip(activeTip.cue)}
          onRevisit={canRevisit ? revisitTips : undefined}
        />
      )}

      {selectedIntent !== null
        && selectedIntent !== 'intentional-look'
        && !activeTip
        && (
          <View style={styles.statusCard} accessibilityLiveRegion="polite">
            <Text style={styles.statusTitle}>Setup tips dismissed</Text>
            <Text style={styles.statusMessage}>Revisit them whenever you want another check.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Revisit all setup tips"
              onPress={revisitTips}
              style={styles.revisitButton}>
              <Text style={styles.actionButtonText}>Revisit tips</Text>
            </Pressable>
          </View>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    gap: 10,
  },
  previewLabel: {
    color: '#fcd34d',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  disclaimer: {
    color: '#94a3b8',
    fontSize: 12,
    lineHeight: 18,
  },
  intentPicker: {
    width: '100%',
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff1f',
    backgroundColor: '#00000080',
  },
  label: {
    color: '#cbd5e1',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  helper: {
    color: '#94a3b8',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  intentOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
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
  card: {
    width: '100%',
    alignItems: 'stretch',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff26',
    backgroundColor: '#111827ee',
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
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
  },
  reason: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 17,
  },
  action: {
    color: '#fef3c7',
    fontSize: 12,
    lineHeight: 17,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 4,
  },
  actionButton: {
    minHeight: 44,
    minWidth: 68,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  actionButtonText: {
    color: '#fcd34d',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
  secondaryButtonText: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
  statusCard: {
    width: '100%',
    gap: 4,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff1f',
    backgroundColor: '#111827cc',
  },
  statusTitle: {
    color: '#fef3c7',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  statusMessage: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 18,
  },
  revisitButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 8,
    marginTop: 4,
  },
});
