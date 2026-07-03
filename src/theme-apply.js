// Applies the user's custom color theme on top of the theme.css defaults.
// Each "wheel" picks ONE color; we derive a whole family of tokens from it so a
// single pick recolors all the related surfaces/borders/text shades cohesively.
// A null field = remove our overrides so the built-in gold defaults show through.
//
// Loaded in EVERY window (control/capture/soundboard) so a change made on the
// home page applies everywhere live. Readability across odd color combos is the
// user's call by design — no contrast guard here.
(function () {
  const root = document.documentElement;

  // Built-in "Maykr" defaults — what the color wheels start from.
  const DEFAULTS = { accent: '#d4af37', bg: '#13100b', text: '#ffffff' };

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  }
  function rgbToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }
  // Linearly blend `hex` toward a target ('white' | 'black' | another hex) by amt 0..1.
  function mix(hex, target, amt) {
    const a = hexToRgb(hex);
    const b = target === 'white' ? [255, 255, 255] : target === 'black' ? [0, 0, 0] : hexToRgb(target);
    return rgbToHex(a[0] + (b[0] - a[0]) * amt, a[1] + (b[1] - a[1]) * amt, a[2] + (b[2] - a[2]) * amt);
  }
  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const set = (k, v) => root.style.setProperty(k, v);
  const clear = (...ks) => ks.forEach((k) => root.style.removeProperty(k));

  // "Gold trim" — accent + its states + the pill/button outlines & highlight borders.
  // --border-strong is the pill/button outline used across every window, so it
  // lives here (follows trim) rather than in the background ramp.
  function applyAccent(c) {
    if (!c) { clear('--accent', '--accent-soft', '--accent-hover', '--accent-active', '--on-accent', '--border-strong', '--border-hover', '--border-active'); return; }
    set('--accent', c);
    set('--accent-soft', mix(c, 'white', 0.45));
    set('--accent-hover', mix(c, 'black', 0.12));
    set('--accent-active', mix(c, 'black', 0.25));
    set('--on-accent', luminance(c) > 0.5 ? '#1a1407' : '#ffffff'); // keep the label on a gold fill legible
    set('--border-strong', mix(c, 'black', 0.52)); // pill/button outlines
    set('--border-hover', mix(c, 'black', 0.30));
    set('--border-active', mix(c, 'black', 0.55));
  }

  // "Background" — the dark base plus the lighter surface/container ramp built up
  // from it (panels, inputs, dividers, container borders). Pill outlines are NOT
  // here — those follow trim (see applyAccent).
  function applyBg(c) {
    if (!c) { clear('--bg', '--thumb-bg', '--modal', '--input', '--panel', '--btn', '--divider', '--border'); return; }
    set('--bg', c);
    set('--thumb-bg', mix(c, 'black', 0.35));
    set('--modal', mix(c, 'white', 0.04));
    set('--input', mix(c, 'white', 0.06));
    set('--panel', mix(c, 'white', 0.08));
    set('--btn', mix(c, 'white', 0.11));
    set('--divider', mix(c, 'white', 0.13));
    set('--border', mix(c, 'white', 0.19));
  }

  // "Text" — main text plus the dimmer subtext/muted shades.
  function applyText(c) {
    if (!c) { clear('--text', '--muted-3', '--muted-2', '--muted', '--muted-4'); return; }
    set('--text', c);
    set('--muted-3', mix(c, 'black', 0.27));
    set('--muted-2', mix(c, 'black', 0.33));
    set('--muted', mix(c, 'black', 0.40));
    set('--muted-4', mix(c, 'black', 0.52));
  }

  function apply(theme) {
    theme = theme || {};
    applyAccent(theme.accent || null);
    applyBg(theme.bg || null);
    applyText(theme.text || null);
  }

  // Custom background image: fill the whole window (cover, centered) behind the
  // UI, with a scrim on top for legibility. Any size is allowed — small/odd
  // images are simply scaled up to fill, so they may look soft. null clears it.
  function whenBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  function applyBgImage(url) {
    whenBody(() => {
      const b = document.body;
      if (url) {
        b.style.backgroundImage = `linear-gradient(var(--bg-scrim), var(--bg-scrim)), url("${url}")`;
        b.style.backgroundSize = 'cover';
        b.style.backgroundPosition = 'center';
        b.style.backgroundRepeat = 'no-repeat';
        b.style.backgroundAttachment = 'fixed';
      } else {
        b.style.backgroundImage = '';
        b.style.backgroundSize = '';
        b.style.backgroundPosition = '';
        b.style.backgroundRepeat = '';
        b.style.backgroundAttachment = '';
      }
    });
  }

  // Exposed so the control panel can preview live while dragging the wheel.
  window.__theme = { apply, applyBgImage, DEFAULTS };

  if (window.gifApp && window.gifApp.getTheme) {
    window.gifApp.getTheme().then(apply).catch(() => {});
    window.gifApp.onThemeChanged(apply);
  }
  if (window.gifApp && window.gifApp.getBgImage) {
    window.gifApp.getBgImage().then(applyBgImage).catch(() => {});
    window.gifApp.onBgChanged(applyBgImage);
  }
})();
