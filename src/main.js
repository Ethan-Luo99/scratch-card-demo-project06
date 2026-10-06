import './style.css';
import { createScratchCard } from './scratch-card/index.js';

// 双实例演示：两张卡片完全独立（各自涂层/奖品/进度/重置），
// 仅在任一揭晓时向对方面板投送"对方已揭晓"提示。

// 调试/自动化钩子（不影响 API）：暴露真实调用次数与组件实例，供无头 E2E 断言。
const __scratchDebug = { cards: {}, completeCount: 0, resetCount: 0, restoredCount: 0 };
window.__scratchDebug = __scratchDebug;

function mountCard(suffix, config, onPeerComplete) {
  const canvas = document.getElementById(`scratch-canvas-${suffix}`);
  const resetBtn = document.getElementById(`reset-btn-${suffix}`);
  const progressBar = document.getElementById(`progress-bar-${suffix}`);
  const progressText = document.getElementById(`progress-text-${suffix}`);
  const statusEl = document.getElementById(`status-${suffix}`);
  const peerHint = document.getElementById(`peer-hint-${suffix}`);

  let completed = false;

  const setStatus = (text) => {
    statusEl.textContent = `状态：${text}`;
  };

  const card = createScratchCard({
    el: canvas,
    width: config.width,
    height: config.height,
    prizeImage: config.prizeImage,
    coat: config.coat,
    brushSize: 28,
    threshold: 0.7,
    dprCap: config.dprCap,
    onProgress(ratio) {
      const pct = Math.round(ratio * 100);
      progressBar.style.width = `${pct}%`;
      progressText.textContent = `${pct}%`;
      if (!completed && ratio > 0) setStatus('刮擦中');
    },
    onComplete() {
      completed = true;
      __scratchDebug.completeCount++;
      progressBar.style.width = '100%';
      progressText.textContent = '100%';
      setStatus('已揭晓 🎉');
      onPeerComplete?.();
    },
    onReset() {
      completed = false;
      __scratchDebug.resetCount++;
      progressBar.style.width = '0%';
      progressText.textContent = '0%';
      setStatus('待开始');
    },
    onCoatRestored() {
      completed = false;
      __scratchDebug.restoredCount++;
      progressBar.style.width = '0%';
      progressText.textContent = '0%';
      setStatus('涂层已恢复，请重新刮开');
    },
  });

  resetBtn.addEventListener('click', () => card.reset());

  return {
    card,
    isCompleted: () => completed,
    notifyPeerComplete() {
      // 对方揭晓时本卡提示；若本卡也已揭晓则无需提示。
      if (!completed) peerHint.hidden = false;
    },
    clearPeerHint() {
      peerHint.hidden = true;
    },
  };
}

let unitA;
let unitB;

unitA = mountCard('a', {
  width: 375,
  height: 500,
  prizeImage: '/prize.png',
  coat: { type: 'image', imageUrl: '/coat.png', fit: 'cover', color: '#c0c0c0' },
  dprCap: 2,
}, () => unitB.notifyPeerComplete());

unitB = mountCard('b', {
  width: 300,
  height: 300,
  // 复用现有 public 资源（浏览器按 cover 缩放），独立 URL 便于缓存/排查。
  prizeImage: '/prize.png?card=b',
  coat: { type: 'image', imageUrl: '/coat.png?card=b', fit: 'cover', color: '#8f9aa8' },
  dprCap: 2,
}, () => unitA.notifyPeerComplete());

// 任一张重置时，若对方未揭晓则清掉对方面板上的提示。
document.getElementById('reset-btn-a').addEventListener('click', () => {
  if (!unitB.isCompleted()) unitB.clearPeerHint();
});
document.getElementById('reset-btn-b').addEventListener('click', () => {
  if (!unitA.isCompleted()) unitA.clearPeerHint();
});

__scratchDebug.cards.a = unitA.card;
__scratchDebug.cards.b = unitB.card;
