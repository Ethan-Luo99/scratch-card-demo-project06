// §3.3 阈值状态机：idle -> scratching -> revealed。
// 硬性约束 5：onComplete 只允许在 scratching/idle -> revealed 的迁移处触发一次。
// 纯逻辑模块，无 DOM / fabric 依赖，便于 node:test 验证去重。

export function createStateMachine({
  threshold = 0.7,
  onProgress,
  onComplete,
} = {}) {
  let state = 'idle';

  /**
   * 每帧 measure 后投喂一个 ratio。
   * - revealed 为终态：任何后续 ratio（含 resize 重采样 ±1% 抖动）都被忽略；
   * - 比较使用 >= threshold（文档定案真值阈值 0.70，不提前判定）。
   * 返回当前 state，供调用方决定是否短路输入（§3.3 revealAll 期间停输入）。
   */
  function feed(ratio) {
    if (state === 'revealed') return state;
    if (ratio > 0) state = 'scratching';
    onProgress?.(ratio);
    if (ratio >= threshold) {
      state = 'revealed';
      // 硬性约束 5：complete 只在状态机迁移处触发，且只可能执行一次。
      onComplete?.();
    }
    return state;
  }

  /** reset：状态归 idle，新一轮重新计数。 */
  function reset() {
    state = 'idle';
  }

  function getState() {
    return state;
  }

  return { feed, reset, getState };
}
