// 刮刮卡纯逻辑单测（node 内置 node:test，无新增依赖）。
// 运行：node --test scripts/scratch-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolatePoints,
  clampPoint,
  createProgressMachine,
  createRafScheduler,
  computeStep,
  sampleScratchedRatio,
  fitRect,
} from '../src/scratch-card/core.js';

// ---------- §3.2：插值补点在 80px 跳变下无断点 ----------

test('§3.2 interpolatePoints: 80px 跳变被切成 <=brushR 的连续段（无断点）', () => {
  const brushCss = 28;
  const dpr = 1;
  const brushR = (brushCss * dpr) / 2; // 14 物理像素
  const prev = { x: 0, y: 0 };
  const next = { x: 80, y: 0 }; // R3：程序化 80px 步进

  const pts = interpolatePoints(prev, next, brushR);
  assert.equal(pts.length, Math.ceil(80 / brushR), '应补 6 段');
  assert.equal(pts.at(-1).x, 80, '末点即当前事件点');

  // 从 prev 到所有补点，相邻距离恒 <= brushR：round lineCap 段段重叠。
  let from = prev;
  for (const p of pts) {
    const gap = Math.hypot(p.x - from.x, p.y - from.y);
    assert.ok(gap <= brushR + 1e-9, `段间距 ${gap} 超过半径 ${brushR} 会产生断点`);
    from = p;
  }
});

test('§3.2 对角 80px 跳变同样连续覆盖', () => {
  const brushR = 14;
  const prev = { x: 10, y: 20 };
  const next = { x: 10 + 80 / Math.SQRT2, y: 20 + 80 / Math.SQRT2 };
  const pts = interpolatePoints(prev, next, brushR);
  let from = prev;
  for (const p of pts) {
    const gap = Math.hypot(p.x - from.x, p.y - from.y);
    assert.ok(gap <= brushR + 1e-9);
    from = p;
  }
  assert.ok(pts.length >= 5);
});

test('§4.2 clampPoint: 越界只夹取到笔半径 margin，不丢弃', () => {
  assert.deepEqual(clampPoint({ x: -100, y: 250 }, 375, 500, 14), { x: -14, y: 250 });
  assert.deepEqual(clampPoint({ x: 999, y: 999 }, 375, 500, 14), { x: 389, y: 514 });
});

// ---------- §3.3：ratio 反复越过 0.70 时 onComplete 恒为 1 ----------

test('§3.3 状态机: ratio 上下穿越 0.70，onComplete 只触发一次', () => {
  let completeCount = 0;
  const progressSeq = [];
  const m = createProgressMachine({
    threshold: 0.7,
    onProgress: (r) => progressSeq.push(r),
    onComplete: () => {
      completeCount += 1;
    },
  });

  const seq = [0.1, 0.4, 0.71, 0.68, 0.75, 0.6, 0.9, 0.72, 1.0];
  for (const r of seq) m.feed(r);

  assert.equal(completeCount, 1, '反复越过阈值，complete 计数必须恒为 1');
  assert.equal(m.getState(), 'revealed');
  assert.equal(progressSeq.length, 3, 'revealed 后不再 measure/发 progress（§3.3）');
  assert.deepEqual(progressSeq, [0.1, 0.4, 0.71]);
});

test('§3.3 未到阈值不结算；reset 后可再次结算且各轮 complete 各一次', () => {
  let completeCount = 0;
  const m = createProgressMachine({ threshold: 0.7, onComplete: () => (completeCount += 1) });

  m.feed(0.5);
  m.feed(0.69);
  assert.equal(completeCount, 0);
  assert.equal(m.getState(), 'scratching');

  m.reset();
  assert.equal(m.getState(), 'idle');

  m.feed(0.7);
  m.feed(0.7);
  assert.equal(completeCount, 1);
  assert.equal(m.getState(), 'revealed');

  m.reset();
  m.feed(0.95);
  assert.equal(completeCount, 2, 'reset 开启新一轮，新一轮仍可触发一次');
});

// ---------- §7.5/R10：reset 自增 generation 使挂起 rAF 作废 ----------

test('R10 rAF 调度器: reset(bump) 后挂起回调作废，新帧使用新一代', () => {
  const queued = [];
  const raf = (cb) => {
    const id = queued.length;
    queued.push(cb);
    return id;
  };
  const caf = () => {};
  const sched = createRafScheduler({ raf, caf });

  let oldRuns = 0;
  let newRuns = 0;
  sched.schedule(() => (oldRuns += 1));
  assert.equal(sched.pending, true);
  const genBefore = sched.getGeneration();

  // reset：generation 自增（不依赖 rAF 是否被取消）。
  sched.bump();
  assert.equal(sched.getGeneration(), genBefore + 1, 'reset 后 generation 必须自增');

  // 旧的挂起 rAF 此刻才触发：token 不匹配，必须直接作废。
  queued[0]();
  assert.equal(oldRuns, 0, '挂起 rAF 不得写已废弃的 coatCanvas');

  // 新一代可以正常调度并执行。
  sched.schedule(() => (newRuns += 1));
  queued[1]();
  assert.equal(newRuns, 1);
});

test('R10 同一帧内多次 schedule 只挂一个 rAF（每帧至多一次统计）', () => {
  let rafCount = 0;
  const sched = createRafScheduler({ raf: (cb) => (rafCount += 1, 1), caf: () => {} });
  sched.schedule(() => {});
  sched.schedule(() => {});
  sched.schedule(() => {});
  assert.equal(rafCount, 1);
});

// ---------- §3.1 网格统计与自适应步长（用假 ctx 验证算法） ----------

test('§3.1 computeStep: 375x500@dpr2 步长被夹到 [4,12] 且采样点 >= 4096', () => {
  const n = 750 * 1000;
  const step = computeStep(n);
  assert.ok(step >= 4 && step <= 12);
  const samples = Math.ceil(750 / step) * Math.ceil(1000 / step);
  assert.ok(samples >= 4096, `采样点数 ${samples} 应 >= 4096`);
});

test('§3.1 sampleScratchedRatio: 全不透明=0、全透明=1', () => {
  const w = 16;
  const h = 16;
  const makeCtx = (alpha) => ({
    getImageData: () => ({
      data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) =>
        i % 4 === 3 ? alpha : 0,
      ),
    }),
  });
  assert.equal(sampleScratchedRatio(makeCtx(255), w, h, 4).ratio, 0);
  assert.equal(sampleScratchedRatio(makeCtx(0), w, h, 4).ratio, 1);
});

test('§7.2 fitRect: cover 裁切铺满、fill 拉伸、contain 完整放入', () => {
  const cover = fitRect(100, 100, 375, 500, 'cover');
  assert.equal(cover.dw, 500, 'cover 按较大比例铺满（宽溢出裁切）');
  const fill = fitRect(100, 100, 375, 500, 'fill');
  assert.deepEqual([fill.dw, fill.dh], [375, 500]);
  const contain = fitRect(100, 100, 375, 500, 'contain');
  assert.equal(contain.dw, 375);
  assert.equal(contain.dh, 375);
  assert.ok(contain.dy > 0, 'contain 纵向居中留边');
});
