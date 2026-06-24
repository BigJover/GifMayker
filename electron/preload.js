// Safe bridge between the renderer (UI) and the main process.
// Only the functions exposed here are reachable from window code.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gifApp', {
  getVersion: () => ipcRenderer.invoke('app/version'),

  // Hotkeys
  getHotkeys: () => ipcRenderer.invoke('hotkeys/get'),
  setHotkey: (action, accelerator) => ipcRenderer.invoke('hotkeys/set', { action, accelerator }),

  // Trigger an action from the UI (same path the hotkey uses)
  trigger: (kind) => ipcRenderer.invoke('action/trigger', kind),

  // Main → renderer: a hotkey/action fired (so the UI can flash the row)
  onActionFired: (cb) => ipcRenderer.on('action/fired', (_e, kind) => cb(kind)),

  // Capture (M2)
  closeCapture: () => ipcRenderer.invoke('capture/close'),
  capturePermission: () => ipcRenderer.invoke('capture/permission'),

  // Soundboard (M6)
  closeSoundboard: () => ipcRenderer.invoke('soundboard/close'),
  sbList: () => ipcRenderer.invoke('sb/list'),
  sbImport: (opts) => ipcRenderer.invoke('sb/import', opts),
  sbAdd: (file) => ipcRenderer.invoke('sb/add', file),
  sbRemove: (id) => ipcRenderer.invoke('sb/remove', id),
  listCaptureGifs: () => ipcRenderer.invoke('captures/list-gifs'),
  deleteCaptureGif: (file) => ipcRenderer.invoke('captures/delete-gif', file),
  deleteSource: (file) => ipcRenderer.invoke('capture/delete-source', file),

  // Instant Replay (Phase 2)
  getReplay: () => ipcRenderer.invoke('replay/get'),
  setReplayEnabled: (on) => ipcRenderer.invoke('replay/set-enabled', on),
  setReplaySeconds: (s) => ipcRenderer.invoke('replay/set-seconds', s),
  listScreens: () => ipcRenderer.invoke('replay/list-screens'),
  setReplayScreen: (displayId) => ipcRenderer.invoke('replay/set-screen', displayId),
  replaySubmit: (buffers) => ipcRenderer.invoke('replay/submit', buffers),
  onReplayStart: (cb) => ipcRenderer.on('replay/start', (_e, opts) => cb(opts)),
  onReplayStop: (cb) => ipcRenderer.on('replay/stop', () => cb()),
  onReplaySave: (cb) => ipcRenderer.on('replay/save', () => cb()),
  onLoadClip: (cb) => ipcRenderer.on('capture/load-clip', (_e, file) => cb(file)),
  openScreenPrefs: () => ipcRenderer.invoke('capture/open-screen-prefs'),
  getSources: () => ipcRenderer.invoke('capture/sources'),
  saveCapture: (arrayBuffer) => ipcRenderer.invoke('capture/save', arrayBuffer),
  revealCapture: (file) => ipcRenderer.invoke('capture/reveal', file),
  openCapture: (file) => ipcRenderer.invoke('capture/open', file),
  copyGif: (file) => ipcRenderer.invoke('capture/copy-gif', file),
  // Correct file:// URL on every OS (Windows paths need file:///C:/... form).
  toFileUrl: (p) => {
    try { return require('url').pathToFileURL(p).href; }
    catch {
      let s = String(p).replace(/\\/g, '/');
      if (/^[A-Za-z]:/.test(s)) s = '/' + s;            // C:/x -> /C:/x
      return 'file://' + s.replace(/ /g, '%20').replace(/#/g, '%23').replace(/\?/g, '%3F');
    }
  },
  replayError: (msg) => ipcRenderer.invoke('replay/error', msg),
  toGif: (opts) => ipcRenderer.invoke('capture/to-gif', opts),

  // Save location
  getSaveDir: () => ipcRenderer.invoke('savedir/get'),
  openSaveDir: () => ipcRenderer.invoke('savedir/open'),
  chooseSaveDir: () => ipcRenderer.invoke('savedir/choose'),
});
