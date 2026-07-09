# 🎬 GifMayker

Capture anything on your screen → turn it into a GIF in seconds → paste it anywhere.
A lightweight desktop app that lives in your menu bar/tray, opens with a global
hotkey, and gives you a full little editor — text, stickers, your webcam, theming —
before you copy the result.

**No third-party sites, no uploads, no accounts.** Everything runs locally: capture,
record, edit, and copy. Your clips never leave your machine.

> Built with Electron + a bundled FFmpeg. Cross-platform (macOS + Windows), shipped
> via automated GitHub Actions releases.

<!-- TODO: drop a demo GIF here — made with GifMayker itself 🙂
![GifMayker demo](docs/demo.gif) -->

## ✨ Features

### 🎥 Capture & record
- **Capture any screen or window**, up to 60 seconds.
- **Webcam capture** — record just your camera, or…
- **Screen + Webcam (Picture-in-Picture)** — record both at once; your webcam
  drops into the editor as a **movable, resizable video overlay** you place
  wherever you want before exporting.
- **Instant Replay** — a background buffer quietly holds the last few seconds so
  you can save a clip *after* the moment happened. Hit the Save-Replay hotkey and
  it lands in the editor. Works for screen, webcam, or screen + webcam PiP.

### ✂️ Edit before exporting
- **Trim** with dual handles and **crop** with draggable corners/edges +
  aspect-ratio lock (free / 1:1 / 4:3 / 16:9 / 9:16…).
- **Text captions** — drag them anywhere, pick the color, baked crisply into the GIF.
- **Stickers / image overlays** — drop in a PNG, drag/resize (8 handles: corners
  scale, edges stretch), and layer it. Recently used stickers are saved for reuse.
- **Layer ordering** — send any text or sticker forward/back so overlays stack how
  you want.
- **Black bars** — one-click letterbox/pillarbox on any side (with an *Equalize*
  button) to give captions a clean, readable backing.
- **Snap guides** — soft alignment guides while dragging overlays so things line up.
- **Output controls** — resolution from 144p up to original, frame rates from
  2.5–20 fps, and playback speed 0.25×–5× for that "deep-fried" meme energy.

### 🎨 Make it yours
- **Custom theme** — accent, background, and text colors via color wheels.
- **Preset themes** — six ready-made palettes (Maykr Gold, Crimson, Emerald,
  Ocean, Violet, Slate) one click away.
- **Custom background image** — set any image as the app's backdrop, with an
  automatic readability scrim so text stays legible.

### 📋 GifBoard & sharing
- **Copy GIF to clipboard** — paste straight into Discord, iMessage, Slack…
- **GifBoard** — pin your favorite GIFs to a board and click to copy instantly.
- **Edit pinned GIFs** — add text or stickers to an existing board GIF and save it
  as a new one (the original is kept).
- **Per-GIF quick-keys** — bind a global hotkey to any board GIF to copy it to your
  clipboard from *anywhere*, even mid-game. Unbound by default.

### 🧩 Quality of life
- **Global hotkeys** — Capture (`⌘/Ctrl + Shift + G`), GifBoard
  (`⌘/Ctrl + Shift + B`), Save Replay (`⌘/Ctrl + Shift + R`). Rebindable.
- **In-app update banner** — checks GitHub Releases and offers a one-click download
  when a newer version ships. No auto-updater, no telemetry.
- **Tray app** — closing a window just hides it; it stays ready in the tray/menu bar.

## 📥 Download & install

Grab the file for your system from the [**Releases**](../../releases/latest) page:

| Your machine | Download |
|---|---|
| **Windows** | `GifMayker-<version>-win-x64.exe` |
| **Mac** (Intel *and* Apple Silicon) | `GifMayker-<version>-mac-universal.dmg` |

> The Mac build is **universal** — the one `.dmg` runs on both Intel and Apple Silicon.

### First-launch notes (the app is unsigned)
- **Windows:** SmartScreen may say "Windows protected your PC" → **More info** → **Run anyway**.
- **macOS:** right-click the app → **Open** (once) to get past Gatekeeper.
- **macOS Screen Recording:** the first capture asks for permission. Grant it in
  **System Settings → Privacy & Security → Screen Recording**, then **quit and
  reopen** the app (macOS requires a restart for it to take effect).
- **Camera:** webcam capture / PiP asks for Camera permission the first time. On
  Windows a webcam can only be used by one app at a time, so close Discord/Zoom (or
  turn off Instant Replay) if the camera won't open — GifMayker falls back to
  screen-only rather than failing.

## 🛠️ Tech & architecture

- **Electron** shell — three windows (control, capture editor, GifBoard) plus a
  hidden buffer window that powers Instant Replay.
- **Screen/webcam capture** via `desktopCapturer` + `getUserMedia` → `MediaRecorder`
  (dual recorders for Picture-in-Picture).
- **GIF encoding** with a **bundled FFmpeg** (`ffmpeg-static`, lipo-merged to a
  universal binary for macOS) — palette-gen/paletteuse for clean color, with
  filtergraphs composing crop, speed, text, sticker overlays, black bars, and
  video-over-video for the PiP webcam.
- **Fully local** — no servers, no uploads, no accounts.

## 🏗️ Build from source

```bash
npm install
npm start          # run in dev
npm run dist:mac   # build a .dmg for your Mac's arch
npm run dist:win   # build a Windows .exe (run on Windows)
```

Releases (all platforms) are built automatically by GitHub Actions when a
`v*` tag is pushed — see `.github/workflows/release.yml`.

## 🔒 Secrets

This repo is public. **Never commit API keys or secrets.** Keep them in a local
`.env` (git-ignored) at runtime, or in **GitHub Actions Secrets** for CI.

## 📄 License

© 2026 Jovan Kirovski (BigJover). **All Rights Reserved** — see [LICENSE](LICENSE).
This is **not** open source: the code is viewable for portfolio/reference, but
copying, modifying, redistributing, or reusing it (including via AI/LLM tools)
is not permitted without written permission. Official released builds are free
to download and use.
