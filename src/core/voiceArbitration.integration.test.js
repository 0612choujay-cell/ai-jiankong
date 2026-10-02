// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createMessageQueue, PRIORITY } from './messageQueue.js'
import { createVoiceFeedback } from './voiceFeedback.js'

/**
 * 這個檔案只測一件事：messageQueue 的 NO_VOICE 表本身就足以擋下 TTS，
 * 不依賴呼叫端把 `voice` 算對。
 *
 * BattleView.test.js 裡的「端到端」測試會真的走 bossDialogue.js 的
 * copyKeyForEvent()——但那支函式自己也會用 NO_VOICE_BOSS_KEYS 算一次
 * `voice`（見該檔案檔頭：「算出的 voice 只是方便值，最終是否朗讀仍由
 * messageQueue 內部的 NO_VOICE 表說了算」）。這代表光是那條測試綠燈，
 * 不足以證明「就算 messageQueue 自己的 NO_VOICE 表被拿掉，分心類提示也不會
 * 被念出來」——因為 copyKeyForEvent 那邊的方便值本來就已經算對了，兩層防禦
 * 會互相掩護，蓋掉 messageQueue 這層真正被移除時的紅燈（複審過的假陽性
 * 模式之一：斷言在下游既有檢查也會接住的終態上）。
 *
 * 這裡刻意繞過 copyKeyForEvent，直接模擬「呼叫端把 voice 算錯」的情況——
 * `publish()` 傳 `voice:true`，就跟 messageQueue.test.js 既有的『NO_VOICE
 * 表…無條件覆寫』那組測試同一個手法——但這裡多接一顆真正的 voiceFeedback，
 * 用production 就是同一句話：「只讀 mq 吐出來的 m.voice，不重新判斷」的
 * consumer 規則，驗證接到 TTS 這一層之後，最終瀏覽器 speak() 真的完全沒被
 * 呼叫。這樣才真正鎖住「messageQueue 自己就是最後一道、而且是充分的防線」，
 * 而不是被上游剛好也算對這件事僥倖蓋過去。
 */

function installFakeSpeechSynthesis() {
  const synth = {
    speaking: false,
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: vi.fn(() => [{ lang: 'zh-TW', name: 'Test' }]),
    addEventListener: vi.fn(),
  }
  window.speechSynthesis = synth
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text
      this.volume = 1
      this.rate = 1
      this.voice = null
      this.lang = null
      this.onend = null
      this.onerror = null
    }
  }
  return synth
}

function uninstallFakeSpeechSynthesis() {
  delete window.speechSynthesis
  delete window.SpeechSynthesisUtterance
}

// 跟 BattleView.vue 的 speakIfNeeded() 一模一樣的消費規則：只讀 m.voice，
// 不重新判斷。寫在這裡是為了不必把 BattleView 的私有函式匯出給測試用——
// 兩邊如果哪天不同步，靠的是 BattleView.test.js 的端到端測試鎖住實際行為，
// 這裡要驗證的是「照著這個規則做，messageQueue 這層防線夠不夠」。
function consumeAndMaybeSpeak(mq, voice, now) {
  const m = mq.current(now)
  if (m && m.voice) voice.speak(m.text, m.priority)
}

describe('messageQueue 的 NO_VOICE 表：即使呼叫端把 voice 算錯（傳 true），接上真正的 voiceFeedback 之後 TTS 依然完全不會被觸發', () => {
  it('boss 分心類 key（phoneTrap/awayTrap）：呼叫端傳 voice:true，最終瀏覽器 speak() 從未被呼叫', () => {
    const synth = installFakeSpeechSynthesis()
    const voice = createVoiceFeedback()
    voice.init()
    voice.setEnabled(true)
    voice.primeFromGesture()
    synth.speak.mockClear() // 排除暖機那一次

    const mq = createMessageQueue()
    // 刻意傳 voice:true——模擬呼叫端（例如未來改版的 bossDialogue）算錯的情況。
    mq.publish({
      kind: 'battle', priority: PRIORITY.battle, text: '手機出現了，這一刀我閃掉了',
      voice: true, ns: 'boss', key: 'phoneTrap',
    }, 0)

    const m = mq.current(0)
    expect(m.voice).toBe(false) // messageQueue 自己糾正回來

    consumeAndMaybeSpeak(mq, voice, 0)
    expect(synth.speak).not.toHaveBeenCalled()

    uninstallFakeSpeechSynthesis()
  })

  it('posture 分心類 key（phone/away）：同上', () => {
    const synth = installFakeSpeechSynthesis()
    const voice = createVoiceFeedback()
    voice.init()
    voice.setEnabled(true)
    voice.primeFromGesture()
    synth.speak.mockClear()

    const mq = createMessageQueue()
    mq.publish({
      kind: 'trap', priority: PRIORITY.trap, text: '偵測到手機出現',
      voice: true, ns: 'posture', key: 'phone',
    }, 0)

    expect(mq.current(0).voice).toBe(false)
    consumeAndMaybeSpeak(mq, voice, 0)
    expect(synth.speak).not.toHaveBeenCalled()

    uninstallFakeSpeechSynthesis()
  })

  it('反向測試：不在任一張表內的一般 key，同一條真實管線（mq→voiceFeedback）真的會呼叫瀏覽器 TTS——證明上面兩則「沒呼叫」不是因為這條管線本來就是啞的', () => {
    const synth = installFakeSpeechSynthesis()
    const voice = createVoiceFeedback()
    voice.init()
    voice.setEnabled(true)
    voice.primeFromGesture()
    synth.speak.mockClear()

    const mq = createMessageQueue()
    // 'hit' 現在被 NO_VOICE_PRAISE_BOSS_KEYS 關掉了（見下一條測試），這裡
    // 換成 'regroup'——distraction 造成的後果、真的要念出來的那一種。
    mq.publish({
      kind: 'battle', priority: PRIORITY.battle, text: '調整一下再來',
      voice: true, ns: 'boss', key: 'regroup',
    }, 0)

    expect(mq.current(0).voice).toBe(true)
    consumeAndMaybeSpeak(mq, voice, 0)
    expect(synth.speak).toHaveBeenCalledTimes(1)

    uninstallFakeSpeechSynthesis()
  })

  it('boss 戰況旁白 key（hit/combo/phase2）：呼叫端傳 voice:true，最終瀏覽器 speak() 從未被呼叫（跟分心類是不同的表，見 messageQueue.js 的 QUIET 常數）', () => {
    const synth = installFakeSpeechSynthesis()
    const voice = createVoiceFeedback()
    voice.init()
    voice.setEnabled(true)
    voice.primeFromGesture()
    synth.speak.mockClear()

    for (const key of ['hit', 'combo', 'phase2']) {
      const mq = createMessageQueue()
      mq.publish({
        kind: 'battle', priority: PRIORITY.battle, text: '再來一次試試',
        voice: true, ns: 'boss', key,
      }, 0)

      expect(mq.current(0).voice, `${key} 不該被念`).toBe(false)
      consumeAndMaybeSpeak(mq, voice, 0)
    }
    expect(synth.speak).not.toHaveBeenCalled()

    uninstallFakeSpeechSynthesis()
  })
})
