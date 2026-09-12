import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { Project, TranscriptSeg } from '@/lib/session';
import {
  StaleCaptionEditError,
  beginCaptionWordEdit,
  captionDisplayText,
  clearCaptionCorrection,
  saveCaptionWordEdit,
  splitCaptionWords,
  undoCaptionWordEdit,
} from '@/lib/t1-caption-edit';
import type { CaptionWordEdit, CaptionWordEditDraft } from '@/lib/t1-caption-edit';

export interface T1CaptionEditorProps {
  project: Project;
  onChange: (project: Project) => Promise<void> | void;
  onSeek?: (seconds: number) => void;
  /** The parent owns the Tier 1 release/development gate. */
  enabled?: boolean;
  disabled?: boolean;
}

interface EditableTranscriptSegment extends TranscriptSeg {
  id: string;
}

interface ActiveWordEdit {
  segmentIndex: number;
  draft: CaptionWordEditDraft;
  replacement: string;
}

/**
 * Opt-in word correction panel for the Tier 1 editor.
 *
 * This component does not infer coverage, splice media or rewrite raw speech.
 * It only persists explicit `manualCorrection` changes through `onChange`.
 */
export function T1CaptionEditor({
  project,
  onChange,
  onSeek,
  enabled = false,
  disabled = false,
}: T1CaptionEditorProps) {
  const latest = useRef(project);
  latest.current = project;
  const [active, setActive] = useState<ActiveWordEdit | null>(null);
  const [undoStack, setUndoStack] = useState<CaptionWordEdit[]>([]);
  const [message, setMessage] = useState('');

  if (!enabled) return null;

  const canSeek = typeof onSeek === 'function' && !!project.videoUri && !project.mediaMissing;
  const editableSegments = editableTranscript(project);

  function openWord(segmentIndex: number, wordIndex: number): void {
    if (disabled) return;
    try {
      const segment = editableTranscript(latest.current)[segmentIndex];
      const draft = beginCaptionWordEdit(segment, wordIndex);
      setActive({ segmentIndex, draft, replacement: draft.beforeWord });
      setMessage('');
    } catch (error) {
      setMessage(formatError(error));
    }
  }

  async function saveWord(): Promise<void> {
    if (!active || disabled) return;
    const current = latest.current;
    try {
      const editable = editableTranscript(current);
      const result = saveCaptionWordEdit(editable, active.draft, active.replacement);
      const next: Project = {
        ...current,
        captionRevision: (current.captionRevision ?? 0) + 1,
        transcript: restoreTranscript(current, result.segments),
      };
      if (!await persist(next)) return;
      setUndoStack((history) => [...history, result.edit].slice(-20));
      setActive(null);
      setMessage('Caption correction saved. Spoken transcript evidence is unchanged.');
    } catch (error) {
      setMessage(formatError(error));
    }
  }

  async function undoLastWord(): Promise<void> {
    if (disabled) return;
    const edit = undoStack[undoStack.length - 1];
    if (!edit) return;
    const current = latest.current;
    try {
      const restored = undoCaptionWordEdit(editableTranscript(current), edit);
      const next: Project = {
        ...current,
        captionRevision: (current.captionRevision ?? 0) + 1,
        transcript: restoreTranscript(current, restored),
      };
      if (!await persist(next)) return;
      setUndoStack((history) => history.slice(0, -1));
      setMessage('Caption correction undone.');
    } catch (error) {
      setMessage(formatError(error));
    }
  }

  async function restoreRecognized(segmentIndex: number): Promise<void> {
    if (disabled) return;
    const current = latest.current;
    try {
      const editable = editableTranscript(current);
      const segment = editable[segmentIndex];
      const restored = clearCaptionCorrection(editable, segment.id, captionDisplayText(segment));
      const next: Project = {
        ...current,
        captionRevision: (current.captionRevision ?? 0) + 1,
        transcript: restoreTranscript(current, restored),
      };
      if (!await persist(next)) return;
      setUndoStack((history) => history.filter((edit) => edit.segmentId !== segment.id));
      setMessage('Recognized caption restored.');
    } catch (error) {
      setMessage(formatError(error));
    }
  }

  async function persist(next: Project): Promise<boolean> {
    latest.current = next;
    try {
      await onChange(next);
      return true;
    } catch (error) {
      setMessage(`Could not save caption correction: ${formatError(error)}`);
      return false;
    }
  }

  return <View className="border-t border-neutral-800 mt-3 pt-3">
    <View className="flex-row items-center justify-between mb-2">
      <Text className="text-white font-semibold">Correct captions</Text>
      {!!undoStack.length && <Pressable
        accessibilityRole="button"
        accessibilityLabel="Undo last caption correction"
        disabled={disabled}
        onPress={() => { void undoLastWord(); }}
        className="p-2 disabled:opacity-40"
      >
        <Text className="text-cyan-200 text-xs">Undo last edit</Text>
      </Pressable>}
    </View>
    {!!project.mediaMissing && <Text className="text-amber-200 text-xs mb-2">
      Original media is unavailable. Captions remain editable, but playback is disabled.
    </Text>}
    {!project.transcript.length && <Text className="text-neutral-400 text-sm">
      No saved captions are available to correct.
    </Text>}
    {project.transcript.map((segment, segmentIndex) => {
      const editable = editableSegments[segmentIndex];
      const displayText = captionDisplayText(editable);
      const words = splitCaptionWords(displayText);
      const segmentId = editable.id;
      const editingThisSegment = active?.draft.segmentId === segmentId;
      const hasSavedCorrection = segment.manualCorrection !== undefined && segment.manualCorrection !== null;
      const captionPieces: ReactNode[] = [];
      let cursor = 0;
      for (const word of words) {
        if (word.start > cursor) {
          captionPieces.push(<Text key={`${segmentId}:gap:${cursor}`} className="text-neutral-100">{displayText.slice(cursor, word.start)}</Text>);
        }
        const selected = editingThisSegment && active?.draft.wordIndex === word.index;
        captionPieces.push(<Pressable
          key={`${segmentId}:${word.index}:${word.start}`}
          accessibilityRole="button"
          accessibilityLabel={`Correct caption word ${word.text}`}
          accessibilityState={{ selected }}
          disabled={disabled}
          onPress={() => openWord(segmentIndex, word.index)}
          style={{ minHeight: 44, justifyContent: 'center' }}
          className="rounded px-1 py-1 disabled:opacity-40"
        >
          <Text className={selected ? 'text-cyan-200 bg-cyan-950' : 'text-neutral-100'}>{word.text}</Text>
        </Pressable>);
        cursor = word.end;
      }
      if (cursor < displayText.length) {
        captionPieces.push(<Text key={`${segmentId}:tail:${cursor}`} className="text-neutral-100">{displayText.slice(cursor)}</Text>);
      }
      return <View key={segmentId} className="mb-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Preview caption segment ${segmentIndex + 1}`}
          disabled={!canSeek}
          onPress={() => { if (canSeek) onSeek?.(segment.t0); }}
          className="py-1 disabled:opacity-40"
        >
          <Text className="text-neutral-400 text-xs">
            {segment.t0.toFixed(1)}s – {segment.t1.toFixed(1)}s · {segment.isFinal === false ? 'Draft' : 'Caption'}
          </Text>
        </Pressable>
        <View className="flex-row flex-wrap items-center">
          {captionPieces}
        </View>
        {editingThisSegment && active && <View className="mt-1">
          <TextInput
            accessibilityLabel={`Replacement for caption word ${active.draft.beforeWord}`}
            autoCapitalize="none"
            autoCorrect={false}
            value={active.replacement}
            onChangeText={(replacement) => setActive((current) => current ? { ...current, replacement } : current)}
            className="text-white bg-neutral-900 rounded-lg p-3"
          />
          <View className="flex-row flex-wrap mt-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save caption word correction"
              disabled={disabled}
              onPress={() => { void saveWord(); }}
              className="bg-cyan-900 rounded-lg p-3 mr-2 disabled:opacity-40"
            >
              <Text className="text-white text-xs">Save word</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel caption word correction"
              disabled={disabled}
              onPress={() => setActive(null)}
              className="p-3 disabled:opacity-40"
            >
              <Text className="text-neutral-300 text-xs">Cancel</Text>
            </Pressable>
          </View>
        </View>}
        {hasSavedCorrection && <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Restore recognized caption ${segmentIndex + 1}`}
          disabled={disabled}
          onPress={() => { void restoreRecognized(segmentIndex); }}
          className="py-2 disabled:opacity-40"
        >
          <Text className="text-neutral-400 text-xs">Restore recognized caption</Text>
        </Pressable>}
      </View>;
    })}
    {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-xs py-2">{message}</Text>}
  </View>;
}

function editableTranscript(project: Project): EditableTranscriptSegment[] {
  return project.transcript.map((segment, index) => ({
    ...segment,
    id: segment.id ?? `${project.id}:caption:${index}`,
  }));
}

function restoreTranscript(project: Project, segments: readonly EditableTranscriptSegment[]): TranscriptSeg[] {
  return segments.map((segment, index) => {
    if (project.transcript[index]?.id) return segment;
    const { id: _id, ...withoutGeneratedId } = segment;
    return withoutGeneratedId;
  });
}

function formatError(error: unknown): string {
  if (error instanceof StaleCaptionEditError) {
    return 'This caption changed while it was open. Reopen the word and save again.';
  }
  return error instanceof Error ? error.message : String(error);
}
