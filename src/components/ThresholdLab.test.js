// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import ThresholdLab from './ThresholdLab.vue'
import thresholdLabSource from './ThresholdLab.vue?raw'

// 手動控制的 rAF：不讓迴圈自己跑，改由測試逐幀 driveFrame()（同
// src/stores/session.test.js 的作法）。
let pendingFrame = null
vi.stubGlobal('requestAnimationFrame', (cb) => { pendingFrame = cb; return 1 })
vi.stubGlobal('cancelAnimationFrame', () => { pendingFrame = null })

async function driveFrame() {
  const cb = pendingFrame
  pendingFrame = null
  if (cb) await cb(performance.now())
  await nextTick()
}

function stubInference(stepResult) {
  return {
    step: async () => (typeof stepResult.value === 'function' ? stepResult.value() : stepResult.value),
    actualFps: () => 0,
  }
}

function poseMetrics(neckRatio, shoulderWidth, extra = {}) {
  return { key: 'pose', metrics: { valid: true, neckRatio, shoulderWidth, ...extra } }
}

// 複審第 1 輪 I-2：inference.step() 第一次呼叫丟一個帶 message/stack 的例外，
// 之後恢復正常回傳 afterValue——用來驗證 loop() 的 try/catch 真的接住例外、
// 沒有讓 rAF 鏈斷掉，而且畫面上只留 error.name，不留 message/stack。
function stubInferenceThrowOnce(errorName, errorMessage, afterValue) {
  let thrown = false
  return {
    step: async () => {
      if (!thrown) {
        thrown = true
        const e = new Error(errorMessage)
        e.name = errorName
        throw e
      }
      return afterValue
    },
    actualFps: () => 0,
  }
}

function mount(props) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(ThresholdLab, props)
  app.mount(el)
  return { el, app }
}

async function feedFrames(n, stepResult, value) {
  stepResult.value = value
  for (let i = 0; i < n; i++) await driveFrame()
}

describe('ThresholdLab', () => {
  beforeEach(() => {
    pendingFrame = null
  })

  it('按「坐正取樣」後餵 N 筆 valid pose metrics，good 計數變成 N', async () => {
    const stepResult = { value: null }
    const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

    el.querySelector('[data-testid="btn-good"]').click()
    await feedFrames(5, stepResult, poseMetrics(1.0, 0.3))

    expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('5')
    expect(el.querySelector('[data-testid="bad-count"]').textContent).toBe('0')

    app.unmount()
    el.remove()
  })

  it('切到「駝背取樣」後餵資料，good 計數不再增加、bad 增加', async () => {
    const stepResult = { value: null }
    const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

    el.querySelector('[data-testid="btn-good"]').click()
    await feedFrames(3, stepResult, poseMetrics(1.0, 0.3))
    expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('3')

    el.querySelector('[data-testid="btn-bad"]').click()
    await feedFrames(4, stepResult, poseMetrics(0.8, 0.36))

    expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('3')
    expect(el.querySelector('[data-testid="bad-count"]').textContent).toBe('4')

    app.unmount()
    el.remove()
  })

  it('再按一次同一顆取樣鈕會停止取樣（aria-pressed 回到 false，之後餵資料計數不再變）', async () => {
    const stepResult = { value: null }
    const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

    const goodBtn = el.querySelector('[data-testid="btn-good"]')
    goodBtn.click()
    await nextTick()
    expect(goodBtn.getAttribute('aria-pressed')).toBe('true')

    goodBtn.click()
    await nextTick()
    expect(goodBtn.getAttribute('aria-pressed')).toBe('false')

    await feedFrames(3, stepResult, poseMetrics(1.0, 0.3))
    expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('0')

    app.unmount()
    el.remove()
  })

  it('兩組各餵足 minSamples、分佈分得開 → 產生結果後出現 neckDropRatio 建議值', async () => {
    const stepResult = { value: null }
    const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

    el.querySelector('[data-testid="btn-good"]').click()
    await feedFrames(12, stepResult, poseMetrics(1.0, 0.3))
    el.querySelector('[data-testid="btn-bad"]').click()
    await feedFrames(12, stepResult, poseMetrics(0.8, 0.36))

    el.querySelectorAll('.actions button')[0].click() // 產生結果
    await nextTick()

    const suggestion = el.querySelector('[data-testid="suggestion-neckDropRatio"]')
    expect(suggestion).not.toBeNull()
    expect(suggestion.querySelector('[data-testid="value"]')).not.toBeNull()
    expect(suggestion.textContent).toContain('成立')

    app.unmount()
    el.remove()
  })

  it('兩組資料重疊分不開 → 不顯示任何建議值，且顯示「不要硬填數字」', async () => {
    const stepResult = { value: null }
    const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

    el.querySelector('[data-testid="btn-good"]').click()
    await feedFrames(12, stepResult, poseMetrics(1.0, 0.3))
    el.querySelector('[data-testid="btn-bad"]').click()
    await feedFrames(12, stepResult, poseMetrics(0.99, 0.302))

    el.querySelectorAll('.actions button')[0].click() // 產生結果
    await nextTick()

    const suggestion = el.querySelector('[data-testid="suggestion-neckDropRatio"]')
    expect(suggestion.querySelector('[data-testid="value"]')).toBeNull()
    expect(suggestion.textContent).toContain('不要硬填數字')

    app.unmount()
    el.remove()
  })

  it('隱私護欄：metrics 帶額外欄位（landmarks 座標）不會出現在 DOM 裡', async () => {
    const stepResult = { value: null }
    const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

    el.querySelector('[data-testid="btn-good"]').click()
    await feedFrames(1, stepResult, poseMetrics(1.0, 0.3, { landmarks: [{ x: 0.123456, y: 0.654321 }] }))

    expect(el.innerHTML).not.toContain('0.123456')
    expect(el.innerHTML).not.toContain('0.654321')

    app.unmount()
    el.remove()
  })

  it('重新量測會清空計數與畫面上的 report', async () => {
    const stepResult = { value: null }
    const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

    el.querySelector('[data-testid="btn-good"]').click()
    await feedFrames(12, stepResult, poseMetrics(1.0, 0.3))
    el.querySelectorAll('.actions button')[0].click() // 產生結果
    await nextTick()
    expect(el.querySelector('[data-testid="report"]')).not.toBeNull()

    el.querySelectorAll('.actions button')[1].click() // 重新量測
    await nextTick()

    expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('0')
    expect(el.querySelector('[data-testid="report"]')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('關閉按鈕會 emit close', async () => {
    const stepResult = { value: null }
    const el = document.createElement('div')
    document.body.appendChild(el)
    let closed = false
    const Host = {
      components: { ThresholdLab },
      template: '<ThresholdLab :camera="{}" :inference="inference" :video-el="null" @close="onClose" />',
      setup() {
        return { inference: stubInference(stepResult), onClose: () => { closed = true } }
      },
    }
    const app = createApp(Host)
    app.mount(el)

    el.querySelectorAll('.actions button')[2].click() // 關閉
    expect(closed).toBe(true)

    app.unmount()
    el.remove()
  })

  it('onBeforeUnmount 後不再有新的樣本進來：卸載發生在 step() 還沒 resolve 的那個 microtask 間隙時，不再排下一幀', async () => {
    // 這一條刻意重現 loop() 檔頭註解講的那個競態窗口：await 到下一次
    // requestAnimationFrame 之間至少有一個 microtask 間隙，卸載可能剛好落在
    // 這裡。如果只是「先呼叫 cancelAnimationFrame(rafId) 就收工」，測起來會
    // 是假綠——此時 rafId 指的是『這一幀』已經消耗掉的舊 id，取消它什麼也
    // 沒擋到，真正擋下重新排程的是 loop() resume 後那個 `if (!alive) return`。
    // 所以這裡用一個手動控制的 deferred promise 卡住 step()，在它 resolve
    // 之前就呼叫 app.unmount()，逼真正跑到那個窗口。
    let resolveStep = null
    const inference = {
      step: () => new Promise((resolve) => { resolveStep = resolve }),
      actualFps: () => 0,
    }
    const { el, app } = mount({ camera: {}, inference, videoEl: null })

    el.querySelector('[data-testid="btn-good"]').click()

    // 觸發 onMounted 排好的第一幀：loop() 開始執行，卡在 `await inference.step(now)`。
    const cb = pendingFrame
    pendingFrame = null
    const loopPromise = cb(performance.now())

    // 卸載發生在 step() 還沒 resolve 的當下——這正是 alive 旗標要防的窗口。
    app.unmount()

    // 現在才讓 step() resolve，帶一筆有效 pose 資料。若 alive 檢查被拿掉，
    // loop() 會繼續 push 樣本並呼叫 requestAnimationFrame 排下一幀。
    resolveStep(poseMetrics(1.0, 0.3))
    await loopPromise

    // 直接可觀察的事實（DOM 已經被 unmount 拔掉，不能再讀畫面）：
    // 沒有排下一幀，代表 loop() 在 resume 後真的因為 alive===false 提前返回。
    expect(pendingFrame).toBeNull()

    el.remove()
  })

  describe('複審第 1 輪 I-2：inference.step() 丟例外時的兜底', () => {
    it('丟一次例外後迴圈沒有斷掉，之後還能繼續收到樣本', async () => {
      const inference = stubInferenceThrowOnce('TypeError', 'boom - 不該出現在畫面上的內部訊息', poseMetrics(1.0, 0.3))
      const { el, app } = mount({ camera: {}, inference, videoEl: null })

      el.querySelector('[data-testid="btn-good"]').click()
      await driveFrame() // 第一幀：step() 丟例外，被 catch 住
      await driveFrame() // 第二幀：step() 恢復正常，回傳有效 pose metrics

      expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('1')

      app.unmount()
      el.remove()
    })

    it('畫面上會顯示錯誤名稱（error.name）', async () => {
      const inference = stubInferenceThrowOnce('TypeError', 'boom - 不該出現在畫面上的內部訊息', poseMetrics(1.0, 0.3))
      const { el, app } = mount({ camera: {}, inference, videoEl: null })

      el.querySelector('[data-testid="btn-good"]').click()
      await driveFrame() // 第一幀：step() 丟例外

      const errorEl = el.querySelector('[data-testid="step-error"]')
      expect(errorEl).not.toBeNull()
      expect(errorEl.textContent).toContain('TypeError')

      app.unmount()
      el.remove()
    })

    it('step() 持續丟例外時，「迴圈影格」照樣在動——迴圈活著跟迴圈斷掉必須分得開', async () => {
      const inference = {
        step: async () => { throw new TypeError('boom') },
        actualFps: () => 0,
      }
      const { el, app } = mount({ camera: {}, inference, videoEl: null })

      await driveFrame()
      await driveFrame()
      await driveFrame()

      // 迴圈影格只在成功路徑上數的話，這裡會是 0.0，跟「rAF 鏈整條斷掉」
      // 長得一模一樣——那正是這個指示燈要分開的兩件事。
      expect(el.querySelector('[data-testid="live-loop"]').textContent).toBe('1.0')
      expect(el.querySelector('[data-testid="live-pose"]').textContent).toBe('0.0')

      app.unmount()
      el.remove()
    })

    it('隱私護欄：DOM 裡不含例外的 message 或 stack 內容，只留 error.name', async () => {
      const sensitiveMessage = 'boom - 不該出現在畫面上的內部訊息'
      const inference = stubInferenceThrowOnce('TypeError', sensitiveMessage, poseMetrics(1.0, 0.3))
      const { el, app } = mount({ camera: {}, inference, videoEl: null })

      el.querySelector('[data-testid="btn-good"]').click()
      await driveFrame() // 第一幀：step() 丟例外

      expect(el.innerHTML).not.toContain(sensitiveMessage)

      app.unmount()
      el.remove()
    })
  })

  // ---------------------------------------------------------------------------
  // feat/diag：即時量測狀態。
  //
  // 使用者回報「按了坐正取樣，計數卻不動」。在只有兩個計數的畫面上，至少五種
  // 原因看起來一模一樣，而修法完全不同。這一組測試逐一釘住「每一種原因都要
  // 對應到一個看得出來的、不一樣的畫面」——一條也不能少，少掉任何一條，那個
  // 原因就又變回「數字不動」這個無法診斷的黑盒。
  //
  // 鎖得到什麼：五個指示燈各自在對應的失敗情境下真的變成 0（或「否」／0×0），
  // 而且在正常情境下不是 0（不能是永遠顯示同一個數字的裝飾）。
  // 鎖不到什麼：真機上 MediaPipe 實際回什麼、3 秒窗口在真實 rAF 節奏下的讀數
  // 好不好讀——那些只能靠真機驗收。
  // ---------------------------------------------------------------------------
  describe('即時量測狀態：五種「計數不動」的原因要分得開', () => {
    it('一切正常時，迴圈／姿態／有效三個速率都有數字（3 秒窗口、餵 3 幀＝1.0/秒）', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(3, stepResult, poseMetrics(1.0, 0.3))

      expect(el.querySelector('[data-testid="live-loop"]').textContent).toBe('1.0')
      expect(el.querySelector('[data-testid="live-pose"]').textContent).toBe('1.0')
      expect(el.querySelector('[data-testid="live-valid"]').textContent).toBe('1.0')

      app.unmount()
      el.remove()
    })

    it('三個速率跟取樣鈕無關：一顆鈕都沒按，照樣在動（這是它跟計數的差別）', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(3, stepResult, poseMetrics(1.0, 0.3))

      expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('0')
      expect(el.querySelector('[data-testid="live-valid"]').textContent).toBe('1.0')

      app.unmount()
      el.remove()
    })

    it('原因 4（pose 沒有被排到）：step() 一直回 null → 迴圈在動、姿態結果是 0', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(3, stepResult, null)

      expect(el.querySelector('[data-testid="live-loop"]').textContent).toBe('1.0')
      expect(el.querySelector('[data-testid="live-pose"]').textContent).toBe('0.0')
      expect(el.querySelector('[data-testid="live-valid"]').textContent).toBe('0.0')

      app.unmount()
      el.remove()
    })

    it('原因 5（人沒被偵測到）：pose 有回但 valid 是 false → 姿態結果在動、有效姿態是 0', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      el.querySelector('[data-testid="btn-good"]').click()
      await feedFrames(3, stepResult, { key: 'pose', metrics: { valid: false, neckRatio: 1.0, shoulderWidth: 0.3 } })

      // 這一條是整組的重點：按了鈕、計數卻是 0，而畫面明確指出原因是
      // 「pose 有在跑，但畫面裡沒有人」，不是「按鈕壞了」。
      expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('0')
      expect(el.querySelector('[data-testid="live-pose"]').textContent).toBe('1.0')
      expect(el.querySelector('[data-testid="live-valid"]').textContent).toBe('0.0')

      app.unmount()
      el.remove()
    })

    it('原因 3（影像還沒送進來）：videoEl 的 videoWidth 是 0 時顯示 0×0', async () => {
      const stepResult = { value: null }
      const videoEl = { videoWidth: 0, videoHeight: 0 }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl })

      await feedFrames(1, stepResult, null)
      expect(el.querySelector('[data-testid="live-frame"]').textContent).toBe('0×0')

      app.unmount()
      el.remove()
    })

    it('影像有送進來時顯示實際的擷取尺寸（不能是寫死的字串）', async () => {
      const stepResult = { value: null }
      const videoEl = { videoWidth: 640, videoHeight: 480 }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl })

      await feedFrames(1, stepResult, null)
      expect(el.querySelector('[data-testid="live-frame"]').textContent).toBe('640×480')

      app.unmount()
      el.remove()
    })

    it('原因 2（模型還沒載好）：inference.isReady() 回 false 時顯示「否」', async () => {
      const stepResult = { value: null }
      const inference = { ...stubInference(stepResult), isReady: () => false }
      const { el, app } = mount({ camera: {}, inference, videoEl: null })

      await feedFrames(1, stepResult, null)
      expect(el.querySelector('[data-testid="live-ready"]').textContent).toBe('否')

      app.unmount()
      el.remove()
    })

    it('模型載好時顯示「是」（不能是永遠顯示「否」的裝飾）', async () => {
      const stepResult = { value: null }
      const inference = { ...stubInference(stepResult), isReady: () => true }
      const { el, app } = mount({ camera: {}, inference, videoEl: null })

      await feedFrames(1, stepResult, null)
      expect(el.querySelector('[data-testid="live-ready"]').textContent).toBe('是')

      app.unmount()
      el.remove()
    })

    it('呼叫端沒有提供 isReady 時不會炸掉，顯示「否」', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(1, stepResult, null)
      expect(el.querySelector('[data-testid="live-ready"]').textContent).toBe('否')

      app.unmount()
      el.remove()
    })

    it('隱私護欄：即時狀態只用到 metrics.valid，neckRatio／shoulderWidth 的數值不進 DOM', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      // 刻意不按任何取樣鈕：走的是「只有即時狀態在讀 metrics」這條路徑。
      await feedFrames(3, stepResult, poseMetrics(0.987654, 0.345678))

      expect(el.innerHTML.length, 'innerHTML 是空的，下面的斷言會恆真').toBeGreaterThan(0)
      expect(el.innerHTML).not.toContain('0.987654')
      expect(el.innerHTML).not.toContain('0.345678')

      app.unmount()
      el.remove()
    })
  })

  // ---------------------------------------------------------------------------
  // feat/diag 追加：物品偵測的即時回饋。
  //
  // 使用者的抱怨是「只有一個按鈕，沒有畫面出來，也沒有辦法測說實際上有沒有
  // 偵測到」。設定面板上的開關給不出即時回饋（那個畫面上鏡頭是關著的），
  // 這個畫面是全 App 唯一鏡頭開著又能顯示結果的地方，而 object 的結果本來
  // 就已經流過 loop() 了。
  //
  // 鎖得到什麼：三態（尚無資料／有東西／沒有東西）各自對應到正確的輸入、
  // 狀態會跟著最新一筆翻回來、累計取樣數會遞增、以及 phoneVisible 以外的
  // 任何欄位都進不了 DOM。
  // 鎖不到什麼：真機上 efficientdet_lite0 到底有沒有認出手機、面積與分數
  // 兩個門檻該設多少——那正是這一列要幫下一輪真機測試回答的問題。
  // ---------------------------------------------------------------------------
  describe('物品偵測的即時回饋：把手機舉到鏡頭前要當場看得到變化', () => {
    const objectResult = (phoneVisible, extra = {}) => ({
      key: 'object',
      metrics: { phoneVisible, ...extra },
    })

    it('偵測到不該出現的東西時顯示「有東西」', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(1, stepResult, objectResult(true))
      expect(el.querySelector('[data-testid="live-object"]').textContent).toBe('有東西')

      app.unmount()
      el.remove()
    })

    it('有跑但沒偵測到時顯示「沒有東西」', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(1, stepResult, objectResult(false))
      expect(el.querySelector('[data-testid="live-object"]').textContent).toBe('沒有東西')

      app.unmount()
      el.remove()
    })

    it('一筆 object 結果都還沒收到時顯示「尚無資料」，不是「沒有東西」', async () => {
      // 這一條是整組最重要的：預設值如果是 false，「object track 根本沒在跑」
      // 會偽裝成「跑了但沒偵測到」——那是這整個工項要消滅的那種黑盒，而且
      // 會讓下一輪真機測試把「鏈路斷了」誤判成「門檻太嚴」。
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(5, stepResult, poseMetrics(1.0, 0.3))

      expect(el.querySelector('[data-testid="live-object"]').textContent).toBe('尚無資料')
      expect(el.querySelector('[data-testid="live-object-samples"]').textContent).toBe('0')

      app.unmount()
      el.remove()
    })

    it('狀態跟著最新一筆走：偵測到之後東西拿開，會變回「沒有東西」', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(1, stepResult, objectResult(true))
      expect(el.querySelector('[data-testid="live-object"]').textContent).toBe('有東西')

      await feedFrames(1, stepResult, objectResult(false))
      expect(el.querySelector('[data-testid="live-object"]').textContent).toBe('沒有東西')

      app.unmount()
      el.remove()
    })

    it('累計取樣數每收到一筆 object 結果加一（0 就是那條 track 沒在跑）', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(3, stepResult, objectResult(false))
      expect(el.querySelector('[data-testid="live-object-samples"]').textContent).toBe('3')

      app.unmount()
      el.remove()
    })

    it('object 的結果不影響姿態取樣：計數與有效姿態都不會被它推動', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      el.querySelector('[data-testid="btn-good"]').click()
      await feedFrames(3, stepResult, objectResult(true))

      expect(el.querySelector('[data-testid="good-count"]').textContent).toBe('0')
      expect(el.querySelector('[data-testid="live-valid"]').textContent).toBe('0.0')

      app.unmount()
      el.remove()
    })

    it('隱私護欄：object metrics 即使多帶類別名稱與信心分數，也進不了 DOM 的任何角落', async () => {
      const stepResult = { value: null }
      const { el, app } = mount({ camera: {}, inference: stubInference(stepResult), videoEl: null })

      await feedFrames(1, stepResult, objectResult(true, {
        categoryName: 'cell phone',
        score: 0.8271,
        boundingBox: { originX: 11, originY: 22, width: 133, height: 244 },
      }))

      const html = el.innerHTML
      expect(html.length, 'innerHTML 是空的，下面的斷言會恆真').toBeGreaterThan(0)
      // 自我檢查要鎖在**那一列本身**，不能用 innerHTML.toContain('有東西')：
      // 底下的操作說明裡也有「有東西」三個字，拿 innerHTML 查子字串的話，
      // 就算這一列整個沒渲染出來，這條自我檢查照樣會過，下面四條
      // not.toContain 就變成在空狀態上恆真（實測突變確認過會這樣）。
      expect(el.querySelector('[data-testid="live-object"]').textContent).toBe('有東西')
      expect(html).not.toContain('cell phone')
      expect(html).not.toContain('0.8271')
      expect(html).not.toContain('boundingBox')
      expect(html).not.toContain('133')

      app.unmount()
      el.remove()
    })
  })
})

// ---------------------------------------------------------------------------
// Important 4（版面／可及性複審）：ThresholdLab 是唯一一個沒有跟進
// safe-area padding 慣例的頂層畫面。jsdom 不解析 `env()`，斷言
// getComputedStyle(el).paddingTop 之類的東西讀不到任何有意義的值——這裡改
// 成鎖原始碼文字本身：`.threshold-lab` 的 CSS 規則必須四個方向都用
// `env(safe-area-inset-*)`，不能只補一邊或維持固定 padding。
//
// 這條鎖得到：四個 safe-area-inset 關鍵字都出現在這條規則裡（原始碼文字）。
// 這條鎖不到：`max(var(--gap), env(...))` 這個算式在真機上算出來的實際
// padding 值對不對、iOS Safari 是否正確解析這個 CSS 函式——那些只能真機
// 驗證。
// ---------------------------------------------------------------------------

describe('Important 4（版面／可及性複審）：.threshold-lab 必須套用四個方向的 safe-area padding', () => {
  it('.threshold-lab 的 CSS 規則同時引用 top/right/bottom/left 四個 safe-area-inset', () => {
    const styleMatch = thresholdLabSource.match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)
    expect(styleMatch, '找不到 ThresholdLab.vue 的 <style scoped>').not.toBeNull()
    const styleText = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '')

    const ruleMatch = styleText.match(/(?:^|\})\s*\.threshold-lab\s*\{([^}]*)\}/)
    expect(ruleMatch, '找不到 .threshold-lab 自己的 CSS 規則').not.toBeNull()
    const ruleBody = ruleMatch[1]

    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(ruleBody, `.threshold-lab 缺少 env(safe-area-inset-${side})`).toContain(`env(safe-area-inset-${side})`)
    }
  })
})
