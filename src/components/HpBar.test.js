// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createApp } from 'vue'
import HpBar from './HpBar.vue'
import hpBarSource from './HpBar.vue?raw'

function mount(props) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(HpBar, props)
  app.mount(el)
  return { el, app }
}

describe('HpBar：數字永遠跟血條長度同步顯示，不單靠顏色與長度傳達', () => {
  it('顯示 label 與「數值 / 上限」的數字，且 aria-valuenow 與畫面數字一致', () => {
    const { el, app } = mount({ label: '你的體力', value: 80, max: 100, side: 'hero' })

    expect(el.textContent).toContain('你的體力')
    expect(el.textContent).toContain('80 / 100')

    const bar = el.querySelector('[role="progressbar"]')
    expect(bar.getAttribute('aria-valuenow')).toBe('80')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-label')).toBe('你的體力')

    app.unmount()
    el.remove()
  })

  it('數值超過上限時，畫面數字與血條長度都封頂在 100%，不會顯示超過 max 或 scaleX > 1', () => {
    const { el, app } = mount({ label: '魔王', value: 999, max: 100, side: 'boss' })

    // 用 .num 的精確字串比對，不是 el.textContent 的 toContain：
    // 「999 / 100」這種未封頂的錯誤輸出裡並不含「100 / 100」子字串，但反過來
    // 的情境（下面那條負數測試）曾經踩到「-30 / 100」子字串意外包含「0 / 100」
    // 而讓斷言失去鎖定能力，這裡統一改成精確比對，兩條測試才是真的在鎖同一件事。
    expect(el.querySelector('.num').textContent).toBe('100 / 100')
    const fill = el.querySelector('.fill')
    expect(fill.style.transform).toBe('scaleX(1)')

    app.unmount()
    el.remove()
  })

  it('數值為負時，畫面數字與血條長度都不會顯示負數（下限 0）', () => {
    const { el, app } = mount({ label: '你的體力', value: -30, max: 100, side: 'hero' })

    // 精確比對，不是 toContain：「-30 / 100」這個字串本身就包含「0 / 100」
    // 這個子字串，toContain 在這裡完全鎖不住「有沒有真的 clamp 到 0」這件事
    // ——這是突變驗證時抓到的假陽性，見上一條測試的註解。
    expect(el.querySelector('.num').textContent).toBe('0 / 100')
    const fill = el.querySelector('.fill')
    expect(fill.style.transform).toBe('scaleX(0)')

    app.unmount()
    el.remove()
  })

  it('side prop 決定套用的 class（hero／boss），用來對應不同顏色', () => {
    const hero = mount({ label: 'H', value: 1, max: 1, side: 'hero' })
    expect(hero.el.querySelector('.hp').classList.contains('hero')).toBe(true)
    hero.app.unmount()
    hero.el.remove()

    const boss = mount({ label: 'B', value: 1, max: 1, side: 'boss' })
    expect(boss.el.querySelector('.hp').classList.contains('boss')).toBe(true)
    boss.app.unmount()
    boss.el.remove()
  })

  it('不帶 side 時預設是 hero', () => {
    const { el, app } = mount({ label: 'H', value: 1, max: 1 })
    expect(el.querySelector('.hp').classList.contains('hero')).toBe(true)
    app.unmount()
    el.remove()
  })
})

describe('HpBar：segments（分形態血條，只有魔王側形態 > 1 時才會用到）', () => {
  it('沒有傳 segments：跟舊版一模一樣，只有一條 .fill，沒有 .seg', () => {
    const { el, app } = mount({ label: '魔王', value: 80, max: 100, side: 'boss' })
    expect(el.querySelectorAll('.seg').length).toBe(0)
    expect(el.querySelectorAll('.fill').length).toBe(1)
    expect(el.querySelector('.track').classList.contains('segmented')).toBe(false)
    app.unmount()
    el.remove()
  })

  it('segments 只有一個元素：視為還沒有分段（跟不傳一樣），不切換成分段版面', () => {
    const { el, app } = mount({
      label: '魔王', value: 80, max: 100, side: 'boss', segments: [{ ratio: 0.8, cleared: false }],
    })
    expect(el.querySelector('.track').classList.contains('segmented')).toBe(false)
    expect(el.querySelectorAll('.seg').length).toBe(0)
    app.unmount()
    el.remove()
  })

  it('segments 有兩個以上：切成對應數量的 .seg，每段各自的 scaleX 對應自己的 ratio', () => {
    const { el, app } = mount({
      label: '魔王', value: 30, max: 100, side: 'boss',
      segments: [{ ratio: 1, cleared: true }, { ratio: 0.3, cleared: false }],
    })
    const segs = el.querySelectorAll('.seg')
    expect(segs.length).toBe(2)
    expect(segs[0].classList.contains('cleared')).toBe(true)
    expect(segs[0].querySelector('.fill').style.transform).toBe('scaleX(1)')
    expect(segs[1].classList.contains('cleared')).toBe(false)
    expect(segs[1].querySelector('.fill').style.transform).toBe('scaleX(0.3)')
    app.unmount()
    el.remove()
  })

  it('segments 不影響 value/max 顯示的數字與 aria-*：那些永遠是當前形態的即時值，不是分段資料', () => {
    const { el, app } = mount({
      label: '魔王', value: 30, max: 100, side: 'boss',
      segments: [{ ratio: 1, cleared: true }, { ratio: 0.3, cleared: false }],
    })
    expect(el.querySelector('.num').textContent).toBe('30 / 100')
    const bar = el.querySelector('[role="progressbar"]')
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    app.unmount()
    el.remove()
  })

  it('單一 segment 的 ratio 超出 [0,1]：跟主血條同一個 clamp，不會畫出 scaleX 超過 1 或負值', () => {
    const { el, app } = mount({
      label: '魔王', value: 30, max: 100, side: 'boss',
      segments: [{ ratio: 5, cleared: true }, { ratio: -2, cleared: false }],
    })
    const segs = el.querySelectorAll('.seg')
    expect(segs[0].querySelector('.fill').style.transform).toBe('scaleX(1)')
    expect(segs[1].querySelector('.fill').style.transform).toBe('scaleX(0)')
    app.unmount()
    el.remove()
  })

  it('.cleared 的顏色規則真的寫在原始碼裡（jsdom 不做 CSS 級聯，只能原始碼比對——只鎖 class 存不存在鎖不到顏色真的接上）', () => {
    const styleMatch = hpBarSource.match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)
    expect(styleMatch, '找不到 <style scoped> 區塊').not.toBeNull()
    const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.seg\.cleared\s+\.fill\s*\{[^}]*background:\s*var\(--c-ok\)/)
  })
})
