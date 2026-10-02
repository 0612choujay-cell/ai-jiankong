// @vitest-environment jsdom
//
// 休息回合（Task 20）在 store 這一層的行為。
//
// 這個檔案的測試骨架是從 session.cameraInvariant.test.js 移植過來的：用**真的**
// cameraCapture.js，只 mock getUserMedia／wakeLock，斷言在狀態上（live+enabled
// 的 track 數、getUserMedia 被呼叫幾次、battle 快照）而不是呼叫次數上——
// 「休息完鏡頭要活著」這種事只有真的量 track 才驗得到，斷言 `enabled === true`
// 在 stream 已經被 pagehide 停掉時會是綠的，而畫面是黑的。
//
// 三件事要證明：
//   1. 入口 A（戰鬥中）→ 出口 A：回到**同一場**，不是開新的一場。
//   2. 入口 B（結算頁）→ 出口 B：沒有進行中的戰鬥，交給呼叫端開新的一場。
//   3. 休息期間鏡頭必須關掉；休息期間螢幕鎖定（pagehide）之後回到戰鬥，
//      必須**重新 getUserMedia**，不是只把 enabled 設回 true。
import { describe, it, expect, vi, afterEach } from 'vitest'

// ---------------------------------------------------------------- 假的鏡頭
const cam = { tracks: [], gumCalls: 0 }

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
      return makeStream(makeTrack())
    }),
  },
  configurable: true,
})

function liveEnabledCount() {
  return cam.tracks.filter((t) => t.readyState === 'live' && t.enabled).length
}
function liveCount() {
  return cam.tracks.filter((t) => t.readyState === 'live').length
}

// -------------------------------------------------------------- 假的 WakeLock
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
// ＝黑影格＝valid:false。這樣「休息完回來真的還能計分」不是只取決於 store 的
// 旗標，而是真的取決於鏡頭。
let stepTick = 0
const inferenceCalls = []
function currentTrackUsable() {
  return liveEnabledCount() > 0
}
vi.mock('../core/inferenceService.js', () => ({
  createInferenceService: vi.fn(() => ({
    init: async () => ({ ok: true }),
    step: async () => {
      stepTick += 1
      const valid = currentTrackUsable()
      return stepTick % 2 === 0
        ? { key: 'pose', metrics: { valid, neckRatio: 1, shoulderWidth: 0.3 }, latencyMs: 1 }
        : { key: 'face', metrics: { valid, eyeClosed: false, gaze: 'center' }, latencyMs: 1 }
    },
    setScale: () => {},
    setEnabled: (key, enabled) => { inferenceCalls.push([key, enabled]) },
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
  el.play = vi.fn(async () => {})
  return el
}

function fireEvent(target, type) {
  const ev = document.createEvent('Event')
  ev.initEvent(type, true, true)
  target.dispatchEvent(ev)
}
function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  fireEvent(document, 'visibilitychange')
}
/** 休息中小孩把 iPad 放桌上站起來 → 螢幕自動鎖定：iOS 發 pagehide（stream 被 stop）。 */
function screenLock() {
  fireEvent(window, 'pagehide')
  setVisibility('hidden')
}

const PROFILE = { baselineNeckRatio: 1, baselineShoulderWidth: 0.3, calibratedAt: 0 }

const { useSession } = await import('./session.js')
const { default: sessionSource } = await import('./session.js?raw')

// 【分任務校準】：流程是 權限 → **選任務** → **校準** → 戰鬥。setTask() 一定
// 要排在 enterCalibration() 之前——校準畫面要讀 state.taskType 決定顯示哪一組
// 姿勢指示，而 setCalibration() 已經不再自己換畫面（換畫面是 startBattle()）。
async function playToBattle(session, videoEl) {
  expect((await session.boot(videoEl)).ok).toBe(true)
  session.enterTaskSelect()
  session.setTask({ taskType: 'homework', durationMin: 15, demoMode: false })
  await session.enterCalibration()
  session.setCalibration(PROFILE)
  await session.startBattle()
  expect(session.state.screen).toBe('battle')
}

/**
 * 複審第 1 輪 Nit-1：收尾一律放這裡，不放在每條測試的最後一行。
 *
 * session.js 是模組級單例，而這個檔案的測試依序共用它：一條測試中途紅掉就會
 * 跳過它自己的收尾（還開著的 fsm、還握著的 WakeLock、還活著的 track、停在
 * 'break' 的畫面），後面每一條都跟著紅——真正的失敗點被一片紅淹掉，而那正是
 * 這個專案最不想要的除錯體驗。afterEach 無論通過與否都會跑。
 *
 * endBattle() 在 fsm 已經是 null 時會自己早退，teardown() 也可以重複呼叫，
 * 所以「測試中途就已經收過尾」的情況不會因為這裡再收一次而出事。
 */
afterEach(async () => {
  const session = useSession()
  try {
    await session.endBattle('aborted')
  } finally {
    session.teardown()
    // 下一條測試從「前景」這個已知起點開始（鎖屏那幾條會把它留在 hidden）。
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  }
})

describe('休息回合 入口 A（戰鬥中打瞌睡）→ 回到同一場', () => {
  it('進休息時這一場被暫停、不被丟掉；離開休息回到同一場並恢復計分', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(4)

    const roundsBefore = session.perfStats().rounds
    const elapsedBefore = session.state.battle.elapsedMs
    const bossHpBefore = session.state.battle.bossHp
    expect(elapsedBefore).toBeGreaterThan(0)

    await session.enterBreak()

    expect(session.state.screen, '休息回合有自己的畫面').toBe('break')
    expect(session.state.paused, '這一場要被暫停，不是被丟掉').toBe(true)
    expect(session.state.battle.elapsedMs, '這一場的進度還在').toBe(elapsedBefore)

    // 休息三分鐘（這裡只要讓時間往前走，畫面上不會有任何計分）
    advance(180_000)

    const resumed = await session.leaveBreak()
    expect(resumed, '這一場還在，leaveBreak 自己就把人送回戰鬥了').toBe(true)
    expect(session.state.screen).toBe('battle')
    expect(session.state.paused, '回來就要恢復暫停，不然魔王一滴血都不會掉').toBe(false)

    // 關鍵斷言：**沒有開新的一場**。perfSamples.rounds 只在 startBattle() 遞增，
    // 是「有沒有偷偷重開一場」最直接的讀數；elapsedMs 也必須是接續下去的。
    expect(session.perfStats().rounds, '不得開新的一場').toBe(roundsBefore)
    expect(session.state.battle.elapsedMs, '從原本的進度接下去').toBeGreaterThanOrEqual(elapsedBefore)
    expect(session.state.battle.bossHp, '魔王血量延續，不是滿血重來').toBeLessThanOrEqual(bossHpBefore)

    await fight(4)
    expect(session.state.battle.elapsedMs, '恢復後真的繼續計分').toBeGreaterThan(elapsedBefore)
    expect(session.state.inferenceHealthy).toBe(true)

  })

  it('已經在暫停中時進休息：不會被 toggle 成「繼續」，離開後照樣恢復', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(2)

    await session.togglePause()
    expect(session.state.paused).toBe(true)

    await session.enterBreak()
    expect(session.state.paused, '進休息不得把暫停中的戰鬥變成繼續').toBe(true)
    expect(session.state.screen).toBe('break')

    await session.leaveBreak()
    expect(session.state.paused).toBe(false)
    expect(session.state.screen).toBe('battle')

  })
})

describe('休息回合 入口 B（結算頁的長時段）→ 由呼叫端開新的一場', () => {
  it('沒有進行中的戰鬥時，leaveBreak() 回傳 false（不會假裝回到某一場）', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(2)
    await session.endBattle('aborted')
    expect(session.state.screen).toBe('stats')

    await session.enterBreak()
    expect(session.state.screen).toBe('break')

    const roundsBefore = session.perfStats().rounds
    const resumed = await session.leaveBreak()

    expect(resumed, '沒有進行中的戰鬥：呼叫端要自己開新的一場').toBe(false)
    expect(session.perfStats().rounds, 'leaveBreak 自己不得開新的一場').toBe(roundsBefore)

    // 呼叫端（App.vue 的 onBreakDone）接手開新的一場
    await session.startBattle()
    expect(session.state.screen).toBe('battle')
    expect(session.perfStats().rounds).toBe(roundsBefore + 1)
    expect(liveEnabledCount(), '新的一場要有鏡頭').toBe(1)

    await fight(3)
    expect(session.state.battle.elapsedMs).toBeGreaterThan(0)

  })
})

describe('休息回合 × 鏡頭（休息時鏡頭不該開，回來時要真的活著）', () => {
  it('休息畫面不得有 live+enabled 的 track，切背景再回來也不會被打開', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(2)
    expect(liveEnabledCount()).toBe(1)

    await session.enterBreak()
    // 休息回合叫小孩站起來離開座位——他不在鏡頭前面，鏡頭亮著只會拍到空椅子
    // 跟教室裡的其他人。這是這個 App 的隱私承諾本身。
    expect(liveEnabledCount(), '休息畫面不得有 live+enabled 的鏡頭').toBe(0)

    setVisibility('hidden')
    await flush()
    expect(liveEnabledCount()).toBe(0)
    setVisibility('visible')
    await flush()
    expect(liveEnabledCount(), '從背景回到休息畫面，鏡頭一樣不得被打開').toBe(0)
    expect(heldSentinels(), '休息中不該持有喚醒鎖').toBe(0)

    await session.leaveBreak()
    expect(liveEnabledCount(), '回到戰鬥，鏡頭要回來').toBe(1)

  })

  it('轉場的順序：鏡頭不得在畫面還停在休息回合時就被打開（連 await 中間那一瞬間也不行）', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(2)
    await session.enterBreak()

    // track 還活著（這一輪沒有 pagehide）→ resume() 走快路，await 的是
    // videoEl.play()。把它掛住，就能在「鏡頭已經被打開、leaveBreak 還沒回來」
    // 這個中間狀態上取一次快照。
    let releasePlay = null
    videoEl.play = vi.fn(() => new Promise((resolve) => { releasePlay = resolve }))

    const p = session.leaveBreak()
    await flush()

    // 順序顛倒（先恢復暫停、再 setScreen('battle')）的話，這個快照會是
    // { screen: 'break', liveEnabled: 1 }——休息畫面上鏡頭亮著。終態一樣是對的，
    // 所以只斷言終態的測試抓不到它（實測：順序顛倒時所有終態斷言全綠）。
    expect({ screen: session.state.screen, liveEnabled: liveEnabledCount() })
      .toEqual({ screen: 'battle', liveEnabled: 1 })

    releasePlay()
    await flush()
    await p
    videoEl.play = vi.fn(async () => {})

    expect(session.state.screen).toBe('battle')
    expect(session.state.paused).toBe(false)
    expect(liveEnabledCount()).toBe(1)

  })

  it('休息中螢幕鎖定（pagehide 把 stream 整個 stop 掉）：回到戰鬥必須重新 getUserMedia', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(2)

    await session.enterBreak()
    expect(session.state.screen).toBe('break')

    // 三分鐘的休息，小孩把 iPad 放在桌上站起來 → 螢幕自動鎖定
    screenLock()
    await flush()
    expect(liveCount(), 'pagehide 之後整條 stream 都死了').toBe(0)

    setVisibility('visible') // 拿回 iPad、解鎖
    await flush()
    expect(liveEnabledCount(), '還在休息畫面，不該重開鏡頭').toBe(0)

    const gumBefore = cam.gumCalls
    await session.leaveBreak()

    // 這裡是這條測試的全部理由：track 已經是 ended，光把 enabled 設回 true
    // 救不回來（那個斷言在壞掉的版本上也會是綠的，畫面卻是黑的）。唯一能
    // 修好它的是重新跑一次 getUserMedia。
    expect(cam.gumCalls, '必須重新 getUserMedia，不能只把 enabled 設回 true').toBe(gumBefore + 1)
    expect(liveEnabledCount(), '回到戰鬥要有一條真的活著的 track').toBe(1)
    expect(videoEl.srcObject).not.toBeNull()
    expect(session.state.cameraHealthy).toBe(true)

    // 而且真的打得起來（黑影格會讓新鮮度看門狗凍結計分）
    const before = session.state.battle.elapsedMs
    await fight(3)
    expect(session.state.battle.elapsedMs, '休息回來要真的能繼續計分').toBeGreaterThan(before)
    expect(session.state.inferenceHealthy).toBe(true)

  })

  it('入口 B 的同一個情境：休息中螢幕鎖定，開新的一場也要重新拿到鏡頭', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(2)
    await session.endBattle('aborted')

    await session.enterBreak()
    screenLock()
    await flush()
    setVisibility('visible')
    await flush()
    expect(liveCount()).toBe(0)

    const gumBefore = cam.gumCalls
    expect(await session.leaveBreak()).toBe(false)
    await session.startBattle()

    expect(cam.gumCalls).toBe(gumBefore + 1)
    expect(liveEnabledCount(), '新的一場要有真的活著的鏡頭').toBe(1)

  })
})

// ---------------------------------------------------------------------------
// 結構性防線：`setScreen()` 是 `state.screen` 的唯一寫入者。
//
// 這一條裝在**會發生違規的那一行**上（session.js 自己），不是裝在下游會收斂的
// 終態上——實測過：把 enterBreak() 的 setScreen('break') 改成
// `state.screen = 'break'`，上面所有行為測試**全部照樣綠**（因為進休息前
// togglePause() 已經把鏡頭關掉了，這一格「繞過去、結果剛好一樣」）。而這正是
// 這個 App 過去長出分身 bug 的固定模式：每一次「先繞過去，反正結果一樣」的
// 例外，都是在等下一個畫面／下一條路徑把它變成真的 bug（第二位訪客的校準畫面
// 全黑，就是這麼來的）。所以這裡直接鎖住「整份 session.js 只准有一個寫入點」。
// ---------------------------------------------------------------------------
describe('結構：state.screen 只有 setScreen() 一個寫入者', () => {
  it('整份 session.js 只出現一次 `state.screen =`，而且就在 setScreen() 裡面', () => {
    // 複審第 1 輪 IMP-1：這裡原本用正則挖掉區塊註解
    // （`.replace(/\/\*[\s\S]*?\*\//g, '')`），那是**假陰性**——原始碼裡只要有
    // 一個字串含 `/*`，它就會把後面真正的直寫一起吃掉，護欄看起來在保護你、
    // 實際上默默放行。主線 `src/App.mount.test.js` 為同一件事明確拒絕過通用的
    // 註解挖空器，理由一字不差地適用於這裡：挖空器要處理字串內的 `//`、
    // 未閉合的 `/*`、template 與 style 的不同註解語法，任何一處判斷錯都會變成
    // 假陰性，而**假陰性沒有人會發現**。
    //
    // 改用同一套 5 行行過濾：只剔除「整行都是註解」的行。一行程式碼不可能以
    // `//`、`*`、`/*` 開頭，所以它不可能藏住真的賦值。代價是行尾註解裡若寫了
    // `state.screen = ...` 會誤報——那是可接受的方向（由人看一眼），
    // 寧可少刪而誤報，不要多刪而默默放行。
    const code = sessionSource
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
      })
      .join('\n')
    const writes = [...code.matchAll(/state\.screen\s*=(?!=)/g)]
    expect(writes.length, '新增畫面時請呼叫 setScreen()，不要直寫 state.screen').toBe(1)
    expect(code).toMatch(/function setScreen\(next\)\s*\{\s*state\.screen = next/)
    // 自我檢查：註解真的被拿掉了，上面那兩條不是在空字串上恆真。
    expect(code).toContain('async enterBreak()')
  })
})

describe('休息回合 × 推論 track（暫停的省電語意要一起帶過去）', () => {
  it('進休息時三個 track 都被關掉，回到戰鬥時重新打開', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    session.rawState.paused = false
    await playToBattle(session, videoEl)
    await fight(2)

    inferenceCalls.length = 0
    await session.enterBreak()
    expect(
      inferenceCalls.filter(([, enabled]) => enabled === true),
      '休息中不該有任何推論 track 被打開',
    ).toEqual([])
    expect(inferenceCalls.filter(([, enabled]) => enabled === false).length).toBeGreaterThanOrEqual(3)

    inferenceCalls.length = 0
    await session.leaveBreak()
    // Task 22c：這條斷言原本是「enabled===true 的呼叫數 ≥ 3」，也就是把「三個
    // track 都會被重新打開」釘死。展場預設**關閉**手機偵測（state.phoneDetectEnabled
    // 預設 false，boot() 依它初始化 object track）之後，那個 3 不再是正確答案：
    // 回到戰鬥時該重新打開的是 pose 與 face 兩個，object 要跟隨
    // state.objectDetectorOn——也就是「現在到底該不該跑手機偵測」的唯一真相
    // （來源有兩個：工作人員的明示設定，以及自動降檔）。
    //
    // 少了 setInferenceTracksEnabled() 裡那道閘門，工作人員（或展場預設）關掉的
    // 偵測會在每一次離開休息回合、每一次 startBattle()、每一次按「繼續」時被
    // 無聲打開，而 state.objectDetectorOn 還停在 false——旗標說沒在跑、實際在跑。
    expect(inferenceCalls).toContainEqual(['pose', true])
    expect(inferenceCalls).toContainEqual(['face', true])
    // 手機偵測實機驗收後改為**預設開啟**，所以三個都該回來。
    expect(session.state.objectDetectorOn).toBe(true)
    expect(inferenceCalls).toContainEqual(['object', true])

    // 另一半（同一道閘門的反向，也是這條測試真正在守的東西）：工作人員把手機
    // 偵測**關掉**之後，object 就不該再跟著 pose／face 一起回來。
    // 閘門的語意是「跟隨旗標」——不是「永遠開著」，也不是「永遠關著」。
    // 少了它，工作人員關掉的偵測會在每一次離開休息、每一次 startBattle()、
    // 每一次按「繼續」時被無聲打開，而 objectDetectorOn 還停在 false
    // ——旗標說沒在跑、實際在跑。
    session.setPhoneDetectEnabled(false)
    await session.togglePause() // 暫停：三個 track 都關掉
    inferenceCalls.length = 0
    await session.togglePause() // 繼續：這次只有 pose／face 該回來
    expect(inferenceCalls).toContainEqual(['pose', true])
    expect(inferenceCalls).toContainEqual(['face', true])
    expect(
      inferenceCalls,
      '手機偵測關著時，回到戰鬥不得順手把 object 打開',
    ).not.toContainEqual(['object', true])
    session.setPhoneDetectEnabled(true) // 還原預設，不留殘留狀態
  })
})
