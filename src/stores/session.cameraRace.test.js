// @vitest-environment jsdom
//
// N1/N2（審查第 3 輪）是 togglePause() 恢復分支跨 await 的競態，只有在真的
// cameraCapture.js（含它自己的 generation counter）跟 session.js 的呼叫時機
// 交互作用時才會出現——mock 掉 cameraCapture.js 會讓測試變成在驗證我自己寫的
// 假象，不是驗證真的行為。這個檔案刻意**不 mock cameraCapture.js**，只 mock
// getUserMedia 這個瀏覽器 API 邊界，換取「可以手動控制哪一次呼叫、什麼時候
// 真的 resolve」的能力——真機上這段是幾百毫秒的不確定延遲，這裡把它變成
// 完全可控、可重現的節奏。
//
// 斷言的終點一律是「有沒有活著且 enabled 的 track」「videoEl.srcObject 是否
// 被指派」「WakeLock 的 sentinel 是否已經 released」，不是「有沒有呼叫某個
// 函式」——這是複審在上一輪點名的教訓：只斷言呼叫次數測不出真正的使用者
// 可見的違規。
//
// fix round（測試鑑別力 I-1／Ruling CH(b)）：這個檔案原本也讓所有測試共用
// 同一個 session 單例依序執行（前三條測試裡那句「顯式歸零才能保證從已知的
// 起點開始」就是它的補丁）。`--sequence.shuffle` 下它會紅 0～6 條，隨機。
// 改成每條測試用 `vi.resetModules()` 拿一個真正全新的 session.js 實例：
// 那些從外面碰不到的模組級變數（camGen／frameGen／fsm／perf／battleStartAt…）
// 是「顯式歸零」到不了的地方，只有 resetModules 才真的乾淨。
// 三個替身佇列（getUserMedia／wakeLock／可見性）也一起在 beforeEach 歸零。
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'

// 可控的 inference.step()：預設跟原本一樣回傳 null（既有測試的行為完全不變），
// 只有下面「過期影格」那一組會把它換成一個手動控制什麼時候落地的 Promise。
// 用 vi.hoisted 是因為 vi.mock 的工廠會被提升到檔案最上面，不能直接參照
// 一般的模組變數。
const { stepControl } = vi.hoisted(() => ({ stepControl: { impl: async () => null } }))

vi.mock('../core/inferenceService.js', () => ({
  createInferenceService: vi.fn(() => ({
    init: async () => ({ ok: true }),
    step: async (...args) => stepControl.impl(...args),
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

function makeFakeTrack() {
  return {
    kind: 'video',
    enabled: true,
    readyState: 'live',
    onended: null,
    stop() { this.readyState = 'ended' },
  }
}

function makeFakeStream(track) {
  return { getTracks: () => [track], getVideoTracks: () => [track] }
}

// 手動控制的 getUserMedia 佇列：每次呼叫都排進佇列、不自動 resolve，讓測試
// 可以精確安排「哪一次呼叫、什麼時候真的拿到 stream」。
let gumQueue = []
function fakeGetUserMedia() {
  return new Promise((resolve) => { gumQueue.push(resolve) })
}
function resolveGumAt(index) {
  const track = makeFakeTrack()
  const [resolve] = gumQueue.splice(index, 1)
  if (!resolve) throw new Error(`沒有排隊中的第 ${index} 個 getUserMedia 呼叫可以 resolve`)
  resolve(makeFakeStream(track))
  return track
}
function resolveNextGum() {
  return resolveGumAt(0)
}

Object.defineProperty(navigator, 'mediaDevices', {
  value: { getUserMedia: vi.fn(fakeGetUserMedia) },
  configurable: true,
})

// 手動控制的 WakeLock：navigator.wakeLock 在 jsdom 裡本來就不存在，createWakeLock()
// 會直接短路回傳 false——沒有東西可以「持有」，測不出 N1 的 WakeLock 分身
// （await 期間又被取代，結束時 wakeHeld 必須是 false）。這裡補一個可控的假 API，
// sentinel 的 released 旗標就是測試唯一需要讀的「有沒有真的放掉」證據。
//
// 預設 'auto'：request() 立刻 resolve，不擋住任何一條測試裡「這次呼叫其實
// 沒被取代、應該正常往下跑完」的路徑。只有專門測 WakeLock 那條會切成
// 'manual'，換取「可以手動控制什麼時候真的拿到 sentinel」的能力。
let wakeLockMode = 'auto'
let wakeLockQueue = []
function makeFakeSentinel() {
  return {
    released: false,
    listeners: new Set(),
    addEventListener(type, fn) { this.listeners.add(fn) },
    release() {
      if (this.released) return
      this.released = true
      for (const fn of this.listeners) fn()
    },
  }
}
async function fakeWakeLockRequest() {
  if (wakeLockMode === 'auto') return makeFakeSentinel()
  return new Promise((resolve) => { wakeLockQueue.push(resolve) })
}
function resolveNextWakeLock() {
  const sentinel = makeFakeSentinel()
  const resolve = wakeLockQueue.shift()
  if (!resolve) throw new Error('沒有排隊中的 wakeLock.request() 呼叫可以 resolve')
  resolve(sentinel)
  return sentinel
}
Object.defineProperty(navigator, 'wakeLock', {
  value: { request: vi.fn(fakeWakeLockRequest) },
  configurable: true,
})

function makeVideoEl() {
  const el = document.createElement('video')
  // jsdom 的 HTMLMediaElement.play() 預設丟「Not implemented」。
  el.play = vi.fn(async () => {})
  return el
}

async function flush() {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function makeEvent(type) {
  // 不用 `new Event(...)`：專案 eslint 全域清單沒列 Event，不想為了一個
  // 測試檔去動共用的 eslint.config.js（跟 session.test.js 的作法一致）。
  const ev = document.createEvent('Event')
  ev.initEvent(type, true, true)
  return ev
}

/** 跟 session.test.js／session.cameraInvariant.test.js 同一套手法。 */
function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  document.dispatchEvent(makeEvent('visibilitychange'))
}

// 每條測試一份全新的 session.js 模組實例。`useSession` 由 beforeEach 換掉，
// 所以每條測試裡的 `useSession()` 拿到的都是這一條自己的那一份。
let useSession = null

beforeEach(async () => {
  gumQueue = []
  wakeLockQueue = []
  wakeLockMode = 'auto'
  stepControl.impl = async () => null
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.resetModules()
  ;({ useSession } = await import('./session.js'))
})

afterEach(() => {
  // teardown() 會解掉 visibilitychange／pagehide 的監聽器。漏掉的話，被丟棄的
  // 舊模組實例會留在 document／window 上，之後每一次 dispatchEvent 都會多叫醒
  // 幾個殭屍——那正是這個檔案原本在防的那種殘留，只是換了一個形狀。
  useSession?.().teardown()
  useSession = null
})

describe('session store × 真的 cameraCapture.js：togglePause() 跨 await 的競態（N1/N2）', () => {
  it('連按兩下（繼續 → resume 走 start() 重開的慢路 → 再按暫停）：落地後不能同時「活著且 enabled」', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()

    const bootPromise = session.boot(videoEl)
    // task-17：bootOnce() 現在在 camera.start() 之前多一個 await reconcile()
    // （崩潰復原，讀 localStorage crumb），這裡先讓那個 microtask 落地，
    // 不然 camera.start() 的 getUserMedia 還沒被呼叫，佇列裡什麼都沒有。
    await flush()
    const initialTrack = resolveNextGum() // boot() 內 camera.start() 的第一次 getUserMedia
    await flush()
    expect((await bootPromise).ok).toBe(true)
    // teardown() 不會重置 state.paused（真正的 App 卸載後不會有「下一場」，
    // 這個欄位本來就沒有跨場景重置的需求）；但這個檔案裡的測試共用同一個
    // session 單例依序執行，前一條測試結束時的 paused 值會原封不動留到這裡，
    // 顯式歸零才能保證每條測試從已知的起點開始。
    session.rawState.paused = false

    await session.togglePause() // 暫停
    expect(session.state.paused).toBe(true)

    // 模擬切到別的 App：iOS Safari PWA 被系統暫停時會發 pagehide，
    // handlePageHide() 會呼叫 camera.stop() 把 stream 整個關掉。
    window.dispatchEvent(makeEvent('pagehide'))
    expect(initialTrack.readyState).toBe('ended')

    // 按「繼續」：resume() 發現 track 已死，走 start() 重開，卡在 getUserMedia
    // ——這正是真機上那「幾百毫秒」的空窗。
    const resumePromise = session.togglePause()
    await flush()

    // 使用者在鏡頭還沒重新打開之前又按了一次「暫停」——這個年齡層「按了沒
    // 反應就再按一次」是預設行為。此時 pause 分支的 camera?.setEnabled(false)
    // 因為 stream 還沒建立、track() 回 null 而完全落空（N1 描述的那個坑）。
    await session.togglePause()
    expect(session.state.paused).toBe(true)

    // 遲來的 getUserMedia 現在才 resolve。
    const secondTrack = resolveNextGum()
    await flush()
    await resumePromise

    // 落地後：不能同時「活著且 enabled」——這正是複審實測到的違規狀態
    // （畫面說「已暫停」，鏡頭還在錄）。
    const liveAndEnabled = secondTrack.readyState === 'live' && secondTrack.enabled === true
    expect(liveAndEnabled).toBe(false)
    expect(session.state.paused).toBe(true) // 使用者最後按的是暫停，畫面上的字要跟真實狀態一致

    await session.teardown()
  })

  it('N2：被取代的舊 resume() 落地時不能把 state.cameraHealthy 寫回錯的值', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()

    const bootPromise = session.boot(videoEl)
    await flush() // task-17：reconcile() 的 microtask 要先落地
    resolveNextGum()
    await flush()
    await bootPromise
    session.rawState.paused = false // 見上一條測試裡的說明

    await session.togglePause() // 暫停
    window.dispatchEvent(makeEvent('pagehide')) // stream 死掉

    const callA = session.togglePause() // 第 1 次「繼續」：卡在 getUserMedia #1
    await flush()
    await session.togglePause() // 暫停（同步完成）
    const callB = session.togglePause() // 第 2 次「繼續」：track 仍是 none，卡在 getUserMedia #2
    await flush()

    // getUserMedia 是佇列裡的第 0 個(callA)、第 1 個(callB)，但兩個 resolve
    // 的先後順序完全不保證跟呼叫順序一樣——這裡刻意讓「後按的」callB 先落地，
    // 「先按的」callA 慢半拍才落地，這是最危險的順序：如果 session.js 沒有
    // 世代比對，A 的舊結果會是「最後寫進 state 的那一個」，把 B 剛寫上去的
    // 正確值蓋掉。
    const liveTrack = resolveGumAt(1) // callB 的 getUserMedia 先落地
    await flush()
    await callB
    expect(liveTrack.readyState).toBe('live')
    expect(session.state.cameraHealthy).toBe(true)

    // callA 現在才 resolve——它的 stream 會被 cameraCapture.js 自己的
    // generation counter 丟棄（因為 callB 的 start() 已經又推進了一次），
    // resume() 因此回傳 false。
    const staleTrack = resolveGumAt(0) // callA 的 getUserMedia 慢半拍落地
    await flush()
    await callA

    expect(staleTrack.readyState).toBe('ended') // 被 generation counter 丟棄的那個 stream
    expect(session.state.cameraHealthy).toBe(true) // 沒有被 callA 的舊 false 蓋掉

    await session.teardown()
  })

  // 第 7 輪唯一改到的既有測試，改的是**前置條件**、不是斷言：這條測試原本在
  // `screen='privacy'` 的狀態下按暫停/繼續（第 3 輪寫它的時候，判準裡還沒有
  // screen 這個維度），而它的核心斷言是「最後停在『繼續』→ 鏡頭必須 live 且
  // enabled」。第 7 輪把「落地後一律用當下判準收斂」變成無條件執行之後，
  // 判準在 `privacy` 畫面上的誠實答案是 OFF——於是這條測試就跟窮舉表裡
  // 「privacy → 鏡頭必須關」那一格直接互相矛盾。矛盾的是前置條件不是斷言：
  // 暫停/繼續這兩顆按鈕只長在戰鬥畫面上，真實世界不存在「在開始畫面按繼續」。
  // 所以把它搬到真的戰鬥畫面上跑，每一條斷言原封不動。
  it('連按三下（繼續→暫停→繼續）：世代比對不是只處理「剛好兩下」，最終要收斂到真正的「繼續」', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()

    await bootIntoBattle(session, videoEl)

    await session.togglePause() // 暫停
    window.dispatchEvent(makeEvent('pagehide')) // stream 死掉

    const p1 = session.togglePause() // 第 1 下：繼續（卡在 getUserMedia #1）
    await flush()
    const p2 = session.togglePause() // 第 2 下：暫停（同步完成）
    expect(session.state.paused).toBe(true)
    const p3 = session.togglePause() // 第 3 下：繼續（卡在 getUserMedia #2，因為 stream 還是 none）
    await flush()
    expect(session.state.paused).toBe(false)

    // p1 那次呼叫的 getUserMedia 先落地——會被 cameraCapture.js 自己的
    // generation counter（p3 的 start() 已經又推進了一次）判定過期、丟棄。
    const staleTrack = resolveNextGum()
    await flush()
    await p1

    // p3 那次真正生效的 getUserMedia 才落地。
    const finalTrack = resolveNextGum()
    await flush()
    await p2
    await p3

    expect(staleTrack.readyState).toBe('ended') // 被丟棄的那個 stream
    expect(finalTrack.readyState).toBe('live')
    expect(finalTrack.enabled).toBe(true) // 最後一次按的是「繼續」，這是唯一正確的最終狀態
    expect(session.state.paused).toBe(false)
    expect(session.state.cameraHealthy).toBe(true)

    await session.teardown()
  })

  it('WakeLock：resume 分支卡在 wakeLock.request() 期間使用者改按暫停，落地時 sentinel 必須被 release', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()

    const bootPromise = session.boot(videoEl)
    await flush() // task-17：reconcile() 的 microtask 要先落地
    resolveNextGum() // track 全程活著，這條測試不需要重開 stream
    await flush()
    await bootPromise
    session.rawState.paused = false

    await session.togglePause() // 暫停
    wakeLockMode = 'manual' // 切成手動控制，才能卡住這次 resume 的 wakeLock.request()
    const resumePromise = session.togglePause() // 繼續：track 還活著，走 resume() 的快路
    await flush() // 讓它跑到 await wakeLock.request() 卡住

    await session.togglePause() // 使用者在 WakeLock 落地之前又改按暫停

    const sentinel = resolveNextWakeLock() // 遲來的 wakeLock.request() 現在才 resolve
    await flush()
    await resumePromise

    expect(sentinel.released).toBe(true) // 不能讓螢幕停在「已取得喚醒鎖」——暫停中不該一直亮著耗電
    expect(session.state.paused).toBe(true)

    wakeLockMode = 'auto' // 還原給後面（如果有）的測試用
    await session.teardown()
  })
})

// ---------------------------------------------------------------------------
// 審查第 4 輪。上面那組測試全部跑在 screen='privacy' 的狀態下（它們只關心
// camera/pauseGen 的交互作用，沒有真的開一場戰鬥），而這一輪的問題只有在
// 「真的在戰鬥畫面上，然後離開戰鬥畫面」時才看得到——所以下面每一條都先
// startBattle()，讓 state.screen 真的走過 battle → stats 這個轉換。
// ---------------------------------------------------------------------------

const PROFILE = { baselineNeckRatio: 1, baselineShoulderWidth: 0.3, calibratedAt: 0 }

/** boot 一個鏡頭已經在跑、且真的開了一場戰鬥的 session。回傳第一條 track。 */
async function bootIntoBattle(session, videoEl) {
  wakeLockMode = 'auto'
  const bootPromise = session.boot(videoEl)
  // task-17：見上面第一條測試的說明，reconcile() 的 microtask 要先落地。
  await flush()
  const track = resolveNextGum()
  await flush()
  expect((await bootPromise).ok).toBe(true)
  // 見上面第一條測試的說明：這個檔案的測試共用同一個 session 單例依序執行，
  // 顯式歸零才能保證從已知的起點開始。
  session.rawState.paused = false
  session.setCalibration(PROFILE)
  session.setTask({ taskType: 'homework', durationMin: 15, demoMode: false })
  await session.startBattle()
  expect(session.state.screen).toBe('battle')
  return track
}

describe('session store × 真的 cameraCapture.js：離開戰鬥畫面之後，遲到的 togglePause() 不能把鏡頭打回去（第 4 輪）', () => {
  it('繼續（卡在 videoEl.play()）→ 改按「結束」：舊呼叫落地時不能把 endBattle() 剛關掉的鏡頭重新打開', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    const track = await bootIntoBattle(session, videoEl)

    await session.togglePause() // 暫停
    expect(track.enabled).toBe(false)

    // 按「繼續」：track 還活著，resume() 走快路——setEnabled(true) 之後卡在
    // videoEl.play()。真機上這是數十～數百毫秒的空窗（背景回來時 getUserMedia
    // 那條慢路更久），兩顆按鈕又相鄰，小孩按了沒反應就改按「結束」。
    let landPlay = null
    videoEl.play = () => new Promise((resolve) => { landPlay = resolve })
    const resumePromise = session.togglePause()
    await flush()
    expect(track.enabled).toBe(true) // resume() 確實已經把鏡頭打開了
    expect(landPlay).not.toBeNull()

    await session.endBattle('aborted') // 使用者改按「結束」
    expect(session.state.screen).toBe('stats')
    expect(track.enabled).toBe(false) // endBattle() 關掉了鏡頭

    landPlay() // 遲到的 play() 現在才落地，舊的 togglePause() 醒過來
    await flush()
    await resumePromise

    // 終局：已經回到「結束」後的畫面，鏡頭就不准是 live 且 enabled。
    // 暫停／結束用的是 setEnabled(false) 而不是 stop()（跨三輪一致的設計，
    // 避免每次繼續都重新要權限），所以 track 本來就會停在 'live'——真正的
    // 紅線是 enabled 這一項，以及它不會自我修復（要到下一場 startBattle()
    // 或關掉 PWA 才會變回來）。
    expect(track.readyState).toBe('live')
    expect(track.enabled).toBe(false)
    expect(session.state.screen).toBe('stats')
    expect(session.state.paused).toBe(false) // endBattle() 刻意不改 paused——這正是不能拿它當判準的原因

    videoEl.play = vi.fn(async () => {})
    await session.teardown()
  })

  it('連按三下、兩次 getUserMedia「相鄰落地」：收斂不能寫死 false，否則最後停在「繼續」的使用者會被留在關閉的鏡頭前', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    await bootIntoBattle(session, videoEl)

    await session.togglePause() // 暫停
    window.dispatchEvent(makeEvent('pagehide')) // 切到別的 App：stream 被 stop()

    const p1 = session.togglePause() // 第 1 下：繼續（stream 已死 → start() → gUM #0）
    await flush()
    const p2 = session.togglePause() // 第 2 下：暫停（同步完成）
    const p3 = session.togglePause() // 第 3 下：繼續（stream 仍是 none → start() → gUM #1）
    await flush()
    expect(session.state.paused).toBe(false)

    // 跟上面「連按三下」那條測試的關鍵差別：那條讓過期的 gUM **先**落地，
    // 當下 stream 還是 null、setEnabled 落空，收斂行寫什麼都不影響結果（複審
    // 的突變測試因此照樣綠）。這裡刻意反過來——先讓真正生效的 p3 把 stream
    // 裝上去，過期的 p1 緊接著才落地，此時收斂行手上才真的有一條 live track
    // 可以動，它的判準才第一次能決定終局。
    const finalTrack = resolveGumAt(1) // p3 的 gUM 先落地：stream 裝上、track live+enabled
    await flush()
    await p3
    expect(finalTrack.readyState).toBe('live')

    const staleTrack = resolveGumAt(0) // p1 的 gUM 緊接著落地
    await flush()
    await p1
    await p2

    expect(staleTrack.readyState).toBe('ended') // 被 cameraCapture.js 的 generation counter 丟棄
    // 使用者最後按的是「繼續」、畫面還在戰鬥中，唯一正確的終局就是鏡頭開著。
    // 若收斂行被簡化成寫死 false：畫面顯示執行中、推論卻吃到黑畫面 → 新鮮度
    // 看門狗判定不健康 → 整場凍結，要再按一次暫停/繼續才救得回來。
    expect(finalTrack.readyState).toBe('live')
    expect(finalTrack.enabled).toBe(true)
    expect(videoEl.srcObject).not.toBeNull() // stream 真的接回 <video>，不是只有 track 活著
    expect(session.state.paused).toBe(false)
    expect(session.state.screen).toBe('battle')

    await session.teardown()
  })

  it('endBattle() 必須讓 pauseGen 前進：否則卡在 wakeLock.request() 的舊「繼續」落地後會把喚醒鎖拿回來，回到開始畫面螢幕永不變暗', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    await bootIntoBattle(session, videoEl)

    await session.togglePause() // 暫停（順便把 startBattle() 拿到的 sentinel 放掉）
    wakeLockMode = 'manual' // 切成手動，才能卡住這次「繼續」的 wakeLock.request()
    const resumePromise = session.togglePause() // 繼續：track 還活著，走快路，卡在 wakeLock.request()
    await flush()
    expect(wakeLockQueue.length).toBe(1)

    await session.endBattle('aborted') // 使用者在喚醒鎖落地之前按了「結束」
    expect(session.state.screen).toBe('stats')

    const sentinel = resolveNextWakeLock() // 遲到的 wakeLock.request() 現在才 resolve
    await flush()
    await resumePromise

    // 回到開始畫面之後不該還持有喚醒鎖——這個 sentinel 之後沒有任何人會再
    // 呼叫 release()（endBattle() 的 release() 早在它存在之前就跑完了），
    // 少了 endBattle() 的世代遞增就會永遠亮著。
    expect(sentinel.released).toBe(true)

    wakeLockMode = 'auto'
    await session.teardown()
  })

  it('teardown() 也必須讓 pauseGen 前進：App 卸載後舊「繼續」不能把剛放掉的喚醒鎖拿回來', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()
    await bootIntoBattle(session, videoEl)

    await session.togglePause() // 暫停
    wakeLockMode = 'manual'
    const resumePromise = session.togglePause() // 繼續：卡在 wakeLock.request()
    await flush()
    expect(wakeLockQueue.length).toBe(1)

    await session.teardown() // App 卸載（App.vue 的 onBeforeUnmount）

    const sentinel = resolveNextWakeLock()
    await flush()
    await resumePromise

    expect(sentinel.released).toBe(true) // 卸載之後沒有任何人會再 release()，這裡不放就是永遠不放
    expect(session.state.booted).toBe(false)

    wakeLockMode = 'auto'
  })
})

// ---------------------------------------------------------------------------
// fix round（測試鑑別力 FG-10／I-2）：`session.js` 有 13 個「await 落地後比對
// 世代」的守衛，總審實測其中 9 個逐一停用之後全套 0 紅。
//
// 這一輪我把 9 個全部重新量了一次（每次都跑全套），得到的結論比「9 個沒有
// 測試」更精確，也更值得寫下來：**有一半是「兩道守衛守同一件事」的縱深防禦，
// 單獨拆掉其中一道，另一道會頂上，所以本來就不可能有測試紅**。逐項實測：
//
// | 守衛 | 單獨停用 | 同層一起停用 | 判定 |
// |---|---|---|---|
// | `startBattle()` 的兩道 `myFrameGen !== frameGen` | 各 0 紅 | **紅 1**（cameraInvariant 的 X8） | 已覆蓋，只是分兩道 |
// | `startBattle()` 的 `myCamGen === camGen` ＋ 內層 release | 各 0 紅 | **紅 1**（X8-b） | 已覆蓋 |
// | `frame()` 的 `gen !== frameGen`（正常路徑＋catch） | 各 0 紅 | **0 紅** | ❌ 真缺口 |
// | `enterCalibration()` 落地 ＋ `syncCameraAsync()` 的 `myGen === camGen` | 各 0 紅 | **0 紅** | ❌ 真缺口 |
// | `onVisible()` 落地的 `myGen !== camGen` | 0 紅 | — | ❌ 真缺口 |
// | `onVisible()` 拿到 wakeLock 後的過期釋放 | 0 紅 | — | ❌ 真缺口 |
// | `setCalibration()` 的 `bumpCamGen()` | 0 紅 | — | 【分任務校準】已移除，見下方說明 |
//
// 所以下面補的是**實測證明真的沒有任何東西守著**的那幾條，按展場風險排序：
//
// 1. `frame()` 的過期影格 —— 每一場都會經過，而且症狀是「上一場的資料寫進
//    這一場」＋「兩條 rAF 迴圈同時跑」，正是 `camGen` 上方註解說的「第九個
//    分身」的形狀。
// 2. `enterCalibration()` 的落地 —— 「展場輪流玩」家族的路徑：小孩在任務畫面
//    按了「開始討伐」沒反應就再按一次，兩次 `getUserMedia` 亂序落地。
//    （【分任務校準】：這條路的入口從「換人玩」換成了 TaskSelector 的
//    「開始討伐」——換人玩現在先回任務畫面，校準是選完任務之後才進去的。
//    按兩下的情境本身一字未變，而且更可能發生：那顆按鈕是小孩自己按的，
//    不是工作人員。）
// 3. `onVisible()` 拿到 WakeLock 之後的過期釋放 —— 症狀是「回到開始畫面之後
//    螢幕永不變暗」，一台 iPad 要撐一整天。
//
// **【分任務校準】更新**：`setCalibration()` 的 `bumpCamGen()` 已經連同它的
// `setScreen('task')` 一起移除——那個方法現在純粹是 `state.profile` 的 setter，
// 不改畫面也就不改變「鏡頭該做什麼」，不再是 `bumpCamGen()` 規則涵蓋的「入口」。
// （上一版這裡記的是「刻意不補測試，因為它今天沒有可觀測的效果」；那個判斷
// 仍然正確，只是現在連那行程式碼都不存在了。）
// ---------------------------------------------------------------------------

describe('session store：await 空窗的世代守衛（實測證明零覆蓋的那幾條）', () => {
  it('frame()：上一場還在飛的影格落地時，不得寫進 state、也不得排下一幀（兩條 rAF 迴圈同時跑就是第九個分身）', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()

    // 自己接管 rAF，才能精確控制「哪一幀、什麼時候跑」。用 stubGlobal 而不是
    // 改檔案層的設定，是為了不動到這個檔案既有測試的節奏（它們跑在 jsdom
    // 真正的 rAF 上）；測試結束一定 unstub。
    const scheduled = []
    vi.stubGlobal('requestAnimationFrame', (cb) => { scheduled.push(cb); return scheduled.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    try {
      await bootIntoBattle(session, videoEl)
      expect(scheduled.length, 'startBattle() 應該已經排了第一幀').toBeGreaterThan(0)

      // 讓這一幀卡在 await inference.step()——真機上這是幾十毫秒的空窗。
      let landStep = null
      stepControl.impl = () => new Promise((resolve) => { landStep = resolve })
      const stalePromise = scheduled[scheduled.length - 1](performance.now())
      await flush()
      expect(landStep, '這一幀應該卡在 inference.step()').not.toBeNull()

      // 小孩在空窗裡按了「結束」。
      await session.endBattle('aborted')
      expect(session.state.screen).toBe('stats')
      const scheduledAfterEnd = scheduled.length
      const phoneBefore = session.state.phoneVisible

      // 遲到的那一幀現在才落地，而且帶著「看到手機」這個讀數——這是上一場的
      // 觀測，不該影響結算之後（或下一位訪客）的任何狀態。
      landStep({ key: 'object', metrics: { phoneVisible: true }, latencyMs: 1 })
      await stalePromise
      await flush()

      expect({
        phoneVisible: session.state.phoneVisible,
        newFramesScheduled: scheduled.length - scheduledAfterEnd,
        screen: session.state.screen,
      }).toEqual({
        // 上一場的讀數不得寫進 state（C2 家族：陳舊的布林值繼續參與計分）
        phoneVisible: phoneBefore,
        // 過期的影格不得排下一幀——排了就是一條沒有人能停下來的孤兒迴圈，
        // 而且下一場開始時會跟新的迴圈同時跑，每幀 tick 兩次。
        newFramesScheduled: 0,
        screen: 'stats',
      })
    } finally {
      stepControl.impl = async () => null
      vi.unstubAllGlobals()
      await session.teardown()
    }
  })

  it('enterCalibration()：在任務畫面按「開始討伐」沒反應又按一次，兩次 getUserMedia 亂序落地——舊的那次不得把 cameraHealthy 寫回錯的值', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()

    await bootIntoBattle(session, videoEl)
    await session.endBattle('aborted') // 上一位訪客打完了，停在結算畫面
    window.dispatchEvent(makeEvent('pagehide')) // 把 iPad 交出去的路上螢幕鎖過：stream 整條被 stop()
    await flush()
    expect(session.state.screen).toBe('stats')

    // 換人玩 → 回到任務畫面（【分任務校準】），新訪客選好任務、按「開始討伐」。
    session.startNewVisitor()
    expect(session.state.screen).toBe('task')
    session.setTask({ taskType: 'reading', durationMin: 15, demoMode: false })

    // 第 1 次「開始討伐」：stream 已死 → 走 getUserMedia 的慢路，卡住。
    const callA = session.enterCalibration()
    await flush()
    // 展場實況：按了沒反應就再按一次。
    const callB = session.enterCalibration()
    await flush()
    expect(gumQueue.length, '應該有兩次 getUserMedia 排隊中').toBe(2)

    // 刻意讓「後按的」callB 先落地——這是最危險的順序：沒有世代比對的話，
    // callA 的舊結果會是最後寫進 state 的那一個。
    const liveTrack = resolveGumAt(1)
    await flush()
    await callB
    expect(session.state.screen).toBe('calibrate')
    expect(liveTrack.readyState).toBe('live')
    expect(liveTrack.enabled).toBe(true)
    expect(session.state.cameraHealthy).toBe(true)

    // callA 現在才落地：它的 stream 會被 cameraCapture.js 自己的 generation
    // counter 丟棄，resume() 因此回傳 false——那是一個**過期的觀測**，不是
    // 「鏡頭真的壞了」。寫進去的後果是新訪客的校準畫面整個凍結（計分靠
    // cameraHealthy），而且畫面上一個字都不會出現。
    const staleTrack = resolveGumAt(0)
    await flush()
    await callA

    expect(staleTrack.readyState).toBe('ended')
    expect({
      cameraHealthy: session.state.cameraHealthy,
      screen: session.state.screen,
      live: liveTrack.readyState === 'live' && liveTrack.enabled === true,
    }).toEqual({ cameraHealthy: true, screen: 'calibrate', live: true })

    await session.teardown()
  })

  it('onVisible()：回前景拿 WakeLock 的空窗裡按「結束」，落地時 sentinel 必須被 release（否則回到開始畫面螢幕永不變暗）', async () => {
    const session = useSession()
    const videoEl = makeVideoEl()

    await bootIntoBattle(session, videoEl)

    setVisibility('hidden') // 小孩按了 home 鍵
    await flush()

    wakeLockMode = 'manual' // 卡住這次回前景的 wakeLock.request()
    setVisibility('visible')
    await flush()
    expect(wakeLockQueue.length, 'onVisible() 應該正卡在 wakeLock.request()').toBe(1)

    await session.endBattle('aborted') // 空窗裡按了「結束」
    expect(session.state.screen).toBe('stats')

    const sentinel = resolveNextWakeLock() // 遲到的 wakeLock.request() 現在才 resolve
    await flush()

    // 這個 sentinel 之後沒有任何人會再呼叫 release()——endBattle() 的
    // release() 早在它存在之前就跑完了。不在這裡放掉就是永遠不放，
    // 展場上那台 iPad 會在「開始」畫面亮一整天。
    expect(sentinel.released).toBe(true)

    wakeLockMode = 'auto'
    setVisibility('visible')
    await session.teardown()
  })
})
