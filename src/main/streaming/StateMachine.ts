/**
 * The single source of truth for what the application is doing.
 *
 * Every guard the UI relies on ("Start cannot be pressed twice", "settings are
 * locked while live", "Stop does nothing when idle") is enforced here rather
 * than by a scatter of booleans, so an invalid transition is impossible even if
 * the renderer is compromised or a race slips through.
 */

import type { ApplicationState } from '../../shared/types';

/** Legal transitions. Anything not listed is rejected. */
const TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> = {
  idle: [
    'discovering-devices',
    'preview-starting',
    'stream-starting',
    'recording-starting',
    'error',
  ],
  'discovering-devices': ['idle', 'error'],
  'preview-starting': ['previewing', 'idle', 'error'],
  previewing: ['idle', 'stream-starting', 'recording-starting', 'preview-starting', 'error'],
  'stream-starting': ['streaming', 'stream-stopping', 'finalising-recording', 'idle', 'error'],
  streaming: ['stream-stopping', 'error'],
  'stream-stopping': ['finalising-recording', 'idle', 'error'],
  'recording-starting': [
    'recording',
    'recording-stopping',
    'finalising-recording',
    'idle',
    'error',
  ],
  recording: ['recording-stopping', 'error'],
  'recording-stopping': ['finalising-recording', 'idle', 'error'],
  'finalising-recording': ['idle', 'error'],
  error: [
    'idle',
    'discovering-devices',
    'preview-starting',
    'stream-starting',
    'recording-starting',
  ],
};

/** States in which an outgoing FFmpeg stream process exists. */
const ACTIVE_STREAM_STATES: ReadonlySet<ApplicationState> = new Set<ApplicationState>([
  'stream-starting',
  'streaming',
  'stream-stopping',
]);

/** States in which a local recording (with no outgoing stream) is running. */
const ACTIVE_RECORDING_STATES: ReadonlySet<ApplicationState> = new Set<ApplicationState>([
  'recording-starting',
  'recording',
  'recording-stopping',
]);

/** States in which configuration must not change. */
const LOCKED_STATES: ReadonlySet<ApplicationState> = new Set<ApplicationState>([
  'stream-starting',
  'streaming',
  'stream-stopping',
  'recording-starting',
  'recording',
  'recording-stopping',
  'finalising-recording',
]);

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ApplicationState,
    readonly to: ApplicationState,
  ) {
    super(`Cannot move from "${from}" to "${to}".`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  if (from === to) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTransitions(from: ApplicationState): readonly ApplicationState[] {
  return TRANSITIONS[from] ?? [];
}

export function isStreamActive(state: ApplicationState): boolean {
  return ACTIVE_STREAM_STATES.has(state);
}

export function isRecordingActive(state: ApplicationState): boolean {
  return ACTIVE_RECORDING_STATES.has(state);
}

export function isConfigurationLocked(state: ApplicationState): boolean {
  return LOCKED_STATES.has(state);
}

/** True when Start is a legal action right now. */
export function canStartStream(state: ApplicationState): boolean {
  return canTransition(state, 'stream-starting');
}

/** True when Stop is a legal action right now. */
export function canStopStream(state: ApplicationState): boolean {
  return state === 'streaming' || state === 'stream-starting';
}

/** True when starting a local recording is a legal action right now. */
export function canStartRecording(state: ApplicationState): boolean {
  return canTransition(state, 'recording-starting');
}

/** True when stopping a local recording is a legal action right now. */
export function canStopRecording(state: ApplicationState): boolean {
  return state === 'recording' || state === 'recording-starting';
}

export type StateListener = (to: ApplicationState, from: ApplicationState) => void;

export class StateMachine {
  private current: ApplicationState;
  private readonly listeners = new Set<StateListener>();

  constructor(initial: ApplicationState = 'idle') {
    this.current = initial;
  }

  get state(): ApplicationState {
    return this.current;
  }

  can(to: ApplicationState): boolean {
    return canTransition(this.current, to);
  }

  /** Transitions or throws. Use for actions the user explicitly requested. */
  transition(to: ApplicationState): ApplicationState {
    if (!this.can(to)) throw new InvalidTransitionError(this.current, to);
    const from = this.current;
    this.current = to;
    for (const listener of this.listeners) listener(to, from);
    return to;
  }

  /**
   * Transitions if legal, otherwise leaves the state untouched.
   * Used for asynchronous events (a process exiting, a device vanishing) where
   * a losing race must not crash the app.
   */
  tryTransition(to: ApplicationState): boolean {
    if (!this.can(to)) return false;
    this.transition(to);
    return true;
  }

  /**
   * Forces the state without checking. Reserved for recovery paths that must
   * always succeed, such as returning to `idle` after a fatal error.
   */
  forceTransition(to: ApplicationState): void {
    if (this.current === to) return;
    const from = this.current;
    this.current = to;
    for (const listener of this.listeners) listener(to, from);
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
