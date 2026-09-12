import { getSetting, saveSetting } from './store.ts';
import { restoreScriptDocumentFrom, serializeScriptDocument, type ScriptDocument } from './script-lines.ts';

/**
 * Line ids and cue statuses live beside the raw draft under their own key in the
 * existing `kv` table, so `script_draft` keeps holding exactly the text the camera
 * route consumes. Losing this key only costs ids and cue statuses, never the script.
 */
const STRUCTURE_KEY = 'script_draft_lines';

export async function saveScriptStructure(document: ScriptDocument): Promise<void> {
  await saveSetting(STRUCTURE_KEY, serializeScriptDocument(document));
}

/**
 * Rebuild the draft from the raw text, which always wins, plus whatever structure
 * survived. A failed structure read is absorbed, so it can never cost the script.
 */
export async function loadScriptDocument(text: string): Promise<ScriptDocument> {
  return restoreScriptDocumentFrom(text, () => getSetting(STRUCTURE_KEY));
}

export async function clearScriptStructure(): Promise<void> {
  await saveSetting(STRUCTURE_KEY, '');
}
