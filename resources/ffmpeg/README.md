# resources/ffmpeg

This directory holds the FFmpeg executable that Vertical Live bundles and runs.

**It is intentionally empty in version control.** No binary is committed, and no
placeholder file pretending to be FFmpeg is committed either — a fake would fail
at runtime in a confusing way.

## Install FFmpeg here

```bash
npm run setup:ffmpeg
```

That script downloads a Windows FFmpeg build, extracts `ffmpeg.exe` (and
`ffprobe.exe`) into this directory, and then **verifies the binary actually
works**: it checks the version, the `dshow` input device, the `rtmp` and `rtmps`
protocols and the `libx264` encoder, and reports which hardware encoders were
compiled in. If a required feature is missing the script fails rather than
letting the app break later.

### Pinning a specific build

The script prints the SHA-256 of whatever it downloaded. To pin that exact build
in CI:

```bash
node scripts/fetch-ffmpeg.mjs --force --sha256=<hex-from-the-previous-run>
```

### Offline or manual install

Download a Windows build yourself and either point the script at the archive:

```bash
node scripts/fetch-ffmpeg.mjs --from-zip=C:\Downloads\ffmpeg.zip
```

…or simply copy `ffmpeg.exe` into this directory by hand.

### Using an FFmpeg you already have

Set an environment variable and no bundling is needed for development:

```bash
set VERTICAL_LIVE_FFMPEG_PATH=C:\tools\ffmpeg\bin\ffmpeg.exe
```

## Requirements

The build must include:

| Feature      | Why                                        | Required |
| ------------ | ------------------------------------------ | -------- |
| `dshow`      | camera and microphone capture on Windows   | yes      |
| `rtmp`       | sending to Facebook                        | yes      |
| `rtmps`      | sending to Facebook over TLS               | strongly recommended |
| `libx264`    | software H.264 fallback                    | yes      |
| `h264_nvenc` / `h264_qsv` / `h264_amf` | hardware encoding | optional |

Hardware encoders are optional: Vertical Live probes each one with a real short
encode at startup and automatically falls back to `libx264`.

## Packaging

`electron-builder.yml` copies this directory to `<install>/resources/ffmpeg`
via `extraResources`, which keeps it **outside** the asar archive. That matters:
an executable cannot be spawned from inside asar.
