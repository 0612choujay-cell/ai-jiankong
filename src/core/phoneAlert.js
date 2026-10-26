/**
 * 拿出手機時的提醒：敲一聲鑼，再念「分心了，手機收起來」。
 *
 * 這是使用者明確要求的行為，刻意推翻原本「手機／離開類提示一律不朗讀」的
 * 保護（data/copy/posture.js 的 NO_VOICE_POSTURE_KEYS 是為了不把被抓包的事
 * 廣播給旁人）。所以它不走 messageQueue 的 voice 仲裁，而是這個獨立模組：
 * 邊緣觸發（手機從沒有變成有才響）＋冷卻，同一次拿著手機不會一直敲。
 * 仍然遵守角落的 🔊／🔇 開關（由呼叫端判斷）。
 */
export const PHONE_ALERT_TEXT = '分心了，手機收起來'
export const PHONE_ALERT_COOLDOWN_MS = 20_000

// 銅鑼的音色：一組不成整數倍的泛音，各自指數衰減，基音衰減最慢。
const PARTIALS = [
  { ratio: 1, gain: 0.5, decay: 2.2 },
  { ratio: 1.47, gain: 0.3, decay: 1.6 },
  { ratio: 2.09, gain: 0.22, decay: 1.2 },
  { ratio: 2.56, gain: 0.15, decay: 0.9 },
  { ratio: 3.42, gain: 0.1, decay: 0.6 },
]
const BASE_HZ = 180

/** @returns {boolean} 有沒有真的送出聲音。 */
export function playGong(ctx) {
  if (!ctx) return false
  try {
    if (ctx.state === 'suspended') ctx.resume?.()
    const t0 = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = 0.35
    master.connect(ctx.destination)
    for (const p of PARTIALS) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = BASE_HZ * p.ratio
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(p.gain, t0 + 0.008) // 敲擊的瞬間
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.decay)
      osc.connect(g)
      g.connect(master)
      osc.start(t0)
      osc.stop(t0 + p.decay + 0.05)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 邊緣觸發＋冷卻的判斷，純函式好測。
 * @returns {boolean} 這一次是否該提醒。
 */
export function shouldAlert({ wasVisible, isVisible, lastAt, now }) {
  if (!isVisible || wasVisible) return false
  return lastAt == null || now - lastAt >= PHONE_ALERT_COOLDOWN_MS
}
