// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest'
import { createApp, nextTick } from 'vue'
import InstallGuide from './InstallGuide.vue'
import installGuideSource from './InstallGuide.vue?raw'
import statsDashboardSource from './StatsDashboard.vue?raw'

// .css 不能用 `?raw`：vitest 預設關掉 CSS 處理，`import x from './a.css?raw'`
// 會拿到空字串（實測過）——空字串會讓下面每一條正則都「找不到」，護欄變成
// 一組永遠拋錯或永遠成立的假測試。直接讀檔。
// 路徑相對於 vitest 的工作目錄（專案根目錄）：jsdom 環境下 import.meta.url 是
// vitest 的 http:// 模組位址，不能拿去組 file 路徑（實測會丟
// 「The URL must be of scheme file」）。
const readCss = (name) => readFileSync(`src/styles/${name}`, 'utf8')
const tokensCss = readCss('tokens.css')
const baseCss = readCss('base.css')

const KEY = 'focus-quest:install-dismissed'

function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(InstallGuide)
  app.mount(el)
  return {
    el,
    app,
    banner: () => el.querySelector('.install'),
    closeBtn: () => el.querySelector('.install button'),
    unmount() { app.unmount(); el.remove() },
  }
}

// ---------------------------------------------------------------- 環境替身
let originalMatchMedia
let originalLocalStorage

function setStandalone(displayMode, navigatorFlag) {
  window.matchMedia = () => ({ matches: displayMode })
  if (navigatorFlag === undefined) delete window.navigator.standalone
  else Object.defineProperty(window.navigator, 'standalone', { value: navigatorFlag, configurable: true })
}

/** 換掉整個 localStorage：throwOn 裡列到的方法會丟例外（模擬私密瀏覽）。 */
function fakeLocalStorage({ initial = {}, throwOn = [] } = {}) {
  const store = { ...initial }
  const guard = (name, fn) => (...args) => {
    if (throwOn.includes(name)) throw new Error('SecurityError: storage blocked')
    return fn(...args)
  }
  const fake = {
    getItem: guard('getItem', (k) => (k in store ? store[k] : null)),
    setItem: guard('setItem', (k, v) => { store[k] = String(v) }),
    removeItem: guard('removeItem', (k) => { delete store[k] }),
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    store,
  }
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true })
  return fake
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia
  originalLocalStorage = window.localStorage
  setStandalone(false, undefined)
  fakeLocalStorage()
})

afterEach(() => {
  window.matchMedia = originalMatchMedia
  Object.defineProperty(window, 'localStorage', { value: originalLocalStorage, configurable: true })
  delete window.navigator.standalone
})

describe('InstallGuide：什麼時候出現', () => {
  it('一般瀏覽器分頁（沒安裝、沒關過）：出現橫幅', async () => {
    const m = mount()
    await nextTick()
    expect(m.banner()).not.toBeNull()
    expect(m.banner().textContent).toContain('加到主畫面')
    m.unmount()
  })

  it('已經從主畫面啟動（display-mode: standalone）：不出現', async () => {
    setStandalone(true, undefined)
    const m = mount()
    await nextTick()
    expect(m.banner()).toBeNull()
    m.unmount()
  })

  it('iOS 舊旗標 navigator.standalone === true：一樣不出現', async () => {
    // iPadOS Safari 某些版本 display-mode 查詢不可靠，只看標準那條會漏判——
    // 已經安裝的人每次打開都被叫去安裝一次是很蠢的體驗。
    setStandalone(false, true)
    const m = mount()
    await nextTick()
    expect(m.banner()).toBeNull()
    m.unmount()
  })

  it('之前按過 ✕（localStorage 記著）：重新整理也不再出現', async () => {
    fakeLocalStorage({ initial: { [KEY]: '1' } })
    const m = mount()
    await nextTick()
    expect(m.banner()).toBeNull()
    m.unmount()
  })
})

describe('InstallGuide：關閉與記憶', () => {
  it('按 ✕ 之後橫幅消失，而且把「已關閉」寫進 localStorage', async () => {
    const ls = fakeLocalStorage()
    const m = mount()
    await nextTick()

    m.closeBtn().click()
    await nextTick()

    expect(m.banner()).toBeNull()
    expect(ls.store[KEY]).toBe('1')
    m.unmount()
  })

  it('localStorage.getItem 直接丟例外（私密瀏覽）：照樣顯示，不把畫面炸掉', async () => {
    fakeLocalStorage({ throwOn: ['getItem'] })
    const m = mount()
    await nextTick()
    expect(m.banner()).not.toBeNull()
    m.unmount()
  })

  it('localStorage.setItem 丟例外：✕ 仍然關得掉（只是這次記不住）', async () => {
    fakeLocalStorage({ throwOn: ['setItem'] })
    const m = mount()
    await nextTick()

    m.closeBtn().click()
    await nextTick()

    expect(m.banner(), '記不住是次要的，關不掉才是壞掉').toBeNull()
    m.unmount()
  })
})

// ---------------------------------------------------------------------------
// 更正 5 的版面護欄。
//
// brief 原本把橫幅釘在 `bottom: max(var(--gap), env(safe-area-inset-bottom))`，
// 而 StatsDashboard 的 `.actions`（「再討伐一次」「回主畫面」兩顆主按鈕）也是
// position:fixed 的底部列——橫幅會直接壓在那兩顆按鈕上面，而且橫幅自己有一顆
// ✕ 要點，不能用 pointer-events:none 把症狀蓋掉。這個專案已經因為「覆蓋層蓋住
// 它自己叫你按的按鈕」踩過三次。
//
// 所以這裡不是「改了 CSS 就算數」：直接把兩個元件原始碼裡的 CSS 算式抓出來，
// 代入 tokens.css 的實際值與多組 safe-area inset 求值，再比較兩個矩形。
// ---------------------------------------------------------------------------
/**
 * 只給**解析 CSS 規則**用：CSS 的區塊註解會夾在宣告之間，不挖掉就切不出
 * 宣告。挖過頭的後果是「找不到選擇器／找不到宣告」→ 直接拋錯，是會吵的失敗，
 * 不會變成安靜的假陰性。缺席斷言（`not.toContain`）一律不准用它，用下面的
 * codeLinesOnly()——理由見該處。
 */
function stripComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 只剔除「整行都是註解」的行（複審第 1 輪 IMP-1，跟主線 App.mount.test.js 同一套）。 */
function codeLinesOnly(source) {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--'))
    })
    .join('\n')
}

/** 取出某個選擇器的規則內容（`{}` 之間那段），已去除註解。 */
function ruleBody(source, selector) {
  const css = stripComments(source)
  const i = css.indexOf(selector)
  if (i < 0) throw new Error(`找不到選擇器 ${selector}`)
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

/**
 * 取出一條宣告的值。刻意不用正則掃（括號裡還有 `;`／`,`／空白，而且
 * `max(var(--gap), env(...))` 這種巢狀值一律要當成一個值），直接照同層的
 * `;` 切開再比對屬性名，最不容易寫出「看起來過了其實沒抓到」的護欄。
 */
function decl(body, prop) {
  let depth = 0
  let cur = ''
  const parts = []
  for (const c of body) {
    if (c === '(') depth += 1
    if (c === ')') depth -= 1
    if (c === ';' && depth === 0) { parts.push(cur); cur = '' } else cur += c
  }
  parts.push(cur)
  for (const p of parts) {
    const i = p.indexOf(':')
    if (i < 0) continue
    if (p.slice(0, i).trim() === prop) return p.slice(i + 1).trim()
  }
  throw new Error(`找不到宣告 ${prop}`)
}

/** 把 `padding: a b c d` 這種簡寫依同層空白切開（括號內的空白不算）。 */
function splitTopLevel(value) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of value) {
    if (c === '(') depth += 1
    if (c === ')') depth -= 1
    if (/\s/.test(c) && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** tokens.css 的實際值（不是抄一份常數：token 改了，這個護欄要跟著改）。 */
function tokenPx(name) {
  const line = tokensCss.split(/\r?\n/).find((l) => l.trim().startsWith(`--${name}:`))
  if (!line) throw new Error(`tokens.css 沒有 --${name}`)
  const value = Number(line.split(':')[1].trim().replace(';', '').replace('px', ''))
  if (!Number.isFinite(value)) throw new Error(`--${name} 不是 px 長度：${line}`)
  return value
}

/** 求值一段 CSS 長度算式；env(safe-area-inset-*) 全部代入同一個 inset。 */
function evalPx(expr, inset) {
  const js = expr
    .replace(/var\(--([a-z-]+)\)/g, (_, n) => String(tokenPx(n)))
    .replace(/env\([a-z-]+\)/g, String(inset))
    .replace(/calc\(/g, '(')
    .replace(/max\(/g, 'Math.max(')
    .replace(/min\(/g, 'Math.min(')
    .replace(/px/g, '')
  // 只求值「本專案自己原始碼裡的 CSS 長度算式」，代進去的變數全部來自
  // tokens.css 與這個檔案自己的 inset 清單，沒有任何外部輸入。
  return Function(`"use strict"; return (${js})`)()
}

describe('InstallGuide × StatsDashboard：安裝橫幅不得蓋住結算頁的兩顆主按鈕（更正 5）', () => {
  const installBody = ruleBody(installGuideSource, '.install {')
  const actionsBody = ruleBody(statsDashboardSource, '.actions {')

  it('兩者都是 position: fixed（所以真的會疊在一起，這個護欄才有意義）', () => {
    expect(decl(installBody, 'position')).toBe('fixed')
    expect(decl(actionsBody, 'position')).toBe('fixed')
    expect(decl(actionsBody, 'bottom')).toBe('0')
  })

  it('結算頁底部按鈕列的按鈕高度就是 --tap-primary（算式的其中一項）', () => {
    const primary = ruleBody(baseCss, 'button.primary {')
    expect(decl(primary, 'min-height')).toBe('var(--tap-primary)')
  })

  it('每一組 safe-area inset 下，橫幅底緣都在按鈕列上緣之上（矩形不相交）', () => {
    const [padTop, , padBottom] = splitTopLevel(decl(actionsBody, 'padding'))
    const installBottom = decl(installBody, 'bottom')

    const rows = []
    // 0 ＝ 沒有 home indicator；34 ＝ iPad Pro 直式；50 ＝ 刻意取一個比
    // --gap 大很多的值，確保護欄不是靠「inset 剛好比 gap 小」僥倖成立。
    for (const inset of [0, 8, 16, 34, 50]) {
      const actionsHeight = evalPx(padTop, inset) + tokenPx('tap-primary') + evalPx(padBottom, inset)
      const bannerBottom = evalPx(installBottom, inset)
      rows.push({ inset, actionsHeight, bannerBottom })
      expect(
        bannerBottom,
        `inset=${inset}px：橫幅底緣 ${bannerBottom}px 必須高於按鈕列頂緣 ${actionsHeight}px`,
      ).toBeGreaterThan(actionsHeight)
    }

    // 這一條讓斷言有鑑別力：brief 原本的 `bottom: max(var(--gap), env(...))`
    // 在每一組 inset 下都會落在按鈕列裡面（16 或 inset < 76+）。
    expect(rows.every((r) => r.bannerBottom > r.actionsHeight)).toBe(true)
    expect(evalPx('max(var(--gap), env(safe-area-inset-bottom))', 0),
      'brief 的原始值：確認這個護欄真的抓得到它（16 < 92）').toBeLessThan(rows[0].actionsHeight)
  })

  // v-html 的檢查用行過濾，不用上面那個 stripComments（複審第 1 輪 IMP-1）：
  // stripComments 是為了**解析 CSS 規則**才存在的（CSS 的區塊註解會夾在宣告
  // 中間），而它挖過頭時的後果是「找不到選擇器／找不到宣告」——會直接拋錯，
  // 屬於會吵的失敗。`not.toContain` 這種**缺席斷言**不一樣：挖過頭會安靜地
  // 變成假陰性，所以改用只剔除整行註解的行過濾（一行程式碼不會以 //、*、/*、
  // <!-- 開頭，所以它不可能藏住真的 v-html）。
  it('沒有使用 v-html', () => {
    expect(codeLinesOnly(installGuideSource)).not.toContain('v-html')
    expect(codeLinesOnly(installGuideSource), '自我檢查：過濾後程式碼還在').toContain('<template>')
  })
})
