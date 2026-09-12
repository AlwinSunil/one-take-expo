# Tier 0 project storage and pickup handoff

Owner: Melvin. Capture consumer: Alwin. Script/coverage reviewer: Sabari.

This implements the review/export lane's receiving API. It does not change the camera or script route and does not claim that capture already calls these functions. Expo SDK 57 documentation and installed file-system types were checked: `File.copy` and `File.move` return promises and must be awaited.

## Capture calls

Import functions from `@/lib/store`, `Project` from `@/lib/session`, and `PickupRecordingInput` from `@/lib/project-data`.

```ts
beginRecording(project: Project): Promise<void>
saveProject(project: Project): Promise<Project>

beginProjectPickup(projectId: string, recordingId: string, lineIds: string[]): Promise<void>
completeProjectPickup(projectId: string, recordingId: string, input: PickupRecordingInput): Promise<Project>
cancelProjectPickup(projectId: string, recordingId: string): Promise<void>

interface PickupRecordingInput {
  videoUri: string;
  duration: number; // finite positive seconds in this source
  transcript: Project['transcript'];
  takes: NonNullable<Project['takes']>;
}

registerProjectWork(projectId: string, cancel: () => Promise<void>): () => void
registerProjectFile(projectId: string, uri: string): Promise<void>
assertProjectExists(projectId: string): Promise<void>
```

For a first recording, choose a unique project ID and call `beginRecording` before capture starts. After the recorder returns a usable file, call `saveProject` with that URI, the final script snapshot, caption observations, and source-relative take evidence. Open the returned project's ID, and use its returned durable URI for recent-recording references. An existing primary original is preserved by later saves; a new recording belongs in the pickup API.

For a pickup, retain the original target project ID, choose a unique recording ID, and pass the target script's stable line IDs to `beginProjectPickup` before capture. Once recording stops and its file is usable, call `completeProjectPickup`. Every caption should have a unique ID within this recording. Each take references those caption IDs, has positive source-relative `t0`/`t1` within `duration`, and references this recording's URI only. Linked caption intervals must fit inside the take's audio interval. Preserve whole take boundaries; do not manufacture word-level splice points. Provisional recognition remains provisional, and optional/required action status comes from the owner's script state, never inferred by storage.

Completion copies the video into the target project's private storage, namespaces caption/take identities, remaps their media URI, appends `recordings`, and preserves earlier originals, captions, take evidence, trim and manual decisions. The begun pickup’s requested line IDs become each new take’s `eligibleLineIds`; review can only use those takes for the requested lines, even when the audio contains other matching speech. Full source audio remains intact, so review still checks indivisible take conflicts. It clears reviewed-cut approval so the changed project must be reviewed again. Repeating completion for the same committed recording ID returns the existing project without duplicating history. Do not reuse recording IDs for different recordings.

`cancelProjectPickup` clears a begun pickup with no pending save. If a copy is already journaled, it refuses to discard recoverable footage; retry completion/recovery or explicitly delete the project. An abandoned begun pickup appears as interrupted in Projects while earlier takes remain usable.

## Work cancellation and deletion

Register active capture or other file-writing work **synchronously before its first asynchronous step**. Then call `assertProjectExists` before starting work on an existing project. The cancellation callback must stop capture and resolve only when the recorder can no longer write or recreate files. Call the returned unregister function when the operation settles. A callback that merely sends a stop signal and resolves immediately is insufficient.

Storage registers its own copy work. Deletion waits for all registered callbacks, records a durable tombstone, and rejects late project writes and job registration. Callers must not bypass these APIs with direct SQLite writes. Pending callbacks that fail leave the project available for deletion retry.

`registerProjectFile` associates additional app-private files such as thumbnails or audio sidecars with a project; register the intended URI before generating the file. Shared associations protect files referenced by another project. Only app document/cache files are accepted. Captured cache sources are registered when copied, while document sources supplied by another project remain intact.

```ts
deleteProject(projectId: string, options?: { deleteGallery?: boolean }): Promise<void>
```

The Projects UI offers explicit app-only or gallery-copy deletion. Gallery choice is persisted for interrupted retries; an explicitly supplied new choice overrides it. Native export cancellation settles before deletion of exports and optional gallery items. Permission or file-removal failures keep the tombstone, project and remaining associations for retry. Externally shared copies remain outside app control. Successful deletion removes the project ledger, registered private files, pickup drafts, copy journals and export references. Tombstones remain to reject late resurrection.

## Recovery and review import

```ts
recoverProjectSaves(): Promise<void>
mergePickupProject(targetId: string, pickupId: string, lineIds: string[]): Promise<Project>
```

`getProject` and `listProjects` automatically replay pending saves. Before copying, SQLite stores a `project_operations` journal with source, destination, intended metadata and expected byte length. `copying` files are recopied from the preserved source; only a `ready` partial with the expected size may be promoted without the source. A completed copy is renamed before metadata commits. Metadata commit and journal removal share a transaction. Unrecoverable operations keep their journal and show a recovery message; an incomplete partial is never claimed as usable coverage.

The `recordings` ledger records each source's URI, duration and creation time. Caption `recordingId` keeps its source identity; times are never offset into a fabricated common source timeline. File availability is computed on read through `unavailableTakeIds`, without permanently changing a take's explicit `playable` value. Restored files can support coverage again. Stale editor metadata cannot erase a recording attached after that editor loaded.

`mergePickupProject` supports an explicitly chosen saved single-source project as a pickup. It copies that recording into the target, preserves the source project, and rematches captions to the target script instead of trusting the source project's line IDs. Multi-source pickup projects are rejected; camera integration should call `completeProjectPickup` per original recording.

## Reproduction and remaining owner checks

- `node --experimental-strip-types --test tests/pickup-storage.test.mjs tests/project-data.test.mjs` checks migration, namespaces, boundaries, idempotency, malformed data, temporary missing media and stale-editor preservation.
- `npm run typecheck` checks consumer signatures.
- `runStorageChecks` in `src/development/sessions/storage-checks.ts` exercises actual SQLite/filesystem storage, pickup import, recovery, cancellation failure, concurrent save/delete and cross-project preservation on the dedicated fixture. The parent integration report records the exact device/build and final outcome.

Capture still owns permission UI, durable begin timing, live recorder cancellation, real recording duration/evidence and calling completion before navigation. Both peers must review the shared receiving API and deletion paths. Local fixture checks do not establish microphone/A/V timing, native recognition correctness or NPU execution.
