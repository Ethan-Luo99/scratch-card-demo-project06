// 生成演示用本地占位图（无外部网络图片依赖）。运行：node scripts/generate-assets.mjs
// 输出 PNG：public/prize.png（375×500 奖品图）、public/coat.png（375×500 涂层图）。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'public'), { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 极简 5x7 位图字体（仅覆盖演示需要的 ASCII 字符）。
const FONT = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','11110','10001','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  '!': ['00100','00100','00100','00100','00100','00000','00100'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
};

function drawText(buf, w, text, cx, cy, scale, color) {
  const chars = [...text.toUpperCase()];
  const totalW = chars.length * (5 + 1) * scale - scale;
  let x0 = Math.round(cx - totalW / 2);
  const y0 = Math.round(cy - (7 * scale) / 2);
  for (const ch of chars) {
    const glyph = FONT[ch] || FONT[' '];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gx][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x0 + gx * scale + sx;
            const py = y0 + gy * scale + sy;
            const i = (py * w + px) * 4;
            if (i >= 0 && i + 3 < buf.length) {
              buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = color[3];
            }
          }
        }
      }
    }
    x0 += 6 * scale;
  }
}

function fillRoundRect(buf, w, x, y, rw, rh, rad, color) {
  for (let py = y; py < y + rh; py++) {
    for (let px = x; px < x + rw; px++) {
      const lx = Math.min(px - x, x + rw - 1 - px);
      const ly = Math.min(py - y, y + rh - 1 - py);
      const inside = lx >= rad || ly >= rad || Math.hypot(rad - lx, rad - ly) <= rad;
      if (!inside) continue;
      const i = (py * w + px) * 4;
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = color[3];
    }
  }
}

// 奖品图：金色渐变底 + 礼物文字。
function makePrize(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = y / h;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = 255 - Math.round(30 * t);
      buf[i + 1] = 200 - Math.round(70 * t);
      buf[i + 2] = 60;
      buf[i + 3] = 255;
    }
  }
  fillRoundRect(buf, w, 38, 150, w - 76, 200, 18, [255, 248, 220, 255]);
  drawText(buf, w, 'PRIZE!', w / 2, 215, 8, [180, 120, 20, 255]);
  drawText(buf, w, 'YOU WIN', w / 2, 285, 5, [180, 120, 20, 255]);
  return encodePng(w, h, buf);
}

// 涂层图：银灰底 + "再来一次"风格英文占位（位图字体不含中文，用 TRY AGAIN）。
function makeCoat(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const noise = ((x * 13 + y * 7) % 18) - 9;
      const base = 200 + noise;
      buf[i] = base; buf[i + 1] = base; buf[i + 2] = base + 6; buf[i + 3] = 255;
    }
  }
  fillRoundRect(buf, w, 40, 210, w - 80, 90, 14, [245, 245, 250, 255]);
  drawText(buf, w, 'TRY AGAIN', w / 2, 248, 5, [90, 90, 105, 255]);
  drawText(buf, w, 'SCRATCH HERE', w / 2, 330, 3, [120, 120, 135, 255]);
  return encodePng(w, h, buf);
}

writeFileSync(join(root, 'public/prize.png'), makePrize(375, 500));

// 涂层图用本地生成的 SVG（中文文案由浏览器系统字体渲染）；
// SVG 与页面同源，drawImage 进 canvas 不会造成 origin-tainted（§4.3）。
const coatSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="375" height="500" viewBox="0 0 375 500">
  <defs>
    <linearGradient id="silver" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d8dae0"/>
      <stop offset="0.5" stop-color="#b9bcc6"/>
      <stop offset="1" stop-color="#d2d4db"/>
    </linearGradient>
    <pattern id="grain" width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="transparent"/>
      <circle cx="1" cy="1" r="0.7" fill="#ffffff" opacity="0.25"/>
      <circle cx="4" cy="4" r="0.7" fill="#8a8d99" opacity="0.2"/>
    </pattern>
  </defs>
  <rect width="375" height="500" fill="url(#silver)"/>
  <rect width="375" height="500" fill="url(#grain)"/>
  <rect x="34" y="196" width="307" height="108" rx="14" ry="14"
        fill="#f4f5f8" stroke="#9ea1ac" stroke-width="2"/>
  <text x="187.5" y="262" text-anchor="middle"
        font-family="system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif"
        font-size="40" font-weight="700" fill="#5a5d6b">再来一次</text>
  <text x="187.5" y="338" text-anchor="middle"
        font-family="system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif"
        font-size="18" fill="#7b7e8c">刮开涂层查看奖品</text>
</svg>
`;
writeFileSync(join(root, 'public/coat.svg'), coatSvg);
console.log('generated public/prize.png public/coat.svg');
