// Control panel logic: show version, render hotkeys, trigger actions, rebind keys.
// Kept external so the page CSP can forbid inline scripts.
//
// ORDER MATTERS: the hotkey-rebind wiring is set up FIRST so that an error in
// any later (optional) feature wiring can't abort the script before rebinding
// is attached. Optional feature wiring is also null-guarded + try/caught.

const $ = (id) => document.getElementById(id);
const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

// --- version ---
(async () => {
  try { $('ver').textContent = 'v' + (await window.gifApp.getVersion()); }
  catch { $('ver').textContent = ''; }
})();

// Make accelerators read nicely (Command symbol on mac, words elsewhere).
function pretty(accel) {
  return String(accel || '')
    .replace('CommandOrControl', IS_MAC ? '⌘' : 'Ctrl')
    .replace('Command', '⌘').replace('Control', 'Ctrl')
    .replace('Shift', IS_MAC ? '⇧' : 'Shift')
    .replace('Alt', IS_MAC ? '⌥' : 'Alt')
    .replace(/\+/g, IS_MAC ? ' ' : '+');
}

// --- render current hotkeys + registration status ---
async function refreshHotkeys() {
  const { hotkeys, status } = await window.gifApp.getHotkeys();
  const set = (id, v) => { const el = $(id); if (el) el.textContent = pretty(v); };
  set('chip-capture', hotkeys.capture);
  set('chip-soundboard', hotkeys.soundboard);
  set('chip-saveReplay', hotkeys.saveReplay);
  const allOk = status.capture && status.soundboard && status.saveReplay;
  $('dot').className = 'dot' + (allOk ? '' : ' warn');
  $('statusText').textContent = allOk
    ? 'Running in the menu bar'
    : 'A hotkey is conflicting — click it to rebind';
}
refreshHotkeys();

// --- trigger an action (same path the global hotkey uses) ---
document.querySelectorAll('.go').forEach((btn) => {
  btn.addEventListener('click', () => window.gifApp.trigger(btn.dataset.action));
});

// --- flash a row when its action fires ---
window.gifApp.onActionFired((kind) => {
  const row = $('row-' + kind);
  if (!row) return;
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 450);
});

// --- rebinding: click a chip, then press a combo (WIRED FIRST, can't be broken) ---
let listening = null; // {action, chip} or null

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => startListening(chip));
});

function startListening(chip) {
  if (listening) stopListening();
  listening = { action: chip.dataset.action, chip };
  chip.classList.add('listening');
  chip.textContent = 'press keys…';
  // Suspend global shortcuts so the combo reaches this window instead of firing.
  try { window.gifApp.suspendHotkeys(); } catch { /* ignore */ }
}

function stopListening() {
  if (!listening) return;
  listening.chip.classList.remove('listening');
  listening = null;
  try { window.gifApp.resumeHotkeys(); } catch { /* ignore */ }
  refreshHotkeys();
}

window.addEventListener('keydown', async (e) => {
  if (!listening) return;
  e.preventDefault();

  if (e.key === 'Escape') { stopListening(); return; }

  const accel = toAccelerator(e);
  if (!accel) return; // wait for a non-modifier key with at least one modifier

  const { action, chip } = listening;
  chip.textContent = 'saving…';
  const res = await window.gifApp.setHotkey(action, accel);
  if (res.ok) {
    listening.chip.classList.remove('listening');
    listening = null;
    try { window.gifApp.resumeHotkeys(); } catch { /* ignore */ }
    refreshHotkeys();
  } else {
    // Stay in listening mode so the user can immediately try another combo.
    chip.textContent = res.error === 'conflict'
      ? `${pretty(accel)} taken — try another`
      : 'failed — try another';
  }
});

// Convert a browser KeyboardEvent into an Electron accelerator string.
function toAccelerator(e) {
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  const key = keyName(e);
  if (!key) return null;            // modifier-only press → keep waiting
  // Letters/digits need a modifier (a bare 'G' would hijack typing globally),
  // but function keys are fine on their own — common for capture/replay tools.
  const isFn = /^F([1-9]|1\d|2[0-4])$/.test(key);
  if (mods.length === 0 && !isFn) return null;
  return [...mods, key].join('+');
}

function keyName(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  const map = {
    Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  return map[c] || null; // ignore bare modifier keys
}

// --- Instant Replay settings (gear → modal) — optional, fully guarded ---
function applyReplayState(r) {
  const t = $('replayToggle');
  if (t) {
    t.classList.toggle('on', !!r.enabled);
    t.textContent = r.enabled ? 'On' : 'Off';
    t.setAttribute('aria-pressed', r.enabled ? 'true' : 'false');
  }
  const gear = $('replayGear'); if (gear) gear.classList.toggle('on', !!r.enabled);
  const secs = $('replaySeconds'); if (secs) secs.value = String(r.seconds);
  const mode = r.mode === 'webcam' ? 'webcam' : 'screen';
  const modeSel = $('replayMode'); if (modeSel) modeSel.value = mode;
  applyReplayMode(mode);
  const sub = $('replaySub'); if (sub) sub.textContent = `Always recording — save the last ${r.seconds}s`;
}

// Show the right source picker (monitor vs camera) and adjust the note.
function applyReplayMode(mode) {
  const webcam = mode === 'webcam';
  const screenRow = $('replayScreenRow'); if (screenRow) screenRow.style.display = webcam ? 'none' : '';
  const camRow = $('replayCameraRow'); if (camRow) camRow.style.display = webcam ? '' : 'none';
  const note = $('replayNote');
  if (note) note.textContent = webcam
    ? 'When on, GifMayker constantly records your webcam (the camera light stays on). Press the hotkey to save the last clip as a GIF.'
    : 'When on, GifMayker constantly records the screen. Press the hotkey to save the last clip and edit it into a GIF.';
  if (webcam) populateCameras();
}

// List cameras for the dropdown. Labels need camera permission; before that
// they come back blank, so we show generic names until permission is granted.
async function populateCameras() {
  const sel = $('replayCamera');
  if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const cur = (await window.gifApp.getReplay()).deviceId;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'Default camera';
    if (cur == null) def.selected = true;
    sel.appendChild(def);
    cams.forEach((c, i) => {
      if (!c.deviceId) return; // unidentifiable until permission granted
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || `Webcam ${i + 1}`;
      if (String(c.deviceId) === String(cur)) o.selected = true;
      sel.appendChild(o);
    });
  } catch { /* leave Default */ }
}
async function refreshReplay() {
  try { applyReplayState(await window.gifApp.getReplay()); } catch { /* ignore */ }
}
async function populateScreens() {
  const sel = $('replayScreen');
  if (!sel) return;
  try {
    const screens = await window.gifApp.listScreens();
    const cur = (await window.gifApp.getReplay()).displayId;
    sel.innerHTML = '';
    if (!screens.length) { sel.innerHTML = '<option>Default</option>'; return; }
    screens.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = s.displayId == null ? '' : String(s.displayId);
      o.textContent = s.name;
      if ((cur == null && i === 0) || String(s.displayId) === String(cur)) o.selected = true;
      sel.appendChild(o);
    });
  } catch { sel.innerHTML = '<option>Default</option>'; }
}

try {
  $('replayScreen')?.addEventListener('change', () => window.gifApp.setReplayScreen($('replayScreen').value || null));
  $('replayMode')?.addEventListener('change', async () => {
    const mode = $('replayMode').value;
    applyReplayMode(mode);
    try { applyReplayState(await window.gifApp.setReplayMode(mode)); } catch { refreshReplay(); }
  });
  $('replayCamera')?.addEventListener('change', () => window.gifApp.setReplayCamera($('replayCamera').value || null));
  $('replayGear')?.addEventListener('click', () => {
    $('replayModal')?.classList.add('show');
    populateScreens();
    if ($('replayMode')?.value === 'webcam') populateCameras();
  });
  $('replayClose')?.addEventListener('click', () => $('replayModal')?.classList.remove('show'));
  $('replayModal')?.addEventListener('click', (e) => { if (e.target === $('replayModal')) $('replayModal').classList.remove('show'); });
  $('replayToggle')?.addEventListener('click', async () => {
    const turnOn = !$('replayToggle').classList.contains('on');
    $('replayToggle').textContent = '…';
    try { applyReplayState(await window.gifApp.setReplayEnabled(turnOn)); } catch { refreshReplay(); }
  });
  $('replaySeconds')?.addEventListener('change', async () => {
    try { applyReplayState(await window.gifApp.setReplaySeconds(Number($('replaySeconds').value))); } catch { refreshReplay(); }
  });
  refreshReplay();
} catch (e) { console.error('[control] replay wiring failed:', e); }
