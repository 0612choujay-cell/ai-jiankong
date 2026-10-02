// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { createApp } from 'vue'
import StatusIndicator from './StatusIndicator.vue'
import statusIndicatorSource from './StatusIndicator.vue?raw'

function mount(props, listeners = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(StatusIndicator, { ...props, ...listeners })
  app.mount(el)
  return { el, app }
}

describe('StatusIndicator：正常時收斂成一個綠點，異常/降級才展開細節', () => {
  it('全部 ok（或沒有任何 items）時只顯示綠點與「偵測中」，不展開清單', () => {
    const { el, app } = mount({ items: [] })

    expect(el.querySelector('.dot').classList.contains('ok')).toBe(true)
    expect(el.textContent).toContain('偵測中')
    expect(el.querySelector('.list')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('有一個 warn 項目時：dot 變 warn、標題顯示「1 項需要注意」、自動展開清單並顯示文字', () => {
    const { el, app } = mount({
      items: [{ id: 'perf', level: 'warn', text: '偵測速度變慢了' }],
    })

    expect(el.querySelector('.dot').classList.contains('warn')).toBe(true)
    expect(el.textContent).toContain('1 項需要注意')
    expect(el.querySelector('.list')).not.toBeNull()
    expect(el.textContent).toContain('偵測速度變慢了')

    app.unmount()
    el.remove()
  })

  it('同時有 warn 與 error 時，dot 以最嚴重的 error 為準', () => {
    const { el, app } = mount({
      items: [
        { id: 'a', level: 'warn', text: '警告文字' },
        { id: 'b', level: 'error', text: '錯誤文字' },
      ],
    })

    expect(el.querySelector('.dot').classList.contains('error')).toBe(true)
    expect(el.querySelector('.dot').classList.contains('warn')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('ok 的項目不會出現在展開的清單裡，只有非 ok 的才顯示', () => {
    const { el, app } = mount({
      items: [
        { id: 'a', level: 'ok', text: '這個不該出現' },
        { id: 'b', level: 'warn', text: '這個該出現' },
      ],
    })

    expect(el.textContent).not.toContain('這個不該出現')
    expect(el.textContent).toContain('這個該出現')

    app.unmount()
    el.remove()
  })

  it('點擊 dot-row 可以手動展開/收合（即使全部正常）', async () => {
    const { el, app } = mount({ items: [] })
    const btn = el.querySelector('.dot-row')

    expect(btn.getAttribute('aria-expanded')).toBe('false')
    btn.click()
    await new Promise((r) => { setTimeout(r, 0) })
    expect(btn.getAttribute('aria-expanded')).toBe('true')

    app.unmount()
    el.remove()
  })

  it('項目帶 action 時顯示按鈕，點擊會 emit action 並帶上該項目的 id；沒有 action 的項目不顯示按鈕', () => {
    let emitted = null
    const { el, app } = mount({
      items: [
        { id: 'has-action', level: 'warn', text: '有動作', action: '重新啟動' },
        { id: 'no-action', level: 'warn', text: '沒動作' },
      ],
    }, { onAction: (id) => { emitted = id } })

    const buttons = [...el.querySelectorAll('button.act')]
    expect(buttons.length).toBe(1)
    expect(buttons[0].textContent).toBe('重新啟動')

    buttons[0].click()
    expect(emitted).toBe('has-action')

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// 版面／可及性複審「順便檢查」的同一類掃描：template 用到的 class 是否都有
// 對應的 CSS 定義（跟 App.mount.test.js 對 App.vue 做的是同一套方法，這裡
// 用來鎖住這個元件自己掃出來的 .text／.tag 缺口，見 StatusIndicator.vue
// 對應的修復註解）。
// ---------------------------------------------------------------------------

describe('StatusIndicator：template 用到的 class 必須在自己的 scoped style 或全域 CSS 裡有定義', () => {
  // jsdom 不做 CSS 級聯，這裡一樣只驗證結構性事實（有沒有定義），不驗證
  // 視覺效果（.tag 的置中對不對齊、min-width 夠不夠）——那些只能真機驗證。
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

  it('沒有任何 template 用過、卻找不到 CSS 定義的 class', () => {
    const used = extractTemplateClasses(statusIndicatorSource)
    const scoped = extractScopedClasses(statusIndicatorSource)
    const globalSets = [
      readFileSync('src/styles/base.css', 'utf8'),
      readFileSync('src/styles/layout.css', 'utf8'),
      readFileSync('src/styles/tokens.css', 'utf8'),
    ].map(extractCssClasses)

    const missing = [...used].filter(
      (c) => !scoped.has(c) && !globalSets.some((set) => set.has(c)),
    )
    expect(missing, `這些 class 用過卻找不到任何 CSS 定義：${missing.join(', ')}`).toEqual([])
  })
})
