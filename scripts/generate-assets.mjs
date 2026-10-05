// 生成本地占位图（无外部网络图片引用、不新增 package.json 依赖）：
//   public/prize.png  375x500 奖品底图（渐变 + 礼盒 + "恭喜中奖"）
//   public/coat.png   375x500 银灰涂层（"再来一次"）
//
// 使用 node-canvas（fabric 的间接依赖，已存在于 node_modules）与本地 OTF 渲染中文。
// 字体不入库（见 scripts/assets/README.md）；仅在缺失时本脚本报错退出，
// 已生成的 public/*.png 可直接随仓库使用。

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const W = 375;
const H = 500;
const here = dirname(fileURLToPath(import.meta.url));
const fontPath = join(here, 'assets', 'NotoSansCJKsc-Regular.otf');

if (!existsSync(fontPath)) {
  console.error('[generate-assets] 缺少字体 scripts/assets/NotoSansCJKsc-Regular.otf');
  console.error('请按 scripts/assets/README.md 下载后重试。');
  process.exit(1);
}

const { createCanvas, registerFont } = require('canvas');
registerFont(fontPath, { family: 'NotoScratch' });

function centerText(ctx, text, y, size, color, weight = 'normal') {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "NotoScratch", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, y);
}

function renderPrize() {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#8e5cf0');
  grad.addColorStop(0.55, '#d6419f');
  grad.addColorStop(1, '#f2486b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // 装饰圆点
  for (const [x, y, r, a] of [
    [40, 60, 6, 0.35], [320, 90, 9, 0.3], [60, 420, 8, 0.25],
    [330, 430, 6, 0.35], [200, 40, 4, 0.3], [120, 470, 5, 0.25],
  ]) {
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  centerText(ctx, '恭喜中奖', 96, 52, '#ffffff', 'bold');

  // 礼盒
  ctx.fillStyle = '#ffe9b0';
  ctx.fillRect(118, 232, 140, 124);
  ctx.fillStyle = '#ffd98c';
  ctx.fillRect(106, 200, 164, 34);
  ctx.fillStyle = '#e1466f';
  ctx.fillRect(176, 200, 24, 156);
  ctx.fillRect(106, 272, 164, 22);
  // 蝴蝶结
  ctx.beginPath();
  ctx.ellipse(168, 182, 18, 14, -0.3, 0, Math.PI * 2);
  ctx.ellipse(208, 182, 18, 14, 0.3, 0, Math.PI * 2);
  ctx.fillStyle = '#e1466f';
  ctx.fill();
  ctx.fillStyle = '#c02f57';
  ctx.beginPath();
  ctx.arc(188, 184, 10, 0, Math.PI * 2);
  ctx.fill();

  centerText(ctx, 'iPhone 17 Pro 一台', 420, 22, 'rgba(255,255,255,0.95)');
  return canvas.toBuffer('image/png');
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderCoat() {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 银灰金属涂层：斜向明暗条纹
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x += 6) {
      const band = (x + y) % 24 < 12;
      ctx.fillStyle = band ? '#d2d4d8' : '#c4c6cc';
      ctx.fillRect(x, y, 6, 1);
    }
  }
  // 纵向轻渐变增加立体质感
  const vgrad = ctx.createLinearGradient(0, 0, 0, H);
  vgrad.addColorStop(0, 'rgba(255,255,255,0.28)');
  vgrad.addColorStop(0.5, 'rgba(255,255,255,0)');
  vgrad.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = vgrad;
  ctx.fillRect(0, 0, W, H);

  // 中央文字底卡
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  roundedRect(ctx, 48, 176, W - 96, 148, 18);
  ctx.fill();

  centerText(ctx, '再来一次', H / 2, 56, '#5f6370', 'bold');
  centerText(ctx, '刮开查看奖品', 320, 20, '#7a7e8a');
  return canvas.toBuffer('image/png');
}

const outDir = join(here, '..', 'public');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'prize.png'), renderPrize());
writeFileSync(join(outDir, 'coat.png'), renderCoat());
console.log('generated public/prize.png and public/coat.png');
