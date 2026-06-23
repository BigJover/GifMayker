// Control panel logic: show version, render hotkeys, trigger actions, rebind keys.
// Kept external so the page CSP can forbid inline scripts.

const $ = (id) => document.getElementById(id);

// --- version ---
(async () => {
  try { $('ver').textContent = 'v' + (await window.gifApp.getVersion()); }
  catch { $('ver').textContent = ''; }
})();

// --- render current hotkeys + registration status ---
async function refreshHotkeys() {
  const { hotkeys, status } = await window.gifApp.getHotkeys();
  $('chip-capture').textContent = pretty(hotkeys.capture);
  $('chip-soundboard').textContent = pretty(hotkeys.soundboard);
  const allOk = status.capture && status.soundboard;
  $('dot').className = 'dot' + (allOk ? '' : ' warn');
  $('statusText').textContent = allOk
    ? 'Running in the menu bar'
    : 'A hotkey is conflicting — click it to rebind';
}
refreshHotkeys();

// Make accelerators read nicely (Command symbol on mac, words elsewhere).
const IS_MAC = navigator.platform.toUpperCase().includes('MAC');
function pretty(accel) {
  return accel
    .replace('CommandOrControl', IS_MAC ? '⌘' : 'Ctrl')
    .replace('Command', '⌘').replace('Control', 'Ctrl')
    .replace('Shift', IS_MAC ? '⇧' : 'Shift')
    .replace('Alt', IS_MAC ? '⌥' : 'Alt')
    .replace(/\+/g, IS_MAC ? ' ' : '+');
}

// --- trigger an action (same path the global hotkey uses) ---
document.querySelectorAll('.go').forEach((btn) => {
  btn.addEventListener('click', () => window.gifApp.trigger(btn.dataset.action));
});

// --- flash a row when its action fires (from hotkey or button) ---
window.gifApp.onActionFired((kind) => {
  const row = $('row-' + kind);
  if (!row) return;
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 450);
});

// --- rebinding: click a chip, then press a combo ---
let listening = null; // {action, chip} or null

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => startListening(chip));
});

function startListening(chip) {
  if (listening) stopListening();
  listening = { action: chip.dataset.action, chip };
  chip.classList.add('listening');
  chip.textContent = 'press keys…';
}

function stopListening() {
  if (!listening) return;
  listening.chip.classList.remove('listening');
  listening = null;
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
  listening.chip.classList.remove('listening');
  listening = null;
  if (!res.ok) {
    chip.textContent = res.error === 'conflict' ? 'taken — try another' : 'failed';
    setTimeout(refreshHotkeys, 1100);
  } else {
    refreshHotkeys();
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
  if (mods.length === 0) return null; // require at least one modifier (safer global key)
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
