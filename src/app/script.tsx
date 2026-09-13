import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { suggestImportantPoints } from '@/features/speech-analysis/important-points';
import { ScriptLineRow } from '@/components/script/script-line-row';
import { clearScriptStructure, loadScriptDocument, saveAcceptedScriptStructure, saveScriptStructure } from '@/lib/script-draft';
import {
  correctAmbiguousCue,
  deleteLine,
  moveLine,
  parseScript,
  setCueRequired,
  setCueStatus,
  unresolvedRequiredCueIds,
  type ActionCueStatus,
  type ScriptDocument,
} from '@/lib/script-lines';
import { acceptDraft, getDraft, saveDraft } from '@/lib/store';

const NEXT_STEP_HINT: Record<ScriptDocument['nextStep'], string> = {
  'add-script': 'Type or paste what you want to say. Put directions in [brackets].',
  'add-spoken-line': 'This script is actions only. Add a line you will say out loud before recording.',
  'ready-to-record': '',
};

export default function ScriptInput() {
  const [doc, setDoc] = useState<ScriptDocument>(() => parseScript(''));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const script = doc.text;
  const importantLineIds = useMemo(() => new Set(suggestImportantPoints(doc, 'current-script')
    .filter(point => point.importance === 'important').map(point => point.span.lineId)), [doc]);
  const requiredOpen = unresolvedRequiredCueIds(doc).length;

  useEffect(() => {
    let cancelled = false;
    // Autosave only starts once the saved draft has actually been read. If that read
    // fails, the debounce must not run, or it would write an empty script over it.
    getDraft()
      .then(draft => loadScriptDocument(draft))
      .then(restored => {
        if (cancelled) return;
        if (restored.text) setDoc(restored);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSaveError('Could not open your saved draft, so nothing typed here is being saved automatically.');
      });
    return () => { cancelled = true; };
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // The raw text is saved first and on its own key, so the camera route keeps
      // reading exactly what the creator typed. A failed structure write only costs
      // line ids and cue statuses, which the next parse rebuilds, so it stays quiet.
      saveDraft(doc.text)
        .then(() => saveScriptStructure(doc).catch(() => {}))
        .catch(() => setSaveError('Could not save draft.'));
    }, 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [doc, loaded]);

  function edit(text: string) {
    setDoc(current => parseScript(text, current));
  }

  async function paste() {
    const s = await Clipboard.getStringAsync();
    if (s) setDoc(current => parseScript(current.text ? `${current.text}\n${s}` : s, current));
  }

  async function cont() {
    if (!script.trim() || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const accepted = await acceptDraft(script);
      await saveAcceptedScriptStructure(doc).catch(() => {});
      await clearScriptStructure().catch(() => {});
      router.push({ pathname: '/camera', params: { mode: 'script', script: accepted } });
    } catch {
      setSaveError('Could not save script. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-black">
      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
        <View className="px-5 pt-4 pb-5 max-w-[600px] w-full self-center">
          <Text className="text-white text-3xl font-bold">Script</Text>
          <Text className="text-neutral-500 text-[11px] mt-0.5">
            {doc.spokenWordCount} spoken words · about {doc.readTime} to read
          </Text>

          <TextInput
            value={script}
            onChangeText={edit}
            multiline
            accessibilityLabel="Script text"
            placeholder="Enter or paste your script…"
            placeholderTextColor="#525252"
            textAlignVertical="top"
            className="bg-neutral-900 border border-neutral-800 rounded-xl text-white text-sm p-4 mt-3 min-h-[180px] max-h-[320px]"
          />

          {!!saveError && <Text className="text-red-300 text-xs mt-2">{saveError}</Text>}

          <View className="flex-row gap-3 mt-3">
            <Pressable onPress={paste} className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl py-3.5 active:opacity-70">
              <Text className="text-neutral-200 text-sm font-semibold text-center">
                Paste from Clipboard
              </Text>
            </Pressable>
            <Pressable
              disabled={!script.trim() || saving}
              onPress={cont}
              className="flex-1 bg-white rounded-xl py-3.5 active:opacity-80 disabled:opacity-40">
              <Text className="text-black text-sm font-bold text-center">Continue</Text>
            </Pressable>
          </View>

          {!!NEXT_STEP_HINT[doc.nextStep] && (
            <Text className="text-amber-200 text-xs mt-3">{NEXT_STEP_HINT[doc.nextStep]}</Text>
          )}

          {doc.lines.length > 0 && (
            <View className="mt-5">
              <Text className="text-neutral-400 text-xs font-semibold">
                {doc.lines.length} {doc.lines.length === 1 ? 'line' : 'lines'}
                {requiredOpen > 0 ? ` · ${requiredOpen} required ${requiredOpen === 1 ? 'action' : 'actions'} still open` : ''}
              </Text>
              <Text className="text-neutral-500 text-xs mt-2">On-device checks will flag unconfirmed important points after recording.</Text>
              {doc.lines.map((line, index) => (
                <View key={line.id}>
                {importantLineIds.has(line.id) && <Text className="text-amber-200 text-xs mt-4">Important point</Text>}
                <ScriptLineRow
                  line={line}
                  position={index + 1}
                  onCueRequiredChange={(cueId, required) => setDoc(current => setCueRequired(current, cueId, required))}
                  onCueStatusChange={(cueId, status: ActionCueStatus) => setDoc(current => setCueStatus(current, cueId, status))}
                  onCorrectAmbiguousCue={(cueId, as) => setDoc(current => correctAmbiguousCue(current, cueId, as))}
                  onMove={(lineId, offset) => setDoc(current => moveLine(current, lineId, offset))}
                  onDelete={lineId => setDoc(current => deleteLine(current, lineId))}
                />
                </View>
              ))}
              {doc.removedLines.length > 0 && (
                <Text className="text-neutral-500 text-[11px] mt-3">
                  {doc.removedLines.length} deleted{' '}
                  {doc.removedLines.length === 1 ? 'line is' : 'lines are'} kept in this draft&apos;s
                  history, so any takes recorded for them are not lost.
                </Text>
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
