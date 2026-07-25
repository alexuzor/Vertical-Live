/**
 * The dashboard controller.
 *
 * This is wired end-to-end to the real preload bridge. It loads persisted
 * settings, discovers real devices, drives the real preview / stream /
 * recording pipelines, and derives every runtime state from the status, stats
 * and error events the main process emits. Nothing here fabricates a backend
 * result.
 *
 * When the page is opened in a plain browser (no Electron bridge) the shared
 * mock in `../lib/api` stands in and a few handlers fall back to an optimistic
 * local state purely so the layout can be previewed; that path is gated behind
 * `!isElectron` and never runs in the shipped desktop app.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  coerceFps,
  MAX_AUDIO_SYNC_OFFSET_MS,
  MIN_AUDIO_SYNC_OFFSET_MS,
  resolveBitrateKbps,
} from '@shared/constants';
import type {
  ApplicationState,
  BitratePreset,
  StreamStats,
  StreamStatus,
  SystemMetrics,
  UpdateStatus,
} from '@shared/types';

import { getApi, isElectron } from '../lib/api';

export type StreamState = 'idle' | 'connecting' | 'streaming' | 'stopping' | 'error';
export type RecordingState =
  'idle' | 'starting' | 'recording' | 'stopping' | 'finalising' | 'error';
export type PreviewState = 'idle' | 'starting' | 'active' | 'error';
export type ModalVariant = 'stop-stream' | 'stop-recording';
export type ConnectionState = 'idle' | 'testing' | 'ok' | 'fail';

export interface DeviceOption {
  id: string;
  label: string;
}

export interface Toast {
  id: number;
  tone: 'green' | 'red' | 'neutral';
  text: string;
}

export interface DashboardController {
  /* Environment */
  electron: boolean;
  /** Real app version, from the main process (single source of truth). */
  appVersion: string;

  /* Runtime states (derived from the main-process status) */
  streamState: StreamState;
  recordingState: RecordingState;
  previewState: PreviewState;
  streamElapsed: number;
  recordElapsed: number;
  meterActive: boolean;
  /** Live microphone level 0..1 from the encoder's ebur128 meter. */
  audioLevel: number;
  /** True while streaming but the uplink is too weak to keep up (amber state). */
  networkDegraded: boolean;

  /* Devices */
  cameras: DeviceOption[];
  microphones: DeviceOption[];
  camera: string;
  microphone: string;
  devicesLoading: boolean;
  monitoring: boolean;
  /** Microphone noise cancellation (affects streamed and recorded audio). */
  noiseSuppression: boolean;
  fps: string;

  /* Framing */
  framing: 'fill' | 'fit';

  /* Streaming output resolution is fixed by the pipeline (720×1280). */
  streamResolution: string;

  /* Stream quality */
  bitratePreset: string;
  customBitrate: string;

  /* Facebook */
  serverUrl: string;
  streamKey: string;
  keyRevealed: boolean;
  hasStoredKey: boolean;
  connectionState: ConnectionState;
  connectionMessage: string;

  /* Recording */
  recordingPath: string;
  freeDiskLabel: string;

  /* Footer */
  cpu: number;
  liveFps: number;
  bitrateMbps: number;
  systemStatus: { ok: boolean; label: string };

  /* Modal */
  modal: { variant: ModalVariant } | null;
  modalBusy: boolean;

  /* Auto-update (GitHub Releases) */
  update: UpdateStatus & { dismissed: boolean };
  downloadUpdate: () => void;
  installUpdate: () => void;
  dismissUpdate: () => void;

  /* Toast */
  toast: Toast | null;

  /* Handlers */
  refreshDevices: () => Promise<void>;
  setCamera: (id: string) => void;
  setMicrophone: (id: string) => void;
  setMonitoring: (on: boolean) => void;
  setNoiseSuppression: (on: boolean) => void;
  audioSyncOffsetMs: number;
  setAudioSyncOffset: (ms: number) => void;
  setFps: (value: string) => void;
  setFraming: (mode: 'fill' | 'fit') => void;
  setBitratePreset: (preset: string) => void;
  setCustomBitrate: (value: string) => void;
  setServerUrl: (value: string) => void;
  setStreamKey: (value: string) => void;
  toggleKeyRevealed: () => void;
  testConnection: () => Promise<void>;
  browseFolder: () => Promise<void>;
  openFolder: () => Promise<void>;
  toggleLive: () => Promise<void>;
  toggleRecording: () => Promise<void>;
  confirmModal: () => Promise<void>;
  cancelModal: () => void;
  viewLogs: () => Promise<void>;
  diagnostics: () => Promise<void>;
  windowMinimize: () => void;
  windowToggleMaximize: () => void;
  windowClose: () => void;
  windowMaximized: boolean;
}

/* ------------------------------------------------------------------ */
/* Status → UI state mapping                                           */
/* ------------------------------------------------------------------ */

function mapStreamState(state: ApplicationState): StreamState {
  switch (state) {
    case 'stream-starting':
      return 'connecting';
    case 'streaming':
      return 'streaming';
    case 'stream-stopping':
      return 'stopping';
    default:
      return 'idle';
  }
}

function mapRecordingState(status: StreamStatus): RecordingState {
  switch (status.state) {
    case 'recording-starting':
      return 'starting';
    case 'recording':
      return 'recording';
    case 'recording-stopping':
      return 'stopping';
    case 'finalising-recording':
      return 'finalising';
    default:
      // Recording that runs as a branch of the live stream is reported through
      // the recording sub-status rather than the application state.
      if (status.recording.phase === 'recording') return 'recording';
      if (status.recording.phase === 'finalising') return 'finalising';
      return 'idle';
  }
}

function mapPreviewState(state: ApplicationState): PreviewState {
  switch (state) {
    case 'preview-starting':
      return 'starting';
    case 'previewing':
    case 'stream-starting':
    case 'streaming':
    case 'recording-starting':
    case 'recording':
      return 'active';
    default:
      return 'idle';
  }
}

const IDLE_STATUS: StreamStatus = {
  state: 'idle',
  phase: 'idle',
  streamingSince: null,
  recordingSince: null,
  recording: {
    phase: 'disabled',
    workingPath: null,
    finalPath: null,
    bytesWritten: null,
    message: null,
  },
  encoder: null,
  encoderFallbackApplied: false,
  captureMode: null,
  networkQuality: 'good',
  message: null,
};

function formatGiB(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TB`;
  return `${Math.round(gib)} GB`;
}

/** "1 camera", "2 cameras", "0 cameras" — no clunky "(s)". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

function useController(): DashboardController {
  const api = getApi();

  /* ---- config state (persisted) ---- */
  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<DeviceOption[]>([]);
  const [camera, setCameraState] = useState('');
  const [microphone, setMicrophoneState] = useState('');
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [monitoring, setMonitoringState] = useState(true);
  const [noiseSuppression, setNoiseSuppressionState] = useState(false);
  const [audioSyncOffsetMs, setAudioSyncOffsetState] = useState(0);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [fps, setFpsState] = useState('30');

  const [framing, setFramingState] = useState<'fill' | 'fit'>('fill');
  const streamResolution = '720x1280';

  const [bitratePreset, setBitratePresetState] = useState('standard');
  const [customBitrate, setCustomBitrateState] = useState('3500');

  const [serverUrl, setServerUrlState] = useState('rtmps://live-api-s.facebook.com:443/rtmp/');
  const [streamKey, setStreamKeyState] = useState('');
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);

  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [connectionMessage, setConnectionMessage] = useState('Not tested yet.');

  const [recordingPath, setRecordingPath] = useState('');

  /* ---- runtime state (from the backend) ---- */
  const [status, setStatus] = useState<StreamStatus>(IDLE_STATUS);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [metrics, setMetrics] = useState<SystemMetrics>({
    cpuPercent: 0,
    freeDiskBytes: null,
    totalDiskBytes: null,
  });
  const [ffmpegAvailable, setFfmpegAvailable] = useState(true);
  const [appVersion, setAppVersion] = useState('');
  const [errored, setErrored] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [modal, setModal] = useState<{ variant: ModalVariant } | null>(null);
  const [modalBusy, setModalBusy] = useState(false);

  /* ---- auto-update ---- */
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    state: 'unsupported',
    version: null,
    percent: 0,
    message: null,
  });
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((tone: Toast['tone'], text: string) => {
    setToast({ id: Date.now(), tone, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);

  const streamState = mapStreamState(status.state);
  const recordingState = mapRecordingState(status);
  const previewState = mapPreviewState(status.state);
  const streamActive = streamState !== 'idle' && streamState !== 'error';
  const recordActive = recordingState !== 'idle' && recordingState !== 'error';
  const networkDegraded = status.networkQuality === 'degraded' && streamState === 'streaming';

  // Announce weak-network / recovery once per transition.
  const prevDegraded = useRef(false);
  useEffect(() => {
    if (networkDegraded === prevDegraded.current) return;
    const wasDegraded = prevDegraded.current;
    prevDegraded.current = networkDegraded;
    const announce = networkDegraded || (wasDegraded && streamState === 'streaming');
    if (!announce) return;
    showToast(
      networkDegraded ? 'neutral' : 'green',
      networkDegraded
        ? 'Weak network — the stream is buffering and will keep trying.'
        : 'Network recovered — streaming normally.',
    );
  }, [networkDegraded, streamState, showToast]);

  /* ---- persistence (debounced) ---- */
  const pendingSettings = useRef<Record<string, unknown>>({});
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePersist = useCallback(
    (partial: Record<string, unknown>) => {
      if (!isElectron) return;
      pendingSettings.current = { ...pendingSettings.current, ...partial };
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        const settings = pendingSettings.current;
        pendingSettings.current = {};
        void api.saveSettings({ settings }).then((result) => {
          if (!result.ok) showToast('red', result.error.message);
        });
      }, 600);
    },
    [api, showToast],
  );

  /* ---- setters that also persist ---- */
  const setCamera = useCallback(
    (id: string) => {
      setCameraState(id);
      schedulePersist({ cameraDevice: id });
    },
    [schedulePersist],
  );
  const setMicrophone = useCallback(
    (id: string) => {
      setMicrophoneState(id);
      schedulePersist({ microphoneDevice: id });
    },
    [schedulePersist],
  );
  const setMonitoring = useCallback(
    (on: boolean) => {
      setMonitoringState(on);
      schedulePersist({ audioEnabled: on });
    },
    [schedulePersist],
  );
  // Noise cancellation only affects the streamed/recorded audio chain, so it is
  // pure config: persisting it never touches the running video preview.
  const setNoiseSuppression = useCallback(
    (on: boolean) => {
      setNoiseSuppressionState(on);
      schedulePersist({ noiseSuppression: on });
    },
    [schedulePersist],
  );
  const setAudioSyncOffset = useCallback(
    (ms: number) => {
      const clamped = Math.max(
        MIN_AUDIO_SYNC_OFFSET_MS,
        Math.min(MAX_AUDIO_SYNC_OFFSET_MS, Math.round(ms)),
      );
      setAudioSyncOffsetState(clamped);
      schedulePersist({ audioSyncOffsetMs: clamped });
    },
    [schedulePersist],
  );
  const setFps = useCallback(
    (value: string) => {
      setFpsState(value);
      schedulePersist({ fps: coerceFps(Number.parseInt(value, 10)) });
    },
    [schedulePersist],
  );
  const setFraming = useCallback(
    (mode: 'fill' | 'fit') => {
      setFramingState(mode);
      schedulePersist({ framingMode: mode });
    },
    [schedulePersist],
  );
  const setBitratePreset = useCallback(
    (preset: string) => {
      setBitratePresetState(preset);
      const partial: Record<string, unknown> = { bitratePreset: preset };
      if (preset !== 'custom') {
        const kbps = resolveBitrateKbps(preset as Exclude<BitratePreset, 'custom'>, 0);
        setCustomBitrateState(String(kbps));
        partial.customBitrateKbps = kbps;
      }
      schedulePersist(partial);
    },
    [schedulePersist],
  );
  const setCustomBitrate = useCallback(
    (value: string) => {
      setCustomBitrateState(value);
      const kbps = Number.parseInt(value, 10);
      if (Number.isFinite(kbps)) schedulePersist({ customBitrateKbps: kbps });
    },
    [schedulePersist],
  );
  const setServerUrl = useCallback(
    (value: string) => {
      setServerUrlState(value);
      schedulePersist({ facebookServerUrl: value });
      setConnectionState('idle');
      setConnectionMessage('Not tested yet.');
    },
    [schedulePersist],
  );
  const setStreamKey = useCallback((value: string) => {
    setStreamKeyState(value);
  }, []);

  /* ---- initial load ---- */
  useEffect(() => {
    let cancelled = false;

    void api.getAppInfo().then((info) => {
      if (!cancelled) setAppVersion(info.version);
    });

    void api.getFfmpegInfo().then((info) => {
      if (!cancelled) setFfmpegAvailable(info.available);
    });

    void api.getSettings().then((snapshot) => {
      if (cancelled) return;
      const s = snapshot.settings;
      if (s.cameraDevice) setCameraState(s.cameraDevice);
      if (s.microphoneDevice) setMicrophoneState(s.microphoneDevice);
      setMonitoringState(s.audioEnabled);
      setNoiseSuppressionState(s.noiseSuppression);
      setAudioSyncOffsetState(s.audioSyncOffsetMs);
      setFpsState(String(s.fps));
      setFramingState(s.framingMode);
      setBitratePresetState(s.bitratePreset);
      setCustomBitrateState(String(s.customBitrateKbps));
      if (s.facebookServerUrl) setServerUrlState(s.facebookServerUrl);
      if (s.recordingDirectory) setRecordingPath(s.recordingDirectory);
      setHasStoredKey(snapshot.hasStoredStreamKey);
    });

    void api.getStatus().then((initial) => {
      if (!cancelled) setStatus(initial);
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  /* ---- live event subscriptions ---- */
  useEffect(() => {
    const offStatus = api.onStreamStatus((next) => setStatus(next));
    const offStats = api.onStreamStats((next) => setStats(next));
    const offError = api.onStreamError((error) => {
      setErrored(true);
      showToast('red', error.message);
    });
    return () => {
      offStatus();
      offStats();
      offError();
    };
  }, [api, showToast]);

  /* ---- window maximised state: drives the header restore/maximise icon ---- */
  useEffect(() => {
    void api.window.isMaximized().then(setWindowMaximized);
    return api.window.onMaximizedChanged(setWindowMaximized);
  }, [api]);

  /* ---- auto-update: the background check runs in main; the UI just reacts ---- */
  useEffect(() => {
    void api.update.getStatus().then(setUpdateStatus);
    return api.update.onStatus((next) => {
      setUpdateStatus(next);
      // A download starting or a ready-to-install build always warrants the
      // banner, even if the user dismissed the initial "available" prompt.
      if (next.state === 'downloading' || next.state === 'downloaded') {
        setUpdateDismissed(false);
      }
    });
  }, [api]);

  const downloadUpdate = useCallback(() => {
    void api.update.download();
  }, [api]);
  const installUpdate = useCallback(() => {
    api.update.install();
  }, [api]);
  const dismissUpdate = useCallback(() => setUpdateDismissed(true), []);

  /* ---- elapsed clock: tick only while something is timing ---- */
  const timing = status.streamingSince !== null || status.recordingSince !== null;
  useEffect(() => {
    if (!timing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timing]);

  const streamElapsed = status.streamingSince
    ? Math.max(0, Math.floor((now - status.streamingSince) / 1000))
    : 0;
  const recordElapsed = status.recordingSince
    ? Math.max(0, Math.floor((now - status.recordingSince) / 1000))
    : 0;

  /* ---- host metrics polling ---- */
  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    const sample = () => {
      void api.getSystemMetrics(recordingPath || null).then((m) => {
        if (!cancelled) setMetrics(m);
      });
    };
    sample();
    const t = setInterval(sample, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [api, recordingPath]);

  /* ---- device discovery ---- */
  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const result = await api.listDevices(true);
      if (result.ok) {
        const cams = result.value.cameras.map((dv) => ({ id: dv.id, label: dv.name }));
        const mics = result.value.microphones.map((dv) => ({ id: dv.id, label: dv.name }));
        setCameras(cams);
        setMicrophones(mics);
        setCameraState((prev) =>
          cams.some((c) => c.id === prev) ? prev : (cams[0]?.id ?? ''),
        );
        setMicrophoneState((prev) =>
          mics.some((m) => m.id === prev) ? prev : (mics[0]?.id ?? ''),
        );
        if (cams.length === 0) {
          showToast('red', 'No cameras found. Connect a camera, then press Refresh.');
        } else {
          showToast(
            'green',
            `Found ${plural(cams.length, 'camera')} and ${plural(mics.length, 'microphone')}.`,
          );
        }
      } else {
        showToast('red', result.error.message);
      }
    } finally {
      setDevicesLoading(false);
    }
  }, [api, showToast]);

  // Populate the real device lists on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api.listDevices(false).catch(() => null);
      if (cancelled || !result || !result.ok) return;
      const cams = result.value.cameras.map((dv) => ({ id: dv.id, label: dv.name }));
      const mics = result.value.microphones.map((dv) => ({ id: dv.id, label: dv.name }));
      setCameras(cams);
      setMicrophones(mics);
      setCameraState((prev) =>
        prev && cams.some((c) => c.id === prev) ? prev : (cams[0]?.id ?? prev),
      );
      setMicrophoneState((prev) =>
        prev && mics.some((m) => m.id === prev) ? prev : (mics[0]?.id ?? prev),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  /* ---- video preview: camera only. Kept alive across the whole preview
     lifecycle (idle → preview-starting → previewing) and restarted only on a
     camera / framing / fps change — never on an audio change, because the mic is
     not part of this process. ---- */
  const canPreview =
    status.state === 'idle' ||
    status.state === 'preview-starting' ||
    status.state === 'previewing';
  useEffect(() => {
    if (!isElectron || !canPreview || !camera) return;
    void api
      .startPreview({
        cameraDevice: camera,
        framingMode: framing,
        fps: coerceFps(Number.parseInt(fps, 10)),
      })
      .then((result) => {
        if (!result.ok) showToast('red', result.error.message);
      });
  }, [api, canPreview, camera, framing, fps, showToast]);

  /* ---- audio meter: a separate, mic-only process. Toggling monitoring or
     changing the microphone restarts only this — the video preview above is
     untouched. Runs only while configuring; during a live send/recording the
     level comes from that pipeline's own meter instead. ---- */
  useEffect(() => {
    if (!isElectron) return;
    const wantMeter = canPreview && monitoring && Boolean(microphone);
    void api.setMeter(wantMeter ? microphone : null).then((result) => {
      if (!result.ok) showToast('red', result.error.message);
    });
  }, [api, canPreview, monitoring, microphone, showToast]);

  /* ---- live microphone level for the audio meter ---- */
  const [audioLevel, setAudioLevel] = useState(0);
  useEffect(() => {
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onAudioLevel((level) => {
      setAudioLevel(level);
      // ebur128 emits ~10x/sec while the mic is open; if the flow stops (preview
      // ends, mic released) let the meter fall back to silence rather than freeze.
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => setAudioLevel(0), 400);
    });
    return () => {
      off();
      if (staleTimer) clearTimeout(staleTimer);
    };
  }, [api]);

  /* ---- Facebook connection test (real reachability probe) ---- */
  const testConnection = useCallback(async () => {
    setConnectionState('testing');
    setConnectionMessage('Testing reachability…');
    const result = await api.testConnection(serverUrl.trim());
    setConnectionState(result.reachable ? 'ok' : 'fail');
    setConnectionMessage(result.message);
    showToast(result.reachable ? 'green' : 'red', result.message);
  }, [api, serverUrl, showToast]);

  /* ---- recording folder ---- */
  const browseFolder = useCallback(async () => {
    const result = await api.chooseRecordingFolder();
    if (result.canceled) return;
    if (result.directory) setRecordingPath(result.directory);
    if (!result.writable) showToast('red', result.error ?? 'That folder is not writable.');
  }, [api, showToast]);

  const openFolder = useCallback(async () => {
    if (!recordingPath) {
      showToast('neutral', 'Choose a recording folder first.');
      return;
    }
    const result = await api.openRecordingFolder(recordingPath);
    if (!result.ok) showToast('red', result.error.message);
  }, [api, recordingPath, showToast]);

  /* ---- live streaming ---- */
  const startLive = useCallback(async () => {
    if (!isElectron) {
      showToast('neutral', 'Streaming runs in the desktop app, not the browser preview.');
      return;
    }
    if (!camera) {
      showToast('red', 'Select a camera first.');
      return;
    }
    const key = streamKey.trim();
    if (!key && !hasStoredKey) {
      showToast('red', 'Enter your Facebook stream key first.');
      return;
    }
    setErrored(false);

    // Persist the key (encrypted) so it survives a restart, then start.
    if (key) {
      const saved = await api.saveSettings({ settings: {}, streamKey: key });
      if (saved.ok) setHasStoredKey(true);
    }

    const result = await api.startStream({
      cameraDevice: camera,
      microphoneDevice: monitoring ? microphone || null : null,
      framingMode: framing,
      fps: coerceFps(Number.parseInt(fps, 10)),
      bitrateKbps: resolveBitrateKbps(
        bitratePreset as BitratePreset,
        Number.parseInt(customBitrate, 10) || 3500,
      ),
      facebookServerUrl: serverUrl.trim(),
      recordingEnabled: false,
      recordingDirectory: recordingPath || null,
      audioSyncOffsetMs,
      noiseSuppression,
      ...(key ? { facebookStreamKey: key } : {}),
    });
    if (!result.ok) showToast('red', result.error.message);
  }, [
    api,
    audioSyncOffsetMs,
    bitratePreset,
    camera,
    customBitrate,
    fps,
    framing,
    hasStoredKey,
    microphone,
    monitoring,
    noiseSuppression,
    recordingPath,
    serverUrl,
    showToast,
    streamKey,
  ]);

  /* ---- local recording ---- */
  const startRecording = useCallback(async () => {
    if (!isElectron) {
      showToast('neutral', 'Recording runs in the desktop app, not the browser preview.');
      return;
    }
    if (!camera) {
      showToast('red', 'Select a camera first.');
      return;
    }
    if (!recordingPath) {
      showToast('red', 'Choose a recording folder first.');
      return;
    }
    setErrored(false);
    const result = await api.startRecording({
      cameraDevice: camera,
      microphoneDevice: monitoring ? microphone || null : null,
      framingMode: framing,
      fps: coerceFps(Number.parseInt(fps, 10)),
      recordingDirectory: recordingPath,
      audioSyncOffsetMs,
      noiseSuppression,
    });
    if (!result.ok) showToast('red', result.error.message);
  }, [
    api,
    audioSyncOffsetMs,
    camera,
    fps,
    framing,
    microphone,
    monitoring,
    noiseSuppression,
    recordingPath,
    showToast,
  ]);

  const toggleLive = useCallback(async () => {
    if (recordActive) {
      showToast(
        'neutral',
        'Stop the recording first — the camera runs one pipeline at a time.',
      );
      return;
    }
    if (streamState === 'idle' || streamState === 'error') {
      await startLive();
    } else if (streamState === 'streaming') {
      setModal({ variant: 'stop-stream' });
    }
  }, [recordActive, startLive, streamState, showToast]);

  const toggleRecording = useCallback(async () => {
    if (streamActive) {
      showToast(
        'neutral',
        'Stop the live stream first — the camera runs one pipeline at a time.',
      );
      return;
    }
    if (recordingState === 'idle' || recordingState === 'error') {
      await startRecording();
    } else if (recordingState === 'recording') {
      setModal({ variant: 'stop-recording' });
    }
  }, [recordingState, startRecording, streamActive, showToast]);

  /* ---- modal ---- */
  const cancelModal = useCallback(() => {
    if (modalBusy) return;
    setModal(null);
  }, [modalBusy]);

  const confirmModal = useCallback(async () => {
    if (!modal) return;
    setModalBusy(true);
    try {
      const result =
        modal.variant === 'stop-stream' ? await api.stopStream() : await api.stopRecording();
      if (!result.ok) showToast('red', result.error.message);
      else if (modal.variant === 'stop-recording') {
        const rec = result.value.recording;
        if (rec.finalPath) showToast('green', 'Recording saved.');
      }
      setModal(null);
    } catch {
      showToast('red', 'Could not complete the operation. Please try again.');
    } finally {
      setModalBusy(false);
    }
  }, [api, modal, showToast]);

  /* ---- diagnostics ---- */
  const viewLogs = useCallback(async () => {
    const result = await api.openLogFile();
    if (!result.ok) showToast('red', result.error.message);
  }, [api, showToast]);

  const diagnostics = useCallback(async () => {
    const result = await api.copyDiagnostics();
    if (result.ok) showToast('green', 'Diagnostics copied to the clipboard (redacted).');
    else showToast('red', result.error.message);
  }, [api, showToast]);

  const meterActive = monitoring && (previewState === 'active' || streamActive || recordActive);

  const systemStatus = useMemo(() => {
    if (!ffmpegAvailable) return { ok: false, label: 'FFmpeg missing' };
    if (errored) return { ok: false, label: 'Error — see logs' };
    return { ok: true, label: 'System OK' };
  }, [ffmpegAvailable, errored]);

  return {
    electron: isElectron,
    appVersion,
    streamState,
    recordingState,
    previewState,
    streamElapsed,
    recordElapsed,
    meterActive,
    audioLevel,
    networkDegraded,
    cameras,
    microphones,
    camera,
    microphone,
    devicesLoading,
    monitoring,
    noiseSuppression,
    audioSyncOffsetMs,
    fps,
    framing,
    streamResolution,
    bitratePreset,
    customBitrate,
    serverUrl,
    streamKey,
    keyRevealed,
    hasStoredKey,
    connectionState,
    connectionMessage,
    recordingPath,
    freeDiskLabel: formatGiB(metrics.freeDiskBytes),
    cpu: metrics.cpuPercent,
    liveFps: stats ? Math.round(stats.fps) : 0,
    bitrateMbps: stats ? stats.bitrateKbps / 1000 : 0,
    systemStatus,
    modal,
    modalBusy,
    update: { ...updateStatus, dismissed: updateDismissed },
    downloadUpdate,
    installUpdate,
    dismissUpdate,
    toast,
    refreshDevices,
    setCamera,
    setMicrophone,
    setMonitoring,
    setNoiseSuppression,
    setAudioSyncOffset,
    setFps,
    setFraming,
    setBitratePreset,
    setCustomBitrate,
    setServerUrl,
    setStreamKey,
    toggleKeyRevealed: () => setKeyRevealed((v) => !v),
    testConnection,
    browseFolder,
    openFolder,
    toggleLive,
    toggleRecording,
    confirmModal,
    cancelModal,
    viewLogs,
    diagnostics,
    windowMinimize: () => api.window.minimize(),
    windowToggleMaximize: () => api.window.toggleMaximize(),
    windowClose: () => api.window.close(),
    windowMaximized,
  };
}

const DashboardContext = createContext<DashboardController | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const controller = useController();
  const value = useMemo(() => controller, [controller]);
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardController {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used inside <DashboardProvider>.');
  return ctx;
}
