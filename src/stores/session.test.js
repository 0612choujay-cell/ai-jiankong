// @vitest-environment jsdom
//
// 這個檔案裡的測試刻意共用同一個 session 單例、依序執行（不是彼此獨立的
// beforeEach 全新實例）——session.js 本來就設計成模組級單例（跟真正的 App 一樣，
// 全程只有一個），拆成互不相干的獨立測試反而要為了隔離狀態去繞一堆
// vi.resetModules()，掩蓋掉「這是單例」這個事實本身。閱讀時請照順序看。
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import { createPostureCoach } from '../core/postureCoach.js'
import { createMessageQueue } from '../core/messageQueue.js'
import { DEMO } from '../core/battleConfig.js'

const cameraState = {
  startOk: true, startError: null, resumeOk: true, resumeCalls: 0, stopCalls: 0,
  onEnded: null, // N3：捕捉 boot() 傳進來的 onEnded，測試才能模擬 track.onended 真的觸發
  setEnabledCalls: [], // task-18：backToTaskSelect() 的測試要證明轉場真的走過 setScreen() 的收斂
}
vi.mock('../core/cameraCapture.js', () => ({
  createCameraCapture: vi.fn(({ onEnded } = {}) => {
    cameraState.onEnded = onEnded
    return {
      start: async () => (cameraState.startOk ? { ok: true } : { ok: false, error: cameraState.startError }),
      stop: () => { cameraState.stopCalls += 1 },
      setEnabled: (v) => { cameraState.setEnabledCalls.push(v) },
      readyState: () => 'live',
      isRunning: () => true,
      resume: async () => { cameraState.resumeCalls += 1; return cameraState.resumeOk },
    }
  }),
}))

// storageService 只**局部**替換 clearAll()（Task 22c）：其餘 saveSession／
// listSessions／reconcile／writeCrumb／clearCrumb 維持真實實作，因為這個檔案
// 既有的測試全部寫在「jsdom 沒有 IndexedDB，所以那幾個呼叫本來就會失敗並被
// catch」這個前提上——整包換成假的 storage 會悄悄改掉那些測試的前提，
// 那正是 Ruling CH(a) 說的「紅的是別人的護欄」的反面：綠的也可能是別人的假設。
// listSessions() 也換成可控版本（裁決 3 的測試需要「資料庫裡真的還有上一位
// 訪客的紀錄」這個前提——jsdom 沒有 IndexedDB，真實版本只會 reject，那樣
// 「history 是空的」會變成恆真的假陽性，分不出是旗標生效還是讀取失敗）。
// 預設回傳空陣列，等同於原本那些測試看到的結果（讀取失敗 → history 清空），
// 只是不再順帶寫 historyError；沒有任何既有測試斷言那個欄位。
const storageState = {
  clearAllShouldThrow: false,
  clearAllCalls: 0,
  listSessionsResult: [],
  listSessionsCalls: 0,
}
vi.mock('../core/storageService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    clearAll: async () => {
      storageState.clearAllCalls += 1
      if (storageState.clearAllShouldThrow) throw new Error('blocked')
      return true
    },
    listSessions: async () => {
      storageState.listSessionsCalls += 1
      return storageState.listSessionsResult
    },
  }
})

const defaultHealth = () => ({
  pose: { consecutiveFailures: 0, lastErrorName: null },
  face: { consecutiveFailures: 0, lastErrorName: null },
  object: { consecutiveFailures: 0, lastErrorName: null },
})

// 預設的「保持存活」序列：依序交替回傳 pose／face 的有效資料，讓新鮮度門檻
// （FRESHNESS_TIMEOUT_MS）在沒有測試刻意搗亂時維持滿足——這樣每條測試才能
// 只操縱它自己關心的那個變因（health() 的例外次數、object 的 phoneVisible……），
// 不必每條都重新處理「怎麼餵資料才不會被新鮮度門檻誤傷」這件事。
const POSE_VALID = { key: 'pose', metrics: { valid: true, neckRatio: 1, shoulderWidth: 0.3 }, latencyMs: 1 }
const FACE_VALID = { key: 'face', metrics: { eyeClosed: false, gaze: 'center', valid: true }, latencyMs: 1 }
let keepAliveTick = 0
function keepAliveStep() {
  keepAliveTick += 1
  return keepAliveTick % 2 === 0 ? POSE_VALID : FACE_VALID
}

const inferenceState = {
  initOk: true, initError: null, stepResult: keepAliveStep, health: defaultHealth, destroyCalls: 0,
  enabledCalls: [], // [key, enabled] 每次呼叫 setEnabled() 的記錄，F5 用來鎖住「暫停時關推論 track」
  scaleCalls: [], // 每次呼叫 setScale() 的記錄，Task 16 降檔測試用來鎖住「真的呼叫了 setScale(0.5)」
  latencyEmaValue: 0, // Task 16：可由測試調整，模擬 perfMonitor 的降檔觸發條件
}
function resetInferenceMock() {
  inferenceState.stepResult = keepAliveStep
  inferenceState.health = defaultHealth
  inferenceState.latencyEmaValue = 0
}

vi.mock('../core/inferenceService.js', () => ({
  createInferenceService: vi.fn(() => ({
    init: async () => (inferenceState.initOk ? { ok: true } : { ok: false, error: inferenceState.initError }),
    step: async () => (typeof inferenceState.stepResult === 'function' ? inferenceState.stepResult() : inferenceState.stepResult),
    setScale: (s) => { inferenceState.scaleCalls.push(s) },
    setEnabled: (key, enabled) => { inferenceState.enabledCalls.push([key, enabled]) },
    actualFps: () => 0,
    latencyEma: () => inferenceState.latencyEmaValue,
    isReady: () => true,
    health: () => inferenceState.health(),
    destroy: () => { inferenceState.destroyCalls += 1 },
  })),
}))

// 手動控制的 rAF：不讓迴圈自己跑，改由測試逐幀 driveFrame()，
// 同時用假的 performance.now() 讓「經過的時間」完全可控、可重現。
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

/** 讓 async 的 onVisible()/onHidden() 內部所有 await 都有機會跑完。 */
async function flush() {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  // 用 document.createEvent 而不是 `new Event(...)`：專案的 eslint 全域清單
  // 沒有列 Event，這裡不想為了一個測試檔去動共用的 eslint.config.js。
  const ev = document.createEvent('Event')
  ev.initEvent('visibilitychange', true, true)
  document.dispatchEvent(ev)
}

// fix round（測試鑑別力 I-1／Ruling CH(b) 的可達部分）：這幾個替身狀態原本是
// 檔案級的可變變數，從頭到尾沒有人歸零。其中 keepAliveTick 最危險：它決定
// 「下一筆假資料是 pose 還是 face」，而**任何人在中間插入一條新測試**都會讓
// 它之後每一條測試拿到相反的那一種——症狀是某條不相干的測試突然變紅，而且
// 看起來跟它自己驗的事情毫無關係。這個 beforeEach 讓每條測試從已知的替身
// 起點開始（session.js 那個模組級單例本身的殘留是另一回事，見檔頭說明）。
beforeEach(() => {
  keepAliveTick = 0
  resetInferenceMock()
  inferenceState.enabledCalls.length = 0
  inferenceState.scaleCalls.length = 0
  cameraState.setEnabledCalls.length = 0
})

const { useSession } = await import('./session.js')

describe('session store：boot → calibrate → battle → teardown', () => {
  const session = useSession()
  const videoEl = document.createElement('video')

  /**
   * 複審 I-2 的護欄。`state.bootError` 曾經是全 store 唯一一條把**整顆原始
   * Error**（message + stack 俱全）放進 reactive state 的路徑；其他五條錯誤
   * 路徑都在捕捉當下收斂成 `error.name`。
   *
   * 為什麼裝在這一層（Ruling DK）：違規發生在 `session.js` 的賦值那一行，
   * 不在畫面上。複審把護欄的缺口示範得很清楚——它在 App.vue 加
   * `{{ s.bootError?.message }}` ＋ `:title="s.bootError?.stack"`，666/666 全綠，
   * 因為 `App.mount.test.js` 的 fixture 是 `bootError: null`，`UNDECLARED_FIELD_CANARY`
   * 只攔頂層未宣告欄位，巢狀的 `.message`／`.stack` 在 fixture 裡根本不存在。
   * 也就是說：**這條線在畫面層測不到**，只有在寫進 state 的那一刻測得到。
   *
   * 哨兵訊息刻意寫得很好認：一旦有人把這兩行改回存整顆 Error，
   * 下面的 `toBe(name)` 會直接拿到一個 Error 物件而紅。
   */
  const BOOT_ERROR_CANARY = 'BOOT-ERROR-MESSAGE-CANARY'

  function namedError(name) {
    const e = new Error(BOOT_ERROR_CANARY)
    e.name = name
    return e
  }

  /**
   * 這個檔案的測試共用同一個 session 單例、依序執行（見檔頭），所以「把
   * 假的失敗設定還原」不能寫在斷言後面的裸語句——斷言一紅，那幾行就不會跑，
   * 殘留的 `startOk = false` 會讓**後面每一條**測試跟著紅。那正是 Ruling CH (b)
   * 說的第二種假紅，而且它會讓突變驗證的紅燈數字失去意義（實測：少了這個
   * finally，一個 I-2 的突變會製造 20 條紅，看不出哪一條才是真的接住它）。
   */
  async function withBootFailure(setup, body) {
    setup()
    try {
      await body()
    } finally {
      cameraState.startOk = true
      cameraState.startError = null
      inferenceState.initOk = true
      inferenceState.initError = null
    }
  }

  it('boot() 失敗時 bootError 只留 error.name（不是整顆 Error），不設定 booted', async () => {
    await withBootFailure(() => {
      cameraState.startOk = false
      cameraState.startError = namedError('NotAllowedError')
    }, async () => {
      const r = await session.boot(videoEl)
      expect(r.ok).toBe(false)
      expect(session.state.booted).toBe(false)
      // 隱私紅線：state 裡不得有 message／stack。用 toBe(字串) 而不是
      // toContain／truthy——後兩者放行「Error 物件」與「name＋其他東西」。
      expect(session.state.bootError).toBe('NotAllowedError')
      expect(typeof session.state.bootError).toBe('string')
      // 回傳值可以保留原始物件：那是函式回傳值、不是長期持有的 reactive state，
      // 而 PermissionGate 只讀 `.name`。這一行同時釘住「不要為了修隱私就把
      // PermissionGate 的復原路徑一起弄壞」。
      expect(r.error).toBe(cameraState.startError)
    })
  })

  it('I1 回歸：inference.init() 失敗時要關掉鏡頭，不能讓鏡頭指示燈繼續亮著', async () => {
    await withBootFailure(() => {
      inferenceState.initOk = false
      inferenceState.initError = namedError('ModelLoadError')
    }, async () => {
      const before = cameraState.stopCalls
      const r = await session.boot(videoEl)
      expect(r.ok).toBe(false)
      expect(session.state.booted).toBe(false)
      expect(session.state.bootError).toBe('ModelLoadError') // 同樣只留 name
      expect(cameraState.stopCalls).toBe(before + 1) // 已經用不到鏡頭了，不能讓它繼續開著
    })
  })

  it('隱私紅線：整個 state 走一遍，任何一個欄位都不得夾帶 error.message／stack', async () => {
    // 上面兩條鎖的是 bootError 這個**具名**欄位。這一條鎖的是「這個形狀的
    // 錯誤，不管未來被存進哪一個欄位，都不准帶著 message 進 state」——
    // 複審 I-2 的根因不是 bootError 特別糟，是**沒有任何一條測試在看 state
    // 裡有沒有原始 Error**，所以新增一個 `xxxError` 欄位時不會有人發現。
    await withBootFailure(() => {
      cameraState.startOk = false
      cameraState.startError = namedError('NotAllowedError')
    }, async () => {
      await session.boot(videoEl)

      const seen = new Set()
      const offenders = []
      ;(function walk(value, where) {
        if (value === null || typeof value !== 'object') {
          if (typeof value === 'string' && value.includes(BOOT_ERROR_CANARY)) offenders.push(where)
          return
        }
        if (seen.has(value)) return
        seen.add(value)
        // Error 物件本身就是違規：它的 message／stack 不是一般欄位走訪得到的
        // 可列舉屬性，光靠上面那個字串比對抓不到它。
        if (value instanceof Error) { offenders.push(`${where}（整顆 Error 物件）`); return }
        for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`)
      })(session.state, 'state')

      expect(offenders, '這些欄位把 error.message／stack（或整顆 Error）留在了 reactive state 裡').toEqual([])
    })
  })

  it('boot() 成功後 booted=true；重複呼叫是 no-op（不重建 camera/inference）', async () => {
    const { createCameraCapture } = await import('../core/cameraCapture.js')
    const r = await session.boot(videoEl)
    expect(r.ok).toBe(true)
    expect(session.state.booted).toBe(true)
    const callsBefore = createCameraCapture.mock.calls.length
    await session.boot(videoEl)
    expect(createCameraCapture.mock.calls.length).toBe(callsBefore)
  })

  it('Task 19：enterPermission() 只換畫面到 permission，不繞過 setScreen() 的收斂點', () => {
    session.enterPermission()
    expect(session.state.screen).toBe('permission')
  })

  // 【分任務校準】：流程從「權限 → 校準 → 選任務 → 戰鬥」改成
  // 「權限 → **選任務** → **校準** → 戰鬥」。下面三條照新的順序各鎖一段轉場。
  it('【分任務校準】權限之後的下一站是選任務：enterTaskSelect() 進到 task，而且真的走過 setScreen()', () => {
    expect(session.state.screen).toBe('permission') // 上一條留下的起點
    cameraState.setEnabledCalls.length = 0

    session.enterTaskSelect()

    expect(session.state.screen).toBe('task')
    // 鑑別力所在：走 setScreen() 才會有這一通收斂呼叫。若有人把它改回
    // `state.screen = 'task'` 直寫，畫面終態一模一樣、但一通 setEnabled 都
    // 不會有——那正是這個專案吃過的真實 bug（第二位訪客永遠黑畫面）的形狀。
    expect(cameraState.setEnabledCalls, '轉場必須經過 setScreen() 的鏡頭收斂').toEqual([false])
  })

  it('【分任務校準】選完任務才進校準：enterCalibration() 從 task 進到 calibrate，鏡頭被判準打開', async () => {
    expect(session.state.screen).toBe('task')
    cameraState.setEnabledCalls.length = 0

    await session.enterCalibration()

    expect(session.state.screen).toBe('calibrate')
    // 鐵律二：'calibrate' 在新順序下的答案沒有變——校準畫面左半邊就是鏡像
    // 預覽，使用者看得到也預期得到鏡頭在運作。
    expect(cameraState.setEnabledCalls).toContain(true)
    expect(cameraState.setEnabledCalls).not.toContain(false)
  })

  it('【分任務校準】setCalibration() 只存 profile、不再自己換畫面；setTask 設定任務參數', () => {
    expect(session.state.screen).toBe('calibrate')
    const profile = { baselineNeckRatio: 1, baselineShoulderWidth: 0.3, calibratedAt: Date.now() }
    cameraState.setEnabledCalls.length = 0

    session.setCalibration(profile)

    expect(session.state.profile).toEqual(profile)
    // 舊行為是 setScreen('task')：校準完回任務畫面，再按一次「開始討伐」才
    // 開打。新流程裡任務在進校準之前就選好了，所以這裡不動畫面——換畫面是
    // startBattle() 的事（見 App.vue 的 onCalibrated()）。
    expect(session.state.screen, 'setCalibration() 不得改畫面').toBe('calibrate')
    // 不改畫面，就不該有任何鏡頭收斂、也不該遞增世代號（那會把別人正在飛的
    // 落地者無故作廢）。這一行同時擋住「順手在這裡補一行 setEnabled」。
    expect(cameraState.setEnabledCalls).toEqual([])

    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
    expect(session.state.demoMode).toBe(true)
  })

  it('task-18：backToTaskSelect() 把畫面切回 task，且走 setScreen() 的鏡頭收斂（不是直寫 rawState.screen）', () => {
    // 校準更正 1：App.vue 的 onHome() 不得直寫 session.rawState.screen = 'task'
    // ——那會繞過 cameraShouldBeEnabled() 這個唯一判準。這裡故意先把畫面設成
    // 'battle'（讓 cameraShouldBeEnabled() 判定「該開」），再呼叫
    // backToTaskSelect()，若它真的走 setScreen()，setEnabled(false) 一定會
    // 被呼叫；若有人把它改回直寫 rawState.screen，這裡不會有任何 setEnabled
    // 呼叫，測試就會抓到。
    session.rawState.screen = 'battle'
    cameraState.setEnabledCalls.length = 0

    session.backToTaskSelect()

    expect(session.state.screen).toBe('task')
    expect(cameraState.setEnabledCalls.at(-1)).toBe(false)
  })

  it('startBattle() 切到 battle 畫面，snapshot 為展示模式的初始值，且已排下一幀', async () => {
    await session.startBattle()
    expect(session.state.screen).toBe('battle')
    expect(session.state.battle.ended).toBe(false)
    expect(session.state.battle.bossHp).toBe(DEMO.bossHp)
    expect(pendingFrame).not.toBe(null)
  })

  it('svc.step() 回 null 不代表不健康——排程器判斷還沒到期時本來就會回 null', async () => {
    // pose/face 交錯夾雜 null（EDF 排程器很多幀輪不到某個 key 是常態），
    // 只要新鮮度門檻內還是收得到有效資料，就不該被判定不健康。
    const pattern = [POSE_VALID, null, FACE_VALID, null]
    let i = 0
    inferenceState.stepResult = () => pattern[(i++) % pattern.length]
    for (let n = 0; n < 8; n++) {
      advance(400)
      await driveFrame()
    }
    expect(session.state.inferenceHealthy).toBe(true)
    resetInferenceMock()
  })

  it('face track 連續失敗達門檻後 inferenceHealthy=false 且 elapsedMs 凍結，恢復後才繼續', async () => {
    const before = session.state.battle.elapsedMs
    inferenceState.health = () => ({
      pose: { consecutiveFailures: 0, lastErrorName: null },
      face: { consecutiveFailures: 3, lastErrorName: 'TypeError' },
      object: { consecutiveFailures: 0, lastErrorName: null },
    })
    advance(500)
    await driveFrame()
    expect(session.state.inferenceHealthy).toBe(false)

    const frozenAt = session.state.battle.elapsedMs
    advance(1000)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBe(frozenAt)

    inferenceState.health = defaultHealth
    advance(500)
    await driveFrame()
    expect(session.state.inferenceHealthy).toBe(true)
    advance(500)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBeGreaterThan(before)
    resetInferenceMock()
  })

  // 這兩條分別鎖住 pose 側跟 face 側，而且刻意讓「另一個 track」的資料源源不絕
  // 進來——單獨餵一個 track 沒資料是測不出東西的（第 2 輪審查抓到：原本那條
  // C1 測試只餵 pose、face 完全沒收到任何結果，所以就算把「看門狗只看有沒有
  // 收到、不看 metrics.valid」的漏洞放回去，測試照樣綠，因為判定不健康其實是
  // face 那一路的「完全沒收到」造成的，不是 pose 側 valid:false 的判斷邏輯）。
  it('C1 回歸（pose 側）：pose 持續回傳 valid:false，即使 face 端資料完全正常也會被判定不健康', async () => {
    inferenceState.health = defaultHealth
    const rotation = [
      { key: 'pose', metrics: { valid: false, neckRatio: 0, shoulderWidth: 0 }, latencyMs: 1 },
      FACE_VALID,
    ]
    let i = 0
    inferenceState.stepResult = () => rotation[(i++) % rotation.length]
    for (let n = 0; n < 10; n++) {
      advance(300)
      await driveFrame()
    }
    expect(session.state.inferenceHealthy).toBe(false)
    resetInferenceMock()
    await driveFrame()
    advance(100)
    await driveFrame()
    expect(session.state.inferenceHealthy).toBe(true)
  })

  it('C1 回歸（face 側）：face 持續回傳 valid:false，即使 pose 端資料完全正常也會被判定不健康', async () => {
    inferenceState.health = defaultHealth
    const rotation = [
      { key: 'face', metrics: { eyeClosed: false, gaze: 'center', valid: false }, latencyMs: 1 },
      POSE_VALID,
    ]
    let i = 0
    inferenceState.stepResult = () => rotation[(i++) % rotation.length]
    for (let n = 0; n < 10; n++) {
      advance(300)
      await driveFrame()
    }
    expect(session.state.inferenceHealthy).toBe(false)
    resetInferenceMock()
    await driveFrame()
    advance(100)
    await driveFrame()
    expect(session.state.inferenceHealthy).toBe(true)
  })

  it('F1 回歸：鏡頭失效狀態下反覆暫停/繼續，不能把新鮮度看門狗當成免費重置鈕', async () => {
    inferenceState.health = defaultHealth
    inferenceState.stepResult = () => (
      { key: 'pose', metrics: { valid: false, neckRatio: 0, shoulderWidth: 0 }, latencyMs: 1 }
    )

    // 對照：完全不碰暫停鈕，讓它自然變不健康並凍結
    for (let i = 0; i < 6; i++) { advance(500); await driveFrame() }
    expect(session.state.inferenceHealthy).toBe(false)
    const frozenElapsed = session.state.battle.elapsedMs

    // 反覆暫停/繼續：如果 resume 時無條件把新鮮度時間戳重設成 now（原本的
    // resetFreshness() 漏洞），每一次「繼續」都會讓 inferenceHealthy 瞬間變回
    // true，讓接下來 advance() 的時間被當成正常遊玩時間繼續計分——鏡頭全程
    // 被擋住，魔王卻照樣掉血。
    for (let i = 0; i < 10; i++) {
      await session.togglePause() // 暫停
      advance(2000)
      await driveFrame()
      await session.togglePause() // 繼續
      // 這段必須小於 FRESHNESS_TIMEOUT_MS(2000)：如果 resume 當下真的被免費
      // 重設成全新鮮（漏洞），這段時間內都會被誤判成健康、正常計分；設太長的話
      // 不管有沒有修好都會在這段時間內自然重新變回不健康，測不出兩者差異。
      advance(800)
      await driveFrame()
    }

    expect(session.state.battle.elapsedMs).toBe(frozenElapsed) // 沒有因為反覆暫停/繼續而多打一下
    resetInferenceMock()
    await driveFrame()
    advance(100)
    await driveFrame()
  })

  it('F1 回歸（背景版）：鏡頭失效狀態下反覆切到背景再回來，同樣不能重置新鮮度（onVisible 用的是同一個 shiftFreshness）', async () => {
    inferenceState.health = defaultHealth
    inferenceState.stepResult = () => (
      { key: 'pose', metrics: { valid: false, neckRatio: 0, shoulderWidth: 0 }, latencyMs: 1 }
    )

    for (let i = 0; i < 6; i++) { advance(500); await driveFrame() }
    expect(session.state.inferenceHealthy).toBe(false)
    const frozenElapsed = session.state.battle.elapsedMs

    for (let i = 0; i < 10; i++) {
      setVisibility('hidden')
      advance(2000)
      setVisibility('visible')
      await flush()
      advance(800) // 見上一條 F1 測試的說明：必須小於 FRESHNESS_TIMEOUT_MS
      await driveFrame()
    }

    expect(session.state.battle.elapsedMs).toBe(frozenElapsed)
    resetInferenceMock()

    // 這條測試用真的背景切換（不是使用者暫停）跑了 10 次循環，會在目前這場
    // 戰鬥的 distractionDurationMs.away／trapCount 上留下真實累加值（這是
    // notifyHidden/notifyVisible 的正常行為，不是 bug）。後面的測試（例如
    // I3/I4 回歸那條）會拿這些欄位斷言絕對值 0，所以這裡收尾時開一場全新的
    // 戰鬥，不把這條測試自己製造出來的背景切換痕跡帶給後面的測試。
    await session.endBattle('aborted')
    await session.startBattle()
  })

  it('Minor1 回歸：startBattle() 必須清掉上一場遺留的 freshnessSuspendedAt，否則一個沒配對的 visible 會把新鮮度時間戳推到未來、永久判定新鮮', async () => {
    await session.startBattle()
    await session.togglePause() // 暫停：設定 freshnessSuspendedAt
    await session.endBattle('aborted') // 不 resume 就結束——freshnessSuspendedAt 沒被消費，還留著

    advance(50_000) // 模擬離開很久才開新的一場

    await session.startBattle() // 新的一場：正確行為要把 freshnessSuspendedAt 清掉

    inferenceState.health = defaultHealth
    inferenceState.stepResult = () => (
      { key: 'pose', metrics: { valid: false, neckRatio: 0, shoulderWidth: 0 }, latencyMs: 1 }
    )

    // 一個沒配對的 visible（這場從沒呼叫過 onHidden()）：如果 freshnessSuspendedAt
    // 還留著上一場的舊時間戳，onVisible() 的 shiftFreshness() 會用它算出一個
    // 巨大的位移，把 lastValid*At 推到未來，之後 now - lastValid*At 恆為負數，
    // 永遠判定新鮮——鏡頭被擋也不會被抓到，比 F1 更嚴重：F1 頂多把新鮮度重置
    // 成「現在」（需要反覆操作才能一直作弊），這個會把它推到「未來」，一次
    // 就永久失效，不必再做任何事。
    setVisibility('visible')
    await flush()

    for (let i = 0; i < 6; i++) { advance(500); await driveFrame() }
    expect(session.state.inferenceHealthy).toBe(false)

    resetInferenceMock()
    await driveFrame()
    advance(100)
    await driveFrame()
  })

  it('togglePause() 暫停時 elapsedMs 不推進；恢復後正常推進（不會被每幀 setPaused 卡死在 dt=0）', async () => {
    advance(1000)
    await driveFrame()
    const before = session.state.battle.elapsedMs
    expect(before).toBeGreaterThan(0)

    await session.togglePause()
    expect(session.state.paused).toBe(true)
    advance(2000)
    await driveFrame()
    advance(2000)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBe(before)

    await session.togglePause()
    expect(session.state.paused).toBe(false)
    advance(1000)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBeGreaterThan(before)
  })

  it('F2 回歸：togglePause() 恢復時要呼叫 camera.resume()，不能只 setEnabled(true)', async () => {
    // 暫停→切到別的 App（pagehide 會把 stream 整個 stop 掉）→回來→按繼續，
    // 這輪要能重新計分，唯一的路徑是 resume()（它會處理「track 還活著就
    // enable+play，track 已經死了就整個 start() 重來」）。只 setEnabled(true)
    // 救不回一個已經被 stop() 的 stream。
    const before = cameraState.resumeCalls
    await session.togglePause() // 暫停
    await session.togglePause() // 恢復
    expect(cameraState.resumeCalls).toBe(before + 1)
  })

  it('F5 回歸：暫停時關掉三個推論 track，恢復時重新開啟（Task 22c：object 只在手機偵測開著時才回來）', async () => {
    // 展場預設是「手機偵測關閉」（state.phoneDetectEnabled），所以要驗「三個
    // track 都會回來」這件 F5 原本的事，得先把它打開——否則這條測試的第三個
    // 斷言會變成在測 Task 22c 的閘門，而不是 F5 的暫停/恢復語意。
    session.setPhoneDetectEnabled(true)
    inferenceState.enabledCalls.length = 0
    await session.togglePause() // 暫停
    expect(inferenceState.enabledCalls).toContainEqual(['pose', false])
    expect(inferenceState.enabledCalls).toContainEqual(['face', false])
    expect(inferenceState.enabledCalls).toContainEqual(['object', false])

    inferenceState.enabledCalls.length = 0
    await session.togglePause() // 恢復
    expect(inferenceState.enabledCalls).toContainEqual(['pose', true])
    expect(inferenceState.enabledCalls).toContainEqual(['face', true])
    expect(inferenceState.enabledCalls).toContainEqual(['object', true])

    // Task 22c：手機偵測關著時，「恢復」不得順手把 object 打開。少了
    // setInferenceTracksEnabled() 裡那道閘，工作人員（或展場預設）關掉的偵測
    // 會在每一次按「繼續」、每一次 startBattle()、每一次離開休息回合時被無聲
    // 地重新打開，而 state.objectDetectorOn 還停在 false——旗標說沒在跑、實際
    // 在跑，正是本專案反覆長出分身 bug 的那種兩套真相。
    session.setPhoneDetectEnabled(false)
    inferenceState.enabledCalls.length = 0
    await session.togglePause() // 暫停
    await session.togglePause() // 恢復
    expect(inferenceState.enabledCalls).toContainEqual(['pose', true])
    expect(inferenceState.enabledCalls).not.toContainEqual(['object', true])
  })

  it('F3 回歸：cameraHealthy 跨場次殘留會讓新的一場整場卡住、且沒有任何提示——startBattle() 必須重置它', async () => {
    // 這跟 C2 是同一類問題（上一場殘留的布林值繼續參與計分），只是換了一個
    // 旗標，而且比 I5 更糟：inferenceHealthy 本身完全正常，inferenceStuck
    // 永遠不會被觸發，畫面上不會出現任何一個字。
    session.rawState.cameraHealthy = false
    await session.startBattle()
    expect(session.state.cameraHealthy).toBe(true)

    advance(500)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBeGreaterThan(0)
    // 這裡刻意不 endBattle()——保留一場進行中的戰鬥給後面的測試接著用
    // （跟檔案其他地方的慣例一致：只有真的需要「結束」這件事本身時才呼叫它）。
  })

  it('N3 回歸：track.onended 之後照著畫面訊息「先暫停再繼續」操作，可以真的重新開始計分（不是只斷言文案字串）', async () => {
    // 模擬鏡頭被系統收走（iPadOS 把鏡頭指示燈收回、或被別的 App 搶走）——
    // boot() 把這個回呼接到 cameraCapture.js 的 onEnded，真機上是 track 自己
    // 觸發，這裡用捕捉到的回呼直接模擬。
    cameraState.onEnded()
    expect(session.state.cameraHealthy).toBe(false) // App.vue 這時會顯示「鏡頭好像不見了…」

    advance(500)
    await driveFrame()
    const frozen = session.state.battle.elapsedMs
    advance(500)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBe(frozen) // 凍結，跟畫面上的訊息一致

    // 照畫面上的指示操作：先按「暫停」，再按「繼續」（N3 選的是 (a)：文案指向
    // 這條既有的 camera.resume() 路徑，不是新增 boot()/CalibrationWizard 邏輯）。
    await session.togglePause()
    expect(session.state.paused).toBe(true)
    await session.togglePause()
    expect(session.state.paused).toBe(false)

    expect(session.state.cameraHealthy).toBe(true) // resume() 觸發重新取得鏡頭，成功後寫回 true
    expect(cameraState.resumeCalls).toBeGreaterThan(0)

    advance(500)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBeGreaterThan(frozen) // 真的恢復計分了
    await session.endBattle('aborted')
  })

  it('F5 回歸：cameraHealthy=false 時即使 inferenceHealthy 正常，也會凍結計分', async () => {
    await session.startBattle()
    advance(500)
    await driveFrame()
    const before = session.state.battle.elapsedMs
    expect(before).toBeGreaterThan(0)
    expect(session.state.inferenceHealthy).toBe(true)

    session.rawState.cameraHealthy = false
    advance(1000)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBe(before)

    session.rawState.cameraHealthy = true
    // 健康狀態「這一幀」才剛轉變時，syncFsmPaused() 會把 fsm 內部的 lastTickAt
    // 重設成當下的 t，同一幀接著呼叫的 tick() 因此 dt=0、不會推進——這是刻意
    // 的保護（見 syncFsmPaused 上方的說明），不是 bug。要看到真的恢復計分，
    // 得再多跑一幀。
    advance(500)
    await driveFrame()
    advance(500)
    await driveFrame()
    expect(session.state.battle.elapsedMs).toBeGreaterThan(before)
  })

  it('F5 回歸：object track 連續失敗達門檻時，陳舊的 phoneVisible 會被歸零', async () => {
    await session.startBattle()
    inferenceState.stepResult = () => ({ key: 'object', metrics: { phoneVisible: true }, latencyMs: 1 })
    advance(500)
    await driveFrame()
    expect(session.state.phoneVisible).toBe(true)

    inferenceState.health = () => ({
      pose: { consecutiveFailures: 0, lastErrorName: null },
      face: { consecutiveFailures: 0, lastErrorName: null },
      object: { consecutiveFailures: 3, lastErrorName: 'TypeError' },
    })
    advance(500)
    await driveFrame()
    expect(session.state.phoneVisible).toBe(false)

    resetInferenceMock()
    await session.startBattle() // 換回保持存活序列並開一場乾淨的戰鬥給後面的測試接著用
  })

  it('I3/I4 回歸：暫停中切到背景再回來，不算「離開」，也不會偷偷把鏡頭/WakeLock 打開', async () => {
    const before = session.state.battle.elapsedMs
    await session.togglePause()
    expect(session.state.paused).toBe(true)

    const resumeCallsBefore = cameraState.resumeCalls
    setVisibility('hidden')
    advance(30_000)
    setVisibility('visible')
    await flush()

    expect(cameraState.resumeCalls).toBe(resumeCallsBefore) // 暫停中不該偷偷把鏡頭打開（I4）
    expect(session.state.battle.trapCount.away).toBe(0) // 暫停中離開不算「離開」（I3）
    expect(session.state.battle.distractionDurationMs.away).toBe(0)
    expect(session.state.battle.elapsedMs).toBe(before) // 暫停中本來就不推進

    await session.togglePause() // 恢復，回到未暫停狀態給後面的測試用
    expect(session.state.paused).toBe(false)
  })

  it('沒有暫停時，切到背景仍正常計入 away（I3 的修法只排除「暫停中」這個情況）', async () => {
    setVisibility('hidden')
    advance(10_000)
    setVisibility('visible')
    await flush()
    expect(session.state.battle.distractionDurationMs.away).toBe(10_000)
  })

  it('I5 回歸：持續不健康超過 30 秒會升級成 inferenceStuck', async () => {
    inferenceState.health = () => ({
      pose: { consecutiveFailures: 3, lastErrorName: 'TypeError' },
      face: { consecutiveFailures: 0, lastErrorName: null },
      object: { consecutiveFailures: 0, lastErrorName: null },
    })
    advance(500)
    await driveFrame()
    expect(session.state.inferenceHealthy).toBe(false)
    expect(session.state.inferenceStuck).toBe(false) // 還沒到 30 秒

    advance(30_000)
    await driveFrame()
    expect(session.state.inferenceStuck).toBe(true)
    resetInferenceMock()
  })

  it('隱私紅線：reactive state 不會出現原始 metrics（landmark/blendshape）的痕跡', async () => {
    inferenceState.health = defaultHealth
    inferenceState.stepResult = {
      key: 'pose',
      metrics: { valid: true, neckRatio: 1, shoulderWidth: 0.3, __rawLandmarkMarker: 'LEAK_MARKER_XYZ' },
      latencyMs: 5,
    }
    advance(500)
    await driveFrame()
    expect(JSON.stringify(session.state)).not.toContain('LEAK_MARKER_XYZ')
    resetInferenceMock()
  })

  it('endBattle("aborted") 不呼叫 inference.destroy()（跨輪重用同一個實例）', async () => {
    const before = inferenceState.destroyCalls
    const record = await session.endBattle('aborted')
    expect(session.state.screen).toBe('stats')
    expect(record.status).toBe('in_progress')
    expect(inferenceState.destroyCalls).toBe(before)
  })

  it('M4 回歸：endBattle() 被呼叫兩次不會把 lastRecord 洗成 null', async () => {
    await session.startBattle()
    const record1 = await session.endBattle('aborted')
    expect(record1).not.toBe(null)
    const record2 = await session.endBattle('aborted')
    expect(record2).toBe(record1)
    // 用 toEqual（深比對）而不是 toBe：session.state 是 readonly(state) 包出來的
    // proxy，跟 endBattle() 內部直接回傳的 state.lastRecord 是不同的 wrapper
    // 物件（Vue 的 reactive／readonly 是各自獨立快取的 proxy 層），內容相同但
    // 物件參照本來就不會相等，這是 Vue 的代理機制，不是這裡要鎖的行為。
    expect(session.state.lastRecord).toEqual(record1)
  })

  it('undoTrap()：battle 進行中對不存在的 trapId 回傳 false（不是靠 fsm===null 的空值短路）；成功撤銷手機陷阱時 trapCount.phoneUndone 增加', async () => {
    await session.startBattle()
    // 這裡 fsm 是真的存在的——測的是 FocusStateMachine 自己拒絕不存在的
    // trapId，不是 `fsm?.undoTrap(trapId) ?? false` 在 fsm===null 時的空值短路（M2）。
    expect(session.undoTrap('does-not-exist')).toBe(false)

    let trapId = null
    const off = session.onBattleEvent((events) => {
      const p = events.find((e) => e.type === 'trapPending' && e.kind === 'phone')
      if (p) trapId = p.trapId
    })

    const rotation = [
      { key: 'object', metrics: { phoneVisible: true }, latencyMs: 1 },
      POSE_VALID,
      FACE_VALID,
    ]
    let i = 0
    inferenceState.stepResult = () => rotation[(i++) % rotation.length]
    for (let n = 0; n < 8 && trapId === null; n++) {
      advance(500)
      await driveFrame()
    }
    expect(trapId).not.toBe(null)

    expect(session.undoTrap(trapId)).toBe(true)
    expect(session.state.battle.trapCount.phoneUndone).toBe(1)

    off()
    resetInferenceMock()
    await session.endBattle('aborted')
  })

  it('C2 回歸：跨場次不殘留 phoneVisible——第二場開場不會平白吃到手機陷阱', async () => {
    // Session 1：手機留在畫面上，讓 state.phoneVisible 卡在 true
    await session.startBattle()
    inferenceState.stepResult = () => ({ key: 'object', metrics: { phoneVisible: true }, latencyMs: 1 })
    advance(500)
    await driveFrame()
    expect(session.state.phoneVisible).toBe(true)
    resetInferenceMock() // 換回保持存活序列，但刻意不去動 phoneVisible 本身——這正是漏洞：
    // 只有 startBattle() 該負責清它，其他任何地方都不該替它兜底。
    await session.endBattle('aborted')

    // Session 2：新的一場，桌上沒有手機
    await session.startBattle()
    expect(session.state.phoneVisible).toBe(false)

    let trapFired = false
    const off = session.onBattleEvent((events) => {
      if (events.some((e) => e.type === 'trapPending' && e.kind === 'phone')) trapFired = true
    })
    for (let i = 0; i < 8; i++) {
      advance(500)
      await driveFrame()
    }
    expect(trapFired).toBe(false)
    off()
    await session.endBattle('aborted')
  })

  it('I2 回歸：一個事件消費者丟例外不會讓 rAF 遞迴排程鏈斷掉，其他消費者仍正常收到事件', async () => {
    await session.startBattle()
    const goodCalls = []
    const offBad = session.onBattleEvent(() => { throw new Error('boom') })
    const offGood = session.onBattleEvent((events) => { goodCalls.push(events) })

    // posture 預設 upright（analyzer 剛建立、窗口內樣本不足時的預設值），
    // demo 模式攻擊間隔 1000ms，dt=1000 應該剛好觸發一次 attack 事件。
    advance(1000)
    await driveFrame()

    expect(pendingFrame).not.toBe(null) // 迴圈沒有因為 offBad 丟例外而停止排程
    expect(goodCalls.length).toBeGreaterThan(0) // 另一個消費者不受影響，正常收到事件
    expect(session.state.loopError).toBe(null) // 消費者的例外被 emit() 自己吞掉，不算迴圈層級的錯誤

    offBad()
    offGood()
    await session.endBattle('aborted')
  })

  it('I2 回歸：inference.step() 本身丟出未預期例外，rAF 迴圈照樣排下一幀並記錄 loopError', async () => {
    await session.startBattle()
    inferenceState.stepResult = () => { throw new Error('boom') }
    advance(500)
    await driveFrame()
    expect(session.state.loopError).toBe('Error') // 隱私紅線：只留 error.name
    expect(pendingFrame).not.toBe(null) // 迴圈沒有因此斷掉

    resetInferenceMock()
    advance(500)
    await driveFrame() // 確認迴圈真的還活著、後續幀能正常運作
    expect(pendingFrame).not.toBe(null)
    await session.endBattle('aborted')
  })

  it('自然結束（elapsedMs 到期）會自動呼叫 endBattle("completed")', async () => {
    await session.startBattle()
    let guard = 0
    while (session.state.screen === 'battle' && guard < 50) {
      advance(500)
      await driveFrame()
      guard += 1
    }
    expect(session.state.screen).toBe('stats')
    expect(session.state.lastRecord.status).toBe('completed')
  })

  // 注意：perfMonitor 的降檔是單向、跨整場（甚至跨輪）不可逆的（見 session.js
  // 的 perf 變數上方說明）——一旦某條測試真的把它觸發過一次，state.perfMode
  // 這個模組級單例就會永遠停在 true，後面的測試不管開幾場新戰鬥都救不回來。
  // 這正是任務規格提醒的「前一條測試殘留的狀態」陷阱：如果先寫一條「觸發降檔」
  // 的測試，後面才寫「暫停中不該被算進降檔」，後面那條會因為 perfMode 早就是
  // true 而變成恆真的假陽性（不管暫停邏輯對不對都會通過）。所以這裡刻意把
  // 「從未觸發過降檔」當前提的測試（暫停免疫）排在真正觸發降檔的測試之前，
  // 而「觸發降檔」本身的所有效果（perfMode／objectDetectorOn／phoneVisible
  // 歸零／setScale／setEnabled 只呼叫一次）合併成單一條測試斷言，不拆成
  // 「觸發一次」用掉之後、後面還想再測別的效果就測不到了。
  it('Task 16：暫停中即使延遲持續超標，也不會被算進降檔的 10 秒視窗（暫停時 track 本來就關了）', async () => {
    await session.startBattle()
    inferenceState.latencyEmaValue = 200
    await session.togglePause() // 暫停

    for (let i = 0; i < 25; i++) { advance(500); await driveFrame() } // 遠超過 10 秒門檻
    expect(session.state.perfMode).toBe(false) // 這裡如果錯，後面所有降檔測試都會失真

    await session.togglePause() // 恢復，不留給後面的測試
    inferenceState.latencyEmaValue = 0
    await session.endBattle('aborted')
  })

  it('Task 16：延遲 EMA 持續超標 10 秒後觸發單向降檔——關閉 ObjectDetector、頻率減半、歸零殘留 phoneVisible，且只觸發一次', async () => {
    await session.startBattle()
    inferenceState.scaleCalls.length = 0
    inferenceState.enabledCalls.length = 0
    inferenceState.stepResult = () => ({ key: 'object', metrics: { phoneVisible: true }, latencyMs: 1 })
    advance(500)
    await driveFrame()
    expect(session.state.phoneVisible).toBe(true) // 先確認手機陷阱真的掛著，等一下才看得出降檔有沒有把它收掉

    inferenceState.latencyEmaValue = 200 // > 150ms 門檻
    let guard = 0
    while (!session.state.perfMode && guard < 40) {
      advance(500)
      await driveFrame()
      guard += 1
    }

    expect(session.state.perfMode).toBe(true)
    expect(session.state.objectDetectorOn).toBe(false)
    expect(session.state.latencyEma).toBe(200)
    expect(session.state.phoneVisible).toBe(false) // 關掉偵測後不能讓陷阱繼續掛著
    expect(inferenceState.scaleCalls).toEqual([0.5])
    expect(inferenceState.enabledCalls).toContainEqual(['object', false])

    // 不可升回，且不會在後續每一幀反覆呼叫：即使繼續超標，呼叫次數維持不變
    for (let i = 0; i < 5; i++) { advance(500); await driveFrame() }
    expect(inferenceState.scaleCalls).toEqual([0.5])
    expect(inferenceState.enabledCalls.filter((c) => c[0] === 'object' && c[1] === false).length).toBe(1)

    resetInferenceMock()
    await session.endBattle('aborted')
  })

  it('Task 16／22c：toggleObjectDetector() 是 setPhoneDetectEnabled() 的薄包裝——兩個旗標一起動，關閉時歸零殘留的 phoneVisible', () => {
    session.setPhoneDetectEnabled(true)
    session.rawState.phoneVisible = true
    inferenceState.enabledCalls.length = 0

    session.toggleObjectDetector()
    // 「使用者的明示設定」跟「現在到底有沒有在跑」必須一起動：兩個方法各自
    // 維護自己那一半的話，就會出現「用 toggle 關掉、設定面板卻顯示開著」。
    expect(session.state.phoneDetectEnabled).toBe(false)
    expect(session.state.objectDetectorOn).toBe(false)
    expect(session.state.phoneVisible).toBe(false)
    expect(inferenceState.enabledCalls).toContainEqual(['object', false])

    session.toggleObjectDetector()
    expect(session.state.phoneDetectEnabled).toBe(true)
    expect(session.state.objectDetectorOn).toBe(true)
    expect(inferenceState.enabledCalls).toContainEqual(['object', true])

    session.setPhoneDetectEnabled(false) // 還原展場預設，不留殘留狀態給後面的測試
  })

  it('Task 16：perfStats() 的 latencyP95／rafP95／rafMax 反映實際樣本，rounds 隨每次 startBattle() 遞增', async () => {
    const roundsBefore = session.perfStats().rounds
    await session.startBattle()
    expect(session.perfStats().rounds).toBe(roundsBefore + 1)

    // 灌滿 600 筆視窗（超過上限），把之前測試留下的殘留樣本全部擠出去，
    // 換上這裡自訂的、可預期的固定值，讓斷言不必依賴之前測試的執行順序。
    inferenceState.stepResult = () => (
      { key: 'pose', metrics: { valid: true, neckRatio: 1, shoulderWidth: 0.3 }, latencyMs: 42 }
    )
    for (let i = 0; i < 610; i++) { advance(20); await driveFrame() }

    const stats = session.perfStats()
    expect(stats.latencyP95).toBe(42)
    expect(stats.rafP95).toBe(20)
    expect(stats.rafMax).toBe(20)

    resetInferenceMock()
    await session.endBattle('aborted')
  })

  it('teardown() 呼叫 inference.destroy()——這是唯一允許呼叫它的地方', () => {
    const before = inferenceState.destroyCalls
    session.teardown()
    expect(inferenceState.destroyCalls).toBe(before + 1)
    expect(session.state.booted).toBe(false)
  })
})

describe('copyEngine 跨場次重置（controller 裁決：startBattle() 必須呼叫 resetSession）', () => {
  it('第二場 session 開始後，第一次駝背反擊訊息仍是因果格式，不是簡化版', async () => {
    const session = useSession()
    const copy = session.copy()

    // --- Session 1：把 posture/slouch 的 repeat 推過 CAUSE_FORMAT_LIMIT(3) ---
    await session.startBattle() // 觸發 copy.resetSession()，確保從乾淨狀態開始
    const mq1 = createMessageQueue()
    const coach1 = createPostureCoach({ copy, mq: mq1 })
    const times = [0, 45_000, 90_000, 135_000] // 間隔跨過 copyEngine 45s 的 cooldown
    for (const t of times) {
      coach1.handle([{ type: 'playerDamage', amount: 3, playerHp: 90, reason: 'slouch' }], { drowsy: false }, t)
    }
    const fourth = mq1.current(times[3])
    // Task 22a 複審 B-2：因果格式從「魔王反擊！（你駝背了）→ …」（合成後最長
    // 觸及 24 字，違反 15 字上限）改成「駝背了，…」，見 postureCoach.js 的
    // formatPostureMessage()。第 4 次（repeat=4 > CAUSE_FORMAT_LIMIT）簡化版
    // 純指令不會帶因果標籤。
    expect(fourth.text).not.toMatch(/^駝背了，/)
    await session.endBattle('aborted')

    // --- Session 2：resetSession() 必須讓 repeat 從 1 重新算起 ---
    // 這裡刻意把時間點取在遠超過 session 1 最後一次 take() 的 45s cooldown 之後
    // （180_000 = times[3] + 45_000）：如果 resetSession() 只清了 repeatCount、
    // 忘了清 lastTakenAt（cooldown 用的那個 map），用 now=0 會被 session 1 的
    // cooldown 卡住、take() 回 null，讀 .text 直接爆掉——那是在測「cooldown 有沒有
    // 被清」，不是這條測試宣稱要測的「repeatCount 有沒有被清 → 因果格式」。把
    // now 拉到 cooldown 一定過期的時間點，兩件事才不會混在一起、失敗訊息才會
    // 指向真正的原因。
    const session2Now = times[3] + 45_000
    await session.startBattle()
    const mq2 = createMessageQueue()
    const coach2 = createPostureCoach({ copy, mq: mq2 })
    coach2.handle([{ type: 'playerDamage', amount: 3, playerHp: 90, reason: 'slouch' }], { drowsy: false }, session2Now)
    const first = mq2.current(session2Now)
    expect(first.text).toMatch(/^駝背了，/)
    await session.endBattle('aborted')
  })
})

// ---------------------------------------------------------------------------
// Task 22c：量測畫面（lab）／換人玩／工作人員設定面板
// ---------------------------------------------------------------------------

describe('Task 22c：ThresholdLab 畫面（lab）的轉場與鏡頭判準', () => {
  const session = useSession()

  it('enterLab() 走 setScreen()，鏡頭被判準打開，推論 track 重新開啟', async () => {
    setVisibility('visible')
    session.rawState.paused = false
    cameraState.setEnabledCalls.length = 0
    inferenceState.enabledCalls.length = 0

    await session.enterLab()

    expect(session.state.screen).toBe('lab')
    // 鐵律二：新增畫面時 cameraShouldBeEnabled() 必須跟著回答。'lab' 沒有列進
    // 判準的話，setScreen('lab') 當場就會把鏡頭收斂成 false——量測畫面會對著
    // 一台關掉的鏡頭跑，取樣數永遠停在 0，而且畫面上不會有任何錯誤訊息
    // （操作者手上沒有 devtools，正式 bundle 連 console 都被拔掉）。
    expect(cameraState.setEnabledCalls).toContain(true)
    expect(cameraState.setEnabledCalls).not.toContain(false)
    // 從結算流程走進來時 endBattle() 已經把三個 track 都關掉了。
    expect(inferenceState.enabledCalls).toContainEqual(['pose', true])
  })

  it('leaveLab() 回到 task 畫面，並依判準把鏡頭關掉', () => {
    cameraState.setEnabledCalls.length = 0
    session.leaveLab()
    expect(session.state.screen).toBe('task')
    // 任務畫面上鏡頭亮著沒有任何理由，而這個 App 賣的就是這件事。
    expect(cameraState.setEnabledCalls).toEqual([false])
  })
})

describe('Task 22c：換人玩（Ruling DY）', () => {
  const session = useSession()

  it('endBattle() 之後重新進校準，pose track 必須被重新打開——第二位訪客才量得到坐姿', async () => {
    await session.startBattle()
    await session.endBattle('aborted')

    inferenceState.enabledCalls.length = 0
    await session.enterCalibration()

    expect(session.state.screen).toBe('calibrate')
    // endBattle() 會 setInferenceTracksEnabled(false)，而 CalibrationWizard
    // 只會 setScale(3)＋關掉 face/object，從來沒有人重新打開 pose。少了
    // enterCalibration() 裡那一行，第二位訪客的校準會跑滿 5 秒然後說
    // 「取樣不足」，按「再試一次」也一樣——而且沒有任何錯誤訊息。
    expect(inferenceState.enabledCalls).toContainEqual(['pose', true])
  })

  it('startNewVisitor()：清掉上一位訪客的 history／lastRecord，並回到**選任務**（新訪客要自己選任務）', () => {
    // 換人玩的真實入口是結算畫面（StatsDashboard 角落那顆按鈕）。
    session.rawState.screen = 'stats'
    session.rawState.history = [{ id: 'prev-visitor' }]
    session.rawState.lastRecord = { id: 'prev-visitor', durationMs: 20 * 60_000, demoMode: false }
    cameraState.setEnabledCalls.length = 0

    session.startNewVisitor()

    // 【分任務校準】：終點從 'calibrate' 改成 'task'。上一位選的是「寫作業
    // 15 分鐘」，下一位可能是來看書的——沿用前一位的任務設定，跟沿用前一位的
    // 校準基準是同一種錯；而且校準的姿勢指示現在依賴任務類型，先跳進校準就
    // 等於拿上一位的任務去指示這一位。
    expect(session.state.screen).toBe('task')
    // 換人之後，結算頁的「跟上一次比」與 needsBreakAfter()（「坐了 20 分鐘，
    // 先休息一下」）讀到的都會是**別人**的資料。
    expect(session.state.history).toEqual([])
    expect(session.state.lastRecord).toBe(null)
    // 而且轉場真的走了 setScreen()（鏡頭依判準收斂成 OFF），不是自己寫一套。
    expect(cameraState.setEnabledCalls, '轉場必須經過 setScreen() 的鏡頭收斂').toEqual([false])
  })

  it('換人玩之後走完既有那條路（選任務 → 校準）會重新校準，且 pose track 被重新打開', async () => {
    // ── 這條測試的名字改過（複審 I-9）──────────────────────────
    //
    // 它原本叫「換人玩之後仍然一定會重新校準——**任務畫面唯一的出口**就是校準」。
    // 那個名字承諾了「唯一性」，而它的內容只是**把 happy path 再跑一次**
    // （自己呼叫 setTask() ＋ enterCalibration()，然後斷言 screen==='calibrate'）。
    // 未來有人在 App.vue 的 'task' 分支下加一顆「跳過校準」按鈕，這條測試會
    // 保持綠色——名字承諾了一個它做不到的保證。
    //
    // 這是 Ruling DK 的變形：要防的違規會發生在 **App.vue 的模板**（新增出口），
    // 護欄卻裝在 store（重跑既有出口）。所以：
    //   - 這條測試改成只承諾它真正鎖得到的事（走完既有那條路會發生什麼）；
    //   - 「任務畫面不得長出第二個出口」那條保證搬到違規會發生的地方，
    //     見 App.taskSelector.test.js 的「'task' 分支的結構護欄」。
    //
    // 為什麼不能省掉這一條：accident #3（換訪客不會重新校準）的症狀是
    // 「整場一直說他駝背」或「整場都不反應」，而且沒有任何錯誤訊息——
    // 這個家族的每一個 bug 都是靜默的，只有測試看得到。
    session.rawState.screen = 'stats'
    session.startNewVisitor()
    expect(session.state.screen).toBe('task')

    inferenceState.enabledCalls.length = 0
    session.setTask({ taskType: 'reading', durationMin: 15, demoMode: true })
    await session.enterCalibration()

    expect(session.state.screen).toBe('calibrate')
    // 新訪客的任務設定真的是他自己選的那一個（校準畫面要靠它決定姿勢指示）。
    expect(session.state.taskType).toBe('reading')
    // 而且 pose track 被重新打開——少了這個，第二位訪客的校準會跑滿 5 秒
    // 然後說「取樣不足」（accident #2）。
    expect(inferenceState.enabledCalls).toContainEqual(['pose', true])
  })

  it('換人之後的第一場不去撈歷史（結算頁不會拿陌生人的成績跟他比），第二場恢復正常', async () => {
    // 前提：資料庫裡**真的**還有上一位訪客的紀錄。這一條如果沒有先立起來，
    // 「history 是空的」會是恆真的假陽性（jsdom 沒有 IndexedDB，真實的
    // listSessions() 本來就會失敗）。
    storageState.listSessionsResult = [{ id: 'prev-visitor', startedAt: 1, durationMs: 60_000 }]
    storageState.listSessionsCalls = 0

    session.startNewVisitor()
    await session.startBattle()
    await session.endBattle('aborted')

    // 第一場：沒有去撈，history 維持空的 → buildSummary() 的
    // priorHistory.length === 0 自然退回冷啟動分支（不講「跟上一次比」）。
    expect(storageState.listSessionsCalls, '換人後第一場不該去撈上一位的紀錄').toBe(0)
    expect(session.state.history).toEqual([])
    expect(session.state.historyError, '沒有去撈就不該有讀取錯誤').toBe(null)

    // 第二場：恢復正常——這時候「上一次」真的是他自己（就是剛剛那一場）。
    await session.startBattle()
    await session.endBattle('aborted')
    expect(storageState.listSessionsCalls).toBe(1)
    expect(session.state.history).toEqual(storageState.listSessionsResult)

    storageState.listSessionsResult = []
  })
})

describe('Task 22c：工作人員設定面板的 store 方法', () => {
  const session = useSession()

  it('setPhoneDetectEnabled(false)：兩個旗標一起關，且一定要歸零殘留的 phoneVisible', () => {
    session.setPhoneDetectEnabled(true)
    session.rawState.phoneVisible = true
    inferenceState.enabledCalls.length = 0

    session.setPhoneDetectEnabled(false)

    expect(session.state.phoneDetectEnabled).toBe(false)
    expect(session.state.objectDetectorOn).toBe(false)
    expect(inferenceState.enabledCalls).toContainEqual(['object', false])
    // 關掉偵測之後殘留的 true 會讓手機陷阱一直掛著，小孩把手機收起來也解不掉
    // （object track 已經不跑了，沒有人會再把它改回 false）。
    expect(session.state.phoneVisible).toBe(false)
  })

  it('resetPerfMode()：重新武裝降檔偵測、還原 scale，且 object 依「使用者的明示設定」還原', async () => {
    // 先把世界弄成「真的降過檔」，而且是這條測試自己弄出來的，不依賴前面測試
    // 留下的殘留狀態（Ruling CH(b)）：resetPerfMode() 先重新武裝 perfMonitor，
    // 接著真的跑到降檔。如果 resetPerfMode() 沒有呼叫 perf.reset()，
    // perfMonitor 的單向旗標會讓下面這個 while 跑滿 guard 而 perfMode 仍是
    // false——那正是「降檔一旦發生就再也回不來」這個 Ruling CR 要修的症狀。
    session.setPhoneDetectEnabled(true)
    session.resetPerfMode()
    await session.startBattle()
    inferenceState.scaleCalls.length = 0
    inferenceState.enabledCalls.length = 0
    inferenceState.latencyEmaValue = 200
    let guard = 0
    while (!session.state.perfMode && guard < 40) {
      advance(500)
      await driveFrame()
      guard += 1
    }
    expect(session.state.perfMode, 'resetPerfMode() 必須呼叫 perf.reset()，否則單向降檔永遠回不來').toBe(true)
    expect(inferenceState.scaleCalls).toEqual([0.5])
    expect(session.state.objectDetectorOn).toBe(false)

    inferenceState.latencyEmaValue = 0
    inferenceState.scaleCalls.length = 0
    inferenceState.enabledCalls.length = 0
    session.resetPerfMode()

    expect(session.state.perfMode).toBe(false)
    // 降檔做了兩件事（setScale(0.5) 與 setEnabled('object', false)），復原就要
    // 還原兩件——只還原一半會留下一台「速度回來了、手機偵測永遠關著」的裝置。
    expect(inferenceState.scaleCalls).toEqual([1])
    expect(session.state.objectDetectorOn).toBe(true)
    expect(inferenceState.enabledCalls).toContainEqual(['object', true])

    // 另一半：工作人員明示關掉手機偵測時，復原降檔**不得**順手把它打開
    // （兩個真相來源打架時，使用者的明示設定優先於自動降檔）。
    session.setPhoneDetectEnabled(false)
    session.rawState.perfMode = true
    inferenceState.enabledCalls.length = 0
    session.resetPerfMode()
    expect(session.state.objectDetectorOn).toBe(false)
    expect(inferenceState.enabledCalls).not.toContainEqual(['object', true])

    await session.endBattle('aborted')
  })

  it('clearAllLocalData() 成功：clearState 走到 done，記憶體裡的 history／lastRecord 也一起清掉', async () => {
    storageState.clearAllShouldThrow = false
    storageState.clearAllCalls = 0
    session.rawState.history = [{ id: 'old' }]
    session.rawState.lastRecord = { id: 'old' }
    session.rawState.clearState = 'idle'

    await session.clearAllLocalData()

    expect(storageState.clearAllCalls).toBe(1)
    expect(session.state.clearState).toBe('done')
    // 不清的話，結算頁還會拿一筆使用者剛剛要求刪掉的資料去講「跟上一次比」。
    expect(session.state.history).toEqual([])
    expect(session.state.lastRecord).toBe(null)
  })

  it('clearAllLocalData() 失敗：clearState 一定是 error，不得靜默當成功，也不得謊稱資料已經清掉', async () => {
    storageState.clearAllShouldThrow = true
    session.rawState.history = [{ id: 'still-here' }]
    session.rawState.clearState = 'idle'

    await session.clearAllLocalData()

    expect(session.state.clearState).toBe('error')
    // IndexedDB 被封鎖（私密瀏覽／儲存空間政策）時資料其實還在。把 history
    // 一併清空會讓畫面看起來像清乾淨了——那是對家長說謊，跟 storageError／
    // historyError 拆成兩個欄位是同一條理由。
    expect(session.state.history).toEqual([{ id: 'still-here' }])
    storageState.clearAllShouldThrow = false
  })

  it('resetClearState()：面板重新打開時把上一次的結果字樣收回 idle', () => {
    session.rawState.clearState = 'error'
    session.resetClearState()
    expect(session.state.clearState).toBe('idle')
  })

  // 複審 I-1：第四個「展場輪流玩」bug——降檔之後換人，效能降檔悄悄失效。
  // CalibrationWizard.restore() 會把推論倍率還原（上一版寫死 1），而
  // Ruling DY 讓「降檔 → 換人 → 校準」變成每一位訪客都會走的路。倍率的
  // 唯一真相是 state.perfMode，所以每一個「接下來真的會有人讀 step()」的
  // 入口都要收斂一次，不能靠某個元件記得。
  it('降檔之後，每一次轉場都把推論倍率收斂回 0.5——不靠 CalibrationWizard 記得', async () => {
    session.rawState.perfMode = true
    session.setPhoneDetectEnabled(false)

    inferenceState.scaleCalls.length = 0
    await session.enterCalibration()
    expect(inferenceState.scaleCalls, 'enterCalibration()').toEqual([0.5])

    // 模擬 CalibrationWizard 卸載時把倍率還原成「它以為的」值——上一版寫死
    // 成 1，現在拿的是 App.vue 依 state.perfMode 傳進去的 restore-scale
    // （見 App.vue 的 :restore-scale 與 CalibrationWizard 的同名 prop）。
    // 就算那個 prop 傳錯，下面每一個轉場的收斂都會把它修回來——這條測試鎖的
    // 正是那道防線。
    session.inference().setScale(1) // ← 模擬 restore() 把倍率打回全解析度

    inferenceState.scaleCalls.length = 0
    await session.enterLab()
    expect(inferenceState.scaleCalls, 'enterLab()').toEqual([0.5])

    inferenceState.scaleCalls.length = 0
    await session.startBattle()
    expect(inferenceState.scaleCalls, 'startBattle()').toEqual([0.5])
    await session.endBattle('aborted')

    // 沒有降檔時，同樣的入口收斂成 1（倍率跟著旗標走，不是單向只會變小）。
    session.rawState.perfMode = false
    inferenceState.scaleCalls.length = 0
    await session.startBattle()
    expect(inferenceState.scaleCalls).toEqual([1])
    await session.endBattle('aborted')
  })
})

// 這一條刻意放在整個檔案的最後：它用 vi.resetModules() 拿一份**全新的**
// session 模組實例，才觀測得到 boot() 當下發生的事。上面所有 describe 共用的
// 是同一個模組級單例，而它的 boot() 早在檔案開頭就跑完了，沒有任何辦法回頭
// 觀測「boot 的那一刻對 object track 做了什麼」。
describe('Task 22c：boot() 依「手機偵測」的預設值初始化 object track', () => {
  it('boot() 必須**主動**把 object track 收斂成 phoneDetectEnabled 的值，不是靠 scheduler 的預設', async () => {
    vi.resetModules()
    const { useSession: useFreshSession } = await import('./session.js')
    const fresh = useFreshSession()
    inferenceState.enabledCalls.length = 0

    await fresh.boot(document.createElement('video'))

    expect(fresh.state.booted).toBe(true)
    // 實機驗收後改為預設開啟（見 session.js 的 phoneDetectEnabled 註解）：
    // 原本的 false 是基於「小孩被冤枉時完全無能為力」，而那個前提是錯的——
    // CoachBanner 上就有一顆「我沒有在玩那個」的撤銷鈕。預設關閉的真實代價是
    // 手機陷阱這個核心機制對每一位訪客靜默失效，實機測試第一輪就撞到了。
    expect(fresh.state.phoneDetectEnabled).toBe(true)
    expect(fresh.state.objectDetectorOn).toBe(true)
    // 這條斷言是這個測試的**全部鑑別力所在**，不要簡化成只看 objectDetectorOn。
    // inferenceScheduler 建構時三個 track 本來就全是 enabled，所以「boot() 正確
    // 收斂」跟「boot() 什麼都沒做」在最終狀態上長得一模一樣。只有「那一通
    // setEnabled 呼叫真的發生過」能分辨兩者——而它必須發生，否則把預設值改回
    // false 的那一天，object track 會繼續跑而旗標說它沒在跑（兩套真相）。
    expect(
      inferenceState.enabledCalls,
      'boot() 必須顯式呼叫 setEnabled(object, ...)，不能依賴 scheduler 的預設值',
    ).toContainEqual(['object', true])

    fresh.teardown()
  })
})
