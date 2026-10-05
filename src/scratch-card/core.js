// 刮刮卡纯逻辑层（无 DOM / 无 fabric 依赖），便于 node:test 单测。
// 对应设计文档：§3.2 插值补点、§3.3 状态机、§3.1 网格降采样、§4.2 越界夹取、
// 以及 §7.5 中 "generation 使挂起 rAF 作废"（R10）的时序要求。

/**
 * §3.2 在相邻两个物理像素点之间做线性插值补点。
 * 相邻绘制点间距不超过 maxSegment（= 物理笔刷半径），round lineCap 段段重叠，
 * 高速滑动（事件点 80px 跳变）也不会出现虚线断洞。
 *
 * @param {{x:number,y:number}} prev 上一物理点
 * @param {{x:number,y:number}} next 当前物理点
 * @param {number} maxSegment 单段最大物理长度（brushR）
 * @returns {Array<{x:number,y:number}>} 从 prev(不含) 到 next(含) 的补点序列
 */
export function interpolatePoints(prev, next, maxSegment) {
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(dist / maxSegment));
  const points = [];
  for (let i = 1; i <= n; i++) {
    points.push({
      x: prev.x + (dx * i) / n,
      y: prev.y + (dy * i) / n,
    });
  }
  return points;
}

/**
 * §4.2 越界坐标夹取：夹到 [-margin, W+margin]（margin=笔半径），
 * 出界段沿画布边缘持续擦除，回滑入时笔迹无缺口。
 */
export function clampPoint(point, width, height, margin) {
  return {
    x: Math.min(width + margin, Math.max(-margin, point.x)),
    y: Math.min(height + margin, Math.max(-margin, point.y)),
  };
}

/**
 * §3.3 刮刮卡状态机：idle -> scratching -> revealed。
 * onComplete 只在 scratching -> revealed 的迁移处触发一次；
 * ratio 反复越过阈值（resize 重采样 ±1% 波动等）也不会重复结算。
 */
export function createProgressMachine({ threshold = 0.7, onProgress, onComplete } = {}) {
  let state = 'idle';

  return {
    getState: () => state,
    /**
     * 每帧 / mouse:up 补算后喂入当前 ratio。
     * @returns {'idle'|'scratching'|'revealed'} 喂入后的状态
     */
    feed(ratio) {
      if (state === 'revealed') return state;
      if (ratio > 0) state = 'scratching';
      onProgress && onProgress(ratio);
      // §3.3：比较用 >= 0.70 真值阈值，回调只可能在该迁移处触发一次
      if (ratio >= threshold) {
        state = 'revealed';
        onComplete && onComplete();
      }
      return state;
    },
    reset() {
      state = 'idle';
    },
  };
}

/**
 * §7.5/R10 代际 rAF 调度器：reset/destroy 自增 generation，
 * 使挂起的 rAF 回调作废，避免写已废弃的 coatCanvas。
 * 允许注入 raf/caf 以便测试。
 */
export function createRafScheduler({ raf, caf } = {}) {
  const requestFrame =
    raf ||
    (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(() => cb(Date.now()), 16));
  const cancelFrame =
    caf ||
    (typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id) => clearTimeout(id));

  let generation = 0;
  let handle = null;

  return {
    getGeneration: () => generation,
    /** 使所有挂起回调作废（不取消其 rAF 句柄，回调内靠 token 自废） */
    bump() {
      generation += 1;
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
    schedule(callback) {
      if (handle !== null) return;
      const token = generation;
      handle = requestFrame(() => {
        handle = null;
        if (token !== generation) return; // R10：当代 token 不匹配，直接作废
        callback();
      });
    },
    cancel() {
      if (handle !== null) {
        cancelFrame(handle);
        handle = null;
      }
    },
  };
}

/**
 * §3.1 自适应网格步长：保证网格点数 >= 4096，步长夹在 [4, 12] 物理像素。
 */
export function computeStep(pixelCount) {
  return Math.max(4, Math.min(12, Math.round(Math.sqrt(pixelCount / 4096))));
}

/**
 * §3.1 网格降采样统计透明比例（"全量拷贝 + 1/STEP 遍历"）。
 * alpha < 16 判透明（抗锯齿边缘按非透明计入）。
 *
 * @returns {{ratio:number, samples:number, transparent:number, uniformAlpha:number|null}}
 *   uniformAlpha 非 null 表示所有采样点 alpha 完全相同（§4.3 健全性校验用）
 */
export function sampleScratchedRatio(ctx, width, height, step) {
  const imageData = ctx.getImageData(0, 0, width, height).data;
  let transparent = 0;
  let samples = 0;
  let uniformAlpha = null;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const alpha = imageData[(y * width + x) * 4 + 3];
      if (uniformAlpha === null) {
        uniformAlpha = alpha;
      } else if (uniformAlpha !== alpha) {
        uniformAlpha = -1; // 标记"非全等"
      }
      if (alpha < 16) transparent += 1;
      samples += 1;
    }
  }
  if (uniformAlpha === -1) uniformAlpha = null;
  return { ratio: samples === 0 ? 0 : transparent / samples, samples, transparent, uniformAlpha };
}

/**
 * §7.2 coat.fit = cover（默认）| contain | fill 的目标矩形计算。
 * cover 裁切铺满（R11，不允许 repeat 接缝）；contain 完整放入（露出底色）；
 * fill 拉伸铺满。
 */
export function fitRect(srcW, srcH, dstW, dstH, fit) {
  if (fit === 'fill') {
    return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: 0, dy: 0, dw: dstW, dh: dstH };
  }
  const scale = fit === 'contain' ? Math.min(dstW / srcW, dstH / srcH) : Math.max(dstW / srcW, dstH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (dstW - dw) / 2;
  const dy = (dstH - dh) / 2;
  return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx, dy, dw, dh };
}
