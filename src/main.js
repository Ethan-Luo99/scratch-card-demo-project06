import './style.css'
import { createScratchCard } from './scratch-card/index.js'

const ratioEl = document.querySelector('#ratio')
const statusEl = document.querySelector('#status')
const resetBtn = document.querySelector('#reset')

function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = `status ${cls}`
}

const card = await createScratchCard({
  el: document.querySelector('#fabric-canvas'),
  width: 375,
  height: 500,
  prizeImage: '/prize.png',
  coat: {
    type: 'image',
    imageUrl: '/coat.svg',
    color: '#c0c0c0',
    fit: 'cover',
  },
  brushSize: 28,
  threshold: 0.7,
  dprCap: 2,
  onProgress(ratio) {
    ratioEl.textContent = `${Math.round(ratio * 100)}%`
    if (ratio > 0) setStatus('刮擦中…', 'status-scratching')
  },
  onComplete() {
    ratioEl.textContent = '100%'
    setStatus('已揭晓 🎉', 'status-revealed')
  },
  onReset() {
    ratioEl.textContent = '0%'
    setStatus('未开始', 'status-idle')
  },
  onCoatRestored() {
    ratioEl.textContent = '0%'
    setStatus('涂层已恢复，请重新刮开', 'status-restored')
  },
})

resetBtn.addEventListener('click', () => card.reset())
