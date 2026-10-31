/**
 * 「要不要休息？」的語音回答辨識：聽到「好／ok」回 'yes'，「不要／no」回 'no'。
 *
 * ⚠ 這是全專案唯一使用瀏覽器語音辨識（SpeechRecognition）的地方，使用者明確要求。
 * 隱私影響（隱私說明頁已同步改寫）：
 *   - 會要麥克風權限，而且只在「叫你休息」之後的幾秒內才開麥克風。
 *   - iPad Safari／Chrome 的語音辨識會把這幾秒的聲音送到瀏覽器廠商（Apple／Google）
 *     辨識，需要網路；本程式不錄音、不存檔、不上傳到任何自己的伺服器。
 *   - 不支援或被拒絕時回 null，遊戲照常進行。
 */
export const LISTEN_MS = 8000

const NO = /不要|不用|不想|不休息|不行|沒有|算了|不|\bno\b|nope|nah|don'?t|do not|\bnot\b/i
const YES = /好|ok|okay|可以|要|休息|對|是|\brest\b|\bbreak\b|take a rest|\byes\b|yeah|sure/i

/** 把辨識到的一串文字分類；聽不出來回 null。「不好」這種否定先於「好」判斷。 */
export function classifyAnswer(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (NO.test(t)) return 'no'
  if (YES.test(t)) return 'yes'
  return null
}

export function isSupported() {
  return typeof window !== 'undefined'
    && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

/**
 * 聽一次。回傳 { stop() }；結果透過 onResult('yes'|'no'|null, reason) 回報，保證只回報一次。
 * null＝沒聽懂、逾時、被拒絕、或不支援。
 */
export function listenForYesNo(onResult, { lang = 'zh-TW', timeoutMs = LISTEN_MS } = {}) {
  const Ctor = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null
  let done = false
  let rec = null
  let timer = 0
  // reason：沒有答案時的原因代碼（'unsupported'、'not-allowed'、'no-speech'、'timeout' 等），給畫面顯示用。
  let lastError = null
  const finish = (answer, reason = null) => {
    if (done) return
    done = true
    clearTimeout(timer)
    try { rec?.abort?.() } catch { /* 已經停了 */ }
    rec = null
    onResult(answer, answer ? null : (reason ?? lastError ?? 'timeout'))
  }
  if (!Ctor) { finish(null, 'unsupported'); return { stop() {} } }

  try {
    rec = new Ctor()
    rec.lang = lang
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 3
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex ?? 0; i < ev.results.length; i++) {
        for (let j = 0; j < ev.results[i].length; j++) {
          const answer = classifyAnswer(ev.results[i][j].transcript)
          if (answer) { finish(answer); return }
        }
      }
    }
    rec.onerror = (ev) => { lastError = ev?.error ?? 'error'; finish(null, lastError) }
    rec.onend = () => finish(null)
    rec.start()
    timer = setTimeout(() => finish(null), timeoutMs)
  } catch (e) {
    finish(null, e?.name ?? 'start-failed')
  }
  return { stop() { finish(null, 'stopped') } }
}
