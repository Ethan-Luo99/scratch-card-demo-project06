// §7.4-4 / §0 / R11：自管离屏 coatCanvas 的创建与铺底。
// coatCanvas 尺寸恒为 cssW*dpr × cssH*dpr（物理像素），ctx 基础变换恒为单位阵。

/**
 * §4.3：以 crossOrigin='anonymous' 预加载涂层图案；任何失败都 reject，
 * 由调用方降级为纯色涂层（图案挂掉不允许拖垮组件）。
 * @returns {Promise<HTMLImageElement>}
 */
export function loadPatternImage(imageUrl) {
  return new Promise((resolve, reject) => {
    if (!imageUrl) {
      reject(new Error('empty imageUrl'));
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`coat image load failed: ${imageUrl}`));
    img.src = imageUrl;
  });
}

/**
 * 按 fit 策略把图案画满目标 ctx（R11：cover 默认，无接缝；fill 拉伸；contain 留边填色）。
 * 调用时 ctx 必须为单位变换。
 */
function paintImage(ctx, img, W, H, fit, color) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (fit === 'fill') {
    ctx.drawImage(img, 0, 0, W, H);
    return;
  }
  const scale =
    fit === 'contain'
      ? Math.min(W / iw, H / ih)
      : Math.max(W / iw, H / ih); // cover
  const dw = iw * scale;
  const dh = ih * scale;
  if (fit === 'contain') {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/**
 * 新建一张铺满涂层的离屏 canvas。
 * @returns {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D}}
 */
export function createCoatCanvas({ cssW, cssH, dpr, patternImage, color, fit }) {
  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  // ctx 基础变换恒为单位阵（§7.3）；所有绘制均在物理像素空间。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (patternImage) {
    paintImage(ctx, patternImage, W, H, fit, color);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, H);
  }
  return { canvas, ctx };
}
