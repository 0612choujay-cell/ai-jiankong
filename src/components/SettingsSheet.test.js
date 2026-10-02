// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createApp, nextTick } from 'vue'
import SettingsSheet from './SettingsSheet.vue'
// 這個專案沒有裝 @vue/test-utils，跟 TaskSelector.test.js／
// CalibrationWizard.mount.test.js 一樣手動 createApp+mount，監聽 emit 要透過
// 一個包一層的宿主元件把它轉成外部看得到的回呼。
import { BANNED_WORDS } from '../core/copyGuardrail.js'

const DEFAULT_PROPS = {
  voiceEnabled: true,
  phoneDetectEnabled: true,
  perfMode: false,
  clearState: 'idle',
}

function mountWithHandlers(props, handlers) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  // 事件名稱含連字號（如 toggle-voice），template 裡不能寫 handlers.toggle-voice
  // （會被解析成減法運算），要用中括號存取。
  const listeners = Object.keys(handlers).map((name) => `@${name}="handlers['${name}']"`).join(' ')
  const Host = {
    components: { SettingsSheet },
    template: `<SettingsSheet v-bind="props" ${listeners} />`,
    setup() {
      return { props, handlers }
    },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app }
}

function findButtonByText(el, text) {
  return [...el.querySelectorAll('button')].find((b) => b.textContent.includes(text))
}

// 複審 Important #1：jsdom 不算 CSS layout/computed style，光斷言
// el.textContent.includes('省電') 抓不到「文字技術上還在 DOM 裡、但被
// display:none／hidden／收合容器藏起來」這種迴歸——審查者實測過，加一個
// inline style="display:none" 就能讓原本 15 條測試全綠。
//
// 這個檢查鎖得到的：inline style 的 display:none（元素自己或任何祖先）、
// hidden 屬性（元素自己或任何祖先）、以及是否被包在 <details>（預設收合、
// 需要展開才看得到）底下。
// 這個檢查鎖不到的（誠實寫明，不是沒發現）：由外部 CSS 規則（.some-class
// { display: none } 這種寫在 <style> 裡、透過 class 套用的樣式）造成的
// 隱藏——jsdom 不做 CSS cascade／stylesheet 比對，只看得到 inline style
// 與屬性，沒辦法在不執行真正的瀏覽器 layout 引擎的情況下鎖死這一種。
function assertNoCheapHidingMechanism(el) {
  let node = el
  while (node && node.nodeType === 1) {
    expect(node.hasAttribute('hidden'), `<${node.tagName}> 有 hidden 屬性`).toBe(false)
    expect(node.style.display, `<${node.tagName}> inline display 被設成 none`).not.toBe('none')
    expect(node.tagName.toLowerCase(), '被包在 <details> 底下，預設收合需要展開才看得到').not.toBe('details')
    node = node.parentElement
  }
}

describe('SettingsSheet：三個開關各自 emit 正確事件名稱', () => {
  it('點語音開關 emit toggle-voice', () => {
    let called = 0
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, { 'toggle-voice': () => { called += 1 } })

    findButtonByText(el, '開啟').click() // voiceEnabled: true → 顯示「開啟」
    expect(called).toBe(1)

    app.unmount()
    el.remove()
  })

  it('點手機偵測開關 emit toggle-phone-detect', () => {
    let called = 0
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, { 'toggle-phone-detect': () => { called += 1 } })

    const switches = [...el.querySelectorAll('[role="switch"]')]
    expect(switches.length).toBe(2)
    switches[1].click()
    expect(called).toBe(1)

    app.unmount()
    el.remove()
  })

  it('perfMode:true 時點「重設效能模式」emit reset-perf-mode', () => {
    let called = 0
    const { el, app } = mountWithHandlers(
      { ...DEFAULT_PROPS, perfMode: true },
      { 'reset-perf-mode': () => { called += 1 } },
    )

    findButtonByText(el, '重設效能模式').click()
    expect(called).toBe(1)

    app.unmount()
    el.remove()
  })

  it('點「關閉設定」emit close', () => {
    let called = 0
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, { close: () => { called += 1 } })

    findButtonByText(el, '關閉設定').click()
    expect(called).toBe(1)

    app.unmount()
    el.remove()
  })
})

describe('SettingsSheet：role/aria 標記', () => {
  it('兩個開關都用 role="switch" 且 aria-checked 反映 props', () => {
    const { el, app } = mountWithHandlers(
      { ...DEFAULT_PROPS, voiceEnabled: true, phoneDetectEnabled: false },
      {},
    )

    const switches = [...el.querySelectorAll('[role="switch"]')]
    expect(switches.length).toBe(2)
    expect(switches[0].getAttribute('aria-checked')).toBe('true')
    expect(switches[1].getAttribute('aria-checked')).toBe('false')

    app.unmount()
    el.remove()
  })

  it('面板本身用 role="dialog" aria-modal="true" 且有 aria-label', () => {
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, {})

    const dialog = el.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBeTruthy()

    app.unmount()
    el.remove()
  })
})

describe('SettingsSheet：效能模式狀態文字與重設按鈕的連動（Ruling CR）', () => {
  it('perfMode:true → 面板文字看得到「省電」等字樣，且重設按鈕不是 disabled', () => {
    const { el, app } = mountWithHandlers({ ...DEFAULT_PROPS, perfMode: true }, {})

    expect(el.textContent).toContain('省電')
    const resetBtn = findButtonByText(el, '重設效能模式')
    expect(resetBtn.disabled).toBe(false)

    // 複審 Important #1：只驗證文字「存在於 DOM」不夠，Ruling CR 要求的是
    // 「看得到」。這裡額外鎖住幾種便宜的藏字手法（見 assertNoCheapHidingMechanism
    // 註解，內附鎖得到／鎖不到的邊界）。用 .status 找到狀態句本身，逐層往上
    // 檢查祖先鏈。
    const statusEl = [...el.querySelectorAll('.status')].find((s) => s.textContent.includes('省電'))
    expect(statusEl).not.toBeUndefined()
    assertNoCheapHidingMechanism(statusEl)

    app.unmount()
    el.remove()
  })

  it('perfMode:false → 重設按鈕 disabled === true', () => {
    const { el, app } = mountWithHandlers({ ...DEFAULT_PROPS, perfMode: false }, {})

    const resetBtn = findButtonByText(el, '重設效能模式')
    expect(resetBtn.disabled).toBe(true)

    app.unmount()
    el.remove()
  })
})

describe('SettingsSheet：清除所有本地紀錄——先確認才 emit（這個元件最重要的護欄）', () => {
  it('點「清除所有紀錄」不會立刻 emit clear-all，會先出現 ConfirmDialog', async () => {
    let called = 0
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, { 'clear-all': () => { called += 1 } })

    findButtonByText(el, '清除所有紀錄').click()
    await nextTick()

    expect(called).toBe(0)
    // ConfirmDialog 疊加後，畫面上會有兩個 role="dialog"：面板本身跟確認框。
    expect(el.querySelectorAll('[role="dialog"]').length).toBe(2)

    app.unmount()
    el.remove()
  })

  it('ConfirmDialog 按確認才 emit clear-all', async () => {
    let called = 0
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, { 'clear-all': () => { called += 1 } })

    findButtonByText(el, '清除所有紀錄').click()
    await nextTick()

    const confirmBtn = findButtonByText(el, '清除紀錄')
    expect(confirmBtn).not.toBeUndefined()
    confirmBtn.click()
    await nextTick()

    expect(called).toBe(1)

    app.unmount()
    el.remove()
  })

  it('ConfirmDialog 按取消 → 永遠不會 emit clear-all，且對話框消失', async () => {
    let called = 0
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, { 'clear-all': () => { called += 1 } })

    findButtonByText(el, '清除所有紀錄').click()
    await nextTick()

    const cancelBtn = findButtonByText(el, '先不要')
    expect(cancelBtn).not.toBeUndefined()
    cancelBtn.click()
    await nextTick()

    expect(called).toBe(0)
    expect(el.querySelectorAll('[role="dialog"]').length).toBe(1)

    app.unmount()
    el.remove()
  })
})

describe('SettingsSheet：clearState 的可見回饋（不得把失敗顯示成功）', () => {
  it("clearState:'busy' → 清除按鈕 disabled 且顯示進行中字樣", () => {
    const { el, app } = mountWithHandlers({ ...DEFAULT_PROPS, clearState: 'busy' }, {})

    const clearBtn = el.querySelector('.clear')
    expect(clearBtn.disabled).toBe(true)
    expect(clearBtn.textContent).toContain('清除中')

    app.unmount()
    el.remove()
  })

  it("clearState:'done' → 顯示已清除字樣", () => {
    const { el, app } = mountWithHandlers({ ...DEFAULT_PROPS, clearState: 'done' }, {})

    expect(el.textContent).toContain('已清除')

    app.unmount()
    el.remove()
  })

  it("clearState:'error' → DOM 不得出現成功字樣，且錯誤訊息看得到", () => {
    const { el, app } = mountWithHandlers({ ...DEFAULT_PROPS, clearState: 'error' }, {})

    expect(el.textContent).not.toContain('已清除')
    expect(el.textContent).toContain('失敗')

    app.unmount()
    el.remove()
  })
})

describe('SettingsSheet：文案紅線（單句 ≤15 字、無禁用詞）', () => {
  it('所有按鈕與標題的 textContent 逐一檢查長度，全文檢查禁用詞（含 ConfirmDialog 四句）', async () => {
    // 同時涵蓋 perfMode 開/關、clearState 各狀態，避免只掛一種狀態漏測某些文字。
    // clearState 用非 'busy' 的狀態（'done'/'error'/'idle'），確保清除按鈕
    // 沒被 disabled，點得下去，ConfirmDialog 才打得開。
    const cases = [
      { ...DEFAULT_PROPS, perfMode: true, clearState: 'idle' },
      { ...DEFAULT_PROPS, perfMode: false, clearState: 'done' },
      { ...DEFAULT_PROPS, perfMode: true, clearState: 'error' },
    ]

    for (const props of cases) {
      const { el, app } = mountWithHandlers(props, {})

      // 複審 Important #2：title/body/confirmText/cancelText 是傳給
      // ConfirmDialog 的 props 字串，不打開 showConfirm 它們永遠不會被渲染
      // 進 DOM，之前的掃描完全漏掉這四句；全域 copyGuardrail 的規則 B
      // 也掃不到（屬性值不在它的擷取範圍）。這裡實際點開清除按鈕，讓
      // ConfirmDialog 的 h3/p/button 一起進到下面的掃描範圍。用 .clear
      // class 找按鈕而不是靠文字：clearState:'error' 時按鈕文字是「再清
      // 一次」，不含「清除」兩字，用文字比對會找不到。
      el.querySelector('.clear').click()
      await nextTick()

      // ConfirmDialog 的標題是 h3，不是 h2，這裡兩種都掃。
      const headings = [...el.querySelectorAll('h2, h3')].map((h) => h.textContent.trim())
      expect(headings.length).toBeGreaterThan(0)
      for (const line of headings) {
        expect(line.length, `「${line}」超過 15 字`).toBeLessThanOrEqual(15)
      }

      const buttonTexts = [...el.querySelectorAll('button')].map((b) => b.textContent.trim())
      expect(buttonTexts.length).toBeGreaterThan(0)
      for (const line of buttonTexts) {
        expect(line.length, `「${line}」超過 15 字`).toBeLessThanOrEqual(15)
      }

      // ConfirmDialog 的 body 是一個沒有專屬 class 的 <p>；乾脆把面板裡
      // 所有 <p>（.hint／.status 旁的說明／clear-msg／ConfirmDialog body）
      // 一起掃，範圍比 brief 原文列的「按鈕與標題」更寬，但這幾句本來就都
      // 是 ≤15 字的短句，掃了不會誤傷，只會多一層保護。
      const paragraphTexts = [...el.querySelectorAll('p')].map((p) => p.textContent.trim())
      for (const line of paragraphTexts) {
        expect(line.length, `「${line}」超過 15 字`).toBeLessThanOrEqual(15)
      }

      const fullText = el.textContent
      for (const word of BANNED_WORDS) {
        expect(fullText).not.toContain(word)
      }

      app.unmount()
      el.remove()
    }
  })
})

// ---------------------------------------------------------------------------
// Important 3（版面／可及性複審）：aria-modal="true" 必須有對應的焦點管理
// 行為，跟 ConfirmDialog.vue 同一套修法。這裡額外驗證巢狀 ConfirmDialog
// （清除所有紀錄的二次確認）打開時，兩層 focus trap 不會互相打架。
// ---------------------------------------------------------------------------

// 用 document.createEvent 而不是 `new KeyboardEvent(...)`：專案的 eslint
// 全域清單沒有列 KeyboardEvent（見 session.test.js 的 setVisibility() 同一個
// 理由），這裡不想為了測試檔去動共用的 eslint.config.js。initEvent 建出來的
// 是最基本的 Event，再手動補上元件程式碼實際會讀的 key 屬性——一般物件
// 屬性賦值，跟是不是「真正的」KeyboardEvent 無關。
function tabKeydown() {
  const ev = document.createEvent('Event')
  ev.initEvent('keydown', true, true)
  ev.key = 'Tab'
  return ev
}

describe('SettingsSheet：焦點管理（Important 3——aria-modal 不能只是宣告）', () => {
  it('掛載時焦點自動移進面板（第一個可聚焦元素，也就是語音開關）', () => {
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, {})
    const switches = [...el.querySelectorAll('[role="switch"]')]
    expect(document.activeElement).toBe(switches[0])
    app.unmount()
    el.remove()
  })

  it('卸載後，焦點回到掛載前原本在焦點上的元素', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '觸發按鈕'
    document.body.appendChild(trigger)
    trigger.focus()

    const { el, app } = mountWithHandlers(DEFAULT_PROPS, {})
    expect(document.activeElement).not.toBe(trigger)

    app.unmount()
    el.remove()

    expect(document.activeElement, '關閉後焦點必須送回觸發它的元素').toBe(trigger)
    trigger.remove()
  })

  it('Tab 循環鎖在面板內：在最後一個可聚焦元素（關閉設定）按 Tab 會回到第一個（語音開關）', () => {
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, {})
    const closeBtn = findButtonByText(el, '關閉設定')
    const firstSwitch = el.querySelectorAll('[role="switch"]')[0]

    closeBtn.focus()
    document.dispatchEvent(tabKeydown())
    expect(document.activeElement, 'Tab 循環：最後一個之後要回到第一個').toBe(firstSwitch)

    app.unmount()
    el.remove()
  })

  it('巢狀 ConfirmDialog 開著時，面板自己的 trap 讓開，焦點循環交給 ConfirmDialog；取消後焦點回到「清除所有紀錄」按鈕', async () => {
    const { el, app } = mountWithHandlers(DEFAULT_PROPS, {})

    const clearBtn = findButtonByText(el, '清除所有紀錄')
    // 先 .focus() 再 .click()：jsdom 的 el.click() 只會派送 click 事件，
    // 不會像真實瀏覽器的滑鼠點擊那樣附帶把元素變成 activeElement 這個副作用
    // （這裡不是在測「點擊會不會自動聚焦」——那正是 ConfirmDialog.vue 註解
    // 提到的 iOS Safari 已知限制，這裡要測的是「聚焦之後、確認框關閉，
    // 焦點會不會正確送回來」，所以先手動把前置條件擺好）。
    clearBtn.focus()
    clearBtn.click()
    await nextTick()

    // ConfirmDialog 掛載時會自己把焦點移進去（見 ConfirmDialog.test.js），
    // 這裡驗證的是「面板自己的 trap 沒有在搶」：在 ConfirmDialog 的最後一顆
    // 按鈕按 Tab，應該由 ConfirmDialog 自己的 trap 處理、回到它自己的第一顆
    // 按鈕，而不是被外層 SettingsSheet 的 trap 攔截、跳到面板自己的其他元素。
    const dialogButtons = [...el.querySelectorAll('[role="dialog"]')]
      .find((d) => d.getAttribute('aria-label') === '清除所有本地紀錄？')
      .querySelectorAll('button')
    const [confirmKeep, confirmStop] = dialogButtons

    confirmStop.focus()
    document.dispatchEvent(tabKeydown())
    expect(document.activeElement, '巢狀對話框的 Tab 循環要留在它自己裡面').toBe(confirmKeep)

    // 取消：ConfirmDialog 卸載，焦點回到觸發它的「清除所有紀錄」按鈕。
    const cancelBtn = findButtonByText(el, '先不要')
    cancelBtn.click()
    await nextTick()
    expect(document.activeElement, 'ConfirmDialog 關閉後焦點要回到清除按鈕').toBe(clearBtn)

    app.unmount()
    el.remove()
  })
})
