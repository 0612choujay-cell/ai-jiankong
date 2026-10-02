// @vitest-environment jsdom
//
// App.vue 的**呼叫點**護欄（Task 20）。
//
// 這個專案今天抓到兩次同型問題：護欄裝在「最好測的那一層」而不是「會發生違規
// 的那一行」——把「禁止直寫 rawState.screen」測在 store，違規卻發生在 App.vue
// 的呼叫點，複審把呼叫點改回違規寫法，全部測試照樣全綠（見 App.stats.test.js
// 開頭那段）。這個檔案盯的就是 App.vue 自己：
//
//   1. 休息回合結束之後，**兩個入口要兩種出口**——leaveBreak() 說「已經回到
//      原本那一場」時，App.vue 不准再 startBattle()（那會把剛剛恢復的那一場
//      整個丟掉）；說「沒有進行中的戰鬥」時，App.vue 一定要開新的一場（不然
//      畫面永遠卡在休息回合）。
//   2. 結算頁的「休息一下再來」（≥20 分鐘）按下去要真的進休息回合，不是直接
//      開打——按鈕文字與行為讀同一個 needsBreakAfter()。
//   3. 安裝橫幅只掛在主畫面與結算畫面，戰鬥畫面與休息畫面都不掛。
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import { createApp, reactive, nextTick } from 'vue'

const fakeState = reactive({
  screen: 'stats',
  booted: true,
  bootError: null,
  battle: null,
  lastRecord: { id: 's-1', result: 'victory', durationMs: 15 * 60_000, demoMode: false },
  history: [],
  storageError: null,
  historyError: null,
  posture: 'upright',
  drowsy: false,
  paused: false,
  inferenceHealthy: true,
  inferenceStuck: false,
  cameraHealthy: true,
  perfMode: false,
  // 【分任務校準】：App.vue 的 `:task-type="s.taskType"`（校準畫面靠它決定
  // 顯示哪一組姿勢指示）。這個檔案把 CalibrationWizard 換成了替身，所以它
  // 不影響任何斷言——宣告在這裡是為了不讓 fixture 跟真實 state 脫節。
  taskType: 'homework',
})

const fakeSession = {
  state: fakeState,
  rawState: fakeState,
  camera: () => ({}),
  inference: () => ({ setScale: () => {}, setEnabled: () => {}, setCalibrationBoost: () => {}, step: async () => null, actualFps: () => 0 }),
  enterTaskSelect: vi.fn(() => { fakeState.screen = 'task' }),
  enterCalibration: vi.fn(async () => { fakeState.screen = 'calibrate' }),
  setCalibration: () => {},
  primeVoiceFromGesture: () => {},
  setTask: () => {},
  startBattle: vi.fn(async () => { fakeState.screen = 'battle' }),
  backToTaskSelect: vi.fn(() => { fakeState.screen = 'task' }),
  enterBreak: vi.fn(async () => { fakeState.screen = 'break' }),
  // 預設回傳 true（＝戰鬥中進來的那條路）；每條測試自己覆寫。
  leaveBreak: vi.fn(async () => { fakeState.screen = 'battle'; return true }),
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
// 但這個檔案要驗「按鈕文字跟著 needsBreakAfter 走」，所以假元件也讀同一個
// 函式、照真元件的寫法算一次 label（真元件自己的那條測試在
// StatsDashboard.test.js）。
vi.mock('./components/StatsDashboard.vue', async () => {
  const { needsBreakAfter } = await import('./core/battleConfig.js')
  return {
    default: {
      props: ['record', 'history', 'dpsSeries', 'storageError', 'historyError'],
      emits: ['again', 'home'],
      setup(props) {
        return { label: () => (needsBreakAfter(props.record) ? '休息一下再來' : '再討伐一次') }
      },
      template: '<div><button class="fake-again" @click="$emit(\'again\')">{{ label() }}</button></div>',
    },
  }
})

// BreakScreen 換成一顆一按就 emit done 的假按鈕：這個檔案驗的是 App.vue 接到
// done 之後做什麼，不是倒數計時（那在 BreakScreen.test.js）。
vi.mock('./components/BreakScreen.vue', () => ({
  default: {
    emits: ['done'],
    template: '<button class="fake-break-done" @click="$emit(\'done\')">FAKE_DONE</button>',
  },
}))

// OfflineWarmup 會 import offlineAssets.js →@mediapipe/tasks-vision，跟這個
// 檔案要驗的事無關，換掉以免把整包推論函式庫拖進來。
vi.mock('./components/OfflineWarmup.vue', () => ({
  default: { template: '<div class="fake-warmup" />' },
}))

// 這兩個只是為了讓「安裝橫幅掛在哪幾個畫面」那組能真的把 screen 切到
// battle／calibrate（真元件會去跑推論迴圈與 5 秒取樣，跟本檔無關）。
vi.mock('./components/BattleView.vue', () => ({
  default: { props: ['videoEl'], emits: ['finish'], template: '<div class="fake-battle" />' },
}))
vi.mock('./components/CalibrationWizard.vue', () => ({
  default: { emits: ['done'], template: '<div class="fake-calibration" />' },
}))

const { default: App } = await import('./App.vue')

function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(App)
  app.mount(el)
  return { el, app, unmount() { app.unmount(); el.remove() } }
}

beforeEach(() => {
  fakeSession.startBattle.mockClear()
  fakeSession.enterBreak.mockClear()
  fakeSession.leaveBreak.mockClear()
  fakeSession.enterCalibration.mockClear()
  fakeSession.enterTaskSelect.mockClear()
  fakeState.lastRecord = { id: 's-1', result: 'victory', durationMs: 15 * 60_000, demoMode: false }
  fakeState.paused = false
})

describe('App.vue：休息回合結束——兩個入口要兩種出口', () => {
  it('戰鬥中進來的（leaveBreak 回傳 true）：不得再開新的一場', async () => {
    fakeState.screen = 'break'
    fakeSession.leaveBreak.mockImplementation(async () => { fakeState.screen = 'battle'; return true })
    const m = mount()
    await nextTick()

    m.el.querySelector('.fake-break-done').click()
    await nextTick()
    await nextTick()

    expect(fakeSession.leaveBreak).toHaveBeenCalledTimes(1)
    // 這一條就是更正 2 的全部：照 brief 寫成無條件 startBattle() 的話，小孩去
    // 伸展三分鐘回來，這一場的進度整個被丟掉。
    expect(fakeSession.startBattle, '這一場還在，不准開新的一場').not.toHaveBeenCalled()

    m.unmount()
  })

  it('結算頁進來的（leaveBreak 回傳 false）：一定要開新的一場，不能卡在休息畫面', async () => {
    fakeState.screen = 'break'
    fakeSession.leaveBreak.mockImplementation(async () => false)
    const m = mount()
    await nextTick()

    m.el.querySelector('.fake-break-done').click()
    await nextTick()
    await nextTick()

    expect(fakeSession.leaveBreak).toHaveBeenCalledTimes(1)
    expect(fakeSession.startBattle, '沒有進行中的戰鬥，這裡不開就沒有人開了').toHaveBeenCalledTimes(1)
    // 休息回合的出口也沿用同一份校準：小孩剛剛才在這台 iPad 前面校準過，
    // 去伸展三分鐘回來不該被要求重坐一次（【分任務校準】新增的護欄）。
    expect(fakeSession.enterCalibration, '休息完不得重跑校準').not.toHaveBeenCalled()

    m.unmount()
  })

  it('休息畫面的轉場一律走 store（App.vue 不得自己寫 screen）', async () => {
    fakeState.screen = 'break'
    fakeSession.leaveBreak.mockImplementation(async () => false)
    const m = mount()
    await nextTick()

    m.el.querySelector('.fake-break-done').click()
    await nextTick()
    // leaveBreak()／startBattle() 是唯二被呼叫的轉場方法；screen 由它們（經過
    // setScreen()）決定，App.vue 沒有任何一行碰 rawState.screen。
    expect(fakeSession.leaveBreak).toHaveBeenCalled()
    m.unmount()
  })
})

describe('App.vue：結算頁的「再討伐一次 / 休息一下再來」', () => {
  it('短時段（15 分鐘）：按鈕寫「再討伐一次」，按下去直接開新的一場，而且**不重跑校準**', async () => {
    fakeState.screen = 'stats'
    const m = mount()
    await nextTick()

    const btn = m.el.querySelector('.fake-again')
    expect(btn.textContent).toBe('再討伐一次')
    btn.click()
    await nextTick()

    expect(fakeSession.startBattle).toHaveBeenCalledTimes(1)
    expect(fakeSession.enterBreak).not.toHaveBeenCalled()
    // 【分任務校準】必須保持不變的既有行為：「再討伐一次」沿用同一份校準與
    // 任務設定。這一輪把校準搬到選任務之後，最容易順手做錯的事就是讓這顆
    // 按鈕也跟著走一遍新流程（選任務 → 校準 → 開打）——那會讓同一個小孩每
    // 打一場就被要求重坐一次 5 秒校準，而這個年齡層要越快回到戰鬥越好。
    expect(fakeSession.enterCalibration, '再討伐一次不得重跑校準').not.toHaveBeenCalled()
    expect(fakeSession.enterTaskSelect, '再討伐一次不得回到選任務').not.toHaveBeenCalled()

    m.unmount()
  })

  it('長時段（20 分鐘）：按鈕寫「休息一下再來」，按下去進休息回合而不是直接開打', async () => {
    fakeState.screen = 'stats'
    fakeState.lastRecord = { id: 's-2', result: 'timeout', durationMs: 20 * 60_000, demoMode: false }
    const m = mount()
    await nextTick()

    const btn = m.el.querySelector('.fake-again')
    // 文字與行為讀同一個 needsBreakAfter()：這兩條斷言一起紅或一起綠，不可能
    // 出現「寫著休息一下再來、按下去直接開打」。
    expect(btn.textContent).toBe('休息一下再來')
    btn.click()
    await nextTick()

    expect(fakeSession.enterBreak, '要先進休息回合').toHaveBeenCalledTimes(1)
    expect(fakeSession.startBattle, '不得跳過休息直接開打').not.toHaveBeenCalled()

    m.unmount()
  })

  it('展示模式的長時段不觸發休息（評審試玩完不該被請去休息三分鐘）', async () => {
    fakeState.screen = 'stats'
    fakeState.lastRecord = { id: 's-3', result: 'timeout', durationMs: 25 * 60_000, demoMode: true }
    const m = mount()
    await nextTick()

    const btn = m.el.querySelector('.fake-again')
    expect(btn.textContent).toBe('再討伐一次')
    btn.click()
    await nextTick()

    expect(fakeSession.startBattle).toHaveBeenCalledTimes(1)
    expect(fakeSession.enterBreak).not.toHaveBeenCalled()

    m.unmount()
  })
})

describe('App.vue：安裝橫幅掛在哪幾個畫面', () => {
  const cases = [
    ['task', true],
    ['stats', true],
    ['battle', false],
    ['break', false],
    ['calibrate', false],
  ]

  for (const [screen, shown] of cases) {
    it(`screen === '${screen}' 時${shown ? '出現' : '不出現'}安裝橫幅`, async () => {
      fakeState.screen = screen
      const m = mount()
      await nextTick()

      const banner = m.el.querySelector('.install')
      if (shown) expect(banner, '主畫面／結算畫面要看得到安裝提示').not.toBeNull()
      else expect(banner, '戰鬥與休息畫面不該有東西擋住').toBeNull()

      m.unmount()
    })
  }

  // Task 22c（Ruling DR）：暖機面板從任務設定畫面搬到**權限畫面**。
  // 時序才是理由：boot() 裡就包含 MediaPipe 模型下載，而 PermissionGate.request()
  // 正是呼叫 boot() 的地方——走到任務設定畫面時模型早就下載完了，舊位置對第一位
  // 訪客只是事後補一個旗標，進度條永遠瞬間滿格。唯一有意義的時機是「按下
  // 『開啟鏡頭』之前」。再加上 !booted 收斂：boot 成功之後（第二位訪客起、或從
  // 兜底畫面走 enterPermission() 回來）該下載的早就下載完了，再出現只是雜訊。
  //
  // 這條測試原本鎖的是**舊位置**（task 要看得到）。它保護的另一半——「不該掛在
  // 會擋住流程的畫面上」——仍然成立，所以窮舉裡把 battle／break 也列進來，
  // 一起鎖住：搬家不是把保護拿掉。
  const warmupCases = [
    ['permission', false, true, '權限畫面、還沒 boot：暖機唯一有意義的時機'],
    ['permission', true, false, '已經 boot 過，該載的早就載完了'],
    ['privacy', false, false, '每位訪客的第一個畫面，不擺維運性質的東西'],
    ['task', true, false, '舊位置：模型早就載完了'],
    ['stats', true, false, '結算畫面是小孩的成果，不擺維運面板'],
    ['battle', true, false, '戰鬥畫面不該有東西擋住'],
    ['break', true, false, '休息畫面的重點是那份伸展清單'],
  ]
  for (const [screen, booted, shown, why] of warmupCases) {
    it(`離線暖機面板：screen=${screen} / booted=${booted} → ${shown ? '出現' : '不出現'}（${why}）`, async () => {
      fakeState.screen = screen
      fakeState.booted = booted
      const m = mount()
      await nextTick()

      const warmup = m.el.querySelector('.fake-warmup')
      if (shown) expect(warmup, why).not.toBeNull()
      else expect(warmup, why).toBeNull()

      m.unmount()
      fakeState.booted = true
    })
  }
})
