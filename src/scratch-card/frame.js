// §3.1 统计时机：rAF 节流，每帧至多一次 measure；R10：generation token
// 使 reset/destroy 后挂起的 rAF 回调直接作废，杜绝写已废弃 canvas。

export function createFrameBatcher({ raf, caf } = {}) {
  const requestFrame =
    raf ?? ((cb) => (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : setTimeout(() => cb(Date.now()), 16)));
  const cancelFrame =
    caf ?? ((id) => (typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame(id)
      : clearTimeout(id)));

  // reset/destroy 自增；挂起回调捕获的 token 与之不符即作废。
  let generation = 0;
  let rafId = 0;
  let rafPending = false;

  function invalidate() {
    // 按 §R10 定案：只自增 token，不取消已挂起的帧。挂起回调触发时
    // 自带的 myGeneration !== generation，直接 return；同时释放 pending
    // 标记，使新一轮刮擦可以立即重新调度（旧帧稍后触发自行作废）。
    generation++;
    rafPending = false;
    rafId = 0;
  }

  /**
   * 同一帧内多次 schedule 只挂一个 rAF；回调内校验 token（R10）。
   * @param {number} myGeneration 调用方在调度时捕获的当代 token
   */
  function schedule(cb, myGeneration = generation) {
    if (rafPending) return;
    rafPending = true;
    rafId = requestFrame(() => {
      if (myGeneration !== generation) return; // R10 作废：已 reset/destroy，不动新轮状态
      rafPending = false;
      rafId = 0;
      cb(generation);
    });
  }

  /** 调度点使用的当代 token（cb 内与最新 generation 比对）。 */
  function currentGeneration() {
    return generation;
  }

  function isPending() {
    return rafPending;
  }

  function destroy() {
    invalidate();
  }

  return { schedule, invalidate, currentGeneration, isPending, destroy };
}
