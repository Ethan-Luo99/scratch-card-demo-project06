// §3.2 快速滑动的插值补点：坐标统一在物理像素空间计算。
// 该模块是无 DOM / 无 fabric 依赖的纯函数，便于 node:test 直接验证。

/**
 * 把点夹到 [-margin, W+margin] × [-margin, H+margin]。
 * §4.2：越界点"夹取用于绘制、不用于状态"，出界段沿边缘连续擦除，
 * 回滑入画布时笔迹无缺口。
 * @param {{x:number,y:number}} p 物理像素点
 * @param {number} W 画布物理宽
 * @param {number} H 画布物理高
 * @param {number} margin 外扩边距（取笔刷物理半径）
 */
export function clampPoint(p, W, H, margin) {
  return {
    x: Math.min(W + margin, Math.max(-margin, p.x)),
    y: Math.min(H + margin, Math.max(-margin, p.y)),
  };
}

/**
 * 生成从 a 到 b 的线性插值补点序列。
 * §3.2：相邻绘制点间距不得超过一个物理半径（MAX_SEG = brushR），
 * 80px CSS 跳变（dpr=2 时为 160 物理 px，笔宽 28 CSS => brushR=28）
 * 最坏补点数 ≈ 距离/brushR，逐段 round cap 线保证无断点。
 *
 * 返回的点集不含起点 a（起点由上一段的终点覆盖），终点为 b。
 * 至少返回 1 个点（b 自身），因此纯点击也能画出一个圆头洞。
 *
 * @param {{x:number,y:number}} a 上一物理点
 * @param {{x:number,y:number}} b 当前物理点
 * @param {number} maxSegment 相邻点最大间距（物理像素，= brushR）
 * @returns {Array<{x:number,y:number}>}
 */
export function interpolatePoints(a, b, maxSegment) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(dist / maxSegment));
  const points = new Array(n);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    points[i - 1] = { x: a.x + dx * t, y: a.y + dy * t };
  }
  return points;
}
