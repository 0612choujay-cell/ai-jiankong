// @vitest-environment jsdom
//
// 這個檔案最重要的一條是「使用者按下同意之前，getUserMedia 一次都沒有被
// 呼叫過」——那正是整個 Task 19 存在的理由（授權前先說明用途）。這裡把
// session.boot()（唯一會呼叫 getUserMedia 的入口）整支 mock 掉，直接斷言
// 它的呼叫次數，而不是斷言某個更下游、每一層防禦都會收斂到的粗粒度終態。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from 'vue'

const bootMock = vi.fn()
vi.mock('../stores/session.js', () => ({ useSession: () => ({ boot: bootMock }) }))

import PermissionGate from './PermissionGate.vue'

function mountWithHandlers(props = {}, handlers = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const Host = {
    components: { PermissionGate },
    template: '<PermissionGate v-bind="props" @granted="onGranted" />',
    setup() { return { props, onGranted: handlers.granted ?? (() => {}) } },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app }
}

async function flush() {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('PermissionGate：授權前先說明用途（Task 19）', () => {
  beforeEach(() => {
    bootMock.mockReset()
  })

  it('關鍵護欄：掛載後、使用者按下「開啟鏡頭」之前，session.boot()（getUserMedia 的唯一入口）一次都不會被呼叫', () => {
    mountWithHandlers()
    expect(bootMock).not.toHaveBeenCalled()
  })

  it('按下「開啟鏡頭」：呼叫 session.boot() 一次，成功後 emit granted', async () => {
    bootMock.mockResolvedValue({ ok: true })
    let granted = false
    const { el, app } = mountWithHandlers({ videoEl: null }, { granted: () => { granted = true } })

    const btn = el.querySelector('button.primary')
    expect(btn.textContent.trim()).toBe('開啟鏡頭')
    btn.click()
    await flush()

    expect(bootMock).toHaveBeenCalledTimes(1)
    expect(granted).toBe(true)
    app.unmount()
    el.remove()
  })

  it('NotAllowedError：切到五步驟設定路徑＋「我設定好了，重試」，不顯示通用錯誤訊息', async () => {
    bootMock.mockResolvedValue({ ok: false, error: { name: 'NotAllowedError' } })
    const { el, app } = mountWithHandlers({ videoEl: null })

    el.querySelector('button.primary').click()
    await flush()

    expect(el.textContent).toContain('鏡頭被擋住了')
    const steps = el.querySelectorAll('ol.steps li')
    expect(steps.length).toBe(5)
    const retryBtn = el.querySelector('button.primary')
    expect(retryBtn.textContent).toBe('我設定好了，重試')
    expect(el.querySelector('.err')).toBeNull()
    app.unmount()
    el.remove()
  })

  // 複審第 1 輪 I5：五步驟設定路徑本身沒有任何護欄——路徑寫錯，家長照著找不到，
  // 這條復原路徑就等於不存在。鎖步驟數與四個關鍵字（設定／Safari／相機／
  // 詢問或允許），不鎖逐字文案（措辭可以調整，但這四個地標不能不見）。
  it('複審第 1 輪 I5：五步驟設定路徑含四個關鍵地標（設定／Safari／相機／詢問或允許）', async () => {
    bootMock.mockResolvedValue({ ok: false, error: { name: 'NotAllowedError' } })
    const { el, app } = mountWithHandlers({ videoEl: null })

    el.querySelector('button.primary').click()
    await flush()

    const stepsText = [...el.querySelectorAll('ol.steps li')].map((li) => li.textContent).join(' / ')
    expect(stepsText).toContain('設定')
    expect(stepsText).toContain('Safari')
    expect(stepsText).toContain('相機')
    expect(stepsText.includes('詢問') || stepsText.includes('允許')).toBe(true)

    app.unmount()
    el.remove()
  })

  it('spec 範圍：NotAllowedError 以外的錯誤（例如 NotReadableError）走通用訊息，不進五步驟畫面；主句不放英文錯誤代碼（複審第 1 輪 I1）', async () => {
    bootMock.mockResolvedValue({ ok: false, error: { name: 'NotReadableError' } })
    const { el, app } = mountWithHandlers({ videoEl: null })

    el.querySelector('button.primary').click()
    await flush()

    expect(el.textContent).not.toContain('鏡頭被擋住了')
    expect(el.querySelector('ol.steps')).toBeNull()
    const err = el.querySelector('.err')
    expect(err).not.toBeNull()
    // I1：主句要提到「分頁」——這是展場最常見的情境（前一位訪客的分頁還開著），
    // 舊版寫「其他 App」漏掉了這個情境。
    expect(err.textContent).toContain('分頁')
    // I1：error.name 不得混在主句裡（一段英文代碼擋在小孩看得懂的句子中間），
    // 只准出現在次要的「技術細節」小字裡。
    expect(err.textContent).not.toContain('NotReadableError')
    expect(el.textContent).toContain('技術細節：NotReadableError')
    app.unmount()
    el.remove()
  })

  it('複審第 1 輪 I1 裁決：NotFoundError 多給一句「這台 iPad 找不到可以用的鏡頭」——唯一一種重試必然失敗的情況', async () => {
    bootMock.mockResolvedValue({ ok: false, error: { name: 'NotFoundError' } })
    const { el, app } = mountWithHandlers({ videoEl: null })

    el.querySelector('button.primary').click()
    await flush()

    expect(el.textContent).toContain('這台 iPad 找不到可以用的鏡頭')
    expect(el.textContent).toContain('技術細節：NotFoundError')
    app.unmount()
    el.remove()
  })

  it('重試流程：NotAllowedError 之後按「我設定好了，重試」會再呼叫一次 session.boot()，成功後 emit granted', async () => {
    bootMock.mockResolvedValueOnce({ ok: false, error: { name: 'NotAllowedError' } })
    bootMock.mockResolvedValueOnce({ ok: true })
    let granted = false
    const { el, app } = mountWithHandlers({ videoEl: null }, { granted: () => { granted = true } })

    el.querySelector('button.primary').click()
    await flush()
    expect(el.textContent).toContain('鏡頭被擋住了')
    expect(granted).toBe(false)

    el.querySelector('button.primary').click() // 這次是「我設定好了，重試」
    await flush()

    expect(bootMock).toHaveBeenCalledTimes(2)
    expect(granted).toBe(true)
    app.unmount()
    el.remove()
  })

  it('請求進行中按鈕會 disabled 並顯示「開啟中…」，避免連點造成第二次 getUserMedia', async () => {
    let resolveBoot
    bootMock.mockImplementation(() => new Promise((resolve) => { resolveBoot = resolve }))
    const { el, app } = mountWithHandlers({ videoEl: null })

    const btn = el.querySelector('button.primary')
    btn.click()
    await flush()

    const workingBtn = el.querySelector('button.primary')
    expect(workingBtn.disabled).toBe(true)
    expect(workingBtn.textContent).toBe('開啟中…')

    resolveBoot({ ok: true })
    await flush()
    app.unmount()
    el.remove()
  })
})
