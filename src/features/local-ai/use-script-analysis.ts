import { useEffect, useState } from 'react';
import captions from '../../../modules/one-take-captions';
import type { ScriptDocument } from '../../lib/script-lines';
import { analyzeLocalScript, type ScriptAnalysis } from './script-model';

function failureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/no space|ENOSPC|insufficient storage/i.test(message)) return 'Free up storage to download local AI.';
  if (/network|connect|download|HTTP/i.test(message)) return 'Local AI could not finish. Check your connection and retry.';
  return 'Local AI unavailable · basic checks active';
}

export function useScriptAnalysis(doc: ScriptDocument, enabled: boolean) {
  const [result, setResult] = useState<ScriptAnalysis>();
  const [status, setStatus] = useState('');
  const [failedScript, setFailedScript] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !doc.text.trim()) { setStatus(''); return; }
    let active = true, checking = false, pending = false;
    let polling: ReturnType<typeof setInterval> | undefined;
    setStatus('');
    setFailedScript(undefined);
    const updateStatus = async () => {
      if (checking || !active || !pending) return;
      checking = true;
      try {
        const state = await captions?.aiStatus();
        if (active && pending) setStatus(state === 'downloading' || state === 'downloadable' ? 'Downloading local AI…' : 'Analyzing script…');
      } catch { /* Analysis reports actionable failures; status polling is optional. */ }
      finally { checking = false; }
    };
    const timer = setTimeout(() => {
      pending = true;
      setStatus('Preparing local AI…');
      void updateStatus();
      polling = setInterval(() => { void updateStatus(); }, 1200);
      void analyzeLocalScript(doc).then(analysis => {
        if (active) { setResult(analysis); setStatus(''); }
      }).catch(error => {
        if (active) { setFailedScript(doc.text); setStatus(failureMessage(error)); }
      }).finally(() => { pending = false; clearInterval(polling); });
    }, 900);
    return () => { active = false; pending = false; clearTimeout(timer); clearInterval(polling); };
  }, [doc, enabled, attempt]);
  return {
    analysis: result?.script === doc.text ? result : undefined,
    status,
    canRetry: enabled && failedScript === doc.text,
    retry: () => { setFailedScript(undefined); setAttempt(value => value + 1); },
  };
}
