// Soundboard window (M6) — a board of saved GIFs. Click a tile to copy the GIF
// to the clipboard (paste anywhere); add via "From Captures" / "Import GIF" /
// the "+" tile; remove with the × on hover. Backed by a local JSON store.

const $ = (id) => document.getElementById(id);

let items = [];   // [{ id, path, name, addedAt, missing }]
let query = '';

function visible() {
  return items.filter((g) => !query || g.name.toLowerCase().includes(query));
}

function fileURL(p) { return `file://${encodeURI(p)}`; }

function render() {
  const list = visible();
  const grid = $('grid');
  grid.innerHTML = '';

  for (const g of list) {
    const el = document.createElement('div');
    el.className = 'tile' + (g.missing ? ' missing' : '');
    const thumb = g.missing
      ? `<span class="thumb"><span class="badge">MISSING</span></span>`
      : `<span class="thumb"><img src="${fileURL(g.path)}" alt="" draggable="false" />` +
        `<span class="badge">GIF</span><span class="veil">Copy</span></span>`;
    el.innerHTML = `${thumb}<span class="rm" title="Remove">×</span>` +
      `<div class="cap" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>`;

    el.querySelector('.rm').addEventListener('click', (e) => { e.stopPropagation(); removeItem(g.id); });
    if (!g.missing) el.addEventListener('click', () => copyTile(el, g));
    grid.appendChild(el);
  }

  // trailing "+ Add GIF" tile (defaults to your captures folder)
  const add = document.createElement('div');
  add.className = 'tile add';
  add.innerHTML = `<span class="plus">+</span><span class="lbl">Add GIF</span>`;
  add.addEventListener('click', () => importGifs(true));
  grid.appendChild(add);

  $('count').textContent = `${items.length} GIF${items.length === 1 ? '' : 's'}`;
  $('empty').style.display = items.length ? 'none' : 'block';
}

async function copyTile(el, g) {
  const veil = el.querySelector('.veil');
  const r = await window.gifApp.copyGif(g.path);
  if (r && r.ok) {
    el.classList.add('copied');
    if (veil) veil.textContent = '✓ Copied';
    $('hint').textContent = `Copied “${g.name}” — paste anywhere.`;
    setTimeout(() => { el.classList.remove('copied'); if (veil) veil.textContent = 'Copy'; }, 900);
  } else {
    $('hint').textContent = `Copy failed: ${(r && r.error) || 'error'}`;
  }
}

async function importGifs(fromCaptures) {
  const r = await window.gifApp.sbImport({ fromCaptures });
  if (r && r.items) {
    items = r.items;
    render();
    if (r.added) $('hint').textContent = `Added ${r.added} GIF${r.added === 1 ? '' : 's'}.`;
  }
}

async function removeItem(id) {
  items = await window.gifApp.sbRemove(id);
  render();
}

async function refresh() {
  items = await window.gifApp.sbList();
  render();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- wire controls ----
$('homeBtn').addEventListener('click', () => window.gifApp.closeSoundboard());
$('search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
$('fromCapturesBtn').addEventListener('click', () => importGifs(true));
$('importBtn').addEventListener('click', () => importGifs(false));

refresh();
