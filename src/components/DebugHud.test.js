// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createApp } from 'vue'
import DebugHud from './DebugHud.vue'
import debugHudSource from './DebugHud.vue?raw'

function baseStats(overrides = {}) {
  return {
    latencyEma: 42.6, latencyP95: 88.2,
    fpsPose: 1.98, fpsFace: 2.97, fpsObject: 0.33,
    rafP95: 16.7, rafMax: 33.2,
    sessionSec: 125.4, rounds: 3,
    perfMode: false, objectOn: true,
    poseFailures: 0, poseErrorName: null,
    faceFailures: 0, faceErrorName: null,
    objectFailures: 0, objectErrorName: null,
    posture: 'upright', drowsy: false,
    wakeLockActive: true,
    ...overrides,
  }
}

function mount(props) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(DebugHud, props)
  app.mount(el)
  return { el, app }
}

describe('DebugHud：只顯示彙總／狀態類數值，白名單制——只顯示明確列舉的欄位', () => {
  it('顯示延遲、三個 track 的 fps、rAF 統計、場次資訊（四捨五入到可讀的位數）', () => {
    const { el, app } = mount({ stats: baseStats() })
    const text = el.textContent

    expect(text).toContain('43') // latencyEma 四捨五入
    expect(text).toContain('88') // latencyP95
    expect(text).toContain('1.98')
    expect(text).toContain('2.97')
    expect(text).toContain('0.33')
    expect(text).toContain('17') // rafP95 四捨五入
    expect(text).toContain('33') // rafMax
    expect(text).toContain('125') // sessionSec 四捨五入
    expect(text).toContain('3') // rounds

    app.unmount()
    el.remove()
  })

  it('顯示效能模式與手機偵測開關的狀態字', () => {
    const { el, app } = mount({ stats: baseStats({ perfMode: true, objectOn: false }) })
    expect(el.textContent).toContain('是') // 效能模式：是
    expect(el.textContent).toContain('關') // 手機偵測：關
    app.unmount()
    el.remove()
  })

  it('顯示三個 track 的連續失敗次數與 error.name（隱私白名單允許的欄位）', () => {
    const { el, app } = mount({
      stats: baseStats({
        poseFailures: 2, poseErrorName: 'TypeError',
        faceFailures: 0, faceErrorName: null,
        objectFailures: 5, objectErrorName: 'Error',
      }),
    })
    const text = el.textContent
    expect(text).toContain('2')
    expect(text).toContain('TypeError')
    expect(text).toContain('5')
    expect(text).toContain('Error')

    app.unmount()
    el.remove()
  })

  it('顯示姿態分類結果（彙總後的字串，不是原始角度或座標）', () => {
    const { el, app } = mount({ stats: baseStats({ posture: 'slouch', drowsy: true } ) })
    expect(el.textContent).toContain('slouch')
    expect(el.textContent).toContain('是') // drowsy: 是

    app.unmount()
    el.remove()
  })

  // 隱私紅線的結構性防線：即使呼叫端不小心在 stats 裡多塞一個危險欄位
  // （例如除錯用的 lastError/landmarks/message），這個元件也不能把它秀出來
  // ——因為 template 只用具名欄位 interpolation，不做 v-bind="stats" 這種
  // 整包展開，多塞的欄位在畫面上沒有任何管道跑得出來。
  //
  // fix round（測試鑑別力 T-2／FG-5／I-6）：這條原本只掃 `el.textContent`，
  // 也就是**屬性通道全開**。總審實測：在根節點加
  // `:title="JSON.stringify(stats)" :aria-label="..."` → 全套 0 紅。
  // `App.mount.test.js:479` 與 `ThresholdLab.test.js:167` 的同型護欄早就改用
  // `el.innerHTML`（屬性值也在裡面），這裡是最後一個還停在 textContent 的。
  // 這個元件顯示 19 個診斷欄位，正是最容易有人順手多掛一個 `:title` 的地方，
  // 而它的檔頭宣稱的恰恰是「沒有任何管道把它秀出來」這件縱深防禦。
  //
  // 鎖得到什麼：任何經由**文字節點或屬性值**（title／aria-label／data-*／
  // alt／任何 v-bind）洩漏出去的 stats 欄位。
  // 鎖不到什麼：只存在於 JS 記憶體、沒有進 DOM 的洩漏（例如寫進
  // localStorage、或塞進事件 payload），那要靠 egressGuardrail 那一層。
  it('stats 裡混入未列舉的欄位（模擬誤塞的除錯資料）不會出現在 DOM 的任何角落（含屬性值）', () => {
    const { el, app } = mount({
      stats: baseStats({
        __rawLandmarkMarker: 'LEAK_MARKER_XYZ',
        lastError: { message: 'C:/Users/secret/path/file.js:42' },
        poseErrorMessage: 'sensitive path info',
      }),
    })
    const html = el.innerHTML
    // 自我檢查：掃描對象真的有東西（不然下面三條在空字串上恆真）。
    expect(html.length, 'innerHTML 是空的，下面的斷言會恆真').toBeGreaterThan(0)
    expect(html).toContain('延遲 EMA') // 元件真的渲染出來了
    expect(html).not.toContain('LEAK_MARKER_XYZ')
    expect(html).not.toContain('secret')
    expect(html).not.toContain('sensitive path info')

    app.unmount()
    el.remove()
  })

  // -------------------------------------------------------------------------
  // feat/diag：物件偵測的可觀測性。
  //
  // 使用者回報「拿手機對著鏡頭，從頭到尾什麼都沒發生」時，工作人員要在現場
  // 回答的第一個問題是「object track 到底有沒有在跑」。那兩個欄位
  // （fpsObject／objectOn）本來就已經接好了——這一組測試的存在理由是把它們
  // **釘住**：它們是這條診斷路徑上唯一的證據，被誰順手拿掉（或改成只顯示
  // 姿態與表情兩個 fps）不會有任何別的測試紅。
  //
  // 鎖得到什麼：兩個欄位真的被渲染成畫面上的文字、以及「開著卻沒有取樣」
  // 這個合成判讀。
  // 鎖不到什麼：BattleView 有沒有真的把 inference.actualFps('object') 餵進來
  // （那是 BattleView.test.js:819 那條的責任）、以及 actualFps 這個數字本身
  // 在真機上準不準。
  // -------------------------------------------------------------------------
  it('object track 的 fps 真的被渲染出來（診斷路徑上唯一的證據，不得被拿掉）', () => {
    // 0.61 是刻意挑的：baseStats 其他每一個數字（延遲、rAF、場次、失敗次數）
    // 都不會四捨五入或格式化成這個字串，所以這條斷言只可能由 fpsObject 滿足。
    const { el, app } = mount({ stats: baseStats({ fpsObject: 0.61 }) })
    expect(el.textContent).toContain('0.61')
    app.unmount()
    el.remove()
  })

  it('手機偵測開著、object fps 是 0 時，畫面上明說「尚無取樣」', () => {
    const { el, app } = mount({ stats: baseStats({ objectOn: true, fpsObject: 0 }) })
    expect(el.textContent).toContain('尚無取樣')
    app.unmount()
    el.remove()
  })

  it('手機偵測開著、object fps 有數字時不出現「尚無取樣」（不能變成恆亮的裝飾）', () => {
    const { el, app } = mount({ stats: baseStats({ objectOn: true, fpsObject: 0.33 }) })
    expect(el.textContent).not.toContain('尚無取樣')
    app.unmount()
    el.remove()
  })

  it('手機偵測本來就關著時不出現「尚無取樣」（那一行已經顯示「關」，再加一句是誤導）', () => {
    const { el, app } = mount({ stats: baseStats({ objectOn: false, fpsObject: 0 }) })
    expect(el.textContent).toContain('關')
    expect(el.textContent).not.toContain('尚無取樣')
    app.unmount()
    el.remove()
  })

  it('fpsObject 漏傳（undefined）時視為「尚無取樣」，不是靜靜地看起來正常', () => {
    const { el, app } = mount({ stats: baseStats({ objectOn: true, fpsObject: undefined }) })
    expect(el.textContent).toContain('尚無取樣')
    app.unmount()
    el.remove()
  })

  it('沒有使用 v-html（結構性防線：文案池／欄位不會變成 XSS 面）', () => {
    expect(debugHudSource).not.toContain('v-html')
  })

  // F3（Task 22b-3 收尾）：jsdom 不解析 CSS `env()`，計算不出 `.hud` 實際的
  // 像素位置——這條測試因此只鎖「原始碼裡真的把 safe-area-inset-bottom
  // 算進 bottom」這件事本身，鎖不到：(1) 算出來的實際像素值，(2) 橫向時
  // 面板底緣是否真的躲開了 home indicator、也沒有跟結束鈕重疊（那兩件事
  // 的算式推導寫在 .hud 規則上方的註解裡，但算式對不對、跟真機的實際
  // safe-area 值符不符合，最終都要靠實機（iPad 橫向）驗收，不是這條測試
  // 能保證的。
  it('F3：.hud 的 bottom 定位把 env(safe-area-inset-bottom) 算進去（原始碼護欄）', () => {
    const hudBlock = debugHudSource.match(/\.hud\s*\{([^}]*)\}/)
    expect(hudBlock, '找不到 .hud 規則').not.toBeNull()
    const rule = hudBlock[1]
    const bottomDecl = rule.match(/bottom:\s*[^;]+;/)
    expect(bottomDecl, '找不到 bottom 宣告').not.toBeNull()
    // 要求 `+ env(safe-area-inset-bottom)` 這個「加法」形狀本身，不是只查
    // env(safe-area-inset-bottom) 這個子字串有沒有出現在 bottom 宣告裡的
    // 任何地方——單純查子字串的話，把 calc() 換成
    // `max(calc(...), env(safe-area-inset-bottom))`（語意錯誤：見 .hud 規則
    // 上方註解的算式，max() 在 safeArea 較大時會讓面板跟結束鈕相交）一樣會
    // 通過，等於這條測試沒有鑑別力。這裡鎖的是「用加法把 safe-area 併進
    // 既有基底」這個結構本身；鎖不到的仍然是：算出來的實際像素值、橫向
    // 真機上面板底緣是否真的躲開 home indicator——那要靠實機驗收。
    expect(bottomDecl[0]).toMatch(/calc\([^;]*\+\s*env\(safe-area-inset-bottom\)\s*\)/)
  })

  // 全 repo 掃過一輪才發現的缺口：wakeLock.isActive() 從一開始就存在，
  // 卻沒有任何畫面讀過它。展場最怕的狀況是螢幕自己暗掉——如果喚醒鎖悄悄
  // 請求失敗，工作人員在那之前完全看不出來。
  it('喚醒鎖狀態：開／關兩種都顯示成使用者看得懂的字（不是原始布林值）', () => {
    const { el: onEl, app: onApp } = mount({ stats: baseStats({ wakeLockActive: true }) })
    expect(onEl.textContent).toContain('螢幕喚醒鎖 開')
    onApp.unmount()

    const { el: offEl, app: offApp } = mount({ stats: baseStats({ wakeLockActive: false }) })
    expect(offEl.textContent).toContain('螢幕喚醒鎖 關')
    offApp.unmount()
  })
})
