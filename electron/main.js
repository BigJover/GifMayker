// Main process — the always-on "backstage" of the app.
// Owns: system tray, global hotkeys, window management, (later) clipboard.
// The app lives in the tray as a background process; closing a window hides it
// rather than quitting, so the global hotkeys stay alive.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, Notification,
  desktopCapturer, systemPreferences, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
// In a packaged build the binary is unpacked beside the asar (see asarUnpack),
// so rewrite the path; in dev it resolves to node_modules unchanged.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
// Caption font for ffmpeg drawtext. Like the ffmpeg binary it must live OUTSIDE
// the asar (see asarUnpack) because ffmpeg reads it as a real file off disk.
const captionFontPath = path.join(__dirname, '..', 'src', 'fonts', 'Anton-Regular.ttf')
  .replace('app.asar', 'app.asar.unpacked');
const settings = require('./settings');
const library = require('./library');
const stickers = require('./stickers');

const SMOKE = !!process.env.SMOKE_TEST; // headless boot test: wire everything then quit
let tray = null;
let controlWin = null;
let captureWin = null;
let soundboardWin = null;
let bufferWin = null;   // hidden window running the instant-replay rolling buffer
let replayActive = false; // true only once the buffer actually grabbed its source

const capturesDir = () => {
  const { saveDir } = settings.load();
  // Default to a clean, visible folder (~/Movies/GifMayker) instead of the
  // buried app-data dir — so it's easy to find and the file picker opens
  // straight to it, like Downloads does.
  const dir = saveDir || path.join(app.getPath('videos'), 'GifMayker');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Paint new windows in the user's themed background (or the real default --bg)
// so there's no color flash before the CSS loads. Mirrors theme.css --bg.
const windowBg = () => { const t = settings.load().theme; return (t && t.bg) || '#13100b'; };

// --- Windows ---
function createControlWindow() {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.show();
    controlWin.focus();
    // Tray apps only hide the window on close, so control.js doesn't re-run on
    // reopen — nudge the renderer to re-poll for updates on every reopen.
    controlWin.webContents.send('update/recheck');
    return;
  }
  controlWin = new BrowserWindow({
    width: 380,
    height: 650,
    resizable: false,
    show: false,
    title: 'GifMayker',
    backgroundColor: windowBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWin.loadFile(path.join(__dirname, '..', 'src', 'control', 'index.html'));
  controlWin.once('ready-to-show', () => { if (!SMOKE) controlWin.show(); });
  controlWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      controlWin.hide();
    }
  });
}

// --- Capture window (M2) ---
function createCaptureWindow() {
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.show();
    captureWin.focus();
    return;
  }
  captureWin = new BrowserWindow({
    width: 980,   // sized so the ~880px preview + option rows fill the window
    height: 880,
    minWidth: 620,
    minHeight: 520,
    show: false,
    title: 'Capture',
    backgroundColor: windowBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWin.loadFile(path.join(__dirname, '..', 'src', 'capture', 'index.html'));
  captureWin.once('ready-to-show', () => { if (!SMOKE) captureWin.show(); });
  // If a webcam capture paused webcam Instant Replay to free the camera, bring
  // it back once the capture window goes away (back button or OS close).
  captureWin.on('closed', () => { reacquireReplay(); });
}

// --- Camera hand-off between webcam capture and webcam Instant Replay ---
// On Windows the webcam is single-owner, so the always-on IR buffer and a
// webcam capture can't hold it at once (the app would fight itself). When a
// webcam capture starts we release the IR buffer; we re-arm it afterwards.
let replaySuspendedForCapture = false;

function suspendReplayForCapture() {
  const { replay } = settings.load();
  const usesCamera = replay.mode === 'webcam' || replay.mode === 'pip';
  if (replay.enabled && usesCamera && bufferWin && !bufferWin.isDestroyed()) {
    disarmReplay();
    replaySuspendedForCapture = true;
    return true;
  }
  return false;
}

async function reacquireReplay() {
  if (!replaySuspendedForCapture) return;
  replaySuspendedForCapture = false;
  if (settings.load().replay.enabled) await armReplay();
}

// --- Soundboard window (skeleton; wiring arrives in M6) ---
function createSoundboardWindow() {
  if (soundboardWin && !soundboardWin.isDestroyed()) {
    soundboardWin.show();
    soundboardWin.focus();
    return;
  }
  soundboardWin = new BrowserWindow({
    width: 940,   // roomy GIF grid + edit modal without lots of empty background
    height: 860,
    minWidth: 560,
    minHeight: 460,
    show: false,
    title: 'GifBoard',
    backgroundColor: windowBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  soundboardWin.loadFile(path.join(__dirname, '..', 'src', 'soundboard', 'index.html'));
  soundboardWin.once('ready-to-show', () => { if (!SMOKE) soundboardWin.show(); });
}

// --- Actions a hotkey can trigger ---
function runAction(kind) {
  // Flash the matching row in the control window (it listens on action/fired).
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('action/fired', kind);
  if (kind === 'capture') {
    createCaptureWindow();
    console.log('[hotkey] capture fired');
    return;
  }
  if (kind === 'soundboard') {
    createSoundboardWindow();
    console.log('[hotkey] soundboard fired');
    return;
  }
  if (kind === 'saveReplay') {
    saveReplay();
    console.log('[hotkey] saveReplay fired');
    return;
  }
}

// --- Instant Replay (Phase 2): hidden rolling-buffer window ---
async function armReplay() {
  if (bufferWin && !bufferWin.isDestroyed()) return;
  replayActive = false; // not recording until the buffer confirms it grabbed a source
  bufferWin = new BrowserWindow({
    width: 320, height: 200, show: false, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep capturing when hidden
    },
  });
  await bufferWin.loadFile(path.join(__dirname, '..', 'src', 'buffer', 'index.html'));
  const { replay } = settings.load();
  const needsCamera = replay.mode === 'webcam' || replay.mode === 'pip';

  // Webcam and PiP both open the camera: make sure Camera access is granted.
  if (needsCamera && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
    try { await systemPreferences.askForMediaAccess('camera'); } catch { /* handled in buffer */ }
  }

  if (replay.mode === 'webcam') {
    // Webcam buffer: grab the chosen camera by deviceId (null = default camera).
    bufferWin.webContents.send('replay/start', { mode: 'webcam', deviceId: replay.deviceId, seconds: replay.seconds });
    return;
  }

  // Screen and PiP both continuously buffer a monitor; PiP also composites the
  // webcam over it. Pick the chosen monitor (or the first).
  let srcId = null;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    let chosen = null;
    if (replay.displayId) chosen = sources.find((s) => String(s.display_id) === String(replay.displayId));
    chosen = chosen || sources[0];
    if (chosen) srcId = chosen.id;
  } catch (e) { console.error('[replay] getSources failed:', e.message); }
  bufferWin.webContents.send('replay/start', {
    mode: replay.mode, // 'screen' or 'pip'
    sourceId: srcId,
    deviceId: replay.deviceId, // used only by 'pip'
    seconds: replay.seconds,
  });
}

function disarmReplay() {
  if (bufferWin && !bufferWin.isDestroyed()) {
    bufferWin.webContents.send('replay/stop');
    bufferWin.destroy();
  }
  bufferWin = null;
  replayActive = false;
}

// Push the live replay state (does the buffer actually hold its source?) to the
// control window so its toggle/status reflects reality — e.g. a webcam that's
// enabled but not recording because it's launch-deferred or the camera is busy.
function broadcastReplayState() {
  if (controlWin && !controlWin.isDestroyed()) {
    const { replay } = settings.load();
    controlWin.webContents.send('replay/state', {
      enabled: replay.enabled, mode: replay.mode, armed: replayActive,
    });
  }
}

// Arm the buffer for an already-enabled replay (used to "Start"/"Retry" a webcam
// that was launch-deferred or whose camera was busy). Fresh buffer each time so
// the webcam restart cycle runs.
async function rearmReplay() {
  const { replay } = settings.load();
  if (!replay.enabled) return { enabled: false, mode: replay.mode, armed: false };
  disarmReplay();
  await armReplay();
  // Don't broadcast here: the buffer reports the real armed state via replay/armed
  // (success) or replay/error (failure) once it actually grabs the source, and
  // that push settles the UI. Broadcasting the still-false state now would flash.
  return { enabled: true, mode: replay.mode, armed: replayActive };
}

// Stop the buffer but KEEP the enabled preference — a "pause recording" that the
// user can resume with Start. (Turning the toggle Off would forget the setting.)
function pauseReplay() {
  disarmReplay();
  broadcastReplayState();
  const { replay } = settings.load();
  return { enabled: replay.enabled, mode: replay.mode, armed: replayActive };
}

function notifyReplay(body) {
  if (Notification.isSupported()) {
    new Notification({ title: 'Instant Replay', body, silent: true }).show();
  }
}

function saveReplay() {
  const { replay } = settings.load();
  if (!replay.enabled || !bufferWin || bufferWin.isDestroyed()) {
    notifyReplay('Instant Replay is off — turn it on first.');
    return;
  }
  // The buffer window can exist but have never grabbed its source (e.g. the
  // camera was busy). Saying so beats a hotkey that silently does nothing.
  if (!replayActive) {
    notifyReplay('Instant Replay isn’t recording — the camera may be in use by another app. Turn it off and on to retry.');
    return;
  }
  bufferWin.webContents.send('replay/save');
}

// --- Global hotkeys ---
// Re-registers both from current settings. Returns which ones registered OK
// (registration fails if the OS or another app already owns that combo).
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const { hotkeys } = settings.load();
  const status = {};
  for (const kind of ['capture', 'soundboard', 'saveReplay']) {
    const accel = hotkeys[kind];
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => runAction(kind));
    } catch {
      ok = false;
    }
    status[kind] = { accelerator: accel, registered: ok };
  }
  // GifBoard quick-keys: optional per-GIF global hotkeys that copy that GIF to
  // the clipboard. Unbound by default; only items the user explicitly bound
  // have a `hotkey`. Registered after the app hotkeys so those win any tie.
  const { items } = library.load();
  for (const it of items) {
    if (!it.hotkey) continue;
    try { globalShortcut.register(it.hotkey, () => quickCopy(it.id)); } catch { /* ignore */ }
  }
  return status;
}

// --- Tray ---
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('GifMayker');
  rebuildTrayMenu();
  tray.on('click', () => createControlWindow());
}

function rebuildTrayMenu() {
  const { hotkeys } = settings.load();
  const menu = Menu.buildFromTemplate([
    { label: 'Open GifMayker', click: () => createControlWindow() },
    { type: 'separator' },
    { label: `Capture   (${hotkeys.capture})`, click: () => runAction('capture') },
    { label: `GifBoard   (${hotkeys.soundboard})`, click: () => runAction('soundboard') },
    { label: `Save Replay   (${hotkeys.saveReplay})`, click: () => runAction('saveReplay') },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// Single-instance lock: a second launch just focuses the existing window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createControlWindow();
    if (controlWin && !controlWin.isDestroyed()) {
      if (controlWin.isMinimized()) controlWin.restore();
      controlWin.show();
      controlWin.focus();
    }
  });
}

if (gotSingleInstanceLock) app.whenReady().then(() => {
  // Mac: minimal menu (keeps Cmd+Q + copy/paste, drops reload/devtools).
  // Windows/Linux: no menu bar at all (also kills the Ctrl+R reload / F12
  // devtools accelerators that could interfere with hotkey rebinding).
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  createTray();
  createControlWindow();
  const status = registerHotkeys();
  console.log('[hotkeys] registration:', JSON.stringify(status));

  // Auto-arm on launch for SCREEN replay only (screen capture is shareable and
  // has no camera light). Webcam replay is intentionally NOT auto-armed: grabbing
  // the camera every launch turns the light on and, on Windows' single-owner
  // camera, blocks other apps. The user starts webcam replay explicitly from the
  // gear modal ("Start recording"); the toggle just remembers the preference.
  {
    const r = settings.load().replay;
    const usesCamera = r.mode === 'webcam' || r.mode === 'pip';
    if (r.enabled && !usesCamera) armReplay();
    else if (r.enabled && usesCamera) {
      // Camera-using replay (webcam or PiP) isn't auto-armed on launch (see
      // above). Not every webcam has a recording light, so pop a reminder that
      // it's on but idle until the user presses Start.
      notifyReplay('Instant Replay is on, but your camera isn’t recording yet — open GifMayker and press “Start recording”.');
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
  });

  if (SMOKE) {
    setTimeout(async () => {
      const allOk = Object.values(status).every((s) => s.registered);
      let srcCount = -1, srcErr = null;
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        srcCount = sources.length;
      } catch (e) { srcErr = e.message; }
      const perm = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
      console.log(`[smoke] hotkeys all registered: ${allOk}`);
      console.log(`[smoke] capture sources found: ${srcCount}${srcErr ? ' (err: ' + srcErr + ')' : ''}; screen permission: ${perm}`);
      console.log('[smoke] ok — quitting');
      app.isQuitting = true;
      app.quit();
    }, 1500);
  }
});

app.on('window-all-closed', () => { /* stay alive in tray */ });
// Any quit path (Cmd+Q, tray Quit, app.quit()) flips this first, so the
// window 'close' handler stops hiding and actually lets the app die.
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

// --- IPC ---
ipcMain.handle('app/version', () => app.getVersion());

// --- Update check: poll GitHub Releases for a newer version -------------------
// Runs in main (not the renderer) so it isn't blocked by the window CSP and so
// the release URL we hand to shell.openExternal is one WE built, not renderer
// input. No auto-download/signing — just a one-click "go get the new build".
const UPDATE_REPO = 'BigJover/GifMayker';
let latestReleaseUrl = null; // remembered from the last successful check

// Compare dotted versions numerically (leading "v" tolerated). >0 => a newer.
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Fetch the latest published (non-draft, non-prerelease) release from GitHub.
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${UPDATE_REPO}/releases/latest`,
      headers: { 'User-Agent': 'GifMayker', Accept: 'application/vnd.github+json' },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('status ' + res.statusCode)); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Renderer asks "is there a newer version?". Offline / rate-limited / no-release
// all resolve to {update:false} so the UI simply shows no banner.
ipcMain.handle('update/check', async () => {
  try {
    const rel = await fetchLatestRelease();
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    if (latest && cmpVersion(latest, app.getVersion()) > 0) {
      latestReleaseUrl = rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`;
      // Grow the fixed-size control window so the banner doesn't crowd the panel.
      if (controlWin && !controlWin.isDestroyed()) controlWin.setSize(380, 702);
      return { update: true, version: latest, url: latestReleaseUrl };
    }
  } catch { /* no connectivity / no release yet — just don't nag */ }
  return { update: false };
});

// Open the release page in the default browser (URL is built by us, above).
ipcMain.handle('update/open', () => {
  shell.openExternal(latestReleaseUrl || `https://github.com/${UPDATE_REPO}/releases/latest`);
  return true;
});

// Custom color theme: persist the user's picks and live-apply them to every
// open window (the renderer derives the full token family from each color).
function broadcastTheme(theme) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('theme/changed', theme);
  }
}
ipcMain.handle('theme/get', () => settings.load().theme);
ipcMain.handle('theme/set', (_e, patch) => {
  const cfg = settings.load();
  cfg.theme = { ...cfg.theme, ...(patch || {}) };
  settings.save(cfg);
  broadcastTheme(cfg.theme);
  return cfg.theme;
});

// --- Custom background image (fills every window behind the UI) --------------
// The chosen file is copied into userData so it survives the original moving.
// It's delivered to the renderers as a data: URL (not a file:// path) so it
// works under every window's CSP without granting file:// access.
const bgDir = () => path.join(app.getPath('userData'), 'background');
function bgDataUrl() {
  const p = settings.load().theme.bgImage;
  if (!p) return null;
  try {
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
    return `data:image/${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch { return null; } // file vanished → treat as no image
}
function broadcastBg() {
  const url = bgDataUrl();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('theme/bg', url);
  }
}
ipcMain.handle('theme/bg-url', () => bgDataUrl());
ipcMain.handle('theme/choose-bg', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose a background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  const src = res.filePaths[0];
  try {
    fs.mkdirSync(bgDir(), { recursive: true });
    // Only ever keep one background file — clear any previous choice first.
    for (const f of fs.readdirSync(bgDir())) fs.rmSync(path.join(bgDir(), f), { force: true });
    const dest = path.join(bgDir(), 'bg' + (path.extname(src).toLowerCase() || '.png'));
    fs.copyFileSync(src, dest);
    const cfg = settings.load();
    cfg.theme = { ...cfg.theme, bgImage: dest };
    settings.save(cfg);
    broadcastBg();
    return { ok: true, hasImage: true };
  } catch (e) {
    console.error('[theme] set background failed:', e);
    return { ok: false, error: 'copy-failed' };
  }
});
ipcMain.handle('theme/clear-bg', () => {
  const cfg = settings.load();
  if (cfg.theme.bgImage) { try { fs.rmSync(cfg.theme.bgImage, { force: true }); } catch { /* already gone */ } }
  cfg.theme = { ...cfg.theme, bgImage: null };
  settings.save(cfg);
  broadcastBg();
  return { ok: true };
});

ipcMain.handle('hotkeys/get', () => {
  const { hotkeys } = settings.load();
  return {
    hotkeys,
    status: {
      capture: globalShortcut.isRegistered(hotkeys.capture),
      soundboard: globalShortcut.isRegistered(hotkeys.soundboard),
      saveReplay: globalShortcut.isRegistered(hotkeys.saveReplay),
    },
  };
});

// Temporarily release global shortcuts while the user is rebinding, so the
// pressed combo reaches the control window instead of firing an action.
ipcMain.handle('hotkeys/suspend', () => { globalShortcut.unregisterAll(); return true; });
ipcMain.handle('hotkeys/resume', () => registerHotkeys());

ipcMain.handle('hotkeys/set', (_e, { action, accelerator }) => {
  if (!['capture', 'soundboard', 'saveReplay'].includes(action) || !accelerator) {
    return { ok: false, error: 'bad request' };
  }
  const cfg = settings.load();
  const previous = cfg.hotkeys[action];
  cfg.hotkeys[action] = accelerator;
  settings.save(cfg);

  const status = registerHotkeys();
  rebuildTrayMenu();

  // If the new combo couldn't register, roll back so the user keeps a working key.
  if (!status[action].registered) {
    cfg.hotkeys[action] = previous;
    settings.save(cfg);
    registerHotkeys();
    rebuildTrayMenu();
    return { ok: false, error: 'conflict', accelerator: previous };
  }
  return { ok: true, accelerator, status };
});

ipcMain.handle('action/trigger', (_e, kind) => { runAction(kind); return true; });

// --- Capture (M2) ---
// "← Back" from the capture window: return to the main menu and close capture.
ipcMain.handle('capture/close', () => {
  createControlWindow();
  if (captureWin && !captureWin.isDestroyed()) captureWin.close();
  return true;
});

// "← Back" from the soundboard window: return to the main menu and close it.
ipcMain.handle('soundboard/close', () => {
  createControlWindow();
  if (soundboardWin && !soundboardWin.isDestroyed()) soundboardWin.close();
  return true;
});

// --- Soundboard library (M6) ---
// Items are stored as references to GIF files (not copies), with a `missing`
// flag computed live so the UI can flag/clean up files that moved or got deleted.
function sbList() {
  const { items } = library.load();
  return items.map((it) => ({ ...it, missing: !fs.existsSync(it.path) }));
}

ipcMain.handle('sb/list', () => sbList());

ipcMain.handle('sb/import', async (_e, opts = {}) => {
  const win = BrowserWindow.fromWebContents(_e.sender);
  // Trailing separator makes macOS open *inside* the folder (showing its files)
  // instead of selecting it in the parent.
  const startDir = opts.fromCaptures ? capturesDir() + path.sep : app.getPath('downloads') + path.sep;
  const res = await dialog.showOpenDialog(win, {
    title: 'Add GIFs to your soundboard',
    defaultPath: startDir,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'GIF', extensions: ['gif'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, items: sbList() };
  const store = library.load();
  let added = 0;
  for (const p of res.filePaths) {
    if (store.items.some((it) => it.path === p)) continue; // dedupe by path
    store.items.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      path: p,
      name: path.basename(p),
      addedAt: Date.now(),
    });
    added++;
  }
  library.save(store);
  return { ok: true, added, items: sbList() };
});

// Add a GIF by path directly (used by "Pin to soundboard" from the capture flow).
ipcMain.handle('sb/add', (_e, file) => {
  if (!file || !fs.existsSync(file)) return { ok: false, items: sbList() };
  const store = library.load();
  if (!store.items.some((it) => it.path === file)) {
    store.items.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      path: file,
      name: path.basename(file),
      addedAt: Date.now(),
    });
    library.save(store);
  }
  return { ok: true, items: sbList() };
});

ipcMain.handle('sb/remove', (_e, id) => {
  const store = library.load();
  store.items = store.items.filter((it) => it.id !== id);
  library.save(store);
  registerHotkeys(); // release any quick-key the removed GIF held
  return sbList();
});

// Bind (or, with accelerator=null, clear) a per-GIF quick-key. Validates the
// combo isn't already an app hotkey or another GIF's key, then confirms the OS
// accepted it (else rolls back), mirroring the app-hotkey rebind flow.
ipcMain.handle('sb/set-hotkey', (_e, { id, accelerator }) => {
  const store = library.load();
  const it = store.items.find((x) => x.id === id);
  if (!it) return { ok: false, error: 'not found', items: sbList() };

  if (!accelerator) { // clear the binding
    delete it.hotkey;
    library.save(store);
    registerHotkeys();
    return { ok: true, items: sbList() };
  }

  const appAccels = Object.values(settings.load().hotkeys);
  const takenByOther = store.items.some((x) => x.id !== id && x.hotkey === accelerator);
  if (appAccels.includes(accelerator) || takenByOther) {
    return { ok: false, error: 'conflict', items: sbList() };
  }

  const previous = it.hotkey;
  it.hotkey = accelerator;
  library.save(store);
  registerHotkeys();
  // If the OS/another app already owns the combo it won't register — roll back.
  if (!globalShortcut.isRegistered(accelerator)) {
    if (previous) it.hotkey = previous; else delete it.hotkey;
    library.save(store);
    registerHotkeys();
    return { ok: false, error: 'conflict', items: sbList() };
  }
  return { ok: true, items: sbList() };
});

// --- Sticker recents: user-uploaded images, copied in so they persist + reuse ---
ipcMain.handle('stickers/list', () => stickers.load().items);

ipcMain.handle('stickers/import', async (_e) => {
  const win = BrowserWindow.fromWebContents(_e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose sticker image(s)',
    defaultPath: app.getPath('downloads') + path.sep,
    properties: ['openFile', 'multiSelections'],
    // Static images only; PNG keeps transparency for clean overlays.
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, items: stickers.load().items };
  const store = stickers.load();
  let last = null;
  for (const src of res.filePaths) {
    const existing = store.items.find((it) => it.src === src);
    if (existing) {
      // Re-uploading a known file just bumps it to the front of recents.
      store.items = store.items.filter((it) => it !== existing);
      store.items.unshift(existing);
      last = existing;
      continue;
    }
    try {
      const ext = path.extname(src).toLowerCase() || '.png';
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const dest = path.join(stickers.dir(), `${id}${ext}`);
      fs.copyFileSync(src, dest);
      const item = { id, path: dest, name: path.basename(src), src, addedAt: Date.now() };
      store.items.unshift(item);
      last = item;
    } catch (e) { console.error('sticker import failed:', e); }
  }
  // Cap recents; delete the copied files of anything that falls off the list.
  if (store.items.length > stickers.MAX_RECENTS) {
    for (const drop of store.items.slice(stickers.MAX_RECENTS)) {
      try { fs.rmSync(drop.path, { force: true }); } catch { /* ignore */ }
    }
    store.items = store.items.slice(0, stickers.MAX_RECENTS);
  }
  stickers.save(store);
  return { ok: true, item: last, items: store.items };
});

ipcMain.handle('stickers/remove', (_e, id) => {
  const store = stickers.load();
  const it = store.items.find((x) => x.id === id);
  if (it) { try { fs.rmSync(it.path, { force: true }); } catch { /* ignore */ } }
  store.items = store.items.filter((x) => x.id !== id);
  stickers.save(store);
  return store.items;
});

// Delete a GIF from the captures folder (to Trash) and unpin it if on the board.
ipcMain.handle('captures/delete-gif', async (_e, file) => {
  try {
    if (!(file && file.toLowerCase().endsWith('.gif') && path.dirname(file) === capturesDir() && fs.existsSync(file))) {
      return { ok: false, error: 'not a captures GIF', items: sbList() };
    }
    const win = BrowserWindow.fromWebContents(_e.sender);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 1,
      cancelId: 0,
      message: 'Delete this GIF?',
      detail: `${path.basename(file)} will be moved to the Trash.`,
    });
    if (response !== 1) return { ok: false, canceled: true, items: sbList() };
    await shell.trashItem(file);
  } catch (e) {
    return { ok: false, error: e.message, items: sbList() };
  }
  const store = library.load();
  const before = store.items.length;
  store.items = store.items.filter((it) => it.path !== file);
  if (store.items.length !== before) { library.save(store); registerHotkeys(); } // release a freed quick-key
  return { ok: true, items: sbList() };
});

// Auto-cleanup of the raw .webm once a capture session is finished.
ipcMain.handle('capture/delete-source', (_e, file) => {
  try {
    if (file && file.toLowerCase().endsWith('.webm') && path.dirname(file) === capturesDir() && fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      return { ok: true };
    }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: false };
});

// In-app "From Captures": list the GIFs in the captures folder (newest first).
ipcMain.handle('captures/list-gifs', () => {
  const dir = capturesDir();
  let gifs = [];
  try {
    gifs = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.gif'))
      .map((f) => { const p = path.join(dir, f); return { path: p, name: f, mtime: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { /* folder may not exist yet */ }
  return { dir, gifs };
});

// --- Instant Replay IPC (Phase 2) ---
// Surface buffer-capture failures (e.g., on Windows) so they're not silent.
ipcMain.handle('replay/error', (_e, msg) => {
  console.error('[replay] buffer error:', msg);
  replayActive = false;
  broadcastReplayState();
  notifyReplay(`Couldn't start recording — ${msg}`);
  return true;
});

// The buffer reports whether it actually grabbed its source, so Save Replay can
// tell "recording" from "armed but the camera/screen never opened".
ipcMain.handle('replay/armed', (_e, ok) => {
  replayActive = !!ok;
  broadcastReplayState();
  return true;
});

// Live state (enabled + whether the buffer is truly recording) for the control
// window's status/toggle. Distinct from replay/get, which is just the settings.
ipcMain.handle('replay/state', () => {
  const { replay } = settings.load();
  return { enabled: replay.enabled, mode: replay.mode, armed: replayActive };
});

// Start/Retry recording for an already-enabled replay (launch-deferred webcam,
// or a camera that was busy on the first try).
ipcMain.handle('replay/rearm', () => rearmReplay());
// Pause recording but keep Instant Replay enabled (resume later with Start).
ipcMain.handle('replay/pause', () => pauseReplay());
// A non-fatal heads-up from the buffer (e.g. PiP fell back to screen-only because
// the webcam was busy) — just notify, don't touch the armed state.
ipcMain.handle('replay/notice', (_e, msg) => { notifyReplay(String(msg || '')); return true; });
// One-click "enter Instant Replay" from the home panel: enable it if it's off
// (using whatever source/camera is configured in the gear), then start recording.
ipcMain.handle('replay/start-recording', async () => {
  const cfg = settings.load();
  if (!cfg.replay.enabled) { cfg.replay.enabled = true; settings.save(cfg); }
  disarmReplay();
  await armReplay();
  // Armed state settles via the buffer's replay/state push; don't broadcast the
  // intermediate not-yet-armed value here (avoids a flash).
  return { enabled: true, mode: cfg.replay.mode, armed: replayActive };
});

// A webcam capture is about to open the camera — free it from the IR buffer.
// Returns true if we actually released it (so the renderer can wait a beat for
// the device to come free before calling getUserMedia).
ipcMain.handle('replay/suspend-for-capture', () => suspendReplayForCapture());

ipcMain.handle('replay/get', () => settings.load().replay);

// List available monitors for the replay settings dropdown.
ipcMain.handle('replay/list-screens', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map((s, i) => ({ displayId: s.display_id, name: s.name || `Display ${i + 1}` }));
  } catch { return []; }
});

ipcMain.handle('replay/set-screen', async (_e, displayId) => {
  const cfg = settings.load();
  cfg.replay.displayId = displayId || null;
  settings.save(cfg);
  if (cfg.replay.enabled) { disarmReplay(); await armReplay(); } // re-arm on the new monitor
  return cfg.replay;
});

ipcMain.handle('replay/set-mode', async (_e, mode) => {
  const cfg = settings.load();
  cfg.replay.mode = mode === 'webcam' ? 'webcam' : mode === 'pip' ? 'pip' : 'screen';
  settings.save(cfg);
  if (cfg.replay.enabled) { disarmReplay(); await armReplay(); } // re-arm on the new source
  return cfg.replay;
});

ipcMain.handle('replay/set-camera', async (_e, deviceId) => {
  const cfg = settings.load();
  cfg.replay.deviceId = deviceId || null;
  settings.save(cfg);
  const usesCamera = cfg.replay.mode === 'webcam' || cfg.replay.mode === 'pip';
  if (cfg.replay.enabled && usesCamera) { disarmReplay(); await armReplay(); }
  return cfg.replay;
});

ipcMain.handle('replay/set-enabled', async (_e, on) => {
  const cfg = settings.load();
  cfg.replay.enabled = !!on;
  settings.save(cfg);
  // Disarm first so enabling always builds a FRESH buffer — that's what triggers
  // the camera restart cycle (open→close→reopen) in webcam mode, and clears any
  // stale/dead buffer window left from a failed launch auto-arm.
  if (cfg.replay.enabled) { disarmReplay(); await armReplay(); } else disarmReplay();
  broadcastReplayState();
  return cfg.replay;
});

ipcMain.handle('replay/set-seconds', async (_e, secs) => {
  const cfg = settings.load();
  cfg.replay.seconds = Math.max(5, Math.min(60, Number(secs) || 30)); // 1-min cap
  settings.save(cfg);
  if (cfg.replay.enabled) { disarmReplay(); await armReplay(); } // re-arm with new length
  return cfg.replay;
});

// The buffer window submits its kept segments; concat them into one clip and
// open it in the Capture editor (trim/crop/GIF flow).
// Concat one track's WebM segments into a single file (stream copy, no re-encode).
function concatSegments(buffers, outPath) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-replay-'));
    const files = buffers.map((buf, i) => {
      const p = path.join(tmp, `seg${String(i).padStart(3, '0')}.webm`);
      fs.writeFileSync(p, Buffer.from(buf));
      return p;
    });
    const listPath = path.join(tmp, 'list.txt');
    fs.writeFileSync(listPath, files.map((f) => `file '${f}'`).join('\n'));
    const proc = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } reject(e); });
    proc.on('close', (code) => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error(`concat failed (${code}): ${err.slice(-300)}`));
    });
  });
}

// payload = { screen?: [ArrayBuffer…], webcam?: [ArrayBuffer…] }. Screen-only and
// webcam-only replays produce one file and open normally; a PiP replay produces
// TWO files (screen base + webcam) and opens with the webcam as a video sticker.
ipcMain.handle('replay/submit', async (_e, payload) => {
  const p = payload || {};
  const hasScreen = Array.isArray(p.screen) && p.screen.length;
  const hasWebcam = Array.isArray(p.webcam) && p.webcam.length;
  if (!hasScreen && !hasWebcam) return { ok: false, error: 'empty buffer' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    if (hasScreen && hasWebcam) {
      const screen = await concatSegments(p.screen, path.join(capturesDir(), `replay-${stamp}.webm`));
      const webcam = await concatSegments(p.webcam, path.join(capturesDir(), `replay-${stamp}-cam.webm`));
      openPipInEditor(screen, webcam);
      return { ok: true, path: screen, webcam };
    }
    // Single track (screen-only or webcam-only fallback).
    const only = hasScreen ? p.screen : p.webcam;
    const out = await concatSegments(only, path.join(capturesDir(), `replay-${stamp}.webm`));
    openClipInEditor(out);
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Open an existing clip in the Capture window's editor.
function openClipInEditor(file) {
  createCaptureWindow();
  const send = () => { if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('capture/load-clip', file); };
  if (captureWin.webContents.isLoading()) captureWin.webContents.once('did-finish-load', send);
  else send();
}

// Open a PiP replay: the screen as the base clip + the webcam as a movable video
// sticker overlay. The editor loads `screen` for trim/crop and adds `webcam` as a
// draggable/resizable/layerable video overlay, composited at GIF-export time.
function openPipInEditor(screen, webcam) {
  createCaptureWindow();
  const send = () => { if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('capture/load-pip', { screen, webcam }); };
  if (captureWin.webContents.isLoading()) captureWin.webContents.once('did-finish-load', send);
  else send();
}

// macOS gates screen capture behind a Screen Recording permission. Other OSes: granted.
ipcMain.handle('capture/permission', () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen'); // granted | denied | restricted | not-determined
});

ipcMain.handle('capture/open-screen-prefs', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
  return true;
});

// Prompt for camera access (macOS shows the OS dialog the first time). Resolves
// to true if granted. No-op elsewhere. Call before getUserMedia for the webcam.
ipcMain.handle('camera/ask', async () => {
  if (process.platform !== 'darwin') return true;
  if (systemPreferences.getMediaAccessStatus('camera') === 'granted') return true;
  try { return await systemPreferences.askForMediaAccess('camera'); }
  catch { return false; }
});

ipcMain.handle('camera/open-prefs', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera');
  }
  return true;
});

// List capturable sources (screens + windows) with preview thumbnails.
ipcMain.handle('capture/sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    isScreen: s.id.startsWith('screen'),
    thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
  }));
});

// Persist a finished recording (raw WebM bytes) to the captures dir.
ipcMain.handle('capture/save', (_e, arrayBuffer) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(capturesDir(), `capture-${stamp}.webm`);
  fs.writeFileSync(file, Buffer.from(arrayBuffer));
  const bytes = fs.statSync(file).size;
  return { path: file, bytes };
});

ipcMain.handle('capture/reveal', (_e, file) => { shell.showItemInFolder(file); return true; });
ipcMain.handle('capture/open', (_e, file) => { shell.openPath(file); return true; });

// --- Save location ---
ipcMain.handle('savedir/get', () => capturesDir());
ipcMain.handle('savedir/open', () => { shell.openPath(capturesDir()); return true; });
ipcMain.handle('savedir/choose', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose where to save videos & GIFs',
    defaultPath: capturesDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, dir: capturesDir() };
  const cfg = settings.load();
  cfg.saveDir = res.filePaths[0];
  settings.save(cfg);
  return { ok: true, dir: capturesDir() };
});

// --- GIF conversion (M3) ---
// Two-stage palette encode in a single ffmpeg pass: palettegen builds an
// optimal 256-color table from the clip, paletteuse maps frames to it with
// dithering. This is what makes the GIF look clean instead of banded.
// The geometric/timing per-frame chain (no overlays, no palette, no trailing
// comma): crop (source pixels) → speed (retime) → fps drop → scale. Overlays
// (text + stickers) are applied AFTER this so they render at output resolution.
function frameChain(fps, width, crop, speed) {
  const parts = [];
  if (crop) parts.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  // setpts=PTS/speed: >1 speeds up, <1 slows down (e.g. 0.25 = 4× longer).
  if (speed && speed !== 1) parts.push(`setpts=PTS/${speed}`);
  parts.push(`fps=${fps}`);
  if (width) parts.push(`scale=${width}:-1:flags=lanczos`);
  return parts.join(',');
}

// Black letterbox bars drawn ON the scaled frame (top/bottom), so text/stickers
// placed on them read clearly. Heights are fractions of the frame height, applied
// via ffmpeg's `ih` so we don't need pixel math here. Returns 0–2 drawbox filters,
// applied BEFORE overlays (bars are a background) and AFTER scale.
function barFilters(bars) {
  const out = [];
  const top = Number(bars && bars.top) || 0;
  const bot = Number(bars && bars.bottom) || 0;
  const left = Number(bars && bars.left) || 0;
  const right = Number(bars && bars.right) || 0;
  if (top > 0) out.push(`drawbox=x=0:y=0:w=iw:h=ih*${top.toFixed(4)}:color=black:t=fill`);
  if (bot > 0) out.push(`drawbox=x=0:y=ih*${(1 - bot).toFixed(4)}:w=iw:h=ih*${bot.toFixed(4)}:color=black:t=fill`);
  if (left > 0) out.push(`drawbox=x=0:y=0:w=iw*${left.toFixed(4)}:h=ih:color=black:t=fill`);
  if (right > 0) out.push(`drawbox=x=iw*${(1 - right).toFixed(4)}:y=0:w=iw*${right.toFixed(4)}:h=ih:color=black:t=fill`);
  return out;
}

// Join filter pieces with commas, skipping empty ones (avoids stray `,,`).
function joinF(...pieces) { return pieces.filter((p) => p && p.length).join(','); }

// The 256-color palette split that makes a clean (un-banded) GIF. `inLabel` is
// the filter_complex pad feeding it (e.g. 'L2'); pass '' for an inline -vf chain.
function paletteSplit(inLabel) {
  const head = inLabel ? `[${inLabel}]split[s0][s1]` : `split[s0][s1]`;
  return `${head};[s0]palettegen=stats_mode=diff[p]` +
    `;[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
}

// Apply overlay nodes (text + stickers) IN ORDER onto the running frame, so they
// stack exactly as arranged in the editor. Text → drawtext (single input);
// sticker → an extra ffmpeg input (inputOffset, inputOffset+1, …) scaled to
// w×h and centered on (fx,fy). CROSS-PLATFORM RULE (same as captions): sticker
// files are referenced via bare `-i name.png` with ffmpeg's cwd = the temp dir,
// never an absolute path — a Windows drive colon would break the filtergraph.
function buildLayerGraph(startLabel, nodes, inputOffset) {
  const segs = [];
  let cur = startLabel;
  let inIdx = inputOffset;
  nodes.forEach((n, i) => {
    if (n.kind === 'text') {
      segs.push(`[${cur}]${n.drawtext}[L${i}]`);
    } else {
      const fx = (Number(n.fx) || 0).toFixed(4);
      const fy = (Number(n.fy) || 0).toFixed(4);
      segs.push(`[${inIdx}:v]scale=${n.w}:${n.h}[sk${i}]`);
      segs.push(`[${cur}][sk${i}]overlay=x=(main_w*${fx})-(overlay_w/2):y=(main_h*${fy})-(overlay_h/2)[L${i}]`);
      inIdx++;
    }
    cur = `L${i}`;
  });
  return { segs, last: cur };
}

// "#rrggbb" → ffmpeg "0xrrggbb"; anything unparseable falls back to white.
function ffColor(c) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(c || '').trim());
  return m ? '0x' + m[1].toLowerCase() : 'white';
}

// Build one drawtext filter for a caption. Position is the caption's CENTER as a
// fraction of the output frame. Text comes from a textfile (no inline-text
// escaping). CROSS-PLATFORM RULE: fontfile/textfile are referenced by BARE
// FILENAME — ffmpeg is run with cwd = the temp dir holding font.ttf + the c*.txt
// files. A Windows absolute path (D:\…) puts a drive colon inside the filtergraph
// that drawtext mis-splits into a stray positional `text` option ("Both text and
// text file provided"); bare names have no colon, so it works on Windows + macOS.
// No outline — text is exactly the chosen color (incl. black).
function buildDrawtext(cap) {
  const size = Math.max(8, Math.round(Number(cap.size) || 24));
  const fx = (Number(cap.fx) || 0).toFixed(4);
  const fy = (Number(cap.fy) || 0).toFixed(4);
  return `drawtext=fontfile=font.ttf:textfile=${cap.textfile}` +
    `:fontsize=${size}:fontcolor=${ffColor(cap.color)}` +
    `:x=(w*${fx})-(text_w/2):y=(h*${fy})-(text_h/2)`;
}

// Prepare the temp dir + ordered overlay nodes for a layer list (text + stickers
// in paint order). Returns { capDir, nodes, stickerArgs, hasStickers } or null
// when there are no overlays. capDir holds font.ttf, c*.txt and the copied sticker
// images; ffmpeg MUST run with cwd=capDir so every filter/-i ref is a bare
// filename — a Windows absolute path's drive colon breaks the filtergraph.
function prepOverlays(layers, opts = {}) {
  const webcamSrc = opts.webcamSrc && fs.existsSync(opts.webcamSrc) ? opts.webcamSrc : null;
  const trimStart = Number(opts.trimStart) || 0;
  const ls = Array.isArray(layers) ? layers.filter((l) => l && (
    l.kind === 'text' ? String(l.text || '').length
      : l.kind === 'sticker' ? (l.path && fs.existsSync(l.path))
        : l.kind === 'webcam' ? !!webcamSrc
          : false)) : [];
  if (!ls.length) return null;
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-ov-'));
  const nodes = [];
  const inputArgs = []; // ffmpeg -i flags for image stickers + the webcam video, in node order
  let txtN = 0, skN = 0, needFont = false;
  for (const l of ls) {
    if (l.kind === 'text') {
      const name = `c${txtN++}.txt`;
      fs.writeFileSync(path.join(capDir, name), String(l.text), 'utf8');
      nodes.push({ kind: 'text', drawtext: buildDrawtext({ textfile: name, fx: l.fx, fy: l.fy, size: l.size, color: l.color }) });
      needFont = true;
    } else if (l.kind === 'webcam') {
      // The webcam is a VIDEO overlay input. A per-input -ss aligns it with the
      // trimmed base (both recorded over the same window). Absolute path is safe
      // here — it's an -i argv token, not inside the filtergraph.
      if (trimStart > 0) inputArgs.push('-ss', String(trimStart));
      inputArgs.push('-i', webcamSrc);
      nodes.push({ kind: 'overlay', w: Math.max(1, Math.round(Number(l.w) || 1)), h: Math.max(1, Math.round(Number(l.h) || 1)), fx: l.fx, fy: l.fy });
    } else {
      const ext = (path.extname(l.path) || '.png').toLowerCase();
      const name = `s${skN++}${ext}`;
      fs.copyFileSync(l.path, path.join(capDir, name));
      inputArgs.push('-i', name);
      nodes.push({ kind: 'overlay', w: Math.max(1, Math.round(Number(l.w) || 1)), h: Math.max(1, Math.round(Number(l.h) || 1)), fx: l.fx, fy: l.fy });
    }
  }
  if (needFont) fs.copyFileSync(captionFontPath, path.join(capDir, 'font.ttf'));
  return { capDir, nodes, inputArgs, hasInputs: inputArgs.length > 0 };
}

ipcMain.handle('capture/to-gif', (_e, { src, fps = 15, width = 480, trim = null, crop = null, speed = 1, outSeconds = 0, layers = [], bars = null, webcamSrc = null }) => {
  return new Promise((resolve) => {
    if (!src || !fs.existsSync(src)) { resolve({ ok: false, error: 'source file not found' }); return; }
    const out = src.replace(/\.webm$/i, '') + '.gif';
    const w = Number(width);

    // Overlays (text + image stickers + the webcam video) live in a temp dir;
    // ffmpeg runs with cwd there. The webcam is seeked to match the trimmed base.
    let ov = null;
    try { ov = prepOverlays(layers, { webcamSrc, trimStart: trim ? trim.start : 0 }); } catch { ov = null; } // best-effort; never block the GIF
    const capDir = ov ? ov.capDir : null;
    const cleanupTmp = () => { if (capDir) { try { fs.rmSync(capDir, { recursive: true, force: true }); } catch { /* ignore */ } } };

    // Trim with INPUT seeking: -ss before -i fast-seeks to the nearest keyframe
    // (no decode-and-discard from frame 0), then decodes to the exact frame, and
    // resets output PTS to 0 so the fps/palette chain runs clean. Output seeking
    // (-ss after -i) decoded the whole head of the clip first — so trimming to the
    // back half was slow and produced bad/timestamp-skewed GIFs.
    const preInput = [];   // before -i (the seek)
    const postInput = [];  // after -i (the duration cap, measured from the cut)
    if (trim && trim.duration > 0) {
      preInput.push('-ss', String(trim.start || 0));
      postInput.push('-t', String(trim.duration));
    }

    // Stickers need extra -i inputs + a filter_complex (overlay is a 2-input
    // filter), and text must interleave with them by layer order. Their -i flags
    // go right after the source so postInput's -t stays an OUTPUT option. With no
    // stickers, keep the faster single-input -vf path (text via drawtext chain).
    const geo = frameChain(Number(fps), w, crop, Number(speed));
    const baseChain = joinF(geo, barFilters(bars).join(',')); // geo + black bars (background)
    let filterArgs;
    let inputArgs = [];
    if (ov && ov.hasInputs) {
      inputArgs = ov.inputArgs;
      const { segs, last } = buildLayerGraph('base', ov.nodes, 1); // input 0 = src, 1.. = stickers/webcam
      filterArgs = ['-filter_complex', `[0:v]${baseChain}[base];${segs.join(';')};${paletteSplit(last)}`];
    } else {
      const drawtexts = ov ? ov.nodes.filter((n) => n.kind === 'text').map((n) => n.drawtext) : [];
      filterArgs = ['-vf', joinF(baseChain, drawtexts.join(','), paletteSplit(''))];
    }
    const args = ['-y', ...preInput, '-i', src, ...inputArgs, ...postInput, ...filterArgs, '-loop', '0', out];

    let proc;
    try {
      proc = spawn(ffmpegPath, args, capDir ? { cwd: capDir } : undefined);
    } catch (e) {
      cleanupTmp();
      resolve({ ok: false, error: e.message });
      return;
    }
    let err = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      // Parse ffmpeg "time=HH:MM:SS.ss" → progress % for live feedback.
      if (outSeconds > 0 && !_e.sender.isDestroyed()) {
        const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          _e.sender.send('gif/progress', Math.max(1, Math.min(99, Math.round((t / outSeconds) * 100))));
        }
      }
    });
    proc.on('error', (e) => { cleanupTmp(); resolve({ ok: false, error: e.message }); });
    proc.on('close', (code) => {
      cleanupTmp();
      if (code === 0 && fs.existsSync(out)) {
        resolve({ ok: true, path: out, bytes: fs.statSync(out).size });
      } else {
        resolve({ ok: false, error: `ffmpeg exited ${code}: ${err.slice(-400)}` });
      }
    });
  });
});

// Bake text + stickers into an EXISTING gif → a NEW gif added to the GifBoard.
// Reuses the same overlay machinery as capture/to-gif, but with no crop/scale/fps
// so the original dimensions + frame timing are preserved.
ipcMain.handle('gif/add-text', (_e, { src, layers = [], bars = null }) => {
  return new Promise((resolve) => {
    if (!src || !fs.existsSync(src)) { resolve({ ok: false, error: 'source gif not found' }); return; }

    let ov;
    try { ov = prepOverlays(layers); } catch (e) { resolve({ ok: false, error: 'overlay setup failed: ' + e.message }); return; }
    const bf = barFilters(bars);
    if (!ov && !bf.length) { resolve({ ok: false, error: 'nothing to add' }); return; }
    const capDir = ov ? ov.capDir : null;
    const nodes = ov ? ov.nodes : [];
    const inputArgs = ov ? ov.inputArgs : [];
    const hasStickers = ov ? ov.hasInputs : false;
    const cleanupTmp = () => { if (capDir) { try { fs.rmSync(capDir, { recursive: true, force: true }); } catch { /* ignore */ } } };

    const out = path.join(path.dirname(src), `${path.basename(src).replace(/\.gif$/i, '')}-edit-${Date.now()}.gif`);

    // No crop/scale/fps here — bars (background) then overlays chain off the source.
    let filterArgs;
    if (hasStickers) {
      const baseSeg = bf.length ? `[0:v]${bf.join(',')}[base];` : '';
      const { segs, last } = buildLayerGraph(bf.length ? 'base' : '0:v', nodes, 1);
      filterArgs = ['-filter_complex', `${baseSeg}${segs.join(';')};${paletteSplit(last)}`];
    } else {
      const drawtexts = nodes.filter((n) => n.kind === 'text').map((n) => n.drawtext);
      filterArgs = ['-vf', joinF(bf.join(','), drawtexts.join(','), paletteSplit(''))];
    }
    let proc;
    try {
      proc = spawn(ffmpegPath, ['-y', '-i', src, ...inputArgs, ...filterArgs, '-loop', '0', out], capDir ? { cwd: capDir } : undefined);
    } catch (e) { cleanupTmp(); resolve({ ok: false, error: e.message }); return; }
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { cleanupTmp(); resolve({ ok: false, error: e.message }); });
    proc.on('close', (code) => {
      cleanupTmp();
      if (code === 0 && fs.existsSync(out)) {
        const store = library.load();
        store.items.unshift({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          path: out, name: path.basename(out), addedAt: Date.now(),
        });
        library.save(store);
        resolve({ ok: true, path: out, items: sbList() });
      } else {
        resolve({ ok: false, error: `ffmpeg exited ${code}: ${err.slice(-400)}` });
      }
    });
  });
});

// --- Copy GIF to clipboard (M5) ---
// Animated GIFs are the tricky case: clipboard.writeImage() flattens to a still
// PNG. On macOS we instead put the file itself on the pasteboard (public.file-url)
// so pasting into Discord/Slack/iMessage attaches the *animated* file. Other
// platforms fall back to a static image (best effort until per-OS handling lands).
// Copy a GIF file to the clipboard so pasting attaches the ANIMATED gif.
// Shared by the soundboard click, the capture flow, and GifBoard quick-keys.
async function copyGifFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'file not found' };
    if (process.platform === 'darwin') {
      // Put the file on the pasteboard so paste attaches the ANIMATED gif.
      clipboard.writeBuffer('public.file-url', Buffer.from(require('url').pathToFileURL(file).href, 'utf8'));
      return { ok: true, mode: 'file' };
    }
    if (process.platform === 'win32') {
      // Set-Clipboard puts the file on the clipboard (CF_HDROP) so pasting into
      // Discord/Slack/etc. attaches the animated GIF, like the macOS path.
      await new Promise((resolve, reject) => {
        const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Set-Clipboard -LiteralPath "${file.replace(/"/g, '')}"`]);
        let err = '';
        ps.stderr.on('data', (d) => { err += d.toString(); });
        ps.on('error', reject);
        ps.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || ('exit ' + code))));
      });
      return { ok: true, mode: 'file' };
    }
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return { ok: false, error: 'could not read image' };
    clipboard.writeImage(img);
    return { ok: true, mode: 'image' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('capture/copy-gif', (_e, file) => copyGifFile(file));

// Copy a specific board GIF by id — fired by a GifBoard quick-key (a per-GIF
// global hotkey). Flashes the matching tile if the board window is open.
async function quickCopy(id) {
  const { items } = library.load();
  const it = items.find((x) => x.id === id);
  if (!it) return;
  const r = await copyGifFile(it.path);
  console.log(`[quickkey] copy ${id}: ${r && r.ok ? 'ok' : 'failed'}`);
  if (soundboardWin && !soundboardWin.isDestroyed()) {
    soundboardWin.webContents.send('sb/copied', { id, ok: !!(r && r.ok) });
  }
}
