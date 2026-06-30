// Sticker recents — tiny JSON store of user-uploaded sticker images so they can
// be reused across GIFs. Unlike the soundboard (which references files in place),
// uploaded stickers are COPIED into userData/stickers/ so they survive even if the
// user moves or deletes the original. Each item: { id, path, name, src, addedAt }
//   path = the copied-in file we render/overlay; src = original path (for dedupe).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_RECENTS = 40;
let cache = null;
const file = () => path.join(app.getPath('userData'), 'stickers.json');

function dir() {
  const d = path.join(app.getPath('userData'), 'stickers');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* exists */ }
  return d;
}

function load() {
  if (cache) return cache;
  try {
    const disk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { items: Array.isArray(disk.items) ? disk.items : [] };
  } catch {
    cache = { items: [] };
  }
  // Drop entries whose copied file vanished (manual cleanup of userData/stickers).
  cache.items = cache.items.filter((it) => it && it.path && fs.existsSync(it.path));
  return cache;
}

function save(next) {
  cache = next;
  try {
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('stickers save failed:', e);
  }
  return cache;
}

module.exports = { load, save, dir, MAX_RECENTS };
