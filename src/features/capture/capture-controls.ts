/**
 * Capture-only command routing.
 *
 * The camera route owns this gate for the lifetime of one active take. Native
 * key events carry the generation that was active when Android observed them,
 * so a queued volume or remote event cannot leak into the next take. Taps are
 * intentionally event-id free because each explicit press is a command.
 */

export type CaptureCommand = 'advance' | 'scratch';
export type CaptureInputSource = 'tap' | 'native-key';

export interface CaptureInputEvent {
  command: CaptureCommand;
  source: CaptureInputSource;
  eventId?: number;
  generation?: number;
}

export type CaptureCommandResult =
  | {
      accepted: true;
      command: CaptureCommand;
      source: CaptureInputSource;
      takeId: string;
      generation: number;
    }
  | {
      accepted: false;
      reason: 'inactive' | 'stale-event' | 'duplicate-event' | 'invalid-event';
    };

export interface CaptureCommandGate {
  /** Starts a new active take and returns its generation token. */
  begin(takeId: string): number;
  /** Ends the active take and rejects events that arrive afterward. */
  end(): void;
  receive(event: CaptureInputEvent): CaptureCommandResult;
  readonly active: boolean;
  readonly takeId: string | null;
  readonly generation: number;
}

/**
 * Map Android key codes used by hardware volume buttons and common selfie
 * remotes. The event source is still `native-key`; no Bluetooth capability is
 * inferred from a key code.
 */
export function nativeCommandForKeyCode(keyCode: number): CaptureCommand | null {
  switch (keyCode) {
    case 24: // KEYCODE_VOLUME_UP
    case 27: // KEYCODE_CAMERA
    case 85: // KEYCODE_MEDIA_PLAY_PAUSE
      return 'advance';
    case 25: // KEYCODE_VOLUME_DOWN
      return 'scratch';
    default:
      return null;
  }
}

export function createCaptureCommandGate(): CaptureCommandGate {
  let active = false;
  let takeId: string | null = null;
  let generation = 0;
  const seenNativeEvents = new Set<number>();

  return {
    begin(nextTakeId) {
      if (typeof nextTakeId !== 'string' || !nextTakeId.trim()) {
        throw new TypeError('A capture take needs a non-empty id.');
      }
      generation += 1;
      active = true;
      takeId = nextTakeId;
      seenNativeEvents.clear();
      return generation;
    },

    end() {
      active = false;
      takeId = null;
      seenNativeEvents.clear();
    },

    receive(event) {
      if (!active || takeId === null) return { accepted: false, reason: 'inactive' };
      if (event.command !== 'advance' && event.command !== 'scratch') {
        return { accepted: false, reason: 'invalid-event' };
      }
      if (event.generation !== undefined && event.generation !== generation) {
        return { accepted: false, reason: 'stale-event' };
      }
      if (event.source === 'native-key' && !Number.isInteger(event.eventId)) {
        return { accepted: false, reason: 'invalid-event' };
      }
      if (event.source === 'native-key') {
        const eventId = event.eventId!;
        if (seenNativeEvents.has(eventId)) return { accepted: false, reason: 'duplicate-event' };
        seenNativeEvents.add(eventId);
      }
      return { accepted: true, command: event.command, source: event.source, takeId, generation };
    },

    get active() {
      return active;
    },
    get takeId() {
      return takeId;
    },
    get generation() {
      return generation;
    },
  };
}
