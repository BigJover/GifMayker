// Generates the app/installer icon (build/icon.png), 512x512 RGBA, zero deps.
// Clean & simple, "imperial" Maykr palette: dark rounded square with a thin
// gold frame and an ivory capture/play glyph. No external imagery.
// Run with: npm run appicon
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const W = 512, H = 512;
const px = Buffer.alloc(W * H * 4);

const RADIUS = 116;     // outer corner radius
const FRAME = 18;       // gold frame thickness
const INNER_R = RADIUS - FRAME;

// inside a rounded rect inset from the edges by `inset`, with corner radius `rad`
function inRoundRect(x, y, inset, rad) {
  const loX = inset, hiX = W - 1 - inset, loY = inset, hiY = H - 1 - inset;
  if (x < loX || x > hiX || y < loY || y > hiY) return false;
  const rx = Math.min(x - loX, hiX - x), ry = Math.min(y - loY, hiY - y);
  if (rx >= rad || ry >= rad) return true;
  const dx = rad - rx, dy = rad - ry;
  return dx * dx + dy * dy <= rad * rad;
}

const lerp = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const BG_HI = [32, 26, 17];   // warm charcoal highlight (top-left)
const BG_LO = [13, 10, 6];    // near-black (bottom-right)
const GOLD_HI = [232, 200, 96];
const GOLD_LO = [176, 134, 38];
const IVORY = [240, 233, 214];
const maxD = Math.hypot(W, H);

// play/capture triangle geometry (slightly left-of-center, vertically centered)
const triL = W * 0.40, triCy = H * 0.5, triH = 168, triW = 150;

function inTriangle(x, y) {
  const dy = y - triCy;
  if (Math.abs(dy) > triH / 2) return false;
  const t = (Math.abs(dy) / (triH / 2));        // 0 at mid, 1 at tip
  const right = triL + triW * (1 - t);
  return x >= triL && x <= right;
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const outer = inRoundRect(x, y, 0, RADIUS);
    if (!outer) continue;                         // transparent outside

    const inner = inRoundRect(x, y, FRAME, INNER_R);
    let col;
    if (!inner) {
      // gold frame, soft diagonal sheen
      const t = Math.min(1, Math.hypot(x, y) / maxD * 1.4);
      col = lerp(GOLD_HI, GOLD_LO, t);
    } else if (inTriangle(x, y)) {
      col = IVORY;                                // capture/play glyph
    } else {
      const t = Math.min(1, Math.hypot(x - W * 0.32, y - H * 0.30) / maxD * 1.7);
      col = lerp(BG_HI, BG_LO, t);
    }
    px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
  }
}

// ---- encode PNG (RGBA, filter 0 per row) ----
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw);
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, dataBuf) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(dataBuf.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, dataBuf])), 0);
  return Buffer.concat([len, t, dataBuf, crc]);
};
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
