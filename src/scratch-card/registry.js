// 多实例注册表 + 全局 dpr 决策（纯逻辑，无 DOM/fabric 依赖，可直接 node:test）。
//
// 【dpr 决策结论 —— 阅读 node_modules/fabric/src/env/index.ts 与 config.ts 后定案】
// 1. fabric 的 config 是模块级单例（config.ts 导出的唯一 Configuration 实例），
//    env/index.ts 的 getDevicePixelRatio() 读的是
//    `config.devicePixelRatio ?? window.devicePixelRatio` —— 同页所有 Canvas
//    实例共享同一个值，fabric 不提供任何按实例封顶 dpr 的入口。
// 2. StaticCanvas.getRetinaScaling() 每次调用都实时读该全局值，但 backstore
//    的物理尺寸与 ctx 缩放只在 setDimensions()（含构造）时烘焙一次
//    （StaticCanvas._setDimensionsImpl -> elements.setDimensions(size, retina)）。
//    因此运行中改全局值不会立刻重排已建实例的 backstore；已建实例只在
//    自己下一次 setDimensions 时才采用新值。
//
// 策略定案：统一取所有存活实例 dprCap 的【最大值】作为全局封顶。
//  - 后创建的低 cap 实例不会拉低全局值，先建的高 cap 实例的 retina 缩放
//    永不因后来者而降级（这是本策略要杜绝的"静默破坏"）；
//  - 后创建的高 cap 实例抬高全局值后，先建实例的 backstore/涂层仍按其
//    实例内捕获的 dpr 自洽运行，直到它自己下一次 relayout 才随
//    setDimensions 采用新 dpr —— 而 relayout 本就会按新 dpr 重建
//    coatCanvas 并等比重映射刮痕，全程一致，无静默错乱；
//  - 备选方案"首个实例创建后锁定"被否决：它会让后续合法的高 cap 实例
//    永久拿不到应有的清晰度，且锁定值在首实例 destroy 后语义含糊。
//
// 组件内一切物理像素换算只使用实例自己捕获的 dpr（index.js 的 dpr 变量），
// 该值与 fabric backstore 缩放同步更新（init / relayout 两处），因此全局
// 值的变化对存活实例永远不是"静默"的。

/**
 * 由窗口 dpr 与一组实例 dprCap 计算全局生效 dpr。
 * @param {number} windowDpr window.devicePixelRatio（可能缺失/异常，按 1 兜底）
 * @param {number[]} dprCaps 所有存活实例的 dprCap
 * @returns {number} min(windowDpr, max(dprCaps))，恒 >= 1
 */
export function resolveDevicePixelRatio(windowDpr, dprCaps) {
  const cap = dprCaps.length ? Math.max(...dprCaps) : 1;
  const raw = typeof windowDpr === 'number' && windowDpr >= 1 ? windowDpr : 1;
  return Math.max(1, Math.min(raw, cap));
}

/**
 * 实例注册表工厂。每个实例注册得到唯一 id；注销幂等（重复删同一 id 安全）。
 * 注册表同时承载按实例隔离的调试钩子存取（替代单实例时代的
 * window.__scratchCardInternals 覆盖式赋值）。
 */
export function createScratchCardRegistry() {
  const instances = new Map(); // id -> { dprCap, internalsGetter }
  let nextId = 1;

  function register(dprCap) {
    const id = nextId++;
    instances.set(id, { dprCap, internalsGetter: null });
    return id;
  }

  // 幂等：Map.delete 对不存在的 key 直接返回 false，重复 destroy 安全。
  function unregister(id) {
    instances.delete(id);
  }

  function setInternals(id, internalsGetter) {
    const entry = instances.get(id);
    if (entry) entry.internalsGetter = internalsGetter;
  }

  function getInternals(id) {
    const entry = instances.get(id);
    return entry && entry.internalsGetter ? entry.internalsGetter() : null;
  }

  function dprCaps() {
    return [...instances.values()].map((entry) => entry.dprCap);
  }

  function size() {
    return instances.size;
  }

  return { register, unregister, setInternals, getInternals, dprCaps, size };
}

// 组件运行时所共享的唯一注册表（同页所有 createScratchCard 实例）。
export const sharedRegistry = createScratchCardRegistry();

let debugHookInstalled = false;

/**
 * 安装按实例隔离的调试钩子：window.__scratchCardInternals(id)。
 * 只安装一次；实例 destroy 注销后，对应 id 返回 null，其余实例不受影响。
 */
export function ensureDebugHook(registry = sharedRegistry) {
  if (typeof window === 'undefined' || debugHookInstalled) return;
  debugHookInstalled = true;
  window.__scratchCardInternals = (id) => registry.getInternals(id);
}
