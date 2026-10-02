// @vitest-environment jsdom
//
// 這個檔案獨立於 App.mount.test.js，鎖住 App.vue 裡「選任務 ↔ 校準 ↔ 開打」
// 那一段接線的**呼叫點**（Ruling DK：護欄要裝在違規會發生的那一行，不是裝在
// 最好測的那一層）。用獨立檔案而不是加進 App.mount.test.js，是因為那個檔案的
// fakeState 是模組層級的共用可變狀態，好幾個 it() 之間互相依賴目前的收尾方式；
// 另開一個檔案能有自己乾淨的 mock，不必擔心跟既有測試的執行順序互相污染。
//
// 【分任務校準】這一輪流程反轉了：
//
//     舊：隱私 → 權限 → 校準 → 選任務 → 戰鬥
//     新：隱私 → 權限 → **選任務** → **校準** → 戰鬥
//
// 理由是校準量的是耳朵相對於肩膀的高度（poseGeometry.js 的 neckRatio），而
// 抬頭看螢幕跟低頭寫作業這個數字差很多——校準必須先知道等一下要做什麼，
// 才給得出正確的姿勢指示。所以這個檔案原本鎖的三件事全部改成鎖新行為：
//
//   1. TaskSelector 的 start → setTask() 之後走 **enterCalibration()**
//      （不是 startBattle()），而且 setTask 一定在前——校準畫面要讀 taskType。
//   2. CalibrationWizard 的 done → setCalibration() 之後 **直接 startBattle()**
//      （不再回任務畫面）。
//   3. primeVoiceFromGesture() 仍然是 onTaskChosen() 的同步第一行。
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createApp, reactive, nextTick } from 'vue'
import { SRC_DIR } from './core/copyGuardrail.js'

const fakeState = reactive({
  screen: 'task',
  booted: true,
  bootError: null,
  battle: null,
  posture: 'upright',
  drowsy: false,
  paused: false,
  inferenceHealthy: true,
  inferenceStuck: false,
  cameraHealthy: true,
  perfMode: false,
  taskType: 'homework',
  durationMin: 15,
  demoMode: false,
})

const calls = { setCalibration: [], setTask: [], startBattle: 0 }
// Task 15：追蹤呼叫「順序」，不只是「有沒有被呼叫」——iOS 手勢暖機的要求是
// 「primeVoiceFromGesture() 必須先於 setTask()，而且兩者都在同一個同步呼叫
// 堆疊內」，這件事光看 calls.setTask 的內容測不出來，一定要有一份時間順序的記錄。
// 【分任務校準】：同一份記錄現在還要負責第二件事——「setTask() 必須先於
// enterCalibration()」（校準畫面要讀 state.taskType 決定顯示哪一組姿勢指示，
// 反了就是拿上一位訪客的任務去指示這一位，而畫面上看起來一切正常）。
const orderLog = []

const fakeSession = {
  state: fakeState,
  rawState: fakeState,
  camera: () => ({}),
  inference: () => ({
    setScale: () => {}, setEnabled: () => {}, setCalibrationBoost: () => {}, step: async () => null, actualFps: () => 0,
  }),
  enterPermission: () => { fakeState.screen = 'permission' },
  enterTaskSelect: vi.fn(() => { orderLog.push('enterTaskSelect'); fakeState.screen = 'task' }),
  enterCalibration: vi.fn(async () => { orderLog.push('enterCalibration'); fakeState.screen = 'calibrate' }),
  // 【分任務校準】：setCalibration() 只存 profile，**不再換畫面**。換畫面是
  // startBattle() 的事（完整理由見 session.js 的 setCalibration() 上方）。
  // 這個替身也照著只記錄、不動 screen——這樣「App.vue 有沒有真的接著呼叫
  // startBattle()」才觀測得到差異：少了那一行，畫面會停在 'calibrate'。
  setCalibration: vi.fn((profile) => {
    orderLog.push('setCalibration')
    calls.setCalibration.push(profile)
  }),
  primeVoiceFromGesture: vi.fn(() => { orderLog.push('prime') }),
  setTask: vi.fn((payload) => {
    orderLog.push('setTask')
    calls.setTask.push(payload)
    fakeState.taskType = payload.taskType
    fakeState.durationMin = payload.durationMin
    fakeState.demoMode = Boolean(payload.demoMode)
  }),
  startBattle: vi.fn(async () => {
    orderLog.push('startBattle')
    calls.startBattle += 1
    fakeState.screen = 'battle'
  }),
  togglePause: () => {},
  endBattle: async () => {},
  teardown: () => {},
  boot: vi.fn(async () => { fakeState.booted = true; return { ok: true } }),
  // Task 14：進了 battle 畫面之後 App.vue 會掛載真正的 BattleView，
  // 這個假 session 也要滿足它的依賴，否則測試最後一步（startBattle 後
  // screen 變成 'battle'）會在 BattleView 的 setup() 階段就炸掉。
  copy: () => ({ take: () => null, peek: () => null, resetSession: () => {} }),
  onBattleEvent: () => () => {},
  undoTrap: () => false,
}

vi.mock('./stores/session.js', () => ({ useSession: () => fakeSession }))

// CalibrationWizard 本身已經有自己的測試（CalibrationWizard.mount.test.js），
// 真的跑一次它的 5 秒取樣迴圈在這裡既慢又脆弱。這裡換成一個一按就 emit 'done'
// 的假元件，只用來驅動「App.vue 真正的 @done="onCalibrated" 這條線」——
// 跟直接呼叫 fakeSession.setCalibration() 的差別：那樣寫完全繞過了 App.vue 的
// onCalibrated()，實作改壞了測試也測不出來（實測過：確實測不出來）。
//
// 它同時把拿到的 task-type prop 顯示出來：App.vue 有沒有真的把任務類型傳下去，
// 是這一輪的核心接線，而這裡是唯一看得到那個 prop 的地方。
vi.mock('./components/CalibrationWizard.vue', () => ({
  default: {
    props: ['camera', 'inference', 'videoEl', 'taskType'],
    emits: ['done'],
    template: '<button class="fake-calibration-done" @click="$emit(\'done\', { calibratedAt: 1 })">'
      + 'FAKE_DONE:{{ taskType }}</button>',
  },
}))

import App from './App.vue'

function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(App)
  app.mount(el)
  return { el, app }
}

function resetCalls() {
  calls.setCalibration.length = 0
  calls.setTask.length = 0
  calls.startBattle = 0
  orderLog.length = 0
  fakeSession.enterCalibration.mockClear()
  fakeSession.enterTaskSelect.mockClear()
  fakeSession.setCalibration.mockClear()
  fakeSession.startBattle.mockClear()
  fakeSession.setTask.mockClear()
  fakeSession.primeVoiceFromGesture.mockClear()
}

/** 在任務畫面上選一個任務並按「準備開始」。 */
function chooseTaskAndGo(el, label) {
  const radio = [...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent.includes(label))
  expect(radio, `任務畫面上要有「${label}」`).not.toBeUndefined()
  radio.click()
  const goButton = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('準備開始'))
  goButton.click()
}

describe('App.vue【分任務校準】：選任務 → 校準 → 開打', () => {
  it('TaskSelector 的 start 事件：setTask() 之後走 enterCalibration()，而且**不得**直接開打', async () => {
    fakeState.screen = 'task'
    resetCalls()
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('[role="radiogroup"]'), '權限之後的第一個畫面是選任務').not.toBeNull()

    chooseTaskAndGo(el, '看書')
    await nextTick()

    expect(calls.setTask).toEqual([{ taskType: 'reading', durationMin: 15, demoMode: false }])
    expect(fakeSession.enterCalibration, '選完任務要先進校準').toHaveBeenCalledTimes(1)
    // 這一條就是流程反轉的全部：舊版在這裡直接 startBattle()，校準因此永遠
    // 發生在「還不知道要做什麼」的時候，只能給一句對三種任務都成立的話。
    expect(calls.startBattle, '選完任務不得直接開打——中間要先校準').toBe(0)
    expect(fakeState.screen).toBe('calibrate')

    app.unmount()
    el.remove()
  })

  it('校準畫面拿得到這一次的任務類型（姿勢指示要靠它分四種）', async () => {
    fakeState.screen = 'task'
    resetCalls()
    const { el, app } = mount()
    await nextTick()

    chooseTaskAndGo(el, '背單字')
    await nextTick()

    // App.vue 的 :task-type="s.taskType"。少了這條 prop，校準畫面會退回
    // 預設的 'custom'，四種任務又變回同一句通用指示——而且畫面上看起來
    // 完全正常（那正是這一輪要修的問題本身）。
    const wizard = el.querySelector('.fake-calibration-done')
    expect(wizard.textContent).toBe('FAKE_DONE:vocab')

    app.unmount()
    el.remove()
  })

  it('CalibrationWizard 的 done 事件：setCalibration() 之後**直接**開打，不再回任務畫面', async () => {
    fakeState.screen = 'calibrate'
    resetCalls()
    const { el, app } = mount()
    await nextTick()

    const doneButton = el.querySelector('.fake-calibration-done')
    expect(doneButton).not.toBeNull()
    doneButton.click() // 觸發真正的 App.vue @done="onCalibrated"
    await nextTick()
    await nextTick()

    expect(calls.setCalibration.length, '校準結果要存進 store').toBe(1)
    expect(calls.startBattle, '校準完成就開打').toBe(1)
    expect(fakeState.screen).toBe('battle')
    // 順序不能反：startBattle() 讀 state.profile 去建 poseAnalyzer，反過來
    // 這一場就跑在**上一位訪客**的基準上（而且沒有任何錯誤訊息）。
    expect(orderLog).toEqual(['setCalibration', 'startBattle'])
    // 中間不得再經過任務畫面——任務早就選好了，多一個畫面就是多一次「按下去
    // 才會開始」，這個年齡層每多一步都是流失。
    expect(fakeSession.enterTaskSelect).not.toHaveBeenCalled()

    app.unmount()
    el.remove()
  })

  it('primeVoiceFromGesture() 在 setTask() 之前、setTask() 在 enterCalibration() 之前，且全部在同一個同步呼叫堆疊內', () => {
    fakeState.screen = 'task'
    resetCalls()
    const { el, app } = mount()

    chooseTaskAndGo(el, '看書')
    // 刻意不 await 任何東西：這裡讀到的 orderLog 就是那一次同步呼叫堆疊跑完
    // 之後的結果。
    //
    // - `prime` 排第一個：iOS 只認「第一次 speak() 是不是在手勢的同步呼叫
    //   堆疊內」，一旦它前面被插進一個 await，這裡會看到空的 orderLog
    //   （onTaskChosen 還卡在第一個 await），而真機上的後果是**整場無聲**、
    //   不丟例外、不進 onerror。
    //   【分任務校準】重新確認：這顆按鈕、這個 handler、這一行的位置都沒變，
    //   變的只是它後面去哪裡；解鎖在 primeVoiceFromGesture() 當場就完成，
    //   跟「第一句真正的台詞多久之後才出現」無關（校準那 5 秒不影響）。
    // - `setTask` 排在 `enterCalibration` 之前：校準畫面要讀 state.taskType。
    expect(orderLog).toEqual(['prime', 'setTask', 'enterCalibration'])

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// 複審 I-9：「任務畫面唯一的出口就是校準」這條保證，要裝在違規會發生的地方
//
// `session.test.js` 原本有一條叫「任務畫面**唯一**的出口就是校準」的測試，
// 但它的內容是自己呼叫 `setTask()` ＋ `enterCalibration()` 再斷言
// `screen === 'calibrate'`——那是**重跑一次 happy path**，不是唯一性的證明。
// 未來有人在 App.vue 的 'task' 分支下加一顆「跳過校準」按鈕，它會保持綠色。
//
// 這是 Ruling DK 的變形：要防的違規會發生在 **App.vue 的模板**（新增出口），
// 護欄卻裝在 store。這一組把它搬回來——掃 App.vue 的原始碼結構。
//
// 為什麼這件事值得一條護欄：accident #3（換訪客不會重新校準）的症狀是
// 「整場一直說他駝背」或「整場都不反應」，而且沒有任何錯誤訊息。校準基準是
// 身高、坐姿、鏡頭距離的函式——用上一位訪客的基準玩，遊戲會整場判錯，
// 而畫面上看起來一切正常。
//
// 它鎖不到什麼（誠實記錄）：只掃字面值與結構，掃不到「用一個變數繞路呼叫
// startBattle」。這裡擋的是「下一個維護者大方地加一條捷徑」，不是會主動
// 規避掃描的對手——跟 redlineGuardrail.test.js 的自我聲明同一個標準。
// ---------------------------------------------------------------------------
describe("I-9：App.vue 的 'task' 分支不得長出第二個出口（結構護欄）", () => {
  const APP_SOURCE = readFileSync(path.join(SRC_DIR, 'App.vue'), 'utf8')

  /** 挖掉整行註解與 HTML 註解區段，避免說明文字造成誤判。 */
  function codeOnly(source) {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
  }

  it("TaskSelector 只有一個事件出口，而且它接到 onTaskChosen", () => {
    const code = codeOnly(APP_SOURCE)
    const tag = code.match(/<TaskSelector[\s\S]*?\/>/)
    expect(tag, 'App.vue 必須還有 TaskSelector——沒有的話這組護欄整個失效').not.toBeNull()

    // 這個元素上的每一個 @xxx 綁定都必須在這份白名單裡。新增一個出口
    // （例如 @skip="session.startBattle()"）會讓清單對不上，當場紅。
    const handlers = [...tag[0].matchAll(/@([a-zA-Z-]+)=/g)].map((m) => m[1])
    expect(handlers, "'task' 畫面的出口是被有意識核准過的，不是想加就加").toEqual(['start'])
    expect(tag[0]).toContain('onTaskChosen')
  })

  it('onTaskChosen() 通往 enterCalibration()，而且不得自己開打', () => {
    const code = codeOnly(APP_SOURCE)
    const body = code.match(/async function onTaskChosen\([\s\S]*?\n\}/)
    expect(body, 'onTaskChosen() 必須存在').not.toBeNull()

    expect(body[0], '選完任務的下一站一定是校準').toContain('session.enterCalibration(')
    expect(
      body[0],
      "從 'task' 直接開打就是 accident #3 的形狀：下一位小孩跑在上一位的校準基準上",
    ).not.toContain('startBattle')
  })

  it('TaskSelector 自己也不得直接碰 session（出口只能經過 App.vue 的 handler）', () => {
    // 反向的旁路：元件內部自己 import useSession 然後呼叫 startBattle()，
    // 上面兩條都掃不到——所以這一條掃元件本身。
    const source = readFileSync(path.join(SRC_DIR, 'components', 'TaskSelector.vue'), 'utf8')
    const code = codeOnly(source)
    expect(code, 'TaskSelector 是純 emit 元件，不讀 store').not.toContain('useSession')
    expect(code).not.toContain('startBattle')
  })
})
