/** Typed copy + tone for each confirmation variant. */

export type ConfirmationDialogVariant = 'stop-stream' | 'stop-recording';

export interface ConfirmationContent {
  title: string;
  message: string[];
  cancelLabel: string;
  confirmLabel: string;
  busyLabel: string;
  tone: 'green' | 'red';
}

export const confirmationContent: Record<ConfirmationDialogVariant, ConfirmationContent> = {
  'stop-stream': {
    title: 'Stop live stream?',
    message: ['Your current live stream session will end.', 'You can start a new stream anytime.'],
    cancelLabel: 'Cancel',
    confirmLabel: 'Stop Stream',
    busyLabel: 'Stopping…',
    // The reference warning-modal.png uses a red confirm for stopping the stream.
    tone: 'red',
  },
  'stop-recording': {
    title: 'Stop recording?',
    message: ['The current recording will be finalised and saved to your computer.'],
    cancelLabel: 'Cancel',
    confirmLabel: 'Stop Recording',
    busyLabel: 'Finalising…',
    tone: 'red',
  },
} as const;
