// §3.1 面积统计：网格降采样读 coatCanvas 的 alpha 通道。
// 统计目标：scratchedRatio = 透明(alpha<16) 采样点数 / 总采样点数。
// 纯逻辑部分（computeStep / ratioFromImageData）无 DOM 依赖，可直接单测。

/**
 * §3.1 自适应步长：保证网格点数 >= 4096，STEP 夹在 [4, 12] 物理像素。
 * STEP = clamp(round(sqrt(N/4096)), 4, 12)
 * @param {number} W 物理宽
 * @param {number} H 物理高
 */
export function computeStep(W, H) {
  const n = W * H;
  return Math.max(4, Math.min(12, Math.round(Math.sqrt(n / 4096))));
}

/**
 * 从 ImageData 的 alpha 通道按 STEP 网格计算透明比例。
 * 同时返回采样元信息与健全性标志（§4.3 iOS 全 0 ImageData 怪癖防御）。
 *
 * @returns {{ratio:number,total:number,cleared:number,uniform:boolean}}
 *   uniform=true 表示所有采样点 alpha 完全相等（可能是系统返回的全 0/全满缓冲）
 */
export function ratioFromImageData(imageData, W, H, step) {
  const data = imageData.data;
  let total = 0;
  let cleared = 0;
  let alpha0 = -1;
  let uniform = true;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const a = data[(y * W + x) * 4 + 3];
      total++;
      if (a < 16) cleared++; // §3.1：α < 16 判透明，抗锯齿边缘按非透明计入
      if (alpha0 === -1) alpha0 = a;
      else if (a !== alpha0) uniform = false;
    }
  }
  return { ratio: total === 0 ? 0 : cleared / total, total, cleared, uniform };
}

/**
 * 对 coatCanvas 执行一次降采样统计。
 * §2.3：必须读自管 coatCanvas（物理像素空间），严禁读 Fabric lower/upper。
 *
 * @param {HTMLCanvasElement} coatCanvas
 * @param {number} step 网格步长（物理像素）
 */
export function measureCoat(coatCanvas, step) {
  const ctx = coatCanvas.getContext('2d');
  const W = coatCanvas.width;
  const H = coatCanvas.height;
  const imageData = ctx.getImageData(0, 0, W, H);
  return ratioFromImageData(imageData, W, H, step);
}
