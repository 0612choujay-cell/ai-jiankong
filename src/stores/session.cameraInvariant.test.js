// @vitest-environment jsdom
//
// 鏡頭不變式的總表（審查第 6 輪）。複審那句話是這個檔案的全部理由：
// **「判準統一了，入口沒統一。」** 第 5 輪把 `cameraShouldBeEnabled()` 接到了
// 每一條畫面轉場上，但 `onHidden()`／`onVisible()`（第 1、2 輪寫的）從來沒有
// 被納入判準——它們只看 `state.paused`，完全不看 `state.screen`。
//
// 這裡驗的是**雙向**紅線，一格都不能少：
//   1. UI 不在使用鏡頭時，不得有任何 live 且 enabled 的 track（隱私承諾）。
//   2. UI 在使用鏡頭時，必須有 live 且 enabled 的 track（不然是黑畫面、
//      推論吃不到東西、整場凍結，而且展場上沒有任何復原路徑）。
//
// 一律用真的 `cameraCapture.js`，只 mock `getUserMedia`／`navigator.wakeLock`；
// 斷言在狀態上（live+enabled 的 track 數、`videoEl.srcObject`、`readyState`），
// 不在呼叫次數上。
import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------- 假的鏡頭
const cam = { tracks: [], gumCalls: 0, mode: 'auto', queue: [] }

function makeTrack() {
  const t = {
    kind: 'video',
    enabled: true,
    readyState: 'live',
    onended: null,
    stop() { this.readyState = 'ended' },
  }
  cam.tracks.push(t)
  return t
}
function makeStream(track) {
  return { getTracks: () => [track], getVideoTracks: () => [track] }
}

Object.defineProperty(navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn(async () => {
      cam.gumCalls += 1
      if (cam.mode === 'auto') return makeStream(makeTrack())
      return new Promise((resolve) => { cam.queue.push(resolve) })
    }),
  },
  configurable: true,
})

/** resolve 佇列中第 index 個 in-flight 的 getUserMedia，回傳那條 track。 */
function resolveGumAt(index) {
  const [resolve] = cam.queue.splice(index, 1)
  if (!resolve) throw new Error(`沒有第 ${index} 個排隊中的 getUserMedia`)
  const t = makeTrack()
  resolve(makeStream(t))
  return t
}

/**
 * 這個檔案唯一的紅線讀數：**整個 process 裡**還有幾條 live 且 enabled 的
 * track。不是「最後一條」——孤兒 stream（boot() 連按兩下留下的那種）正好就是
 * 「不是最後一條、但還活著」的那一條，只看最後一條會完全看不到它。
 */
function liveEnabledCount() {
  return cam.tracks.filter((t) => t.readyState === 'live' && t.enabled).length
}
function liveCount() {
  return cam.tracks.filter((t) => t.readyState === 'live').length
}

// -------------------------------------------------------------- 假的 WakeLock
// sentinel 全部記下來：唯一要問的問題是「現在還有幾個沒被 release 的」——
// 螢幕會不會一直亮著，看的是這個數字，不是 request() 被呼叫過幾次。
const wlSentinels = []
Object.defineProperty(navigator, 'wakeLock', {
  value: {
    request: vi.fn(async () => {
      const s = { released: false, addEventListener() {}, release() { this.released = true } }
      wlSentinels.push(s)
      return s
    }),
  },
  configurable: true,
})
function heldSentinels() {
  return wlSentinels.filter((s) => !s.released).length
}

// ---------------------------------------------------------------- 假的推論
// metrics.valid 綁在「真的那條 track 現在是不是 live 且 enabled」上：track 關著
// ＝黑影格＝valid:false，跟真機一致。這樣「第二場真的會計分」這種斷言才真的
// 取決於鏡頭，而不是只取決於 store 的旗標。
let stepTick = 0
// inference.init() 的手動控制（模型下載那段 await）
const infCtl = { mode: 'auto', queue: [] }
function resolveInit() {
  const resolve = infCtl.queue.shift()
  if (!resolve) throw new Error('沒有排隊中的 inference.init()')
  resolve({ ok: true })
}
function currentTrackUsable() {
  return liveEnabledCount() > 0
}
vi.mock('../core/inferenceService.js', () => ({
  createInferenceService: vi.fn(() => ({
    // 模型下載在真機上是好幾秒，是整個 App 最長的一段 await——'manual' 模式讓
    // 測試可以精確安排「這段期間發生了什麼」。
    init: async () => {
      if (infCtl.mode === 'auto') return { ok: true }
      return new Promise((resolve) => { infCtl.queue.push(resolve) })
    },
    step: async () => {
      stepTick += 1
      const valid = currentTrackUsable()
      return stepTick % 2 === 0
        ? { key: 'pose', metrics: { valid, neckRatio: 1, shoulderWidth: 0.3 }, latencyMs: 1 }
        : { key: 'face', metrics: { valid, eyeClosed: false, gaze: 'center' }, latencyMs: 1 }
    },
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

// ------------------------------------------------------------ 假時鐘與 rAF
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
async function fight(seconds) {
  for (let i = 0; i < seconds * 2; i++) { advance(500); await driveFrame() }
}
async function flush() { await new Promise((resolve) => { setTimeout(resolve, 0) }) }

function makeVideoEl() {
  const el = document.createElement('video')
  el.play = vi.fn(async () => {}) // jsdom 的 play() 預設丟「Not implemented」
  return el
}

// 不用 `new Event(...)`：專案 eslint 全域清單沒列 Event（跟既有測試檔一致）。
function fireEvent(target, type) {
  const ev = document.createEvent('Event')
  ev.initEvent(type, true, true)
  target.dispatchEvent(ev)
}
function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  fireEvent(document, 'visibilitychange')
}
/** iOS Safari PWA 被系統暫停：先 pagehide（stream 整個被 stop()）再進背景。 */
function backgroundWithPageHide() {
  fireEvent(window, 'pagehide')
  setVisibility('hidden')
}

const PROFILE = { baselineNeckRatio: 1, baselineShoulderWidth: 0.3, calibratedAt: 0 }

const { useSession } = await import('./session.js')

/**
 * 從任務設定畫面走到校準（【分任務校準】的真實路徑：TaskSelector 的
 * 「開始討伐」→ App.vue 的 onTaskChosen() → setTask() → enterCalibration()）。
 *
 * 這幾條測試刻意走完整條路而不是直接呼叫 enterCalibration()：校準的姿勢指示
 * 依賴 state.taskType，而「任務有沒有先被設定好」正是這一輪反轉順序要保證的
 * 事。少了 setTask() 那一行，測試仍然會綠，但它走的就不是使用者走的那條路。
 */
async function chooseTaskThenCalibrate(session, taskType = 'homework') {
  session.setTask({ taskType, durationMin: 15, demoMode: true })
  await session.enterCalibration()
}

/** 走到 battle 畫面（未暫停、前景、鏡頭開著）。 */
async function playToBattle(session, videoEl) {
  expect((await session.boot(videoEl)).ok).toBe(true)
  session.enterTaskSelect()
  await chooseTaskThenCalibrate(session)
  session.setCalibration(PROFILE)
  await session.startBattle()
  expect(session.state.screen).toBe('battle')
}

/** 走到 stats 畫面（打一場再結束）。pauseFirst：結束前先按暫停。 */
async function playOneRound(session, videoEl, { pauseFirst = false } = {}) {
  await playToBattle(session, videoEl)
  await fight(1)
  if (pauseFirst) await session.togglePause()
  await session.endBattle('aborted')
  expect(session.state.screen).toBe('stats')
}

describe('入口統一（一）：背景／前景切換不得繞過判準', () => {
  it('A. 結算畫面切到別的 App 再回來，鏡頭不得被重新打開', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    await playOneRound(session, videoEl)
    expect(session.state.paused).toBe(false)
    expect(liveEnabledCount()).toBe(0)

    const gumBefore = cam.gumCalls
    setVisibility('hidden')
    await flush()
    setVisibility('visible')
    await flush()

    // 「開始」畫面上的綠色指示燈亮起來，而且不會自我修復——跟第 4 輪判定為
    // Critical 的症狀一字不差，只是換了一扇門（onVisible() 無條件 resume()）。
    expect(liveEnabledCount(), 'stats 畫面回前景後不得有 live+enabled 的鏡頭').toBe(0)
    expect(cam.gumCalls, 'stats 畫面不該重新要一次鏡頭').toBe(gumBefore)

    session.teardown()
  })

  it('B. 任務設定畫面切到別的 App 再回來，鏡頭不得被重新打開', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    expect((await session.boot(videoEl)).ok).toBe(true)
    // 【分任務校準】：任務設定畫面現在是權限之後的第一個畫面（校準排在它後面）。
    session.enterTaskSelect()
    expect(session.state.screen).toBe('task')
    expect(liveEnabledCount()).toBe(0)

    setVisibility('hidden')
    await flush()
    setVisibility('visible')
    await flush()

    expect(liveEnabledCount(), 'task 畫面回前景後不得有 live+enabled 的鏡頭').toBe(0)
    session.teardown()
  })

  it('C. 殘留 paused=true 的校準畫面切到背景，鏡頭必須關掉', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    await playOneRound(session, videoEl, { pauseFirst: true })
    expect(session.state.paused).toBe(true) // endBattle() 刻意不重設它

    expect((await session.boot(videoEl)).ok).toBe(true)
    session.enterTaskSelect()
    await chooseTaskThenCalibrate(session)
    expect(liveEnabledCount()).toBe(1) // 第 5 輪修好的部分：第二位訪客有鏡頭

    setVisibility('hidden')
    await flush()
    // 原本 onHidden() 開頭就 `if (state.paused) return`，殘留的 paused 讓
    // 鏡頭在背景繼續亮著。I3/I4 要保的是計分公平，不是這個。
    expect(liveEnabledCount(), 'App 進到背景，鏡頭一律關掉').toBe(0)

    setVisibility('visible')
    await flush()
    expect(liveEnabledCount(), '回到校準畫面，鏡頭要再打開').toBe(1)

    session.teardown()
  })
})

describe('入口統一（二）：pagehide 把 stream 整個 stop() 掉之後', () => {
  it('P1 未暫停就結束 → 進背景 → 回前景：開始畫面不得重新拿一次 getUserMedia', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    await playOneRound(session, videoEl)
    const gumBefore = cam.gumCalls

    backgroundWithPageHide()
    await flush()
    setVisibility('visible')
    await flush()

    expect(liveEnabledCount(), 'stats 畫面不得有 live+enabled 的鏡頭').toBe(0)
    expect(cam.gumCalls, 'stats 畫面不該重新要一次鏡頭').toBe(gumBefore)
    session.teardown()
  })

  it('P2 暫停中結束 → 進背景 → 回前景 → 按「開始」：校準畫面必須真的有鏡頭', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    await playOneRound(session, videoEl, { pauseFirst: true })
    expect(session.state.paused).toBe(true)

    backgroundWithPageHide()
    await flush()
    expect(liveCount(), 'pagehide 之後整個 stream 都該被 stop()').toBe(0)
    setVisibility('visible')
    await flush()

    // 這裡是關鍵：paused 殘留 true 時，舊的 onVisible() 會早退，沒有人重開
    // stream；而 setScreen() 的 setEnabled() 打在 null 上落空。終局是
    // srcObject=null、readyState='ended'，而且沒有任何復原路徑（暫停／繼續
    // 只長在戰鬥畫面上），只能重開 PWA。
    expect((await session.boot(videoEl)).ok).toBe(true) // 按「開始」：boot() 早退
    session.enterTaskSelect()
    await chooseTaskThenCalibrate(session)

    expect(session.state.screen).toBe('calibrate')
    expect(liveEnabledCount(), '第二位訪客的校準畫面必須有鏡頭').toBe(1)
    expect(videoEl.srcObject).not.toBeNull()

    // 而且真的打得起來（黑影格會讓新鮮度看門狗凍結計分）。
    session.setCalibration(PROFILE)
    await session.startBattle()
    await fight(3)
    expect(session.state.inferenceHealthy).toBe(true)
    expect(session.state.battle.elapsedMs).toBeGreaterThan(0)

    await session.endBattle('aborted')
    session.teardown()
  })

  it('P3 校準畫面途中進背景再回來：stream 已死，必須重新拿一次鏡頭', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    expect((await session.boot(videoEl)).ok).toBe(true)
    session.rawState.paused = false
    session.enterTaskSelect()
    await chooseTaskThenCalibrate(session)
    expect(liveEnabledCount()).toBe(1)

    backgroundWithPageHide()
    await flush()
    expect(liveCount()).toBe(0)

    setVisibility('visible')
    await flush()
    // 這一格是判準的另一個方向：UI 在用鏡頭時，鏡頭**必須**是 live+enabled。
    expect(liveEnabledCount(), '回到校準畫面，鏡頭必須重新接上').toBe(1)
    expect(videoEl.srcObject).not.toBeNull()
    expect(session.state.cameraHealthy).toBe(true)

    session.teardown()
  })
})

// 【分任務校準】：這一組原本只有一條測試，鎖的是「任務設定畫面期間 stream
// 死掉 → 按開始打 → startBattle() 補救」。順序反轉之後，**任務畫面後面接的
// 是校準，不是戰鬥**，所以那條路上真正補救的人換成了 enterCalibration()。
//
// 這不是把保護拿掉，是拆成兩條、把兩個補救點各鎖一次——而且第二條在新流程下
// 比以前更重要：「再討伐一次」是全 App 唯一一條**不經過校準就進戰鬥**的路
// （那是刻意的，見 App.vue 的 onAgain()：這個年齡層要越快回到戰鬥越好），
// 所以 stats → battle 這一段少了 startBattle() 的非同步收斂就沒有任何人接。
describe('入口統一（六）：進戰鬥前的兩個補救點（stream 已經被 pagehide 停掉）', () => {
  it('六-1 任務設定畫面期間進背景 → 按「開始討伐」：校準畫面必須真的有鏡頭（enterCalibration 補救）', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    expect((await session.boot(videoEl)).ok).toBe(true)
    session.enterTaskSelect()
    expect(session.state.screen).toBe('task')

    backgroundWithPageHide()
    await flush()
    setVisibility('visible')
    await flush()
    // 任務設定畫面不該重開鏡頭（隱私紅線的那個方向），所以回到前景之後
    // stream 仍然是死的——能救它的是下一步的 enterCalibration()。
    expect(liveCount(), 'task 畫面回前景後不該有任何 live track').toBe(0)

    await chooseTaskThenCalibrate(session)
    expect(session.state.screen).toBe('calibrate')
    expect(liveEnabledCount(), '校準畫面必須有鏡頭').toBe(1)
    expect(videoEl.srcObject).not.toBeNull()
    expect(session.state.cameraHealthy).toBe(true)

    // 而且接著真的打得起來。
    session.setCalibration(PROFILE)
    await session.startBattle()
    await fight(3)
    expect(session.state.inferenceHealthy).toBe(true)
    expect(session.state.battle.elapsedMs).toBeGreaterThan(0)

    await session.endBattle('aborted')
    session.teardown()
  })

  it('六-2 結算畫面期間進背景 → 按「再討伐一次」（不重跑校準）：戰鬥畫面必須真的有鏡頭（startBattle 補救）', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playOneRound(session, videoEl)

    backgroundWithPageHide() // 上一場打完，小孩放著去喝水，iPad 睡著了
    await flush()
    setVisibility('visible')
    await flush()
    // 結算畫面不該重開鏡頭（隱私紅線），所以 stream 仍然是死的。「再討伐
    // 一次」不經過校準，所以這條路上唯一會重新 getUserMedia 的就是
    // startBattle() 的非同步收斂層。
    expect(liveCount(), 'stats 畫面回前景後不該有任何 live track').toBe(0)

    await session.startBattle() // ← App.vue 的 onAgain()：沿用同一份校準與任務設定
    expect(session.state.screen).toBe('battle')
    expect(liveEnabledCount(), '戰鬥畫面必須有鏡頭').toBe(1)
    expect(videoEl.srcObject).not.toBeNull()

    await fight(3)
    expect(session.state.inferenceHealthy).toBe(true)
    expect(session.state.battle.elapsedMs).toBeGreaterThan(0)

    await session.endBattle('aborted')
    session.teardown()
  })
})

describe('入口統一（三）：boot() 連按兩下不得留下沒人管的 live track', () => {
  it('「開始」連按兩下（第一次還卡在 getUserMedia）：不得有孤兒 stream', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    cam.mode = 'manual'

    const b1 = session.boot(videoEl) // 第 1 下
    await flush()
    const b2 = session.boot(videoEl) // 第 2 下：state.booted 還是 false，不會早退
    await flush()

    // 沒有 in-flight 防護時這裡會是 2——第二個 capture 直接覆寫模組變數
    // `camera`，第一個拿到的 stream 從此沒有任何人持有參照。
    expect(cam.queue.length, '「開始」按兩下不該建立第二個 capture').toBe(1)

    resolveGumAt(0)
    await flush()
    expect((await b1).ok).toBe(true)
    expect((await b2).ok).toBe(true)
    cam.mode = 'auto'

    session.enterTaskSelect()
    await chooseTaskThenCalibrate(session)
    expect(liveEnabledCount()).toBe(1)

    // 打完一場回到結算畫面：判準說鏡頭該關。孤兒 stream 的檢查關鍵在
    // liveEnabledCount() 數的是**整個 process** 裡還活著的 track，不是
    // 「最後一條」——第一次 boot 留下的那條正好就是「不是最後一條、但還
    // 活著」的那一條（見該函式的說明）。
    session.setCalibration(PROFILE)
    await session.startBattle()
    await session.endBattle('aborted')
    expect(liveEnabledCount(), 'UI 不在使用鏡頭時，不得有任何 live+enabled 的 track').toBe(0)

    session.teardown()
    expect(liveCount(), 'teardown() 之後不得有任何 live track').toBe(0)
  })

  it('模型下載途中就 teardown()：落地後不得留下 live track，也不得把自己標成 booted', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    // 鏡頭已經拿到（權限給了），卡在 MediaPipe 模型下載那段 await——真機上
    // 這是整個 App 最長的一段空窗，好幾秒。
    infCtl.mode = 'manual'
    const b = session.boot(videoEl)
    await flush()
    expect(infCtl.queue.length, 'boot 卡在 inference.init()').toBe(1)
    expect(liveCount(), '此時鏡頭已經開著了').toBe(1)

    session.teardown() // App 在模型下載期間被卸載
    resolveInit()
    await flush()
    const r = await b
    infCtl.mode = 'auto'

    expect(liveCount(), 'teardown 之後 boot 落地不得留下 live track').toBe(0)
    // booted 若被設回 true，下次掛載時 boot() 會因為早退而完全不重開鏡頭——
    // 使用者會直接站在一台關掉的鏡頭前面（第 5 輪那個 blocking 的形狀）。
    expect(session.state.booted, '卸載之後不得把自己標成 booted').toBe(false)
    expect(r.ok).toBe(false)
  })
})

describe('入口統一（五）：非同步收斂層在 await 之後必須重新比對判準', () => {
  // syncCameraAsync() 的 await 是一次完整的 getUserMedia（真機數百毫秒）。
  // 落地時世界可能已經變了——不重新比對判準的話，這個函式自己就是下一個分身，
  // 症狀跟第 4 輪那個 Critical 一模一樣（畫面已經離開，鏡頭卻被打開）。
  it('背景回到戰鬥畫面、getUserMedia 還在飛的時候按「結束」：落地後不得在結算畫面打開鏡頭', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    expect((await session.boot(videoEl)).ok).toBe(true)
    session.enterTaskSelect()
    await chooseTaskThenCalibrate(session)
    session.setCalibration(PROFILE)
    await session.startBattle()
    await fight(1)

    backgroundWithPageHide() // 切到別的 App：stream 整個被 stop()
    await flush()
    expect(liveCount()).toBe(0)

    cam.mode = 'manual' // 讓重開鏡頭卡在 getUserMedia，模擬真機那數百毫秒
    setVisibility('visible')
    await flush()
    expect(cam.queue.length, '回到戰鬥畫面要重新拿鏡頭').toBe(1)

    await session.endBattle('aborted') // 使用者在這段空窗裡按了「結束」
    expect(session.state.screen).toBe('stats')

    const late = resolveGumAt(0) // 遲到的 getUserMedia 現在才落地
    await flush()

    expect(late.readyState).toBe('live') // stream 真的接上了（不是被丟棄）
    expect(liveEnabledCount(), '結算畫面不得有 live+enabled 的鏡頭').toBe(0)
    expect(session.state.screen).toBe('stats')

    cam.mode = 'auto'
    session.teardown()
  })

  it('校準畫面重開鏡頭途中切到別的 App：落地後不得在背景把鏡頭打開', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    expect((await session.boot(videoEl)).ok).toBe(true)
    session.enterTaskSelect()
    await chooseTaskThenCalibrate(session)
    expect(liveEnabledCount()).toBe(1)

    backgroundWithPageHide()
    await flush()

    cam.mode = 'manual'
    setVisibility('visible') // 回前景 → 重開鏡頭，卡在 getUserMedia
    await flush()
    expect(cam.queue.length).toBe(1)

    setVisibility('hidden') // 使用者又切走了（這次沒有 pagehide，stream 不會被丟棄）
    await flush()

    const late = resolveGumAt(0)
    await flush()

    // 判準必須認得「App 在背景」這個維度，否則這裡 screen 還是 'calibrate'，
    // 落地後就會把鏡頭在背景打開——而 onHidden() 那行早就跑完了，不會再有人來關。
    expect(liveEnabledCount(), 'App 在背景時不得有 live+enabled 的鏡頭').toBe(0)
    // 第 7 輪把這一格收緊了：這條 stream 是在「沒有人要它」的世界裡才誕生的
    // （使用者在 getUserMedia 落地前就切走了），所以整條放掉，不是留一條
    // disabled 的 track 掛在 videoEl 上（見 convergeCameraAfterAwait()）。
    // 第 6 輪這裡斷言的是 `late.readyState === 'live'`，那是當時的實作行為；
    // 現在的正確答案是 'ended' ＋ srcObject 清空。
    expect(late.readyState, 'App 在背景時不該留著這條剛誕生的 stream').toBe('ended')
    expect(videoEl.srcObject, 'App 在背景時不該掛著 srcObject').toBeNull()

    cam.mode = 'auto'
    setVisibility('visible')
    await flush()
    expect(liveEnabledCount(), '再回前景，校準畫面要有鏡頭').toBe(1)
    session.teardown()
  })
})

// ---------------------------------------------------------------------------
// 第 7 輪：複審找到的第八個分身，以及「兩套世代計數器互不作廢」。
// 這一組是照複審留在 scratchpad 的 X1-a／X1-c／X2／X8／X8-b 移植過來的
// （移植前先確認它們在第 6 輪的程式碼上是紅的，結果見報告）。
// ---------------------------------------------------------------------------
describe('入口統一（七）：togglePause() 恢復分支的 await 空窗 × 世界變化', () => {
  it('X1-a 慢路重開鏡頭途中切到背景（只有 visibilitychange、沒有 pagehide）：落地後不得在背景留下鏡頭', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(1)

    await session.togglePause() // 暫停（把 iPad 交出去之前）
    expect(session.state.paused).toBe(true)
    expect(liveEnabledCount()).toBe(0)

    backgroundWithPageHide() // 交出 iPad：PWA 被系統凍結，stream 整個被 stop()
    await flush()
    expect(liveCount()).toBe(0)
    setVisibility('visible') // 拿回來
    await flush()
    expect(liveEnabledCount(), '還在暫停中').toBe(0)

    cam.mode = 'manual'
    const p = session.togglePause() // 按「繼續」：resume() 走 getUserMedia 慢路
    await flush()
    expect(cam.queue.length, '繼續必須重新拿鏡頭').toBe(1)

    // 真機數百毫秒的空窗中使用者又切走了——鎖屏／下拉控制中心／分割視窗，
    // iOS 這些只發 visibilitychange，**不發 pagehide**，所以 stream 不會被
    // cameraCapture 自己的世代丟棄，而是真的會接上來。
    setVisibility('hidden')
    await flush()

    resolveGumAt(0) // 遲到的 getUserMedia 現在才落地
    await flush()
    await p
    cam.mode = 'auto'

    // 第 6 輪這裡是 live+enabled=1 且 srcObject 掛著，而且不會自我修復——
    // 跟第 4 輪判定為 Critical 的紅線一字不差，只是第八扇門。
    expect(liveEnabledCount(), 'App 在背景時不得有 live+enabled 的鏡頭').toBe(0)
    expect(videoEl.srcObject, 'App 在背景時不該掛著 stream').toBeNull()

    setVisibility('visible')
    await flush()
    session.teardown()
  })

  it('X1-b 對照組：快路（track 還活著，await 的是 videoEl.play()）本來就是安全的', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(1)
    await session.togglePause()
    expect(liveEnabledCount()).toBe(0)

    // 不發 pagehide：track 還活著 → resume() 走快路，setTrackEnabled(true) 在
    // onHidden() 之前就跑完了，所以 onHidden() 的收斂真的打得到那條 track。
    let releasePlay = null
    videoEl.play = vi.fn(() => new Promise((resolve) => { releasePlay = resolve }))
    const p = session.togglePause()
    await flush()
    setVisibility('hidden')
    await flush()
    releasePlay()
    await flush()
    await p

    expect(liveEnabledCount(), '快路：背景中一樣不得 live+enabled').toBe(0)
    videoEl.play = vi.fn(async () => {})
    setVisibility('visible')
    await flush()
    session.teardown()
  })

  it('X1-c 同一條路上的 WakeLock 分身：落地後不得在背景重新取得喚醒鎖', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(1)
    await session.togglePause()
    backgroundWithPageHide()
    await flush()
    setVisibility('visible')
    await flush()

    cam.mode = 'manual'
    const p = session.togglePause() // 繼續：卡在 getUserMedia
    await flush()
    setVisibility('hidden') // 空窗中又切走
    await flush()
    expect(heldSentinels(), 'onHidden() 已經放掉喚醒鎖').toBe(0)

    resolveGumAt(0)
    await flush()
    await p
    cam.mode = 'auto'

    expect(heldSentinels(), '背景中不該持有喚醒鎖（螢幕永不變暗）').toBe(0)
    setVisibility('visible')
    await flush()
    session.teardown()
  })
})

describe('入口統一（八）：單一世代計數器（兩套計數器會彼此不作廢）', () => {
  it('X2 onVisible 的重開鏡頭與 togglePause 的重開鏡頭併發、亂序落地：過期的觀測不得寫壞 cameraHealthy', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(1)

    backgroundWithPageHide() // 戰鬥中直接切走（沒按暫停）
    await flush()
    expect(liveCount()).toBe(0)

    cam.mode = 'manual'
    setVisibility('visible') // onVisible → 重開鏡頭，gUM#1 in-flight
    await flush()
    expect(cam.queue.length).toBe(1)

    await session.togglePause() // 按「暫停」（同步分支）
    const p2 = session.togglePause() // 再按「繼續」→ gUM#2 in-flight
    await flush()
    expect(cam.queue.length).toBe(2)

    const good = resolveGumAt(1) // 真正生效的第 2 次先落地
    await flush()
    await p2
    expect(good.readyState).toBe('live')
    expect(liveEnabledCount(), '鏡頭真的接上了').toBe(1)
    expect(session.state.cameraHealthy).toBe(true)

    resolveGumAt(0) // 過期的第 1 次（onVisible 那條）慢半拍才落地
    await flush()
    cam.mode = 'auto'

    // 兩套計數器時：onVisible 的 syncCameraAsync 看自己的 cameraSyncGen「沒變」，
    // 於是把 cameraHealthy 寫成過期的 false → scoringAllowed() 為假 → 整場凍結。
    expect(liveEnabledCount(), '鏡頭仍然是好的').toBe(1)
    expect(session.state.cameraHealthy, '不得被過期的觀測寫成 false').toBe(true)

    const before = session.state.battle.elapsedMs
    await fight(3)
    expect(session.state.battle.elapsedMs, '計分不得被凍結').toBeGreaterThan(before)

    await session.endBattle('aborted')
    session.teardown()
  })
})

describe('入口統一（九）：startBattle() 的 await 空窗', () => {
  // App.vue 的 onCalibrated() 一呼叫 startBattle()，setScreen('battle') 是同步的
  // ——戰鬥畫面（含「結束」「暫停」兩顆按鈕）在 await 期間就已經渲染出來了。
  //
  // 【分任務校準】：走的路線換成「打完一場 → 結算畫面上 iPad 睡著（stream 被
  // pagehide 停掉）→ 按『再討伐一次』」。理由是順序反轉之後，battle 的前一個
  // 畫面是 calibrate（鏡頭本來就開著、而且 enterCalibration() 會先救一次），
  // 唯一還會讓 startBattle() 面對一台死掉的鏡頭的真實路徑，就是不經過校準的
  // 「再討伐一次」。要驗的東西（await 空窗裡按結束／按暫停）一字未改。
  async function startBattleWithDeadCamera(session, videoEl) {
    await playOneRound(session, videoEl)
    backgroundWithPageHide() // 結算畫面上 App 被凍結過，stream 已死
    await flush()
    setVisibility('visible')
    await flush()
    expect(liveCount(), 'stats 畫面不該重開鏡頭').toBe(0)
    cam.mode = 'manual'
    const bp = session.startBattle() // ←「再討伐一次」：沿用同一份校準與任務設定
    await flush()
    expect(session.state.screen, '畫面同步就切到 battle 了').toBe('battle')
    expect(cam.queue.length, 'startBattle 正在重新拿鏡頭').toBe(1)
    // 包在物件裡回傳：async function 直接 return 一個 pending promise 會被
    // await 展開，呼叫端就會卡在「等 startBattle 跑完」而不是拿到它的 handle。
    return { bp }
  }

  it('X8 空窗中按「結束」：落地後不得重新取回喚醒鎖、不得留下孤兒 rAF 迴圈、鏡頭不得開', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    const { bp } = await startBattleWithDeadCamera(session, videoEl)

    await session.endBattle('aborted') // 小孩在空窗裡按了「結束」
    expect(session.state.screen).toBe('stats')
    const heldAfterEnd = heldSentinels()

    resolveGumAt(0)
    await flush()
    await bp
    cam.mode = 'auto'

    expect(liveEnabledCount(), '結算畫面不得有 live+enabled 的鏡頭').toBe(0)
    expect({
      heldAfterEnd,
      heldAfterLanding: heldSentinels(),
      orphanFrameLoop: pendingFrame !== null,
    }).toEqual({ heldAfterEnd: 0, heldAfterLanding: 0, orphanFrameLoop: false })

    session.teardown()
  })

  it('X8-b 空窗中按「暫停」：推論 track 與鏡頭都不得被重新打開，但這一場必須還活著', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    expect((await session.boot(videoEl)).ok).toBe(true)
    const inferenceCalls = []
    session.inference().setEnabled = (key, enabled) => { inferenceCalls.push([key, enabled]) }

    session.enterTaskSelect()
    await chooseTaskThenCalibrate(session)
    session.setCalibration(PROFILE)
    await session.startBattle()
    await session.endBattle('aborted') // → stats（「再討伐一次」的起點）
    backgroundWithPageHide()
    await flush()
    setVisibility('visible')
    await flush()
    cam.mode = 'manual'
    const bp = session.startBattle()
    await flush()

    await session.togglePause() // 空窗中按「暫停」
    expect(session.state.paused).toBe(true)
    inferenceCalls.length = 0

    resolveGumAt(0)
    await flush()
    await bp
    cam.mode = 'auto'

    expect(liveEnabledCount(), '暫停中不得有 live+enabled 的鏡頭').toBe(0)
    expect(inferenceCalls.filter(([, enabled]) => enabled === true), '暫停中不該把推論 track 重新打開').toEqual([])
    expect(heldSentinels(), '暫停中不該持有喚醒鎖').toBe(0)
    // 「按暫停」跟「按結束」是兩件不同的事：這一場還在，rAF 迴圈必須照常排，
    // 否則按「繼續」之後整場永遠不會再動（合併世代計數器時最容易踩的坑）。
    expect(pendingFrame, '這一場還在，迴圈要活著').not.toBeNull()

    await session.togglePause() // 按「繼續」
    await flush()
    const before = session.state.battle.elapsedMs
    await fight(3)
    expect(session.state.battle.elapsedMs, '繼續之後要真的恢復計分').toBeGreaterThan(before)

    await session.endBattle('aborted')
    session.teardown()
  })
})

describe('入口統一（四）：screen × paused × 背景事件 窮舉', () => {
  // 每一格都雙向驗證，而且每一格都跑一次背景往返——第 5 輪的窮舉只涵蓋轉場，
  // 加上 visibilitychange 之後才看得到 onHidden()/onVisible() 繞過判準。
  const rows = []
  async function cell(session, label, expected) {
    expect(liveEnabledCount(), `${label}：靜態`).toBe(expected ? 1 : 0)
    setVisibility('hidden')
    await flush()
    expect(liveEnabledCount(), `${label}：進背景時鏡頭一律關掉`).toBe(0)
    setVisibility('visible')
    await flush()
    expect(liveEnabledCount(), `${label}：回前景要收斂回判準說的樣子`).toBe(expected ? 1 : 0)
    rows.push(`PASS | ${label} | 期望鏡頭=${expected ? 'ON' : 'OFF'}`)
  }

  it('走完一整條路徑，每一格都量鏡頭（含背景往返）', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    // 這個檔案的測試共用同一個 session 單例依序執行（session.js 本來就是模組級
    // 單例），而 teardown() 正確地不重設 screen／paused——真正的 App 卸載後不會
    // 有「下一場」。窮舉表要從第一格開始量，所以顯式歸零建立已知起點。
    // （此時上一條測試的 teardown() 已經把所有 track 都 stop() 掉了，直接寫
    // screen 不會讓任何鏡頭處於未收斂的狀態，下一行就是斷言。）
    session.rawState.paused = false
    session.rawState.screen = 'privacy'

    expect(session.state.screen).toBe('privacy')
    expect(liveEnabledCount(), 'privacy（boot 前）：根本還沒有 track').toBe(0)

    expect((await session.boot(videoEl)).ok).toBe(true)
    // boot() 成功之後、轉場之前仍然是 privacy 畫面：權限剛拿到，但畫面上還
    // 沒有任何東西在用鏡頭。
    await cell(session, 'privacy（boot 後、轉場前）× paused=false', false)

    // Task 19：'permission'（PermissionGate 說明頁）跟 'privacy' 是同一類——
    // 使用者看得到、但不預期鏡頭在運作（cameraShouldBeEnabled() 沒有把它列進
    // 判準的 OR 鏈），這裡把它也納入窮舉，不要讓新畫面成為表格外的例外。
    session.enterPermission()
    await cell(session, 'permission × paused=false', false)

    // 【分任務校準】：這張表的順序跟著流程一起反轉——'task' 從「校準之後」
    // 移到「校準之前」。**兩格的期望值都沒有變**（task=OFF、calibrate=ON），
    // 而這正是重點：判準問的是「這個畫面上的使用者看得到、也預期得到鏡頭
    // 在運作嗎」，不是「這個畫面排在第幾個」。順序可以改，答案不跟著改。
    session.enterTaskSelect()
    await cell(session, 'task × paused=false', false)

    await chooseTaskThenCalibrate(session)
    await cell(session, 'calibrate × paused=false', true)

    session.setCalibration(PROFILE)
    // setCalibration() 不再改畫面（【分任務校準】），所以這裡還在 calibrate、
    // 鏡頭還開著——這一行順便鎖住那件事，不進 rows（上面那一格已經量過）。
    expect(session.state.screen, 'setCalibration() 不得改畫面').toBe('calibrate')
    expect(liveEnabledCount(), '還在校準畫面，鏡頭照樣開著').toBe(1)

    await session.startBattle()
    await cell(session, 'battle × paused=false', true)

    await fight(1)
    await session.togglePause()
    expect(session.state.paused).toBe(true)
    await cell(session, 'battle × paused=true', false)

    await session.endBattle('aborted')
    expect(session.state.paused).toBe(true) // 暫停中直接結束，paused 會殘留
    await cell(session, 'stats × paused=true（殘留）', false)

    // 第二位訪客：按「開始」→ 選任務 → 校準（新順序）。'task' 這一格在
    // paused=true 殘留之下也要量一次——這張表的價值就是「每一個畫面 × 每一種
    // paused 都有人量過」。
    expect((await session.boot(videoEl)).ok).toBe(true)
    session.enterTaskSelect()
    await cell(session, 'task × paused=true（殘留）', false)

    await chooseTaskThenCalibrate(session)
    await cell(session, 'calibrate × paused=true（殘留）', true)

    session.setCalibration(PROFILE)

    // Task 22c：'lab'（ThresholdLab 量測畫面）是 'calibrate' 之後**第一個
    // 鏡頭要開的新畫面**，照這張表自己在 'permission' 那一列立下的規則納入
    // 窮舉——不要讓新畫面成為表格外的例外。判準對 'lab' 不看 paused（跟
    // 'calibrate' 同一類：那是戰鬥畫面內部的狀態），所以殘留的 paused=true
    // 之下鏡頭照樣要開。量測的人正對著鏡頭調整坐姿，看得到也預期得到。
    await session.enterLab()
    await cell(session, 'lab × paused=true（殘留）', true)

    // 出口也要量：leaveLab() 回 'task'，鏡頭必須跟著關掉（這一格不進 rows，
    // 因為 'task × paused=true（殘留）' 上面已經量過了，這裡只鎖住「從 lab
    // 離開」這條路本身有沒有收斂）。
    session.leaveLab()
    expect(liveEnabledCount(), 'leaveLab() 之後鏡頭要關掉').toBe(0)

    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
    await session.startBattle()
    expect(session.state.paused).toBe(false) // startBattle() 會重設
    await cell(session, 'battle × paused=false（第二場）', true)

    await session.endBattle('aborted')
    await cell(session, 'stats × paused=false', false)

    // 另一半的 'lab'：paused=false（正常情況，工作人員從任務畫面的設定面板
    // 進來量測）。走的是跟上面那一格完全相同的判準，但兩格都要在表上——
    // 這張表的價值就是「每一個畫面 × 每一種 paused 都有人量過」。
    session.backToTaskSelect()
    await session.enterLab()
    await cell(session, 'lab × paused=false', true)
    session.leaveLab()
    expect(liveEnabledCount(), 'leaveLab() 之後鏡頭要關掉').toBe(0)

    expect(rows.length).toBe(13)
    session.teardown()
    expect(liveCount(), '收工：不得留下任何 live track').toBe(0)
  })
})
