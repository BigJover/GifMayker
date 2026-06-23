// Soundboard library — tiny JSON store of saved GIFs (references, not copies).
// Lives in the OS app-data dir alongside settings.json. Each item:
//   { id, path, name, addedAt }
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let cache = null;
const file = () => path.join(app.getPath('userData'), 'soundboard.json');

function load() {
  if (cache) return cache;
  try {
    const disk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { items: Array.isArray(disk.items) ? disk.items : [] };
  } catch {
    cache = { items: [] };
  }
  return cache;
}

function save(next) {
  cache = next;
  try {
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('soundboard save failed:', e);
  }
  return cache;
}

module.exports = { load, save };
