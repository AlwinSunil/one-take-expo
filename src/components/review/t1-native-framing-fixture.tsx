import { Asset } from 'expo-asset';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import media, {
  NativeCutPreview,
  type MediaExport,
  type MediaExportRequest,
} from '../../../modules/one-take-media';
import { buildFramingPlan, type FramingPlanInput } from '@/lib/t1-framing';
import { saveSetting } from '@/lib/store';

const REPORT_KEY = 't1-native-render-report';
const EXPORT_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 400;
const CAPTION_TEXT = 'Our bottle stays cold.';
const CASE_IDS = [
  'portrait-ready',
  'moving-subject-falls-back',
  'missing-vision-track-falls-back',
  'product-keeps-product-and-hand',
] as const;

type FixtureCaseId = typeof CASE_IDS[number];
type Selection = 'suggested' | 'original';

interface FixtureCase {
  id: FixtureCaseId;
  input: FramingPlanInput;
  expected: FixtureExpected;
}

interface FixtureExpected {
  mode: 'original' | 'reframed';
  fallbackReason?: string;
}

interface RawFixtureCase {
  id: FixtureCaseId;
  input: FramingPlanInput & { expected: FixtureExpected };
}

interface FixtureDocument {
  cases: RawFixtureCase[];
}

interface NativeCaseReport {
  caseId: FixtureCaseId;
  selection: Selection;
  fixtureSource: string;
  sourceUri: string;
  sourceMediaId: string;
  takeId: string | null;
  analysisId: string | null;
  expected: FixtureCase['expected'];
  decision: {
    mode: 'original' | 'reframed';
    fallbackReason?: string;
    suggestionId?: string;
    nativeCrop: unknown;
  };
  requestId: string;
  status: MediaExport['status'] | 'error';
  resultUri?: string;
  error?: string;
  elapsedMs: number;
}

interface NativeReport {
  generatedAt: string;
  supportsFraming: boolean;
  fixtureSources: string[];
  correctedCaption: string;
  cases: NativeCaseReport[];
}

const fixtureDocument = require('../../../tools/fixtures/t1-framing.json') as FixtureDocument;

function sourceFixtureForCase(id: FixtureCaseId): string {
  switch (id) {
    case 'portrait-ready': return 'tools/fixtures/t1-portrait.mp4';
    case 'moving-subject-falls-back': return 'docs/validation/evidence/t1-session-3/framing/moving-source.mp4';
    case 'missing-vision-track-falls-back': return 'docs/validation/evidence/t1-session-3/framing/moving-source.mp4';
    case 'product-keeps-product-and-hand': return 'docs/validation/evidence/t1-session-3/framing/product-source.mp4';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeStatus(status: MediaExport['status']): boolean {
  return status === 'queued' || status === 'running';
}

function shortId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 34);
}

function caseSuggestionId(input: FramingPlanInput): string | null {
  const first = input.suggestions?.[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const analysisId = (first as { analysisId?: unknown }).analysisId;
  return typeof analysisId === 'string' && analysisId.trim() ? analysisId : null;
}

function sourceTakeId(input: FramingPlanInput): string | null {
  const takeId = input.cuts[0]?.takeId;
  return typeof takeId === 'string' && takeId.trim() ? takeId : null;
}

function fixtureCase(id: FixtureCaseId): FixtureCase {
  const row = fixtureDocument.cases.find(candidate => candidate.id === id);
  if (!row) throw new Error(`Framing fixture case is missing: ${id}`);
  const { expected, ...input } = row.input;
  return { id: row.id, input, expected };
}

function buildRequest(
  row: FixtureCase,
  sourceUri: string,
  selection: Selection,
  runId: string,
): { request: MediaExportRequest; plan: ReturnType<typeof buildFramingPlan> } {
  const input = { ...row.input, enabled: selection === 'suggested' };
  const plan = buildFramingPlan(input);
  const cut = input.cuts[0];
  if (!cut) throw new Error(`Framing fixture case has no cut: ${row.id}`);
  const decision = plan.cuts[0];
  if (!decision) throw new Error(`Framing plan has no decision: ${row.id}`);
  const caption = { t0: cut.startSec, t1: cut.endSec, text: CAPTION_TEXT };
  const segment = {
    uri: sourceUri,
    t0: cut.startSec,
    t1: cut.endSec,
    takeId: cut.takeId,
    captions: [caption],
    ...(decision.mode === 'reframed' ? { crop: decision.nativeCrop } : {}),
  };
  return {
    plan,
    request: {
      id: runId,
      sourceUri,
      cuts: [],
      captions: [caption],
      segments: [segment],
    },
  };
}

async function loadFixtureSource(id: FixtureCaseId): Promise<string> {
  const assetModule = (() => {
    switch (id) {
      case 'portrait-ready': return require('../../../tools/fixtures/t1-portrait.mp4');
      case 'moving-subject-falls-back': return require('../../../docs/validation/evidence/t1-session-3/framing/moving-source.mp4');
      case 'missing-vision-track-falls-back': return require('../../../docs/validation/evidence/t1-session-3/framing/moving-source.mp4');
      case 'product-keeps-product-and-hand': return require('../../../docs/validation/evidence/t1-session-3/framing/product-source.mp4');
    }
  })();
  const asset = await Asset.fromModule(assetModule).downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('Synthetic framing video did not produce a local URI.');
  return uri;
}

async function waitForExport(
  module: NonNullable<typeof media>,
  id: string,
): Promise<MediaExport> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let current = await module.getExport(id);
  while (activeStatus(current.status)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      let cancellationError: string | undefined;
      try {
        await module.cancelExport(id);
      } catch (error) {
        cancellationError = errorText(error);
      }
      const afterCancel = await module.getExport(id).catch(() => current);
      throw new Error(`Export timed out after ${EXPORT_TIMEOUT_MS} ms (${afterCancel.status})${cancellationError ? `; cancel failed: ${cancellationError}` : ''}`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    current = await module.getExport(id);
  }
  return current;
}

export function T1NativeFramingFixture() {
  const [selectedId, setSelectedId] = useState<FixtureCaseId>(CASE_IDS[0]);
  const [selection, setSelection] = useState<Selection>('suggested');
  const [sourceUri, setSourceUri] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState<MediaExportRequest | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [reportJson, setReportJson] = useState('');
  const [reports, setReports] = useState<NativeCaseReport[]>([]);
  const exportIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef(`fixture-${Date.now().toString(36)}`);
  const firstFrameLoggedRef = useRef(false);

  useEffect(() => () => {
    const id = exportIdRef.current;
    if (id && media) void media.cancelExport(id).catch(() => {});
  }, []);

  const selected = useMemo(() => fixtureCase(selectedId), [selectedId]);
  const capability = media?.supportsFraming === true;
  const activeRequest = useMemo(() => {
    if (!sourceUri) return null;
    const id = `t1nf-${sessionIdRef.current}-${shortId(selectedId)}-${selection}`;
    return buildRequest(selected, sourceUri, selection, id);
  }, [selected, selectedId, selection, sourceUri]);

  function displayReport(value: NativeReport) {
    const json = JSON.stringify(value, null, 2);
    setReportJson(json);
    setReports(value.cases);
    void saveSetting(REPORT_KEY, json).catch(error => {
      console.info('[T1NativeFramingFixture] report persistence unavailable', errorText(error));
    });
    console.info('[T1NativeFramingFixture]', json);
  }

  function makeReport(
    row: FixtureCase,
    selectedSelection: Selection,
    source: string,
    request: MediaExportRequest,
    plan: ReturnType<typeof buildFramingPlan>,
    result: MediaExport | null,
    startedAt: number,
    error?: string,
  ): NativeCaseReport {
    const decision = plan.cuts[0];
    if (!decision) throw new Error(`Framing plan has no cut decision: ${row.id}`);
    return {
      caseId: row.id,
      selection: selectedSelection,
      fixtureSource: sourceFixtureForCase(row.id),
      sourceUri: source,
      sourceMediaId: row.input.sourceMediaId,
      takeId: sourceTakeId(row.input),
      analysisId: caseSuggestionId(row.input),
      expected: row.expected,
      decision: {
        mode: decision.mode,
        ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
        ...(decision.suggestionId ? { suggestionId: decision.suggestionId } : {}),
        nativeCrop: decision.nativeCrop,
      },
      requestId: request.id,
      status: result?.status ?? 'error',
      ...(result?.uri ? { resultUri: result.uri } : {}),
      ...(error ? { error } : {}),
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function runOne(
    row: FixtureCase,
    selectedSelection: Selection,
    source: string,
    runTag: string,
    prepared?: ReturnType<typeof buildRequest>,
  ): Promise<NativeCaseReport> {
    const id = `t1nf-${sessionIdRef.current}-${shortId(row.id)}-${runTag}`;
    const startedAt = Date.now();
    let request: MediaExportRequest;
    let plan: ReturnType<typeof buildFramingPlan>;
    try {
      ({ request, plan } = prepared ?? buildRequest(row, source, selectedSelection, id));
      exportIdRef.current = id;
      const started = await media!.startExport(request);
      exportIdRef.current = started.id;
      const result = await waitForExport(media!, started.id);
      return makeReport(row, selectedSelection, source, request, plan, result, startedAt,
        result.status === 'completed' ? undefined : result.error ?? `Native export ended as ${result.status}.`);
    } catch (error) {
      const fallbackRequest: MediaExportRequest = {
        id,
        sourceUri: source,
        cuts: [],
        captions: [],
        segments: [],
      };
      try {
        ({ plan } = buildRequest(row, source, selectedSelection, id));
      } catch {
        plan = buildFramingPlan({ ...row.input, enabled: false });
      }
      return makeReport(row, selectedSelection, source, fallbackRequest, plan, null, startedAt, errorText(error));
    } finally {
      exportIdRef.current = null;
    }
  }

  async function runSelectedExport() {
    if (!media || !capability || busy) return;
    setBusy(true);
    setStatus('Loading synthetic source…');
    try {
      const source = sourceUri ?? await loadFixtureSource(selectedId);
      setSourceUri(source);
      const prepared = activeRequest ?? buildRequest(
        selected,
        source,
        selection,
        `t1nf-${sessionIdRef.current}-${shortId(selectedId)}-${selection}`,
      );
      const result = await runOne(selected, selection, source, 'selected', prepared);
      const next = [...reports.filter(item => !(item.caseId === result.caseId && item.selection === result.selection)), result];
      displayReport({ generatedAt: new Date().toISOString(), supportsFraming: capability, fixtureSources: [sourceFixtureForCase(result.caseId)], correctedCaption: CAPTION_TEXT, cases: next });
      setStatus(result.status === 'completed' ? `Export completed: ${result.resultUri ?? 'URI unavailable'}` : `Export ${result.status}: ${result.error ?? 'no details'}`);
    } catch (error) {
      setStatus(`Fixture failed: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runAllExports() {
    if (!media || !capability || busy) return;
    setBusy(true);
    setStatus('Loading synthetic source…');
    try {
      const next: NativeCaseReport[] = [];
      for (const id of CASE_IDS) {
        setStatus(`Exporting ${id}…`);
        const source = await loadFixtureSource(id);
        next.push(await runOne(fixtureCase(id), 'suggested', source, 'all'));
      }
      displayReport({ generatedAt: new Date().toISOString(), supportsFraming: capability, fixtureSources: CASE_IDS.map(sourceFixtureForCase), correctedCaption: CAPTION_TEXT, cases: next });
      const failed = next.filter(item => item.status !== 'completed').length;
      setStatus(failed ? `${failed} native framing export${failed === 1 ? '' : 's'} failed.` : 'All native framing fixture exports completed.');
    } catch (error) {
      setStatus(`Fixture failed: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function previewSelected() {
    if (!media || !capability || busy) return;
    try {
      const source = sourceUri ?? await loadFixtureSource(selectedId);
      if (!sourceUri) setSourceUri(source);
      const request = activeRequest?.request ?? buildRequest(
        selected,
        source,
        selection,
        `t1nf-${sessionIdRef.current}-${shortId(selectedId)}-${selection}`,
      ).request;
      setPreviewRequest(request);
      firstFrameLoggedRef.current = false;
      setPlaying(true);
      setStatus(`Previewing ${selectedId} (${request.segments?.[0]?.crop ? 'reframed' : 'original'})…`);
    } catch (error) {
      setStatus(`Preview failed: ${errorText(error)}`);
    }
  }

  if (!__DEV__) return null;

  const decision = activeRequest?.plan.cuts[0];
  return <View className="border-t border-neutral-800 py-4">
    <Text className="text-white font-semibold">Native framing fixture · Dev</Text>
    <Text className="text-amber-200 py-2">
      Synthetic provider rows only. This exercises the real Android Media3 preview/export path; it is not camera, vision, or human accuracy evidence.
    </Text>
    <Text className={capability ? 'text-emerald-300 text-xs' : 'text-amber-200 text-xs'}>
      Native status: {media ? (capability ? 'supports framing' : 'module present, framing unsupported') : 'unavailable in this build'}
    </Text>
    <View className="flex-row flex-wrap gap-2 mt-3">
      {CASE_IDS.map(id => <Pressable
        key={id}
        accessibilityRole="button"
        accessibilityState={{ selected: selectedId === id, disabled: busy }}
        disabled={busy}
        onPress={() => { setSelectedId(id); setSourceUri(null); setPreviewRequest(null); setPlaying(false); }}
        className={selectedId === id ? 'bg-neutral-700 rounded-lg px-3 py-3' : 'bg-neutral-900 rounded-lg px-3 py-3'}>
        <Text className="text-white text-xs">{id}</Text>
      </Pressable>)}
    </View>
    <View className="flex-row flex-wrap gap-2 mt-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: selection === 'suggested', disabled: busy }}
        disabled={busy}
        onPress={() => setSelection('suggested')}
        className={selection === 'suggested' ? 'bg-sky-900 rounded-lg px-3 py-3' : 'bg-neutral-900 rounded-lg px-3 py-3'}>
        <Text className="text-white text-xs">Use fixture decision</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: selection === 'original', disabled: busy }}
        disabled={busy}
        onPress={() => setSelection('original')}
        className={selection === 'original' ? 'bg-sky-900 rounded-lg px-3 py-3' : 'bg-neutral-900 rounded-lg px-3 py-3'}>
        <Text className="text-white text-xs">Use original frame</Text>
      </Pressable>
    </View>
    <Text className="text-neutral-300 text-xs mt-3">
      Decision: {decision?.mode ?? 'not loaded'}{decision?.fallbackReason ? ` · fallback ${decision.fallbackReason}` : ''}
    </Text>
    <Text selectable className="text-neutral-400 text-xs mt-1">
      Native crop: {decision ? JSON.stringify(decision.nativeCrop) : 'not loaded'}
    </Text>
    <View className="flex-row flex-wrap gap-2 mt-3">
      <Pressable accessibilityRole="button" disabled={!capability || busy} onPress={() => { void previewSelected(); }} className="bg-neutral-800 rounded-lg px-3 py-3 disabled:opacity-40">
        <Text className="text-white text-xs">Preview selected</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={!capability || busy} onPress={() => { void runSelectedExport(); }} className="bg-neutral-800 rounded-lg px-3 py-3 disabled:opacity-40">
        <Text className="text-white text-xs">Export selected</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={!capability || busy} onPress={() => { void runAllExports(); }} className="bg-sky-900 rounded-lg px-3 py-3 disabled:opacity-40">
        <Text className="text-white text-xs">Run four native exports</Text>
      </Pressable>
    </View>
    {busy && <ActivityIndicator accessibilityLabel="Native framing fixture running" color="#93c5fd" className="mt-3 self-start" />}
    {previewRequest && NativeCutPreview && <View className="h-80 mt-4 rounded-xl overflow-hidden bg-neutral-950">
      <NativeCutPreview
        style={{ flex: 1 }}
        request={JSON.stringify(previewRequest)}
        playing={playing}
        seek={0}
        onState={({ nativeEvent: event }) => {
          if (event.error) setStatus(`Preview error: ${event.error}`);
          else if (event.firstFrameMs != null && !firstFrameLoggedRef.current) {
            firstFrameLoggedRef.current = true;
            setStatus(`Preview first frame: ${event.firstFrameMs} ms`);
          } else if (event.ended) {
            setPlaying(false);
            setStatus('Preview ended.');
          } else if (event.ready) setStatus('Preview ready.');
        }}
      />
    </View>}
    {previewRequest && !NativeCutPreview && <Text className="text-amber-200 text-xs mt-3">Native preview is unavailable in this build.</Text>}
    <Text accessibilityRole="alert" className="text-neutral-300 text-xs mt-3">{status}</Text>
    {!!reportJson && <View className="mt-4 bg-neutral-950 rounded-xl p-3">
      <Text className="text-neutral-300 text-xs font-semibold">Native render report</Text>
      <Text selectable className="text-neutral-400 text-xs mt-2">{reportJson}</Text>
      {reports.some(report => report.resultUri) && <Text selectable className="text-neutral-300 text-xs mt-3">
        Result URIs: {reports.filter(report => report.resultUri).map(report => `${report.caseId}=${report.resultUri}`).join('\n')}
      </Text>}
    </View>}
  </View>;
}

export default T1NativeFramingFixture;
