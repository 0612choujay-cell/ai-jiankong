// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createApp } from 'vue'
import CoachBanner from './CoachBanner.vue'

function mountWithHandlers(props, handlers = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const Host = {
    components: { CoachBanner },
    template: `<CoachBanner v-bind="props" @undo="onUndo" @break="onBreak" />`,
    setup() {
      return { props, onUndo: handlers.undo ?? (() => {}), onBreak: handlers.break ?? (() => {}) }
    },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app }
}

describe('CoachBanner：姿態提示', () => {
  it('message 為 null 時完全不渲染，不留下空殼', () => {
    const { el, app } = mountWithHandlers({ message: null })
    expect(el.querySelector('.banner')).toBeNull()
    app.unmount()
    el.remove()
  })

  it('依 message.kind 套用對應 class，且顯示 text', () => {
    const { el, app } = mountWithHandlers({ message: { kind: 'posture', text: '背靠椅背' } })
    const banner = el.querySelector('.banner')
    expect(banner).not.toBeNull()
    expect(banner.classList.contains('posture')).toBe(true)
    expect(el.textContent).toContain('背靠椅背')
    app.unmount()
    el.remove()
  })

  it('沒有 trapId 也沒有 showBreakButton 時，不出現任何按鈕', () => {
    const { el, app } = mountWithHandlers({ message: { kind: 'battle', text: '再來一次' } })
    expect(el.querySelectorAll('button').length).toBe(0)
    app.unmount()
    el.remove()
  })

  it('trapId 存在、icon 是 phone 時出現「我沒有在玩那個」按鈕，點擊 emit undo 並帶上 trapId', () => {
    let received = null
    const { el, app } = mountWithHandlers(
      { message: { kind: 'trap', text: '偵測到手機出現', trapId: 'phone-1', icon: 'phone' } },
      { undo: (id) => { received = id } },
    )
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('我沒有在玩那個'))
    expect(btn).not.toBeUndefined()
    btn.click()
    expect(received).toBe('phone-1')
    app.unmount()
    el.remove()
  })

  it('trapId 存在、icon 是 away 時改用「我沒有離開」——文字要對得上陷阱原因，不能兩種都講同一句', () => {
    let received = null
    const { el, app } = mountWithHandlers(
      { message: { kind: 'trap', text: '你離開了專注畫面', trapId: 'away-1', icon: 'away' } },
      { undo: (id) => { received = id } },
    )
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('我沒有離開'))
    expect(btn, '應該是「我沒有離開」，不是「我沒有在玩那個」').not.toBeUndefined()
    expect(el.textContent).not.toContain('我沒有在玩那個')
    btn.click()
    expect(received).toBe('away-1')
    app.unmount()
    el.remove()
  })

  it('showBreakButton 為 true 時出現「休息一下」按鈕，點擊 emit break', () => {
    let called = false
    const { el, app } = mountWithHandlers(
      { message: { kind: 'safety', text: '眼睛快閉上囉', showBreakButton: true } },
      { break: () => { called = true } },
    )
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('休息一下'))
    expect(btn).not.toBeUndefined()
    btn.click()
    expect(called).toBe(true)
    app.unmount()
    el.remove()
  })

  it('undoRemainSec 為 null（預設）時不顯示倒數；帶數字時顯示「還剩 N 秒」', () => {
    const noCountdown = mountWithHandlers({ message: { kind: 'trap', text: 't', trapId: 'phone-1' } })
    expect(noCountdown.el.querySelector('.countdown')).toBeNull()
    noCountdown.app.unmount()
    noCountdown.el.remove()

    const withCountdown = mountWithHandlers(
      { message: { kind: 'trap', text: 't', trapId: 'phone-1' }, undoRemainSec: 12 },
    )
    expect(withCountdown.el.querySelector('.countdown').textContent).toContain('12')
    withCountdown.app.unmount()
    withCountdown.el.remove()
  })
})
