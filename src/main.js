import './style.css';
import { createScratchCard } from './scratch-card/index.js';

// 同页两张完全独立的刮刮卡实例：各自的涂层/奖品/进度/状态互不串扰。
// 联动规则：任一实例揭晓（onComplete）时，另一张面板出现"对方已揭晓"提示；
// 揭晓方重置后，对方提示随之消失。

// 调试/自动化钩子（不影响 API）：暴露真实调用次数与组件实例，供无头 E2E 断言。
const __scratchDebug = { cards: {} };
window.__scratchDebug = __scratchDebug;

function setupCard({ name, canvasId, width, height, coat, onPeerRevealChange }) {
  const canvas = document.getElementById(canvasId);
  const resetBtn = document.getElementById(`reset-btn-${name}`);
  const progressBar = document.getElementById(`progress-bar-${name}`);
  const progressText = document.getElementById(`progress-text-${name}`);
  const statusEl = document.getElementById(`status-${name}`);
  const peerHintEl = document.getElementById(`peer-hint-${name}`);

  const debug = { completeCount: 0, resetCount: 0, restoredCount: 0, card: null };
  __scratchDebug.cards[name] = debug;

  let completed = false;

  function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
  }

  function setProgress(ratio) {
    const pct = Math.round(ratio * 100);
    progressBar.style.width = `${pct}%`;
    progressText.textContent = `${pct}%`;
  }

  const card = createScratchCard({
    el: canvas,
    width,
    height,
    prizeImage: '/prize.png',
    coat,
    brushSize: 28,
    threshold: 0.7,
    dprCap: 2,
    onProgress(ratio) {
      setProgress(ratio);
      if (!completed && ratio > 0) setStatus('刮擦中');
    },
    onComplete() {
      completed = true;
      debug.completeCount++;
      setProgress(1);
      setStatus('已揭晓 🎉');
      onPeerRevealChange?.(true);
    },
    onReset() {
      completed = false;
      debug.resetCount++;
      setProgress(0);
      setStatus('待开始');
      onPeerRevealChange?.(false);
    },
    onCoatRestored() {
      completed = false;
      debug.restoredCount++;
      setProgress(0);
      setStatus('涂层已恢复，请重新刮开');
    },
  });

  resetBtn.addEventListener('click', () => card.reset());
  debug.card = card;

  return {
    card,
    setPeerRevealed(revealed) {
      peerHintEl.hidden = !revealed;
    },
  };
}

let cardA;
let cardB;

cardA = setupCard({
  name: 'a',
  canvasId: 'scratch-canvas-a',
  width: 375,
  height: 500,
  coat: {
    type: 'image',
    imageUrl: '/coat.png',
    fit: 'cover',
    color: '#c0c0c0',
  },
  onPeerRevealChange: (revealed) => cardB?.setPeerRevealed(revealed),
});

cardB = setupCard({
  name: 'b',
  canvasId: 'scratch-canvas-b',
  width: 300,
  height: 300,
  coat: {
    type: 'image',
    imageUrl: '/coat.png',
    fit: 'fill',
    color: '#9a8fb0',
  },
  onPeerRevealChange: (revealed) => cardA?.setPeerRevealed(revealed),
});
