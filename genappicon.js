// Generates the app/installer icon (build/icon.png), 512x512 RGBA, zero deps.
// A rounded-square purple radial gradient matching the control-window logo,
// with a simple white "play→frames" mark. electron-builder turns this into
// the .icns/.ico at package time. Run with: npm run appicon
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const W = 512, H = 512;
const px = Buffer.alloc(W * H * 4);
const radius = 112;           // rounded corners
const lightX = W * 0.32, lightY = H * 0.30; // gradient highlight center

// inside-rounded-rect test
function inRoundRect(x, y) {
  const rx = Math.min(x, W - 1 - x);
  const ry = Math.min(y, H - 1 - y);
  if (rx >= radius || ry >= radius) return true;            // straight edges
  const dx = radius - rx, dy = radius - ry;
  return dx * dx + dy * dy <= radius * radius;              // rounded corner
}

// lerp between two #rgb arrays
const lerp = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const C_LIGHT = [230, 200, 90];  // #e6c85a light gold
const C_MID = [212, 175, 55];    // #d4af37 gold
const C_DARK = [122, 94, 24];    // #7a5e18 bronze
const maxD = Math.hypot(W, H);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (!inRoundRect(x, y)) continue; // transparent outside

    const d = Math.hypot(x - lightX, y - lightY) / maxD; // 0..~1
    const t = Math.min(1, d * 1.7);
    const col = t < 0.5 ? lerp(C_LIGHT, C_MID, t / 0.5) : lerp(C_MID, C_DARK, (t - 0.5) / 0.5);
    px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
  }
}

// white play triangle (the "make a clip" mark), centered-ish
const triCx = W * 0.46, triCy = H * 0.5, triH = 150;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const ry = y - triCy;
    if (Math.abs(ry) > triH / 2) continue;
    const frac = (ry + triH / 2) / triH;           // 0 at top, 1 at bottom
    const halfW = (triH / 2) * (1 - Math.abs(0.5 - frac) * 2); // pointer right
    const left = triCx - triH * 0.30;
    const right = left + (triH * 0.85) * (1 - Math.abs(ry) / (triH / 2));
    if (x >= left && x <= right) {
      const i = (y * W + x) * 4;
      if (px[i + 3] === 255) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }
    }
  }
}

// encode PNG (RGBA, filter 0 per row)
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
