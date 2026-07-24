# Vertical Live

A small, focused Windows desktop app that takes your camera and microphone,
composes them into a vertical **1080 × 1920** frame, and sends a **720 × 1280**
H.264/AAC stream to Facebook over RTMPS — with optional full-resolution local
recording.

It does that one job and nothing else. There are no scenes, overlays, captions,
browser sources, multistreaming, accounts, cloud sync or analytics.

---

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Requirements](#requirements)
4. [Development setup](#development-setup)
5. [FFmpeg setup](#ffmpeg-setup)
6. [Running locally](#running-locally)
7. [Building the Windows installer](#building-the-windows-installer)
8. [Using a Facebook stream key](#using-a-facebook-stream-key)
9. [Recording behaviour](#recording-behaviour)
10. [Security model](#security-model)
11. [Testing](#testing)
12. [Troubleshooting](#troubleshooting)
13. [Known limitations](#known-limitations)
14. [Directory structure](#directory-structure)
15. [Engineering decisions](#engineering-decisions)

---

## Features

- **Camera + microphone capture** via FFmpeg's DirectShow input, with device
  enumeration, capability detection and a Refresh button.
- **Vertical 1080 × 1920 composition** with two framing modes:
  - **Fill** — covers the whole frame, cropping the sides of a landscape camera.
  - **Fit** — shows the entire source, padded with black.
- **720 × 1280 Facebook output** over RTMPS: H.264 + AAC in FLV, `yuv420p`,
  48 kHz stereo, 128 Kbps audio, two-second keyframe interval.
- **Frame rate**: 24, 25 or 30 fps. GOP is derived automatically (48 / 50 / 60).
- **Bitrate presets**: Data Saver 2500, Standard 3500, High 5000, Maximum 6000
  Kbps, plus a custom value between 2000 and 6000.
- **Automatic encoder selection** across NVENC, Quick Sync, AMF and libx264 —
  each verified by a real short encode at startup, not just by being listed.
- **Optional local recording** at the full 1080 × 1920, written to MKV while
  live and remuxed to MP4 without re-encoding when you stop.
- **Live preview** of the actual composed output (360 × 640 MJPEG from the same
  filter graph that feeds Facebook).
- **Live statistics** from FFmpeg's `-progress` stream: duration, frame rate,
  bitrate, dropped frames.
- **Encrypted stream-key storage** using Windows credential encryption.

---

## Architecture

Three isolated layers, in the standard secure Electron shape:

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer  (React 19, sandboxed, no Node)                      │
│   UI, form validation, preview <img>, status rendering        │
└───────────────────────────┬──────────────────────────────────┘
                            │  window.verticalLive.*  (contextBridge)
┌───────────────────────────┴──────────────────────────────────┐
│ Preload  (sandboxed, single frozen object, 20 fixed channels) │
└───────────────────────────┬──────────────────────────────────┘
                            │  ipcMain.handle  (every payload Zod-validated)
┌───────────────────────────┴──────────────────────────────────┐
│ Main                                                          │
│   StreamingEngine ── StateMachine                             │
│     ├── FfmpegLocator        find + validate the binary       │
│     ├── DeviceDiscovery      dshow enumeration                │
│     ├── DeviceCapabilityService  capture-mode selection       │
│     ├── EncoderDetector      real synthetic encode tests      │
│     ├── FfmpegCommandBuilder pure argv generation             │
│     ├── FfmpegProcess        spawn / graceful quit / kill     │
│     ├── ProgressParser       -progress key=value stream       │
│     ├── PreviewFrameParser   MJPEG framing + rate limiting    │
│     ├── RecordingFinalizer   MKV -> MP4 remux + verification  │
│     ├── SettingsStore        atomic JSON, lenient validation  │
│     └── CredentialStore      safeStorage-encrypted key        │
└──────────────────────────────────────────────────────────────┘
```

### The FFmpeg pipeline

One FFmpeg process. **The camera is opened exactly once** and split into
branches, so the preview can never fight the stream for the device.

```
 dshow video ─┐
              ├─► fps ─► scale/crop (Fill) or scale/pad (Fit)
 dshow audio ─┘         ─► setsar=1 ─► yuv420p ─► [master] 1080×1920
                                                      │
                                                    split=3
              ┌───────────────────────┬───────────────┴────────────┐
              ▼                       ▼                            ▼
      scale=720:1280           null (1080×1920)         fps=10, scale=360:640
              │                       │                            │
        H.264 + AAC              H.264 + AAC                     MJPEG
       -f flv → RTMPS         -f matroska → .mkv           -f mjpeg → stdout
```

The concrete filter graph (Fill mode, 30 fps, recording on):

```
[0:v]fps=30,
     scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,
     crop=1080:1920,setsar=1,format=yuv420p[master];
[master]split=3[sp_stream][sp_recording][sp_preview];
[sp_stream]scale=720:1280[v_stream];
[sp_recording]null[v_record];
[sp_preview]fps=10,scale=360:640[v_preview];
[1:a]aresample=async=1000:first_pts=0,
     aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a_master];
[a_master]asplit=2[a_stream][a_record]
```

Fit mode replaces the scale/crop pair with:

```
scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,
pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black
```

---

## Requirements

- **Windows 10 or Windows 11**, x64. This version is Windows-only: capture uses
  DirectShow.
- **Node.js 20.19+** (development only).
- A DirectShow-visible camera. A microphone is optional — see
  [Known limitations](#known-limitations).

---

## Development setup

```bash
npm install
```

```bash
npm run setup:ffmpeg
```

```bash
npm run dev
```

---

## FFmpeg setup

FFmpeg is bundled as a sidecar executable. **No binary is committed** to this
repository, and no placeholder pretending to be one either.

```bash
npm run setup:ffmpeg
```

That script downloads a Windows FFmpeg build into `resources/ffmpeg/`, then
**verifies it actually works** — version, `dshow` input, `rtmp` and `rtmps`
protocols, the `libx264` encoder — and reports which hardware encoders were
compiled in. If a required feature is missing it fails there rather than at
runtime.

To pin an exact build (the script prints the hash of what it fetched):

```bash
node scripts/fetch-ffmpeg.mjs --force --sha256=<hex>
```

Offline, or behind a proxy — download the archive yourself and point at it:

```bash
node scripts/fetch-ffmpeg.mjs --from-zip=C:\Downloads\ffmpeg.zip
```

To use an FFmpeg you already have, without bundling anything:

```bash
set VERTICAL_LIVE_FFMPEG_PATH=C:\tools\ffmpeg\bin\ffmpeg.exe
```

`FfmpegLocator` resolves, in order: the environment override → the packaged
resource (`<install>/resources/ffmpeg/ffmpeg.exe`) → the repo's
`resources/ffmpeg/` → `PATH` as a logged last resort. The shipped application
never depends on a system install.

---

## Running locally

```bash
npm run dev
```

### Without a camera

Synthetic mode substitutes FFmpeg's `testsrc2` and `sine` generators for real
hardware, so the whole pipeline can be exercised on a machine with no webcam:

```bash
npm run dev:synthetic
```

### Without sending to Facebook

Dry-run mode replaces the RTMPS destination with a local FLV file. Combine the
two to validate everything end to end with no hardware and no credentials:

```bash
set VERTICAL_LIVE_SYNTHETIC_INPUT=true
set VERTICAL_LIVE_DRY_RUN=true
npm run dev
```

Neither mode is exposed in the production UI; both are shown as badges in the
status bar when active.

---

## Building the Windows installer

```bash
npm run dist:win
```

Output lands in `release/`:

- `release/Vertical Live-1.0.0-Setup-x64.exe` — NSIS installer
- `release/win-unpacked/` — the unpacked application

For a fast unpacked build with no installer:

```bash
npm run package:win
```

The installer is per-user (no administrator rights required), allows choosing
the install directory, and creates Start Menu and desktop shortcuts. FFmpeg
ships as an **unpacked** resource at `<install>/resources/ffmpeg/ffmpeg.exe` —
it must live outside `app.asar`, because an executable cannot be spawned from
inside an asar archive.

---

## Using a Facebook stream key

1. Open **Facebook Live Producer** and start a new live video.
2. Choose **Streaming software** as the source.
3. Copy the **Server URL** and **Stream key** Facebook gives you.
4. Paste both into Vertical Live and press **Start Sending to Facebook**.
5. Wait for the status to change from _Connecting_ to **Sending video to
   Facebook**.
6. **Go back to Live Producer and press Go Live.**

> **Step 6 matters.** A stream key only delivers video to Facebook's ingest
> servers. It does not publish the broadcast. Vertical Live therefore never
> claims you are "live publicly" — it only reports what it can actually verify:
> that FFmpeg has connected and is sending frames. Publishing is completed in
> Live Producer.

The Server URL is **not** hard-coded, so the app keeps working if Facebook
changes ingest hosts. The default is `rtmps://live-api-s.facebook.com:443/rtmp/`.

### Status wording

| Status                      | What it actually means                                   |
| --------------------------- | -------------------------------------------------------- |
| `Connecting to Facebook`    | FFmpeg started; the RTMP handshake is in flight          |
| `Sending video to Facebook` | FFmpeg has muxed frames to the ingest server             |
| `Stopping`                  | A graceful quit was sent; containers are being finalised |
| `Finalising recording`      | The MKV is being remuxed to MP4                          |

"Sending" is only shown once FFmpeg reports encoded frames — which, for FLV over
RTMP, can only happen _after_ the connect and publish handshake succeeded.

---

## Recording behaviour

Recording is crash-resistant by construction:

1. While live, video is written to **MKV**, which needs no seekable trailer and
   stays playable even if the process is killed.
2. On a normal stop, the MKV is remuxed to **MP4** with `-c copy`. Nothing is
   ever re-encoded.
3. The MP4 is verified to exist and be non-empty.
4. Only then is the temporary MKV deleted.
5. If the remux fails for any reason, **the MKV is kept** and you are told where
   it is. It is fully playable in VLC.

Files are named from the local wall clock:

```
Vertical-Live_2026-07-24_01-35-20.mkv   (while live)
Vertical-Live_2026-07-24_01-35-20.mp4   (after stopping)
```

Existing files are never overwritten — a `_2`, `_3` … suffix is added instead.
Windows-illegal characters and reserved device names are handled.

**If the Facebook stream fails midway**, the recording is still finalised from
whatever was written up to that point, so you keep the footage. See
[Known limitations](#known-limitations) for why the recording cannot outlive the
stream.

---

## Security model

| Control            | Setting                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `nodeIntegration`  | `false`                                                             |
| `contextIsolation` | `true`                                                              |
| `sandbox`          | `true`                                                              |
| `webSecurity`      | `true`                                                              |
| `webviewTag`       | `false`                                                             |
| Navigation         | Blocked except the app's own document; links open in the OS browser |
| New windows        | Always denied                                                       |
| Permissions        | All renderer permission requests denied                             |
| CSP (production)   | `default-src 'none'`, `script-src 'self'`, no remote origins        |

The renderer receives exactly one frozen object with 20 methods, each
hard-coding its own IPC channel. It has no `require`, no `process`, no `fs`, no
`child_process`, and no `ipcRenderer` — it cannot name a channel that is not on
the list.

Every IPC payload is validated with a **Zod** schema in the main process before
it is used. FFmpeg is always spawned with an **argument array and
`shell: false`** — never a shell string — so device names containing spaces,
quotes, apostrophes, parentheses or Unicode are passed through byte-for-byte
with no quoting rules to get wrong.

### The stream key

- Encrypted with Electron `safeStorage` (DPAPI on Windows) before it touches
  disk, and stored separately from ordinary settings.
- **Never** written to `localStorage`, `sessionStorage`, plaintext JSON, logs,
  diagnostics or crash reports.
- If the OS cannot provide encryption, the key is held **in memory for the
  session only** and is never written. The UI says so explicitly. It is never
  silently persisted in plaintext.
- Masked in the UI by default, with a Reveal/Hide control, and dropped from
  renderer memory as soon as the main process has stored it.
- Registered for redaction the moment it enters the process. Every log line,
  error message and diagnostics report passes through `redact()`, which removes
  registered secrets **and** structurally strips the path of any `rtmp://` or
  `rtmps://` URL — so a key cannot leak even through a code path that forgot to
  register it.

`Copy diagnostics` produces a fully redacted report suitable for pasting into a
bug report.

---

## Testing

```bash
npm test
```

348 tests across 15 files. Unit tests cover the Facebook URL construction,
stream-key redaction, settings validation, state-machine transitions, FFmpeg
argument generation, Fill and Fit filter graphs, GOP calculation, bitrate preset
mapping, recording filename generation, progress parsing, MJPEG frame parsing,
device-list parsing (against captured output from several FFmpeg versions),
capture-mode selection, encoder preference selection, error classification and
credential storage.

FFmpeg process creation is abstracted behind an injectable spawner, so no test
needs a camera or a real binary.

The **integration test** (`tests/integration/pipeline.test.ts`) runs the real
FFmpeg with the real generated arguments against `testsrc2` / `sine`, and
asserts that the pipeline produces a 720 × 1280 H.264/AAC stream-compatible
output, a 1080 × 1920 H.264/AAC recording-compatible output, MJPEG preview
frames on stdout, and a working stream-copy remux. It never contacts Facebook.

It is skipped (not failed) when FFmpeg is not installed, so a fresh clone still
has a green run.

```bash
npm run typecheck   # strict TypeScript, both projects
npm run lint        # ESLint
npm run build       # typecheck + build main, preload and renderer
```

---

## Troubleshooting

### Camera not listed

Press **Refresh**. If it is still missing, confirm Windows itself can see it
(Settings → Privacy & security → Camera, and the Windows Camera app). Vertical
Live lists exactly what `ffmpeg -list_devices true -f dshow -i dummy` reports.

Virtual cameras (OBS, NDI, manufacturer utilities) only appear if they register
a DirectShow filter.

### Camera already in use

DirectShow gives exclusive access. Close Teams, Zoom, OBS, the Windows Camera
app, or any browser tab holding the camera, then press **Refresh**. Vertical
Live deliberately does not retry automatically — a camera held by another app
would loop forever.

### Black preview

- Give it a moment: some cameras take several seconds to start.
- Check the status badge. `PREVIEW` with a black image usually means the camera
  is delivering frames but the lens is covered or the exposure is very low.
- If the badge stays on `STARTING`, the selected capture mode may be
  unsupported. Try a different camera and check the Devices section, which
  reports the mode actually chosen.

### No microphone audio

- Confirm **Capture microphone audio** is ticked and the right device is
  selected.
- Check the mic is not muted in Windows and is allowed in Privacy settings.
- With audio switched off (or no microphone present) Vertical Live sends
  **silent stereo audio** rather than no audio track, because Facebook's ingest
  expects one. Silence at the destination is expected in that case.

### Encoder failure / hardware encoder unavailable

Vertical Live probes each encoder at startup with a real 20-frame encode using
the exact production flags. An encoder that fails the probe is excluded, and the
app falls back automatically: NVENC → Quick Sync → AMF → libx264.

If a hardware encoder fails at _runtime_ before anything has been published, the
app automatically retries once with `libx264` and shows a **Software fallback**
tag. Open **Copy diagnostics** to see exactly which probe failed and why.

Software encoding at 1080 × 1920 plus a 720 × 1280 stream is CPU-heavy; if the
speed statistic sits below 1.0x, lower the frame rate or turn recording off.

### RTMPS connection failure

- Check the Server URL starts with `rtmps://` and matches what Live Producer
  currently shows.
- Facebook rotates ingest hosts; copy the URL fresh rather than reusing an old
  one.
- Corporate firewalls often block port 443 RTMPS. Test on another network.
- If `Copy diagnostics` reports "rtmps protocol" missing, re-run
  `npm run setup:ffmpeg` to install a build with TLS support.

### Facebook receives no video

- The status must read **Sending video to Facebook**. If it says _Connecting_,
  the handshake has not completed.
- Stream keys are usually single-use. Start a new session in Live Producer and
  copy the new key.
- Remember to press **Go Live** in Live Producer — ingest alone does not publish.

### Recording not created

- Recording must be ticked **and** a folder chosen before you start.
- The folder is write-tested when you select it; a warning appears if it is not
  writable.
- If the stream failed early, an empty recording is removed and reported rather
  than left behind.
- If you see **Kept as MKV**, the MP4 remux failed but the MKV is complete and
  playable. Use **Show recording** to open it.

### `npm run dev` fails with "Error: Electron uninstall"

Electron's own binary is downloaded by a postinstall script, which can fail
silently behind a proxy or a blocked GitHub. Re-run it:

```bash
node node_modules/electron/install.js
```

It reuses `%LOCALAPPDATA%\electron\Cache` when the zip is already there, so this
usually needs no network. Building the installer is unaffected — electron-builder
fetches its own copy.

### Antivirus warning about the packaged FFmpeg

`resources/ffmpeg/ffmpeg.exe` is a large, unsigned, statically linked binary,
which some antivirus products flag heuristically. It is the standard FFmpeg
Windows build. Verify it with the SHA-256 that `npm run setup:ffmpeg` printed,
or substitute your own trusted build — the app only requires `dshow`, `rtmp`,
`rtmps` and `libx264`.

---

## Known limitations

These are real constraints, honestly stated:

- **Facebook publishing has not been verified end to end.** No valid Facebook
  stream key was available during development. The output pipeline was verified
  instead with synthetic input against local FLV and MKV destinations, and
  by asserting stream properties with `ffprobe`. The RTMPS code path itself is
  exercised only in the sense that the same FLV muxer and argument set is used.
- **The local recording cannot outlive the stream.** FFmpeg is a single process
  with shared outputs: if the RTMP output dies, the process exits and every
  output stops. Running a second FFmpeg would mean opening the camera twice,
  which DirectShow does not allow. The mitigation is explicit and safe: the MKV
  written up to the moment of failure is always finalised into an MP4, so the
  footage is never lost.
- **The bitrate statistic is FFmpeg's aggregate.** `-progress` reports one
  figure for the invocation. The Facebook branch is deliberately output #0 so
  the number tracks it as closely as FFmpeg allows, but with recording enabled
  it may include the local file's throughput.
- **Windows only.** Capture is DirectShow-specific. macOS would need
  `avfoundation` and Linux `v4l2`/`pulse`.
- **Camera exposure, focus and white balance are not exposed.** Use the vendor's
  own utility.
- **No audio monitoring, level meters or gain control.** Deliberately out of
  scope.
- **`-level 4.1` is set only for libx264 and NVENC.** Quick Sync and AMF accept
  the option inconsistently across driver versions, so the driver's own default
  is used there. Both are still constrained by profile and bitrate.
- **The renderer bundle is not code-split.** At 227 kB minified it loads
  instantly from local disk, so splitting would add complexity for no gain.

---

## Directory structure

```
vertical-live/
├── src/
│   ├── main/                        Electron main process
│   │   ├── main.ts                  entry point, lifecycle, shutdown
│   │   ├── window.ts                window creation and hardening
│   │   ├── ipc/
│   │   │   ├── channels.ts          the complete channel surface
│   │   │   └── registerIpcHandlers.ts   validated handlers
│   │   ├── streaming/
│   │   │   ├── StreamingEngine.ts   orchestrator
│   │   │   ├── StateMachine.ts      legal transitions
│   │   │   ├── FfmpegCommandBuilder.ts  pure argv generation
│   │   │   ├── FfmpegProcess.ts     spawn / graceful quit / kill
│   │   │   ├── DeviceDiscovery.ts   dshow enumeration
│   │   │   ├── DeviceCapabilityService.ts  capture-mode selection
│   │   │   ├── EncoderDetector.ts   real synthetic encode tests
│   │   │   ├── ErrorClassifier.ts   stderr -> actionable error code
│   │   │   ├── ProgressParser.ts    -progress key=value stream
│   │   │   ├── PreviewFrameParser.ts   MJPEG framing + throttling
│   │   │   ├── ProcessRegistry.ts   orphan FFmpeg reaping
│   │   │   ├── RecordingFinalizer.ts   MKV -> MP4 remux
│   │   │   └── runProbe.ts          one-shot FFmpeg helper
│   │   ├── settings/
│   │   │   ├── SettingsStore.ts     atomic JSON persistence
│   │   │   └── CredentialStore.ts   safeStorage-encrypted key
│   │   ├── logging/
│   │   │   ├── Logger.ts            rotating, size-limited
│   │   │   └── redact.ts            secret redaction
│   │   ├── ffmpeg/
│   │   │   └── FfmpegLocator.ts     resolution + validation
│   │   └── util/
│   │       └── TypedEmitter.ts      typed event emitter
│   ├── preload/
│   │   ├── preload.ts               the contextBridge surface
│   │   └── global.d.ts              window.verticalLive typing
│   ├── renderer/
│   │   ├── index.html               CSP-carrying shell
│   │   ├── main.tsx, App.tsx
│   │   ├── components/              7 UI components
│   │   ├── hooks/                   controller, preview frames, elapsed
│   │   ├── stores/streamStore.ts    Zustand store
│   │   ├── styles/global.css
│   │   └── utils/format.ts
│   └── shared/
│       ├── types.ts                 the full IPC contract
│       ├── schemas.ts               Zod validation
│       ├── constants.ts             dimensions, presets, timeouts
│       └── errors.ts                error taxonomy
├── resources/ffmpeg/                bundled sidecar (not committed)
├── scripts/
│   ├── fetch-ffmpeg.mjs             download + verify FFmpeg
│   └── generate-icon.mjs            build/icon.ico
├── tests/
│   ├── unit/                        14 suites
│   └── integration/pipeline.test.ts real FFmpeg, synthetic input
├── electron-builder.yml
├── electron.vite.config.ts
├── vitest.config.ts
└── package.json
```

---

## Engineering decisions

Decisions worth recording, with the reasoning:

- **`-progress pipe:2` with `-nostats`.** Statistics come from FFmpeg's
  machine-readable stream, never from scraping the human-readable status line.
  Progress goes to stderr alongside logs because stdout carries binary MJPEG
  and must stay clean; `-nostats` prevents the two text streams from
  interleaving mid-line, and the parser ignores anything that is not a known
  `key=value`. Note that FFmpeg writes microseconds into _both_ `out_time_us`
  and `out_time_ms` — a long-standing quirk the parser accounts for.

- **DirectShow names are passed verbatim, not escaped.** FFmpeg's
  `parse_device_name` splits on `=` and `:` with `strtok` and supports no escape
  sequences. Backslash-escaping a colon would make things worse: the backslash
  would pass through literally and the colon would still split the token. The
  correct handling is to spawn with an argv array (so spaces, quotes and Unicode
  survive untouched) and fall back to the DirectShow "Alternative name" for the
  rare device whose friendly name contains a colon.

- **Graceful stop writes `q` to stdin.** On Windows FFmpeg reads piped stdin via
  `PeekNamedPipe`, so this works exactly as it would from a console. It lets
  FFmpeg flush muxers and write container trailers. `taskkill /T /F` is the
  escalation after an 8-second timeout, not the first resort — killing
  immediately corrupts recordings.

- **Encoders are probed with production flags.** Being listed in `-encoders`
  only proves the binary was compiled with support, not that this GPU and driver
  can use it. Each candidate runs a 20-frame `testsrc2` encode with the exact
  argument set production will use, which is what makes "Encoder: Automatic"
  trustworthy.

- **Silence instead of `-an` when audio is off.** Facebook's ingest expects an
  audio track; `anullsrc` keeps the stream valid for a camera-only broadcast.

- **B-frames disabled everywhere.** Facebook's ingest is happiest without them
  and it keeps the software and hardware paths behaviourally identical.

- **The preview is an FFmpeg branch, not a browser `getUserMedia` view.** A
  browser preview would show an unrelated crop and would contend for the camera.
  Deriving it from the same `split` guarantees what you see is what is sent.

- **Preview frames are rate-limited with latest-wins.** Old frames are dropped
  rather than queued, so a busy renderer can never apply back-pressure to
  FFmpeg. At most two object URLs exist at a time and every one is revoked.

- **Zod never reaches the renderer.** Validation is a main-process
  responsibility; the two pure helpers the UI needs live in `constants.ts`. This
  removed 140 kB from the renderer bundle.

- **The main process is shipped unminified.** Source maps are excluded from the
  installer, so readable identifiers are what make a stack trace in the log file
  diagnosable. The renderer is minified because it reports failures through the
  app's own error banner.

- **Orphan reaping is PID-verified.** Spawned PIDs are recorded to disk; on the
  next start each is checked with `tasklist` to confirm it is still an
  `ffmpeg.exe` before `taskkill` runs, so a recycled PID can never cause an
  unrelated process to be killed.

- **All dependencies are bundled by Vite; `dependencies` is empty.** Nothing is
  loaded from `node_modules` at runtime, which keeps the installer small and the
  packaged surface minimal.

---

## Licence

MIT.
