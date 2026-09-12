# Handoff: editable spoken lines and bracketed action cues (#12)

Owner: Sabari (script and coverage lane).
Branch: `feat/issue-12-script-lines`.
Consumers: capture (#11), coverage (#16) and persistence.

This is an owner-authored handoff, not an agreed API.
Nothing here has been reproduced on a device; see the open checks at the end.

## What the lane now owns

- `src/lib/script-lines.ts` - pure parsing and editing of a script draft.
- `src/lib/script-draft.ts` - the second draft key that stores line ids and cue statuses.
- `src/components/script/script-line-row.tsx` and `src/components/script/action-cue-row.tsx` - props-only rows.
- `src/app/script.tsx` - the screen that composes them.
- `tests/script-lines.test.mjs` - 24 behavior tests.

## The camera contract is unchanged

`script.tsx` still calls `acceptDraft(text)` and pushes `/camera` with `{ mode: 'script', script }` as a raw string.
`parseScript` splits with the same expression `camera.tsx` uses, `/[^.!?\n]+[.!?]?/g`, and every editing helper rebuilds the raw text by joining line texts with a newline.
A test asserts that the string handed to the camera re-chunks into exactly the lines the script screen displayed, including after a reorder, a delete and a bracket correction.

## Line and cue shapes

```ts
interface ScriptDocumentLine {
  id: string;               // 'line-1', stable across edits
  text: string;             // what the creator typed, brackets included
  spokenText: string;       // cue text removed, whitespace collapsed
  actionCues: ScriptActionCue[];
  ambiguousCues: AmbiguousCue[];
  kind: 'spoken' | 'action-only';
  wordCount: number;        // spoken words only
}

interface ScriptActionCue {
  id: string;               // '<lineId>:cue:<index>'
  text: string;
  required: boolean;        // optional by default
  status: 'pending' | 'done' | 'skipped';
}
```

`ActionCueStatus` is separate from `ActionCue.resolved` in `transcript-workflow.ts` because a boolean cannot record "skipped".
`unresolvedRequiredCueIds(document)` treats `skipped` as unresolved, so skipping is an honest record and never a wrap-time resolution.
Nothing in this module infers that an action happened.

Bracket parsing is not duplicated: `extractBracketedCues` is now exported from `transcript-workflow.ts` and re-exported from `script-lines.ts`, so review and script share one regex.
An unclosed `[hold up` stays in `spokenText` and is reported as an `AmbiguousCue`; `correctAmbiguousCue(document, cueId, 'action' | 'spoken')` rewrites the line either way.

## Change intent for coverage and persistence

```ts
scriptChangeIntent(previous, next): {
  editedLineIds: string[];
  deletedLineIds: string[];
  addedLineIds: string[];
  reorderedFrom?: string[];   // previous order of the surviving lines, only when it changed
}
```

Consumers decide the effects; this lane only reports them.
The intended reactions are: an edited line that was already covered needs a new verdict, a deleted line keeps its historical takes (the line itself stays in `document.removedLines`), and a reorder changes nothing about coverage because the ids are unchanged.

## Draft persistence

`script_draft` keeps holding the raw text and nothing else, so any existing reader, including the camera route, is unaffected.
`script-draft.ts` writes the structure to `script_draft_lines` through the existing `saveSetting`/`getSetting` helpers in `store.ts`.

This deviates from the plan's suggestion of opening `expo-sqlite` directly from a new module: `store.ts` already exports generic `kv` accessors, so reusing them needs no edit to `store.ts`, no schema change and no second database connection.

`restoreScriptDocument(text, serialized)` always rebuilds from the raw text.
A missing, empty, stale or unreadable structure costs line ids and cue statuses only; the creator's script is still restored.
The two writes are not one transaction, so a crash between them can leave a stale structure. That is safe by construction because the raw text is authoritative.

## Requested changes in other lanes

None. No file outside this lane was edited.

If capture wants the parsed lines instead of re-chunking the raw string, the smallest future change is for `camera.tsx` to call `parseScript(script)` from `@/lib/script-lines` and read `lines[i].spokenText` for the prompter and `lines[i].actionCues` for an on-screen direction.
That would let the prompter stop showing bracket text to the creator while reading.
It is not proposed as part of #12 because it touches `camera.tsx`.

## Open checks

- No device or emulator run: keyboard layout with the line list visible, draft recovery after force-close and paste from a real clipboard are unverified.
- No UX recording or screenshot is attached.
- The named reviewer has not reproduced any of this.
