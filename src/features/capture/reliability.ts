export type PermissionLike = {
  granted: boolean;
  canAskAgain?: boolean;
  status?: string;
};

export type CapturePermissionState = 'loading' | 'ready' | 'requestable' | 'settings';
export type PermissionRecoveryAction = 'none' | 'request' | 'settings';

export type CapturePermissionDescription = {
  state: CapturePermissionState;
  missing: ('camera' | 'microphone')[];
  action: PermissionRecoveryAction;
  title: string;
  message: string;
};

function isMissing(permission: PermissionLike | null | undefined) {
  return permission != null && !permission.granted;
}

/**
 * Converts Expo permission responses into one stable decision for the camera
 * screen. A null response means the permission hook is still loading and must
 * not be presented as a denial.
 */
export function describeCapturePermissions(
  camera: PermissionLike | null | undefined,
  microphone: PermissionLike | null | undefined,
): CapturePermissionDescription {
  if (!camera || !microphone) {
    return {
      state: 'loading',
      missing: [],
      action: 'none',
      title: 'Checking camera and microphone access',
      message: 'Checking device access before opening the camera.',
    };
  }

  const missing: ('camera' | 'microphone')[] = [];
  if (isMissing(camera)) missing.push('camera');
  if (isMissing(microphone)) missing.push('microphone');
  if (!missing.length) {
    return {
      state: 'ready',
      missing,
      action: 'none',
      title: 'Camera and microphone access',
      message: 'Camera and microphone access is ready.',
    };
  }

  const permanentlyBlocked = missing.some(name =>
    name === 'camera' ? camera.canAskAgain === false : microphone.canAskAgain === false,
  );
  const action: PermissionRecoveryAction = permanentlyBlocked ? 'settings' : 'request';

  let message: string;
  if (missing.length === 2) {
    message = permanentlyBlocked
      ? 'Camera and microphone access is blocked. Open Settings, allow both permissions, and return to try again.'
      : 'One Take needs camera access for video and microphone access for audio. Allow both permissions to record.';
  } else if (missing[0] === 'camera') {
    message = permanentlyBlocked
      ? 'Camera access is blocked. Open Settings, allow camera access, and return to try again.'
      : 'Camera access is needed to record video. Allow it to start a take.';
  } else {
    message = permanentlyBlocked
      ? 'Microphone access is blocked. Open Settings, allow microphone access, and return to try again.'
      : 'Microphone access is needed to include audio. Allow it to start a take.';
  }

  return {
    state: permanentlyBlocked ? 'settings' : 'requestable',
    missing,
    action,
    title: missing.length === 2 ? 'Camera and microphone access' : `${missing[0] === 'camera' ? 'Camera' : 'Microphone'} access needed`,
    message,
  };
}

export const CAPTURE_STORAGE_WARNING_BYTES = 512 * 1024 * 1024;
export const CAPTURE_STORAGE_BLOCK_BYTES = 64 * 1024 * 1024;

export type CaptureStorageState = 'ok' | 'warning' | 'blocked' | 'unknown';

export type CaptureStorageCheck = {
  state: CaptureStorageState;
  availableBytes: number | null;
  canRecord: boolean;
  message: string;
};

function formatMegabytes(bytes: number) {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * Checks the synchronous SDK 57 `Paths.availableDiskSpace` value before a
 * take. Unknown values remain recordable because a failed probe must not make
 * the optional preflight more restrictive than the camera itself.
 */
export function inspectCaptureStorage(availableDiskSpace: unknown): CaptureStorageCheck {
  if (typeof availableDiskSpace !== 'number' || !Number.isFinite(availableDiskSpace) || availableDiskSpace < 0) {
    return {
      state: 'unknown',
      availableBytes: null,
      canRecord: true,
      message: 'Storage availability could not be checked. Save the take promptly after recording.',
    };
  }

  if (availableDiskSpace < CAPTURE_STORAGE_BLOCK_BYTES) {
    return {
      state: 'blocked',
      availableBytes: availableDiskSpace,
      canRecord: false,
      message: `Only ${formatMegabytes(availableDiskSpace)} is free. Free space before recording so the take can be saved safely.`,
    };
  }

  if (availableDiskSpace < CAPTURE_STORAGE_WARNING_BYTES) {
    return {
      state: 'warning',
      availableBytes: availableDiskSpace,
      canRecord: true,
      message: `Only ${formatMegabytes(availableDiskSpace)} is free. Free space before a long take and save the recording promptly.`,
    };
  }

  return {
    state: 'ok',
    availableBytes: availableDiskSpace,
    canRecord: true,
    message: '',
  };
}

export type CaptureFailureKind = 'camera-busy' | 'storage' | 'permission' | 'interrupted' | 'unknown';

function errorText(error: unknown) {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    return '';
  }
}

/** Maps Expo Camera/CameraX and lifecycle errors to user-facing recovery paths. */
export function classifyCaptureFailure(error: unknown): CaptureFailureKind {
  const text = errorText(error).toLowerCase();
  if (!text) return 'unknown';
  if (/(source inactive|interrupted|activity destroyed|unmounted|background|cancel(?:led|ed))/.test(text)) {
    return 'interrupted';
  }
  if (/(permission|missing.*camera|missing.*record[_ ]audio|record[_ ]audio|not authorized|denied)/.test(text)) {
    return 'permission';
  }
  if (/(no space|storage|disk|could not create video file|file size|space left)/.test(text)) {
    return 'storage';
  }
  if (/(already.*(?:in )?use|in use|camera.*busy|camera.*unavailable|failed to bind|could not be started)/.test(text)) {
    return 'camera-busy';
  }
  return 'unknown';
}

export function captureFailureMessage(kind: CaptureFailureKind) {
  switch (kind) {
    case 'camera-busy':
      return 'The camera is busy or unavailable. Close other camera apps, then tap Retry camera.';
    case 'storage':
      return 'Recording stopped because device storage is low. Free space and try again. Any saved partial take remains marked for review.';
    case 'permission':
      return 'Camera or microphone access was lost. Re-enable the permission in Settings, then try again.';
    case 'interrupted':
      return 'Recording was interrupted before it finished. The take is marked for review and can be recovered from Projects.';
    case 'unknown':
      return 'Recording failed before a complete take was saved. Please try again.';
  }
}

export type CaptureStopReason = 'user' | 'interruption' | 'storage' | 'screen-blur' | 'cleanup';

export type StopLatch = {
  readonly requested: boolean;
  readonly reason: CaptureStopReason | null;
  request(reason: CaptureStopReason): boolean;
  reset(): void;
};

/** Ensures rapid taps and duplicate lifecycle callbacks issue one stop intent. */
export function createStopLatch(): StopLatch {
  let requested = false;
  let reason: CaptureStopReason | null = null;
  return {
    get requested() {
      return requested;
    },
    get reason() {
      return reason;
    },
    request(nextReason) {
      if (requested) return false;
      requested = true;
      reason = nextReason;
      return true;
    },
    reset() {
      requested = false;
      reason = null;
    },
  };
}
