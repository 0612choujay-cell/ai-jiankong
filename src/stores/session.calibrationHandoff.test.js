// @vitest-environment jsdom
//
// Blocking B1 的端到端護欄：**校準畫面卸載的那一刻，誰是最後一個寫推論設定的人。**
//
// ## 出過什麼事
//
// 流程從「校準 → 選任務 → 開打」反轉成「選任務 → 校準 → 開打」之後，
// `App.vue` 的 `onCalibrated()` 變成 `setCalibration(profile)` 緊接
// `await startBattle()`，中間沒有 await。`startBattle()` 第一件事是
// `setScreen('battle')`——那只是改一個 reactive 值，Vue 的卸載排在微任務佇列裡；
// 接著它**同步**跑完 `setInferenceTracksEnabled(true)` 與 `syncInferenceScale()`，
// 然後在 `await syncCameraAsync()` 讓出執行權——**Vue 就在那一刻 flush，
// CalibrationWizard 卸載，`restore()` 執行。**
//
// 於是「收斂」變成倒數第二步、「元件還原」變成最後一步，而元件還原寫的是
// 無條件的絕對值。實際後果（複審用探針實測，不是推論）：工作人員在設定面板
// 關掉手機偵測之後走完「選任務 → 校準 → 開打」，得到
// `objectDetectorOn: false` 但實際 track 是開著的——**旗標說沒在跑、實際在跑**。
// 同一個機制也讓效能降檔關掉的 object track 在每一場戰鬥被重新打開。
//
// ## 為什麼這個檔案要用真的東西
//
// 這條線上有三個參與者，而缺任何一個都測不到這個 bug：
//
//   1. **真的 session store**——`setInferenceTracksEnabled()` 的
//      `enabled && state.objectDetectorOn` 那一道條件是被繞過的那一道。
//   2. **真的 CalibrationWizard**——bug 的觸發點是 Vue 的卸載時機，替身沒有
//      onBeforeUnmount，也就沒有那一刻。
//   3. **真的 inferenceService**——修法是把「校準提頻」變成它內部的一個疊加層，
//      合成邏輯在那裡。用假的 inference 等於把要驗的東西自己寫一遍。
//
// 所以這個檔案只 mock 兩個**邊界**：`@mediapipe/tasks-vision`（GPU／wasm）與
// `inferenceScheduler.js`（拿它當觀測點，看 track 最終到底被設成什麼）。
// 斷言的終點是「scheduler 最後一次收到的 object 開關值」——那是這台 iPad 上
// 手機偵測到底有沒有在跑的**實際事實**，不是任何旗標。
//
// ## 它鎖不到什麼（誠實記錄）
//
// jsdom 沒有真的 video decode，`videoEl.readyState` 恆為 0，所以
// `inference.step()` 一定早退——這個檔案驗的是設定的收斂，不是推論結果。
// `onCalibrated` 的那兩行是照抄 App.vue 的（見下方 finishCalibration），
// 「App.vue 有沒有真的這樣接線」的護欄在 App.taskSelector.test.js。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import CalibrationWizard from '../components/CalibrationWizard.vue'

// --- 邊界一：MediaPipe（GPU / wasm） ---------------------------------------
const taskStub = () => ({ detectForVideo: vi.fn(() => ({})), close: vi.fn() })
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn().mockResolvedValue({}) },
  PoseLandmarker: { createFromOptions: vi.fn(async () => taskStub()) },
  FaceLandmarker: { createFromOptions: vi.fn(async () => taskStub()) },
  ObjectDetector: { createFromOptions: vi.fn(async () => taskStub()) },
}))
vi.stubGlobal('OffscreenCanvas', class {})

// --- 邊界二：scheduler（同時是這個檔案的觀測點） ---------------------------
const schedulerCalls = { enabled: [], scale: [] }
vi.mock('../core/inferenceScheduler.js', () => ({
  createScheduler: () => ({
    pick: () => null,
    complete: () => {},
    skip: () => {},
    actualFps: () => 0,
    setScale: (s) => { schedulerCalls.scale.push(s) },
    setEnabled: (key, enabled) => { schedulerCalls.enabled.push([key, enabled]) },
  }),
}))

// --- 邊界三：getUserMedia（跟 session.secondSession.test.js 同一套作法） ----
function makeFakeTrack() {
  return { kind: 'video', enabled: true, readyState: 'live', onended: null, stop() { this.readyState = 'ended' } }
}
Object.defineProperty(navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn(async () => {
      const track = makeFakeTrack()
      return { getTracks: () => [track], getVideoTracks: () => [track] }
    }),
  },
  configurable: true,
})

// 手動驅動的 rAF：不讓 startBattle() 排出來的迴圈自己跑。
vi.stubGlobal('requestAnimationFrame', () => 1)
vi.stubGlobal('cancelAnimationFrame', () => {})

/**
 * 把 App.vue 的 `'calibrate'` 分支抄成一個最小的宿主元件。
 *
 * 關鍵是那個 `v-if`（這裡寫成條件 render）：卸載必須由 `state.screen` 的改變
 * 觸發，才會落在 Vue 自己的 flush 時機上。手動 `app.unmount()` 是**不同的**
 * 時機，測不到這個 bug。
 */
function mountHost(session) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      const s = session.state
      return () => (s.screen === 'calibrate'
        ? h(CalibrationWizard, {
          camera: session.camera(),
          inference: session.inference(),
          videoEl: document.createElement('video'),
          taskType: s.taskType,
        })
        : h('div', { class: 'not-calibrate' }))
    },
  })
  app.mount(el)
  return { el, app }
}

/** scheduler 目前的終局：每個 track 最後一次被設成什麼。 */
function finalTrackState() {
  const out = {}
  for (const [key, enabled] of schedulerCalls.enabled) out[key] = enabled
  return out
}

describe('Blocking B1：校準 → 開打的交接（真 store ＋ 真元件 ＋ 真 inferenceService）', () => {
  let session
  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./session.js')
    session = mod.useSession()
    await session.boot(document.createElement('video'))
    schedulerCalls.enabled.length = 0
    schedulerCalls.scale.length = 0
  })

  /**
   * 照抄 App.vue 的 `onCalibrated()`：兩個呼叫、中間沒有 await。
   * 這個「沒有 await」正是把元件卸載推進 startBattle() 內部的原因，所以它
   * 必須被原樣複製，不能為了測試好寫而在中間插一個 nextTick。
   */
  async function finishCalibration() {
    session.setCalibration({ neckRatio: 1, shoulderWidth: 0.3, calibratedAt: Date.now() })
    await session.startBattle()
  }

  it('工作人員關掉手機偵測 → 選任務 → 校準 → 開打：object track 最後仍然是關的', async () => {
    // 這正是複審用探針實測出 `objectDetectorOn:false / 實際 true` 的那條路徑。
    session.setPhoneDetectEnabled(false)
    expect(session.state.objectDetectorOn).toBe(false)

    session.setTask({ taskType: 'homework', durationMin: 15, demoMode: false })
    await session.enterCalibration()
    const { el, app } = mountHost(session)
    await nextTick()
    expect(el.querySelector('.arena'), '校準畫面真的掛上去了（否則下面全是假綠）').not.toBeNull()

    // 校準期間：元件開疊加層（提頻＋關掉 face/object）
    el.querySelector('button').click()
    await nextTick()

    schedulerCalls.enabled.length = 0
    await finishCalibration()
    await nextTick() // 讓任何還沒 flush 的卸載落地

    expect(session.state.screen).toBe('battle')
    expect(el.querySelector('.arena'), '畫面換了，校準元件必須已經卸載（restore() 跑過了）').toBeNull()

    // 這一條是全部的價值所在：**實際事實**（scheduler 收到什麼），不是旗標。
    expect(
      finalTrackState().object,
      '工作人員關掉的手機偵測，不得被校準畫面的卸載無聲打開',
    ).toBe(false)
    // 旗標與事實一致——這個專案反覆長出分身的「兩套真相」就是這兩者對不上。
    expect(session.state.objectDetectorOn).toBe(false)

    app.unmount()
    el.remove()
  })

  it('效能降檔關掉 object track 之後開打：倍率與 track 都不得被校準的卸載打回去', async () => {
    // 降檔做兩件事：setScale(0.5) 與關掉 object。事故 #4 的形狀是「換人玩 →
    // 校準」把倍率打回 1；B1 讓它多了一個分身（track 也被打開）。
    session.rawState.perfMode = true
    session.setPhoneDetectEnabled(false)

    session.setTask({ taskType: 'reading', durationMin: 15, demoMode: false })
    await session.enterCalibration()
    const { el, app } = mountHost(session)
    await nextTick()
    el.querySelector('button').click()
    await nextTick()

    schedulerCalls.enabled.length = 0
    schedulerCalls.scale.length = 0
    await finishCalibration()
    await nextTick()

    expect(schedulerCalls.scale.at(-1), '降檔中的倍率不得被還原成全解析度').toBe(0.5)
    expect(finalTrackState().object, '降檔關掉的 track 不得被重新打開').toBe(false)
    // pose／face 是這一場真的要用的，必須是開的——否則這條測試會因為
    // 「全部都關掉」而假綠（那樣的話戰鬥根本不會計分）。
    expect(finalTrackState().pose).toBe(true)
    expect(finalTrackState().face).toBe(true)

    app.unmount()
    el.remove()
  })

  it('手機偵測開著時，走完同一條路 object track 是開的（反方向：修法不得把功能關死）', async () => {
    session.setPhoneDetectEnabled(true)
    session.setTask({ taskType: 'vocab', durationMin: 15, demoMode: false })
    await session.enterCalibration()
    const { el, app } = mountHost(session)
    await nextTick()
    el.querySelector('button').click()
    await nextTick()

    schedulerCalls.enabled.length = 0
    await finishCalibration()
    await nextTick()

    expect(finalTrackState().object).toBe(true)
    expect(session.state.objectDetectorOn).toBe(true)

    app.unmount()
    el.remove()
  })
})
