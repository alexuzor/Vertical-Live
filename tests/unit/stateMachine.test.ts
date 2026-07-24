/**
 * The state machine is what makes "Start cannot be pressed twice" and
 * "settings cannot change while live" structural guarantees rather than
 * UI conventions.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  InvalidTransitionError,
  StateMachine,
  allowedTransitions,
  canStartRecording,
  canStartStream,
  canStopRecording,
  canStopStream,
  canTransition,
  isConfigurationLocked,
  isRecordingActive,
  isStreamActive,
} from '../../src/main/streaming/StateMachine';
import type { ApplicationState } from '../../src/shared/types';

const ALL_STATES: ApplicationState[] = [
  'idle',
  'discovering-devices',
  'preview-starting',
  'previewing',
  'stream-starting',
  'streaming',
  'stream-stopping',
  'recording-starting',
  'recording',
  'recording-stopping',
  'finalising-recording',
  'error',
];

describe('canTransition', () => {
  it('allows the normal streaming lifecycle', () => {
    expect(canTransition('idle', 'stream-starting')).toBe(true);
    expect(canTransition('stream-starting', 'streaming')).toBe(true);
    expect(canTransition('streaming', 'stream-stopping')).toBe(true);
    expect(canTransition('stream-stopping', 'finalising-recording')).toBe(true);
    expect(canTransition('finalising-recording', 'idle')).toBe(true);
  });

  it('allows the preview lifecycle', () => {
    expect(canTransition('idle', 'preview-starting')).toBe(true);
    expect(canTransition('preview-starting', 'previewing')).toBe(true);
    expect(canTransition('previewing', 'idle')).toBe(true);
    expect(canTransition('previewing', 'stream-starting')).toBe(true);
  });

  it('never allows a self-transition', () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('refuses to start a second stream while one is running', () => {
    expect(canTransition('streaming', 'stream-starting')).toBe(false);
    expect(canTransition('stream-starting', 'stream-starting')).toBe(false);
  });

  it('refuses to stop when nothing is running', () => {
    expect(canTransition('idle', 'stream-stopping')).toBe(false);
    expect(canTransition('previewing', 'stream-stopping')).toBe(false);
  });

  it('refuses to open a preview while the stream owns the camera', () => {
    expect(canTransition('streaming', 'preview-starting')).toBe(false);
    expect(canTransition('stream-starting', 'preview-starting')).toBe(false);
    expect(canTransition('stream-stopping', 'preview-starting')).toBe(false);
  });

  it('always allows recovery from error', () => {
    expect(canTransition('error', 'idle')).toBe(true);
    expect(canTransition('error', 'preview-starting')).toBe(true);
    expect(canTransition('error', 'stream-starting')).toBe(true);
    expect(canTransition('error', 'recording-starting')).toBe(true);
  });

  it('allows the recording lifecycle', () => {
    expect(canTransition('idle', 'recording-starting')).toBe(true);
    expect(canTransition('previewing', 'recording-starting')).toBe(true);
    expect(canTransition('recording-starting', 'recording')).toBe(true);
    expect(canTransition('recording', 'recording-stopping')).toBe(true);
    expect(canTransition('recording-stopping', 'finalising-recording')).toBe(true);
  });

  it('keeps streaming and recording mutually exclusive', () => {
    expect(canTransition('recording', 'stream-starting')).toBe(false);
    expect(canTransition('streaming', 'recording-starting')).toBe(false);
  });

  it('lists only reachable targets', () => {
    for (const state of ALL_STATES) {
      for (const target of allowedTransitions(state)) {
        expect(ALL_STATES).toContain(target);
        expect(target).not.toBe(state);
      }
    }
  });
});

describe('predicates', () => {
  it('identifies the states where a stream process exists', () => {
    expect(isStreamActive('stream-starting')).toBe(true);
    expect(isStreamActive('streaming')).toBe(true);
    expect(isStreamActive('stream-stopping')).toBe(true);
    expect(isStreamActive('previewing')).toBe(false);
    expect(isStreamActive('idle')).toBe(false);
  });

  it('identifies the states where a recording process exists', () => {
    expect(isRecordingActive('recording-starting')).toBe(true);
    expect(isRecordingActive('recording')).toBe(true);
    expect(isRecordingActive('recording-stopping')).toBe(true);
    expect(isRecordingActive('streaming')).toBe(false);
    expect(isRecordingActive('idle')).toBe(false);
  });

  it('locks configuration for the whole streaming and recording lifecycle', () => {
    expect(isConfigurationLocked('streaming')).toBe(true);
    expect(isConfigurationLocked('stream-starting')).toBe(true);
    expect(isConfigurationLocked('recording')).toBe(true);
    expect(isConfigurationLocked('recording-starting')).toBe(true);
    expect(isConfigurationLocked('finalising-recording')).toBe(true);
    expect(isConfigurationLocked('previewing')).toBe(false);
    expect(isConfigurationLocked('idle')).toBe(false);
  });

  it('answers the questions the UI asks', () => {
    expect(canStartStream('idle')).toBe(true);
    expect(canStartStream('previewing')).toBe(true);
    expect(canStartStream('streaming')).toBe(false);

    expect(canStopStream('streaming')).toBe(true);
    expect(canStopStream('stream-starting')).toBe(true);
    expect(canStopStream('idle')).toBe(false);
    expect(canStopStream('stream-stopping')).toBe(false);

    expect(canStartRecording('idle')).toBe(true);
    expect(canStartRecording('previewing')).toBe(true);
    expect(canStartRecording('recording')).toBe(false);
    expect(canStartRecording('streaming')).toBe(false);

    expect(canStopRecording('recording')).toBe(true);
    expect(canStopRecording('recording-starting')).toBe(true);
    expect(canStopRecording('idle')).toBe(false);
    expect(canStopRecording('recording-stopping')).toBe(false);
  });
});

describe('StateMachine', () => {
  it('starts idle', () => {
    expect(new StateMachine().state).toBe('idle');
  });

  it('moves through a legal transition', () => {
    const machine = new StateMachine();
    machine.transition('stream-starting');
    expect(machine.state).toBe('stream-starting');
  });

  it('throws on an illegal transition rather than corrupting state', () => {
    const machine = new StateMachine();
    expect(() => machine.transition('streaming')).toThrow(InvalidTransitionError);
    expect(machine.state).toBe('idle');
  });

  it('tryTransition reports failure without throwing', () => {
    const machine = new StateMachine();
    expect(machine.tryTransition('streaming')).toBe(false);
    expect(machine.state).toBe('idle');
    expect(machine.tryTransition('stream-starting')).toBe(true);
    expect(machine.state).toBe('stream-starting');
  });

  it('forceTransition bypasses the rules for recovery paths', () => {
    const machine = new StateMachine('streaming');
    machine.forceTransition('idle');
    expect(machine.state).toBe('idle');
  });

  it('forceTransition to the current state is a no-op', () => {
    const machine = new StateMachine('idle');
    const listener = vi.fn();
    machine.onChange(listener);
    machine.forceTransition('idle');
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies listeners with both the old and new state', () => {
    const machine = new StateMachine();
    const listener = vi.fn();
    machine.onChange(listener);
    machine.transition('preview-starting');
    expect(listener).toHaveBeenCalledWith('preview-starting', 'idle');
  });

  it('stops notifying after unsubscribe', () => {
    const machine = new StateMachine();
    const listener = vi.fn();
    machine.onChange(listener)();
    machine.transition('preview-starting');
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects a duplicate start', () => {
    const machine = new StateMachine();
    machine.transition('stream-starting');
    machine.transition('streaming');
    expect(() => machine.transition('stream-starting')).toThrow(InvalidTransitionError);
  });

  it('rejects a duplicate stop', () => {
    const machine = new StateMachine('streaming');
    machine.transition('stream-stopping');
    expect(machine.tryTransition('stream-stopping')).toBe(false);
  });

  it('completes a full stream cycle back to idle', () => {
    const machine = new StateMachine();
    const path: ApplicationState[] = [
      'stream-starting',
      'streaming',
      'stream-stopping',
      'finalising-recording',
      'idle',
    ];
    for (const target of path) machine.transition(target);
    expect(machine.state).toBe('idle');
  });
});
