// 刮刮卡纯逻辑测试（node:test，不新增任何 npm 依赖）：
//  1. §3.2 插值补点：80px CSS 跳变下相邻绘制点间距 <= 笔刷半径，笔迹无断点；
//  2. §3.3 状态机：ratio 反复越过 0.70 时 onComplete 调用计数恒为 1；
//  3. R10/§7.5：reset 后 generation 自增，挂起 rAF 回调作废（不再写旧 canvas）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpolatePoints } from '../src/scratch-card/geometry.js';
import { createStateMachine } from '../src/scratch-card/state.js';
import { createFrameBatcher } from '../src/scratch-card/frame.js';
import { computeStep, ratioFromImageData } from '../src/scratch-card/measure.js';

// §3.2 R3：文档给定场景 —— 80px CSS 跳变（快速滑动）。
test('§3.2 插值补点：80px CSS 跳变（dpr=2）下相邻点间距不超过笔刷物理半径', () => {
  const dpr = 2;
  const brushSizeCss = 28;
  const brushR = (brushSizeCss * dpr) / 2; // 28 物理 px
  const maxSegment = brushR;
  const a = { x: 0, y: 0 };
  const b = { x: 80 * dpr, y: 0 }; // 80 CSS px = 160 物理 px 的跳变

  const points = interpolatePoints(a, b, maxSegment);
  const chain = [a, ...points];

  // 必达终点
  assert.equal(points.at(-1).x, b.x);
  assert.equal(points.at(-1).y, b.y);

  // 最坏情况下补点数 = ceil(160/28) = 6
  assert.equal(points.length, Math.ceil(160 / brushR));

  // 核心断言：沿路径每 2px 采样（R3 验证手法）都应落在某条 round-cap
  // 线段覆盖域内；此处先保证"相邻绘制点间距 <= 半径"——线宽=2*半径，
  // 等宽圆头段因此必然重叠，无断点。
  for (let i = 1; i < chain.length; i++) {
    const gap = Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
    assert.ok(
      gap <= maxSegment + 1e-9,
      `第 ${i} 段间距 ${gap} 超过半径 ${maxSegment}，会出现断洞`,
    );
  }
});

test('§3.2 插值补点：对角线 80px 跳变同样无断点且方向正确', () => {
  const brushR = 28;
  const a = { x: 100, y: 100 };
  const b = { x: 100 + 80 * Math.SQRT1_2, y: 100 + 80 * Math.SQRT1_2 };
  const points = interpolatePoints(a, b, brushR);
  const chain = [a, ...points];
  for (let i = 1; i < chain.length; i++) {
    const gap = Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
    assert.ok(gap <= brushR + 1e-9);
  }
  // 点列单调推进（不回退）
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].x >= points[i - 1].x - 1e-9);
    assert.ok(points[i].y >= points[i - 1].y - 1e-9);
  }
});

test('§3.2 纯点击（位移≈0）也会产生 1 个绘制点，保证出现圆头洞', () => {
  const points = interpolatePoints({ x: 10, y: 10 }, { x: 10.1, y: 10 }, 28);
  assert.equal(points.length, 1);
});

test('§3.3 ratio 反复越过 0.70 时 onComplete 只触发一次', () => {
  let completes = 0;
  const progressRatios = [];
  const sm = createStateMachine({
    threshold: 0.7,
    onProgress: (r) => progressRatios.push(r),
    onComplete: () => completes++,
  });

  // 模拟 resize 重采样 ±1% 抖动 + 继续刮擦：在阈值两侧来回穿越。
  const feed = [0.1, 0.35, 0.69, 0.71, 0.7, 0.68, 0.75, 0.99, 0.5, 0.7, 1, 0.72];
  for (const r of feed) sm.feed(r);

  assert.equal(completes, 1, 'onComplete 调用计数必须恒为 1');
  assert.equal(sm.getState(), 'revealed');

  // reset 后新一轮仍允许且只允许再触发一次
  sm.reset();
  assert.equal(sm.getState(), 'idle');
  sm.feed(0.72);
  sm.feed(0.95);
  assert.equal(completes, 2, 'reset 后应允许新的唯一一次 complete');
  assert.equal(sm.getState(), 'revealed');
});

test('§3.3 未达阈值（50% 停手）不触发 complete', () => {
  let completes = 0;
  const sm = createStateMachine({ threshold: 0.7, onComplete: () => completes++ });
  sm.feed(0.5);
  assert.equal(completes, 0);
  assert.equal(sm.getState(), 'scratching');
});

test('§3.3 恰好等于 0.70（>=）即触发', () => {
  let completes = 0;
  const sm = createStateMachine({ threshold: 0.7, onComplete: () => completes++ });
  sm.feed(0.7);
  assert.equal(completes, 1);
  assert.equal(sm.getState(), 'revealed');
});

// 可控 rAF 的测试桩：手动推进帧，不依赖浏览器。
function createManualRaf() {
  const queue = [];
  return {
    raf: (cb) => {
      const id = Math.random();
      queue.push({ id, cb });
      return id;
    },
    caf: (id) => {
      const i = queue.findIndex((j) => j.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    flush() {
      const jobs = queue.splice(0, queue.length);
      for (const j of jobs) j.cb(performance.now());
    },
    size: () => queue.length,
  };
}

test('R10 reset 后 generation 自增，挂起 rAF 作废且新帧正常', () => {
  const manual = createManualRaf();
  const batcher = createFrameBatcher({ raf: manual.raf, caf: manual.caf });
  const oldGen = batcher.currentGeneration();

  let oldRan = 0;
  let newRan = 0;

  // 旧一代刮擦挂起一个 rAF
  batcher.schedule(() => oldRan++, oldGen);
  assert.equal(manual.size(), 1);

  // reset：generation 自增
  batcher.invalidate();
  assert.equal(batcher.currentGeneration(), oldGen + 1);

  // 挂起旧帧触发：token 不匹配，必须作废，不执行回调
  manual.flush();
  assert.equal(oldRan, 0, 'reset 前挂起的 rAF 不得再写已废弃的 canvas');

  // 新一代可正常调度并执行
  const newGen = batcher.currentGeneration();
  batcher.schedule(() => newRan++, newGen);
  assert.equal(batcher.isPending(), true);
  manual.flush();
  assert.equal(newRan, 1, 'reset 后新一代 rAF 必须正常执行');
});

test('§7.5 同帧多次 schedule 至多挂一个 rAF（每帧至多统计一次）', () => {
  const manual = createManualRaf();
  const batcher = createFrameBatcher({ raf: manual.raf, caf: manual.caf });
  let runs = 0;
  const gen = batcher.currentGeneration();
  for (let i = 0; i < 10; i++) batcher.schedule(() => runs++, gen);
  assert.equal(manual.size(), 1, '同一代最多挂起 1 个 rAF');
  manual.flush();
  assert.equal(runs, 1);
});

test('§3.1 自适应步长夹在 [4,12] 且 375x500@dpr2 采样点充足', () => {
  assert.equal(computeStep(375, 500), 7); // dpr1
  const step2 = computeStep(750, 1000);
  assert.ok(step2 >= 4 && step2 <= 12);
  // 375x500 物理像素下采样点数 >= 4096 保护目标的近似校验（小尺寸会取 4）
  assert.ok(computeStep(80, 80) === 4);
  assert.ok(computeStep(8000, 8000) === 12);
});

test('§3.1 alpha<16 判透明：构造半刮 ImageData 得到约 50% ratio', () => {
  const W = 8;
  const H = 8;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // 左 4 列透明（alpha 0），右 4 列不透明（alpha 255）
      data[i + 3] = x < 4 ? 0 : 255;
    }
  }
  const { ratio, cleared, total } = ratioFromImageData({ data }, W, H, 1);
  assert.equal(total, 64);
  assert.equal(cleared, 32);
  assert.ok(Math.abs(ratio - 0.5) < 1e-9);

  // 抗锯齿边缘 alpha=15 判透明，alpha=16 判不透明
  const edge = new Uint8ClampedArray(2 * 1 * 4);
  edge[3] = 15;
  edge[7] = 16;
  const r2 = ratioFromImageData({ data: edge }, 2, 1, 1);
  assert.equal(r2.cleared, 1);
});
