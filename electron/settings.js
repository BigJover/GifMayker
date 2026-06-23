// Tiny JSON-file settings store (no dependency). Lives in the OS app-data dir.
// Holds user-rebindable hotkeys for now; soundboard/favorites get added later.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  hotkeys: {
    capture: 'CommandOrControl+Shift+G',
    soundboard: 'CommandOrControl+Shift+B',
  },
  // null = use the default captures folder inside app-data; otherwise an
  // absolute directory the user chose for saved videos + GIFs.
  saveDir: null,
};

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  try {
    const disk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { ...DEFAULTS, ...disk };
    cache.hotkeys = { ...DEFAULTS.hotkeys, ...(disk.hotkeys || {}) };
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
