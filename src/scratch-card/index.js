// 刮刮卡组件 —— 严格按 docs/scratch-card-design.md 实现。
// 路线 A（文档 §0）：奖品层为 DOM <img>；Fabric 场景恒为 1 个涂层 FabricImage，
// 其元素是自管离屏 coatCanvas；所有擦除只在 coatCtx 上以 destination-out 完成。

import { Canvas, FabricImage, config } from 'fabric';
import { clampPoint, interpolatePoints } from './geometry.js';
import { createStateMachine } from './state.js';
import { createFrameBatcher } from './frame.js';
import { computeStep, measureCoat } from './measure.js';
import { createCoatCanvas, loadPatternImage } from './coat.js';
import {
  sharedRegistry,
  resolveDevicePixelRatio,
  exposeInternals,
  removeInternals,
} from './registry.js';

// §7.3 六条硬性约束在本文件中的对应位置：
//   约束1 涂层对象禁 clipPath/shadow/滤镜/Group —— buildCoatImage()
//   约束2 擦除只发生在 coatCtx —— strokeSegment()
//   约束3 尺寸变更只走 fabricCanvas.setDimensions —— relayout()
//   约束4 坐标换算只乘 getRetinaScaling() —— toPhysical()
//   约束5 complete 只在状态机迁移处触发一次 —— state.js feed() / revealAll()
//   约束6 涂层 FabricImage 宽高恒为 CSS 逻辑值 —— buildCoatImage()/reset()/relayout()

function defaultCoatOptions(coat = {}) {
  return {
    type: coat.type === 'color' ? 'color' : 'image',
    color: coat.color ?? '#c0c0c0',
    imageUrl: coat.imageUrl ?? '',
    fit: coat.fit ?? 'cover',
  };
}

/**
 * §7.2 组件 API（定案，签名/返回值不得变更）：
 * createScratchCard({
 *   el, width, height, prizeImage,
 *   coat: { type, color, imageUrl, fit },
 *   brushSize = 28, threshold = 0.70, dprCap = 2,
 *   onProgress, onComplete, onReset, onCoatRestored,
 * }) -> { reset(), destroy(), getRatio() }
 */
export function createScratchCard(options) {
  const {
    el,
    width,
    height,
    prizeImage,
    brushSize = 28,
    threshold = 0.7,
    dprCap = 2,
    onProgress,
    onComplete,
    onReset,
    onCoatRestored,
  } = options;
  const coatOpts = defaultCoatOptions(options.coat);

  if (!el || el.tagName !== 'CANVAS') {
    throw new Error('createScratchCard: el 必须是一个 <canvas> 元素');
  }

  // 多实例：登记到全页共享注册表，dpr 决策据此取存活实例 cap 的最大值。
  const instanceId = sharedRegistry.register(dprCap);

  const state = createStateMachine({ threshold, onProgress, onComplete });
  const batcher = createFrameBatcher();

  // §7.3 内部状态字段
  let dpr = 1;
  let cssW = width;
  let cssH = height;
  let coatCanvas = null;
  let coatCtx = null;
  let coatImage = null;
  let patternImage = null; // HTMLImageElement（crossOrigin anonymous），null=纯色
  let fabricCanvas = null;
  let lastPoint = null; // 物理像素
  let drawing = false;
  let needsMeasure = false;
  let currentRatio = 0;
  let destroyed = false;
  let revealAnim = null;
  let resizeRafId = 0;
  let prizeImageEl = null;

  // 约束4：一切 CSS px -> 物理 px 的换算只有 dpr 这一个因子
  // （dpr 恒取 fabricCanvas.getRetinaScaling()，不引入 viewportTransform）。
  function toPhysical(scenePoint) {
    return { x: scenePoint.x * dpr, y: scenePoint.y * dpr };
  }

  function physicalSize() {
    return { W: coatCanvas.width, H: coatCanvas.height };
  }

  // 约束2：destination-out 只允许出现在 coatCtx；
  // 严禁在 fabric 拥有的 lower/upper ctx 上手画（§2.4）。
  function strokeSegment(a, b) {
    const radius = (brushSize * dpr) / 2; // 物理半径
    coatCtx.save();
    // 每次显式重置变换，保证 ctx 基础变换恒为单位阵（§7.3）。
    coatCtx.setTransform(1, 0, 0, 1, 0, 0);
    coatCtx.globalCompositeOperation = 'destination-out';
    coatCtx.strokeStyle = '#000'; // 颜色任意，destination-out 只取 alpha
    coatCtx.lineWidth = radius * 2;
    coatCtx.lineCap = 'round';
    coatCtx.lineJoin = 'round';
    coatCtx.beginPath();
    coatCtx.moveTo(a.x, a.y);
    coatCtx.lineTo(b.x, b.y);
    coatCtx.stroke();
    coatCtx.restore();
  }

  // §3.2：上一点 -> 当前点按 <= brushR 插值补点，逐段画连续粗线。
  function eraseTo(target) {
    const { W, H } = physicalSize();
    const margin = (brushSize * dpr) / 2;
    const maxSegment = margin; // MAX_SEG = brushR
    const points = interpolatePoints(lastPoint, target, maxSegment);
    let prev = lastPoint;
    for (const raw of points) {
      // §4.2：越界坐标只做"夹取用于绘制、不用于状态"。
      const q = clampPoint(raw, W, H, margin);
      strokeSegment(prev, q);
      prev = q;
    }
  }

  function getStep() {
    const { W, H } = physicalSize();
    return computeStep(W, H);
  }

  // §3.1 面积统计：网格降采样读 coatCanvas alpha；
  // §4.3：健全性校验 —— 全均匀缓冲疑似 iOS 全 0 readback 时丢弃本次结果。
  function measureNow() {
    if (!coatCanvas || state.getState() === 'revealed') return currentRatio;
    let result;
    try {
      result = measureCoat(coatCanvas, getStep());
    } catch (err) {
      // §4.3 R1：SecurityError 等读回失败不允许打断交互，沿用上一次结果。
      console.warn('[scratch-card] measure failed:', err);
      return currentRatio;
    }
    if (result.uniform && result.cleared === 0) {
      // 采样全不透明且完全均匀：初始满涂层的合法状态，ratio 确为 0。
      currentRatio = 0;
    } else if (result.uniform && result.cleared === result.total) {
      // §4.3：全透明且完全均匀，既可能是真刮净，也可能是 iOS 旧版 WebKit
      // 在 GPU 繁忙时返回的全 0 ImageData。单帧内笔宽有限，ratio 不可能从
      // <0.9 跳到 1：出现这种跳变即判定 readback 失真，丢弃本次沿用上一次。
      if (currentRatio >= 0.9) currentRatio = 1;
    } else {
      currentRatio = result.ratio;
    }
    needsMeasure = false;
    state.feed(currentRatio);
    return currentRatio;
  }

  function scheduleFrame() {
    needsMeasure = true;
    const gen = batcher.currentGeneration();
    batcher.schedule(() => {
      if (destroyed) return;
      // §7.5：同帧先渲染、帧末 measure（fabric requestRenderAll 自身也按帧合帧）。
      fabricCanvas.requestRenderAll();
      if (needsMeasure) measureNow();
    }, gen);
  }

  // ---------- 涂层对象 / 重建 ----------

  // 约束1：涂层 FabricImage 永不得加 clipPath/shadow/滤镜/进 Group。
  // origin 显式 left/top；objectCaching:false 双保险走直绘路径（§2.2）。
  //
  // 约束6（v7.4.0 实测修正版）：涂层【对象在场景中的占地】恒等于 CSS 逻辑宽高。
  // 关键实现细节（与文档 §7.4 文字结论不同，已在 fabric@7.4.0 + dpr=2 真机式
  // 无头浏览器中逐像素验证）：FabricImage._renderFill 会把元素按对象 width/height
  // drawImage 到对象坐标系，随后主 ctx 再乘一次 getRetinaScaling()。若元素是
  // cssW*dpr 的物理缓冲而对象 width 传 cssW，内容会被二次放大 dpr 倍（洞位翻倍、
  // 只显示左上 1/dpr 区域）。正确映射为：
  //   元素 coatCanvas 尺寸 = cssW*dpr（物理，擦除/统计的像素真值在此）
  //   对象 width/height  = cssW*dpr（drawImage 源与目标 1:1，不缩放、不模糊）
  //   对象 scaleX/Y      = 1/dpr（对象场景占地 = cssW*dpr*(1/dpr) = cssW 逻辑值）
  // 这样物理像素与屏幕像素一一对应，约束6 的"恒为 CSS 逻辑值（占地）"成立。
  function buildCoatImage(canvas) {
    const img = new FabricImage(canvas, {
      width: canvas.width,
      height: canvas.height,
      originX: 'left',
      originY: 'top',
      left: 0,
      top: 0,
      scaleX: 1 / dpr,
      scaleY: 1 / dpr,
      selectable: false,
      evented: false,
      objectCaching: false, // 双保险：即使误加属性也走直绘路径（§2.2）
    });
    return img;
  }

  // 统一换源：新 coat 物理缓冲 -> 更新元素/对象物理宽高，并保持 1/dpr 缩放，
  // 使对象场景占地始终 = CSS 逻辑宽高（约束6）。用于 reset / resize / 丢失恢复。
  function swapCoatElement(nextCanvas) {
    coatImage.setElement(nextCanvas, {
      width: nextCanvas.width,
      height: nextCanvas.height,
    });
    coatImage.set({ scaleX: 1 / dpr, scaleY: 1 / dpr });
  }

  function makeFreshCoat() {
    return createCoatCanvas({
      cssW,
      cssH,
      dpr,
      patternImage,
      color: coatOpts.color,
      fit: coatOpts.fit,
    });
  }

  // §3.3：一次性淡出揭开；revealed 为终态，期间输入由处理函数短路。
  function revealAll() {
    drawing = false;
    if (!coatImage) return;
    if (revealAnim) revealAnim.opacity?.abort();
    revealAnim = coatImage.animate(
      { opacity: 0 },
      {
        duration: 250,
        easing: (t) => t,
        onChange: () => fabricCanvas.requestRenderAll(),
        onComplete: () => {
          if (destroyed || state.getState() !== 'revealed') return;
          // 淡出结束可选 remove；像素真值仍保留在 coatCanvas（已近全透）。
          if (coatImage && fabricCanvas) {
            fabricCanvas.remove(coatImage);
            fabricCanvas.requestRenderAll();
          }
        },
      },
    );
  }

  // ---------- 事件处理 ----------

  function onMouseDown(opt) {
    if (state.getState() === 'revealed') return; // §3.3 停输入
    if (drawing) return;
    drawing = true;
    const p = toPhysical(opt.scenePoint);
    const { W, H } = physicalSize();
    lastPoint = clampPoint(p, W, H, (brushSize * dpr) / 2);
    // §3.2：点一下也出圆洞（画一条 0.1 物理 px 的极短段，round cap 成圆）。
    strokeSegment(lastPoint, { x: lastPoint.x + 0.1, y: lastPoint.y });
    scheduleFrame();
  }

  function onMouseMove(opt) {
    if (!drawing || state.getState() === 'revealed') return;
    const cur = toPhysical(opt.scenePoint);
    const { W, H } = physicalSize();
    const target = clampPoint(cur, W, H, (brushSize * dpr) / 2);
    eraseTo(target);
    lastPoint = target;
    scheduleFrame(); // 每 move 至多挂一帧 requestRenderAll + measure（§7.5）
  }

  function endStroke() {
    if (!drawing) return;
    drawing = false;
    lastPoint = null;
    measureNow(); // §7.5：mouse:up 后立即补算，不等 rAF
  }

  function onMouseUp() {
    endStroke();
  }

  // §4.2 / R9：window 上强制收尾一笔，防止 drawing 卡 true。
  function onPointerCancel() {
    endStroke();
  }
  function onWindowBlur() {
    endStroke();
  }

  // §4.4：回到前台做涂层丢失探测；丢失则重铺完整涂层并回调 onCoatRestored。
  function probeCoatLoss() {
    if (destroyed || !coatCanvas || !coatCtx) return;
    if (document.visibilityState !== 'visible') return;
    fabricCanvas.requestRenderAll(); // Fabric 自身丢失由 renderAll 自愈
    if (state.getState() === 'revealed') return; // 已揭开保持揭开
    const { W, H } = physicalSize();
    let lost = false;
    try {
      // 探测网格：非空涂层若所有采样 alpha 均为 0 即判定位图丢失。
      const sample = coatCtx.getImageData(0, 0, W, H);
      const step = computeStep(W, H);
      let seen = 0;
      let opaque = 0;
      for (let y = 0; y < H; y += step) {
        for (let x = 0; x < W; x += step) {
          seen++;
          if (sample.data[(y * W + x) * 4 + 3] >= 16) opaque++;
        }
      }
      // 涂层确认非空 = 尚未刮满；上一次 ratio < 0.99 时理应存在不透明像素。
      lost = seen > 0 && opaque === 0 && currentRatio < 0.99;
    } catch (err) {
      console.warn('[scratch-card] coat loss probe failed:', err);
      return;
    }
    if (lost) {
      const fresh = makeFreshCoat();
      coatCanvas = fresh.canvas;
      coatCtx = fresh.ctx;
      swapCoatElement(coatCanvas); // 约束6：物理宽高 + 1/dpr，场景占地=逻辑值
      coatImage.set({ opacity: 1 });
      fabricCanvas.requestRenderAll();
      currentRatio = 0;
      needsMeasure = false;
      onCoatRestored?.(); // §4.4：coat:restored 业务可提示
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') probeCoatLoss();
  }
  function onPageShow() {
    probeCoatLoss();
  }

  // ---------- §4.5 resize 重映射 ----------

  // 约束3：Fabric 尺寸变更只走 setDimensions；禁止手改 canvas width/style。
  function relayout(nextCssW, nextCssH) {
    if (destroyed) return;
    if (nextCssW === cssW && nextCssH === cssH) return;

    const oldCanvas = coatCanvas;
    const W0 = oldCanvas.width;
    const H0 = oldCanvas.height;

    // 约束4：新 dpr 以当前 getRetinaScaling() 为准（跨屏拖动 dpr 可能变化）。
    // 先更新封顶 dpr（须早于 Fabric 重建 backstore），再走唯一尺寸入口
    // setDimensions（约束3）；coat 重建依赖最终的 dpr/cssW/cssH。
    applyGlobalDpr();
    cssW = nextCssW;
    cssH = nextCssH;
    fabricCanvas.setDimensions({ width: nextCssW, height: nextCssH });
    dpr = fabricCanvas.getRetinaScaling();

    const { canvas: next, ctx: nextCtx } = makeFreshCoat();
    const W1 = next.width;
    const H1 = next.height;
    nextCtx.setTransform(1, 0, 0, 1, 0, 0);
    nextCtx.imageSmoothingEnabled = true;
    // 旧刮痕（透明洞）等比映射到新缓冲：
    nextCtx.globalCompositeOperation = 'destination-out';
    nextCtx.drawImage(oldCanvas, 0, 0, W0, H0, 0, 0, W1, H1);

    // 约束6：换源走统一映射（物理宽高 + 1/dpr），场景占地恒为新 CSS 逻辑值。
    swapCoatElement(next);
    coatCanvas = next;
    coatCtx = nextCtx;
    fabricCanvas.requestRenderAll();

    // §4.5：resize 后立即校准 ratio；状态机保持原 state（去重见 §3.3）。
    needsMeasure = true;
    measureNow();
  }

  function onResizeObserver(entries) {
    if (destroyed) return;
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    const nextW = Math.round(rect.width);
    const nextH = Math.round(rect.height);
    if (nextW <= 0 || nextH <= 0) return;
    // §4.5：ResizeObserver 用 rAF 去抖。
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = 0;
      if (!destroyed) relayout(nextW, nextH);
    });
  }

  // ---------- 对外 API ----------

  // §7.5 reset：generation++ 使挂起 rAF 作废；重建 coatCanvas；state 归 idle。
  function reset() {
    if (destroyed) return;
    batcher.invalidate(); // R10：当代 token 作废，挂起回调不会再写旧 canvas
    drawing = false;
    lastPoint = null;
    needsMeasure = false;
    currentRatio = 0;
    state.reset();

    const fresh = makeFreshCoat();
    coatCanvas = fresh.canvas;
    coatCtx = fresh.ctx;
    if (revealAnim) {
      revealAnim.opacity?.abort();
      revealAnim = null;
    }
    swapCoatElement(coatCanvas); // 约束6：物理宽高 + 1/dpr，场景占地=逻辑值
    coatImage.set({ opacity: 1 });
    // complete 淡出结束时对象可能已被 remove：按需重新加入，场景恒为 1 个对象。
    if (!fabricCanvas.getObjects().includes(coatImage)) {
      fabricCanvas.add(coatImage);
    }
    fabricCanvas.requestRenderAll();
    onReset?.();
  }

  // §7.2 destroy：fabric dispose + 移除自有监听 + 释放引用。
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    // 注册表注销（幂等）：其余实例的 dpr 决策不再计入本实例 cap；
    // 全局 config.devicePixelRatio 不向下回收（理由见 registry.js 注释）。
    sharedRegistry.unregister(instanceId);
    removeInternals(instanceId);
    batcher.destroy();
    if (resizeRafId) {
      cancelAnimationFrame(resizeRafId);
      resizeRafId = 0;
    }
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    resizeObserver?.disconnect();
    fabricCanvas.off({
      'mouse:down': onMouseDown,
      'mouse:move': onMouseMove,
      'mouse:up': onMouseUp,
    });
    fabricCanvas.dispose();
    prizeImageEl?.remove();
    coatCanvas = null;
    coatCtx = null;
    coatImage = null;
    patternImage = null;
    fabricCanvas = null;
    prizeImageEl = null;
  }

  function getRatio() {
    return currentRatio;
  }

  // dpr 全局决策（策略与源码依据见 registry.js 头部注释）：
  // config.devicePixelRatio 是 fabric 模块级全局且被实时读取，多实例无法
  // 各自封顶；统一取 min(window.devicePixelRatio, 存活实例 cap 最大值)，
  // 保证后建实例只会抬升、绝不静默拉低先建实例的 retina 缩放。
  function applyGlobalDpr() {
    config.devicePixelRatio = resolveDevicePixelRatio(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      sharedRegistry.maxDprCap(),
    );
  }

  // ---------- §7.4 初始化（严格按顺序） ----------

  let resizeObserver = null;

  async function init() {
    const host = el.parentElement;

    // §7.1 奖品层：DOM <img> 放在最底层，Fabric 背景透明，涂层透明处直接透出。
    const prize = document.createElement('img');
    prizeImageEl = prize;
    prize.className = 'scratch-card-prize';
    prize.src = prizeImage;
    prize.alt = '';
    prize.setAttribute('aria-hidden', 'true');
    prize.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;z-index:0;' +
      'object-fit:cover;pointer-events:none;user-select:none;-webkit-user-drag:none;';
    el.parentNode.insertBefore(prize, el);

    // §7.4-1：dpr 封顶必须在 new Canvas 之前（高 dpr 机 readback/绘制成本控制）。
    // 多实例：取值统一走注册表决策（存活实例 cap 最大值），见 applyGlobalDpr。
    applyGlobalDpr();

    // §7.4-2：场景背景透明、禁选中、不启用缩放平移（viewportTransform 恒单位阵）。
    fabricCanvas = new Canvas(el, {
      width: cssW,
      height: cssH,
      backgroundColor: '',
      preserveObjectStacking: true,
      enableRetinaScaling: true,
      selection: false,
      renderOnAddRemove: true,
    });
    // §4.1：容器 touch-action:none，防止刮擦时页面滚动/下拉刷新。
    if (fabricCanvas.container) {
      fabricCanvas.container.style.touchAction = 'none';
    }
    dpr = fabricCanvas.getRetinaScaling();

    // 竞态防护：destroy 可能在 new Canvas 后、图案 await 期间调用。
    if (destroyed) {
      fabricCanvas.dispose();
      prizeImageEl?.remove();
      return;
    }

    // §7.4-3：预加载涂层图案（crossOrigin anonymous），成功与否都继续；
    // 失败（含无 CORS，R1）降级纯色涂层，组件不允许因此崩溃。
    if (coatOpts.type === 'image' && coatOpts.imageUrl) {
      try {
        patternImage = await loadPatternImage(coatOpts.imageUrl);
      } catch (err) {
        patternImage = null;
        console.warn('[scratch-card] coat image fallback to color:', err);
      }
    }
    if (destroyed) return;

    // §7.4-4：创建 coatCanvas（backstore = cssW*dpr）并铺底。
    const fresh = makeFreshCoat();
    coatCanvas = fresh.canvas;
    coatCtx = fresh.ctx;

    // §7.4-5：涂层 FabricImage（约束1/6 + origin 显式 left/top）。
    coatImage = buildCoatImage(coatCanvas);

    // §7.4-6：add -> 绑事件 -> 首帧 requestRenderAll。
    fabricCanvas.add(coatImage);
    // 非 API 的内部自检钩子（不进返回值，仅用于自动化验收 R12/约束1/对象计数）。
    // 多实例隔离：window.__scratchCardInternals(id) 按实例取用，互不覆盖。
    exposeInternals(instanceId, () => ({
      id: instanceId,
      fabricCanvas,
      coatImage,
      coatCanvas,
      dpr,
    }));
    fabricCanvas.on({
      'mouse:down': onMouseDown,
      'mouse:move': onMouseMove,
      'mouse:up': onMouseUp,
    });
    // §4.4 / R9 兜底监听。
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // §4.5：ResizeObserver 观察外层容器（rAF 去抖在回调内处理）。
    if (host && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResizeObserver);
      resizeObserver.observe(host);
    }

    fabricCanvas.requestRenderAll();
  }

  init();

  return { reset, destroy, getRatio };
}
