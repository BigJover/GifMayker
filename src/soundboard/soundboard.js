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
// Unified paint order for ALL overlay items (captions + stickers), bottom→top;
// DOM z-index and the ffmpeg bake both follow it so text/images layer freely.
let tzorder = [];
// black letterbox bars; top/bottom = fraction of GIF height, left/right = fraction
// of GIF width. 0 = off.
let tbars = { top: 0, bottom: 0, left: 0, right: 0 };
let tbardrag = null;

function tRegion() { const r = $('textGif').getBoundingClientRect(); return { W: r.width, H: r.height, left: r.left, top: r.top }; }

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
    c.el.style.zIndex = tzorder.indexOf(c) + 1;
    c.el.classList.toggle('sel', c === tsel);
  }
}

function tSelect(c) {
  tsel = c || null;
  const on = !!tsel;
  for (const id of ['tCapText', 'tCapColor', 'tCapSmaller', 'tCapBigger', 'tCapDel']) $(id).disabled = !on;
  if (on) { $('tCapText').value = tsel.text; $('tCapColor').value = tsel.color; } else { $('tCapText').value = ''; }
  if (tsel && tssel) { tssel = null; $('tSkDel').disabled = true; tsRender(); } // one selection across layers
  tRender();
  tUpdateLayerButtons();
}

function tAdd() {
  const c = { id: ++tseq, text: 'TEXT', fx: 0.5, fy: 0.12, sizeFrac: 0.12, color: '#ffffff' };
  const el = document.createElement('div');
  el.className = 'txtcap';
  el.addEventListener('mousedown', (e) => tStartDrag(e, c));
  $('textOverlay').appendChild(el);
  c.el = el; tcaps.push(c); tzorder.push(c); tSelect(c); $('tCapText').focus(); $('tCapText').select();
}

function tDelete() {
  if (!tsel) return;
  if (tsel.el) tsel.el.remove();
  tcaps = tcaps.filter((x) => x !== tsel);
  tzorder = tzorder.filter((x) => x !== tsel);
  tSelect(tcaps[tcaps.length - 1] || null);
}

function tClear() { for (const c of tcaps) if (c.el) c.el.remove(); tzorder = tzorder.filter((x) => !tcaps.includes(x)); tcaps = []; tSelect(null); }

// ---- layer ordering (shared by captions + stickers in this modal) ----
function tSelectedLayer() { return tsel || tssel; }
function tReorderLayer(dir) {
  const item = tSelectedLayer();
  if (!item) return;
  const i = tzorder.indexOf(item);
  const j = i + (dir > 0 ? 1 : -1);
  if (i < 0 || j < 0 || j >= tzorder.length) return;
  tzorder.splice(i, 1);
  tzorder.splice(j, 0, item);
  tRender(); tsRender(); tUpdateLayerButtons();
}
function tUpdateLayerButtons() {
  const item = tSelectedLayer();
  const i = item ? tzorder.indexOf(item) : -1;
  $('tLayerForward').disabled = i < 0 || i >= tzorder.length - 1;
  $('tLayerBack').disabled = i <= 0;
}

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
  tgif = g; tClear(); tsClear(); tClearBars();
  const img = $('textGif');
  img.onload = () => { tRender(); tsRender(); tRenderBars(); };
  img.src = fileURL(g.path);
  $('textHint').textContent = '';
  $('textModal').classList.add('show');
}
function closeTextEditor() { $('textModal').classList.remove('show'); $('textGif').src = ''; tClear(); tsClear(); tClearBars(); tgif = null; }

async function saveTextGif() {
  if (!tgif) return;
  const img = $('textGif');
  const natH = img.naturalHeight || img.clientHeight || 1; // sizes are in OUTPUT (native) pixels
  const natW = img.naturalWidth || img.clientWidth || 1;
  // Walk the shared z-order so text + stickers bake in the on-screen stacking.
  const layers = [];
  for (const item of tzorder) {
    if (tcaps.includes(item)) {
      if (!String(item.text || '').trim().length) continue;
      layers.push({ kind: 'text', text: item.text, fx: item.fx, fy: item.fy, size: Math.round(item.sizeFrac * natH), color: item.color });
    } else if (tstk.includes(item)) {
      layers.push({ kind: 'sticker', path: item.src, fx: item.fx, fy: item.fy, w: Math.max(1, Math.round(item.wFrac * natW)), h: Math.max(1, Math.round(item.hFrac * natH)) });
    }
  }
  const hasBars = tbars.top > 0 || tbars.bottom > 0;
  if (!layers.length && !hasBars) { $('textHint').textContent = 'Add some text, a sticker, or a bar first.'; return; }
  $('textSave').disabled = true; $('textSave').textContent = 'Saving…';
  const r = await window.gifApp.addTextToGif(tgif.path, layers, tbars);
  $('textSave').disabled = false; $('textSave').textContent = 'Save as new GIF';
  if (r && r.ok) {
    if (r.items) { items = r.items; render(); }
    closeTextEditor();
    $('hint').textContent = 'Saved a new edited GIF to your board.';
  } else {
    $('textHint').textContent = `Couldn't save: ${(r && r.error) || 'error'}`;
  }
}

// ---- sticker (image overlay) editor — parallel to the text impl above ----
// Region = the displayed GIF's client rect; positions/sizes are fractions of it.
// wFrac/hFrac are independent so a sticker can be stretched, not just scaled.
let tstk = [], tssel = null, tsdrag = null, tsresize = null, tsseq = 0;
const T_GRIPS = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];

function tsRender() {
  const g = tRegion();
  for (const s of tstk) {
    if (!s.el) continue;
    s.el.style.left = (s.fx * g.W) + 'px';
    s.el.style.top = (s.fy * g.H) + 'px';
    s.el.style.width = Math.max(8, s.wFrac * g.W) + 'px';
    s.el.style.height = Math.max(8, s.hFrac * g.H) + 'px';
    s.el.style.zIndex = tzorder.indexOf(s) + 1;
    s.el.classList.toggle('sel', s === tssel);
  }
}

function tsAdd(src) {
  const s = { id: ++tsseq, src, fx: 0.5, fy: 0.5, wFrac: 0.3, hFrac: 0.3, natW: 0, natH: 0 };
  const el = document.createElement('div');
  el.className = 'sticker';
  const img = document.createElement('img');
  img.draggable = false;
  img.onload = () => {
    s.natW = img.naturalWidth; s.natH = img.naturalHeight;
    const g = tRegion();
    if (s.natW && g.H) s.hFrac = (s.wFrac * g.W) * (s.natH / s.natW) / g.H;
    tsRender();
  };
  img.src = fileURL(src);
  el.appendChild(img);
  for (const dir of T_GRIPS) {
    const grip = document.createElement('span');
    grip.className = 'skgrip ' + dir;
    grip.addEventListener('mousedown', (e) => tsStartResize(e, s, dir));
    el.appendChild(grip);
  }
  el.addEventListener('mousedown', (e) => tsStartDrag(e, s));
  $('textOverlay').appendChild(el);
  s.el = el;
  tstk.push(s); tzorder.push(s);
  tsSelect(s);
}

function tsSelect(s) {
  tssel = s || null;
  $('tSkDel').disabled = !tssel;
  if (tssel) tSelect(null); // one selection across layers
  tsRender();
  tUpdateLayerButtons();
}
function tsDelete() { if (!tssel) return; if (tssel.el) tssel.el.remove(); tstk = tstk.filter((x) => x !== tssel); tzorder = tzorder.filter((x) => x !== tssel); tsSelect(null); }
function tsClear() { for (const s of tstk) if (s.el) s.el.remove(); tzorder = tzorder.filter((x) => !tstk.includes(x)); tstk = []; tsSelect(null); }

function tsStartDrag(e, s) {
  e.preventDefault(); e.stopPropagation(); tsSelect(s);
  tsdrag = { s, g: tRegion() };
  document.addEventListener('mousemove', tsOnDrag); document.addEventListener('mouseup', tsEndDrag);
}
function tsOnDrag(e) {
  if (!tsdrag) return;
  const g = tsdrag.g;
  tsdrag.s.fx = Math.max(0, Math.min(1, (e.clientX - g.left) / g.W));
  tsdrag.s.fy = Math.max(0, Math.min(1, (e.clientY - g.top) / g.H));
  tsRender();
}
function tsEndDrag() { tsdrag = null; document.removeEventListener('mousemove', tsOnDrag); document.removeEventListener('mouseup', tsEndDrag); }

// 8-handle resize: corners scale uniformly (aspect-locked), edges stretch one axis.
function tsStartResize(e, s, dir) {
  e.preventDefault(); e.stopPropagation(); tsSelect(s);
  const g = tRegion();
  const cx = s.fx * g.W, cy = s.fy * g.H, hw = (s.wFrac * g.W) / 2, hh = (s.hFrac * g.H) / 2;
  const wPx = s.wFrac * g.W;
  tsresize = { s, g, dir, box: { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh }, aspect: wPx > 0 ? (s.hFrac * g.H) / wPx : 1 };
  document.addEventListener('mousemove', tsOnResize); document.addEventListener('mouseup', tsEndResize);
}
// Pure geometry for an 8-handle resize (region px). `uniform` locks aspect on
// every handle; else corners stretch both axes, edges stretch one. aspect=h/w.
function tResizeBox(box, dir, mx, my, aspect, uniform) {
  let { left, right, top, bottom } = box;
  const MIN = 12;
  if (dir.length === 2) {
    const anchorX = dir.includes('w') ? right : left;
    const anchorY = dir.includes('n') ? bottom : top;
    let newW, newH;
    if (uniform) { newW = Math.max(MIN, Math.abs(mx - anchorX), Math.abs(my - anchorY) / aspect); newH = newW * aspect; }
    else { newW = Math.max(MIN, Math.abs(mx - anchorX)); newH = Math.max(MIN, Math.abs(my - anchorY)); }
    if (dir.includes('e')) { left = anchorX; right = anchorX + newW; } else { right = anchorX; left = anchorX - newW; }
    if (dir.includes('s')) { top = anchorY; bottom = anchorY + newH; } else { bottom = anchorY; top = anchorY - newH; }
  } else if (uniform) {
    if (dir === 'e' || dir === 'w') {
      const anchorX = dir === 'e' ? left : right;
      const newW = Math.max(MIN, Math.abs(mx - anchorX)), newH = newW * aspect;
      if (dir === 'e') { left = anchorX; right = anchorX + newW; } else { right = anchorX; left = anchorX - newW; }
      const cy = (top + bottom) / 2; top = cy - newH / 2; bottom = cy + newH / 2;
    } else {
      const anchorY = dir === 's' ? top : bottom;
      const newH = Math.max(MIN, Math.abs(my - anchorY)), newW = newH / aspect;
      if (dir === 's') { top = anchorY; bottom = anchorY + newH; } else { bottom = anchorY; top = anchorY - newH; }
      const cx = (left + right) / 2; left = cx - newW / 2; right = cx + newW / 2;
    }
  } else {
    if (dir === 'e') right = Math.max(left + MIN, mx);
    else if (dir === 'w') left = Math.min(right - MIN, mx);
    else if (dir === 's') bottom = Math.max(top + MIN, my);
    else if (dir === 'n') top = Math.min(bottom - MIN, my);
  }
  return { left, right, top, bottom };
}

function tsOnResize(e) {
  if (!tsresize) return;
  const { s, g, dir, aspect } = tsresize;
  const uniform = $('tSkUniform').checked;
  const mx = e.clientX - g.left, my = e.clientY - g.top; // region-relative pixels
  const b = tResizeBox(tsresize.box, dir, mx, my, aspect, uniform);
  s.fx = ((b.left + b.right) / 2) / g.W;
  s.fy = ((b.top + b.bottom) / 2) / g.H;
  s.wFrac = (b.right - b.left) / g.W;
  s.hFrac = (b.bottom - b.top) / g.H;
  tsRender();
}
function tsEndResize() { tsresize = null; document.removeEventListener('mousemove', tsOnResize); document.removeEventListener('mouseup', tsEndResize); }

// ---- black letterbox bars (top / bottom / left / right) ----
function tRenderBars() {
  const img = $('textGif');
  const W = img.clientWidth, H = img.clientHeight;
  // Pixel-snap far edges (ceil) so no GIF sliver peeks past the bar; overlap is
  // clipped by the layer's overflow:hidden.
  const Wc = Math.ceil(W), Hc = Math.ceil(H);
  const place = (el, on, x, y, w, h) => {
    if (!on) { el.style.display = 'none'; return; }
    el.style.display = 'block'; el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
  };
  place($('tBarTop'), tbars.top > 0, 0, 0, Wc, Math.ceil(tbars.top * H));
  const bTop = Math.floor(H - tbars.bottom * H);
  place($('tBarBottom'), tbars.bottom > 0, 0, bTop, Wc, Hc - bTop);
  place($('tBarLeft'), tbars.left > 0, 0, 0, Math.ceil(tbars.left * W), Hc);
  const rLeft = Math.floor(W - tbars.right * W);
  place($('tBarRight'), tbars.right > 0, rLeft, 0, Wc - rLeft, Hc);
}
function tUpdateBarButtons() {
  $('tBarTopBtn').classList.toggle('on', tbars.top > 0);
  $('tBarBottomBtn').classList.toggle('on', tbars.bottom > 0);
  $('tBarLeftBtn').classList.toggle('on', tbars.left > 0);
  $('tBarRightBtn').classList.toggle('on', tbars.right > 0);
}
function tToggleBar(which) { tbars[which] = tbars[which] > 0 ? 0 : 0.15; tRenderBars(); tUpdateBarButtons(); }
function tEqualizeBars() {
  if (tbars.top > 0 && tbars.bottom > 0) { const m = Math.max(tbars.top, tbars.bottom); tbars.top = tbars.bottom = m; }
  if (tbars.left > 0 && tbars.right > 0) { const m = Math.max(tbars.left, tbars.right); tbars.left = tbars.right = m; }
  tRenderBars();
}
function tClearBars() { tbars = { top: 0, bottom: 0, left: 0, right: 0 }; tRenderBars(); tUpdateBarButtons(); }
function tStartBarDrag(e, which) {
  e.preventDefault(); e.stopPropagation();
  tbardrag = { which, g: tRegion() };
  document.addEventListener('mousemove', tOnBarDrag); document.addEventListener('mouseup', tEndBarDrag);
}
function tOnBarDrag(e) {
  if (!tbardrag) return;
  const g = tbardrag.g, which = tbardrag.which;
  let frac;
  if (which === 'top' || which === 'bottom') { const y = e.clientY - g.top; frac = which === 'top' ? y / g.H : (g.H - y) / g.H; }
  else { const x = e.clientX - g.left; frac = which === 'left' ? x / g.W : (g.W - x) / g.W; }
  tbars[which] = Math.max(0.03, Math.min(0.6, frac));
  tRenderBars();
}
function tEndBarDrag() { tbardrag = null; document.removeEventListener('mousemove', tOnBarDrag); document.removeEventListener('mouseup', tEndBarDrag); }

async function tsRefreshTray() {
  const list = await window.gifApp.stickersList();
  const tray = $('tSkTray');
  tray.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'skempty';
    empty.textContent = 'No saved stickers yet —';
    tray.appendChild(empty);
  }
  for (const it of list) {
    const thumb = document.createElement('div');
    thumb.className = 'skthumb'; thumb.title = it.name || 'sticker';
    const img = document.createElement('img'); img.src = fileURL(it.path); thumb.appendChild(img);
    const rm = document.createElement('button');
    rm.className = 'skrm'; rm.textContent = '×'; rm.title = 'Remove from recents';
    rm.addEventListener('click', async (e) => { e.stopPropagation(); await window.gifApp.stickersRemove(it.id); tsRefreshTray(); });
    thumb.appendChild(rm);
    thumb.addEventListener('click', () => tsAdd(it.path));
    tray.appendChild(thumb);
  }
  const up = document.createElement('button');
  up.className = 'skupload'; up.textContent = '＋'; up.title = 'Upload an image';
  up.addEventListener('click', tsUpload);
  tray.appendChild(up);
}

async function tsUpload() {
  const res = await window.gifApp.stickersImport();
  await tsRefreshTray();
  if (res && res.ok && res.item) tsAdd(res.item.path);
}

// ---- wire controls ----
$('homeBtn').addEventListener('click', () => window.gifApp.closeSoundboard());
$('tAddCap').addEventListener('click', tAdd);
$('tCapText').addEventListener('input', () => { if (tsel) { tsel.text = $('tCapText').value; tRender(); } });
$('tCapColor').addEventListener('input', () => { if (tsel) { tsel.color = $('tCapColor').value; tRender(); } });
$('tCapSmaller').addEventListener('click', () => { if (tsel) { tsel.sizeFrac = Math.max(0.04, tsel.sizeFrac - 0.02); tRender(); } });
$('tCapBigger').addEventListener('click', () => { if (tsel) { tsel.sizeFrac = Math.min(0.6, tsel.sizeFrac + 0.02); tRender(); } });
$('tCapDel').addEventListener('click', tDelete);
$('tStickerToggle').addEventListener('click', () => {
  const tray = $('tSkTray');
  const show = tray.style.display === 'none';
  tray.style.display = show ? '' : 'none';
  if (show) tsRefreshTray();
});
$('tSkDel').addEventListener('click', tsDelete);
$('tLayerForward').addEventListener('click', () => tReorderLayer(1));
$('tLayerBack').addEventListener('click', () => tReorderLayer(-1));
$('tBarTopBtn').addEventListener('click', () => tToggleBar('top'));
$('tBarBottomBtn').addEventListener('click', () => tToggleBar('bottom'));
$('tBarLeftBtn').addEventListener('click', () => tToggleBar('left'));
$('tBarRightBtn').addEventListener('click', () => tToggleBar('right'));
$('tBarEqualBtn').addEventListener('click', tEqualizeBars);
$('tBarTop').querySelector('.baredge').addEventListener('mousedown', (e) => tStartBarDrag(e, 'top'));
$('tBarBottom').querySelector('.baredge').addEventListener('mousedown', (e) => tStartBarDrag(e, 'bottom'));
$('tBarLeft').querySelector('.baredge').addEventListener('mousedown', (e) => tStartBarDrag(e, 'left'));
$('tBarRight').querySelector('.baredge').addEventListener('mousedown', (e) => tStartBarDrag(e, 'right'));
$('textClose').addEventListener('click', closeTextEditor);
$('textCancel').addEventListener('click', closeTextEditor);
$('textSave').addEventListener('click', saveTextGif);
$('textModal').addEventListener('click', (e) => { if (e.target === $('textModal')) closeTextEditor(); });
window.addEventListener('resize', () => { tRender(); tsRender(); tRenderBars(); });
$('search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
$('fromCapturesBtn').addEventListener('click', openCapturePicker);
$('importBtn').addEventListener('click', () => importGifs(false));
$('capClose').addEventListener('click', () => $('capModal').classList.remove('show'));
$('capModal').addEventListener('click', (e) => { if (e.target === $('capModal')) $('capModal').classList.remove('show'); });

refresh();
