const MAX_CHARS = 15

/**
 * Web Speech 合成（TTS）包裝層。全模組只用語音合成（SpeechSynthesis），
 * 絕不使用語音「辨識」那一支 API——iOS 上語音辨識會把音訊送往 Apple 伺服器，
 * 直接違反本作品「影像與聲音不離開這台 iPad」的隱私訴求。全專案都不得出現
 * 那支辨識用的 API。
 *
 * 這個模組刻意「笨」：`speak(text, priority)` 只管怎麼念，不管該不該念。
 * 「該不該念」的判斷只有一個地方做——messageQueue.publish()（見該檔案
 * 檔頭註解：分心類提示的 voice 會被無條件覆寫成 false）。呼叫這個模組的
 * 唯一合法方式，是讀 messageQueue 吐出來那則訊息的 `voice` 欄位，原樣拿去
 * 決定要不要呼叫 speak()——不能從文字內容、kind、ns 或任何其他欄位重新
 * 推導一次。那會變成第二套真相：某次交錯下這裡跟 messageQueue 給出不同
 * 答案，而分心類提示一旦被念出來，後果是把使用者被抓包的事廣播給教室／
 * 展場裡的其他人。這是人格保護，不是技術細節，容不下第二個判準。
 */
export function createVoiceFeedback() {
  let enabled = false // spec 要求預設關閉：語音是加分項，不能自作主張幫使用者打開
  let primed = false
  let voice = null
  let available = false
  let currentPriority = -1

  function pickVoice() {
    const all = window.speechSynthesis?.getVoices?.() ?? []
    if (all.length === 0) return false
    // 精準命中 zh-TW 優先；退而求其次才接受任何 zh-* 開頭（例如只裝了 zh-CN
    // 語音包的機器）。順序很重要：陣列裡 zh-CN 排在 zh-TW 前面時，若只用
    // startsWith('zh') 找第一筆會誤選 zh-CN。
    voice = all.find((v) => v.lang === 'zh-TW')
      ?? all.find((v) => v.lang?.startsWith('zh'))
      ?? null
    available = voice !== null
    return available
  }

  return {
    /**
     * 註冊 voiceschanged、嘗試立刻取得 zh-TW voice。
     * @param {(available: boolean) => void} [onAvailabilityChange] 當「能不能
     *   念」這件事在 init() 呼叫之後才被確定下來時通知呼叫端（多半是
     *   voiceschanged 非同步觸發的那次）——session.js 用它把 state.voiceAvailable
     *   同步回真正的結果，不然 iPad 上第一次 getVoices() 幾乎必定回空陣列，
     *   state.voiceAvailable 會永遠卡在 init() 當下量到的 false。
     */
    init(onAvailabilityChange) {
      if (!('speechSynthesis' in window)) { available = false; return false }
      // getVoices() 第一次呼叫在多數瀏覽器（含 iOS Safari）必定回空陣列，
      // 要等 voiceschanged 事件之後才拿得到真正的清單。
      if (pickVoice()) {
        onAvailabilityChange?.(true)
      } else {
        window.speechSynthesis.addEventListener('voiceschanged', () => {
          if (pickVoice()) onAvailabilityChange?.(true)
        })
      }
      return true
    },

    /**
     * 必須在使用者手勢（click handler）的同步呼叫堆疊內執行，中間不能插入
     * 任何 await。iOS 只認「這次 speak() 是不是手勢觸發的那個同步呼叫堆疊裡
     * 發生的」；不暖機的話，之後每一次 speak() 都會被靜默忽略——不丟例外、
     * 不進 onerror，現場整場無聲，而且完全查不出原因。
     */
    primeFromGesture() {
      if (primed || !('speechSynthesis' in window)) return
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0
      window.speechSynthesis.speak(u)
      primed = true
    },

    /**
     * 單槽播放＋優先權搶佔。呼叫端必須自己先確認 `voice:true`（來自
     * messageQueue 吐出的訊息），這裡不重新判斷。
     * @returns {boolean} 這次呼叫是否真的把 utterance 送出去播放。
     */
    speak(text, priority = 0) {
      if (!enabled || !available || !primed || !text) return false
      const synth = window.speechSynthesis
      if (synth.speaking) {
        // 單槽播放：嚴格更高優先才搶佔；同優先或更低直接丟棄、不排隊——
        // 排隊會讓提示在事過境遷之後才冒出來，跟 messageQueue 拒絕排隊
        // （見該檔案檔頭註解）是同一個理由。
        if (priority <= currentPriority) return false
        synth.cancel()
      }
      const u = new SpeechSynthesisUtterance(text.slice(0, MAX_CHARS))
      u.voice = voice
      u.lang = voice?.lang ?? 'zh-TW'
      u.rate = 1
      // 讓「目前在念的優先權」回到 -1（等於沒有東西在念），下一句任何優先權
      // 都能正常開口，不會被上一句念完後遺留的 currentPriority 卡住。
      u.onend = () => { currentPriority = -1 }
      u.onerror = () => { currentPriority = -1 }
      currentPriority = priority
      synth.speak(u)
      return true
    },

    /**
     * 中斷目前正在播放的語音。
     *
     * 呼叫點只在 session.js（onHidden()／onVisible()／endBattle()／
     * teardown()——見那幾處既有的 `window.speechSynthesis?.cancel?.()`）：
     * 暫停、切背景、結束一場、卸載都是「使用者已經看不到／聽不到當下這句話
     * 還有沒有意義」的時刻。這裡刻意不在別處（例如 BattleView）再掛第二個
     * 負責清理的地方——清理時機只有一個權威來源，跟 messageQueue 是唯一
     * 仲裁者同一個道理。
     */
    cancel() {
      window.speechSynthesis?.cancel?.()
      currentPriority = -1
    },

    setEnabled(on) {
      enabled = Boolean(on)
      if (!enabled) this.cancel()
    },

    isEnabled: () => enabled,
    isAvailable: () => available,
  }
}
