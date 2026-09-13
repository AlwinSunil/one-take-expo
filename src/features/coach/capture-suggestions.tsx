import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { CoachIntent } from './policy';
import type {
  SuggestionCategory,
  SuggestionEvaluation,
  SuggestionJobDiagnostics,
  SuggestionJobSnapshot,
} from './suggestion-job';

const setupTips: Record<CoachIntent, string> = {
  'talking-head': 'Give your face a little room, face a soft light, and check what is behind you.',
  product: 'Keep the selected product and the demonstrating hands visible, with enough light to see detail.',
  subject: 'Keep the subject you want noticed in view and leave room for its movement.',
  'intentional-look': 'Your chosen crop, lighting, and composition stay in control. Automatic suggestions remain off.',
};

const intents: readonly { value: CoachIntent; label: string }[] = [
  { value: 'talking-head', label: 'Talking head' },
  { value: 'product', label: 'Product' },
  { value: 'subject', label: 'Subject' },
  { value: 'intentional-look', label: 'Intentional look' },
];

const categoryLabels: Record<SuggestionCategory, string> = {
  framing: 'framing',
  'face-position': 'face position',
  'subject-position': 'subject position',
  lighting: 'lighting',
  'camera-angle': 'camera angle',
  exposure: 'exposure',
  background: 'background',
};

export interface CaptureSuggestionsProps {
  /** Current shot intent owned by the camera screen. */
  intent: CoachIntent;
  onIntentChange: (intent: CoachIntent) => void;
  /** Snapshot supplied by the camera-owned request controller. */
  snapshot: SuggestionJobSnapshot;
  /** Camera starts a fresh request explicitly from its Visual Suggestions action. */
  onRequest?: () => void;
  /** Camera retries with the current session/lens identity and evidence. */
  onRetry?: () => void;
  /** Ends a visible result or cancels an active request. */
  onDismiss?: () => void;
  /** Optional development diagnostics, never needed to render advice. */
  diagnostics?: SuggestionJobDiagnostics | null;
  showIntentPicker?: boolean;
  style?: StyleProp<ViewStyle>;
}

function IntentPicker({ intent, onChange }: { intent: CoachIntent; onChange: (intent: CoachIntent) => void }) {
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

function PrimaryAction({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.primaryButton}>
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryAction({ label, accessibilityLabel, onPress }: { label: string; accessibilityLabel: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.secondaryButton}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function unsupportedCopy(categories: readonly SuggestionCategory[]): string {
  if (!categories.length) return '';
  return `Unverified: ${categories.map(category => categoryLabels[category]).join(', ')}.`;
}

function EvaluationCard({ evaluation }: { evaluation: SuggestionEvaluation }) {
  if (evaluation.kind === 'actionable') {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.copy}>
          <Text style={styles.eyebrow}>VISUAL SUGGESTION · {evaluation.title.toUpperCase()}</Text>
          <Text style={styles.message}>{evaluation.message}</Text>
          <Text style={styles.reason}>{evaluation.reason}</Text>
          {!!evaluation.unsupportedCategories?.length && (
            <Text style={styles.uncertainty}>{unsupportedCopy(evaluation.unsupportedCategories)}</Text>
          )}
        </View>
      </View>
    );
  }

  if (evaluation.kind === 'all-good') {
    return (
      <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
        <Text style={styles.statusLabel}>
          {evaluation.evidence.source === 'none'
            ? 'SUGGESTIONS OFF'
            : evaluation.unsupportedCategories?.length
              ? 'MEASURED CUES CLEAR'
              : 'ALL GOOD'}
        </Text>
        <Text style={styles.statusMessage}>{evaluation.message}</Text>
        {!!evaluation.unsupportedCategories?.length && (
          <Text style={styles.uncertainty}>{unsupportedCopy(evaluation.unsupportedCategories)}</Text>
        )}
      </View>
    );
  }

  if (evaluation.kind === 'intentional') {
    return (
      <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
        <Text style={styles.statusLabel}>SUGGESTIONS OFF</Text>
        <Text style={styles.statusMessage}>{evaluation.message}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
      <Text style={styles.statusLabel}>UNAVAILABLE</Text>
      <Text style={styles.statusMessage}>{evaluation.message}</Text>
      {!!evaluation.unsupportedCategories.length && (
        <Text style={styles.uncertainty}>{unsupportedCopy(evaluation.unsupportedCategories)}</Text>
      )}
    </View>
  );
}

function LoadingCard({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
      <View style={styles.copy}>
        <Text style={styles.statusLabel}>CHECKING VISUAL SUGGESTIONS</Text>
        <Text style={styles.statusMessage}>Checking one recent camera view. Recording remains available.</Text>
      </View>
      {onDismiss && <SecondaryAction label="Cancel" accessibilityLabel="Cancel visual suggestions" onPress={onDismiss} />}
    </View>
  );
}

function TerminalActions({
  snapshot,
  onRequest,
  onRetry,
  onDismiss,
}: {
  snapshot: SuggestionJobSnapshot;
  onRequest?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const status = snapshot.status;
  if (status === 'loading' || status === 'idle') return null;
  return (
    <View style={styles.actions}>
      {(status === 'unavailable' || status === 'stale' || status === 'cancelled')
        && snapshot.evaluation?.kind !== 'intentional'
        && onRetry && (
        <PrimaryAction
          label={status === 'stale' ? 'Refresh suggestions' : 'Try again'}
          accessibilityLabel={status === 'stale' ? 'Refresh visual suggestions' : 'Try visual suggestions again'}
          onPress={onRetry}
        />
      )}
      {onDismiss && (
        <SecondaryAction label="Dismiss" accessibilityLabel="Dismiss visual suggestions" onPress={onDismiss} />
      )}
      {status === 'cancelled' && onRequest && (
        <PrimaryAction label="Check this view" accessibilityLabel="Check this view for visual suggestions" onPress={onRequest} />
      )}
    </View>
  );
}

/**
 * Presentational Visual Suggestions surface.
 *
 * This component never starts work from render, mount, an identity change, a
 * preference restore, or a camera-frame update. The camera owner starts the
 * bounded controller from its explicit action and passes the resulting
 * snapshot here.
 */
export function CaptureSuggestions({
  intent,
  onIntentChange,
  snapshot,
  onRequest,
  onRetry,
  onDismiss,
  diagnostics,
  showIntentPicker = true,
  style,
}: CaptureSuggestionsProps) {
  const evaluation = snapshot.evaluation;
  return (
    <View style={[styles.root, style]}>
      {snapshot.status === 'loading' && <LoadingCard onDismiss={onDismiss} />}
      {snapshot.status === 'stale' && (
        <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
          <Text style={styles.statusLabel}>REFRESH NEEDED</Text>
          <Text style={styles.statusMessage}>The camera changed. Check the current view for fresh suggestions.</Text>
        </View>
      )}
      {snapshot.status === 'cancelled' && (
        <View style={[styles.card, styles.statusCard]} accessibilityLiveRegion="polite">
          <Text style={styles.statusLabel}>CANCELLED</Text>
          <Text style={styles.statusMessage}>Visual Suggestions ended without changing your recording.</Text>
        </View>
      )}
      {evaluation && snapshot.status !== 'stale' && snapshot.status !== 'cancelled' && (
        <EvaluationCard evaluation={evaluation} />
      )}
      <TerminalActions snapshot={snapshot} onRequest={onRequest} onRetry={onRetry} onDismiss={onDismiss} />
      {snapshot.status === 'idle' && onRequest && (
        <PrimaryAction label="Check this view" accessibilityLabel="Check this view for visual suggestions" onPress={onRequest} />
      )}
      <Text style={styles.description}>
        Runs only when tapped. It never changes your recording.
      </Text>
      {showIntentPicker && <IntentPicker intent={intent} onChange={onIntentChange} />}
      <View style={styles.manualCard}>
        <Text style={styles.manualTitle}>Creator check</Text>
        <Text style={styles.manualText}>{setupTips[intent]}</Text>
      </View>
      {__DEV__ && diagnostics && (
        <Text style={styles.diagnostics} selectable>
          Suggestion jobs · starts {diagnostics.starts} · evaluations {diagnostics.evaluations} · timeouts {diagnostics.timeouts}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    gap: 12,
    paddingTop: 16,
  },
  description: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 20,
  },
  intentPicker: {
    width: '100%',
    padding: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff1f',
    backgroundColor: '#00000080',
    gap: 6,
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
    minHeight: 72,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
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
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    flexShrink: 1,
  },
  reason: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 19,
    flexShrink: 1,
  },
  uncertainty: {
    color: '#fcd34d',
    fontSize: 12,
    lineHeight: 18,
    flexShrink: 1,
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
    fontSize: 14,
    lineHeight: 21,
  },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#fcd34d',
  },
  primaryButtonText: {
    color: '#111827',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 44,
    minWidth: 76,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff40',
  },
  secondaryButtonText: {
    color: '#fcd34d',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  manualCard: {
    gap: 4,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#171717',
  },
  manualTitle: {
    color: '#e5e7eb',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
  manualText: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 20,
  },
  diagnostics: {
    color: '#64748b',
    fontSize: 11,
    lineHeight: 16,
  },
});
