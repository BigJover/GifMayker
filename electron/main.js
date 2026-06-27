// Main process — the always-on "backstage" of the app.
// Owns: system tray, global hotkeys, window management, (later) clipboard.
// The app lives in the tray as a background process; closing a window hides it
// rather than quitting, so the global hotkeys stay alive.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, Notification,
  desktopCapturer, systemPreferences, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

const SMOKE = !!process.env.SMOKE_TEST; // headless boot test: wire everything then quit
let tray = null;
let controlWin = null;
let captureWin = null;
let soundboardWin = null;
let bufferWin = null;   // hidden window running the instant-replay rolling buffer

const capturesDir = () => {
  const { saveDir } = settings.load();
  // Default to a clean, visible folder (~/Movies/GifMayker) instead of the
  // buried app-data dir — so it's easy to find and the file picker opens
  // straight to it, like Downloads does.
  const dir = saveDir || path.join(app.getPath('videos'), 'GifMayker');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// --- Windows ---
function createControlWindow() {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.show();
    controlWin.focus();
    return;
  }
  controlWin = new BrowserWindow({
    width: 380,
    height: 568,
    resizable: false,
    show: false,
    title: 'GifMayker',
    backgroundColor: '#0f1117',
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
    width: 760,
    height: 620,
    minWidth: 620,
    minHeight: 520,
    show: false,
    title: 'Capture',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWin.loadFile(path.join(__dirname, '..', 'src', 'capture', 'index.html'));
  captureWin.once('ready-to-show', () => { if (!SMOKE) captureWin.show(); });
}

// --- Soundboard window (skeleton; wiring arrives in M6) ---
function createSoundboardWindow() {
  if (soundboardWin && !soundboardWin.isDestroyed()) {
    soundboardWin.show();
    soundboardWin.focus();
    return;
  }
  soundboardWin = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 560,
    minHeight: 460,
    show: false,
    title: 'GifBoard',
    backgroundColor: '#0f1117',
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

  if (replay.mode === 'webcam') {
    // Webcam buffer: make sure Camera access is granted, then let the buffer
    // window grab the chosen camera by deviceId (null = default camera).
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      try { await systemPreferences.askForMediaAccess('camera'); } catch { /* handled in buffer */ }
    }
    bufferWin.webContents.send('replay/start', { mode: 'webcam', deviceId: replay.deviceId, seconds: replay.seconds });
    return;
  }

  // Screen buffer: pick the chosen monitor (or the first) to continuously buffer.
  let srcId = null;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    let chosen = null;
    if (replay.displayId) chosen = sources.find((s) => String(s.display_id) === String(replay.displayId));
    chosen = chosen || sources[0];
    if (chosen) srcId = chosen.id;
  } catch (e) { console.error('[replay] getSources failed:', e.message); }
  bufferWin.webContents.send('replay/start', { mode: 'screen', sourceId: srcId, seconds: replay.seconds });
}

function disarmReplay() {
  if (bufferWin && !bufferWin.isDestroyed()) {
    bufferWin.webContents.send('replay/stop');
    bufferWin.destroy();
  }
  bufferWin = null;
}

function saveReplay() {
  const { replay } = settings.load();
  if (!replay.enabled || !bufferWin || bufferWin.isDestroyed()) {
    if (Notification.isSupported()) {
      new Notification({ title: 'GifMayker', body: 'Instant Replay is off — turn it on first.', silent: true }).show();
    }
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

  if (settings.load().replay.enabled) armReplay();

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
  return sbList();
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
  if (store.items.length !== before) library.save(store);
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
  if (Notification.isSupported()) {
    new Notification({ title: 'Instant Replay', body: `Couldn't start recording: ${msg}`, silent: true }).show();
  }
  return true;
});

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
  cfg.replay.mode = mode === 'webcam' ? 'webcam' : 'screen';
  settings.save(cfg);
  if (cfg.replay.enabled) { disarmReplay(); await armReplay(); } // re-arm on the new source
  return cfg.replay;
});

ipcMain.handle('replay/set-camera', async (_e, deviceId) => {
  const cfg = settings.load();
  cfg.replay.deviceId = deviceId || null;
  settings.save(cfg);
  if (cfg.replay.enabled && cfg.replay.mode === 'webcam') { disarmReplay(); await armReplay(); }
  return cfg.replay;
});

ipcMain.handle('replay/set-enabled', async (_e, on) => {
  const cfg = settings.load();
  cfg.replay.enabled = !!on;
  settings.save(cfg);
  if (cfg.replay.enabled) await armReplay(); else disarmReplay();
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
ipcMain.handle('replay/submit', (_e, buffers) => {
  return new Promise((resolve) => {
    if (!buffers || !buffers.length) { resolve({ ok: false, error: 'empty buffer' }); return; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-replay-'));
    const files = buffers.map((buf, i) => {
      const p = path.join(tmp, `seg${String(i).padStart(3, '0')}.webm`);
      fs.writeFileSync(p, Buffer.from(buf));
      return p;
    });
    const listPath = path.join(tmp, 'list.txt');
    fs.writeFileSync(listPath, files.map((f) => `file '${f}'`).join('\n'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(capturesDir(), `replay-${stamp}.webm`);
    const proc = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      if (code === 0 && fs.existsSync(out)) {
        openClipInEditor(out);
        resolve({ ok: true, path: out });
      } else {
        resolve({ ok: false, error: `concat failed (${code}): ${err.slice(-300)}` });
      }
    });
  });
});

// Open an existing clip in the Capture window's editor.
function openClipInEditor(file) {
  createCaptureWindow();
  const send = () => { if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('capture/load-clip', file); };
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

// Webcam uses a SEPARATE macOS permission (Camera, not Screen Recording).
ipcMain.handle('camera/permission', () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('camera'); // granted | denied | restricted | not-determined
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
function gifFilter(fps, width, crop, speed, drawtexts) {
  // crop (source pixels) → speed (retime) → fps drop → scale → TEXT → palette.
  // Text overlays go AFTER scale so they render at output resolution (crisp) and
  // BEFORE the palette split so palettegen accounts for the text colors.
  const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  // setpts=PTS/speed: >1 speeds up, <1 slows down (e.g. 0.25 = 4× longer).
  const speedF = (speed && speed !== 1) ? `setpts=PTS/${speed},` : '';
  const scale = width ? `scale=${width}:-1:flags=lanczos,` : '';
  const textF = drawtexts && drawtexts.length ? drawtexts.join(',') + ',' : '';
  return `${cropF}${speedF}fps=${fps},${scale}${textF}split[s0][s1]` +
    `;[s0]palettegen=stats_mode=diff[p]` +
    `;[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
}

// Escape a file path for use inside a single-quoted ffmpeg filtergraph value.
// Forward slashes work on every OS, and inside single quotes a Windows drive
// colon (C:) is literal — so we only need to neutralise backslashes + quotes.
function ffPath(p) { return String(p).replace(/\\/g, '/').replace(/'/g, "\\'"); }

// "#rrggbb" → ffmpeg "0xrrggbb"; anything unparseable falls back to white.
function ffColor(c) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(c || '').trim());
  return m ? '0x' + m[1].toLowerCase() : 'white';
}

// Build one drawtext filter for a caption. Position is the caption's CENTER as a
// fraction of the output frame, so it tracks what the user placed in the editor.
// Text comes from a textfile (no fragile inline-text escaping). White-with-black-
// outline default keeps captions readable over any footage.
function buildDrawtext(cap) {
  const size = Math.max(8, Math.round(Number(cap.size) || 24));
  const bw = Math.max(2, Math.round(size / 14)); // outline thickness scales with size
  const fx = (Number(cap.fx) || 0).toFixed(4);
  const fy = (Number(cap.fy) || 0).toFixed(4);
  return `drawtext=fontfile='${ffPath(captionFontPath)}':textfile='${ffPath(cap.textfile)}'` +
    `:fontsize=${size}:fontcolor=${ffColor(cap.color)}:borderw=${bw}:bordercolor=black@1` +
    `:x=(w*${fx})-(text_w/2):y=(h*${fy})-(text_h/2)`;
}

ipcMain.handle('capture/to-gif', (_e, { src, fps = 15, width = 480, trim = null, crop = null, speed = 1, outSeconds = 0, captions = [] }) => {
  return new Promise((resolve) => {
    if (!src || !fs.existsSync(src)) { resolve({ ok: false, error: 'source file not found' }); return; }
    const out = src.replace(/\.webm$/i, '') + '.gif';
    const w = Number(width);

    // Text overlays: write each caption's text to a temp file (drawtext textfile=)
    // and build its filter. tmpPaths are cleaned up once ffmpeg finishes.
    const tmpPaths = [];
    let drawtexts = [];
    try {
      const caps = Array.isArray(captions) ? captions.filter((c) => c && String(c.text || '').length) : [];
      if (caps.length) {
        const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-cap-'));
        tmpPaths.push(tdir);
        drawtexts = caps.map((c, i) => {
          const tf = path.join(tdir, `c${i}.txt`);
          fs.writeFileSync(tf, String(c.text), 'utf8');
          tmpPaths.push(tf);
          return buildDrawtext({ textfile: tf, fx: c.fx, fy: c.fy, size: c.size, color: c.color });
        });
      }
    } catch { drawtexts = []; } // captions are best-effort; never block the GIF
    const cleanupTmp = () => {
      for (const p of tmpPaths) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
    };

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
    const args = ['-y', ...preInput, '-i', src, ...postInput, '-vf', gifFilter(Number(fps), w, crop, Number(speed), drawtexts), '-loop', '0', out];

    let proc;
    try {
      proc = spawn(ffmpegPath, args);
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

// --- Copy GIF to clipboard (M5) ---
// Animated GIFs are the tricky case: clipboard.writeImage() flattens to a still
// PNG. On macOS we instead put the file itself on the pasteboard (public.file-url)
// so pasting into Discord/Slack/iMessage attaches the *animated* file. Other
// platforms fall back to a static image (best effort until per-OS handling lands).
ipcMain.handle('capture/copy-gif', async (_e, file) => {
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
});
