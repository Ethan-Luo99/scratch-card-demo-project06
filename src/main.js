import './style.css';
import { createScratchCard } from './scratch-card/index.js';

const canvas = document.getElementById('scratch-canvas');
const resetBtn = document.getElementById('reset-btn');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const statusEl = document.getElementById('status');

const CARD_W = 375;
const CARD_H = 500;

let completed = false;

// 调试/自动化钩子（不影响 API）：暴露真实调用次数与组件实例，供无头 E2E 断言。
const __scratchDebug = { completeCount: 0, resetCount: 0, restoredCount: 0, card: null };
window.__scratchDebug = __scratchDebug;

function setStatus(text) {
  statusEl.textContent = `状态：${text}`;
}

const card = createScratchCard({
  el: canvas,
  width: CARD_W,
  height: CARD_H,
  prizeImage: '/prize.png',
  coat: {
    type: 'image',
    imageUrl: '/coat.png',
    fit: 'cover',
    color: '#c0c0c0',
  },
  brushSize: 28,
  threshold: 0.7,
  dprCap: 2,
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
__scratchDebug.card = card;
