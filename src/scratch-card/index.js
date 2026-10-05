// 刮刮卡组件（路线 A：自管离屏 coatCanvas + Fabric 仅作渲染器）
// 严格遵循 docs/scratch-card-design.md：§7 实现契约 / §3 面积统计 / §4 边界清单。
//
// 【硬性约束（§7.3）—— 编号与文档逐条对应】
//   约束1：涂层 FabricImage 永不加 clipPath / shadow / 滤镜 / 进 Group。
//   约束2：擦除只发生在 coatCtx；禁止在 Fabric 拥有的 lower/upper ctx 上手画。
//   约束3：尺寸变更只走 fabricCanvas.setDimensions；禁止手改 Fabric canvas 的
//          width/height 属性与 style。
//   约束4：一切坐标换算只经过 dpr = fabricCanvas.getRetinaScaling() 一个因子，
//          不引入 viewportTransform（本场景 viewportTransform 恒为单位阵）。
//   约束5：complete 只在状态机 scratching -> revealed 迁移处触发一次。
//   约束6：涂层 FabricImage 的 width/height 恒为 CSS 逻辑宽高（其元素
//          coatCanvas 自身是物理像素尺寸）。

import { Canvas, FabricImage, config } from 'fabric';
import {
  interpolatePoints,
  clampPoint,
  createProgressMachine,
  createRafScheduler,
  computeStep,
  sampleScratchedRatio,
  fitRect,
} from './core.js';

const DEFAULT_BRUSH_SIZE = 28; // CSS px
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_DPR_CAP = 2;
const DEFAULT_COAT_COLOR = '#c0c0c0';
const REVEAL_FADE_MS = 250;

function loadImage(url, { crossOrigin = true, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous'; // §4.3：防 origin-tainted
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok ? img : null);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

export async function createScratchCard(options = {}) {
  const {
    el,
    width,
    height,
    prizeImage,
    coat: coatConfig = {},
    brushSize = DEFAULT_BRUSH_SIZE,
    threshold = DEFAULT_THRESHOLD,
    dprCap = DEFAULT_DPR_CAP,
    onProgress,
    onComplete,
    onReset,
    onCoatRestored,
  } = options;

  if (!el) throw new Error('createScratchCard: el 为必传的 <canvas> 元素');
  // Fabric 构造会把 canvas 包进 .canvas-container，先保存外部宿主用于 ResizeObserver。
  const host = el.parentElement;
  let cssW = Math.round(width);
  let cssH = Math.round(height);
  if (!cssW || !cssH) throw new Error('createScratchCard: width/height 必须为正数');

  const coatType = coatConfig.type || 'image';
  const coatColor = coatConfig.color || DEFAULT_COAT_COLOR;
  const coatImageUrl = coatConfig.imageUrl;
  const coatFit = coatConfig.fit || 'cover';

  // §7.4-1：config.devicePixelRatio 封顶必须在 new Canvas 之前。
  config.devicePixelRatio = Math.min(
    typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1,
    dprCap,
  );

  // §7.4-2：new Canvas（背景透明、关闭选中、开启 retina）。
  const fabricCanvas = new Canvas(el, {
    width: cssW,
    height: cssH,
    backgroundColor: '',
    preserveObjectStacking: true,
    enableRetinaScaling: true,
    selection: false,
    renderOnAddRemove: true,
  });
  fabricCanvas.set({ allowTouchScrolling: false }); // §4.1：刮擦时不滚动

  // §7.1 奖品层是宿主内的 DOM <img>，由组件按入参 prizeImage 赋 src（Fabric 场景不含它）。
  if (prizeImage && host) {
    const prizeEl = host.querySelector('img.prize');
    if (prizeEl && !prizeEl.src) prizeEl.src = prizeImage;
  }

  // dpr 与 Fabric 取同一个值（§2.3 匹配性检查），不各自读 window.devicePixelRatio。
  let dpr = fabricCanvas.getRetinaScaling();

  // §7.2 内部状态字段。
  let coatCanvas = null;
  let coatCtx = null;
  let coatImage = null;
  let patternImage = null; // 涂层图案（crossOrigin anonymous）；null 表示纯色
  let patternLoadFailed = false;
  let lastPoint = null; // 物理像素
  let drawing = false;
  let needsMeasure = false;
  let ratio = 0;
  let step = 8;
  let disposed = false;
  let revealAnim = null;

  const machine = createProgressMachine({
    threshold,
    onProgress: (r) => safeCallback(onProgress, r),
    onComplete: handleReveal,
  });
  // §7.5/R10：reset/destroy 自增 generation，挂起 rAF 内 token 不匹配即作废。
  const scheduler = createRafScheduler();

  function safeCallback(fn, arg) {
    if (disposed) return;
    try {
      fn && fn(arg);
    } catch (err) {
      console.error('[scratch-card] callback error:', err);
    }
  }

  // ---------- 涂层位图（coatCanvas：物理像素空间，ctx 基础变换恒为单位阵） ----------

  function createCoatCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    return canvas;
  }

  // 铺底：纯色或按 fit 画图案；调用方保证 ctx 为单位变换。
  function paintCoatBase(ctx, w, h) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (coatType === 'image' && patternImage && !patternLoadFailed) {
      // R11：cover 裁切铺满，不留缝不 repeat；fill 拉伸；contain 露出底色。
      const rect = fitRect(patternImage.naturalWidth, patternImage.naturalHeight, w, h, coatFit);
      if (coatFit === 'contain') {
        ctx.fillStyle = coatColor;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        patternImage,
        rect.sx, rect.sy, rect.sw, rect.sh,
        rect.dx, rect.dy, rect.dw, rect.dh,
      );
    } else {
      ctx.fillStyle = coatColor;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // ---------- §3.2 擦除（约束2：destination-out 只出现在 coatCtx） ----------

  function strokeSegment(a, b) {
    const ctx = coatCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out'; // 约束2：仅 coatCtx
    ctx.strokeStyle = '#000'; // 颜色任意，destination-out 只取 alpha
    ctx.lineWidth = brushSize * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // §4.2：CSS px 场景坐标 -> 物理像素（约束4：只乘 getRetinaScaling()），再夹取。
  function toPhysical(scenePoint) {
    const p = { x: scenePoint.x * dpr, y: scenePoint.y * dpr };
    const margin = (brushSize * dpr) / 2;
    return clampPoint(p, coatCanvas.width, coatCanvas.height, margin);
  }

  // ---------- §3.1 面积统计 ----------

  function measureRatio() {
    if (machine.getState() === 'revealed') return ratio;
    const result = sampleScratchedRatio(coatCtx, coatCanvas.width, coatCanvas.height, step);
    // §4.3 旧版 WebKit 防御：全部采样点 alpha 全等且涂层并非"完整/全空"时丢弃本次结果。
    if (
      result.uniformAlpha !== null &&
      result.uniformAlpha >= 16 &&
      result.uniformAlpha < 250
    ) {
      return ratio; // 可疑的全 0/异常 readback，沿用上一次
    }
    ratio = result.ratio;
    return ratio;
  }

  function frameTick() {
    if (disposed) return;
    if (needsMeasure) {
      needsMeasure = false;
      fabricCanvas.requestRenderAll();
      measureAndFeed();
    }
  }

  function measureAndFeed() {
    const r = measureRatio();
    machine.feed(r); // §3.3：onProgress/onComplete 都由状态机统一发
  }

  function scheduleFrame() {
    needsMeasure = true;
    scheduler.schedule(frameTick); // §7.5：一帧至多统计一次
  }

  // ---------- §3.3 complete：仅在状态机迁移处触发（约束5） ----------

  function handleReveal() {
    if (disposed) return;
    drawing = false; // 停掉输入
    // §7.5：涂层 FabricImage 一次 250ms 淡出，避免最后一笔后画面跳变。
    revealAnim = coatImage.animate(
      { opacity: 0 },
      {
        duration: REVEAL_FADE_MS,
        onChange: () => fabricCanvas.requestRenderAll(),
        onComplete: () => {
          revealAnim = null;
          fabricCanvas.requestRenderAll();
        },
      },
    );
    safeCallback(onComplete); // 约束5：onComplete 只可能在此触发一次
  }

  // ---------- §4.1/§4.2 指针（v7 mouse:* 已做单主指过滤与 document 级越界追踪） ----------

  function onMouseDown(e) {
    if (disposed || machine.getState() === 'revealed') return;
    drawing = true;
    const p = toPhysical(e.scenePoint);
    lastPoint = p;
    // AC13：纯点击也出一个直径≈笔宽的圆洞。
    strokeSegment(p, { x: p.x + 0.01, y: p.y + 0.01 });
    scheduleFrame();
  }

  function onMouseMove(e) {
    if (!drawing || machine.getState() === 'revealed') return;
    const cur = toPhysical(e.scenePoint);
    const prev = lastPoint || cur;
    // §3.2：80px 跳变下按 <= 一个半径线性插值补点，段段圆头重叠无断点。
    const maxSeg = (brushSize * dpr) / 2;
    const points = interpolatePoints(prev, cur, maxSeg);
    let from = prev;
    for (const to of points) {
      strokeSegment(from, to);
      from = to;
    }
    lastPoint = cur;
    scheduleFrame();
  }

  function finishStroke() {
    // §7.2/R9：mouse:up / pointercancel / blur 共用的强制收尾。
    if (!drawing) return;
    drawing = false;
    lastPoint = null;
    needsMeasure = false;
    measureAndFeed(); // §7.5：抬手后立即补算，不等 rAF
  }

  function onMouseUp() {
    finishStroke();
  }

  // ---------- §4.5 resize：刮痕等比重映射 ----------

  function remapCoat(nextCssW, nextCssH, nextDpr) {
    const oldCanvas = coatCanvas;
    const W0 = oldCanvas.width;
    const H0 = oldCanvas.height;
    const W1 = Math.round(nextCssW * nextDpr);
    const H1 = Math.round(nextCssH * nextDpr);

    // §4.5-1：新建空物理缓冲（dpr 可能已变）。
    const next = document.createElement('canvas');
    next.width = W1;
    next.height = H1;
    const nctx = next.getContext('2d', { willReadFrequently: true });
    // §4.5-2：先铺完整新涂层底图。
    paintCoatBase(nctx, W1, H1);
    // §4.5-3：destination-out 把旧 coat 等比缩放画出，旧洞映射到新缓冲。
    nctx.save();
    nctx.setTransform(1, 0, 0, 1, 0, 0);
    nctx.globalCompositeOperation = 'destination-out';
    nctx.imageSmoothingEnabled = true;
    nctx.drawImage(oldCanvas, 0, 0, W0, H0, 0, 0, W1, H1);
    nctx.restore();

    coatCanvas = next;
    coatCtx = nctx;
    // §4.5-4：约束6 —— setElement 必传 CSS 逻辑宽高；约束3 —— 尺寸只走 setDimensions。
    coatImage.setElement(next, { width: nextCssW, height: nextCssH }); // 约束6
    fabricCanvas.setDimensions({ width: nextCssW, height: nextCssH }); // 约束3
    fabricCanvas.requestRenderAll();
    // §4.5-5：立即 measure 校准，状态机保持原 state 不变。
    step = computeStep(W1 * H1);
    measureAndFeed();
    cssW = nextCssW;
    cssH = nextCssH;
  }

  // §4.5：ResizeObserver（rAF 去抖）。Fabric 自身 window resize 仅 calcOffset。
  let resizeRaf = 0;
  function onResize() {
    if (disposed || !host) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (disposed) return;
      const rect = host.getBoundingClientRect();
      const nextCssW = Math.round(rect.width);
      const nextCssH = Math.round(rect.height);
      const nextDpr = fabricCanvas.getRetinaScaling();
      if (
        (nextCssW === cssW && nextCssH === cssH && nextDpr === dpr) ||
        nextCssW <= 0 ||
        nextCssH <= 0
      ) {
        return;
      }
      dpr = nextDpr;
      remapCoat(nextCssW, nextCssH, nextDpr);
    });
  }

  // ---------- §4.4 后台回收导致 coat 位图丢失的像素探测 ----------

  function detectAndRestoreCoat() {
    if (disposed || !coatCtx) return;
    fabricCanvas.requestRenderAll(); // Fabric 侧丢失由 renderAll 自愈
    if (machine.getState() === 'revealed') return;
    // 涂层非全空（刮过但未揭底）时，若读到全透明即判定 coat 被系统清空。
    if (ratio <= 0.001) return;
    const probe = coatCtx.getImageData(0, 0, coatCanvas.width, coatCanvas.height).data;
    let opaque = 0;
    for (let i = 3; i < probe.length; i += 4 * 64) {
      if (probe[i] >= 16) opaque += 1;
    }
    if (opaque > 0) return; // 像素仍在
    // §4.4 决策：不持久化刮痕形状，重新铺完整涂层让用户重刮，并通知业务层。
    const fresh = createCoatCanvas();
    const fctx = fresh.getContext('2d');
    paintCoatBase(fctx, fresh.width, fresh.height);
    coatCanvas = fresh;
    coatCtx = fctx;
    coatImage.setElement(fresh, { width: cssW, height: cssH }); // 约束6
    coatImage.set({ opacity: 1 });
    drawing = false;
    lastPoint = null;
    ratio = 0;
    machine.reset();
    fabricCanvas.requestRenderAll();
    safeCallback(onCoatRestored);
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') detectAndRestoreCoat();
  }
  function onPageShow() {
    detectAndRestoreCoat();
  }

  // ---------- §7.5 reset / §7.2 destroy ----------

  function rebuildCoat() {
    const fresh = createCoatCanvas();
    const fctx = fresh.getContext('2d');
    paintCoatBase(fctx, fresh.width, fresh.height);
    coatCanvas = fresh;
    coatCtx = fctx;
    return fresh;
  }

  function reset() {
    if (disposed) return;
    scheduler.bump(); // generation 自增：所有挂起 rAF 立即作废（R10）
    drawing = false;
    lastPoint = null;
    needsMeasure = false;
    ratio = 0;
    if (revealAnim) {
      revealAnim.abort();
      revealAnim = null;
    }
    machine.reset(); // state -> idle
    const fresh = rebuildCoat();
    // §7.5：setElement 必传 CSS 逻辑宽高（约束6），opacity 归 1。
    coatImage.setElement(fresh, { width: cssW, height: cssH });
    coatImage.set({ opacity: 1 });
    step = computeStep(fresh.width * fresh.height);
    fabricCanvas.requestRenderAll();
    safeCallback(onReset);
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    scheduler.bump();
    scheduler.cancel();
    cancelAnimationFrame(resizeRaf);
    if (resizeObserver) resizeObserver.disconnect();
    fabricCanvas.off('mouse:down', onMouseDown);
    fabricCanvas.off('mouse:move', onMouseMove);
    fabricCanvas.off('mouse:up', onMouseUp);
    window.removeEventListener('pointercancel', finishStroke);
    window.removeEventListener('blur', finishStroke);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
    if (revealAnim) {
      revealAnim.abort();
      revealAnim = null;
    }
    coatCanvas = null;
    coatCtx = null;
    patternImage = null;
    return fabricCanvas.dispose(); // v7 公开销毁入口
  }

  function getRatio() {
    return ratio;
  }

  // ---------- 监听器 ----------

  const resizeObserver =
    typeof ResizeObserver !== 'undefined' && host
      ? new ResizeObserver(onResize)
      : null;
  window.addEventListener('pointercancel', finishStroke, { passive: true }); // R9
  window.addEventListener('blur', finishStroke); // R9
  document.addEventListener('visibilitychange', onVisibilityChange); // §4.4
  window.addEventListener('pageshow', onPageShow); // §4.4
  fabricCanvas.on('mouse:down', onMouseDown); // §4.1：主触摸由 v7 过滤
  fabricCanvas.on('mouse:move', onMouseMove);
  fabricCanvas.on('mouse:up', onMouseUp);

  // ---------- §7.4 初始化顺序 ----------

  // §7.4-3：预加载涂层图案，成功与否都继续（失败降级纯色，§4.3/AC12）。
  if (coatType === 'image' && coatImageUrl) {
    patternImage = await loadImage(coatImageUrl);
    if (!patternImage) {
      patternLoadFailed = true;
      console.warn('[scratch-card] 涂层图案加载失败，已降级为纯色涂层:', coatImageUrl);
    }
  }

  // §7.4-4：coatCanvas（backstore = cssW*dpr）并铺底。
  coatCanvas = createCoatCanvas();
  coatCtx = coatCanvas.getContext('2d', { willReadFrequently: true });
  paintCoatBase(coatCtx, coatCanvas.width, coatCanvas.height);
  step = computeStep(coatCanvas.width * coatCanvas.height);

  // §7.4-5：唯一的 Fabric 场景对象（§7.1，对象数恒为 1）。
  //   约束1：无 clipPath / shadow / 滤镜 / Group；
  //   objectCaching:false 双保险（即使误加属性也走直绘路径，见 §2.2 R12）；
  //   约束6：width/height 显式传 CSS 逻辑值；origin 显式 left/top（默认 center 会偏移半幅）。
  coatImage = new FabricImage(coatCanvas, {
    width: cssW,
    height: cssH,
    originX: 'left',
    originY: 'top',
    left: 0,
    top: 0,
    selectable: false,
    evented: false,
    objectCaching: false,
  });

  // §7.4-6：add -> 观察尺寸 -> 首帧渲染。
  fabricCanvas.add(coatImage);
  if (resizeObserver) resizeObserver.observe(host);
  fabricCanvas.requestRenderAll();

  return { reset, destroy, getRatio };
}

export default createScratchCard;
