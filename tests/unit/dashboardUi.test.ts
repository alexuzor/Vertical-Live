/**
 * Pure UI logic: the confirmation-dialog content map and the header/status
 * clock formatter. The dialog's DOM behaviour (focus trap, Escape, tone class)
 * is exercised in the running app; these cover the parts that are pure.
 */

import { describe, expect, it } from 'vitest';

import { confirmationContent } from '../../src/renderer/components/dialogs/confirmationDialogContent';
import { formatClock } from '../../src/renderer/utils/time';

describe('confirmationContent', () => {
  it('has exactly the two supported variants', () => {
    expect(Object.keys(confirmationContent).sort()).toEqual(['stop-recording', 'stop-stream']);
  });

  it('stop-stream carries the exact reference copy', () => {
    const c = confirmationContent['stop-stream'];
    expect(c.title).toBe('Stop live stream?');
    expect(c.message).toEqual([
      'Your current live stream session will end.',
      'You can start a new stream anytime.',
    ]);
    expect(c.cancelLabel).toBe('Cancel');
    expect(c.confirmLabel).toBe('Stop Stream');
    expect(c.busyLabel).toBe('Stopping…');
  });

  it('stop-recording carries the exact reference copy', () => {
    const c = confirmationContent['stop-recording'];
    expect(c.title).toBe('Stop recording?');
    expect(c.message).toEqual([
      'The current recording will be finalised and saved to your computer.',
    ]);
    expect(c.confirmLabel).toBe('Stop Recording');
    expect(c.busyLabel).toBe('Finalising…');
  });

  it('every variant has a non-empty message and a defined tone', () => {
    for (const c of Object.values(confirmationContent)) {
      expect(c.message.length).toBeGreaterThan(0);
      expect(['green', 'red']).toContain(c.tone);
    }
  });
});

describe('formatClock', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(768)).toBe('00:12:48');
    expect(formatClock(3661)).toBe('01:01:01');
  });

  it('floors fractional seconds and clamps negatives', () => {
    expect(formatClock(12.9)).toBe('00:00:12');
    expect(formatClock(-5)).toBe('00:00:00');
  });

  it('keeps counting past an hour', () => {
    expect(formatClock(3600 * 10 + 59 * 60 + 59)).toBe('10:59:59');
  });
});
