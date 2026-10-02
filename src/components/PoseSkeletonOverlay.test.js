// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createApp, nextTick, reactive } from 'vue'
import { SRC_DIR } from '../core/copyGuardrail.js'
import PoseSkeletonOverlay from './PoseSkeletonOverlay.vue'

/**
 * 骨架線疊加層。這個檔案的優先序是**隱私測試在前、功能測試在後**，因為這個
 * 元件是全專案唯一拿得到原始 landmark 座標的畫面元件——它是那條「座標壓縮成
 * 純量才離開 inferenceService」界線上刻意開的一個洞，所以洞口的護欄比它畫得
 * 好不好看重要得多。
 *
 * 鎖不到什麼（誠實記錄）：
 * - **畫出來對不對**。jsdom 沒有 canvas 實作，這裡全部用假的 2D context 記
 *   呼叫。線條在真機上有沒有對齊影像、鏡像方向對不對，只能靠實機看。
 *   這裡能做的是把「對齊」拆成幾個**可以推理**的部分（object-fit 換算、
 *   scaleX(-1) 與宿主一致、landmark 索引與 poseGeometry 一致）各自鎖住。
 * - **記憶體裡有沒有殘留**。這裡驗的是「不在 DOM、不在 setupState」，
 *   驗不了 V8 堆疊裡那個陣列什麼時候被回收。
 */

const OVERLAY_FILE = path.join(SRC_DIR, 'components', 'PoseSkeletonOverlay.vue')
const OVERLAY_SRC = readFileSync(OVERLAY_FILE, 'utf8')

/**
 * 真正的 `<style>` 內容，**註解已挖空**。
 *
 * 兩件事都是突變實測抓到的（沒有它們，兩條護欄都是「綠得沒有理由」）：
 * - 行首錨定：檔頭那段說明裡也會出現「<style>」這幾個字，不錨定會從那裡
 *   開始一路吃掉整個 <script>。
 * - 挖掉 CSS 註解：這個檔案的樣式註解逐字寫著「pointer-events: none」與
 *   「transform: scaleX(-1)」在解釋為什麼要有它們。不挖掉的話，**把宣告本身
 *   刪掉護欄照樣是綠的**——註解自己就讓斷言通過了。
 */
const OVERLAY_STYLE = (OVERLAY_SRC.match(/^<style[^>]*>([\s\S]*?)^<\/style>/m)?.[1] ?? '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

// ---------------------------------------------------------------------------
// 假的 2D context：記下每一次呼叫與參數。
// ---------------------------------------------------------------------------
function makeCtx() {
  return {
    calls: [],
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
    fillStyle: '',
    clearRect(...a) { this.calls.push(['clearRect', ...a]) },
    beginPath() { this.calls.push(['beginPath']) },
    moveTo(...a) { this.calls.push(['moveTo', ...a]) },
    lineTo(...a) { this.calls.push(['lineTo', ...a]) },
    arc(...a) { this.calls.push(['arc', ...a]) },
    stroke() { this.calls.push(['stroke']) },
    fill() { this.calls.push(['fill']) },
  }
}

let ctx
beforeEach(() => {
  ctx = makeCtx()
  // jsdom 沒有 canvas 實作（getContext 會噴 "Not implemented"）。
  window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx)
  // Ruling CH (b)：上一條測試留在共用 host 上的 props 不得流到下一條。
  hostState.inference = null
  hostState.video = null
  hostState.fit = 'cover'
  hostState.posture = null
})

function callsOf(name) {
  return ctx.calls.filter((c) => c[0] === name)
}

// ---------------------------------------------------------------------------
// 假的 inferenceService：只有 onPoseFrame，其他方法一律不給。
//
// 理由跟 BattleView.test.js 那個假 inference 一樣（Ruling DK：護欄裝在違規會
// 發生的地方）：這個元件若哪天呼叫了 setScale／setEnabled／setCalibrationBoost／
// init／destroy，測試會當場因為「不是函式」而炸掉，不必靠人工複查。
// ---------------------------------------------------------------------------
function makeInference() {
  const observers = []
  return {
    observers,
    onPoseFrame(fn) {
      observers.push(fn)
      return () => {
        const i = observers.indexOf(fn)
        if (i !== -1) observers.splice(i, 1)
      }
    },
    push(landmarks) { for (const fn of [...observers]) fn(landmarks) },
  }
}

function fakeVideo(videoWidth = 640, videoHeight = 480) {
  return { videoWidth, videoHeight }
}

/**
 * 一組 33 點的假 landmarks，四個關鍵點帶**明顯可辨識的哨兵小數**。
 * 這幾個數字就是隱私測試要在 DOM／setupState 裡找不到的東西。
 */
const COORD_CANARIES = ['0.123456', '0.654321', '0.222222', '0.777777', '0.888888', '0.111111']

function makeLandmarks(overrides = {}) {
  const pts = []
  for (let i = 0; i < 33; i += 1) pts.push({ x: 0.5, y: 0.5, visibility: 0.9 })
  pts[7] = { x: 0.123456, y: 0.222222, visibility: 0.9 } // 左耳
  pts[8] = { x: 0.654321, y: 0.222222, visibility: 0.9 } // 右耳
  pts[11] = { x: 0.111111, y: 0.777777, visibility: 0.9 } // 左肩
  pts[12] = { x: 0.888888, y: 0.777777, visibility: 0.9 } // 右肩
  for (const [i, p] of Object.entries(overrides)) pts[i] = p
  return pts
}

/**
 * 共用的宿主元件：props 走一份 reactive 狀態，而不是 `createApp()` 的 rootProps。
 *
 * 理由是「宿主的 inference 會從 null 變成實例」這件事必須測得到——
 * `session.inference()` 在 `boot()` 之前是 null，而 rootProps 掛上去之後就
 * 不會再變了，用它根本演不出那個轉變。
 */
const hostState = reactive({ inference: null, video: null, fit: 'cover', posture: null })
const Host = {
  components: { PoseSkeletonOverlay },
  setup: () => ({ s: hostState }),
  template:
    '<PoseSkeletonOverlay :inference="s.inference" :video="s.video" :fit="s.fit" :posture="s.posture" />',
}

function mount(props = {}) {
  hostState.inference = props.inference ?? null
  hostState.video = props.video ?? null
  hostState.fit = props.fit ?? 'cover'
  hostState.posture = props.posture ?? null
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(Host)
  const vm = app.mount(el)
  // Host 的根節點就是疊加層，所以 subTree 的 component 就是它的實例。
  return { el, app, overlay: vm.$.subTree.component }
}

// ===========================================================================
// 1. 隱私（最重要，優先於功能）
// ===========================================================================

describe('隱私：座標只活在繪圖函式的參數裡', () => {
  it('餵進哨兵座標之後，DOM（含所有屬性值）不得出現任何一個座標值', async () => {
    const inference = makeInference()
    const { el, app } = mount({ inference, video: fakeVideo() })
    await nextTick()

    inference.push(makeLandmarks())
    await nextTick()

    // 先證明那一幀真的被消化了，否則「沒洩漏」只是因為根本沒畫
    // （Ruling CH：綠得沒有理由的測試）。
    expect(callsOf('stroke').length, '這一幀應該真的畫了線').toBe(1)

    for (const canary of COORD_CANARIES) {
      expect(el.innerHTML, `隱私紅線：DOM（含屬性值）不得出現座標 ${canary}`).not.toContain(canary)
    }

    app.unmount()
    el.remove()
  })

  it('座標不得出現在元件的 setupState（Vue devtools 看得到的就是這一份）', async () => {
    const inference = makeInference()
    const { el, app, overlay } = mount({ inference, video: fakeVideo() })
    await nextTick()

    inference.push(makeLandmarks())
    await nextTick()

    const found = scanForCanaries(overlay.setupState, COORD_CANARIES)
    // 這一條擋的是「存進一個沒有用在模板上的 ref，反正 DOM 看不到」——
    // 那仍然是 reactive state，仍然出現在 devtools 裡，仍然是可以被下一個人
    // 順手轉送出去的東西。
    expect(found, `座標被存進元件狀態：${found.join('、')}`).toEqual([])

    app.unmount()
    el.remove()
  })

  it('<canvas> 只有兩個靜態屬性，沒有任何繫結的屬性通道', async () => {
    const inference = makeInference()
    const { el, app } = mount({ inference, video: fakeVideo() })
    inference.push(makeLandmarks())
    await nextTick()

    const canvas = el.querySelector('canvas')
    const attrs = [...canvas.attributes]
      .filter((a) => !(/^data-v-[0-9a-f]+$/.test(a.name) && a.value === ''))
      .map((a) => `${a.name}="${a.value}"`)
      .sort()
    // 完全相等比對：新屬性一律要被有意識地核准過（跟
    // CalibrationWizard.mount.test.js 的屬性清單同一個作法）。
    expect(attrs).toEqual(['aria-hidden="true"', 'class="skeleton"'])
    // width/height 只有在量得到版面尺寸時才會被寫成屬性（jsdom 的
    // clientWidth 恆為 0）。就算被寫了也只是版面尺寸，不是座標——但清單
    // 是完全相等比對，所以那一天會有人被迫回來看一眼。
    expect(canvas.getAttribute('width')).toBe(null)

    app.unmount()
    el.remove()
  })

  it('原始碼護欄：畫布不得被序列化、不得寫進任何儲存層', () => {
    const code = stripComments(OVERLAY_SRC)
    for (const api of ['toDataURL', 'toBlob', 'getImageData', 'captureStream']) {
      expect(code, `畫完的像素只活在螢幕上，不得經由 ${api} 變成可以被傳出去的東西`)
        .not.toContain(api)
    }
    for (const sink of ['localStorage', 'indexedDB', 'JSON.stringify', 'fetch(']) {
      expect(code, `疊加層不得把任何東西送進 ${sink}`).not.toContain(sink)
    }
  })

  it('原始碼護欄：疊加層不得 import 任何既有的資料流模組', () => {
    const code = stripComments(OVERLAY_SRC)
    // 座標一旦被交給這些模組裡的任何一個函式，它就開始流過整個既有的壓縮
    // 界線，之後每一個碰過 metrics 的地方都要重新審查隱私。
    for (const mod of ['session.js', 'focusStateMachine.js', 'storageService.js', 'poseGeometry.js']) {
      expect(code, `疊加層不得 import ${mod}`).not.toContain(mod)
    }
  })

  it('原始碼護欄：座標不得被指派給 ref／reactive', () => {
    const code = stripComments(OVERLAY_SRC)
    // 這個元件唯一的 ref 是模板參照 canvasEl。多一個 ref 不必然是違規，
    // 但這個檔案的規模不需要第二個——多出來的那一刻應該有人看一眼。
    const refCount = (code.match(/\bref\(/g) ?? []).length
    expect(refCount, 'ref() 只該有 canvasEl 一個（多出來的那一個要有人看一眼）').toBe(1)
    expect(code, '這個元件不需要 reactive()').not.toContain('reactive(')
  })
})

// ===========================================================================
// 2. 資料流的接線
// ===========================================================================

describe('資料流：訂閱 inference.onPoseFrame()，卸載時解除', () => {
  it('掛載後訂閱一次，卸載後解除', async () => {
    const inference = makeInference()
    const { el, app } = mount({ inference, video: fakeVideo() })
    await nextTick()

    expect(inference.observers.length).toBe(1)

    app.unmount()
    expect(inference.observers.length, '卸載後還留著訂閱＝一條指向已卸載元件的路').toBe(0)
    el.remove()
  })

  it('inference 是 null（或舊替身沒有 onPoseFrame）時安靜地不畫，不炸掉整個畫面', async () => {
    const { el, app } = mount({ inference: null })
    await nextTick()
    expect(el.querySelector('canvas')).not.toBeNull()
    app.unmount()

    const { el: el2, app: app2 } = mount({ inference: { actualFps: () => 0 } })
    await nextTick()
    expect(el2.querySelector('canvas')).not.toBeNull()
    app2.unmount()

    el.remove()
    el2.remove()
  })

  it('inference 從 null 變成實例時會補訂閱（session.inference() 在 boot() 之前是 null）', async () => {
    const inference = makeInference()
    const { el, app } = mount({ inference: null })
    await nextTick()
    expect(inference.observers.length, '還沒有實例，當然還沒訂閱').toBe(0)

    // 只在 onMounted 訂閱一次的寫法，會讓「取到 null 就永遠是 null」變成一個
    // 沒有任何錯誤訊息的靜默失敗：骨架線整場不出現，而沒有人知道為什麼。
    hostState.inference = inference
    await nextTick()
    expect(inference.observers.length).toBe(1)

    app.unmount()
    expect(inference.observers.length).toBe(0)
    el.remove()
  })
})

// ===========================================================================
// 3. 繪圖：畫哪幾條線、座標怎麼換算
// ===========================================================================

describe('繪圖：兩條線（肩線、頸線）＋三個關節點', () => {
  function drawOnce(landmarks, props = {}) {
    const inference = makeInference()
    const mounted = mount({ inference, video: fakeVideo(), ...props })
    inference.push(landmarks)
    return mounted
  }

  it('有效姿勢：清一次畫布、畫兩條線段（4 次 moveTo/lineTo 配對）', () => {
    const { el, app } = drawOnce(makeLandmarks())

    expect(callsOf('clearRect').length).toBe(1)
    expect(callsOf('stroke').length).toBe(1)
    // 肩線（moveTo+lineTo）＋頸線（moveTo+lineTo）
    expect(callsOf('lineTo').length, '肩線與頸線，剛好兩條線段').toBe(2)
    expect(callsOf('arc').length, '兩肩＋頸線頂端，三個關節點').toBe(3)
    expect(callsOf('fill').length).toBe(1)

    app.unmount()
    el.remove()
  })

  it('肩膀等高時，肩線兩端的 y 相等（左右不會被畫歪）', () => {
    const { el, app } = drawOnce(makeLandmarks())

    const shoulderFrom = callsOf('moveTo')[0]
    const shoulderTo = callsOf('lineTo')[0]
    expect(Math.abs(shoulderFrom[2] - shoulderTo[2])).toBeLessThan(0.001)
    // 而且它們的 x 明顯分開——否則「畫了一條長度為零的線」也會通過上一條。
    expect(Math.abs(shoulderFrom[1] - shoulderTo[1])).toBeGreaterThan(1)

    app.unmount()
    el.remove()
  })

  it('頸線從兩耳中點連到兩肩中點，而且耳朵那端比較高（y 較小）', () => {
    const { el, app } = drawOnce(makeLandmarks())

    const earMid = callsOf('moveTo')[1]
    const shoulderMid = callsOf('lineTo')[1]
    // 兩耳中點的 x = (0.123456+0.654321)/2；兩肩中點的 x = (0.111111+0.888888)/2
    // 兩者不同，所以這一條同時證明「中點真的是各自算的」，不是抄同一個值。
    expect(earMid[1]).not.toBeCloseTo(shoulderMid[1], 5)
    // 影像座標 y 向下為正：耳朵在上，y 比較小。這正是 poseGeometry 的
    // neckRatio =（肩中 y − 耳中 y）/ 肩寬 在頭抬起時為正值的那個關係。
    expect(earMid[2]).toBeLessThan(shoulderMid[2])

    app.unmount()
    el.remove()
  })

  it('fit=contain：影像被置中留白，線條跟著平移（手算比對）', () => {
    // 畫布 300×150（jsdom 的 <canvas> 預設值），影像 640×480。
    // contain → k = min(300/640, 150/480) = min(0.46875, 0.3125) = 0.3125
    // sx = 640*0.3125 = 200、sy = 480*0.3125 = 150
    // ox = (300−200)/2 = 50、oy = (150−150)/2 = 0
    // 左肩 x=0.111111 → 50 + 0.111111*200 = 72.2222
    const { el, app } = drawOnce(makeLandmarks(), { fit: 'contain', video: fakeVideo(640, 480) })

    const shoulderFrom = callsOf('moveTo')[0]
    expect(shoulderFrom[1]).toBeCloseTo(50 + 0.111111 * 200, 3)
    expect(shoulderFrom[2]).toBeCloseTo(0 + 0.777777 * 150, 3)

    app.unmount()
    el.remove()
  })

  it('fit=cover：影像被放大裁切，線條跟著（同一個公式，max 換 min）', () => {
    // cover → k = max(300/640, 150/480) = 0.46875
    // sx = 300、sy = 225、ox = 0、oy = (150−225)/2 = −37.5
    const { el, app } = drawOnce(makeLandmarks(), { fit: 'cover', video: fakeVideo(640, 480) })

    const shoulderFrom = callsOf('moveTo')[0]
    expect(shoulderFrom[1]).toBeCloseTo(0 + 0.111111 * 300, 3)
    expect(shoulderFrom[2]).toBeCloseTo(-37.5 + 0.777777 * 225, 3)

    app.unmount()
    el.remove()
  })

  it('量不到影像原生尺寸時退回「整個拉滿」，不是整個不畫', () => {
    // 影格還沒 decode（videoWidth 是 0）時仍然要畫得出東西——否則一上畫面
    // 的頭幾百毫秒會完全沒有回饋，而那正是使用者最需要知道「有沒有被看到」
    // 的時候。
    const { el, app } = drawOnce(makeLandmarks(), { video: fakeVideo(0, 0) })

    const shoulderFrom = callsOf('moveTo')[0]
    expect(shoulderFrom[1]).toBeCloseTo(0.111111 * 300, 3)
    expect(shoulderFrom[2]).toBeCloseTo(0.777777 * 150, 3)

    app.unmount()
    el.remove()
  })
})

describe('繪圖：失敗要優雅——清掉，不留殘影', () => {
  function pushAndCollect(landmarks) {
    const inference = makeInference()
    const mounted = mount({ inference, video: fakeVideo() })
    inference.push(makeLandmarks()) // 先畫一幀真的有東西的
    const before = callsOf('stroke').length
    inference.push(landmarks) // 再推一幀無效的
    return { ...mounted, before }
  }

  const cases = [
    ['null（完全沒偵測到人）', null],
    // 這一組刻意是「除了點數以外樣樣正常」的 20 點：突變實測發現，隨便給一個
    // 很短的陣列時，**先接住它的其實是肩寬下限**（缺漏的點被當成同一點、
    // 肩寬 0），於是「點數要滿 33」那條判斷根本沒有被驗到（Ruling CH (a)）。
    // 20 點含有 7/8/11/12 而且數值完全合理，所以只有點數那條擋得住它。
    ['點數不足 33 但關鍵點都在（換了模型或壞掉的結果）', makeLandmarks().slice(0, 20)],
    ['關鍵點缺漏', makeLandmarks({ 11: undefined })],
    ['關鍵點 visibility 低於門檻', makeLandmarks({ 12: { x: 0.888888, y: 0.777777, visibility: 0.1 } })],
    ['肩寬小於下限（人太遠／側身）', makeLandmarks({
      11: { x: 0.5, y: 0.777777, visibility: 0.9 },
      12: { x: 0.505, y: 0.777777, visibility: 0.9 },
    })],
  ]

  for (const [label, landmarks] of cases) {
    it(`${label}：清畫布但不畫線`, () => {
      const { el, app, before } = pushAndCollect(landmarks)

      expect(callsOf('stroke').length, '無效的這一幀不該再畫線').toBe(before)
      expect(callsOf('clearRect').length, '但畫布一定要被清掉，不能留上一幀的殘影').toBe(2)

      app.unmount()
      el.remove()
    })
  }
})

// ===========================================================================
// 4. 效能：每幀都要跑的東西
// ===========================================================================

describe('效能：每幀零配置、不重配 backing store', () => {
  it('連續 10 幀只在第一幀配置一次 backing store，之後尺寸沒變就不再碰', () => {
    const inference = makeInference()
    const { el, app } = mount({ inference, video: fakeVideo() })
    const canvas = el.querySelector('canvas')
    // jsdom 的 clientWidth/clientHeight 恆為 0（它不做版面計算），不給假值的話
    // 尺寸同步那段程式碼**一次都不會執行**，這條測試就會綠得沒有理由
    // （Ruling CH (a)：綠的原因不是它該綠的那個原因）。
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => 600 })
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => 400 })

    let resizes = 0
    for (const prop of ['width', 'height']) {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLCanvasElement.prototype, prop)
      Object.defineProperty(canvas, prop, {
        configurable: true,
        get: () => desc.get.call(canvas),
        set: (v) => { resizes += 1; desc.set.call(canvas, v) },
      })
    }

    for (let i = 0; i < 10; i += 1) inference.push(makeLandmarks())

    // 寫 canvas.width/height 會清空畫布並重新配置整張 bitmap。每幀寫一次
    // 等於每幀重配一張全螢幕大小的記憶體——這個 App 有一個單向、不可升回的
    // 效能降檔，那是它絕對不能承受的成本。
    expect(resizes, '10 幀只該有第一幀那一次 width+height').toBe(2)
    expect(canvas.width, '尺寸真的被同步過（否則上一條是空轉的）').toBe(600)
    expect(callsOf('stroke').length).toBe(10)

    app.unmount()
    el.remove()
  })

  it('每一幀的 context 呼叫次數是常數（沒有隨幀數累積的東西）', () => {
    const inference = makeInference()
    const { el, app } = mount({ inference, video: fakeVideo() })

    inference.push(makeLandmarks())
    const first = ctx.calls.length
    inference.push(makeLandmarks())
    const second = ctx.calls.length - first

    expect(second).toBe(first)
    expect(first, '一幀＝clearRect+2×beginPath+5×moveTo+2×lineTo+3×arc+stroke+fill').toBe(15)

    app.unmount()
    el.remove()
  })
})

// ===========================================================================
// 5. 兩套真相護欄：這個元件跟它的宿主、跟 poseGeometry 必須講同一件事
// ===========================================================================

const BATTLE_SRC = readFileSync(path.join(SRC_DIR, 'components', 'BattleView.vue'), 'utf8')
const CALIB_SRC = readFileSync(path.join(SRC_DIR, 'components', 'CalibrationWizard.vue'), 'utf8')
const POSE_GEOMETRY_SRC = readFileSync(path.join(SRC_DIR, 'core', 'poseGeometry.js'), 'utf8')
const TOKENS_SRC = readFileSync(path.join(SRC_DIR, 'styles', 'tokens.css'), 'utf8')

const HOSTS = [
  { name: 'BattleView.vue', source: BATTLE_SRC, fit: 'cover' },
  { name: 'CalibrationWizard.vue', source: CALIB_SRC, fit: 'contain' },
]

describe('兩套真相護欄', () => {
  it('landmark 索引與門檻的宣告，跟 poseGeometry.js 逐字相同', () => {
    // 這裡是不得不的第二份（畫線的人本來就得知道要連哪兩個點）。兩份飄掉的
    // 後果是靜默的：畫面上的線跟遊戲實際在量的點不是同一組，而小孩會照著
    // 線調整姿勢——他會被一條畫錯的線教成錯的坐姿。
    const lines = [
      'const EAR_L = 7, EAR_R = 8, SHOULDER_L = 11, SHOULDER_R = 12',
      'const MIN_VISIBILITY = 0.5',
      'const MIN_SHOULDER_WIDTH = 0.02',
    ]
    for (const line of lines) {
      expect(POSE_GEOMETRY_SRC, `poseGeometry.js 的「${line}」變了`).toContain(line)
      expect(OVERLAY_SRC, `疊加層的「${line}」跟 poseGeometry.js 對不上`).toContain(line)
    }
  })

  for (const { name, source, fit } of HOSTS) {
    it(`${name}：<video> 的 object-fit 與傳給疊加層的 fit 一致（${fit}）`, () => {
      const camRule = source.match(/\.cam\s*\{[^}]*\}/)?.[0] ?? ''
      expect(camRule, `${name} 找不到 .cam 的樣式規則`).not.toBe('')
      // 對不上的後果：線條整體偏移，而且偏移量隨裝置長寬比改變——在某些
      // 尺寸上看起來「差不多對」，在另一些尺寸上明顯歪掉。
      expect(camRule, `${name} 的 .cam 沒有明寫 object-fit: ${fit}`).toContain(`object-fit: ${fit}`)
      expect(source, `${name} 傳給疊加層的 fit 不是 ${fit}`).toContain(`fit="${fit}"`)
    })

    it(`${name}：<video> 與疊加層都做 scaleX(-1)，鏡像方向一致`, () => {
      const camRule = source.match(/\.cam\s*\{[^}]*\}/)?.[0] ?? ''
      // 少了它，使用者往右偏頭、線往左跑——比沒有線更糟：畫面在說謊。
      expect(camRule, `${name} 的鏡像預覽沒有 scaleX(-1)`).toContain('scaleX(-1)')
    })

    it(`${name}：疊加層掛在 <video> 之後，兩者在同一個 .arena__hero 裡`, () => {
      const hero = source.match(/<(section|div) class="arena__hero"[\s\S]*?<\/\1>/)?.[0]
        ?? source.match(/<div class="arena__hero">[\s\S]*?<\/div>/)?.[0]
        ?? ''
      expect(hero, `${name} 找不到 .arena__hero`).not.toBe('')
      const videoAt = hero.indexOf('ref="localVideo"')
      const overlayAt = hero.indexOf('<PoseSkeletonOverlay')
      expect(videoAt, `${name} 的 .arena__hero 裡找不到鏡像 <video>`).toBeGreaterThan(-1)
      expect(overlayAt, `${name} 的疊加層不在 .arena__hero 裡`).toBeGreaterThan(-1)
      expect(overlayAt, '疊加層必須排在 <video> 之後才畫得到它上面').toBeGreaterThan(videoAt)
    })
  }

  it('疊加層自己也做 scaleX(-1)，而且 pointer-events:none', () => {
    expect(OVERLAY_STYLE, '疊加層沒有鏡像，線就會左右相反於使用者的實際動作')
      .toContain('transform: scaleX(-1)')
    // 擋住暫停／結束／撤銷鈕的疊加層等於把復原路徑拿掉。
    expect(OVERLAY_STYLE, '疊加層吃了觸控，底下的按鈕就點不到了')
      .toContain('pointer-events: none')
  })

  it('線條顏色的 fallback 逐字等於 tokens.css 的 --c-accent（不得發明色碼）', () => {
    const token = TOKENS_SRC.match(/--c-accent:\s*(#[0-9a-fA-F]{3,8})/)?.[1] ?? ''
    expect(token).not.toBe('')
    expect(OVERLAY_SRC, `fallback 色碼跟 --c-accent（${token}）不一致`)
      .toContain(`const FALLBACK_STROKE = '${token}'`)
    expect(OVERLAY_SRC, '正常路徑要走 token，不是走色碼').toContain('color: var(--c-accent)')
  })

  // -------------------------------------------------------------------------
  // 依姿態變色（使用者要求：「正常是黃線，駝背異常是紅線」）。
  //
  // 校準畫面（不傳 posture）零改動——上面的 --c-accent fallback 測試已經
  // 鎖住那條路徑，這裡只測新加的那一半：posture 有值時的行為。
  // -------------------------------------------------------------------------
  describe('依姿態變色', () => {
    it('STROKE_OK／STROKE_BAD 兩個字面值逐字等於 tokens.css 的 --c-warn／--c-danger', () => {
      const warn = TOKENS_SRC.match(/--c-warn:\s*(#[0-9a-fA-F]{3,8})/)?.[1] ?? ''
      const danger = TOKENS_SRC.match(/--c-danger:\s*(#[0-9a-fA-F]{3,8})/)?.[1] ?? ''
      expect(warn).not.toBe('')
      expect(danger).not.toBe('')
      expect(OVERLAY_SRC, `STROKE_OK 跟 --c-warn（${warn}）不一致`)
        .toContain(`const STROKE_OK = '${warn}'`)
      expect(OVERLAY_SRC, `STROKE_BAD 跟 --c-danger（${danger}）不一致`)
        .toContain(`const STROKE_BAD = '${danger}'`)
    })

    it('posture="upright" 時線是 STROKE_OK（黃）', async () => {
      const warn = TOKENS_SRC.match(/--c-warn:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
      const inference = makeInference()
      const { app } = mount({ inference, video: fakeVideo(), posture: 'upright' })
      await nextTick()

      inference.push(makeLandmarks())
      await nextTick()

      expect(callsOf('stroke').length, '這幀沒有真的畫，顏色斷言沒有意義').toBeGreaterThan(0)
      expect(ctx.strokeStyle).toBe(warn)
      app.unmount()
    })

    it.each(['slouch', 'forwardHead', 'gazeAway'])(
      'posture="%s"（非 upright）時線是 STROKE_BAD（紅）——不列舉異常字串，只認「不是 upright」',
      async (posture) => {
        const danger = TOKENS_SRC.match(/--c-danger:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
        const inference = makeInference()
        const { app } = mount({ inference, video: fakeVideo(), posture })
        await nextTick()

        inference.push(makeLandmarks())
        await nextTick()

        expect(callsOf('stroke').length).toBeGreaterThan(0)
        expect(ctx.strokeStyle).toBe(danger)
        app.unmount()
      },
    )

    it('姿態中途改變，同一顆疊加層不必重新掛載就換色（跟著 reactive prop 走）', async () => {
      const warn = TOKENS_SRC.match(/--c-warn:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
      const danger = TOKENS_SRC.match(/--c-danger:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
      const inference = makeInference()
      const { app } = mount({ inference, video: fakeVideo(), posture: 'upright' })
      await nextTick()

      inference.push(makeLandmarks())
      await nextTick()
      expect(ctx.strokeStyle).toBe(warn)

      // 改 reactive 來源之後要先 flush：props 是透過 Vue 的更新佇列往下傳，
      // 不是賦值當下就同步反映到子元件——這裡原本漏了這次 await，
      // 呼叫 push() 時子元件讀到的還是上一輪的 props.posture。
      hostState.posture = 'slouch'
      await nextTick()
      inference.push(makeLandmarks())
      await nextTick()
      expect(ctx.strokeStyle).toBe(danger)

      app.unmount()
    })

    it('posture 沒有傳（null，校準畫面）時完全不走 STROKE_OK／STROKE_BAD 那個分支', async () => {
      // 這條原本想斷言「strokeStyle 逐字等於 --c-accent」，但 jsdom 的
      // getComputedStyle 對沒有真的套上樣式表的元素會回傳一個非空的預設值
      // （實測是 'rgb(0, 0, 0)'），不是空字串——`computed || FALLBACK_STROKE`
      // 因此拿到的是那個預設值，FALLBACK_STROKE 這條路徑在 jsdom 裡永遠
      // 走不到，只有真的瀏覽器才可能命中。斷言一個 jsdom 環境給不出的值，
      // 是在測 jsdom 的行為，不是在測這個元件——上一條「線條顏色的 fallback
      // 逐字等於 tokens.css」的原始碼比對測試已經鎖住 FALLBACK_STROKE 跟
      // --c-accent 一致這件事，這裡不重複鎖同一個承諾不了的東西。
      //
      // 這裡真正能鎖、也該鎖的，是「校準路徑沒有被這次改動污染」：
      // posture===null 時，畫出來的顏色一定不是新加的兩個姿態色之一
      // ——如果是，代表 null 被誤判成了某個姿態字串。
      const warn = TOKENS_SRC.match(/--c-warn:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
      const danger = TOKENS_SRC.match(/--c-danger:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
      const inference = makeInference()
      const { app } = mount({ inference, video: fakeVideo() }) // posture 預設 null
      await nextTick()

      inference.push(makeLandmarks())
      await nextTick()

      expect(callsOf('stroke').length, '這幀沒有真的畫，顏色斷言沒有意義').toBeGreaterThan(0)
      expect(ctx.strokeStyle).not.toBe(warn)
      expect(ctx.strokeStyle).not.toBe(danger)
      app.unmount()
    })
  })

  it('<style> 裡沒有 transition／animation——所以 reduced-motion 沒有東西要處理', () => {
    // 先挖掉 CSS 註解：上面那段說明會逐字寫出「刻意沒有 transition/animation」，
    // 不挖掉的話這條護欄永遠是紅的。
    const style = OVERLAY_STYLE
    expect(style.trim(), '抓不到樣式內容，這條護欄是在對空氣斷言').not.toBe('')
    // 這一條不是在禁止動畫，是在讓「加了動畫」變成一件必須被看見的事：
    // 誰要加淡入效果，就會在這裡紅，然後想起 prefers-reduced-motion。
    for (const prop of ['transition', 'animation', '@keyframes']) {
      expect(style, `疊加層加了 ${prop}，請一併處理 prefers-reduced-motion`).not.toContain(prop)
    }
  })
})

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 只挖掉「整行都是註解」的行：上面那幾段說明會逐字提到被禁的 API 名稱。 */
function stripComments(source) {
  return source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
}

/**
 * 遞迴掃描元件狀態裡的每一個字串／數字，找哨兵值。
 *
 * 跳過函式與 DOM 節點（canvasEl 指向的就是那個 <canvas>，它本來就該在
 * setupState 裡）。深度上限純粹是防呆，不是判準的一部分。
 */
function scanForCanaries(root, canaries, maxDepth = 8) {
  const hits = new Set()
  const seen = new Set()
  const walk = (value, depth) => {
    if (value === null || value === undefined || depth > maxDepth) return
    const t = typeof value
    if (t === 'function') return
    if (t === 'number' || t === 'string' || t === 'boolean') {
      const s = String(value)
      for (const c of canaries) if (s.includes(c)) hits.add(c)
      return
    }
    if (t !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    if (typeof value.nodeType === 'number') return
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    for (const k of Object.keys(value)) {
      let v
      try { v = value[k] } catch { continue }
      walk(v, depth + 1)
    }
  }
  walk(root, 0)
  return [...hits]
}
