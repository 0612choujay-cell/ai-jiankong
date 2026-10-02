// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { createApp, reactive, nextTick } from 'vue'
// 這個年齡層的產品文案紅線：單句 ≤15 字、不得出現對人格／外觀的負面描述。
import { BANNED_WORDS } from './core/copyGuardrail.js'

const fakeState = reactive({
  screen: 'privacy',
  booted: false,
  bootError: null,
  battle: null,
  posture: 'upright',
  paused: false,
  inferenceHealthy: true,
  inferenceStuck: false,
  // 第 4 輪新增：原本漏掉這個欄位，`!s.cameraHealthy` 讀到 undefined 恆為真
  // ——上面那條測試只渲染開始畫面所以看不出來，但文案測試要真的進戰鬥畫面。
  cameraHealthy: true,
  drowsy: false,
  // Task 22c：設定面板（SettingsSheet）四個 prop 的來源，以及 G 的 loopError。
  voiceEnabled: false,
  phoneDetectEnabled: false,
  perfMode: false,
  clearState: 'idle',
  loopError: null,
  lastRecord: null,
  history: [],
  storageError: null,
  historyError: null,
  // 【分任務校準】：App.vue 的 `:task-type="s.taskType"`（校準畫面要靠它決定
  // 顯示哪一組姿勢指示）。一定要在這裡宣告——沒宣告的話 fakeStateView 這個
  // Proxy 會回傳 UNDECLARED_FIELD_CANARY，CalibrationWizard 會拿到一個不存在
  // 的任務類型然後靜默退回 custom，而這個 fixture 就跟真實 state 脫節了
  // （這個檔案第 4 輪吃過的正是這個虧：cameraHealthy 沒宣告）。
  taskType: 'homework',
  // 複審 B-1：植進哨兵值的兩個「絕對不准進 DOM」的欄位。profile 是校準基準
  // （身體量測值），battle 是整場的原始統計——兩者都是複審實際攻擊過的通道
  // （`:data-profile="JSON.stringify(s.profile)"` 等等）。
  profile: { baselineNeckRatio: 0.987654321, baselineShoulderWidth: 0.3, tag: 'PROFILE-CANARY' },
})

/**
 * 「未宣告欄位」哨兵（複審 B-1 的第二輪）：`session.state` 交給 App.vue 的是
 * 這個 Proxy，任何**這個假 state 沒有宣告過**的欄位都會讀到一個哨兵字串，
 * 而不是 `undefined`。
 *
 * 為什麼需要它：第一版的屬性清單比對擋住了「用既有欄位開新屬性」，但擋不住
 * 複審的攻擊 2——那個攻擊在 `session.js` **新增**一個 `loopErrorDetail`
 * （message + stack）再用 `:title` 送出去。假 session 沒有那個欄位，Vue 對
 * `undefined` 的屬性綁定**根本不渲染那個屬性**，所以屬性清單完全沒變、測試
 * 全綠——而真機上那條屬性是有值的。哨兵把「未宣告欄位」從隱形變成看得見：
 * 屬性會真的出現（清單對不上），字串也會被內容掃描抓到。
 *
 * 代價：假 state 從此必須宣告 App.vue／BattleView 真正讀到的每一個欄位，
 * 否則畫面上會冒出哨兵字串。這正是想要的效果——fixture 與真實 state 脫節
 * 本來就是這個檔案第 4 輪吃過的虧（`cameraHealthy` 沒宣告，`!undefined`
 * 恆為真）。
 */
const UNDECLARED_FIELD_CANARY = 'UNDECLARED-STATE-FIELD'
const fakeStateView = new Proxy(fakeState, {
  get(target, key) {
    // symbol 與 Vue 內部旗標（__v_isRef／__v_raw…）一律原樣放行，否則
    // reactivity 與 JSON 序列化會被這個 Proxy 弄壞。
    if (typeof key === 'symbol' || key.startsWith('__v_')) return target[key]
    if (key in target) return target[key]
    return UNDECLARED_FIELD_CANARY
  },
})

let bootCalls = 0
const inferenceCalls = { scale: [], enabled: [], boost: [] }
const fakeSession = {
  state: fakeStateView,
  rawState: fakeState,
  camera: () => ({}),
  // 需要涵蓋 CalibrationWizard 會用到的方法（含 onBeforeUnmount 的 restore()），
  // 否則掛載 calibrate 畫面或之後 unmount 時會噴例外。
  // 三份記錄都是 Blocking B1 的呼叫點護欄用的：校準期間與卸載時，這個元件
  // 只准翻疊加層（boost），**不准**寫任何絕對值（scale／enabled）。
  inference: () => ({
    setScale: (v) => { inferenceCalls.scale.push(v) },
    setEnabled: (key, enabled) => { inferenceCalls.enabled.push([key, enabled]) },
    setCalibrationBoost: (on) => { inferenceCalls.boost.push(on) },
    step: async () => null,
    actualFps: () => 0,
  }),
  // 第 5 輪：App.vue 改成呼叫 store 的方法而不是直接寫 rawState.screen，
  // 畫面轉換才會經過「鏡頭該不該開」那個唯一判準。假的 session 只要做到
  // 同樣的畫面效果即可（真正的收斂行為由 session.secondSession.test.js 用
  // 真的 cameraCapture.js 驗證）。
  // Task 19：PrivacyNotice 的「我知道了，開始」只換畫面到 'permission'，
  // 還沒有要鏡頭——真正呼叫 boot() 的是 PermissionGate 的「開啟鏡頭」按鈕。
  // 複審第 1 輪 B3：包成 vi.fn()，才能斷言 App.vue 真的有呼叫它們——單看
  // fakeState.screen 的終態測不出來（把 App.vue 的 @agree/@granted 整個改回
  // `session.rawState.screen = ...` 一樣能讓終態正確，因為這裡就是拿
  // fakeState 當同一個物件在寫，見複審報告）。
  enterPermission: vi.fn(() => { fakeState.screen = 'permission' }),
  // 【分任務校準】：權限之後的下一站是**選任務**，校準排在它後面。
  enterTaskSelect: vi.fn(() => { fakeState.screen = 'task' }),
  enterCalibration: vi.fn(() => { fakeState.screen = 'calibrate' }),
  setCalibration: () => {},
  setTask: () => {},
  startBattle: async () => {},
  togglePause: () => {},
  endBattle: async () => {},
  teardown: () => {},
  // Task 14：戰鬥畫面換成真正的 BattleView，這個假 session 也要滿足它的
  // 依賴，否則 screen==='battle' 的測試會在 BattleView 的 setup() 階段就炸掉。
  copy: () => ({ take: () => null, peek: () => null, resetSession: () => {} }),
  onBattleEvent: () => () => {},
  undoTrap: () => false,
  // Task 22c：設定面板／量測畫面／換人玩的呼叫點。全部包成 vi.fn()——Ruling DK：
  // 這幾條線的護欄一定要裝在 App.vue 這個**呼叫點**上，不是只裝在 store 方法
  // 裡。這個專案已經連續兩次把護欄裝錯層（測了 store 方法、複審把 App.vue 的
  // 呼叫點改回直寫，結果全綠）。
  toggleVoice: vi.fn(),
  setPhoneDetectEnabled: vi.fn((on) => { fakeState.phoneDetectEnabled = Boolean(on) }),
  resetPerfMode: vi.fn(() => { fakeState.perfMode = false }),
  clearAllLocalData: vi.fn(async () => { fakeState.clearState = 'done' }),
  resetClearState: vi.fn(() => { fakeState.clearState = 'idle' }),
  enterLab: vi.fn(async () => { fakeState.screen = 'lab' }),
  leaveLab: vi.fn(() => { fakeState.screen = 'task' }),
  // 【分任務校準】：換人玩帶去的是**選任務**（新訪客要自己選任務，而校準的
  // 姿勢指示依賴任務類型）。重新校準的保證沒有變弱——任務畫面唯一的出口就是
  // 「準備開始」，而那條路一定經過校準（完整推導見 session.js）。
  startNewVisitor: vi.fn(() => { fakeState.screen = 'task' }),
  // 第一次呼叫模擬使用者拒絕鏡頭權限（I1 的真實情境）；第二次（「再試一次」）成功。
  boot: vi.fn(async () => {
    bootCalls += 1
    if (bootCalls === 1) {
      const error = { name: 'NotAllowedError' }
      // 複審 I-2：真的 store 從此**只**把 error.name 這個字串寫進 state
      // （session.js 的 boot()），回傳值才保留原始物件。fixture 跟著改成
      // 同樣的形狀——這個檔案第 4 輪就是吃過「fixture 與真實 state 脫節」
      // 的虧（當時是 cameraHealthy 沒宣告）。
      fakeState.bootError = error.name
      return { ok: false, error }
    }
    fakeState.bootError = null
    fakeState.booted = true
    return { ok: true }
  }),
}

vi.mock('./stores/session.js', () => ({ useSession: () => fakeSession }))

// StatsDashboard 真正的實作會 `new Chart(canvasEl)`，jsdom 沒有 canvas 會炸。
// 這個檔案只有 Task 22c 的「換人玩」那一組需要結算畫面**存在**（要驗的是
// App.vue 自己加在角落的那顆出口按鈕），跟圖表怎麼畫無關，所以整個換掉
// （跟 App.stats.test.js／App.break.test.js 既有的作法一致）。
vi.mock('./components/StatsDashboard.vue', () => ({
  default: {
    props: ['record', 'history', 'dpsSeries', 'storageError', 'historyError'],
    emits: ['again', 'home'],
    template: '<div class="fake-stats" />',
  },
}))

// 這裡刻意用跟 CalibrationWizard.mount.test.js 相同的手法：createApp + 手動
// mount，不裝 @vue/test-utils。vi.mock 呼叫會被 vitest 提升到檔案最前面，
// 所以下面這個看起來「晚於 vi.mock」的 import 實際上仍會拿到被 mock 過的版本。
import App from './App.vue'
import appSource from './App.vue?raw'

function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(App)
  app.mount(el)
  return { el, app }
}

/** 讓 start() 內部 `await session.boot(...)` 跟 Vue 的重新渲染都有機會跑完。 */
async function flush() {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await nextTick()
}

describe('App.vue：privacy → permission → task（Task 19；【分任務校準】把校準移到選任務之後）', () => {
  it('一開始看到隱私說明頁（不呼叫 boot），同意後才進 PermissionGate；鏡頭被拒仍能重試並推進到下一個畫面', async () => {
    fakeSession.enterPermission.mockClear()
    fakeSession.enterTaskSelect.mockClear()
    fakeSession.enterCalibration.mockClear()
    const { el, app } = mount()

    // 隱私說明頁：授權前先說明用途，這時 getUserMedia 的唯一入口 boot()
    // 一次都不該被呼叫過（Task 19 存在的理由）。
    expect(fakeState.screen).toBe('privacy')
    expect(fakeSession.boot).not.toHaveBeenCalled()

    const agreeButton = [...el.querySelectorAll('button')].find((b) => b.textContent === '我知道了，開始')
    expect(agreeButton).not.toBeUndefined()
    agreeButton.click()
    await flush()

    expect(fakeState.screen).toBe('permission')
    expect(fakeSession.enterPermission, '@agree 必須真的呼叫 session.enterPermission()').toHaveBeenCalledTimes(1)
    expect(fakeSession.boot, '同意只是換畫面，還沒有要鏡頭').not.toHaveBeenCalled()

    const openButton = el.querySelector('button.primary')
    expect(openButton.textContent.trim()).toBe('開啟鏡頭')
    openButton.click()
    await flush()

    // 錯誤訊息要是小孩看得懂的中文，且給出完整的復原步驟（不是原本 App.vue
    // 那句「請到設定裡允許使用攝影機」就沒了）。
    expect(el.textContent).toContain('鏡頭被擋住了')
    const retryButton = el.querySelector('button.primary')
    expect(retryButton).not.toBeNull() // 按鈕還在——這正是 I1 要鎖住的行為
    expect(retryButton.textContent).toBe('我設定好了，重試')

    retryButton.click()
    await flush()

    expect(fakeState.booted).toBe(true)
    expect(fakeState.bootError).toBe(null)
    // 【分任務校準】：權限之後的下一站從 'calibrate' 改成 'task'。校準量的是
    // 耳朵相對於肩膀的高度，而寫作業／看書／背單字的頭部角度各不相同——
    // 校準必須先知道等一下要做什麼（完整推導見 session.js 的 enterTaskSelect()）。
    expect(fakeState.screen).toBe('task')
    expect(fakeSession.boot).toHaveBeenCalledTimes(2)
    // 複審第 1 輪 B3：這是這個檔案唯一能觀測到「@granted 真的呼叫了那個 store
    // 方法」的地方——單看 fakeState.screen 的終態，就算 App.vue 被改回
    // `session.rawState.screen = 'task'`（那個全黑 bug 的逐字成因）一樣會通過，
    // 因為兩者寫的是同一個 fakeState 物件。
    expect(fakeSession.enterTaskSelect, '@granted 必須真的呼叫 session.enterTaskSelect()').toHaveBeenCalledTimes(1)
    // 而且**不得**直接跳進校準：那正是這一輪要拿掉的順序。
    expect(fakeSession.enterCalibration, '權限之後不得直接進校準').not.toHaveBeenCalled()

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

// 複審第 1 輪 B3：上面那條測試測不出「onTaskChosen() 有沒有 await
// session.enterCalibration()」——mock 版的 enterCalibration() 就算是同步函式，
// 拿掉 await 之後 fakeState.screen 一樣會在同一個 tick 內被改掉，觀測不到
// 差異；而且就算換成真正的 session.js，`await` 本身在 App.vue 這一層也沒有
// 任何後續動作依賴它、Vue 也不等 emit handler 執行完才繼續，一樣觀測不到。
// 這件事只能鎖原始碼文字本身：跟 DebugHud.test.js 用 `?raw` 匯入原始碼、
// 斷言「沒有 v-html」是同一招，這裡斷言「轉場走的是 store 方法而不是繞過
// setScreen() 的 rawState.screen 賦值」。
//
// 【分任務校準】：`await session.enterCalibration()` 這行字沒有消失，只是搬了
// 家——從 onGranted() 搬到 onTaskChosen()（選完任務才進校準）。onGranted()
// 現在呼叫的是同步的 enterTaskSelect()，所以那一行不再需要 await。
describe('App.vue：畫面轉場一律走 store 方法（複審第 1 輪 B3，原始碼文字護欄）', () => {
  it('轉場都走 store 方法（含 onTaskChosen() 的 await enterCalibration()），且整個檔案不得出現 rawState.screen 賦值', () => {
    expect(appSource).toContain('await session.enterCalibration()')
    expect(appSource).toContain('session.enterTaskSelect()')
    expect(appSource).toContain('session.enterPermission()')
    // 刻意**沒有**在這裡加一條 `toContain('await session.startBattle()')`：
    // 那個字串在 App.vue 裡有三個呼叫點（onCalibrated／onAgain／onBreakDone），
    // 所以拿掉其中任何一個它都還是綠的——實測過（突變 M5：拿掉 onCalibrated
    // 的那一行，紅的是 App.taskSelector.test.js 的呼叫點 spy，這條護欄照樣
    // 全綠）。一條不會為它宣稱的目的變紅的斷言，就是這個專案禁止的那種
    // 「看起來有在保護」的護欄。那件事由呼叫點的 spy 斷言負責。
    // 掃描前先把「整行都是註解」的行拿掉，再比對 `rawState.screen =`。
    //
    // 原本只鎖含等號的子字串（理由是說明註解會提到「不直接寫
    // session.rawState.screen」，不含等號所以分得開）。合併 Task 18 時這個假設
    // 就破了：那邊的說明註解寫的是「不直接寫 session.rawState.screen = 'task'」
    // ——**連等號一起引用**，於是護欄紅在一句註解上，而不是任何真的賦值。
    //
    // 修法刻意選「只刪整行註解」而不是寫一個通用的註解挖空器：挖空器要處理
    // 字串內的 `//`、未閉合的 `/*`、template 與 style 區塊的不同註解語法，
    // 任何一處判斷錯都會變成**假陰性**——把真正的違規連同註解一起吃掉。
    // （這不是假想：Task 22a 的文案護欄就是在這一點上被複審抓到假陰性路徑。）
    // 「整行都是註解」則不可能藏住真的賦值：一行程式碼不會以 // 或 * 開頭。
    // 寧可少刪（頂多再次誤報、由人來看一眼），也不要多刪（默默放行真的違規）。
    const codeOnly = appSource
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
      })
      .join('\n')
    expect(codeOnly).not.toContain('rawState.screen =')
  })
})

describe('App.vue：未知畫面狀態的兜底（複審第 1 輪 B1；Task 22c E 重寫斷言）', () => {
  // Task 22c E：這條測試原本用 `b.textContent === '再玩一次'` 找按鈕——也就是
  // 把「按鈕寫什麼字」當成護欄。那個斷言鎖錯了東西：文案本來就會改（這一輪
  // 就改了），而真正不能失去的是**這個兜底畫面有一條走得通的出路**。改成鎖
  // 三件不會隨文案漂移的事：(1) 畫面上只有一顆按鈕、(2) 它按下去真的呼叫
  // 得到既有入口 enterPermission()、(3) 文案沒有回到那句假話，也沒有指向
  // 使用者做不到的操作。
  it('兜底畫面有且只有一條走得通的出路，且文案不對使用者說謊、不指向做不到的操作', async () => {
    fakeSession.enterPermission.mockClear()
    fakeState.screen = 'this-screen-value-does-not-exist'
    const { el, app } = mount()
    await nextTick()

    // standalone PWA 沒有網址列、沒有重新整理按鈕。
    expect(el.textContent).not.toContain('重新整理')
    // 這個分支是**未知狀態**的 catch-all，不是戰鬥結束：對一個掉進未知狀態的
    // 小孩說「這一輪結束囉」是假話，還會讓他以為成績已經結算好了。
    expect(el.textContent).not.toContain('這一輪結束')

    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.length, '兜底畫面要有一顆、而且只有一顆真的能往下走的按鈕').toBe(1)
    const btn = buttons[0]
    expect(btn.textContent.trim().length).toBeGreaterThan(0)
    expect(btn.textContent.trim().length).toBeLessThanOrEqual(15)

    // 提示句同樣受 15 字上限約束（跟戰鬥畫面那三則同一條規則）。
    const hint = el.querySelector('p.hint')
    expect(hint).not.toBeNull()
    expect(hint.textContent.length).toBeLessThanOrEqual(15)

    // 複審第 2 輪 M-N1（controller 補）：隱私 canary 原本只在 battle／stats／
    // task+settings 三條測試裡跑，**兜底畫面從來沒被掃過**——而這裡正是下一個
    // 維護者最想加技術細節的地方（「掉進未知狀態了，把 state 印出來看看」）。
    // 註解寫的「整棵樹的 canary 掃描」讀起來比實際覆蓋的大，補上這一行讓它名實相符。
    expectNoPrivacyLeak(el)

    btn.click()
    await nextTick()
    // 這顆按鈕必須呼叫 enterPermission()——這是這個 App 唯一保證從任何狀態都
    // 走得通的路（權限頁 → 開鏡頭 → 校準 → 任務）。
    expect(fakeSession.enterPermission).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

describe('App.vue：戰鬥畫面的異常提示文案（第 4 輪）', () => {
  // 單句 15 字上限的原始理由是「語音播報會蓋掉下一則提示」——一則提示唸太久，
  // 下一則就疊上來，小孩兩則都聽不完整。Task 9 審查已經有前例（29 字的失敗提示
  // 被要求拆成兩行短句），這裡把那條規則變成會報紅的護欄，而不是只寫在報告裡。
  function warnLines(el) {
    return [...el.querySelectorAll('p.hint.warn')].map((p) => p.textContent)
  }

  it('鏡頭不見了／推論卡住兩則提示都拆成兩行，每行 ≤15 字且能獨立讀懂', async () => {
    fakeState.booted = true
    fakeState.screen = 'battle'
    fakeState.cameraHealthy = false
    fakeState.inferenceStuck = false
    const { el, app } = mount()
    await nextTick()

    const cameraLines = warnLines(el)
    expect(cameraLines.length).toBe(2)
    for (const line of cameraLines) expect(line.length).toBeLessThanOrEqual(15)
    expect(cameraLines[0]).toContain('鏡頭') // 第一行：發生什麼事
    // 第二行：可以做什麼。這兩個詞必須跟畫面上真的存在、而且真的能救回鏡頭的
    // 那顆按鈕一致（togglePause() 的恢復主線走 camera.resume()，track 已死時
    // 會整個 start() 重來並把 cameraHealthy 寫回 true）——文案指向一條走不通的
    // 路徑正是第 3 輪 N3 修掉的問題，別再回去。
    expect(cameraLines[1]).toContain('暫停')
    expect(cameraLines[1]).toContain('繼續')

    fakeState.cameraHealthy = true
    fakeState.inferenceStuck = true
    await nextTick()

    const stuckLines = warnLines(el)
    expect(stuckLines.length).toBe(2)
    for (const line of stuckLines) expect(line.length).toBeLessThanOrEqual(15)
    expect(stuckLines[1]).toContain('結束')

    // 第 7 輪補的第三格：`!s.inferenceHealthy` 那句是戰鬥畫面三個異常分支裡
    // 唯一沒有被任何測試渲染過的——複審把它改成 20 字，這個檔案照樣 3 passed。
    // 護欄要涵蓋「畫面上所有會講給小孩聽的句子」，不是「我記得要檢查的那幾句」。
    fakeState.inferenceStuck = false
    fakeState.inferenceHealthy = false
    await nextTick()

    const unhealthyLines = warnLines(el)
    expect(unhealthyLines.length).toBe(1)
    for (const line of unhealthyLines) expect(line.length).toBeLessThanOrEqual(15)

    fakeState.inferenceHealthy = true
    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
    fakeState.inferenceStuck = false
  })

  // Task 19：原本這裡還有一條「開機錯誤的四種說明也不得破線」，鎖的是舊版
  // App.vue 那個「privacy 畫面兼開機錯誤展示區」的 fallback 區塊
  // （BOOT_ERROR_MESSAGES／bootErrorLines）。隱私流程接上之後，boot() 只會在
  // PermissionGate 裡被呼叫，NotAllowedError 的完整復原步驟與其他錯誤的
  // 通用訊息都改由 PermissionGate 自己顯示並測試（見
  // src/components/PermissionGate.test.js），spec 也明確只做 NotAllowedError
  // 這一條分流，不再需要四種錯誤各自的文案——那份對照表已經是死碼，隨
  // App.vue 那個 fallback 分支一起拿掉，不留一條測著死碼的測試。
})

describe('App.vue：健康度提示不得把 BattleView 的 .arena 往下推（fix round 1，Important）', () => {
  // jsdom 不算版面，getBoundingClientRect 恆為 0，不能拿來鎖「有沒有被推移」。
  // 改成鎖「這個容器本身脫離 normal flow」這個結構性事實：position:fixed 是
  // inline style（不是丟給 <style scoped> 的 class），所以這裡直接讀
  // el.style.position 就能驗到，不必依賴 jsdom 有沒有完整套用 CSS 級聯。
  it('cameraHealthy=false 時，提示容器是 position:fixed，且 BattleView 的 .arena 照常渲染', async () => {
    fakeState.booted = true
    fakeState.screen = 'battle'
    fakeState.cameraHealthy = false
    fakeState.inferenceStuck = false
    fakeState.inferenceHealthy = true
    const { el, app } = mount()
    await nextTick()

    const overlay = el.querySelector('.health-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay.style.position).toBe('fixed')

    // .arena 是 BattleView 的根節點；它必須照常渲染、不會因為上面那個提示
    // 容器佔掉版面高度而被擠壓／往下推到看不見（.arena 本身有沒有實際偏移
    // 是瀏覽器才算得出來的事，這裡只鎖「造成推移的那個容器有沒有脫離 flow」）。
    expect(el.querySelector('.arena')).not.toBeNull()
    // 暫停/結束是 BattleView 內部相對 .arena 定位的角落按鈕，只要 .arena 本身
    // 沒被推出畫面，這兩顆按鈕就還構得著——用「按鈕確實存在且在 .arena 內」
    // 佐證整條鏈路沒斷。
    const arena = el.querySelector('.arena')
    expect(arena.querySelector('.pause')).not.toBeNull()
    expect(arena.querySelector('.stop')).not.toBeNull()

    fakeState.cameraHealthy = true
    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })

  it('三種異常都健康時，提示容器完全不渲染，不留空殼佔位', async () => {
    fakeState.booted = true
    fakeState.screen = 'battle'
    fakeState.cameraHealthy = true
    fakeState.inferenceStuck = false
    fakeState.inferenceHealthy = true
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.health-overlay')).toBeNull()

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

// ---------------------------------------------------------------------------
// Task 22c
// ---------------------------------------------------------------------------

/**
 * 隱私紅線的**屬性通道**護欄（複審 B-1，Blocking）。
 *
 * 背景：上一輪這裡只守 `textContent`。複審從屬性攻進來——`:title`、`:aria-label`、
 * `:data-*` 把 `error.message + error.stack`、`JSON.stringify(s.battle)`、
 * `JSON.stringify(s.profile)`、`s.posture` 掛到 `.detail` 與 `.corner-exit` 上，
 * **655 條全綠**。`:title` 與 `:aria-label` 正是寫 UI 時最自然會伸手去用的兩個
 * 屬性，這不是理論攻擊。
 *
 * 先例：`ThresholdLab.test.js` 的兩條隱私護欄用 `el.innerHTML`（屬性值在裡面）
 * 掃 landmark 座標與 error.message，複審同型攻擊在那個元件上**紅了**。這裡沿用
 * 同一個方向，再補強一層。
 *
 * ## 這個護欄鎖得到什麼
 *
 * 1. **屬性清單完全比對**：新增／改動的四個區塊（`.health-overlay`、`.staff-gear`、
 *    `.staff-extra`、`.corner-exit`）底下，每一個節點的每一個屬性（名稱＋值）都
 *    必須在預期清單裡。這四塊今天的屬性**全部是靜態的**，所以清單是可以逐字寫死
 *    的——任何新綁定（不管叫 `title`、`data-x` 還是塞進既有的 `class`／`aria-label`）
 *    都會讓比對失敗。這一層擋得住「下一個維護者新增一個 state 欄位再掛上去」
 *    這種攻擊，因為它不需要事先知道那個欄位叫什麼。
 * 2. **內容 canary**：整棵 DOM 的 `innerHTML`（含所有屬性值）不得出現植進假
 *    state 的哨兵值（`profile` 的內容、`battle` 的內容、原始角度數字）。這一層
 *    涵蓋上面沒有逐一列舉的節點與文字節點。
 *
 * ## 鎖不到什麼（誠實記錄）
 *
 * - 只涵蓋 App.vue **自己**渲染的那四塊與整棵樹的 canary 掃描；子元件內部的
 *   屬性由各自的測試負責（例如 ThresholdLab 有自己的兩條）。
 * - canary 只認得「這個假 state 裡真的存在的欄位」。全新的 state 欄位（複審的
 *   攻擊 2 就是這種）靠的是第 1 層的屬性清單比對，不是 canary。
 * - jsdom 不跑 CSS，所以「屬性沒洩漏但用 CSS content 洩漏」這種路徑不在範圍內
 *   （這個專案沒有任何 `content:` 帶動態值的用法）。
 */
function attrInventory(root) {
  const out = []
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of node.attributes) {
      // Vue 的 scoped style 標記（data-v-<hash>，值恆為空字串）不列入：那個
      // hash 由 SFC 內容決定，改一行註解就會變，寫進預期清單只會變成每次動
      // App.vue 都要回來改一次的死數字。**只**在值是空字串時跳過——真的有人
      // 寫 `:data-v-x="secret"` 的話值就不是空的，照樣會被逮到。
      if (/^data-v-[0-9a-f]+$/.test(attr.name) && attr.value === '') continue
      out.push(`${node.tagName.toLowerCase()}[${attr.name}="${attr.value}"]`)
    }
  }
  return out.sort()
}

/** 植進假 state 的哨兵值：這些字串一旦出現在 DOM（含屬性值）就是洩漏。 */
const PRIVACY_CANARIES = [
  'PROFILE-CANARY', // s.profile 的內容（校準基準＝身體量測值）
  'BATTLE-CANARY', // s.battle 整包序列化
  '0.987654321', // 原始角度／比值那一類數字
  UNDECLARED_FIELD_CANARY, // 任何「這個假 state 沒宣告過」的欄位被送進 DOM
]

function expectNoPrivacyLeak(el) {
  for (const canary of PRIVACY_CANARIES) {
    expect(el.innerHTML, `隱私紅線：DOM（含屬性值）不得出現 ${canary}`).not.toContain(canary)
  }
}

/** 把畫面切到任務畫面、連點齒輪 5 下把設定面板打開，回傳掛載結果。 */
function openSettings() {
  fakeState.screen = 'task'
  const m = mount()
  const gear = m.el.querySelector('[aria-label="工作人員設定"]')
  for (let i = 0; i < 5; i++) gear.click()
  return m
}

function textButton(el, text) {
  return [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
}

describe('Task 22c G：rAF 迴圈例外（loopError）終於有畫面顯示它', () => {
  function warnLines(el) {
    return [...el.querySelectorAll('p.hint.warn')].map((p) => p.textContent)
  }

  it('其他三項都健康、只有 loopError 有值時，戰鬥畫面顯示兩行提示＋只含 error.name 的技術細節', async () => {
    fakeState.booted = true
    fakeState.screen = 'battle'
    fakeState.cameraHealthy = true
    fakeState.inferenceStuck = false
    fakeState.inferenceHealthy = true
    fakeState.loopError = 'TypeError'
    const { el, app } = mount()
    await nextTick()

    // 這正是 G 要修的那個畫面：迴圈壞到連健康度都不再更新（例外發生在
    // computeInferenceHealthy() 之前就 throw 了），三個旗標全部凍結在「健康」，
    // 原本的三則提示一則都不會出現——戰鬥畫面還在、血量不動、時間不走、
    // 一個字都沒有。
    const lines = warnLines(el)
    expect(lines.length, 'loopError 必須有自己的提示，不能繼續靜音').toBe(2)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(15)
    expect(lines[0]).toContain('卡住') // 第一行：發生什麼事
    // 第二行：可以做什麼。指向的必須是畫面上真的存在、而且按得到的那顆按鈕。
    expect(lines[1]).toContain('結束')

    // controller 追加（第四個「組合字串」缺陷）：技術細節前綴與 error.name
    // 拆成了兩個獨立的 <p class="detail">，不再是同一句裡用「：」隔開。這裡
    // 改成分別驗證兩個節點，不是只看第一個（querySelector 只會抓到第一個）。
    // 隱私紅線：第二個節點**只**能有 error.name，用「剛好等於」而不是
    // toContain()——toContain 放行「名稱＋任何其他東西」，而這一行未來最可能
    // 長出來的東西正是 message／stack／姿態資料那一類（複審突測過:
    // 在後面多插一個 {{ s.posture }}，toContain 版本照樣全綠）。
    const details = [...el.querySelectorAll('.health-overlay .detail')]
    expect(details.length, '前綴與 error.name 必須是兩個獨立節點').toBe(2)
    expect(details[0].textContent.trim()).toBe('技術細節')
    expect(details[1].textContent.trim()).toBe('TypeError')

    fakeState.loopError = null
    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })

  it('鏡頭不見了時，loopError 不得蓋掉那一則——它是黏著的、可能早就過期', async () => {
    fakeState.booted = true
    fakeState.screen = 'battle'
    fakeState.cameraHealthy = false
    fakeState.inferenceStuck = false
    fakeState.inferenceHealthy = true
    fakeState.loopError = 'RangeError'
    const { el, app } = mount()
    await nextTick()

    // 四則互斥、依嚴重程度排序：前三則每一幀重新計算，講的是「現在」；
    // loopError 只有 startBattle() 會清掉，講的是「這一場曾經發生過」。
    // 讓一則可能過期的訊息蓋住正在發生、而且有明確復原路徑的鏡頭提示，
    // 就是第 3 輪 N3 修掉的那個問題（文案指向走不通的路）的翻版。
    const lines = warnLines(el)
    expect(lines[0]).toContain('鏡頭')
    expect(el.querySelector('.health-overlay').textContent).not.toContain('RangeError')

    fakeState.cameraHealthy = true
    fakeState.loopError = null
    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

/**
 * Blocking B1 的**呼叫點**護欄（Ruling DK）。
 *
 * 要防的違規會發生在這裡：有人（像上一版那樣）讓 `App.vue` 把「該還原成什麼」
 * 算出來傳給 `CalibrationWizard`，於是元件在卸載時變成一個會寫絕對值的
 * 寫入者——而流程反轉之後它是**開打前最後一個**寫入者，store 的收斂會被它
 * 無聲蓋掉（工作人員關掉的手機偵測被打開、降檔關掉的 object track 被打開）。
 *
 * 這個檔案掛的是**真正的** CalibrationWizard，所以這條護欄看得到整條線：
 * App.vue 傳了什麼 prop → 元件在取樣與卸載時對 inference 做了什麼。
 * 斷言的是**元件一通絕對值都沒寫**，不是「傳進去的數字對不對」——後者正是
 * 上一版鎖住的東西，而它鎖住的是一個結構上就不該存在的參數。
 */
describe('Blocking B1：校準畫面不得成為推論設定的寫入者（呼叫點護欄）', () => {
  it('降檔中走完校準：元件只翻疊加層，一次 setScale／setEnabled 都不呼叫', async () => {
    fakeState.booted = true
    fakeState.screen = 'calibrate'
    fakeState.perfMode = true
    inferenceCalls.scale.length = 0
    inferenceCalls.enabled.length = 0
    inferenceCalls.boost.length = 0
    const { el, app } = mount()
    await nextTick()

    textButton(el, '開始校準').click()
    await nextTick()
    expect(inferenceCalls.boost, '校準期間要開疊加層（提頻＋關掉用不到的 track）').toEqual([true])

    app.unmount() // → onBeforeUnmount → restore()
    expect(inferenceCalls.boost, '卸載時只把疊加層拿掉，不帶任何「該還原成什麼」的知識').toEqual([true, false])

    // 這兩條是這組護欄的全部價值：只要有人把絕對值寫回這個元件（不管是
    // 寫死的 1、還是 App.vue 算好傳進來的 0.5），這裡就會紅。
    expect(inferenceCalls.scale, '校準畫面不得寫推論倍率——倍率的唯一寫入者是 store').toEqual([])
    expect(inferenceCalls.enabled, '校準畫面不得開關任何 track——track 的唯一寫入者是 store').toEqual([])

    el.remove()
    fakeState.perfMode = false
    fakeState.screen = 'privacy'
  })
})

describe('【分任務校準】：校準畫面真的拿得到這一次的任務類型（呼叫點護欄）', () => {
  // 這個檔案掛的是**真正的** CalibrationWizard（不是替身），所以這裡看得到
  // 整條線的終點：App.vue 的 `:task-type="s.taskType"` → 元件的 steps →
  // 畫面上那三行姿勢指示。
  //
  // 為什麼需要這一條，而不是只靠 CalibrationWizard 自己的測試：那邊驗的是
  // 「給它 taskType 它會顯示對的話」，這裡驗的是「App.vue 真的有給」。
  // 少了 `:task-type`，元件會靜默退回預設的 'custom'——四種任務又變回同一句
  // 通用指示，而畫面上看起來完全正常。這正是 Ruling DK 說的那一層。
  const cases = [
    ['homework', '作業本'],
    ['reading', '書'],
    ['vocab', '單字卡'],
  ]

  for (const [taskType, keyword] of cases) {
    it(`taskType=${taskType} 時，校準畫面的步驟提到「${keyword}」`, async () => {
      fakeState.booted = true
      fakeState.screen = 'calibrate'
      fakeState.taskType = taskType
      const { el, app } = mount()
      await nextTick()

      const steps = [...el.querySelectorAll('.how li')].map((li) => li.textContent)
      expect(steps.length, '三行：東西放哪裡 → 背挺直 → 按開始之後看哪裡').toBe(3)
      expect(steps.join('｜')).toContain(keyword)

      app.unmount()
      el.remove()
      fakeState.taskType = 'homework'
      fakeState.screen = 'privacy'
    })
  }
})

describe('隱私紅線：屬性通道（複審 B-1，Blocking）', () => {
  it('health-overlay 的每一個屬性都必須是預期中的靜態值，且整棵 DOM 不含哨兵值', async () => {
    fakeState.booted = true
    fakeState.screen = 'battle'
    fakeState.cameraHealthy = true
    fakeState.inferenceStuck = false
    fakeState.inferenceHealthy = true
    fakeState.loopError = 'TypeError'
    // 讓 `JSON.stringify(s.battle)` 這條攻擊有東西可以洩漏（複審攻擊 1）。
    fakeState.battle = {
      elapsedMs: 0, durationMs: 60_000, bossHp: 10, bossHpMax: 10, bossHpPhaseMax: 10,
      playerHp: 100, score: 0, attacks: 0, streak: 0, phase: 1, phase2Damage: 0,
      regrouping: false, ended: false, result: null, pendingTraps: [], dpsSeries: [],
      postureDurationMs: {}, distractionDurationMs: {}, trapCount: {}, tag: 'BATTLE-CANARY',
    }
    const { el, app } = mount()
    await nextTick()

    // 這一塊今天的屬性**全部是靜態的**（一個 class、一個 inline position），
    // 所以可以逐字寫死。任何新綁定——不管叫 title、aria-label、data-diag，
    // 也不管它掛的是既有欄位還是某個未來才新增的 state 欄位——都會讓這個
    // 清單對不上。這是唯一一種「不需要事先知道攻擊者用哪個欄位」的鎖法。
    expect(attrInventory(el.querySelector('.health-overlay'))).toEqual([
      'div[class="health-overlay"]',
      'div[style="position: fixed;"]',
      // controller 追加：技術細節前綴與 error.name 拆成兩個獨立的
      // p[class="detail"]（見上面「不併句」的修法），這裡的清單要跟著更新，
      // 不然這條屬性完全比對的護欄會對著舊結構打假紅。
      'p[class="detail"]',
      'p[class="detail"]',
      'p[class="hint warn"]',
      'p[class="hint warn"]',
    ])
    expectNoPrivacyLeak(el)

    fakeState.loopError = null
    fakeState.battle = null
    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })

  it('結算畫面的「換人玩」出口不得夾帶任何狀態（複審用 :data-profile 攻過這一顆）', async () => {
    fakeState.booted = true
    fakeState.screen = 'stats'
    const { el, app } = mount()
    await nextTick()

    expect(attrInventory(el.querySelector('.corner-exit'))).toEqual([
      'button[class="corner-exit"]',
      'button[type="button"]',
    ])
    expectNoPrivacyLeak(el)

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })

  it('齒輪與設定面板旁那一列也一樣：aria-label 只能是那句固定的標籤', async () => {
    const { el, app } = openSettings()
    await nextTick()

    // aria-label 是這四塊裡唯一一個「合法且必要」的文字屬性，所以它的**值**
    // 也一起鎖死——否則 `:aria-label="'err ' + s.loopError + ' ' + s.posture"`
    // 這種攻擊（複審攻擊 1 用過）會從名稱白名單的縫裡穿過去。
    expect(attrInventory(el.querySelector('.staff-gear'))).toEqual([
      'button[aria-label="工作人員設定"]',
      'button[class="staff-gear"]',
      'button[type="button"]',
    ])
    expect(attrInventory(el.querySelector('.staff-extra'))).toEqual([
      'button[class="staff-btn"]',
      'button[class="staff-btn"]',
      'button[type="button"]',
      'button[type="button"]',
      'div[class="staff-extra"]',
    ])
    expectNoPrivacyLeak(el)

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

describe('Task 22c F：離線暖機面板搬到權限流程（Ruling DR）', () => {
  // boot() 裡就包含 MediaPipe 模型下載，而 PermissionGate.request() 正是呼叫
  // boot() 的地方——掛在任務畫面對第一位訪客只是事後補旗標，進度條永遠瞬間
  // 滿格。唯一有意義的時機是「按下開啟鏡頭之前」。
  const cases = [
    ['privacy', false, false, '隱私說明頁是每位訪客的第一個畫面，不擺維運性質的東西'],
    ['permission', false, true, '權限畫面、還沒 boot：這是暖機唯一有意義的時機'],
    ['permission', true, false, '已經 boot 過，該下載的早就下載完了，再出現只是雜訊'],
    ['task', true, false, '舊位置：模型早就載完了，不該再掛在這裡'],
  ]
  for (const [screen, booted, shown, why] of cases) {
    it(`screen=${screen} / booted=${booted} → ${shown ? '顯示' : '不顯示'}（${why}）`, async () => {
      fakeState.screen = screen
      fakeState.booted = booted
      const { el, app } = mount()
      await nextTick()

      const warmup = el.querySelector('.warmup')
      if (shown) expect(warmup).not.toBeNull()
      else expect(warmup).toBeNull()

      app.unmount()
      el.remove()
      fakeState.screen = 'privacy'
    })
  }
})

describe('Task 22c A：工作人員設定面板的 5 連點入口（Ruling DU）', () => {
  it('任務畫面角落有一個看得見的齒輪；600ms 內連點 5 下才打開面板', async () => {
    vi.useFakeTimers()
    fakeState.screen = 'task'
    fakeState.booted = true
    fakeSession.resetClearState.mockClear()
    const { el, app } = mount()
    await nextTick()

    const gear = el.querySelector('[aria-label="工作人員設定"]')
    // 「看得見」是 Ruling DU 的明確要求：Task 16 的審查禁止新增隱形高 z-index
    // 圖層（隱形圖層會吃掉它底下按鈕的點擊，而且沒有人查得出來）。
    expect(gear, '任務畫面要有一個看得見的設定入口').not.toBeNull()
    expect(gear.textContent.trim().length).toBeGreaterThan(0)

    for (let i = 0; i < 4; i++) gear.click()
    await nextTick()
    expect(
      el.querySelector('[aria-label="工作人員設定"][role="dialog"]'),
      '4 下不該打開——面板裡有「清除所有本地紀錄」這個不可逆操作',
    ).toBeNull()

    gear.click()
    await nextTick()
    expect(el.querySelector('[role="dialog"]')).not.toBeNull()
    // 面板一打開就先把上一次的清除結果字樣收回 idle，否則會顯示
    // 「清除失敗，請再試」而這一次根本什麼都還沒做。
    expect(fakeSession.resetClearState).toHaveBeenCalledTimes(1)

    textButton(el, '關閉設定').click()
    await nextTick()
    expect(el.querySelector('[role="dialog"]')).toBeNull()

    app.unmount()
    el.remove()
    vi.useRealTimers()
    fakeState.screen = 'privacy'
  })

  it('連點之間超過 600ms 就重新計數（小孩零星亂點不會慢慢累積把面板打開）', async () => {
    vi.useFakeTimers()
    fakeState.screen = 'task'
    const { el, app } = mount()
    await nextTick()
    const gear = el.querySelector('[aria-label="工作人員設定"]')

    for (let i = 0; i < 4; i++) gear.click()
    vi.advanceTimersByTime(700) // 視窗過期，計數歸零
    gear.click()
    await nextTick()
    expect(el.querySelector('[role="dialog"]'), '跨過視窗的點擊不該累加').toBeNull()

    for (let i = 0; i < 4; i++) gear.click() // 這一輪的第 2~5 下
    await nextTick()
    expect(el.querySelector('[role="dialog"]')).not.toBeNull()

    app.unmount()
    el.remove()
    vi.useRealTimers()
    fakeState.screen = 'privacy'
  })
})

describe('Task 22c A：設定面板每一個開關都打到對應的 store 方法', () => {
  it('語音／手機偵測／重設效能模式／清除紀錄各自呼叫到正確的方法', async () => {
    fakeSession.toggleVoice.mockClear()
    fakeSession.setPhoneDetectEnabled.mockClear()
    fakeSession.resetPerfMode.mockClear()
    fakeSession.clearAllLocalData.mockClear()
    fakeState.phoneDetectEnabled = false
    fakeState.perfMode = true // 「重設效能模式」在沒有降檔時是 disabled
    const { el, app } = openSettings()
    await nextTick()

    const switches = [...el.querySelectorAll('[role="switch"]')]
    expect(switches.length).toBe(2)
    switches[0].click() // 語音提示
    switches[1].click() // 手機偵測
    await nextTick()
    expect(fakeSession.toggleVoice).toHaveBeenCalledTimes(1)
    // 面板的 @toggle-phone-detect 不帶參數，App.vue 要把「現在是關的 → 要打開」
    // 這件事翻譯成明確的布林值，不能讓兩邊各自維護一份開關狀態。
    expect(fakeSession.setPhoneDetectEnabled).toHaveBeenCalledWith(true)

    textButton(el, '重設效能模式').click()
    await nextTick()
    expect(fakeSession.resetPerfMode).toHaveBeenCalledTimes(1)

    textButton(el, '清除所有紀錄').click()
    await nextTick()
    // 不可逆操作要先過二次確認（面板自己的 ConfirmDialog），不是一按就清。
    expect(fakeSession.clearAllLocalData).not.toHaveBeenCalled()
    textButton(el, '清除紀錄').click()
    await nextTick()
    expect(fakeSession.clearAllLocalData).toHaveBeenCalledTimes(1)

    fakeState.perfMode = false
    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

describe('Task 22c B：ThresholdLab 的入口與畫面', () => {
  it('設定面板旁邊的入口呼叫 session.enterLab()，並把面板收掉（面板的遮罩會蓋住整個量測畫面）', async () => {
    fakeSession.enterLab.mockClear()
    const { el, app } = openSettings()
    await nextTick()

    textButton(el, '姿態量測工具').click()
    await nextTick()

    // Ruling DK：護欄裝在 App.vue 這個呼叫點上。只看 fakeState.screen 的終態
    // 測不出差異——那個假 session 寫的是同一個物件，直寫畫面狀態一樣會「對」。
    expect(fakeSession.enterLab).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[role="dialog"]')).toBeNull()

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })

  it('screen==="lab" 時渲染量測畫面，它的「關閉」呼叫 session.leaveLab()', async () => {
    fakeSession.leaveLab.mockClear()
    fakeState.booted = true
    fakeState.screen = 'lab'
    const { el, app } = mount()
    await nextTick()

    const lab = el.querySelector('.threshold-lab')
    expect(lab, 'lab 畫面要真的渲染 ThresholdLab（而不是掉進兜底畫面）').not.toBeNull()

    textButton(el, '關閉').click()
    await nextTick()
    expect(fakeSession.leaveLab).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

describe('Task 22c D：換人玩（Ruling DY）', () => {
  it('結算畫面角落有出口，二次確認之後才呼叫 session.startNewVisitor()', async () => {
    fakeSession.startNewVisitor.mockClear()
    fakeState.booted = true
    fakeState.screen = 'stats'
    const { el, app } = mount()
    await nextTick()

    const exit = textButton(el, '換人玩')
    expect(exit, '結算畫面是工作人員交接 iPad 的時機，出口要長在這裡').not.toBeUndefined()
    expect(exit.textContent.trim().length).toBeLessThanOrEqual(15)

    exit.click()
    await nextTick()
    // 這顆按鈕小孩碰得到，而按下去會離開他正在看的成績——先確認。
    expect(fakeSession.startNewVisitor).not.toHaveBeenCalled()
    textButton(el, '先不要').click()
    await nextTick()
    expect(fakeSession.startNewVisitor).not.toHaveBeenCalled()

    textButton(el, '換人玩').click()
    await nextTick()
    textButton(el, '好，換下一位').click()
    await nextTick()
    // Ruling DK：轉場走 store 方法，不是在 App.vue 這裡自己寫一套。
    expect(fakeSession.startNewVisitor).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })

  it('確認框開著時，底下那一列入口按不到——不得再按進量測畫面（複審 I-2）', async () => {
    fakeSession.enterLab.mockClear()
    const { el, app } = openSettings()
    await nextTick()

    expect(textButton(el, '姿態量測工具'), '確認框還沒開，入口在').not.toBeUndefined()

    textButton(el, '換人玩').click()
    await nextTick()

    // `.staff-extra` 的 z-index 是 11、確認框的 backdrop 是 10——不把那一列
    // 收掉的話，確認框開著時它仍然在上面而且點得到，按下去會帶著一個
    // inset:0 的遮罩整片蓋在量測畫面（brief 稱為「交付門檻本身」）上。
    // 原則：確認框開著的時候，不該還有東西在它上面可以點。
    expect(el.querySelector('.staff-extra'), '確認框開著時整列都要收掉').toBeNull()
    expect(textButton(el, '姿態量測工具')).toBeUndefined()
    expect(fakeSession.enterLab).not.toHaveBeenCalled()

    // 複審第 2 輪 M-N1（controller 補）：換人玩的確認框是另一塊 canary 從沒掃過
    // 的畫面。它掛在結算頁上、而結算頁握有 lastRecord 與 history，是整個 App
    // 最容易順手把「上一位訪客的數字」寫進 :title 當說明的地方。
    expectNoPrivacyLeak(el)

    // 取消之後要回得來（收掉不是拿掉）。
    textButton(el, '先不要').click()
    await nextTick()
    expect(el.querySelector('.staff-extra')).not.toBeNull()

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })

  it('工作人員設定面板裡也有同一個出口，走同一條確認流程', async () => {
    fakeSession.startNewVisitor.mockClear()
    const { el, app } = openSettings()
    await nextTick()

    textButton(el, '換人玩').click()
    await nextTick()
    expect(fakeSession.startNewVisitor).not.toHaveBeenCalled()

    textButton(el, '好，換下一位').click()
    await nextTick()
    expect(fakeSession.startNewVisitor).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[role="dialog"]'), '確認之後設定面板也要收掉').toBeNull()

    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})

// ---------------------------------------------------------------------------
// 版面／可及性複審：Blocking——App.vue template 用到的每一個 class 都必須有
// 對應的 CSS 定義（`.health-overlay` 的 `<p class="hint warn">` 曾經完全沒有
// 對應的 `.hint`/`.warn` 規則）
// ---------------------------------------------------------------------------

describe('Blocking（版面／可及性複審）：App.vue template 用到的 class，必須在自己的 scoped style 或全域 CSS 裡有定義', () => {
  // 背景：`.health-overlay` 的四則裝置異常警告（鏡頭不見了／看不清楚／推論
  // 不穩定／loopError）用的是 `<p class="hint warn">`，但 App.vue 自己的
  // <style scoped> 從來沒有定義過 `.hint`/`.warn`——其他元件（CalibrationWizard/
  // StatsDashboard/ThresholdLab/SettingsSheet/StatusIndicator）scoped style
  // 裡同名的規則不會套用到這裡（Vue scoped style 靠編譯期加的 data-v 屬性
  // 選擇器隔離）。結果是這四則最需要被注意到的警告，長得跟一般說明文字
  // 一模一樣。
  //
  // jsdom 不做 CSS 級聯，甚至不會把 <style> 標籤的內容拿去算 computed style
  // ——斷言「算出來的顏色是 --c-warn」會是一條讀到瀏覽器預設值、永遠綠的
  // 假測試。這裡改成斷言一件結構性事實：appSource 的 <template> 裡出現過的
  // 每一個 class，都能在 appSource 的 <style scoped> 或全域 CSS
  // （src/styles/*.css）裡找到至少一條選擇器定義它。
  //
  // 這條鎖得到：擋住「template 用了一個 class，但這個檔案能看到的 CSS 從來
  // 沒人定義過」這一整類 bug（.hint/.warn 就是一個實例）。
  // 這條鎖不到（誠實記錄）：那條 CSS 規則的視覺效果對不對（顏色是否真的
  // 醒目、字重是否真的加粗、iOS Safari 實際渲染結果）——那些只能真機驗證；
  // 也鎖不到「有定義」是否等於「真的套用到這個元素」（例如選擇器層級寫錯
  // 但剛好同名），那需要真正的 CSS 引擎才能確認；也不驗證其他元件自己
  // scoped style 裡的 class 完整性（那些各自有自己的測試檔案負責，或見
  // StatusIndicator.test.js 的同型護欄）。
  function stripHtmlComments(html) {
    return html.replace(/<!--[\s\S]*?-->/g, '')
  }

  function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '')
  }

  function extractTemplateClasses(source) {
    const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/)
    const used = new Set()
    if (!templateMatch) return used
    const tpl = stripHtmlComments(templateMatch[1])
    for (const m of tpl.matchAll(/\sclass="([^"{}]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c)
    }
    return used
  }

  function extractCssClasses(css) {
    const classes = new Set()
    for (const m of stripCssComments(css).matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.add(m[1])
    return classes
  }

  function extractScopedClasses(source) {
    const styleMatch = source.match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)
    if (!styleMatch) return new Set()
    return extractCssClasses(styleMatch[1])
  }

  it('App.vue 沒有任何 template 用過、卻找不到 CSS 定義的 class', () => {
    const used = extractTemplateClasses(appSource)
    const scoped = extractScopedClasses(appSource)
    const globalSets = [
      readFileSync('src/styles/base.css', 'utf8'),
      readFileSync('src/styles/layout.css', 'utf8'),
      readFileSync('src/styles/tokens.css', 'utf8'),
    ].map(extractCssClasses)

    const missing = [...used].filter(
      (c) => !scoped.has(c) && !globalSets.some((set) => set.has(c)),
    )
    expect(missing, `這些 class 在 App.vue 的 template 出現過，卻找不到任何 CSS 定義：${missing.join(', ')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// controller 追加：第四個「組合字串」缺陷——loopError 的技術細節不得跟固定
// 前綴併成同一句
// ---------------------------------------------------------------------------

describe('App.vue：loopError 技術細節不得與固定前綴併成同一句（第四個組合字串缺陷，controller 追加）', () => {
  // 背景：`技術細節：{{ s.loopError }}` 曾經併成一句，`s.loopError` 存的是
  // `error.name`，真實會出現的名稱像 NotReadableError（16 字）、
  // ReferenceError（14 字），組出來 21 字／19 字，破 15 字上限，而且跟同一個
  // 覆蓋層裡上面那兩行（各自都乖乖 ≤15 字）不一致。修法跟 OfflineWarmup.vue
  // 已經定案的作法一致：把固定前綴與變數拆成兩個獨立的文字節點。
  it('技術細節前綴與 error.name 是兩個獨立節點；前綴本身固定 ≤15 字且無禁用詞，error.name 那一行不窮舉但結構上不併句', async () => {
    fakeState.booted = true
    fakeState.screen = 'battle'
    fakeState.cameraHealthy = true
    fakeState.inferenceStuck = false
    fakeState.inferenceHealthy = true
    // 刻意挑一個真實會出現、字數偏長的 error.name：跟固定前綴「技術細節」
    // （4 字）併成一句的話會是「技術細節：NotReadableError」共 21 字，遠超
    // 15 字上限——用這個值來讓「有沒有併句」這件事在斷言裡看得出差異。
    fakeState.loopError = 'NotReadableError'
    const { el, app } = mount()
    await nextTick()

    const details = [...el.querySelectorAll('.health-overlay .detail')]
    expect(details.length, '前綴與 error.name 必須是兩個獨立節點，不是同一個 <p> 併成一句').toBe(2)

    // 靜態前綴：字面值固定、無條件可窮舉，鎖死長度與禁用詞。
    expect(details[0].textContent.trim()).toBe('技術細節')
    expect(details[0].textContent.length).toBeLessThanOrEqual(15)
    for (const word of BANNED_WORDS) expect(details[0].textContent).not.toContain(word)

    // error.name 那一行：定義域是瀏覽器/JS 平台給的技術識別字，不是本專案
    // 審過的封閉集合，這裡鎖不住「它本身會不會超過 15 字」（這個測試案例
    // 選的 NotReadableError 本身就是 16 字）——能鎖住、也已經鎖住的只有
    // 「它沒有跟固定前綴湊成同一句」：這一行的文字必須剛好等於 error.name
    // 本身，不含「技術細節」字樣或任何其他前綴／後綴。
    expect(details[1].textContent.trim()).toBe('NotReadableError')
    expect(details[1].textContent).not.toContain('技術細節')

    fakeState.loopError = null
    app.unmount()
    el.remove()
    fakeState.screen = 'privacy'
  })
})
