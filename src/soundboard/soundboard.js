// Soundboard window (M6) — a board of saved GIFs. Click a tile to copy the GIF
// to the clipboard (paste anywhere); add via "From Captures" / "Import GIF" /
// the "+" tile; remove with the × on hover. Backed by a local JSON store.

const $ = (id) => document.getElementById(id);

let items = [];   // [{ id, path, name, addedAt, missing }]
let query = '';

function visible() {
  return items.filter((g) => !query || g.name.toLowerCase().includes(query));
}

function fileURL(p) { return window.gifApp.toFileUrl(p); }

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
    const editBtn = g.missing ? '' : `<button class="capedit" title="Add text to this GIF">✎ edit</button>`;
    el.innerHTML = `${thumb}<span class="rm" title="Remove">×</span>` +
      `<div class="cap">${editBtn}<span class="fname" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span></div>`;

    el.querySelector('.rm').addEventListener('click', (e) => { e.stopPropagation(); removeItem(g.id); });
    const eb = el.querySelector('.capedit');
    if (eb) eb.addEventListener('click', (e) => { e.stopPropagation(); openTextEditor(g); });
    if (!g.missing) el.addEventListener('click', () => copyTile(el, g));
    grid.appendChild(el);
  }

  // trailing "+ Add GIF" tile (defaults to your captures folder)
  const add = document.createElement('div');
  add.className = 'tile add';
  add.innerHTML = `<span class="plus">+</span><span class="lbl">Add GIF</span>`;
  add.addEventListener('click', openCapturePicker);
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

// --- In-app "From Captures" picker: a grid of GIFs from the captures folder ---
async function openCapturePicker() {
  const { gifs } = await window.gifApp.listCaptureGifs();
  const grid = $('capGrid');
  grid.innerHTML = '';
  if (!gifs.length) {
    grid.innerHTML = '<div style="color:#9a8c66;font-size:12.5px;padding:24px 4px">No GIFs in your captures folder yet — make one in Capture first.</div>';
  } else {
    const onBoard = new Set(items.map((it) => it.path));
    for (const g of gifs) {
      const added = onBoard.has(g.path);
      const el = document.createElement('div');
      el.className = 'tile' + (added ? ' added' : '');
      el.innerHTML =
        `<span class="thumb"><img src="${fileURL(g.path)}" alt="" draggable="false" />` +
        `<span class="veil">${added ? 'On board' : 'Add'}</span></span>` +
        `<span class="rm" title="Delete from captures (to Trash)">×</span>` +
        `<div class="cap" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>`;
      el.querySelector('.rm').addEventListener('click', (e) => { e.stopPropagation(); deleteCapture(el, g.path); });
      if (!added) el.addEventListener('click', () => addFromPicker(el, g.path));
      grid.appendChild(el);
    }
  }
  $('capModal').classList.add('show');
}

async function addFromPicker(el, p) {
  const r = await window.gifApp.sbAdd(p);
  if (r && r.items) { items = r.items; render(); }
  el.classList.add('added');
  const veil = el.querySelector('.veil');
  if (veil) veil.textContent = 'Added ✓';
}

async function deleteCapture(el, p) {
  const r = await window.gifApp.deleteCaptureGif(p);
  if (r && r.ok) {
    el.remove();
    if (r.items) { items = r.items; render(); } // also unpinned if it was on the board
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

// ---- text editor: bake captions onto an existing GIF → a new board GIF ----
// Self-contained (operates on a still GIF <img> in a modal — no crop/video like
// the capture editor) but reuses the SAME drawtext backend via addTextToGif.
let tcaps = [], tsel = null, tdrag = null, tseq = 0, tgif = null;

function tRender() {
  const img = $('textGif');
  const W = img.clientWidth, H = img.clientHeight;
  for (const c of tcaps) {
    if (!c.el) continue;
    c.el.style.left = (c.fx * W) + 'px';
    c.el.style.top = (c.fy * H) + 'px';
    c.el.style.fontSize = Math.max(8, Math.round(c.sizeFrac * H)) + 'px';
    c.el.style.color = c.color;
    c.el.textContent = c.text || ' ';
    c.el.classList.toggle('sel', c === tsel);
  }
}

function tSelect(c) {
  tsel = c || null;
  const on = !!tsel;
  for (const id of ['tCapText', 'tCapColor', 'tCapSmaller', 'tCapBigger', 'tCapDel']) $(id).disabled = !on;
  if (on) { $('tCapText').value = tsel.text; $('tCapColor').value = tsel.color; } else { $('tCapText').value = ''; }
  tRender();
}

function tAdd() {
  const c = { id: ++tseq, text: 'TEXT', fx: 0.5, fy: 0.12, sizeFrac: 0.12, color: '#ffffff' };
  const el = document.createElement('div');
  el.className = 'txtcap';
  el.addEventListener('mousedown', (e) => tStartDrag(e, c));
  $('textLayer').appendChild(el);
  c.el = el; tcaps.push(c); tSelect(c); $('tCapText').focus(); $('tCapText').select();
}

function tDelete() {
  if (!tsel) return;
  if (tsel.el) tsel.el.remove();
  tcaps = tcaps.filter((x) => x !== tsel);
  tSelect(tcaps[tcaps.length - 1] || null);
}

function tClear() { for (const c of tcaps) if (c.el) c.el.remove(); tcaps = []; tSelect(null); }

function tStartDrag(e, c) {
  e.preventDefault(); e.stopPropagation(); tSelect(c);
  tdrag = { c, r: $('textGif').getBoundingClientRect() };
  document.addEventListener('mousemove', tOnDrag);
  document.addEventListener('mouseup', tEndDrag);
}
function tOnDrag(e) {
  if (!tdrag) return;
  const r = tdrag.r;
  tdrag.c.fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  tdrag.c.fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  tRender();
}
function tEndDrag() { tdrag = null; document.removeEventListener('mousemove', tOnDrag); document.removeEventListener('mouseup', tEndDrag); }

function openTextEditor(g) {
  tgif = g; tClear();
  const img = $('textGif');
  img.onload = tRender;
  img.src = fileURL(g.path);
  $('textHint').textContent = 'Add text and drag it onto the GIF.';
  $('textModal').classList.add('show');
}
function closeTextEditor() { $('textModal').classList.remove('show'); $('textGif').src = ''; tClear(); tgif = null; }

async function saveTextGif() {
  if (!tgif) return;
  const img = $('textGif');
  const natH = img.naturalHeight || img.clientHeight || 1; // font size is in OUTPUT (native) pixels
  const payload = tcaps
    .filter((c) => String(c.text || '').trim().length)
    .map((c) => ({ text: c.text, fx: c.fx, fy: c.fy, size: Math.round(c.sizeFrac * natH), color: c.color }));
  if (!payload.length) { $('textHint').textContent = 'Add some text first.'; return; }
  $('textSave').disabled = true; $('textSave').textContent = 'Saving…';
  const r = await window.gifApp.addTextToGif(tgif.path, payload);
  $('textSave').disabled = false; $('textSave').textContent = 'Save as new GIF';
  if (r && r.ok) {
    if (r.items) { items = r.items; render(); }
    closeTextEditor();
    $('hint').textContent = 'Saved a new captioned GIF to your board.';
  } else {
    $('textHint').textContent = `Couldn't save: ${(r && r.error) || 'error'}`;
  }
}

// ---- wire controls ----
$('homeBtn').addEventListener('click', () => window.gifApp.closeSoundboard());
$('tAddCap').addEventListener('click', tAdd);
$('tCapText').addEventListener('input', () => { if (tsel) { tsel.text = $('tCapText').value; tRender(); } });
$('tCapColor').addEventListener('input', () => { if (tsel) { tsel.color = $('tCapColor').value; tRender(); } });
$('tCapSmaller').addEventListener('click', () => { if (tsel) { tsel.sizeFrac = Math.max(0.04, tsel.sizeFrac - 0.02); tRender(); } });
$('tCapBigger').addEventListener('click', () => { if (tsel) { tsel.sizeFrac = Math.min(0.6, tsel.sizeFrac + 0.02); tRender(); } });
$('tCapDel').addEventListener('click', tDelete);
$('textClose').addEventListener('click', closeTextEditor);
$('textCancel').addEventListener('click', closeTextEditor);
$('textSave').addEventListener('click', saveTextGif);
$('textModal').addEventListener('click', (e) => { if (e.target === $('textModal')) closeTextEditor(); });
window.addEventListener('resize', tRender);
$('search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
$('fromCapturesBtn').addEventListener('click', openCapturePicker);
$('importBtn').addEventListener('click', () => importGifs(false));
$('capClose').addEventListener('click', () => $('capModal').classList.remove('show'));
$('capModal').addEventListener('click', (e) => { if (e.target === $('capModal')) $('capModal').classList.remove('show'); });

refresh();
