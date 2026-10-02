// @vitest-environment jsdom
//
// 展場輪流玩：**第一位訪客之後的每一位都是「第二場」**。
//
// 第 5 輪修的 blocking 問題整條路徑是：`endBattle()` 把鏡頭 setEnabled(false)
// → 使用者按「開始」→ `boot()` 因為 `state.booted` 早退（那是刻意的，重跑會
// 連 `inference.init()` 一起重跑、重建 MediaPipe task）→ `App.vue` 直接把
// screen 設成 'calibrate' → `CalibrationWizard` 全檔沒有任何 start()/resume()
// → **沒有任何人把鏡頭打開**。校準畫面對著一台關掉的鏡頭，第二位訪客之後
// 誰都玩不了。
//
// 這個檔案跟 session.cameraRace.test.js 一樣**刻意不 mock cameraCapture.js**
// （只 mock getUserMedia 這個瀏覽器 API 邊界），斷言的終點是狀態：track 是不是
// live 且 enabled、`videoEl.srcObject` 有沒有被指派、第二場的魔王血量有沒有
// 真的在掉——不是「有沒有呼叫某個函式」。
import { describe, it, expect, vi } from 'vitest'
import { DEMO } from '../core/battleConfig.js'

let currentTrack = null
let gumCalls = 0

function makeFakeTrack() {
  return {
    kind: 'video',
    enabled: true,
    readyState: 'live',
    onended: null,
    stop() { this.readyState = 'ended' },
  }
}

Object.defineProperty(navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn(async () => {
      gumCalls += 1
      currentTrack = makeFakeTrack()
      return { getTracks: () => [currentTrack], getVideoTracks: () => [currentTrack] }
    }),
  },
  configurable: true,
})

// 推論 mock 會真的「看」那條 track：track 被 disable 的時候送出的是黑影格，
// 偵測不到任何東西，所以 metrics.valid 是 false。這一步是這個檔案的關鍵——
// 沒有它，下面「第二場真的會計分」的斷言就只是在測 store 的旗標，跟鏡頭到底
// 有沒有開完全脫鉤（而鏡頭沒開正是我們要抓的那個 bug）。有了它，鏡頭沒打開
// 時新鮮度看門狗會在 2 秒內判定不健康、計分凍結，跟真機上的症狀一致。
function poseResult() {
  return { key: 'pose', metrics: { valid: Boolean(currentTrack?.enabled), neckRatio: 1, shoulderWidth: 0.3 }, latencyMs: 1 }
}
function faceResult() {
  return { key: 'face', metrics: { valid: Boolean(currentTrack?.enabled), eyeClosed: false, gaze: 'center' }, latencyMs: 1 }
}
let stepTick = 0

vi.mock('../core/inferenceService.js', () => ({
  createInferenceService: vi.fn(() => ({
    init: async () => ({ ok: true }),
    step: async () => { stepTick += 1; return stepTick % 2 === 0 ? poseResult() : faceResult() },
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

// 手動驅動的 rAF ＋ 假時鐘（跟 session.test.js 同一套手法，逐幀可控）。
let pendingFrame = null
vi.stubGlobal('requestAnimationFrame', (cb) => { pendingFrame = cb; return 1 })
vi.stubGlobal('cancelAnimationFrame', () => { pendingFrame = null })
let clock = 0
vi.spyOn(performance, 'now').mockImplementation(() => clock)
function advance(ms) { clock += ms }
async function driveFrame() {
  const cb = pendingFrame
  pendingFrame = null
  if (cb) await cb(performance.now())
}
/** 打 seconds 秒的戰鬥（每幀 500ms，跟 pose 2fps 的節奏一致）。 */
async function fight(seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    advance(500)
    await driveFrame()
  }
}

const PROFILE = { baselineNeckRatio: 1, baselineShoulderWidth: 0.3, calibratedAt: 0 }

const { useSession } = await import('./session.js')

describe('展場輪流玩：第二位訪客開始的每一場（第 5 輪 blocking）', () => {
  it('第一場結束 → 按「開始」→ 校準畫面的鏡頭必須是 live 且 enabled，而且第二場真的會計分', async () => {
    const session = useSession()
    const videoEl = document.createElement('video')
    videoEl.play = vi.fn(async () => {}) // jsdom 的 HTMLMediaElement.play() 預設丟「Not implemented」

    // ---------- 第一位訪客 ----------
    expect((await session.boot(videoEl)).ok).toBe(true)
    expect(gumCalls).toBe(1)

    // 【分任務校準】：權限之後先選任務，校準排在後面（校準的姿勢指示依賴
    // 任務類型）。任務設定畫面沒有用到鏡頭，就不該亮著。
    session.enterTaskSelect()
    expect(session.state.screen).toBe('task')
    expect(currentTrack.enabled).toBe(false)

    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
    session.enterCalibration()
    expect(session.state.screen).toBe('calibrate')
    expect(currentTrack.readyState).toBe('live')
    expect(currentTrack.enabled).toBe(true) // 校準要照鏡子，鏡頭一定要開
    expect(videoEl.srcObject).not.toBeNull()

    // 校準完成 → 直接開打（不再回任務畫面），鏡頭一路開著不必再關再開。
    session.setCalibration(PROFILE)
    await session.startBattle()
    expect(currentTrack.enabled).toBe(true)

    await fight(3)
    expect(session.state.inferenceHealthy).toBe(true)
    expect(session.state.battle.elapsedMs).toBeGreaterThan(0)
    expect(session.state.battle.bossHp).toBeLessThan(DEMO.bossHp)

    await session.endBattle('aborted')
    expect(session.state.screen).toBe('stats')
    // 隱私紅線：UI 不在使用鏡頭時，鏡頭不得處於 live 且 enabled。
    // （track 停在 'live' 是刻意的設計——暫停／結束用 setEnabled 而不是 stop()，
    // 才不必每次都重新要一次權限；真正的紅線是 enabled。）
    expect(currentTrack.enabled).toBe(false)
    expect(currentTrack.readyState).toBe('live')

    // ---------- 第二位訪客：按「開始」 ----------
    const again = await session.boot(videoEl)
    expect(again.ok).toBe(true)
    // boot() 因為 state.booted 早退——這是刻意的（重跑會連 inference.init()
    // 一起重跑、重建 MediaPipe task 並累積 GPU 記憶體），所以既沒有新的
    // getUserMedia，也沒有任何人會順手把鏡頭打開。
    expect(gumCalls).toBe(1)

    // 第二位訪客一樣先選任務、再校準（新流程）。
    session.enterTaskSelect()
    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
    session.enterCalibration()
    expect(session.state.screen).toBe('calibrate')
    // ↓ 這三條就是第 5 輪修的東西本身。在修之前：track 是 live 但 enabled=false，
    //   校準畫面對著一台關掉的鏡頭，第二位訪客之後誰都玩不了。
    expect(currentTrack.readyState).toBe('live')
    expect(currentTrack.enabled).toBe(true)
    expect(videoEl.srcObject).not.toBeNull()
    expect(gumCalls).toBe(1) // 而且是「重新啟用」不是「重開」：沒有再要一次權限

    // ---------- 第二場真的打得起來 ----------
    session.setCalibration(PROFILE)
    await session.startBattle()
    expect(session.state.screen).toBe('battle')
    expect(currentTrack.enabled).toBe(true)

    const bossAtStart = session.state.battle.bossHp
    await fight(3)

    expect(session.state.inferenceHealthy).toBe(true) // 鏡頭沒開的話這裡會是 false（黑影格 → 新鮮度看門狗）
    expect(session.state.cameraHealthy).toBe(true)
    expect(session.state.battle.elapsedMs).toBeGreaterThan(0) // 計分沒有凍結
    expect(session.state.battle.bossHp).toBeLessThan(bossAtStart) // 魔王真的在掉血

    session.teardown()
    expect(currentTrack.readyState).toBe('ended') // 卸載時才真的 stop()
  })

  it('上一位訪客在「暫停中」把 iPad 交出去、下一位直接按「結束」：校準畫面一樣要有鏡頭', async () => {
    const session = useSession()
    const videoEl = document.createElement('video')
    videoEl.play = vi.fn(async () => {})

    expect((await session.boot(videoEl)).ok).toBe(true)
    const gumAtBoot = gumCalls

    session.enterTaskSelect()
    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
    session.enterCalibration()
    session.setCalibration(PROFILE)
    await session.startBattle()
    await fight(1)

    await session.togglePause() // 上一位按暫停就把 iPad 交出去了
    expect(currentTrack.enabled).toBe(false)

    await session.endBattle('aborted') // 下一位直接按「結束」
    expect(session.state.screen).toBe('stats')
    expect(session.state.paused).toBe(true) // endBattle() 刻意不重設它
    expect(currentTrack.enabled).toBe(false)

    expect((await session.boot(videoEl)).ok).toBe(true) // 按「開始」
    session.enterTaskSelect()
    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
    session.enterCalibration()

    // 校準畫面沒有任何狀態是「鏡頭該關著」的——包含上一場遺留的 paused=true。
    // 這也是把 calibrate 納入判準（而不是只在某一條路徑補一行 setEnabled）的
    // 具體好處：殘留旗標影響不到它。
    expect(session.state.screen).toBe('calibrate')
    expect(currentTrack.readyState).toBe('live')
    expect(currentTrack.enabled).toBe(true)
    expect(gumCalls).toBe(gumAtBoot) // 沒有重新要一次權限

    session.teardown()
  })
})
