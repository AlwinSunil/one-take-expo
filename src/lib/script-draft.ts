import { getAcceptedScript, getSetting, saveSetting } from './store.ts';
import { restoreScriptDocumentFrom, serializeScriptDocument, type ScriptDocument } from './script-lines.ts';

/**
 * Line ids and cue statuses live beside the raw draft under their own key in the
 * existing `kv` table, so `script_draft` keeps holding exactly the text the camera
 * route consumes. Losing this key only costs ids and cue statuses, never the script.
 */
const STRUCTURE_KEY = 'script_draft_lines';
const ACCEPTED_STRUCTURE_KEY = 'script_accepted_lines';

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

/**
 * Preserve the exact line ids and manual action decisions that were accepted
 * for the next camera take. This is separate from the draft structure because
 * accepting a script intentionally clears the editable draft key.
 */
export async function saveAcceptedScriptStructure(document: ScriptDocument): Promise<void> {
  await saveSetting(ACCEPTED_STRUCTURE_KEY, serializeScriptDocument(document));
}

/**
 * Restore the accepted structure against the route's raw script text. The raw
 * text always wins, so a stale structure can preserve ids and cue state but can
 * never resurrect words the creator did not accept for this take.
 */
export async function loadAcceptedScriptDocument(text?: string): Promise<ScriptDocument> {
  let accepted = text ?? '';
  if (!accepted) {
    try {
      accepted = await getAcceptedScript();
    } catch {
      accepted = '';
    }
  }
  return restoreScriptDocumentFrom(accepted, () => getSetting(ACCEPTED_STRUCTURE_KEY));
}
