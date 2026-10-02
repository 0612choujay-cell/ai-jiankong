// @vitest-environment jsdom
//
// fix round（測試鑑別力 FG-2／I-8／必查 4-E）：`cameraCapture.js` 是全專案
// **唯一**碰 `getUserMedia` 的檔案，而它原本**完全沒有測試檔**。後果有兩個，
// 總審都實測過：
//
//   1. `audio: false` 這條隱私紅線在**行為層**沒有任何護欄。
//      `redlineGuardrail.test.js` 已經補上了原始碼層的掃描（CONSTRAINTS 這個
//      字面量裡寫著 audio:false、整個檔案沒有 audio:true），但那條掃描抓不到
//      「constraints 在執行期才被組出來」的寫法——例如
//      `getUserMedia({ ...CONSTRAINTS, audio: wantMic })`，或多出一個
//      第二組 constraints。這個檔案鎖的是**真正遞給瀏覽器的那個物件**。
//   2. `cameraCapture.js` 的兩個 catch（`getUserMedia` 丟例外、`videoEl.play()`
//      被打斷）是**從未被執行過的程式碼**——總審在每個 catch 第一行插
//      `throw` 再跑全套，666 條全綠。而「使用者拒絕鏡頭權限」正是展場第一天
//      最可能發生的事之一。
//
// ## 這個檔案鎖得到什麼 / 鎖不到什麼（誠實記錄）
//
// 鎖得到：遞給 `getUserMedia` 的 constraints 物件逐欄的值；權限被拒／被系統
// 收走／`play()` 被打斷三條錯誤路徑的回傳值與清理行為；`start`／`stop`／
// `resume` 的狀態機（要不要重新要權限）；世代比對（遲到的 stream 必須被
// 丟棄而不是接到 `<video>` 上）。
//
// 鎖不到：真實的權限對話框行為、iOS Safari 把 PWA 丟進背景時真正會發什麼
// 事件、`videoEl.play()` 在真機上的時序、以及「鏡頭燈有沒有亮」。jsdom 沒有
// 任何一個真的 media 實作，這些只能靠實機驗收。這個檔案刻意**不** mock
// `cameraCapture.js` 自己的任何一部分，只在 `navigator.mediaDevices` 這個
// 瀏覽器 API 邊界上放替身——跟 `session.cameraRace.test.js` 同一條界線。
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { createCameraCapture } from './cameraCapture.js'

/**
 * 這個專案真正要的那一組 constraints，在測試裡逐欄寫死一份。
 *
 * 刻意用「完整相等」而不是只斷言 `audio === false`（總審的 B-2 建議）：
 * 只查 audio 的話，`audio: false` 旁邊多長出一個
 * `video: { ..., echoCancellation: ... }`、或有人把 `audio` 換成
 * `{ deviceId: ... }` 之外的其他麥克風相關鍵，都照樣綠。
 *
 * video 那三個數字（640×480、15fps）不是紅線，是效能取捨；把它們一起寫死的
 * 用意不是禁止調整，而是讓**調整成為一個有意識的動作**——改了就要回來改這一
 * 行，改的時候自然會再看一眼上面那個 `audio: false`。
 */
const EXPECTED_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { max: 15 },
  },
}

function makeTrack(kind = 'video') {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    onended: null,
    stop() { this.readyState = 'ended' },
  }
}

function makeStream(tracks) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }
}

function makeVideoEl() {
  const el = document.createElement('video')
  // jsdom 的 HTMLMediaElement.play() 預設丟「Not implemented」。
  el.play = vi.fn(async () => {})
  return el
}

let gum
let originalMediaDevices

beforeEach(() => {
  // 每條測試都拿一個全新的替身：這個檔案不共用任何模組級狀態，
  // 任何一條紅燈都不必先排除「是不是前面那條害的」。
  gum = vi.fn(async () => makeStream([makeTrack()]))
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: (...args) => gum(...args) },
    configurable: true,
  })
})

afterEach(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else delete navigator.mediaDevices
})

describe('cameraCapture：隱私紅線——遞給 getUserMedia 的 constraints（行為層，不是原始碼層）', () => {
  it('start() 真正遞出去的 constraints 逐欄等於預期，audio 是嚴格布林 false', async () => {
    const cam = createCameraCapture({ videoEl: makeVideoEl() })
    expect((await cam.start()).ok).toBe(true)

    expect(gum, 'start() 應該只要一次權限').toHaveBeenCalledTimes(1)
    const [constraints] = gum.mock.calls[0]
    expect(constraints).toEqual(EXPECTED_CONSTRAINTS)
    // `toEqual` 對 false 與 undefined 的差別已經足夠嚴格，但再明講一次：
    // 紅線是「麥克風連要都不要」，所以 audio 必須是布林 false，
    // 不是 undefined、不是省略、更不是任何 truthy 的物件。
    expect(constraints.audio).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(constraints, 'audio')).toBe(true)

    cam.stop()
  })

  it('整個生命週期裡的每一次 getUserMedia 都用同一組 constraints（重開的慢路不得夾帶 audio）', async () => {
    const videoEl = makeVideoEl()
    const cam = createCameraCapture({ videoEl })
    await cam.start()
    cam.stop() // 模擬 pagehide：stream 整條被關掉
    expect(cam.readyState()).toBe('none')

    expect(await cam.resume(), 'track 已死，resume() 應該走 start() 重開').toBe(true)

    expect(gum.mock.calls.length, '這條測試必須真的發生過兩次 getUserMedia').toBe(2)
    for (const [i, call] of gum.mock.calls.entries()) {
      expect(call[0], `第 ${i + 1} 次 getUserMedia 的 constraints 不一致`).toEqual(EXPECTED_CONSTRAINTS)
    }

    cam.stop()
  })
})

describe('cameraCapture：使用者拒絕鏡頭權限（展場第一天最可能發生的事）', () => {
  it('NotAllowedError：回傳 {ok:false, error}，不丟例外，videoEl 被清乾淨，也沒有留下半條 track', async () => {
    const videoEl = makeVideoEl()
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    gum.mockRejectedValueOnce(denied)

    const cam = createCameraCapture({ videoEl })
    const res = await cam.start()

    expect(res.ok).toBe(false)
    // 原始 error 物件原封不動往上傳是這一層的契約；把它收斂成只留 `name`
    // （隱私紅線：不得寫入或傳出 error.message／stack）是 session.js 的責任，
    // 由 session.test.js 的 loopError 那組測試守著。這裡鎖的是「有東西可以
    // 讓上層判斷是哪一種失敗」，而 name 正是上層唯一被允許用的那個欄位。
    expect(res.error).toBe(denied)
    expect(res.error.name).toBe('NotAllowedError')

    expect(videoEl.srcObject, '失敗路徑也要把 <video> 清乾淨').toBe(null)
    expect(cam.isRunning()).toBe(false)
    expect(cam.readyState()).toBe('none')
  })

  it('拒絕之後使用者到 iOS 設定裡打開權限，再按一次就要能成功（失敗不得留下卡死的內部狀態）', async () => {
    const videoEl = makeVideoEl()
    gum.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))

    const cam = createCameraCapture({ videoEl })
    expect((await cam.start()).ok).toBe(false)

    // 第二次成功。若第一次失敗時把世代或 stream 留在奇怪的狀態，這裡會拿不到
    // 活著的 track——那正是展場上「叫小孩去設定裡開權限、回來還是黑畫面」。
    const res = await cam.start()
    expect(res.ok).toBe(true)
    expect(cam.isRunning()).toBe(true)
    expect(videoEl.srcObject).not.toBeNull()

    cam.stop()
  })

  it('stream 已經拿到、但 videoEl.play() 在 start() 裡丟例外：track 要被關掉、videoEl 要清乾淨，不留一條沒人管的活 track', async () => {
    // 這條專門打 start() 的 catch 裡那行 `detach()`。上面兩條走的是
    // 「getUserMedia 直接 reject」，那時候根本還沒有 stream，catch 裡的
    // detach() 拿掉也看不出差別。這裡讓例外發生在 stream 已經接上 <video>
    // **之後**，清理沒做就是鏡頭燈一直亮著、而 App 以為自己沒有鏡頭。
    const videoEl = makeVideoEl()
    let track = null
    gum.mockImplementationOnce(async () => { track = makeTrack(); return makeStream([track]) })
    videoEl.play = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { name: 'NotSupportedError' })
    })

    const cam = createCameraCapture({ videoEl })
    const res = await cam.start()

    expect(res.ok).toBe(false)
    expect(track.readyState, '失敗就要把已經拿到的 track 關掉').toBe('ended')
    expect(videoEl.srcObject).toBe(null)
    expect(cam.isRunning()).toBe(false)
  })

  it('NotReadableError（鏡頭被別的 App 占用）走同一條路：ok:false 而不是丟例外', async () => {
    const busy = Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' })
    gum.mockRejectedValueOnce(busy)

    const cam = createCameraCapture({ videoEl: makeVideoEl() })
    let thrown = null
    const res = await cam.start().catch((e) => { thrown = e; return null })
    expect(thrown, 'start() 不得把例外往上丟——呼叫端全都只看回傳值').toBe(null)
    expect(res).toEqual({ ok: false, error: busy })
  })
})

describe('cameraCapture：track 生命週期', () => {
  it('track 中途死掉（系統收走鏡頭／裝置被拔掉）：onEnded 回呼一次，isRunning 立刻變 false', async () => {
    const videoEl = makeVideoEl()
    const onEnded = vi.fn()
    let track = null
    gum.mockImplementationOnce(async () => {
      track = makeTrack()
      return makeStream([track])
    })

    const cam = createCameraCapture({ videoEl, onEnded })
    await cam.start()
    expect(cam.isRunning()).toBe(true)
    expect(typeof track.onended, 'onended 必須被掛上去，否則沒有人會知道鏡頭死了').toBe('function')

    track.readyState = 'ended'
    track.onended()

    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(cam.isRunning()).toBe(false)
    expect(cam.readyState()).toBe('ended')
  })

  it('stop()：每一條 track 都被 stop()、onended 解掛、srcObject 清空', async () => {
    const videoEl = makeVideoEl()
    const onEnded = vi.fn()
    const video = makeTrack('video')
    // 刻意多給一條非 video 的 track：我們從來沒要過它，但如果哪天平台多塞了
    // 一條回來，stop() 必須用 getTracks()（全部）而不是只關掉第一條 video。
    const other = makeTrack('audio')
    gum.mockImplementationOnce(async () => makeStream([video, other]))

    const cam = createCameraCapture({ videoEl, onEnded })
    await cam.start()
    expect(videoEl.srcObject).not.toBeNull()

    cam.stop()

    expect(video.readyState).toBe('ended')
    expect(other.readyState, '沒要過的 track 也必須被關掉').toBe('ended')
    expect(video.onended, 'onended 要解掛，否則 stop() 自己會觸發一次「鏡頭死了」').toBe(null)
    expect(videoEl.srcObject).toBe(null)
    expect(cam.isRunning()).toBe(false)
    expect(onEnded, '主動 stop() 不是「鏡頭死了」，不該通知上層').not.toHaveBeenCalled()
  })

  it('setEnabled(false) 不會殺掉 track——那是「按繼續立刻回來、不必重新要權限」這條快路的前提', async () => {
    let track = null
    gum.mockImplementationOnce(async () => { track = makeTrack(); return makeStream([track]) })

    const cam = createCameraCapture({ videoEl: makeVideoEl() })
    await cam.start()

    cam.setEnabled(false)
    expect(track.enabled).toBe(false)
    expect(track.readyState, 'setEnabled 不得變成 stop').toBe('live')
    expect(cam.isRunning(), 'readyState 仍是 live').toBe(true)

    cam.stop()
  })
})

describe('cameraCapture：resume() 的兩條路', () => {
  it('快路：track 還活著時只重新 enable + play，不再要一次權限', async () => {
    const videoEl = makeVideoEl()
    let track = null
    gum.mockImplementationOnce(async () => { track = makeTrack(); return makeStream([track]) })

    const cam = createCameraCapture({ videoEl })
    await cam.start()
    cam.setEnabled(false)
    gum.mockClear()
    videoEl.play.mockClear()

    expect(await cam.resume()).toBe(true)
    expect(gum, '快路不得重新呼叫 getUserMedia——真機上那會再彈一次權限對話框').not.toHaveBeenCalled()
    expect(track.enabled).toBe(true)
    expect(videoEl.play).toHaveBeenCalledTimes(1)

    cam.stop()
  })

  it('快路：videoEl.play() 被打斷不算失敗（cameraCapture.js 的第二個 catch）', async () => {
    const videoEl = makeVideoEl()
    let track = null
    gum.mockImplementationOnce(async () => { track = makeTrack(); return makeStream([track]) })

    const cam = createCameraCapture({ videoEl })
    await cam.start()
    cam.setEnabled(false)

    // 真機上這是常態：前一個 play() 還沒完成就被新的 load/pause 打斷，
    // Safari 會丟 AbortError。鏡頭本身完全正常，不該因此回報失敗——
    // 回報失敗的後果是 session.js 把 state.cameraHealthy 寫成 false，
    // 畫面跳出「鏡頭好像停了」，而鏡頭其實好好的。
    videoEl.play = vi.fn(async () => {
      throw Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' })
    })

    expect(await cam.resume()).toBe(true)
    expect(track.enabled).toBe(true)
    expect(cam.isRunning()).toBe(true)

    cam.stop()
  })

  it('慢路：track 已死時重開，重開失敗（權限被關掉）要回傳 false，不是丟例外', async () => {
    const cam = createCameraCapture({ videoEl: makeVideoEl() })
    await cam.start()
    cam.stop()

    gum.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    let thrown = null
    const ok = await cam.resume().catch((e) => { thrown = e; return 'threw' })
    expect(thrown).toBe(null)
    expect(ok).toBe(false)
    expect(cam.isRunning()).toBe(false)
  })
})

describe('cameraCapture：世代比對（遲到的 stream 不得接到 <video> 上）', () => {
  it('start() 還卡在 getUserMedia 時被 stop() 打斷：遲到的 stream 必須被關掉，而不是接上去', async () => {
    const videoEl = makeVideoEl()
    let landGum = null
    gum.mockImplementationOnce(() => new Promise((resolve) => { landGum = resolve }))

    const cam = createCameraCapture({ videoEl })
    const startPromise = cam.start()
    await Promise.resolve()
    expect(landGum, 'getUserMedia 應該已經被呼叫、還沒落地').not.toBeNull()

    cam.stop() // 使用者在權限對話框還開著的時候就離開了這個畫面

    const lateTrack = makeTrack()
    landGum(makeStream([lateTrack]))
    const res = await startPromise

    expect(res.ok).toBe(false)
    expect(lateTrack.readyState, '被取代的 stream 必須自己關掉，否則鏡頭燈會一直亮著').toBe('ended')
    expect(videoEl.srcObject, '過期的 stream 不得接到 <video> 上').toBe(null)
    expect(cam.isRunning()).toBe(false)
  })

  it('兩次 start() 重疊、舊的那次慢半拍落地：最終活著的只能是新的那一條', async () => {
    const videoEl = makeVideoEl()
    const resolvers = []
    gum.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve) }))

    const cam = createCameraCapture({ videoEl })
    const first = cam.start()
    await Promise.resolve()
    const second = cam.start()
    await Promise.resolve()
    expect(resolvers.length).toBe(2)

    // 刻意讓「後呼叫的」先落地、「先呼叫的」慢半拍——這是最危險的順序：
    // 沒有世代比對的話，舊的那次會是最後寫進 stream 的那一個。
    const newTrack = makeTrack()
    resolvers[1](makeStream([newTrack]))
    await second

    const staleTrack = makeTrack()
    resolvers[0](makeStream([staleTrack]))
    await first

    expect(staleTrack.readyState).toBe('ended')
    expect(newTrack.readyState).toBe('live')
    expect(cam.isRunning()).toBe(true)
    expect(videoEl.srcObject).not.toBeNull()

    cam.stop()
  })
})
