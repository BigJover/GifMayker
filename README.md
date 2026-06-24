# 🎬 GifMayker

Capture anything on your screen → turn it into a GIF in seconds → paste it anywhere.
A lightweight desktop app that lives in your menu bar/tray, opens with a global
hotkey, and keeps your favorite GIFs one click away in a built-in soundboard.

No third-party sites, no uploads — capture, trim, crop, and copy, all locally.

## ✨ Features

- **Global hotkeys** — open Capture (`⌘/Ctrl + Shift + G`) or GifBoard
  (`⌘/Ctrl + Shift + B`) from anywhere, even mid-game. Rebindable.
- **Capture any screen or window**, up to 60 seconds.
- **Edit before exporting** — trim with dual handles, crop with draggable
  corners/edges and aspect-ratio lock (free / 1:1 / 4:3 / 16:9 / 9:16…).
- **Make it yours** — resolution from 144p up to original, frame rates from
  2.5–20 fps, and playback speed 0.25×–5× for "deep-fried" meme energy.
- **Copy GIF to clipboard** — paste straight into Discord, iMessage, Slack…
- **GifBoard** — pin your favorite GIFs to a board and click to copy instantly.

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

## 🛠️ Build from source

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
