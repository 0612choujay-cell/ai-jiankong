// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createApp } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'
// 這個年齡層的產品文案紅線：單句 ≤15 字、不得出現對人格／外觀的負面描述。
// Task 22a：收斂自四份各自獨立、互不同步的 BANNED_WORDS 清單，見
// src/core/copyGuardrail.js。
import { BANNED_WORDS } from '../core/copyGuardrail.js'

function mountWithHandlers(props, handlers = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const Host = {
    components: { ConfirmDialog },
    template: `<ConfirmDialog v-bind="props" @confirm="onConfirm" @cancel="onCancel" />`,
    setup() {
      return { props, onConfirm: handlers.confirm ?? (() => {}), onCancel: handlers.cancel ?? (() => {}) }
    },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app }
}

describe('ConfirmDialog：二次確認，誤觸成本不對稱', () => {
  it('預設文案：標題、內文、兩顆按鈕都渲染，且「繼續討伐」在 DOM 順序上排在「結束這一輪」之前', () => {
    const { el, app } = mountWithHandlers({})
    expect(el.querySelector('h3').textContent).toBe('要結束這一輪嗎？')
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.length).toBe(2)
    expect(buttons[0].textContent).toBe('繼續討伐')
    expect(buttons[1].textContent).toBe('結束這一輪')

    const dialog = el.querySelector('[role="dialog"]')
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    app.unmount()
    el.remove()
  })

  it('點「繼續討伐」emit cancel，不 emit confirm', () => {
    let confirmed = false
    let cancelled = false
    const { el, app } = mountWithHandlers({}, {
      confirm: () => { confirmed = true }, cancel: () => { cancelled = true },
    })
    const keepButton = [...el.querySelectorAll('button')].find((b) => b.textContent === '繼續討伐')
    keepButton.click()
    expect(cancelled).toBe(true)
    expect(confirmed).toBe(false)
    app.unmount()
    el.remove()
  })

  it('點「結束這一輪」emit confirm，不 emit cancel', () => {
    let confirmed = false
    let cancelled = false
    const { el, app } = mountWithHandlers({}, {
      confirm: () => { confirmed = true }, cancel: () => { cancelled = true },
    })
    const stopButton = [...el.querySelectorAll('button')].find((b) => b.textContent === '結束這一輪')
    stopButton.click()
    expect(confirmed).toBe(true)
    expect(cancelled).toBe(false)
    app.unmount()
    el.remove()
  })

  it('可以覆寫文案（自訂 title/body/confirmText/cancelText）', () => {
    const { el, app } = mountWithHandlers({
      title: '標題', body: '內文', confirmText: '確定', cancelText: '取消',
    })
    expect(el.querySelector('h3').textContent).toBe('標題')
    expect(el.querySelector('p').textContent).toBe('內文')
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons[0].textContent).toBe('取消')
    expect(buttons[1].textContent).toBe('確定')
    app.unmount()
    el.remove()
  })

  it('預設文案沒有出現任何禁用詞，且各自不超過 15 字', () => {
    const { el, app } = mountWithHandlers({})
    const title = el.querySelector('h3').textContent
    const body = el.querySelector('p').textContent
    for (const text of [title, body]) {
      expect(text.length).toBeLessThanOrEqual(15)
      for (const word of BANNED_WORDS) expect(text).not.toContain(word)
    }
    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// Important 3（版面／可及性複審）：aria-modal="true" 必須有對應的焦點管理
// 行為——開啟時焦點進到對話框內、關閉後回到觸發它的元素、Tab 循環鎖在
// 對話框裡（focus trap）。
// ---------------------------------------------------------------------------

// 用 document.createEvent 而不是 `new KeyboardEvent(...)`：專案的 eslint
// 全域清單沒有列 KeyboardEvent（見 session.test.js 的 setVisibility() 同一個
//理由），這裡不想為了測試檔去動共用的 eslint.config.js。initEvent 建出來的
// 是最基本的 Event，再手動補上元件程式碼實際會讀的 key/shiftKey 屬性
// ——一般物件屬性賦值，跟是不是「真正的」KeyboardEvent 無關。
function tabKeydown(shiftKey = false) {
  const ev = document.createEvent('Event')
  ev.initEvent('keydown', true, true)
  ev.key = 'Tab'
  ev.shiftKey = shiftKey
  return ev
}

describe('ConfirmDialog：焦點管理（Important 3——aria-modal 不能只是宣告）', () => {
  it('掛載時焦點自動移進對話框（第一顆按鈕，也就是「繼續討伐」）', () => {
    const { el, app } = mountWithHandlers({})
    const keepButton = [...el.querySelectorAll('button')].find((b) => b.textContent === '繼續討伐')
    expect(document.activeElement).toBe(keepButton)
    app.unmount()
    el.remove()
  })

  it('卸載後，焦點回到掛載前原本在焦點上的元素', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '觸發按鈕'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const { el, app } = mountWithHandlers({})
    // 掛載後焦點被搶進對話框（上一條測試已經驗過），這裡只關心卸載之後。
    expect(document.activeElement).not.toBe(trigger)

    app.unmount()
    el.remove()

    expect(document.activeElement, '關閉後焦點必須送回觸發它的元素').toBe(trigger)
    trigger.remove()
  })

  it('Tab 循環鎖在對話框內：在最後一顆按鈕按 Tab 會回到第一顆，不會跑出對話框', () => {
    const { el, app } = mountWithHandlers({})
    const buttons = [...el.querySelectorAll('button')]
    const [keepButton, stopButton] = buttons

    stopButton.focus()
    expect(document.activeElement).toBe(stopButton)
    document.dispatchEvent(tabKeydown())
    expect(document.activeElement, 'Tab 循環：最後一顆之後要回到第一顆').toBe(keepButton)

    app.unmount()
    el.remove()
  })

  it('Shift+Tab 反向循環：在第一顆按鈕往回跳會到最後一顆', () => {
    const { el, app } = mountWithHandlers({})
    const buttons = [...el.querySelectorAll('button')]
    const [keepButton, stopButton] = buttons

    keepButton.focus()
    document.dispatchEvent(tabKeydown(true))
    expect(document.activeElement, 'Shift+Tab 反向循環：第一顆往回跳要到最後一顆').toBe(stopButton)

    app.unmount()
    el.remove()
  })
})
