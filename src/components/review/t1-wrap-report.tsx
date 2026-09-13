import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { Project } from '@/lib/session';
import type { FootageReference } from '@/lib/t1-contracts';
import {
  acknowledgeWrapAnyway,
  buildWrapReport,
  clearWrapAcknowledgement,
  type WrapActionReport,
  type WrapFootage,
  type WrapLineReport,
} from '@/lib/t1-wrap';

export interface T1WrapReportProps {
  project: Project;
  onChange: (project: Project) => Promise<void> | void;
  onReviewFootage?: (footage: FootageReference) => void;
  onPickup?: (lineId: string) => void;
  onConfirmAction?: (actionId: string, confirmed: boolean) => void;
  /** Tier 1 remains hidden until the common release gate explicitly enables it. */
  enabled?: boolean;
  disabled?: boolean;
  /** Injectable time for deterministic development replays. */
  acknowledgedAt?: number;
}

function statusText(status: string): string {
  switch (status) {
    case 'covered': return 'Covered';
    case 'needed': return 'Needs recording';
    case 'pending': return 'Checking';
    case 'unavailable': return 'Unavailable';
    case 'satisfied': return 'Confirmed by supplied evidence';
    case 'missing': return 'Missing';
    case 'uncertain': return 'Uncertain';
    case 'not-required': return 'Not required';
    default: return 'Unknown';
  }
}

function ActionRow({ action, onConfirm }: {
  action: WrapActionReport;
  onConfirm?: (actionId: string, confirmed: boolean) => void;
}) {
  return <View className="border-t border-neutral-800 py-3">
    <View className="flex-row flex-wrap items-center gap-2">
      <Text className="text-white text-sm flex-1">{action.text}</Text>
      <Text className={action.confirmed ? 'text-emerald-300 text-xs' : action.required ? 'text-amber-200 text-xs' : 'text-neutral-400 text-xs'}>
        {action.confirmed ? 'Manually confirmed' : action.required ? 'Needs manual confirmation' : 'Optional · not confirmed'}
      </Text>
    </View>
    {action.required && !action.confirmed && onConfirm && <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Confirm required action ${action.text}`}
      accessibilityState={{ disabled: false }}
      onPress={() => onConfirm(action.id, true)}
      className="self-start bg-neutral-800 rounded-lg px-3 py-3 mt-2 active:bg-neutral-700">
      <Text className="text-white text-xs">Confirm action done</Text>
    </Pressable>}
    {action.required && action.confirmed && onConfirm && <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Undo confirmation for required action ${action.text}`}
      accessibilityState={{ disabled: false }}
      onPress={() => onConfirm(action.id, false)}
      className="self-start px-3 py-3 mt-2 active:opacity-70">
      <Text className="text-neutral-300 text-xs">Undo confirmation</Text>
    </Pressable>}
    {action.required && !action.confirmed && !onConfirm && <Text className="text-neutral-500 text-xs mt-2">
      Confirm this action in the capture or review controls.
    </Text>}
  </View>;
}

function FootageButton({ footage, onReview }: {
  footage: WrapFootage;
  onReview?: (footage: FootageReference) => void;
}) {
  const available = footage.playable && !!onReview;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={available ? `Review footage from ${footage.t0.toFixed(1)} to ${footage.t1.toFixed(1)} seconds` : 'Supporting footage unavailable'}
    accessibilityState={{ disabled: !available }}
    disabled={!available}
    onPress={() => { if (available) onReview(footage); }}
    className="self-start px-3 py-2 rounded-lg bg-neutral-800 disabled:opacity-40">
    <Text className="text-neutral-200 text-xs">
      {available ? `Review ${footage.t0.toFixed(1)}–${footage.t1.toFixed(1)}s` : 'Footage unavailable'}
    </Text>
  </Pressable>;
}

function LineRow({ line, onReview, onPickup }: {
  line: WrapLineReport;
  onReview?: (footage: FootageReference) => void;
  onPickup?: (lineId: string) => void;
}) {
  const hasPlayableFootage = line.evidence.some(footage => footage.playable);
  const needsPickup = line.coverage !== 'covered' || line.mustSay.status === 'missing';
  return <View className="border-t border-neutral-800 py-4">
    <Text selectable className="text-white text-sm leading-5">{line.spokenText}</Text>
    <View className="flex-row flex-wrap gap-x-3 gap-y-1 mt-1">
      <Text className={line.coverage === 'covered' ? 'text-emerald-300 text-xs' : 'text-amber-200 text-xs'}>
        Coverage · {statusText(line.coverage)}
      </Text>
      <Text className={line.mustSay.status === 'satisfied' || line.mustSay.status === 'not-required' ? 'text-neutral-300 text-xs' : 'text-amber-200 text-xs'}>
        Must-say · {line.mustSay.required === null ? 'Unknown' : statusText(line.mustSay.status)}
      </Text>
      <Text className="text-neutral-400 text-xs">{line.takeCount} {line.takeCount === 1 ? 'take' : 'takes'}</Text>
    </View>
    {!!line.reasons.length && <View className="mt-2">
      {line.reasons.map(reason => <Text key={reason.id} className="text-amber-200 text-xs">{reason.message}</Text>)}
    </View>}
    {!!line.evidence.length && <View className="flex-row flex-wrap gap-2 mt-3">
      {line.evidence.map((footage, index) => <FootageButton key={`${footage.recordingId}:${footage.t0}:${footage.t1}:${index}`} footage={footage} onReview={onReview} />)}
    </View>}
    {needsPickup && <View className="mt-2">
      {onPickup ? <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Record a pickup for ${line.spokenText}`}
        onPress={() => onPickup(line.id)}
        className="self-start px-3 py-3 rounded-lg border border-neutral-700 active:bg-neutral-800">
        <Text className="text-white text-xs">Record pickup</Text>
      </Pressable> : <Text className="text-neutral-500 text-xs">Pickup unavailable in this build.</Text>}
    </View>}
    {!hasPlayableFootage && line.evidence.length > 0 && <Text className="text-neutral-500 text-xs mt-2">
      Supporting footage is saved as a reference but cannot be played from this project.
    </Text>}
  </View>;
}

export function T1WrapReport({
  project,
  onChange,
  onReviewFootage,
  onPickup,
  onConfirmAction,
  enabled = false,
  disabled = false,
  acknowledgedAt,
}: T1WrapReportProps) {
  const [message, setMessage] = useState('');
  if (!enabled) return null;

  const report = buildWrapReport(project);
  const status = report.qualifiedAllClear
    ? 'Ready to wrap'
    : report.wrapAllowed
      ? 'Wrap anyway acknowledged'
      : 'Review needed before wrapping';

  async function wrapAnyway() {
    if (disabled) return;
    try {
      const next = acknowledgeWrapAnyway(project, acknowledgedAt);
      await onChange(next);
      setMessage('Wrap anyway saved. The remaining flags stay attached to this project.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Wrap anyway could not be saved.');
    }
  }

  async function startFreshReview() {
    if (disabled) return;
    try {
      await onChange(clearWrapAcknowledgement(project));
      setMessage('The old Wrap anyway acknowledgement was cleared. Review the current evidence again.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The old acknowledgement could not be cleared.');
    }
  }

  return <View accessibilityLabel="Tier 1 wrap report" className="border-t border-neutral-800 mt-4 pt-4">
    <View className="flex-row flex-wrap items-start justify-between gap-3">
      <View className="flex-1">
        <Text className="text-white text-base font-semibold">Wrap report</Text>
        <Text accessibilityRole="header" className={report.qualifiedAllClear ? 'text-emerald-300 text-sm mt-1' : 'text-amber-200 text-sm mt-1'}>
          {status}
        </Text>
      </View>
      <Text className="text-neutral-400 text-xs">{report.lines.length} {report.lines.length === 1 ? 'line' : 'lines'}</Text>
    </View>
    {report.evidenceProvider === 'fixture' && <Text className="text-sky-300 text-xs mt-3">
      Development fixture · this state is not evidence from a real recording.
    </Text>}
    {!!report.evidenceError && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-3">{report.evidenceError}</Text>}
    <Text className="text-neutral-300 text-xs mt-3">
      Recording to wrap: {report.recordingToWrapLabel}{report.recordingToWrapMs === null ? ' · capture timing unavailable' : ''}
    </Text>
    {!report.mediaAvailable && <Text className="text-amber-200 text-xs mt-2">
      The original recording is unavailable. Saved decisions remain visible, but footage cannot be played or counted as covered.
    </Text>}

    <View className="mt-4">
      <Text className="text-neutral-300 text-xs font-semibold">Spoken lines</Text>
      {report.lines.length ? report.lines.map(line => <LineRow
        key={line.id}
        line={line}
        onReview={onReviewFootage}
        onPickup={onPickup}
      />) : <Text className="text-neutral-500 text-xs mt-3">No spoken lines are available.</Text>}
    </View>

    <View className="mt-4">
      <Text className="text-neutral-300 text-xs font-semibold">Required actions · manual confirmation</Text>
      {report.requiredActions.length ? report.requiredActions.map(action => <ActionRow key={action.id} action={action} onConfirm={onConfirmAction} />) : <Text className="text-neutral-500 text-xs mt-3">No required actions.</Text>}
      {!!report.optionalActions.length && <View className="mt-3">
        <Text className="text-neutral-400 text-xs">Optional actions</Text>
        {report.optionalActions.map(action => <ActionRow key={action.id} action={action} onConfirm={onConfirmAction} />)}
      </View>}
    </View>

    {!!report.remainingFlags.length && <View className="mt-4 bg-neutral-950 rounded-xl p-3">
      <Text className="text-amber-200 text-xs font-semibold">Remaining flags</Text>
      {report.flags.map(flag => <Text key={`${flag.source}:${flag.id}`} className="text-neutral-300 text-xs mt-2">
        {flag.source === 'acknowledged' ? 'Previously acknowledged · ' : ''}{flag.message}
      </Text>)}
    </View>}

    {!report.qualifiedAllClear && !report.acknowledgementValid && !!report.evidenceRevision && !report.evidenceError && !!report.currentFlagIds.length && <Pressable
      accessibilityRole="button"
      accessibilityLabel="Wrap anyway"
      accessibilityState={{ disabled: false }}
      disabled={disabled}
      onPress={() => { void wrapAnyway(); }}
      className="self-start bg-neutral-800 rounded-lg px-4 py-3 mt-4 active:bg-neutral-700">
      <Text className="text-white text-sm">Wrap anyway</Text>
    </Pressable>}
    {report.acknowledgementValid && <Text className="text-neutral-300 text-xs mt-4">
      You explicitly acknowledged the flags above. They remain attached to this project.
    </Text>}
    {!!report.acknowledgement && !report.acknowledgementValid && <Pressable
      accessibilityRole="button"
      accessibilityLabel="Start a fresh wrap review"
      disabled={disabled}
      onPress={() => { void startFreshReview(); }}
      className="self-start px-3 py-3 mt-3 active:opacity-70">
      <Text className="text-neutral-300 text-xs">Start a fresh wrap review</Text>
    </Pressable>}
    {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-xs mt-3">{message}</Text>}
  </View>;
}

export default T1WrapReport;
