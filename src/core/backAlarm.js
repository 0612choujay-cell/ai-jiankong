import { speakNow } from './phoneAlert.js'

/**
 * 離開這個頁面（切到別的網頁／App）時的警報：嗶嗶嗶，再念兩次「回去」，
 * 回到頁面才停。
 *
 * 限制（瀏覽器行為，程式無法繞過）：iPad Safari 會在頁面進背景後暫停計時器、
 * 語音合成，有時連聲音都會被系統靜音；桌機瀏覽器通常可以正常響。
 * 所以這是「盡力而為」：能響就響，被系統擋掉就沒有聲音。
 */
export const BACK_ALARM_REPEAT_MS = 3500
export const BACK_ALARM_TEXT = '回去。回去。'

export function playBeeps(ctx, count = 3) {
  if (!ctx) return false
  try {
    if (ctx.state === 'suspended') ctx.resume?.()
    const t0 = ctx.currentTime
    for (let i = 0; i < count; i++) {
      const t = t0 + i * 0.28
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = 1000
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.6, t + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
      osc.connect(g)
      g.connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.2)
    }
    return true
  } catch {
    return false
  }
}

export function createBackAlarm({ getCtx }) {
  let timer = 0
  function once() {
    playBeeps(getCtx())
    setTimeout(() => speakNow(BACK_ALARM_TEXT, 'zh-TW'), 900)
  }
  return {
    start() {
      if (timer) return
      once()
      timer = setInterval(once, BACK_ALARM_REPEAT_MS)
    },
    stop() {
      clearInterval(timer)
      timer = 0
      try { window.speechSynthesis?.cancel?.() } catch { /* 沒有語音就算了 */ }
    },
    isRunning: () => timer !== 0,
  }
}
