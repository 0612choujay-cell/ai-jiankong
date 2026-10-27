/**
 * 拿出手機時的提醒：敲一聲鑼，再念「不要再滑了」。
 *
 * 這是使用者明確要求的行為，刻意推翻原本「手機／離開類提示一律不朗讀」的
 * 保護（data/copy/posture.js 的 NO_VOICE_POSTURE_KEYS 是為了不把被抓包的事
 * 廣播給旁人）。所以它不走 messageQueue 的 voice 仲裁，而是這個獨立模組：
 * 手機一出現就響，之後每 PHONE_ALERT_REPEAT_MS 重複，直到手機離開畫面。
 * 仍然遵守角落的 🔊／🔇 開關（由呼叫端判斷）。
 */
export const PHONE_ALERT_TEXT = '不要再滑了'
export const PHONE_ALERT_LANG = 'zh-TW'
// 手機在畫面上就每隔這麼久再敲一次、再念一次，直到收起來為止。
export const PHONE_ALERT_REPEAT_MS = 6000

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
    master.gain.value = 0.75 // 最大音量：各泛音增益加總約 1.27，0.75 讓峰值約 0.95、不爆音
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
 * 魔王的吼叫：低沉的鋸齒波往下滑，疊一段濾過的雜訊當氣音，約 1.1 秒。
 * @returns {boolean} 有沒有真的送出聲音。
 */
export function playRoar(ctx) {
  if (!ctx) return false
  try {
    if (ctx.state === 'suspended') ctx.resume?.()
    const t0 = ctx.currentTime
    const dur = 1.1
    const master = ctx.createGain()
    master.gain.setValueAtTime(0.0001, t0)
    master.gain.exponentialRampToValueAtTime(0.9, t0 + 0.06)
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    master.connect(ctx.destination)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(1400, t0)
    lp.frequency.exponentialRampToValueAtTime(300, t0 + dur)
    lp.connect(master)

    for (const detune of [0, 7]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(130, t0)
      osc.frequency.exponentialRampToValueAtTime(55, t0 + dur)
      osc.detune.value = detune
      osc.connect(lp)
      osc.start(t0)
      osc.stop(t0 + dur + 0.05)
    }

    const frames = Math.floor(ctx.sampleRate * dur)
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * 0.5
    const noise = ctx.createBufferSource()
    noise.buffer = buf
    noise.connect(lp)
    noise.start(t0)
    return true
  } catch {
    return false
  }
}

/**
 * 直接用瀏覽器語音念一句（取代原本的吼叫聲），不經過 🔊／🔇 開關。
 * 需要之前已有使用者手勢解鎖過語音（開戰按鈕那次 primeVoiceFromGesture）。
 * onStart／onEnd：聲音真正開始、結束時呼叫（畫面動作要跟著聲音走）。
 * @returns {boolean} 有沒有送出。
 */
export function speakNow(text, lang = PHONE_ALERT_LANG, { onStart, onEnd } = {}) {
  try {
    const synth = window.speechSynthesis
    if (!synth || !text) return false
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const voices = synth.getVoices?.() ?? []
    const v = voices.find((x) => x.lang === lang) ?? voices.find((x) => x.lang?.startsWith(lang.slice(0, 2))) ?? null
    if (v) u.voice = v
    u.lang = v?.lang ?? lang
    u.volume = 1
    u.rate = 1
    // 聲音真正開始／結束的時間點，讓畫面動作跟聲音同步。
    u.onstart = () => onStart?.()
    u.onend = () => onEnd?.()
    u.onerror = () => onEnd?.()
    synth.speak(u)
    return true
  } catch {
    return false
  }
}
