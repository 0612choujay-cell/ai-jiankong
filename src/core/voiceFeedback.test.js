// @vitest-environment jsdom
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { createVoiceFeedback } from './voiceFeedback.js'

/**
 * jsdom 沒有內建 speechSynthesis／SpeechSynthesisUtterance，這裡用最小的假
 * 實作模擬瀏覽器行為。`speaking` 刻意做成一個測試可以直接讀寫的可變屬性
 * （不是根據 speak()/cancel() 呼叫自動推導），這樣才能精準模擬「utterance
 * 還沒觸發 onend 前，瀏覽器仍回報 speaking:true」這種真實但難以自然重現
 * 的時序，來驗證單槽播放的優先權搶佔邏輯。
 */
function makeFakeSynth() {
  return {
    speaking: false,
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: vi.fn(() => []),
    addEventListener: vi.fn(),
  }
}

const ZH_TW_VOICE = { lang: 'zh-TW', name: 'Mei-Jia' }

function installGlobals(synth) {
  window.speechSynthesis = synth
  globalThis.SpeechSynthesisUtterance = class {
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
}

function uninstallGlobals() {
  delete window.speechSynthesis
  delete globalThis.SpeechSynthesisUtterance
}

describe('createVoiceFeedback', () => {
  let synth

  beforeEach(() => {
    synth = makeFakeSynth()
    installGlobals(synth)
  })

  afterEach(() => {
    uninstallGlobals()
  })

  describe('init()：不可用環境與 voiceschanged 非同步取得', () => {
    it('沒有 speechSynthesis 時 init() 回 false，isAvailable() 維持 false，不噴例外', () => {
      uninstallGlobals()
      const voice = createVoiceFeedback()
      expect(() => voice.init()).not.toThrow()
      expect(voice.init()).toBe(false)
      expect(voice.isAvailable()).toBe(false)
    })

    it('getVoices() 第一次回空陣列時，會註冊 voiceschanged 監聽；事件觸發後才變成可用', () => {
      synth.getVoices.mockReturnValue([]) // 模擬第一次呼叫的常態
      const voice = createVoiceFeedback()
      const onChange = vi.fn()

      voice.init(onChange)
      expect(voice.isAvailable()).toBe(false)
      expect(synth.addEventListener).toHaveBeenCalledWith('voiceschanged', expect.any(Function))
      expect(onChange).not.toHaveBeenCalled()

      // 模擬 voiceschanged 觸發，且這次 getVoices() 拿到真正的清單
      synth.getVoices.mockReturnValue([ZH_TW_VOICE])
      const handler = synth.addEventListener.mock.calls[0][1]
      handler()

      expect(voice.isAvailable()).toBe(true)
      expect(onChange).toHaveBeenCalledWith(true)
    })

    it('getVoices() 第一次就有清單時，init() 立刻可用，且不註冊 voiceschanged 監聽', () => {
      synth.getVoices.mockReturnValue([ZH_TW_VOICE])
      const voice = createVoiceFeedback()
      const onChange = vi.fn()

      voice.init(onChange)

      expect(voice.isAvailable()).toBe(true)
      expect(onChange).toHaveBeenCalledWith(true)
      expect(synth.addEventListener).not.toHaveBeenCalled()
    })

    it('挑選 voice：精準命中 zh-TW，即使陣列裡 zh-CN 排在前面（不是「第一個 zh-* 就選」）', () => {
      synth.getVoices.mockReturnValue([
        { lang: 'zh-CN', name: 'Cn' },
        { lang: 'zh-TW', name: 'Tw' },
      ])
      const voice = createVoiceFeedback()
      voice.init()
      expect(voice.isAvailable()).toBe(true)

      // 用行為驗證挑中的是哪一顆：speak 出去的 utterance.lang 應該是 zh-TW
      voice.setEnabled(true)
      voice.primeFromGesture()
      voice.speak('測試', 1)
      const u = synth.speak.mock.calls.at(-1)[0]
      expect(u.lang).toBe('zh-TW')
    })

    it('沒有 zh-TW 時退而求其次接受任何 zh-* 開頭', () => {
      synth.getVoices.mockReturnValue([{ lang: 'zh-Hans-CN', name: 'Hans' }])
      const voice = createVoiceFeedback()
      voice.init()
      expect(voice.isAvailable()).toBe(true)
    })

    it('完全沒有中文 voice 時 isAvailable() 為 false，speak() 一律短路回 false', () => {
      synth.getVoices.mockReturnValue([{ lang: 'en-US', name: 'Sam' }])
      const voice = createVoiceFeedback()
      voice.init()
      voice.setEnabled(true)
      voice.primeFromGesture()
      synth.speak.mockClear() // 排除 primeFromGesture 那一次暖機呼叫

      expect(voice.isAvailable()).toBe(false)
      expect(voice.speak('提示', 1)).toBe(false)
      expect(synth.speak).not.toHaveBeenCalled()
    })
  })

  describe('primeFromGesture()：iOS 手勢解鎖', () => {
    it('同步呼叫 speechSynthesis.speak 一次靜音 utterance', () => {
      const voice = createVoiceFeedback()
      voice.primeFromGesture()
      expect(synth.speak).toHaveBeenCalledTimes(1)
      const u = synth.speak.mock.calls[0][0]
      expect(u.volume).toBe(0)
    })

    it('重複呼叫是 idempotent：只會真正暖機一次', () => {
      const voice = createVoiceFeedback()
      voice.primeFromGesture()
      voice.primeFromGesture()
      voice.primeFromGesture()
      expect(synth.speak).toHaveBeenCalledTimes(1)
    })

    it('沒有 speechSynthesis 時不噴例外', () => {
      uninstallGlobals()
      const voice = createVoiceFeedback()
      expect(() => voice.primeFromGesture()).not.toThrow()
    })
  })

  describe('speak()：四個必要前提缺一不可（enabled／available／primed／text）', () => {
    function readyVoice() {
      synth.getVoices.mockReturnValue([ZH_TW_VOICE])
      const voice = createVoiceFeedback()
      voice.init()
      return voice
    }

    it('預設 isEnabled() 為 false；未 setEnabled(true) 時 speak() 回 false 且不觸發 synth.speak', () => {
      const voice = readyVoice()
      voice.primeFromGesture()
      synth.speak.mockClear() // 排除 primeFromGesture 那一次暖機呼叫
      expect(voice.isEnabled()).toBe(false)
      expect(voice.speak('提示文字', 1)).toBe(false)
      expect(synth.speak).not.toHaveBeenCalled()
    })

    it('setEnabled(true) 但尚未 primeFromGesture() 時 speak() 回 false', () => {
      const voice = readyVoice()
      voice.setEnabled(true)
      expect(voice.speak('提示文字', 1)).toBe(false)
      expect(synth.speak).not.toHaveBeenCalled()
    })

    it('文字為空字串／null／undefined 時一律回 false，不呼叫 synth.speak', () => {
      const voice = readyVoice()
      voice.setEnabled(true)
      voice.primeFromGesture()
      synth.speak.mockClear() // 排除 primeFromGesture 那一次

      expect(voice.speak('', 1)).toBe(false)
      expect(voice.speak(null, 1)).toBe(false)
      expect(voice.speak(undefined, 1)).toBe(false)
      expect(synth.speak).not.toHaveBeenCalled()
    })

    it('四個前提都滿足時，speak() 回 true 並呼叫 synth.speak', () => {
      const voice = readyVoice()
      voice.setEnabled(true)
      voice.primeFromGesture()
      synth.speak.mockClear()

      expect(voice.speak('偵測到姿勢', 1)).toBe(true)
      expect(synth.speak).toHaveBeenCalledTimes(1)
    })

    it('文字超過 15 字會被截斷到剛好 15 字；15 字以下原樣不動', () => {
      const voice = readyVoice()
      voice.setEnabled(true)
      voice.primeFromGesture()
      synth.speak.mockClear()

      voice.speak('一二三四五六七八九十一二三四五六七八九十', 1) // 20 字
      const u1 = synth.speak.mock.calls.at(-1)[0]
      expect(u1.text.length).toBe(15)
      expect(u1.text).toBe('一二三四五六七八九十一二三四五')

      synth.speaking = false
      voice.speak('剛好十五字剛好十五字剛好十五字', 1) // 15 字
      const u2 = synth.speak.mock.calls.at(-1)[0]
      expect(u2.text.length).toBe(15)
    })
  })

  describe('speak()：單槽播放＋優先權搶佔', () => {
    function readyEnabledVoice() {
      synth.getVoices.mockReturnValue([ZH_TW_VOICE])
      const voice = createVoiceFeedback()
      voice.init()
      voice.setEnabled(true)
      voice.primeFromGesture()
      synth.speak.mockClear()
      return voice
    }

    it('沒有東西在播（synth.speaking=false）時，任何優先權都能直接開口', () => {
      const voice = readyEnabledVoice()
      synth.speaking = false
      expect(voice.speak('第一句', 1)).toBe(true)
      expect(synth.cancel).not.toHaveBeenCalled()
    })

    it('同優先權：正在播放時直接丟棄，不搶佔、不排隊', () => {
      const voice = readyEnabledVoice()
      synth.speaking = false
      voice.speak('第一句', 2)
      synth.speaking = true // 模擬瀏覽器現在正在念

      expect(voice.speak('第二句', 2)).toBe(false)
      expect(synth.cancel).not.toHaveBeenCalled()
      expect(synth.speak).toHaveBeenCalledTimes(1) // 只有第一句真的送出去
    })

    it('更低優先權：正在播放時直接丟棄', () => {
      const voice = readyEnabledVoice()
      synth.speaking = false
      voice.speak('安全提示', 4)
      synth.speaking = true

      expect(voice.speak('魔王台詞', 1)).toBe(false)
      expect(synth.speak).toHaveBeenCalledTimes(1)
    })

    it('更高優先權：正在播放時搶佔——先 cancel() 再 speak() 新的一句', () => {
      const voice = readyEnabledVoice()
      synth.speaking = false
      voice.speak('魔王台詞', 1)
      synth.speaking = true

      expect(voice.speak('安全提示', 4)).toBe(true)
      expect(synth.cancel).toHaveBeenCalledTimes(1)
      expect(synth.speak).toHaveBeenCalledTimes(2)
      const u = synth.speak.mock.calls.at(-1)[0]
      expect(u.text).toBe('安全提示')
    })

    it('utterance 的 onend 觸發後，currentPriority 歸零——即使瀏覽器慢半拍、speaking 仍回報 true，下一句同優先權也能搶佔播出', () => {
      const voice = readyEnabledVoice()
      synth.speaking = false
      voice.speak('第一句', 2)
      const firstUtterance = synth.speak.mock.calls.at(-1)[0]

      synth.speaking = true // 模擬「還在播」
      expect(voice.speak('第二句', 2)).toBe(false) // 同優先權，這時候還在播，丟棄
      expect(synth.speak).toHaveBeenCalledTimes(1)

      // 模擬第一句其實已經念完，只是瀏覽器的 speaking 旗標更新得比 onend 晚
      firstUtterance.onend()
      expect(voice.speak('第三句', 2)).toBe(true) // currentPriority 已重置為 -1，2 > -1 可以搶佔
      expect(synth.cancel).toHaveBeenCalledTimes(1)
      expect(synth.speak).toHaveBeenCalledTimes(2)
    })

    it('utterance 的 onerror 觸發後，currentPriority 同樣歸零', () => {
      const voice = readyEnabledVoice()
      synth.speaking = false
      voice.speak('第一句', 3)
      const firstUtterance = synth.speak.mock.calls.at(-1)[0]

      synth.speaking = true
      firstUtterance.onerror()
      expect(voice.speak('第二句', 3)).toBe(true)
      expect(synth.cancel).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel()', () => {
    it('呼叫 window.speechSynthesis.cancel()，且重置 currentPriority（讓下一句不受舊優先權卡住）', () => {
      synth.getVoices.mockReturnValue([ZH_TW_VOICE])
      const voice = createVoiceFeedback()
      voice.init()
      voice.setEnabled(true)
      voice.primeFromGesture()
      synth.speak.mockClear()

      synth.speaking = false
      voice.speak('第一句', 3)
      synth.speaking = true // 模擬瀏覽器仍回報在播放

      voice.cancel()
      expect(synth.cancel).toHaveBeenCalledTimes(1)

      // currentPriority 已被 cancel() 重置為 -1；就算 synth.speaking 仍為 true
      // （模擬瀏覽器狀態更新的空窗），同優先權也不該再被舊值卡住
      expect(voice.speak('第二句', 3)).toBe(true)
    })

    it('沒有 speechSynthesis 時呼叫 cancel() 不噴例外', () => {
      uninstallGlobals()
      const voice = createVoiceFeedback()
      expect(() => voice.cancel()).not.toThrow()
    })
  })

  describe('setEnabled()／isEnabled()', () => {
    it('預設 isEnabled() 為 false', () => {
      const voice = createVoiceFeedback()
      expect(voice.isEnabled()).toBe(false)
    })

    it('setEnabled(true) 之後 isEnabled() 為 true', () => {
      const voice = createVoiceFeedback()
      voice.setEnabled(true)
      expect(voice.isEnabled()).toBe(true)
    })

    it('setEnabled(false) 會呼叫 cancel()（立刻打斷正在播放的語音）', () => {
      const voice = createVoiceFeedback()
      const cancelSpy = vi.spyOn(voice, 'cancel')
      voice.setEnabled(true)
      voice.setEnabled(false)
      expect(cancelSpy).toHaveBeenCalledTimes(1)
      expect(voice.isEnabled()).toBe(false)
    })

    it('setEnabled(true) 不會呼叫 cancel()', () => {
      const voice = createVoiceFeedback()
      const cancelSpy = vi.spyOn(voice, 'cancel')
      voice.setEnabled(true)
      expect(cancelSpy).not.toHaveBeenCalled()
    })
  })
})
