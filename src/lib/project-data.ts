import { canonicalJson, validateFoundation } from './t15-schema.ts';
import type { Project, TranscriptSeg } from './session';

export function normalizeProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('Project data is unreadable.');
  const p = value as Project;
  if (p.schemaVersion !== undefined && (!Number.isSafeInteger(p.schemaVersion) || p.schemaVersion < 1 || p.schemaVersion > 2)) throw new Error('This project needs a newer app or has an unreadable schema.');
  if (p.v15 !== undefined) validateFoundation(p.v15, p);
  if (typeof p.id !== 'string' || !p.id || !['script', 'assisted'].includes(p.mode)) throw new Error('Project identity is invalid.');
  for (const key of ['scriptLines', 'reviewDecisions', 'rawTranscript', 'refinementCandidate', 'cuts', 'quietIntervals', 'takes', 'recordings', 'reviewSegments'] as const) {
    if (p[key] !== undefined && !Array.isArray(p[key])) throw new Error(`Project ${key} data is unreadable.`);
  }
  if (p.scriptLines?.some(line =>
    !line
    || typeof line.id !== 'string'
    || typeof line.spokenText !== 'string'
    || !Array.isArray(line.actionCues)
    || line.actionCues.some(cue => !isValidActionCue(cue))
  )) throw new Error('Project script lines are unreadable.');
  if (p.cuts?.some(cut => !cut || !Number.isFinite(cut.t0) || !Number.isFinite(cut.t1) || cut.t0 < 0 || cut.t1 <= cut.t0)) throw new Error('Project cuts are unreadable.');
  if (p.takes?.some(take => !take || typeof take.id !== 'string' || !take.id
    || !Number.isFinite(take.t0) || !Number.isFinite(take.t1) || take.t0 < 0 || take.t1 <= take.t0
    || (take.mediaUri !== null && typeof take.mediaUri !== 'string')
    || typeof take.playable !== 'boolean' || typeof take.inFrame !== 'boolean'
    || !['clean', 'scratched', 'flub'].includes(take.quality)
    || !Array.isArray(take.transcriptSegmentIds) || take.transcriptSegmentIds.some(id => typeof id !== 'string')
    || (take.eligibleLineIds !== undefined && (!Array.isArray(take.eligibleLineIds) || take.eligibleLineIds.some(id => typeof id !== 'string')))
    || (take.lineIds !== undefined && (!Array.isArray(take.lineIds) || take.lineIds.some(id => typeof id !== 'string')))
  )) throw new Error('Project takes are unreadable.');
  if (p.pickupRequest && (!Array.isArray(p.pickupRequest.lineIds)
    || p.pickupRequest.lineIds.some(id => typeof id !== 'string')
    || !Number.isFinite(p.pickupRequest.requestedAt))) throw new Error('Project pickup request is unreadable.');
  if (p.recordings?.some(recording => !recording || typeof recording.id !== 'string' || !recording.id
    || typeof recording.mediaUri !== 'string' || !recording.mediaUri || !Number.isFinite(recording.duration) || recording.duration < 0
    || !Number.isFinite(recording.createdAt)
    || (recording.evidenceStatus !== undefined && !['pending', 'complete'].includes(recording.evidenceStatus)))) throw new Error('Project recordings are unreadable.');
  if (p.recordings && new Set(p.recordings.map(recording => recording.id)).size !== p.recordings.length) throw new Error('Project recording identities are duplicated.');
  if (p.reviewSegments?.some(segment => !segment || typeof segment.uri !== 'string' || !segment.uri
    || !Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0
    || (segment.captions !== undefined && (!Array.isArray(segment.captions) || segment.captions.some(caption => !caption
      || typeof caption.text !== 'string' || !Number.isFinite(caption.t0) || !Number.isFinite(caption.t1)
      || caption.t0 < 0 || caption.t1 <= caption.t0))))) throw new Error('Project review segments are unreadable.');
  if (p.automaticEdit !== undefined) {
    const edit = p.automaticEdit;
    if (!edit || edit.version !== 1 || !edit.sourceKeys || typeof edit.sourceKeys !== 'object' || !Array.isArray(edit.clips)
      || Object.values(edit.sourceKeys).some(key => typeof key !== 'string')
      || edit.clips.some(clip => !clip || typeof clip.id !== 'string' || !clip.id || typeof clip.sourceId !== 'string' || !clip.sourceId
        || typeof clip.label !== 'string' || typeof clip.included !== 'boolean' || !Number.isFinite(clip.t0) || !Number.isFinite(clip.t1) || clip.t0 < 0 || clip.t1 <= clip.t0)
      || new Set(edit.clips.map(clip => clip.id)).size !== edit.clips.length) throw new Error('Automatic cuts are unreadable.');
  }
  if (p.semanticMatches !== undefined && (!Array.isArray(p.semanticMatches) || p.semanticMatches.some(match => !match || typeof match.segmentId !== 'string' || typeof match.text !== 'string' || typeof match.lineId !== 'string' || !['complete', 'partial', 'fumbled'].includes(match.verdict)))) throw new Error('Script matches are unreadable.');
  const transcript = Array.isArray(p.transcript) ? p.transcript.filter((s): s is TranscriptSeg =>
    !!s && typeof s.text === 'string' && Number.isFinite(s.t0) && Number.isFinite(s.t1) && s.t0 >= 0 && s.t1 >= s.t0,
  ) : [];
  return {
    ...p, schemaVersion: 2,
    videoUri: typeof p.videoUri === 'string' ? p.videoUri : null,
    clips: Array.isArray(p.clips) ? p.clips : [],
    transcript: transcript.map((s, i) => ({ ...s, id: s.id || `${p.id}:legacy:${i}` })),
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
    refinement: p.refinement?.status === 'running'
      ? { ...p.refinement, status: 'failed', error: 'Refinement was interrupted. Your previous captions are preserved; retry when ready.' }
      : p.refinement,
  };
}

function isValidActionCue(value: unknown): value is {
  id: string;
  text: string;
  required: boolean;
  resolved: boolean;
} {
  if (!value || typeof value !== 'object') return false;
  const cue = value as Record<string, unknown>;
  return typeof cue.id === 'string'
    && cue.id.trim().length > 0
    && typeof cue.text === 'string'
    && cue.text.trim().length > 0
    && typeof cue.required === 'boolean'
    && typeof cue.resolved === 'boolean';
}

export const PENDING_PICKUP_MESSAGE = 'A pickup recording is safely saved, but its captions and coverage did not finish. Review the raw recording or record those lines again.';

export interface PickupRecordingInput {
  videoUri: string;
  duration: number;
  transcript: Project['transcript'];
  takes: NonNullable<Project['takes']>;
  eligibleLineIds?: string[];
  semanticMatches?: Project['semanticMatches'];
  /** Explicit keep intervals after capture-time retakes, already accepted by the creator. */
  captureCuts?: { t0: number; t1: number }[];
  evidenceStatus?: 'pending' | 'complete';
}

/** Source times stay relative to each recording; only identities are namespaced. */
export function mergePickupRecording(project: Project, recordingId: string, input: PickupRecordingInput, createdAt: number): Project {
  const existing = project.recordings?.find(recording => recording.id === recordingId);
  if (existing && existing.mediaUri !== input.videoUri) throw new Error('This pickup evidence belongs to a different recording.');
  if (input.evidenceStatus === 'pending' && (input.transcript.length || input.takes.length || input.captureCuts !== undefined)) throw new Error('A media checkpoint cannot claim finalized caption or take evidence.');
  if (!recordingId || !Number.isFinite(input.duration) || input.duration <= 0 || !input.videoUri) throw new Error('The pickup recording is incomplete.');
  const payload = canonicalJson({ duration: input.duration, videoUri: input.videoUri, transcript: input.transcript, takes: input.takes,
    eligibleLineIds: input.eligibleLineIds ?? null, evidenceStatus: input.evidenceStatus ?? 'complete',
    ...(input.semanticMatches === undefined ? {} : { semanticMatches: input.semanticMatches }),
    ...(input.captureCuts === undefined ? {} : { captureCuts: input.captureCuts }) });
  if (existing && (existing.evidenceStatus !== 'pending' || input.evidenceStatus === 'pending')) {
    const previous = input.evidenceStatus === 'pending' ? existing.checkpointPayload : existing.completionPayload;
    if (previous !== undefined && previous !== payload) throw new Error('This pickup identity has a different payload.');
    if (existing.duration !== input.duration) throw new Error('This pickup identity has a different duration.');
    // Legacy rows lack receipts; they remain readable and cannot be rewritten by a duplicate.
    return project;
  }
  if (input.captureCuts !== undefined) {
    let end = 0;
    for (const cut of input.captureCuts) {
      if (!Number.isFinite(cut.t0) || !Number.isFinite(cut.t1) || cut.t0 < end || cut.t1 <= cut.t0 || cut.t1 > input.duration) {
        throw new Error('The pickup retake cuts are invalid.');
      }
      end = cut.t1;
    }
  }
  const segmentIds = new Map<string, string>();
  const transcript = input.transcript.map((segment, index) => {
    const oldId = segment.id ?? `segment:${index}`;
    if (segmentIds.has(oldId)) throw new Error('The pickup contains duplicate caption identities.');
    const id = `${recordingId}:caption:${encodeURIComponent(oldId)}`;
    segmentIds.set(oldId, id);
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0 || segment.t1 > input.duration || typeof segment.text !== 'string') throw new Error('The pickup caption timing is invalid.');
    return { ...segment, id, recordingId };
  });
  const takeIds = new Set<string>();
  const takes = input.takes.map(take => {
    if (take.mediaUri && take.mediaUri !== input.videoUri) throw new Error('A pickup can only reference its own recording.');
    if (takeIds.has(take.id)) throw new Error('The pickup contains duplicate take identities.');
    takeIds.add(take.id);
    if (take.t0 < 0 || take.t1 > input.duration || !Number.isFinite(take.t0) || !Number.isFinite(take.t1) || take.t1 <= take.t0) throw new Error('The pickup take timing is invalid.');
    const references = take.transcriptSegmentIds.map(id => {
      const mapped = segmentIds.get(id);
      if (!mapped) throw new Error('A pickup take references an unknown caption.');
      const segment = transcript.find(segment => segment.id === mapped)!;
      if (segment.t0 < take.t0 || segment.t1 > take.t1) throw new Error('A pickup caption falls outside its take audio interval.');
      return mapped;
    });
    return { ...take, eligibleLineIds: input.eligibleLineIds ? [...new Set(input.eligibleLineIds)] : take.eligibleLineIds, id: `${recordingId}:take:${encodeURIComponent(take.id)}`, mediaUri: input.videoUri, transcriptSegmentIds: references, recordedAt: createdAt };
  });
  const legacyTranscript = project.transcript.map((segment, index) => ({ ...segment, id: segment.id || `${project.id}:legacy:${index}` }));
  const legacyTakes = project.takes ?? legacyTranscript.filter(segment => segment.t1 > segment.t0).map(segment => ({
    id: `take:${segment.id}`, t0: segment.t0, t1: segment.t1, mediaUri: project.videoUri,
    playable: !!project.videoUri, quality: segment.needsListening ? 'scratched' as const : 'clean' as const,
    inFrame: false, transcriptSegmentIds: [segment.id], recordedAt: project.createdAt,
  }));
  const existingIds = new Set([...legacyTranscript.map(segment => segment.id), ...legacyTakes.map(take => take.id)]);
  if ([...transcript, ...takes].some(item => existingIds.has(item.id))) throw new Error('This pickup identity is already in use.');
  const primary = project.videoUri ? [{ id: `${project.id}:original`, mediaUri: project.videoUri,
    duration: project.duration ?? Math.max(0, ...legacyTranscript.map(segment => segment.t1), ...legacyTakes.map(take => take.t1)), createdAt: project.createdAt }] : [];
  const hasCaptureEdit = input.evidenceStatus !== 'pending' && (input.captureCuts !== undefined
    || project.cuts !== undefined || project.reviewSegments !== undefined);
  const previousSegments = project.reviewSegments ?? (project.recordings ?? primary)
    .filter(recording => recording.id !== recordingId)
    .flatMap(recording => (recording.mediaUri === project.videoUri && project.cuts !== undefined
      ? project.cuts : [{ t0: 0, t1: recording.duration }]).map(cut => ({ ...cut, uri: recording.mediaUri })));
  const captureSegments = hasCaptureEdit ? [...previousSegments,
    ...(input.captureCuts ?? [{ t0: 0, t1: input.duration }]).map(cut => ({ ...cut, uri: input.videoUri }))] : undefined;
  return normalizeProject({ ...project,
    recordings: existing
      ? project.recordings!.map(recording => recording.id === recordingId ? { ...recording, duration: input.duration, evidenceStatus: 'complete' as const, completionPayload: payload } : recording)
      : [...(project.recordings ?? primary), { id: recordingId, mediaUri: input.videoUri, duration: input.duration, createdAt, evidenceStatus: input.evidenceStatus ?? 'complete', ...(input.evidenceStatus === 'pending' ? { checkpointPayload: payload } : { completionPayload: payload }) }],
    semanticMatches: [...(project.semanticMatches ?? []), ...(input.semanticMatches ?? []).flatMap(match => {
      const segmentId = segmentIds.get(match.segmentId);
      return segmentId && transcript.some(segment => segment.id === segmentId && segment.text === match.text)
        && project.scriptLines?.some(line => line.id === match.lineId) ? [{ ...match, segmentId }] : [];
    })],
    transcript: [...legacyTranscript, ...transcript], takes: [...legacyTakes, ...takes],
    pickupRequest: input.evidenceStatus === 'pending' ? project.pickupRequest : undefined,
    cuts: hasCaptureEdit ? undefined : project.cuts,
    cutsReviewed: input.evidenceStatus === 'pending' ? project.cutsReviewed : hasCaptureEdit
      && ((project.cuts === undefined && project.reviewSegments === undefined) || project.cutsReviewed === true),
    reviewSegments: input.evidenceStatus === 'pending' ? project.reviewSegments : captureSegments,
    recoveryMessage: existing?.evidenceStatus === 'pending' && project.recoveryMessage === PENDING_PICKUP_MESSAGE ? undefined : project.recoveryMessage,
    captionRevision: (project.captionRevision ?? 0) + 1,
  });
}

/** An editor opened before a pickup must not overwrite newly attached history. */
export function preserveNewRecordings(current: Project, incoming: Project): Project {
  const known = new Map(incoming.recordings?.map(recording => [recording.id, recording]) ?? []);
  const added = current.recordings?.filter(recording => !known.has(recording.id)
    || (known.get(recording.id)?.evidenceStatus === 'pending' && recording.evidenceStatus !== 'pending')) ?? [];
  if (!added.length) return incoming;
  const addedIds = new Set(added.map(recording => recording.id));
  const addedUris = new Set(added.filter(recording => recording.mediaUri !== incoming.videoUri).map(recording => recording.mediaUri));
  const captionIds = new Set(incoming.transcript.map(segment => segment.id));
  const takes = incoming.takes ?? current.takes ?? [];
  const takeIds = new Set(takes.map(take => take.id));
  return { ...incoming,
    recordings: [...(incoming.recordings ?? []).filter(recording => !addedIds.has(recording.id)), ...added],
    transcript: [...incoming.transcript, ...current.transcript.filter(segment => segment.recordingId && addedIds.has(segment.recordingId) && !captionIds.has(segment.id))],
    takes: [...takes, ...(current.takes ?? []).filter(take => take.mediaUri && addedUris.has(take.mediaUri) && !takeIds.has(take.id))],
    cutsReviewed: false, reviewSegments: undefined, pickupRequest: current.pickupRequest,
    recoveryMessage: incoming.recoveryMessage === PENDING_PICKUP_MESSAGE && !current.recordings?.some(recording => recording.evidenceStatus === 'pending')
      ? current.recoveryMessage === PENDING_PICKUP_MESSAGE ? undefined : current.recoveryMessage
      : incoming.recoveryMessage,
    captionRevision: Math.max(current.captionRevision ?? 0, incoming.captionRevision ?? 0),
  };
}


/** A durable file copy does not mean capture or recognition finished successfully. */
export function projectWithDurableOriginal(project: Project, videoUri: string): Project {
  return { ...project, videoUri,
    takes: project.takes?.map(take => take.mediaUri === project.videoUri ? { ...take, mediaUri: videoUri } : take),
    recordingStatus: project.recordingStatus === 'interrupted' ? 'interrupted' : 'complete',
    recoveryMessage: project.recordingStatus === 'interrupted'
      ? project.recoveryMessage || 'Recording did not finish. The available original is safely saved for review.'
      : undefined,
  };
}


/** A late cache-backed capture finalization supplies evidence, not a new editor snapshot. */
export function preserveEditsDuringCaptureFinalization(current: Project, captured: Project): Project {
  const merged = { ...captured };
  for (const key of ['trim', 'cuts', 'cutsReviewed', 'reviewSegments', 'reviewDecisions', 'previousReviewDecisions', 'framing', 'cleanupReview', 'v15', 'automaticEdit'] as const) {
    if (key in current) Object.assign(merged, { [key]: current[key] });
  }
  merged.transcript = captured.transcript.map(segment => {
    const previous = current.transcript.find(item => item.id === segment.id && item.recordingId === segment.recordingId);
    if (!previous) return segment;
    return { ...segment,
      ...(Object.prototype.hasOwnProperty.call(previous, 'manualCorrection') ? { manualCorrection: previous.manualCorrection } : {}),
      ...(previous.correctedText !== undefined ? { correctedText: previous.correctedText } : {}),
    };
  });
  return merged;
}
