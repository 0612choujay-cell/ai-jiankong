// @vitest-environment jsdom
//
// 複審第 1 輪 F2：Task 18 原本的測試只證明了 session.backToTaskSelect() 內部
// 會走 setScreen()——但真正會違規的地方是 App.vue 的 onHome()，而那個呼叫點
// 完全沒有測試盯著。複審實測把 onHome() 改回直寫
// `session.rawState.screen = 'task'`，session.test.js 跟 session.storage.test.js
// 全部 475 條照樣全線（因為那些測試測的是 store 自己的方法，不是 App.vue
// 有沒有呼叫對的方法）。這正是這個專案反覆踩的坑：斷言在下游會收斂的終態
// 上，紅的永遠是別人的護欄。
//
// 這個檔案直接鎖住 App.vue 的呼叫點本身：session 是完全 mock 的，
// onHome()／onAgain() 有沒有呼叫到正確的 session 方法，用 spy 直接看得到，
// 不必依賴任何下游的收斂行為。
import { describe, it, expect, vi } from 'vitest'
import { createApp, reactive, nextTick } from 'vue'

const fakeState = reactive({
  screen: 'stats',
  booted: true,
  bootError: null,
  battle: null,
  lastRecord: { id: 's-1', result: 'victory' },
  history: [],
  storageError: null,
  historyError: null,
  posture: 'upright',
  drowsy: false,
  paused: false,
  inferenceHealthy: true,
  inferenceStuck: false,
  cameraHealthy: true,
})

const fakeSession = {
  state: fakeState,
  rawState: fakeState,
  camera: () => ({}),
  inference: () => ({ setScale: () => {}, setEnabled: () => {}, setCalibrationBoost: () => {}, step: async () => null, actualFps: () => 0 }),
  enterCalibration: () => { fakeState.screen = 'calibrate' },
  setCalibration: () => {},
  primeVoiceFromGesture: () => {},
  setTask: () => {},
  // 這兩個是這個檔案真正要鎖住的呼叫點。
  startBattle: vi.fn(async () => { fakeState.screen = 'battle' }),
  backToTaskSelect: vi.fn(() => { fakeState.screen = 'task' }),
  togglePause: () => {},
  endBattle: async () => {},
  teardown: () => {},
  copy: () => ({ take: () => null, peek: () => null, resetSession: () => {} }),
  onBattleEvent: () => () => {},
  undoTrap: () => false,
  boot: vi.fn(async () => { fakeState.booted = true; return { ok: true } }),
}

vi.mock('./stores/session.js', () => ({ useSession: () => fakeSession }))

// StatsDashboard 真正的實作會 new Chart(canvasEl)，jsdom 沒有 canvas 會炸——
// 這個檔案只關心 App.vue 有沒有把 @again/@home 接到正確的 session 方法，
// 跟 StatsDashboard 內部怎麼畫圖表無關，所以整個換成一個一按就 emit 的假元件
// （跟 App.taskSelector.test.js 對 CalibrationWizard 的做法一致）。
vi.mock('./components/StatsDashboard.vue', () => ({
  default: {
    props: ['record', 'history', 'dpsSeries', 'storageError', 'historyError'],
    emits: ['again', 'home'],
    template: `<div>
      <button class="fake-again" @click="$emit('again')">FAKE_AGAIN</button>
      <button class="fake-home" @click="$emit('home')">FAKE_HOME</button>
    </div>`,
  },
}))

const { default: App } = await import('./App.vue')

function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(App)
  app.mount(el)
  return { el, app }
}

describe('App.vue：結算頁（screen === stats）的 onHome／onAgain 呼叫點', () => {
  it('按「回主畫面」呼叫 session.backToTaskSelect()（不是直寫 session.rawState.screen）', async () => {
    fakeState.screen = 'stats'
    fakeSession.backToTaskSelect.mockClear()
    const { el, app } = mount()
    await nextTick()

    const homeBtn = el.querySelector('.fake-home')
    expect(homeBtn).not.toBeNull()
    homeBtn.click()
    await nextTick()

    expect(fakeSession.backToTaskSelect).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
  })

  it('按「再討伐一次」呼叫 session.startBattle()，不重跑校準／任務選擇', async () => {
    fakeState.screen = 'stats'
    fakeSession.startBattle.mockClear()
    const { el, app } = mount()
    await nextTick()

    const againBtn = el.querySelector('.fake-again')
    expect(againBtn).not.toBeNull()
    againBtn.click()
    await nextTick()

    expect(fakeSession.startBattle).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
  })
})
