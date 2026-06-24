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
  const dir = saveDir || path.join(app.getPath('userData'), 'captures');
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
    height: 520,
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
  // Grab the primary screen as the source to continuously buffer.
  let srcId = null;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length) srcId = sources[0].id;
  } catch (e) { console.error('[replay] getSources failed:', e.message); }
  const { replay } = settings.load();
  bufferWin.webContents.send('replay/start', { sourceId: srcId, seconds: replay.seconds });
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

app.whenReady().then(() => {
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
  const res = await dialog.showOpenDialog(win, {
    title: 'Add GIFs to your soundboard',
    defaultPath: opts.fromCaptures ? capturesDir() : app.getPath('downloads'),
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

// --- Instant Replay IPC (Phase 2) ---
ipcMain.handle('replay/get', () => settings.load().replay);

ipcMain.handle('replay/set-enabled', async (_e, on) => {
  const cfg = settings.load();
  cfg.replay.enabled = !!on;
  settings.save(cfg);
  if (cfg.replay.enabled) await armReplay(); else disarmReplay();
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
function gifFilter(fps, width, crop, speed) {
  // crop (source pixels) → speed (retime) → fps drop → scale → palette.
  const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  // setpts=PTS/speed: >1 speeds up, <1 slows down (e.g. 0.25 = 4× longer).
  const speedF = (speed && speed !== 1) ? `setpts=PTS/${speed},` : '';
  const scale = width ? `scale=${width}:-1:flags=lanczos,` : '';
  return `${cropF}${speedF}fps=${fps},${scale}split[s0][s1]` +
    `;[s0]palettegen=stats_mode=diff[p]` +
    `;[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
}

ipcMain.handle('capture/to-gif', (_e, { src, fps = 15, width = 480, trim = null, crop = null, speed = 1 }) => {
  return new Promise((resolve) => {
    if (!src || !fs.existsSync(src)) { resolve({ ok: false, error: 'source file not found' }); return; }
    const out = src.replace(/\.webm$/i, '') + '.gif';
    const w = width === 'orig' ? null : Number(width);

    // Trim via accurate (post-decode) seek so the cut lands on the right frame.
    const trimArgs = [];
    if (trim && trim.duration > 0) {
      trimArgs.push('-ss', String(trim.start || 0), '-t', String(trim.duration));
    }
    const args = ['-y', '-i', src, ...trimArgs, '-vf', gifFilter(Number(fps), w, crop, Number(speed)), '-loop', '0', out];

    let proc;
    try {
      proc = spawn(ffmpegPath, args);
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
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
ipcMain.handle('capture/copy-gif', (_e, file) => {
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'file not found' };
    if (process.platform === 'darwin') {
      const url = 'file://' + encodeURI(file);
      clipboard.writeBuffer('public.file-url', Buffer.from(url, 'utf8'));
      return { ok: true, mode: 'file' };
    }
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return { ok: false, error: 'could not read image' };
    clipboard.writeImage(img);
    return { ok: true, mode: 'image' }; // static frame on non-mac for now
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
