// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createApp, nextTick } from 'vue'
import CalibrationWizard from './CalibrationWizard.vue'
import {
  BANNED_WORDS, SRC_DIR, blankPureCommentLines, stripHtmlCommentSpans,
} from '../core/copyGuardrail.js'

// 手動控制的 rAF：不讓 loop() 自己跑，改由測試逐幀 driveFrame()（同
// ThresholdLab.test.js／session.test.js 的既有作法）。原本這個檔案沒有 stub，
// 那也表示原本的測試從來沒有真的驅動過 loop()——而 loop() 正是這個元件唯一
// 拿到原始 metrics 的地方（複審 I-1 的攻擊面）。
let pendingFrame = null
vi.stubGlobal('requestAnimationFrame', (cb) => { pendingFrame = cb; return 1 })
vi.stubGlobal('cancelAnimationFrame', () => { pendingFrame = null })

// Ruling CH (b)：上一條測試留下的未執行 frame 不得流到下一條。
beforeEach(() => { pendingFrame = null })

async function driveFrame() {
  const cb = pendingFrame
  pendingFrame = null
  if (cb) await cb(performance.now())
  await nextTick()
}

function stubInference(log = { scale: [], enabled: [], boost: [] }) {
  return {
    setScale(v) { log.scale?.push(v) },
    setEnabled(key, enabled) { log.enabled?.push([key, enabled]) },
    setCalibrationBoost(on) { log.boost?.push(on) },
    step: async () => null,
    actualFps: () => 0,
  }
}
function inferenceLog() {
  return { scale: [], enabled: [], boost: [] }
}

function mount(props) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(CalibrationWizard, props)
  app.mount(el)
  return { el, app }
}

describe('CalibrationWizard 攝影機預覽掛接', () => {
  it('掛載後把 props.videoEl 的 stream 接到內部預覽 video（不是靠死碼、是真的接線）', () => {
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' } // jsdom 不驗證型別，隨便一個物件即可代表 MediaStream

    const { el, app } = mount({ camera: {}, inference: stubInference(), videoEl })

    const localVideo = el.querySelector('video.cam')
    expect(localVideo).not.toBeNull()
    expect(localVideo.srcObject).toBe(videoEl.srcObject)

    app.unmount()
    el.remove()
  })

  it('videoEl 沒有 stream 時顯示「鏡頭還沒接上」，不靜默留白', async () => {
    const videoEl = document.createElement('video') // 沒有塞 srcObject

    const { el, app } = mount({ camera: {}, inference: stubInference(), videoEl })
    await nextTick() // cameraMissing 是 reactive ref，DOM patch 排在下一個 tick

    expect(el.textContent).toContain('鏡頭還沒接上')

    app.unmount()
    el.remove()
  })

  it('videoEl 是 null 時也顯示「鏡頭還沒接上」，不靜默留白', async () => {
    const { el, app } = mount({ camera: {}, inference: stubInference(), videoEl: null })
    await nextTick()

    expect(el.textContent).toContain('鏡頭還沒接上')

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// 【分任務校準】：四種任務各自的姿勢指示
//
// 為什麼這件事非做不可（實機驗收，使用者原話：「開頭在測試姿勢也有點難懂，
// 是要坐正臉看鏡頭還是要測看書寫作業的樣子」）：校準量的是耳朵相對於肩膀的
// 高度（poseGeometry.js 的 neckRatio），而那個數字完全由視線落在哪裡決定。
// 用抬頭看螢幕的姿勢校準、卻低頭寫作業，遊戲會整場認為小孩在駝背——而他其實
// 坐得很好；反過來（駝著背校準）則是整場都不提醒他。兩個方向都是靜默的。
//
// 上一輪只能給一句對三種任務都成立的通用指示，因為校準發生在選任務之前。
// 這一輪把流程反轉成「選任務 → 校準」，這裡才有 taskType 可以讀。
// ---------------------------------------------------------------------------
describe('CalibrationWizard 分任務的姿勢指示（【分任務校準】）', () => {
  function stepsOf(el) {
    return [...el.querySelectorAll('.how li')].map((li) => li.textContent)
  }

  function mountWithTask(taskType) {
    return mount({ camera: {}, inference: stubInference(), videoEl: null, taskType })
  }

  // 每一組的第 1、3 句必須指向**那個任務真實會有的東西**，而不是四種共用的
  // 一句話——「這一格有沒有真的分開」就是這一輪的全部價值所在。
  const cases = [
    ['homework', ['作業本', '作業本']],
    ['reading', ['書', '書']],
    ['vocab', ['單字卡', '單字卡']],
  ]

  for (const [taskType, [setupKeyword, gazeKeyword]] of cases) {
    it(`taskType=${taskType}：第一句講東西放哪裡（${setupKeyword}）、第三句講按開始之後看哪裡（${gazeKeyword}）`, () => {
      const { el, app } = mountWithTask(taskType)
      const steps = stepsOf(el)

      expect(steps.length, '三行：東西放哪裡 → 背挺直 → 按開始之後看哪裡').toBe(3)
      expect(steps[0]).toContain(setupKeyword)
      expect(steps[2]).toContain(gazeKeyword)
      // 「按開始，然後看著…」而不是「看著…」：按鈕按下去才開始取樣，先講
      // 動作順序，小孩才不會為了讀畫面而在取樣期間一直抬頭。
      expect(steps[2]).toContain('按開始')

      app.unmount()
      el.remove()
    })
  }

  it('custom（自己選）誠實地給一句通用的話，不假裝知道小孩要做什麼', () => {
    const { el, app } = mountWithTask('custom')
    const steps = stepsOf(el)

    expect(steps[0]).toContain('等一下要做的東西')
    expect(steps[2]).toContain('平常做事的姿勢')
    // 反向護欄：不得為了湊滿四種而編一個具體的姿勢——那會讓基準值系統性地
    // 偏向一個他等一下根本不會用的姿勢，比通用指示更糟。
    for (const word of ['作業本', '書', '單字卡']) {
      expect(steps.join('｜'), `custom 不該假設小孩在做什麼（出現了「${word}」）`).not.toContain(word)
    }

    app.unmount()
    el.remove()
  })

  it('四種任務**每一種**都必須講「背挺直」——少了它，駝著背校準會被記成正確基準', () => {
    // 反向風險，而且比「用錯姿勢校準」更難發現：小孩一開始就駝著背校準，
    // 那個駝背會被 collector 記成基準（neckRatio 偏低），之後整場都不會提醒
    // 他——他坐得越糟，遊戲越認為他坐得好。所以這一句是四組的交集，不是
    // 其中三組的巧合。
    for (const taskType of ['homework', 'reading', 'vocab', 'custom']) {
      const { el, app } = mountWithTask(taskType)
      expect(stepsOf(el).join('｜'), `${taskType} 少了「背挺直」`).toContain('背挺直')
      app.unmount()
      el.remove()
    }
  })

  it('未知的 taskType 退回 custom，而不是讓步驟清單整個消失', () => {
    // 靜默失敗的形狀：`TASK_STEPS[props.taskType]` 是 undefined 時 v-for 不會
    // 報錯，畫面上只剩標題跟按鈕，而校準照樣跑完 5 秒、照樣記下一組基準值。
    const { el, app } = mountWithTask('this-task-does-not-exist')
    const steps = stepsOf(el)

    expect(steps.length).toBe(3)
    expect(steps[2]).toContain('平常做事的姿勢')

    app.unmount()
    el.remove()
  })

  it('沒有傳 taskType 時預設 custom（單獨掛載這個元件的測試不必每次都傳）', () => {
    const { el, app } = mount({ camera: {}, inference: stubInference(), videoEl: null })
    expect(stepsOf(el)[2]).toContain('平常做事的姿勢')
    app.unmount()
    el.remove()
  })

  it('四組指示都不含禁用詞（整檔長度豁免不包含禁用詞，那條規則沒有例外）', () => {
    // CalibrationWizard.vue 在 copyGuardrail 的 VUE_LENGTH_RULE_EXCEPTIONS 裡
    // 有整檔長度豁免（步驟說明是靜態文字、不朗讀、不會被下一則訊息取代），
    // 但規則 A（禁用詞）全專案適用、沒有任何例外。這一條在渲染後的 DOM 上
    // 再驗一次，涵蓋的是「組合出來的那一句」而不只是原始碼裡的字面值。
    for (const taskType of ['homework', 'reading', 'vocab', 'custom']) {
      const { el, app } = mountWithTask(taskType)
      const text = stepsOf(el).join('｜')
      for (const word of BANNED_WORDS) {
        expect(text, `${taskType} 的指示含禁用詞「${word}」`).not.toContain(word)
      }
      app.unmount()
      el.remove()
    }
  })
})

/**
 * Blocking B1：這個元件不得是推論設定的寫入者。
 *
 * 出過什麼事：流程反轉（選任務 → 校準 → 開打）之後，`onCalibrated()` 是
 * `setCalibration()` 緊接 `await startBattle()`，而 `setScreen('battle')` 只是
 * 改 reactive 值——Vue 的卸載排在微任務，剛好落在 `startBattle()` 的
 * `await syncCameraAsync()` 之中。於是這個元件的 `restore()` 變成**開打前
 * 最後一個寫推論設定的人**，它那三行無條件的絕對值
 * （`setScale(restoreScale)`／`setEnabled('face', true)`／`setEnabled('object', true)`）
 * 會蓋掉 store 剛剛收斂好的結果：工作人員在設定面板關掉的手機偵測被打開、
 * 效能降檔關掉的 object track 被打開，而旗標還停在「沒在跑」。
 *
 * 修法不是「排在 store 後面」——那是把正確性押在 flush 順序上。改成這個元件
 * **只翻一個布林**，合成與還原由 inferenceService 用 store 寫進去的基準層去算。
 *
 * 這一組護欄裝在違規會發生的地方（Ruling DK）：一層看**行為**（元件對
 * inference 呼叫了什麼），一層看**原始碼**（那兩個 API 的名字不准再出現在
 * 這個檔案裡）。行為那層擋得住「又寫了絕對值」，原始碼那層連「換個名字繞路」
 * 都擋得住。
 */
describe('Blocking B1：校準畫面只翻疊加層，不寫任何絕對值', () => {
  it('開始校準 → 卸載：只有 setCalibrationBoost(true) 與 (false)，沒有任何 setScale／setEnabled', () => {
    const log = inferenceLog()
    const { el, app } = mount({ camera: {}, inference: stubInference(log), videoEl: null })

    el.querySelector('button').click() // 「開始校準」→ begin()
    expect(log.boost).toEqual([true])

    app.unmount() // onBeforeUnmount → restore()
    expect(log.boost, '卸載只是把疊加層拿掉，不決定「該還原成什麼」').toEqual([true, false])

    // 這兩條是全部的鑑別力所在。上一版在這兩個陣列裡會有 [3, 0.5] 與
    // [['face',false],['object',false],['face',true],['object',true]]。
    expect(log.scale, '倍率的唯一寫入者是 store').toEqual([])
    expect(log.enabled, 'track 的唯一寫入者是 store').toEqual([])

    el.remove()
  })

  it('取樣跑完（不卸載）也一樣：restore() 只拿掉疊加層', async () => {
    // 取樣成功結束時 loop() 會自己呼叫 restore()，那條路徑跟卸載是同一個函式，
    // 但走的是不同的呼叫者——兩條都要鎖，否則有人「只改卸載那條」就會漏掉。
    const log = inferenceLog()
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' }
    const inference = stubInference(log)
    inference.step = async () => null
    const { el, app } = mount({ camera: {}, inference, videoEl })

    el.querySelector('button').click()
    // 把 5 秒取樣視窗跳完：loop() 讀的是 performance.now()，這裡直接把時鐘往前推。
    const realNow = performance.now.bind(performance)
    const t0 = realNow()
    vi.spyOn(performance, 'now').mockImplementation(() => t0 + 6000)
    await driveFrame()
    performance.now.mockRestore()

    expect(log.boost.at(-1), '取樣結束也要把疊加層拿掉').toBe(false)
    expect(log.scale).toEqual([])
    expect(log.enabled).toEqual([])

    app.unmount()
    el.remove()
  })

  it('原始碼護欄：這個元件的程式碼裡不得出現 inference.setScale／inference.setEnabled', () => {
    const source = readFileSync(path.join(SRC_DIR, 'components', 'CalibrationWizard.vue'), 'utf8')
    // 只挖掉「整行都是註解」的行：上面那幾段說明會逐字提到這兩個 API，
    // 不挖掉就永遠是紅的。行尾附掛的註解不挖（會誤報，但誤報由人看一眼就好，
    // 漏報才是這條護欄不能有的東西）。
    const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
    expect(code, '校準畫面不得直接寫推論倍率（Blocking B1）').not.toContain('inference.setScale(')
    expect(code, '校準畫面不得直接開關 track（Blocking B1）').not.toContain('inference.setEnabled(')
  })
})

// ---------------------------------------------------------------------------
// 複審 I-1（Important）：屬性通道的隱私護欄沒有覆蓋校準畫面
// ---------------------------------------------------------------------------

/**
 * 背景：`App.mount.test.js:416` 起那組屬性通道護欄寫得很好，但它的覆蓋面是
 * battle / stats / task 三個畫面 ＋ App.vue 自己渲染的四個區塊。
 * `ThresholdLab.test.js` 有自己的 `innerHTML` 隱私護欄。
 * **`CalibrationWizard` 兩邊都不在**——而 `CalibrationWizard.vue` 的 `loop()`
 * 是全專案除了 ThresholdLab 之外**唯一**每幀直接拿到 `inference.step()` 原始
 * `r.metrics` 的地方，也就是原始身體量測值真正流過的那個點。
 *
 * 複審實測的攻擊（`:title="rawDiag"` ＋ `:data-diag="rawDiag"`，
 * `rawDiag.value = JSON.stringify(r.metrics)`）：**666/666 全綠**。
 * 這個檔案裡「隱私／canary／innerHTML／attributes」四個關鍵字一個都沒有。
 *
 * 這裡補兩層，跟 App.mount.test.js 同一個結構：
 *   1. **內容 canary**：餵進 metrics 的哨兵值不得出現在 `innerHTML`（含屬性值）。
 *      擋得住 `JSON.stringify(r.metrics)` 與「挑幾個欄位串起來」這兩種寫法。
 *   2. **屬性清單完全比對**：`.arena` 底下每一個節點的每一個屬性都必須在預期
 *      清單裡。這一層不需要事先知道攻擊者用哪個欄位——連「新增一個 ref 再掛
 *      上去」都擋得住，因為屬性本身就會讓清單對不上。
 *
 * 鎖不到什麼（誠實記錄）：jsdom 不跑 CSS，所以「用 CSS `content:` 帶動態值」
 * 這條路不在範圍內（這個專案沒有任何這種用法）；也鎖不到「把 metrics 送去
 * 別的地方」（那由 storageService 的白名單與 egressGuardrail 負責）。
 */
const METRICS_CANARIES = ['METRICS-CANARY', '0.987654321', '0.123456', '0.654321']

function poseStepWithCanary() {
  return {
    key: 'pose',
    metrics: {
      valid: true,
      neckRatio: 1.0,
      shoulderWidth: 0.3,
      // 原始角度／比值那一類數字、landmark 座標、以及一個純字串哨兵：
      // 三種形狀都放進來，攻擊者不管挑哪一個欄位往 DOM 送都會被抓到。
      rawAngle: 0.987654321,
      landmarks: [{ x: 0.123456, y: 0.654321 }],
      tag: 'METRICS-CANARY',
    },
  }
}

function samplingInference(stepResult) {
  return {
    setScale() {},
    setEnabled() {},
    setCalibrationBoost() {},
    step: async () => stepResult.value,
    actualFps: () => 0,
  }
}

function attrInventory(root) {
  const out = []
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of node.attributes) {
      // Vue 的 scoped style 標記（data-v-<hash>，值恆為空字串）不列入：那個
      // hash 由 SFC 內容決定，改一行註解就會變。**只**在值是空字串時跳過——
      // 真的有人寫 `:data-v-x="secret"` 的話值就不是空的，照樣會被逮到。
      if (/^data-v-[0-9a-f]+$/.test(attr.name) && attr.value === '') continue
      out.push(`${node.tagName.toLowerCase()}[${attr.name}="${attr.value}"]`)
    }
  }
  return out.sort()
}

function mountSampling() {
  const videoEl = document.createElement('video')
  videoEl.srcObject = { fake: 'stream' }
  const stepResult = { value: null }
  const { el, app } = mount({ camera: {}, inference: samplingInference(stepResult), videoEl })
  el.querySelector('button').click() // 「開始校準」→ sampling = true，loop() 排進 rAF
  return { el, app, stepResult }
}

describe('CalibrationWizard 隱私護欄（複審 I-1：每幀拿到原始 r.metrics 的唯一另一個元件）', () => {
  it('餵進 loop() 的原始 metrics 哨兵值不得出現在 DOM（含所有屬性值）', async () => {
    const { el, app, stepResult } = mountSampling()
    stepResult.value = poseStepWithCanary()

    await driveFrame()
    await driveFrame() // 兩幀：確認不是只有第一幀剛好還沒渲染

    // 先證明這幀真的被消化了，否則「沒洩漏」只是因為 loop() 根本沒跑
    // ——那會是 Ruling CH 說的那種綠得沒有理由的測試。
    expect(el.querySelector('.frame').className, 'collected > 0 才會加上 good').toContain('good')

    for (const canary of METRICS_CANARIES) {
      expect(el.innerHTML, `隱私紅線：DOM（含屬性值）不得出現 ${canary}`).not.toContain(canary)
    }

    app.unmount()
    el.remove()
  })

  it('取樣中的每一個屬性都必須是預期中的靜態值（屬性通道：複審用 :title／:data-diag 攻過這裡）', async () => {
    const { el, app, stepResult } = mountSampling()
    stepResult.value = poseStepWithCanary()
    await driveFrame()

    expect(attrInventory(el.querySelector('.arena'))).toEqual([
      // 骨架線疊加層（PoseSkeletonOverlay.vue）。它是全專案唯一拿得到原始
      // landmark 座標的畫面元件，所以**它的屬性清單特別要緊**：這兩筆是它
      // 全部的屬性，都是靜態字面值，沒有任何一個是繫結的。
      // 任何人日後在那個 <canvas> 上掛 :title / :data-* 把座標帶出去，
      // 這條完全相等比對會當場紅——這正是複審用 :title／:data-diag 攻過的
      // 那條路，疊加層不得成為它的新入口。
      // （像素本身不在 DOM 字串裡，這一層擋的是屬性通道。）
      'canvas[aria-hidden="true"]',
      'canvas[class="skeleton"]',
      'div[class="arena"]',
      'div[class="arena__boss guide"]',
      'div[class="arena__hero"]',
      'div[class="frame good"]',
      // frameRect 的 letterbox 對齊計算（見 <script> 檔頭註解）——jsdom 量不到
      // 真實 layout（clientWidth/clientHeight 恆為 0），這裡看到的是初始
      // fallback 值，外觀等同原本寫死的 inset:12% 18%，不是新洩漏的資料。
      'div[style="left: 18%; top: 12%; width: 64%; height: 76%;"]',
      'ol[class="how"]',
      'p[aria-live="polite"]',
      'p[class="countdown"]',
      // 實機驗收加的：少了 autoplay，這個鏡像 <video> 在 iOS Safari 上永遠是
      // paused，校準畫面左半邊整片空白（家族護欄見 videoMirror.guardrail.test.js）。
      // 它出現在這份清單裡不是意外——這條護欄是「完全相等比對」，新屬性一律
      // 要被有意識地核准過，才不會有人順手掛一個 :title 把 metrics 帶出去。
      'video[autoplay=""]',
      'video[class="cam"]',
      'video[playsinline=""]',
    ])

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// 骨架線疊加層（PoseSkeletonOverlay）
//
// 校準畫面是這個功能最有價值的地方：這個畫面正要求小孩「照著指示坐好」，
// 而在此之前他完全沒有任何回饋可以知道自己有沒有被看見。
//
// 它同時也是隱私上最需要盯著的地方——這個元件本來就是全專案除了 ThresholdLab
// 之外唯一每幀直接拿到 `inference.step()` 原始 `r.metrics` 的地方（複審 I-1），
// 現在它旁邊又多了一條真的帶著**原始座標**的通道。上面那兩條既有的護欄
// （內容 canary、屬性清單完全比對）必須在多了這條通道之後仍然有效，
// 這裡再補一條直接餵座標的。
// ---------------------------------------------------------------------------
describe('CalibrationWizard 骨架線疊加層', () => {
  const drawn = { strokes: 0 }
  function stubCanvas() {
    drawn.strokes = 0
    window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      lineWidth: 0, lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '',
      clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
      stroke() { drawn.strokes += 1 },
    }))
  }

  const COORD_CANARIES = ['0.123456', '0.654321', '0.222222', '0.777777', '0.888888', '0.111111']

  function landmarksWithCanary() {
    const pts = []
    for (let i = 0; i < 33; i += 1) pts.push({ x: 0.5, y: 0.5, visibility: 0.9 })
    pts[7] = { x: 0.123456, y: 0.222222, visibility: 0.9 }
    pts[8] = { x: 0.654321, y: 0.222222, visibility: 0.9 }
    pts[11] = { x: 0.111111, y: 0.777777, visibility: 0.9 }
    pts[12] = { x: 0.888888, y: 0.777777, visibility: 0.9 }
    return pts
  }

  function observableInference() {
    const observers = []
    return {
      observers,
      setScale() {}, setEnabled() {}, setCalibrationBoost() {},
      step: async () => null,
      actualFps: () => 0,
      onPoseFrame(fn) {
        observers.push(fn)
        return () => {
          const i = observers.indexOf(fn)
          if (i !== -1) observers.splice(i, 1)
        }
      },
    }
  }

  it('掛載時訂閱一次，卸載時解除', async () => {
    stubCanvas()
    const inference = observableInference()
    const { el, app } = mount({ camera: {}, inference, videoEl: null })
    await nextTick()

    expect(inference.observers.length).toBe(1)
    app.unmount()
    expect(inference.observers.length, '卸載後還留著訂閱＝推論每幀呼叫一個不存在的畫面').toBe(0)
    el.remove()
  })

  it('推一幀帶哨兵座標的 landmarks 之後，校準畫面的 DOM 不得出現任何座標值', async () => {
    stubCanvas()
    const inference = observableInference()
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' }
    const { el, app } = mount({ camera: {}, inference, videoEl })
    await nextTick()

    inference.observers[0](landmarksWithCanary())
    await nextTick()

    expect(drawn.strokes, '這一幀應該真的畫了線（否則這條測試綠得沒有理由）').toBe(1)
    for (const canary of COORD_CANARIES) {
      expect(el.innerHTML, `隱私紅線：DOM（含屬性值）不得出現座標 ${canary}`).not.toContain(canary)
    }

    app.unmount()
    el.remove()
  })

  it('即使畫過一幀，.arena 底下的屬性清單一個字都沒變', async () => {
    // 上面那條屬性清單護欄是在「還沒畫過」的狀態下驗的。座標真的流過一次
    // 之後屬性清單仍然完全相同——這一條驗的是那件事，而不是「載入時長怎樣」。
    stubCanvas()
    const inference = observableInference()
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' }
    const { el, app } = mount({ camera: {}, inference, videoEl })
    inference.observers[0](landmarksWithCanary())
    await nextTick()

    expect(attrInventory(el.querySelector('.arena'))).toEqual([
      'button[class="primary go"]',
      'canvas[aria-hidden="true"]',
      'canvas[class="skeleton"]',
      'div[class="arena"]',
      'div[class="arena__boss guide"]',
      'div[class="arena__hero"]',
      'div[class="frame"]',
      'div[style="left: 18%; top: 12%; width: 64%; height: 76%;"]',
      'ol[class="how"]',
      'p[class="hint"]',
      'video[autoplay=""]',
      'video[class="cam"]',
      'video[playsinline=""]',
    ])

    app.unmount()
    el.remove()
  })

  it('這個元件自己不得碰座標：它只把 props.inference 交給疊加層', () => {
    const source = readFileSync(path.join(SRC_DIR, 'components', 'CalibrationWizard.vue'), 'utf8')
    const code = blankPureCommentLines(stripHtmlCommentSpans(source))
    expect(code, '校準畫面不得自己訂閱 pose 影格').not.toContain('onPoseFrame')
    expect(code, '校準畫面不得出現 landmark 字樣').not.toMatch(/landmark/i)
  })
})

// ---------------------------------------------------------------------------
// 對齊框（.frame）letterbox 對齊。
//
// 實機驗收回報的 bug（使用者原話：「現在畫的外框和顯示的方向不相同」）：
// 舊寫法用容器的固定百分比 inset:12% 18% 畫框，但 .arena__hero 這個容器的
// 長寬比會隨 iPad 直橫翻轉，相機串流的原生長寬比不會跟著轉，object-fit:
// contain 的留白（letterbox）位置因此在兩個方向下不一樣，框卻永遠用同一組
// 固定比例——只有其中一個方向會剛好對到影像。
//
// 這裡鎖的是 frameRect 那組公式本身（跟 PoseSkeletonOverlay.vue 的 contain
// 公式對齊），不是「畫面好不好看」——後者只能靠真機肉眼驗收。
// ---------------------------------------------------------------------------
describe('CalibrationWizard 對齊框：letterbox 對齊計算', () => {
  it('容器與影片原生長寬比不同時，框收在「實際顯示影像」的矩形內，不是收在整個容器裡', async () => {
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' }
    const { el, app } = mount({ camera: {}, inference: stubInference(), videoEl })
    await nextTick()

    const host = el.querySelector('.arena__hero')
    const localVideoEl = el.querySelector('video.cam')
    // 容器 640×800（瘦高，模擬其中一個 orientation 下的 .arena__hero），
    // 影片原生 640×480（4:3 相機）。
    Object.defineProperty(host, 'clientWidth', { value: 640, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true })
    Object.defineProperty(localVideoEl, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(localVideoEl, 'videoHeight', { value: 480, configurable: true })
    localVideoEl.dispatchEvent(new Event('loadedmetadata'))
    await nextTick()

    // 手算（跟程式碼各自獨立算一次，不是抄同一行公式）：
    // k = min(640/640, 800/480) = min(1, 1.667) = 1（contain 取較小值）
    // sx=640, sy=480, ox=(640-640)/2=0, oy=(800-480)/2=160
    // insetX = sx*0.18 = 115.2, insetY = sy*0.12 = 57.6
    const frame = el.querySelector('.frame')
    expect(parseFloat(frame.style.left)).toBeCloseTo(0 + 115.2, 5)
    expect(parseFloat(frame.style.top)).toBeCloseTo(160 + 57.6, 5)
    expect(parseFloat(frame.style.width)).toBeCloseTo(640 - 115.2 * 2, 5)
    expect(parseFloat(frame.style.height)).toBeCloseTo(480 - 57.6 * 2, 5)

    app.unmount()
    el.remove()
  })

  it('容器長寬比改變（模擬 iPad 轉向）：框跟著重新對齊，不是維持轉向前的舊值——這正是原本回報的 bug', async () => {
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' }
    const { el, app } = mount({ camera: {}, inference: stubInference(), videoEl })
    await nextTick()

    const host = el.querySelector('.arena__hero')
    const localVideoEl = el.querySelector('video.cam')
    Object.defineProperty(localVideoEl, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(localVideoEl, 'videoHeight', { value: 480, configurable: true })

    Object.defineProperty(host, 'clientWidth', { value: 640, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true })
    localVideoEl.dispatchEvent(new Event('loadedmetadata'))
    await nextTick()
    const beforeRect = { ...el.querySelector('.frame').style }
    const beforeLeft = parseFloat(el.querySelector('.frame').style.left)
    const beforeTop = parseFloat(el.querySelector('.frame').style.top)

    // 模擬旋轉：容器換成矮胖形狀（另一個 orientation 下的 .arena__hero）
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true })
    localVideoEl.dispatchEvent(new Event('loadedmetadata'))
    await nextTick()
    const afterLeft = parseFloat(el.querySelector('.frame').style.left)
    const afterTop = parseFloat(el.querySelector('.frame').style.top)

    expect(
      afterLeft !== beforeLeft || afterTop !== beforeTop,
      `容器形狀換了，框必須重新對齊，不能維持舊值（before=${JSON.stringify(beforeRect)}）`,
    ).toBe(true)

    app.unmount()
    el.remove()
  })

  it('量不到容器尺寸時（jsdom 常態）維持初始 fallback，不會因為除以 0 而炸掉或畫出 NaN', async () => {
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' }
    const { el, app } = mount({ camera: {}, inference: stubInference(), videoEl })
    await nextTick()

    const localVideoEl = el.querySelector('video.cam')
    Object.defineProperty(localVideoEl, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(localVideoEl, 'videoHeight', { value: 480, configurable: true })
    // 刻意不設 host 的 clientWidth/clientHeight：jsdom 預設就是 0，這是
    // 真實測試環境下每一條既有測試原本就在跑的狀態。
    localVideoEl.dispatchEvent(new Event('loadedmetadata'))
    await nextTick()

    const frame = el.querySelector('.frame')
    expect(frame.style.left).not.toContain('NaN')
    expect(frame.style.width).not.toContain('NaN')
    expect(frame.style.left).toBe('18%')
    expect(frame.style.width).toBe('64%')

    app.unmount()
    el.remove()
  })
})
