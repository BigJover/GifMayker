// Generates a simple tray icon (assets/tray.png) with zero dependencies.
// A filled gold circle with soft antialiased edges, 32x32 RGBA PNG.
// Run with: npm run icon
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const W = 32, H = 32;
const px = Buffer.alloc(W * H * 4);
const cx = (W - 1) / 2, cy = (H - 1) / 2, r = 14;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = Math.hypot(x - cx, y - cy);
    if (d <= r) {
      px[i] = 212; px[i + 1] = 175; px[i + 2] = 55;        // #d4af37 gold
      px[i + 3] = d > r - 1 ? Math.round(255 * (r - d)) : 255; // edge AA
    } // else fully transparent (already zeroed)
  }
}

// Raw scanlines: each row prefixed with filter-type byte 0.
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw);

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, dataBuf) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(dataBuf.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, dataBuf])), 0);
  return Buffer.concat([len, t, dataBuf, crc]);
};

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type: RGBA
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
