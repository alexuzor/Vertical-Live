/**
 * Error taxonomy shared by every layer. Classification happens in the main
 * process; the renderer only ever renders the friendly message and, on demand,
 * the already-redacted technical detail.
 */

export const ERROR_CODES = [
  'ffmpeg-missing',
  'ffmpeg-unusable',
  'no-camera-found',
  'no-microphone-found',
  'camera-in-use',
  'camera-disconnected',
  'camera-not-found',
  'microphone-unavailable',
  'unsupported-camera-mode',
  'encoder-unavailable',
  'hardware-encoder-init-failed',
  'invalid-facebook-url',
  'invalid-stream-key',
  'publish-rejected',
  'rtmp-connection-refused',
  'dns-failure',
  'network-disconnected',
  'network-interrupted',
  'recording-path-unwritable',
  'disk-full',
  'permission-denied',
  'recording-finalise-failed',
  'unexpected-exit',
  'invalid-state-transition',
  'invalid-configuration',
  'encryption-unavailable',
  'internal-error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Short, non-technical sentences shown in the error banner. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  'ffmpeg-missing':
    'FFmpeg was not found. Run "npm run setup:ffmpeg" or reinstall Vertical Live.',
  'ffmpeg-unusable': 'The bundled FFmpeg build is missing features Vertical Live needs.',
  'no-camera-found': 'No camera was found. Connect a camera and press Refresh.',
  'no-microphone-found':
    'No microphone was found. Connect one and press Refresh, or turn audio off.',
  'camera-in-use':
    'The camera is already in use by another application. Close it and try again.',
  'camera-disconnected': 'The camera was disconnected.',
  'camera-not-found':
    'The selected camera is no longer available. Press Refresh and pick another.',
  'microphone-unavailable':
    'The selected microphone is unavailable. Pick another or turn audio off.',
  'unsupported-camera-mode':
    'The camera cannot run at the requested resolution and frame rate.',
  'encoder-unavailable': 'No usable H.264 encoder was found on this computer.',
  'hardware-encoder-init-failed':
    'The hardware video encoder failed to start. Vertical Live will use software encoding.',
  'invalid-facebook-url':
    'The Facebook server URL is not valid. It must start with rtmps:// or rtmp://.',
  'invalid-stream-key': 'The Facebook stream key is empty or not valid.',
  'publish-rejected':
    'Facebook rejected the stream. Check that the stream key is current and not already in use.',
  'rtmp-connection-refused':
    'Facebook refused the connection. Check the server URL and your network.',
  'dns-failure':
    'The Facebook server name could not be resolved. Check your internet connection.',
  'network-disconnected': 'The network connection was lost.',
  'network-interrupted': 'The connection to Facebook was interrupted while sending.',
  'recording-path-unwritable':
    'The recording folder cannot be written to. Pick a different folder.',
  'disk-full': 'The disk is full. Free some space and try again.',
  'permission-denied': 'Windows denied access to a required device or folder.',
  'recording-finalise-failed':
    'The recording could not be converted to MP4. The original MKV file was kept.',
  'unexpected-exit': 'FFmpeg stopped unexpectedly.',
  'invalid-state-transition': 'That action is not available right now.',
  'invalid-configuration': 'Some settings are incomplete or not valid.',
  'encryption-unavailable':
    'Windows credential encryption is unavailable, so the stream key is only kept for this session.',
  'internal-error': 'Vertical Live hit an unexpected internal error.',
};

/** Errors after which the app can keep running without a restart. */
const RECOVERABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'no-camera-found',
  'no-microphone-found',
  'camera-in-use',
  'camera-disconnected',
  'camera-not-found',
  'microphone-unavailable',
  'unsupported-camera-mode',
  'hardware-encoder-init-failed',
  'invalid-facebook-url',
  'invalid-stream-key',
  'publish-rejected',
  'rtmp-connection-refused',
  'dns-failure',
  'network-disconnected',
  'network-interrupted',
  'recording-path-unwritable',
  'disk-full',
  'permission-denied',
  'recording-finalise-failed',
  'unexpected-exit',
  'invalid-state-transition',
  'invalid-configuration',
  'encryption-unavailable',
]);

export function isRecoverable(code: ErrorCode): boolean {
  return RECOVERABLE.has(code);
}

/**
 * The single error type thrown inside the main process. `detail` must already
 * be redacted by the caller before it reaches here.
 */
export class VerticalLiveError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | null;

  constructor(code: ErrorCode, detail?: string | null, messageOverride?: string) {
    super(messageOverride ?? ERROR_MESSAGES[code]);
    this.name = 'VerticalLiveError';
    this.code = code;
    this.detail = detail ?? null;
  }

  get recoverable(): boolean {
    return isRecoverable(this.code);
  }
}
