import { DISTRACTED_CLIP_RATE, DISTRACTED_CLIP_PCM16_B64 } from '../data/distractedClip.js'

/**
 * 全 App 共用一個 AudioContext，並且在「開始」那一下點擊（使用者手勢）裡解鎖。
 * iOS 只允許在手勢裡 resume() 的 AudioContext 之後出聲；放在畫面掛載時才建立
 * 的話，使用者切到別的網頁後那個 context 還是靜音的，警報就沒有聲音。
 */
let ctx = null
let alarmBuffer = null

/** 把內嵌的 PCM16 直接建成 AudioBuffer（同步，沒有任何會失敗的載入／解碼）。 */
export function buildClipBuffer(c) {
  try {
    const bin = window.atob(DISTRACTED_CLIP_PCM16_B64)
    const n = bin.length >> 1
    const buf = c.createBuffer(1, n, DISTRACTED_CLIP_RATE)
    const ch = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
      if (v & 0x8000) v -= 0x10000
      ch[i] = v / 32768
    }
    if (buf.copyToChannel) buf.copyToChannel(ch, 0)
    else buf.getChannelData(0).set(ch)
    return buf
  } catch {
    return null
  }
}

export function getSharedCtx() {
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)()
    } catch {
      ctx = null
    }
  }
  return ctx
}

/** 必須在點擊（使用者手勢）的同步呼叫堆疊裡呼叫。 */
export function unlockAudioFromGesture() {
  const c = getSharedCtx()
  if (!c) return false
  try {
    if (c.state === 'suspended') c.resume?.()
    // 播一個無聲的短 buffer，讓 iOS 認定這個 context 已被使用者啟動過。
    const buf = c.createBuffer(1, 1, 22050)
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(c.destination)
    src.start(0)
  } catch { /* 解鎖失敗不影響遊戲 */ }
  alarmBuffer ??= buildClipBuffer(c)
  return true
}

export function getAlarmBuffer() {
  if (!alarmBuffer && ctx) alarmBuffer = buildClipBuffer(ctx)
  return alarmBuffer
}
