import type { Project } from './session';

/** Runtime availability projection only; never delete source identities or decisions. */
export function projectForMediaReview(project: Project, failedUris: readonly string[] = []): Project {
  const available = (project.availableMediaUris ?? (project.videoUri && project.mediaMissing === false ? [project.videoUri] : []))
    .filter(uri => !failedUris.includes(uri));
  return { ...project, availableMediaUris: available,
    mediaMissing: !project.videoUri || !available.includes(project.videoUri),
    takes: project.takes?.map(take => ({ ...take, playable: take.playable && !!take.mediaUri && available.includes(take.mediaUri) })),
  };
}

/** Availability projections must not permanently rewrite a take's stored evidence. */
export function preserveStoredMediaEvidence(base: Project, edited: Project): Project {
  return { ...edited, takes: edited.takes?.map(take => {
    const stored = base.takes?.find(item => item.id === take.id && item.mediaUri === take.mediaUri);
    return stored ? { ...take, playable: stored.playable } : take;
  }) };
}
