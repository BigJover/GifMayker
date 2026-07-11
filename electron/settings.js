// Tiny JSON-file settings store (no dependency). Lives in the OS app-data dir.
// Holds user-rebindable hotkeys for now; soundboard/favorites get added later.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  hotkeys: {
    capture: 'CommandOrControl+Shift+G',
    soundboard: 'CommandOrControl+Shift+B',
    saveReplay: 'CommandOrControl+Shift+R',
  },
  // null = use the default captures folder inside app-data; otherwise an
  // absolute directory the user chose for saved videos + GIFs.
  saveDir: null,
  // Instant Replay (Phase 2): a rolling background buffer of the last N seconds.
  replay: {
    enabled: false,
    seconds: 30,
    displayId: null, // which monitor to record; null = primary/first
    mode: 'screen',  // 'screen' = a monitor, 'webcam' = the camera, 'pip' = screen + webcam overlay
    deviceId: null,  // which webcam in 'webcam'/'pip' mode; null = default camera
  },
  // Custom color theme. Each field is a hex string the user picked from the
  // color wheel, or null = use the built-in "Maykr" gold defaults from
  // theme.css. One picked color drives a whole family (see src/theme-apply.js).
  theme: {
    accent: null, // "gold trim" — accent + highlight borders
    bg: null,     // dark background + the surface/border ramp
    text: null,   // text + the subtext/muted shades
    bgImage: null, // absolute path to a user-chosen window background image (copied into userData), or null
  },
};

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  try {
    const disk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { ...DEFAULTS, ...disk };
    cache.hotkeys = { ...DEFAULTS.hotkeys, ...(disk.hotkeys || {}) };
    cache.replay = { ...DEFAULTS.replay, ...(disk.replay || {}) };
    cache.theme = { ...DEFAULTS.theme, ...(disk.theme || {}) };
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function save(next) {
  cache = next;
  try {
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('settings save failed:', e);
  }
  return cache;
}

module.exports = { load, save, DEFAULTS };
