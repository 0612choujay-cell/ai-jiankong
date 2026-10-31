import { speakNow } from './phoneAlert.js'

/**
 * 離開這個頁面（切到別的網頁／App）時的警報：嗶兩聲，1 秒後念「分心了」，
 * 回到頁面才停。
 *
 * 為什麼不用瀏覽器語音（speechSynthesis）：iPad Safari 頁面進背景後會把語音
 * 合成直接停掉，所以「分心了」是事先錄好的音檔（public/sounds/distracted.wav），
 * 載入成 AudioBuffer，離開頁面的當下把接下來 SCHEDULE_COUNT 輪整串排進
 * AudioContext 的音訊時鐘——不依賴背景裡會被凍結的 setInterval。
 * 音檔沒載入成功才退回用瀏覽器語音。
 *
 * 限制（瀏覽器行為，程式無法繞過）：系統仍可能把背景頁面的聲音整個靜音。
 */
export const BACK_ALARM_REPEAT_MS = 3500
export const BACK_ALARM_TEXT = '分心了'
export const BACK_ALARM_SOUND = '/sounds/distracted.wav'
const SCHEDULE_COUNT = 20 // 一次排 20 輪（約 70 秒），回到頁面就全部取消
const VOICE_DELAY_S = 1 // 離開後 1 秒念「分心了」

/** 載入音檔成 AudioBuffer；失敗回 null（呼叫端退回瀏覽器語音）。 */
export async function loadAlarmBuffer(ctx, url = BACK_ALARM_SOUND) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.arrayBuffer()
    return await new Promise((resolve) => {
      const p = ctx.decodeAudioData(data, resolve, () => resolve(null))
      p?.then?.(resolve, () => resolve(null))
    })
  } catch {
    return null
  }
}

/** 在 t0 起排 count 聲嗶；回傳建立的 source，讓呼叫端能取消。 */
export function scheduleBeeps(ctx, t0, count = 2, sources = []) {
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
    sources.push(osc)
  }
  return sources
}

export function playBeeps(ctx, count = 2) {
  if (!ctx) return false
  try {
    if (ctx.state === 'suspended') ctx.resume?.()
    scheduleBeeps(ctx, ctx.currentTime, count)
    return true
  } catch {
    return false
  }
}

export function createBackAlarm({ getCtx, getBuffer = () => null }) {
  let timer = 0
  let running = false
  let sources = []

  function scheduleAll(ctx, buffer) {
    const t0 = ctx.currentTime + 0.05
    for (let k = 0; k < SCHEDULE_COUNT; k++) {
      const t = t0 + (k * BACK_ALARM_REPEAT_MS) / 1000
      scheduleBeeps(ctx, t, 2, sources)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(t + VOICE_DELAY_S)
      sources.push(src)
    }
  }

  function fallbackOnce(ctx) {
    playBeeps(ctx)
    setTimeout(() => speakNow(BACK_ALARM_TEXT, 'zh-TW'), VOICE_DELAY_S * 1000)
  }

  return {
    start() {
      if (running) return
      running = true
      const ctx = getCtx()
      const buffer = getBuffer()
      if (ctx && buffer) {
        try {
          if (ctx.state === 'suspended') ctx.resume?.()
          scheduleAll(ctx, buffer)
          return
        } catch { sources = [] }
      }
      fallbackOnce(ctx)
      timer = setInterval(() => fallbackOnce(getCtx()), BACK_ALARM_REPEAT_MS)
    },
    stop() {
      running = false
      clearInterval(timer)
      timer = 0
      for (const s of sources) { try { s.stop() } catch { /* 已經結束的不用管 */ } }
      sources = []
      try { window.speechSynthesis?.cancel?.() } catch { /* 沒有語音就算了 */ }
    },
    isRunning: () => running,
  }
}
