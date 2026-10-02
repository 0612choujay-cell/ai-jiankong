// @vitest-environment jsdom
//
// task-17：session.js × storageService.js 整合點的測試——這個檔案只關心
// 「session.js 有沒有在正確的時機、用正確的方式呼叫 storageService.js」，
// IndexedDB/localStorage 本身的邏輯已經在 storageService.test.js 測過，這裡
// 全部 mock 掉，只驗證呼叫時機、順序、參數。
//
// 三個跟 brief 字面不一致、照 controller 指示修正過的地方，這個檔案各有一條
// 測試專門鎖住：
//   1. handlePageHide() 的 writeCrumb() 要排在 camera?.stop() 之前（同步的
//      崩潰保險要最先做）。
//   2. reconcile() 要在 boot() 的早退之後、camera.start() 之前執行。
//   3. handlePageHide() 是模組層級具名函式，註冊/移除用同一個參照——這個檔案
//      沒有直接測「同一個函式參照」這件事本身（那是 session.js 內部實作
//      細節），但「teardown() 之後 pagehide 不再觸發 writeCrumb()」這條測試
//      間接證明了 removeEventListener 真的生效，只有用同一個參照才做得到。
import { describe, it, expect, vi, beforeEach } from 'vitest'
// 複審第 2 輪：驗證「讀歷史失敗時 state.history 被清空」這條護欄真的有效
// （不是被 beforeEach 的重置蓋過去），需要拿清空後的 state.history 去餵
// buildSummary()，確認它會落到冷啟動分支。summary.js 是純函式，不需要 mock。
import { buildSummary } from '../core/summary.js'

const callLog = []

const cameraState = { startOk: true }
vi.mock('../core/cameraCapture.js', () => ({
  createCameraCapture: vi.fn(() => ({
    start: async () => (cameraState.startOk ? { ok: true } : { ok: false, error: new Error('denied') }),
    stop: () => { callLog.push(['camera.stop']) },
    setEnabled: (enabled) => { callLog.push(['camera.setEnabled', enabled]) },
    readyState: () => 'live',
    isRunning: () => true,
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

const storageState = {
  reconcileResult: false, reconcileDelay: 0,
  saveSessionShouldThrow: false, reconcileShouldThrow: false, writeCrumbShouldThrow: false,
  listSessionsResult: [], listSessionsShouldThrow: false,
}
const storageMock = {
  saveSession: vi.fn(async (record) => {
    callLog.push(['saveSession', record])
    if (storageState.saveSessionShouldThrow) throw new TypeError('idbFactory() is undefined')
    return true
  }),
  writeCrumb: vi.fn((record) => {
    callLog.push(['writeCrumb', record])
    if (storageState.writeCrumbShouldThrow) throw new TypeError('boom')
  }),
  clearCrumb: vi.fn(() => { callLog.push(['clearCrumb']) }),
  reconcile: vi.fn(async () => {
    callLog.push(['reconcile'])
    if (storageState.reconcileDelay > 0) {
      await new Promise((resolve) => { setTimeout(resolve, storageState.reconcileDelay) })
    }
    if (storageState.reconcileShouldThrow) throw new TypeError('idbFactory() is undefined')
    return storageState.reconcileResult
  }),
  // task-18：endBattle() 存完本場之後會呼叫這個刷新 state.history。
  listSessions: vi.fn(async (limit) => {
    callLog.push(['listSessions', limit])
    if (storageState.listSessionsShouldThrow) throw new TypeError('idbFactory() is undefined')
    return storageState.listSessionsResult
  }),
}
vi.mock('../core/storageService.js', () => storageMock)

vi.stubGlobal('requestAnimationFrame', () => 1)
vi.stubGlobal('cancelAnimationFrame', () => {})

function makeEvent(type) {
  // 不用 `new Event(...)`：專案 eslint 全域清單沒列 Event（跟既有測試檔一致）。
  const ev = document.createEvent('Event')
  ev.initEvent(type, true, true)
  return ev
}

const { useSession } = await import('./session.js')
const { createCameraCapture } = await import('../core/cameraCapture.js')

const PROFILE = { baselineNeckRatio: 1, baselineShoulderWidth: 0.3, calibratedAt: 0 }

/** boot → task → calibrate → battle（【分任務校準】之後的順序），回傳 session。 */
async function bootToBattle(session, videoEl, { demoMode = true } = {}) {
  const r = await session.boot(videoEl)
  expect(r.ok).toBe(true)
  session.enterTaskSelect()
  session.setTask({ taskType: 'homework', durationMin: 15, demoMode })
  await session.enterCalibration()
  session.setCalibration(PROFILE)
  await session.startBattle()
  expect(session.state.screen).toBe('battle')
}

describe('session.js × storageService.js 整合', () => {
  const session = useSession()
  const videoEl = document.createElement('video')

  beforeEach(() => {
    // 這個檔案的測試共用同一個 session 單例依序執行（跟 session.test.js 同一個
    // 理由）。storageError 在真實使用情境下只會在 startBattle() 被重設——但
    // 有些測試（reconcile() 丟例外那條）刻意檢查 boot() 剛落地那一刻的值，
    // 早於任何 startBattle()，所以不能依賴那個重設。顯式歸零才能保證每條
    // 測試從已知的起點開始，不會被前一條測試留下的值污染出一個假的綠燈
    // （複審第 1 輪 F5 的教訓：綠燈也可能是別的東西造成的，不是只有紅燈）。
    session.rawState.storageError = null
    session.rawState.historyError = null
    session.rawState.history = []
    callLog.length = 0
    storageMock.saveSession.mockClear()
    storageMock.writeCrumb.mockClear()
    storageMock.clearCrumb.mockClear()
    storageMock.reconcile.mockClear()
    storageMock.listSessions.mockClear()
    storageState.saveSessionShouldThrow = false
    storageState.reconcileShouldThrow = false
    storageState.writeCrumbShouldThrow = false
    storageState.listSessionsShouldThrow = false
    storageState.listSessionsResult = []
  })

  it('修正 3：boot() 會呼叫 reconcile()，且排在 camera.start() 之前', async () => {
    await bootToBattle(session, videoEl)
    const names = callLog.map((c) => c[0])
    expect(storageMock.reconcile).toHaveBeenCalledTimes(1)
    // camera.start() 本身沒有留下 callLog 記錄（mock 沒有記），但 camera.stop()
    // 會——用「reconcile 在所有 camera 相關記錄之前」間接證明順序沒錯，
    // 更直接的證據是下一條「teardown 在 reconcile 空窗中發生」的測試。
    expect(names.indexOf('reconcile')).toBe(0)
    await session.endBattle('aborted')
    session.teardown()
  })

  it('teardown() 若在 reconcile() 這段空窗裡發生，boot() 完全不建立 camera（修正 3 的落地檢查）', async () => {
    // 複審第 1 輪 F5：報告原本只斷言 r.ok/booted，但拿掉這裡的檢查之後，
    // 流程一樣會走到 bootOnce() 既有的（T10 就有的）「inference.init() 之後」
    // 那個 myFrameGen 檢查，一樣回 {ok:false}、一樣 booted=false——那兩個
    // 斷言測不出「我這條護欄有沒有生效」，只測得出「有某條護欄接住了」。
    // 這裡改成直接斷言 createCameraCapture 有沒有被呼叫過：少了我這條檢查，
    // 流程會先建立 camera、呼叫 camera.start()，才在更後面被既有檢查收掉；
    // 有這條檢查，camera 從頭到尾不會被建立——這是只有這條護欄自己生效才會
    // 成立的斷言。
    const callsBefore = createCameraCapture.mock.calls.length
    storageState.reconcileDelay = 20
    const bootPromise = session.boot(videoEl)
    // reconcile() 還沒 resolve 的空窗裡，App 被卸載了。
    session.teardown()
    const r = await bootPromise
    expect(r.ok).toBe(false)
    expect(session.state.booted).toBe(false)
    expect(createCameraCapture.mock.calls.length).toBe(callsBefore)
    storageState.reconcileDelay = 0
  })

  it('非展示模式：endBattle() 呼叫 saveSession(lastRecord) 再 clearCrumb()，且展示模式的紀錄不會混進去', async () => {
    await bootToBattle(session, videoEl, { demoMode: false })
    const record = await session.endBattle('aborted')

    expect(storageMock.saveSession).toHaveBeenCalledTimes(1)
    expect(storageMock.saveSession).toHaveBeenCalledWith(record)
    expect(record.demoMode).toBe(false)
    expect(storageMock.clearCrumb).toHaveBeenCalledTimes(1)

    // saveSession 必須排在 clearCrumb 之前：清 crumb 之前要先確定真的存進去了
    // （見 session.js endBattle() 的註解：saveSession 失敗時不能清掉 crumb）。
    const saveIdx = callLog.findIndex((c) => c[0] === 'saveSession')
    const clearIdx = callLog.findIndex((c) => c[0] === 'clearCrumb')
    expect(saveIdx).toBeGreaterThanOrEqual(0)
    expect(saveIdx).toBeLessThan(clearIdx)

    session.teardown()
  })

  // 下面三條都用 try/finally 保護清理步驟（重置 storageState 旗標、
  // session.teardown()）：mutation 測試時斷言會刻意失敗，如果清理步驟寫在
  // 斷言後面、沒有 finally，一次失敗就會讓 storageState 的旗標或
  // session.booted 卡在髒狀態，拖累後面完全無關的測試一起紅——那樣看到的
  // 紅燈就不是「這條護欄真的沒生效」，而是「測試互相污染」，會誤導判讀。

  it('複審 F2：saveSession() 丟例外時，設定 state.storageError（只留錯誤名稱），且不清 crumb、畫面仍會切到 stats', async () => {
    storageState.saveSessionShouldThrow = true
    try {
      await bootToBattle(session, videoEl, { demoMode: false })
      await session.endBattle('aborted')

      expect(session.state.storageError).toBe('TypeError')
      expect(storageMock.clearCrumb).not.toHaveBeenCalled() // 沒存成功，crumb 是唯一的復原路徑，不能清
      expect(session.state.screen).toBe('stats') // 儲存失敗不能擋住畫面切換
    } finally {
      storageState.saveSessionShouldThrow = false
      session.teardown()
    }
  })

  it('複審 F2：reconcile() 丟例外時，設定 state.storageError，且不阻塞鏡頭/推論初始化', async () => {
    // 注意：不能借用 bootToBattle()——它會一路呼叫到 startBattle()，而
    // startBattle() 會把 storageError 重置成 null（見下一條測試），
    // 這裡要看的是 boot() 剛落地那一刻的值，得在 startBattle() 之前檢查。
    storageState.reconcileShouldThrow = true
    try {
      const r = await session.boot(videoEl)

      expect(r.ok).toBe(true) // reconcile 失敗不該連鏡頭都開不了
      expect(session.state.booted).toBe(true)
      expect(session.state.storageError).toBe('TypeError')

      storageState.reconcileShouldThrow = false
      session.enterTaskSelect()
      session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
      await session.enterCalibration()
      session.setCalibration(PROFILE)
      await session.startBattle()
      await session.endBattle('aborted')
    } finally {
      storageState.reconcileShouldThrow = false
      session.teardown()
    }
  })

  it('startBattle() 會重置上一輪殘留的 storageError，不讓舊錯誤訊息帶進新的一輪', async () => {
    storageState.saveSessionShouldThrow = true
    try {
      await bootToBattle(session, videoEl, { demoMode: false })
      await session.endBattle('aborted')
      expect(session.state.storageError).toBe('TypeError')
      storageState.saveSessionShouldThrow = false

      session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
      await session.startBattle()
      expect(session.state.storageError).toBeNull()

      await session.endBattle('aborted')
    } finally {
      storageState.saveSessionShouldThrow = false
      session.teardown()
    }
  })

  it('展示模式：endBattle() 不呼叫 saveSession()／clearCrumb()——評審試玩的資料不入庫', async () => {
    await bootToBattle(session, videoEl, { demoMode: true })
    const record = await session.endBattle('aborted')

    expect(record.demoMode).toBe(true)
    expect(storageMock.saveSession).not.toHaveBeenCalled()
    expect(storageMock.clearCrumb).not.toHaveBeenCalled()

    session.teardown()
  })

  it('修正 1／2：handlePageHide() 的 writeCrumb() 排在 camera.stop() 之前，且內容是進行中的紀錄', async () => {
    await bootToBattle(session, videoEl, { demoMode: false })

    window.dispatchEvent(makeEvent('pagehide'))

    const writeIdx = callLog.findIndex((c) => c[0] === 'writeCrumb')
    const stopIdx = callLog.findIndex((c) => c[0] === 'camera.stop')
    expect(writeIdx).toBeGreaterThanOrEqual(0)
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(writeIdx).toBeLessThan(stopIdx)

    const [, record] = callLog[writeIdx]
    expect(record.status).toBe('in_progress')

    session.teardown()
  })

  it('onHidden()（visibilitychange → hidden）也會 writeCrumb()，戰鬥中才會寫', async () => {
    await bootToBattle(session, videoEl, { demoMode: false })

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(makeEvent('visibilitychange'))

    expect(storageMock.writeCrumb).toHaveBeenCalledTimes(1)
    expect(storageMock.writeCrumb.mock.calls[0][0].status).toBe('in_progress')

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(makeEvent('visibilitychange'))
    await session.endBattle('aborted')
    session.teardown()
  })

  it('複審 F7：writeCrumb() 丟例外時，handlePageHide() 仍然會執行鏡頭衛生（camera.stop()）', async () => {
    storageState.writeCrumbShouldThrow = true
    try {
      await bootToBattle(session, videoEl, { demoMode: false })

      expect(() => window.dispatchEvent(makeEvent('pagehide'))).not.toThrow()

      const stopIdx = callLog.findIndex((c) => c[0] === 'camera.stop')
      expect(stopIdx).toBeGreaterThanOrEqual(0) // 崩潰保險本身出錯，鏡頭衛生不能被跳過
    } finally {
      storageState.writeCrumbShouldThrow = false
      session.teardown()
    }
  })

  it('複審 F7：writeCrumb() 丟例外時，onHidden() 仍然會執行鏡頭衛生（camera.setEnabled 收斂）', async () => {
    storageState.writeCrumbShouldThrow = true
    try {
      await bootToBattle(session, videoEl, { demoMode: false })
      callLog.length = 0 // 只看這次 visibilitychange 之後新增的記錄

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      expect(() => document.dispatchEvent(makeEvent('visibilitychange'))).not.toThrow()

      const writeIdx = callLog.findIndex((c) => c[0] === 'writeCrumb')
      const setEnabledIdx = callLog.findIndex((c) => c[0] === 'camera.setEnabled')
      expect(writeIdx).toBeGreaterThanOrEqual(0) // 真的呼叫過（然後丟了例外）
      expect(setEnabledIdx).toBeGreaterThanOrEqual(0) // 鏡頭衛生沒有被那個例外攔腰打斷
      expect(writeIdx).toBeLessThan(setEnabledIdx)

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(makeEvent('visibilitychange'))
      storageState.writeCrumbShouldThrow = false
      await session.endBattle('aborted')
    } finally {
      storageState.writeCrumbShouldThrow = false
      session.teardown()
    }
  })

  // ── task-18：endBattle() × listSessions() ──────────────────────────────

  it('task-18：endBattle() 成功後把 listSessions(60) 的結果寫進 state.history', async () => {
    const fakeHistory = [{ id: 's-1' }, { id: 's-2' }]
    storageState.listSessionsResult = fakeHistory
    try {
      await bootToBattle(session, videoEl, { demoMode: false })
      await session.endBattle('aborted')

      expect(storageMock.listSessions).toHaveBeenCalledWith(60)
      expect(session.state.history).toEqual(fakeHistory)
    } finally {
      session.teardown()
    }
  })

  it('task-18：展示模式（不 saveSession）一樣會刷新 state.history——讀歷史跟存不存本場是兩件事', async () => {
    const fakeHistory = [{ id: 's-1' }]
    storageState.listSessionsResult = fakeHistory
    try {
      await bootToBattle(session, videoEl, { demoMode: true })
      await session.endBattle('aborted')

      expect(storageMock.saveSession).not.toHaveBeenCalled()
      expect(storageMock.listSessions).toHaveBeenCalledWith(60)
      expect(session.state.history).toEqual(fakeHistory)
    } finally {
      session.teardown()
    }
  })

  // 複審第 1 輪 F1：這條測試原本斷言 listSessions() 失敗會設定
  // `state.storageError`——那是複審指出的「一欄兩用讓畫面說謊」問題本身：
  // 讀歷史失敗跟存檔失敗是兩件事，不該共用同一個欄位／同一句話。改成斷言
  // 獨立的 `state.historyError`，並鎖住連帶修正：`state.history` 必須被清空
  // 成 `[]`——不清空的話 buildSummary() 會撿到上一輪殘留的舊歷史，讓「退回
  // 冷啟動分支」這件事不會發生（見 session.js 的 F1 註解）。
  it('task-18/F1：listSessions() 丟例外時設定 state.historyError（不是 storageError）、清空 state.history，且不擋畫面切到 stats', async () => {
    storageState.listSessionsShouldThrow = true
    try {
      await bootToBattle(session, videoEl, { demoMode: false })
      // await 本身不拋出就是這條護欄成立的證據：少了 endBattle() 內部那個
      // try/catch，這裡會變成一個沒接住的 rejection（unhandled rejection），
      // 而不是讓這行 await 乾淨地拋出讓 test runner 抓到——所以不能只寫
      // `await expect(...).rejects...`，那樣反而測不出「有沒有被吞掉」。
      await session.endBattle('aborted')

      expect(session.state.screen).toBe('stats')
      expect(session.state.historyError).toBe('TypeError')
      expect(session.state.storageError).toBeNull() // saveSession() 這次是成功的，不該被牽連
      expect(session.state.history).toEqual([]) // F1 連帶修正：不能留著上一輪殘留的舊歷史
    } finally {
      storageState.listSessionsShouldThrow = false
      session.teardown()
    }
  })

  // 複審第 2 輪：上面那條測試進入 endBattle() 之前，state.history 本來就是
  // beforeEach 重置出來的 []——拿掉 catch 裡的 `state.history = []` 之後，
  // state.history 觀察起來還是 []，那條測試看不出差異（複審實測：拿掉那行，
  // 482/482 全綠）。這裡先讓 state.history 帶著非空的殘留值（模擬「上一輪
  // 讀成功、這一輪讀失敗」——真實情境下 startBattle() 刻意不歸零 history，
  // 讀失敗前 state.history 就是上一輪成功讀到的那份），再觸發 listSessions()
  // 失敗，這樣「有沒有清空」才會在斷言上留下可觀察的差異。
  it('task-18/F1/複審第 2 輪：state.history 帶著上一輪殘留值時，listSessions() 失敗仍要清空成 []，總結退回冷啟動分支', async () => {
    storageState.listSessionsShouldThrow = true
    try {
      await bootToBattle(session, videoEl, { demoMode: false })
      // 模擬上一輪成功讀到的殘留歷史——這裡故意讓它「看起來端正比例很低」，
      // 如果沒被清空、buildSummary() 撿去用，會走到「進步」或「最常發生」
      // 分支而不是冷啟動分支，跟下面的斷言對不上。
      session.rawState.history = [
        { id: 's-stale-1', durationMs: 900_000, postureDurationMs: { upright: 60_000 }, startedAt: 1 },
      ]

      await session.endBattle('aborted')

      expect(session.state.historyError).toBe('TypeError')
      expect(session.state.history).toEqual([]) // 不是「本來就是空的」，是被清空的
      expect(session.state.history).not.toEqual([{ id: 's-stale-1' }])

      // 冷啟動分支（history 為空）專屬的措辭是「你專注了…砍了魔王 N 刀」
      // （SUMMARY_COPY.firstRun）；只要 priorHistory 非空，就會走「跟上一次
      // 比」的另外三個分支（進步／最常發生／繼續保持），沒有一個含「砍了
      // 魔王」。這比單純斷言「不含進步」更有鑑別力：本場的姿態資料在這個
      // 測試裡幾乎全是 0（endBattle('aborted') 沒有真的跑過 frame 迴圈），
      // 「進步」「最常發生」在退化成全零資料時，兩個分支都可能沒觸發，
      // 沒有鑑別力；但「砍了魔王」只會出現在 priorHistory.length===0 這一
      // 個條件下，能真正分辨「history 有沒有被清空」。
      const { headline } = buildSummary(session.state.lastRecord, session.state.history)
      expect(headline).toContain('砍了魔王')
      for (const w of ['昨', '連續', '進步']) expect(headline).not.toContain(w)
    } finally {
      storageState.listSessionsShouldThrow = false
      session.rawState.history = []
      session.teardown()
    }
  })

  it('task-18/F1：saveSession() 失敗、listSessions() 成功時，只有 state.storageError 有值，state.historyError 維持 null', async () => {
    storageState.saveSessionShouldThrow = true
    storageState.listSessionsResult = [{ id: 's-old' }]
    try {
      await bootToBattle(session, videoEl, { demoMode: false })
      await session.endBattle('aborted')

      expect(session.state.storageError).toBe('TypeError')
      expect(session.state.historyError).toBeNull()
      expect(session.state.history).toEqual([{ id: 's-old' }]) // 讀歷史沒有受存檔失敗牽連
    } finally {
      storageState.saveSessionShouldThrow = false
      storageState.listSessionsResult = []
      session.teardown()
    }
  })

  it('沒有進行中的戰鬥（fsm 不存在）時，背景/pagehide 都不寫 crumb', async () => {
    const r = await session.boot(videoEl)
    expect(r.ok).toBe(true)

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(makeEvent('visibilitychange'))
    window.dispatchEvent(makeEvent('pagehide'))

    expect(storageMock.writeCrumb).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    session.teardown()
  })
})
