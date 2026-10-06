// 多实例支持：实例注册表 + dpr 全局决策 + 按实例隔离的调试钩子。
// 本模块无 DOM / fabric 依赖（window 访问全部兜底），可直接被 node:test 验证。

/**
 * dpr 决策的事实依据（fabric@7.4.0 源码）：
 * - node_modules/fabric/src/env/index.ts:
 *     getDevicePixelRatio() = Math.max(config.devicePixelRatio ?? window.devicePixelRatio, 1)
 *   读取的是【模块级全局】config.devicePixelRatio，且在调用时刻实时求值；
 * - node_modules/fabric/src/config.ts: devicePixelRatio 初值 = window.devicePixelRatio；
 * - node_modules/fabric/src/canvas/StaticCanvas.ts:
 *     getRetinaScaling() = enableRetinaScaling ? getDevicePixelRatio() : 1
 *   在 setDimensions()（L313）与渲染路径（L1348/L1364）中【实时】调用，
 *   即 dpr 不是 new Canvas 时的快照，任何时刻改写 config.devicePixelRatio
 *   都会影响所有存活 canvas 的下一次 setDimensions/render。
 *
 * 结论：同页多实例无法各自封顶，config.devicePixelRatio 全页只有一份。
 *
 * 本组件采用的策略 —— 【统一取各存活实例 dprCap 的最大值】：
 *   effectiveDpr = min(window.devicePixelRatio, max(存活实例的 dprCap))
 * 理由：
 *  1. 后创建的实例只会把全局值【向上】抬（或不变），绝不会把先创建实例的
 *     retina 缩放静默降级 —— 先建实例的 backstore 不会在其不知情时缩水；
 *  2. 低 cap 实例在高 cap 同伴存活期间可能运行在高于自身 cap 的 dpr 上，
 *     代价是多耗一点 readback/绘制成本，但显示与坐标换算始终正确
 *     （每个实例的 dpr 取自自身 canvas 的 getRetinaScaling()，自洽）；
 *  3. destroy 时【不向下回收】全局值：存活实例的 backstore 已按高 dpr 建立，
 *     贸然调低会让它们在下一次 relayout 时静默降级。页面生命周期内
 *     config.devicePixelRatio 单调不降，是"不破坏先创建实例"的最保守选择。
 * 被否决的备选"首个实例创建后锁定"：后建的高 cap 实例将永远拿不到 retina，
 * 在 dpr=3 设备上被锁死在首实例的低 cap，显示模糊，不可接受。
 */
export function resolveDevicePixelRatio(windowDpr, maxDprCap) {
  const dpr = typeof windowDpr === 'number' && windowDpr > 0 ? windowDpr : 1;
  const cap = typeof maxDprCap === 'number' && maxDprCap > 0 ? maxDprCap : 1;
  return Math.min(dpr, cap);
}

/**
 * 实例注册表：登记存活实例的 dprCap，供 dpr 决策取最大值。
 * register 返回自增 id；unregister 幂等（重复 destroy 安全）。
 */
export function createScratchCardRegistry() {
  const instances = new Map(); // id -> { dprCap }
  let nextId = 0;

  function register(dprCap) {
    const id = ++nextId;
    instances.set(id, { dprCap });
    return id;
  }

  function unregister(id) {
    instances.delete(id); // Map.delete 对不存在 key 静默成功：重复 destroy 幂等
  }

  /** 存活实例 dprCap 的最大值（无实例时为 1，即不封顶之外的最低有效值）。 */
  function maxDprCap() {
    let max = 1;
    for (const { dprCap } of instances.values()) {
      if (typeof dprCap === 'number' && dprCap > max) max = dprCap;
    }
    return max;
  }

  function size() {
    return instances.size;
  }

  function has(id) {
    return instances.has(id);
  }

  return { register, unregister, maxDprCap, size, has };
}

// 全页共享单例：createScratchCard 各实例共用，保证 dpr 决策看到全部存活实例。
export const sharedRegistry = createScratchCardRegistry();

// ---------- 按实例隔离的调试钩子 ----------

// id -> () => internals。模块级 Map，同模块所有实例共享。
const internalsGetters = new Map();

/**
 * 安装/复用 window.__scratchCardInternals 分发器（幂等）。
 * 调用形式：window.__scratchCardInternals(id) -> 该实例内部引用或 null。
 */
function ensureInternalsDispatcher() {
  if (typeof window === 'undefined') return;
  if (typeof window.__scratchCardInternals === 'function' &&
      window.__scratchCardInternals.__isScratchDispatcher) {
    return;
  }
  const dispatcher = (id) => internalsGetters.get(id)?.() ?? null;
  dispatcher.__isScratchDispatcher = true;
  window.__scratchCardInternals = dispatcher;
}

/** 登记某实例的 internals 取值器；返回该实例 id 供调用方透传。 */
export function exposeInternals(id, getter) {
  ensureInternalsDispatcher();
  internalsGetters.set(id, getter);
}

/** 注销某实例的 internals（幂等）；无剩余实例时移除全局分发器。 */
export function removeInternals(id) {
  internalsGetters.delete(id);
  if (internalsGetters.size === 0 && typeof window !== 'undefined') {
    if (window.__scratchCardInternals?.__isScratchDispatcher) {
      delete window.__scratchCardInternals;
    }
  }
}
