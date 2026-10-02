// @vitest-environment jsdom
//
// 獨立檔案，理由跟 session.secondSession.test.js 一樣：session.js 是模組級
// 單例，這裡只關心語音那幾條接線（voice.init()／state.voiceAvailable／
// toggleVoice()／primeVoiceFromGesture()／teardown() 的語音清理），用一份
// 全新、乾淨的 mock 環境，不必跟 session.test.js 那個大檔案的既有測試順序
// 互相牽扯。
//
// fix round（測試鑑別力 I-1／Ruling CH(b)）：這個檔案原本跟 session.test.js
// 一樣，讓所有測試共用**同一個** session 單例依序執行——註解裡還留著
// 「這裡從上一則測試結束時的『開』切回『關』」「上一則測試結束時停在
// 'hidden'」這種明文的前後相依。後果是 `--sequence.shuffle` 下這個檔案穩定
// 紅 3～6 條，而且更糟的是：**平常綠的那幾條，綠的原因有一部分來自前一條
// 測試留下的狀態**，不是來自它自己驗的那件事。
//
// 改法：每條測試用 `vi.resetModules()` 拿一個**真正全新**的 session.js 模組
// 實例（連同它內部那些從外面碰不到的模組級變數：camGen／frameGen／fsm／
// perf／unhealthySince…），再自己把需要的前置狀態明確建立起來。
// 這個檔案因此不再有任何跨測試的隱藏前提——`--sequence.shuffle` 下全綠。
//
// 代價誠實記錄：每條測試都要重跑一次 boot()（多幾毫秒），而且 `voiceEnabled
// 預設為 false` 那條從「碰巧是第一條所以看得到初始值」變成**真的**在驗初始值。
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'

vi.mock('../core/cameraCapture.js', () => ({
  createCameraCapture: vi.fn(() => ({
    start: async () => ({ ok: true }),
    stop: () => {},
    setEnabled: () => {},
    resume: async () => true,
  })),
}))

vi.mock('../core/inferenceService.js', () => ({
  createInferenceService: vi.fn(() => ({
    init: async () => ({ ok: true }),
    step: async () => null,
    setScale: () => {},
    setEnabled: () => {},
    actualFps: () => 0,
    latencyEma: () => 0,
    isReady: () => true,
    health: () => ({
      pose: { consecutiveFailures: 0, lastErrorName: null },
      face: { consecutiveFailures: 0, lastErrorName: null },
      object: { consecutiveFailures: 0, lastErrorName: null },
    }),
    destroy: () => {},
  })),
}))

vi.stubGlobal('requestAnimationFrame', () => 1)
vi.stubGlobal('cancelAnimationFrame', () => {})

/** jsdom 沒有 speechSynthesis／SpeechSynthesisUtterance，最小的假瀏覽器實作。
 *  getVoices() 一開始就回傳 zh-TW，讓 voice.init() 不必等 voiceschanged 就能
 *  同步判定可用——這裡要驗的是 session.js 有沒有正確接線，不是 voiceFeedback
 *  自己的非同步取得邏輯（那在 voiceFeedback.test.js 已經測過)。 */
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

/** 跟 session.test.js 同一套手法：用 document.createEvent 而不是
 *  `new Event(...)`，理由同那邊的註解——不想為了一個測試檔去動共用的
 *  eslint.config.js 全域清單。 */
function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  const ev = document.createEvent('Event')
  ev.initEvent('visibilitychange', true, true)
  document.dispatchEvent(ev)
}

/** 讓 async 的 onVisible() 內部所有 await 都有機會跑完。 */
async function flush() {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

const PROFILE = { baselineNeckRatio: 1, baselineShoulderWidth: 0.3, calibratedAt: 0 }

let ctx = null

/**
 * 一份全新的 session.js 模組實例 ＋ 一份全新的假 speechSynthesis。
 *
 * `vi.resetModules()` 是這裡的關鍵：session.js 的狀態不只有 `state` 這個
 * reactive 物件（那個從外面還碰得到），還有一整排從外面**碰不到**的模組級
 * 變數。少了 resetModules，任何「顯式歸零」都只能歸零看得到的那一半。
 */
async function freshSession() {
  vi.resetModules()
  const synth = installFakeSpeechSynthesis()
  // 每條測試都從「頁面在前景」這個已知起點開始，不繼承上一條的可見性。
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  const { useSession } = await import('./session.js')
  const session = useSession()
  const videoEl = document.createElement('video')
  videoEl.play = vi.fn(async () => {})
  return { session, synth, videoEl }
}

/** 已經 boot 過的 session（語音接線的大多數測試都需要）。 */
async function bootedSession() {
  const c = await freshSession()
  expect((await c.session.boot(c.videoEl)).ok).toBe(true)
  return c
}

/** 已經在打一場戰鬥的 session。 */
async function sessionInBattle() {
  const c = await bootedSession()
  // 【分任務校準】：選任務 → 校準 → 開打（setTask() 必須在校準之前，
  // 校準畫面要靠 state.taskType 決定顯示哪一組姿勢指示）。
  c.session.enterTaskSelect()
  c.session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
  await c.session.enterCalibration()
  c.session.setCalibration(PROFILE)
  await c.session.startBattle()
  expect(c.session.state.screen).toBe('battle')
  return c
}

beforeEach(() => { ctx = null })

afterEach(() => {
  // 一定要 teardown：它會把 visibilitychange／pagehide 的監聽器解掉，
  // 否則被丟棄的舊模組實例會留在 document 上，之後每一條測試的
  // setVisibility() 都會多叫醒幾個殭屍。
  ctx?.session.teardown()
  ctx = null
})

describe('session store：語音單例的接線（voice.init()／toggleVoice()／primeVoiceFromGesture()）', () => {
  it('state.voiceEnabled 預設為 false（不得自作主張幫使用者打開）', async () => {
    ctx = await freshSession()
    expect(ctx.session.state.voiceEnabled).toBe(false)
  })

  it('boot() 成功後呼叫 voice.init()，state.voiceAvailable 反映裝置上找不找得到中文語音', async () => {
    ctx = await freshSession()
    expect(ctx.session.state.voiceAvailable).toBe(false) // boot() 之前還沒 init()
    const r = await ctx.session.boot(ctx.videoEl)
    expect(r.ok).toBe(true)
    expect(ctx.session.state.voiceAvailable).toBe(true) // 假瀏覽器一開始就有 zh-TW voice
  })

  it('primeVoiceFromGesture() 之後、toggleVoice() 打開，session.voice().speak() 才真的會呼叫瀏覽器 TTS', async () => {
    ctx = await bootedSession()
    const { session, synth } = ctx
    // 開語音之前：就算暖機過，enabled 還是預設 false，speak() 短路。
    session.primeVoiceFromGesture()
    synth.speak.mockClear() // 排除暖機那一次
    expect(session.voice().speak('測試提示', 1)).toBe(false)
    expect(synth.speak).not.toHaveBeenCalled()

    session.toggleVoice()
    expect(session.state.voiceEnabled).toBe(true)
    expect(session.voice().speak('測試提示', 1)).toBe(true)
    expect(synth.speak).toHaveBeenCalledTimes(1)
  })

  /**
   * 【分任務校準】：新流程在「暖機」與「第一句真正的台詞」之間插進了一整段
   * 校準（最少 5 秒），這條測試就是那件事的護欄。
   *
   * iOS 的規則是「**第一次** speak() 有沒有落在使用者手勢的同步呼叫堆疊內」，
   * 不是「speak() 跟手勢隔了多久」——所以理論上插一段校準不影響。但這條推理
   * 的價值在於它是**可以被實作打破的**：`enterCalibration()`／`startBattle()`
   * 這條路上只要有人加一行 `voice.cancel()`／重建 voiceFeedback 單例／
   * `speechSynthesis.cancel()` 之外的清理，暖機就白做了，而症狀是**整場無聲、
   * 不丟例外、不進 onerror**——這個專案最查不出來的那一類失效。
   *
   * 所以這裡走完整條新流程再 speak()，而不是只斷言 `primed` 這個旗標。
   */
  it('【分任務校準】暖機 → 選任務 → 校準（隔了一整段）→ 戰鬥：speak() 仍然打得到瀏覽器 TTS', async () => {
    ctx = await bootedSession()
    const { session, synth } = ctx
    session.enterTaskSelect()

    // TaskSelector 的「開始討伐」＝ App.vue onTaskChosen() 的同步第一行。
    session.primeVoiceFromGesture()
    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
    await session.enterCalibration() // ← 新流程多出來的這一段
    expect(session.state.screen).toBe('calibrate')
    session.setCalibration(PROFILE)
    await session.startBattle()
    expect(session.state.screen).toBe('battle')

    session.toggleVoice()
    synth.speak.mockClear() // 排除暖機那一次
    expect(session.voice().speak('魔王受傷了', 1), '校準隔在中間不得讓暖機失效').toBe(true)
    expect(synth.speak).toHaveBeenCalledTimes(1)

    await session.endBattle('aborted')
  })

  it('toggleVoice() 關閉時會立刻打斷正在播放的語音（voiceFeedback.setEnabled(false) 內建的 cancel）', async () => {
    ctx = await bootedSession()
    const { session, synth } = ctx
    session.toggleVoice() // 先打開，建立這條測試自己的前置狀態
    expect(session.state.voiceEnabled).toBe(true)

    synth.cancel.mockClear()
    session.toggleVoice() // 再關掉
    expect(session.state.voiceEnabled).toBe(false)
    expect(synth.cancel).toHaveBeenCalledTimes(1)
  })

  it('session.voice() 每次呼叫都回傳同一個單例（不是每次呼叫都重新建立一份）', async () => {
    ctx = await freshSession()
    expect(ctx.session.voice()).toBe(ctx.session.voice())
  })

  /**
   * 複審 Task 15 fix round 1（Important 2）：session.js 原本就有三處
   * `window.speechSynthesis?.cancel?.()`（onHidden()／onVisible()／
   * endBattle()），但全專案沒有任何測試安裝假 speechSynthesis 並斷言它們
   * 真的呼叫了 cancel()——只有「speechSynthesis 是 undefined 時 optional
   * chaining 不會噴例外」這種消極保證。日後有人重構刪掉其中一處，不會有任何
   * 測試變紅。下面四條各自補上，並且都用 mockClear() 把前一步的呼叫次數歸零，
   * 確保斷言咬住的是「這一次呼叫剛好觸發的那一次 cancel()」。
   */
  it('onHidden()（切背景）會打斷正在播放的語音', async () => {
    ctx = await bootedSession()
    const { synth } = ctx
    synth.cancel.mockClear()
    setVisibility('hidden')
    expect(synth.cancel).toHaveBeenCalledTimes(1)
  })

  it('onVisible()（回到前景）也會打斷正在播放的語音——防止 iOS 背景期間卡住的語音佇列在回前景時繼續講', async () => {
    ctx = await bootedSession()
    const { synth } = ctx
    setVisibility('hidden') // 這條測試自己把頁面送進背景，不靠前一條留下的狀態
    await flush()

    synth.cancel.mockClear()
    setVisibility('visible')
    await flush() // onVisible() 是 async
    expect(synth.cancel).toHaveBeenCalledTimes(1)
  })

  /**
   * Task 15 複審 fix round 1（Minor）：togglePause() 刻意不打斷語音的設計
   * 決定目前只有註解、沒有測試——補一條負向測試鎖住它，日後若有人重構誤加
   * 一行 cancel()，這裡會變紅。
   */
  it('togglePause()（暫停）刻意不打斷語音——語音一句最長 15 字，正常語速一兩秒內自然念完，暫停這種可能一秒內就復原的操作沒有必要打斷', async () => {
    ctx = await sessionInBattle()
    const { session, synth } = ctx

    synth.cancel.mockClear()
    await session.togglePause() // 暫停
    expect(session.state.paused).toBe(true)
    expect(synth.cancel).not.toHaveBeenCalled()
  })

  it('endBattle() 會打斷正在播放的語音——既有三個 cancel 呼叫點中的最後一個', async () => {
    ctx = await sessionInBattle()
    const { session, synth } = ctx

    synth.cancel.mockClear()
    await session.endBattle('aborted')
    expect(session.state.screen).toBe('stats')
    expect(synth.cancel).toHaveBeenCalledTimes(1)
  })

  it('teardown() 會打斷正在播放的語音（跟 onHidden()／onVisible()／endBattle() 同一條規則的第四個補齊點）', async () => {
    ctx = await bootedSession()
    const { session, synth } = ctx
    session.primeVoiceFromGesture()
    session.toggleVoice() // 打開，讓下面真的有東西在「播放」可以被打斷
    session.voice().speak('這句應該被打斷', 1)
    synth.cancel.mockClear()

    session.teardown()
    expect(synth.cancel).toHaveBeenCalledTimes(1)
    ctx = null // 已經 teardown 過，afterEach 不必再來一次
  })
})
