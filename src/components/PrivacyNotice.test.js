// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, nextTick } from 'vue'

// vi.mock 工廠會被 hoist 到檔案最上面（在下面的 `import PrivacyNotice ...`
// 之前）——工廠函式本身在這裡就會被呼叫一次，所以不能讓它直接參照任何
// 之後才賦值的外部變數（PermissionGate.test.js 用巢狀 closure 延後存取
// 躲開這個限制；這裡直接讓工廠自己建立 vi.fn()，再把同一個 mock 匯入回來
// 操控，兩種寫法都繞開了同一個 TDZ 陷阱）。
vi.mock('../core/storageService.js', () => ({ clearAll: vi.fn() }))

import PrivacyNotice from './PrivacyNotice.vue'
import privacyNoticeSource from './PrivacyNotice.vue?raw'
import { clearAll } from '../core/storageService.js'

// 這個年齡層的產品文案紅線（跟 ConfirmDialog.test.js 用同一份清單）。
// 這個檔案的文字不受 15 字上限（見元件檔頭註解），所以這裡不檢查長度。
const BANNED_WORDS = ['懶惰', '摸魚', '沒用', '果然做不到', '笨', '胖', '醜']

function mountWithHandlers(handlers = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const Host = {
    components: { PrivacyNotice },
    template: '<PrivacyNotice @agree="onAgree" />',
    setup() { return { onAgree: handlers.agree ?? (() => {}) } },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app }
}

async function flush() {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await nextTick()
}

describe('PrivacyNotice：授權前先說明用途（Task 19）', () => {
  beforeEach(() => {
    clearAll.mockReset()
    clearAll.mockResolvedValue(true)
  })

  it('預設不展開家長版說明；標題與內文不含任何禁用詞', () => {
    const { el, app } = mountWithHandlers()
    expect(el.querySelector('.detail')).toBeNull()
    expect(el.querySelector('h1').textContent).toBe('專注討伐戰：分心大魔王')
    for (const word of BANNED_WORDS) expect(el.textContent).not.toContain(word)
    app.unmount()
    el.remove()
  })

  it('展開／收起家長版完整說明，三個段落標題都在；展開後（字最多的地方）同樣不含任何禁用詞（複審第 1 輪 I2）', async () => {
    const { el, app } = mountWithHandlers()
    const moreBtn = el.querySelector('button.more')
    expect(moreBtn.getAttribute('aria-expanded')).toBe('false')

    moreBtn.click()
    await nextTick()
    expect(moreBtn.getAttribute('aria-expanded')).toBe('true')
    expect(moreBtn.textContent).toBe('收起說明')
    const detail = el.querySelector('.detail')
    expect(detail).not.toBeNull()
    const headings = [...detail.querySelectorAll('h2')].map((h) => h.textContent)
    expect(headings).toEqual(['這個 App 會做什麼', '會存下什麼', '不會做什麼', '怎麼刪掉紀錄'])
    // 複審第 1 輪 I2：原本的禁用詞測試只掃收合狀態，展開區（家長版完整說明，
    // 字最多的地方）完全沒掃到——這裡是假綠。展開之後再掃一次整個 el，
    // 涵蓋展開區的內容。
    for (const word of BANNED_WORDS) expect(el.textContent).not.toContain(word)

    moreBtn.click()
    await nextTick()
    expect(el.querySelector('.detail')).toBeNull()
    app.unmount()
    el.remove()
  })

  it('按「我知道了，開始」emit agree，且不會連帶呼叫 clearAll()', () => {
    let agreed = false
    const { el, app } = mountWithHandlers({ agree: () => { agreed = true } })
    const goBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === '我知道了，開始')
    goBtn.click()
    expect(agreed).toBe(true)
    expect(clearAll).not.toHaveBeenCalled()
    app.unmount()
    el.remove()
  })

  it('清除成功：呼叫 clearAll() 一次，顯示「已經清除了」，不顯示失敗訊息', async () => {
    const { el, app } = mountWithHandlers()
    el.querySelector('button.more').click()
    await nextTick()

    el.querySelector('button.danger').click()
    await flush()

    expect(clearAll).toHaveBeenCalledTimes(1)
    expect(el.querySelector('.cleared')).not.toBeNull()
    expect(el.textContent).toContain('已經清除了')
    expect(el.querySelector('.err')).toBeNull()
    app.unmount()
    el.remove()
  })

  it('更正 4：clearAll() 失敗時不冒出 unhandled rejection、畫面不留白，且訊息誠實反映「一部分真的清掉了」', async () => {
    clearAll.mockRejectedValue(new Error('boom'))
    const { el, app } = mountWithHandlers()
    el.querySelector('button.more').click()
    await nextTick()

    // clearAll() reject 時，onClear() 沒有 try/catch 的話這裡會拋出未捕捉的
    // rejection（測試環境下 vitest 會把它記成 unhandled rejection，不一定會讓
    // 這個 expect 本身變紅，所以下面接著檢查畫面真的有反應，而不是只檢查
    // 「沒有丟出同步例外」）。
    expect(() => el.querySelector('button.danger').click()).not.toThrow()
    await flush()

    expect(clearAll).toHaveBeenCalledTimes(1)
    // 不能謊稱「已經清除了」——那句話只保留給真正成功的情況。
    expect(el.querySelector('.cleared')).toBeNull()
    const errEl = el.querySelector('.err')
    expect(errEl).not.toBeNull()
    // storageService.js 的 clearAll() 先同步清掉 localStorage 的 crumb，才去開
    // IndexedDB——IndexedDB 失敗時「暫存的那份」已經真的沒了，訊息要誠實反映
    // 這件事，不能讓家長以為按了按鈕什麼都沒發生。
    expect(errEl.textContent).toContain('暫存的紀錄已經清掉')
    app.unmount()
    el.remove()
  })

  // 複審第 1 輪 I4：jsdom 不算版面（getBoundingClientRect 恆為 0），沒辦法
  // 直接斷言橫式視窗下 .go 按鈕有沒有被推到摺線以下——跟 App.mount.test.js
  // 鎖 health-overlay position:fixed 同一個既有先例，改成鎖「造成推移的那個
  // 結構性事實」本身：家長版展開說明在橫式必須有高度上限＋內部捲動，這樣
  // .go 按鈕的位置就不會隨展開內容的長度變化，不管內容多長都一樣。
  it('複審第 1 輪 I4：橫式下 .detail 必須有高度上限＋內部捲動，不能讓展開內容把 .go 按鈕推出視窗（原始碼結構護欄）', () => {
    const landscapeBlock = privacyNoticeSource.match(/@media \(orientation: landscape\)[^}]*\{[^}]*\.detail[^}]*\{([^}]*)\}/)
    expect(landscapeBlock, '找不到橫式下針對 .detail 的規則').not.toBeNull()
    const rule = landscapeBlock[1]
    expect(rule).toMatch(/max-height/)
    expect(rule).toMatch(/overflow-y:\s*auto/)
  })

  // I4c（Task 22b-3 收尾）：jsdom 的 scrollHeight/clientHeight 恆為 0、
  // scrollTop 雖然可以指派但不會反映任何真實版面，測不出「橫式視窗下
  // .detail 真的被截斷」這件事。這裡測的是抽出來的判斷邏輯本身
  // （computeScrollHint()：截斷 && 沒捲到底 → 該不該顯示提示），做法是
  // 用 Object.defineProperty 蓋掉 scrollHeight/clientHeight 這兩個唯讀的
  // getter、直接指派 scrollTop，再手動 dispatch 一個 'scroll' 事件觸發
  // 元件內的 updateScrollHint()。**誠實聲明**：這條測試鎖不到真實版面
  // ——橫式 iPad 上 .detail 的內容到底有沒有被截斷、提示會不會真的貼著
  // 捲動容器底部、有沒有蓋到最後一行文字，這些都要靠實機（iPad 橫向）
  // 驗收，不是這裡能保證的。
  describe('PrivacyNotice：I4c 橫式捲動提示——只在真的被截斷、且還沒捲到底時出現', () => {
    function setMetrics(el, { scrollHeight, clientHeight, scrollTop }) {
      Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
      el.scrollTop = scrollTop
    }

    // 用 document.createEvent 而不是 `new Event(...)`：專案的 eslint 全域
    // 清單沒有列 Event（跟 session.test.js 的既有先例同一個理由）。
    function fireScroll(el) {
      const ev = document.createEvent('Event')
      ev.initEvent('scroll', true, true)
      el.dispatchEvent(ev)
    }

    async function openDetail(el) {
      el.querySelector('button.more').click()
      await nextTick()
      return el.querySelector('.detail')
    }

    it('內容沒有被截斷（scrollHeight===clientHeight）：不顯示提示', async () => {
      const { el, app } = mountWithHandlers()
      const detail = await openDetail(el)

      setMetrics(detail, { scrollHeight: 300, clientHeight: 300, scrollTop: 0 })
      fireScroll(detail)
      await nextTick()

      expect(el.querySelector('.scroll-hint')).toBeNull()
      app.unmount()
      el.remove()
    })

    it('被截斷、還沒捲到底：顯示提示', async () => {
      const { el, app } = mountWithHandlers()
      const detail = await openDetail(el)

      setMetrics(detail, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 })
      fireScroll(detail)
      await nextTick()

      expect(el.querySelector('.scroll-hint')).not.toBeNull()
      expect(el.querySelector('.scroll-hint').textContent).toContain('往下滑')
      app.unmount()
      el.remove()
    })

    it('被截斷但已經捲到底：提示消失', async () => {
      const { el, app } = mountWithHandlers()
      const detail = await openDetail(el)

      setMetrics(detail, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 })
      fireScroll(detail)
      await nextTick()
      expect(el.querySelector('.scroll-hint'), '先確認真的出現過，不是本來就沒渲染').not.toBeNull()

      setMetrics(detail, { scrollHeight: 600, clientHeight: 300, scrollTop: 300 })
      fireScroll(detail)
      await nextTick()

      expect(el.querySelector('.scroll-hint')).toBeNull()
      app.unmount()
      el.remove()
    })

    it('+1px 容差：scrollTop 只差 0.5px 沒到底（浮點捨入誤差）仍視為已到底，不留下永遠關不掉的提示', async () => {
      const { el, app } = mountWithHandlers()
      const detail = await openDetail(el)

      setMetrics(detail, { scrollHeight: 600.4, clientHeight: 300, scrollTop: 299.9 })
      fireScroll(detail)
      await nextTick()

      expect(el.querySelector('.scroll-hint')).toBeNull()
      app.unmount()
      el.remove()
    })

    it('收起再展開：提示狀態會歸零重算，不會沿用上一次展開的殘留判斷', async () => {
      const { el, app } = mountWithHandlers()
      const detail1 = await openDetail(el)
      setMetrics(detail1, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 })
      fireScroll(detail1)
      await nextTick()
      expect(el.querySelector('.scroll-hint')).not.toBeNull()

      el.querySelector('button.more').click() // 收起
      await nextTick()
      expect(el.querySelector('.detail')).toBeNull()

      el.querySelector('button.more').click() // 重新展開，新的 .detail 元素預設 0/0
      await nextTick()
      // 還沒收到任何 scroll 事件、也還沒真正量到版面（jsdom 恆 0/0），
      // 不該殘留上一輪「顯示中」的狀態。
      expect(el.querySelector('.scroll-hint')).toBeNull()

      app.unmount()
      el.remove()
    })

    it('同意按鈕不在 .detail 捲動容器內部，跟隨一般頁面捲動就摸得到（設計決定：按鈕留在容器外、屬於一般文件流，見元件註解）', async () => {
      const { el, app } = mountWithHandlers()
      const detail = await openDetail(el)

      expect(detail.querySelector('.go')).toBeNull()
      expect(el.querySelector('.go')).not.toBeNull()

      app.unmount()
      el.remove()
    })

    it('.scroll-hint 不得用 pointer-events 攔截捲動（原始碼護欄）', () => {
      const hintBlock = privacyNoticeSource.match(/\.scroll-hint\s*\{([^}]*)\}/)
      expect(hintBlock, '找不到 .scroll-hint 規則').not.toBeNull()
      expect(hintBlock[1]).toMatch(/pointer-events:\s*none/)
    })
  })
})
