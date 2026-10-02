// @vitest-environment jsdom
//
// 展場離線暖機面板：offlineAssets.js 的第一個 UI 呼叫點。
//
// 整個 core/offlineAssets.js 被換掉（它會真的去 fetch 35MB 的模型，而且 import
// @mediapipe/tasks-vision）——這裡驗的是 UI 怎麼用那個介面：進度、就緒、重試，
// 以及失敗時**只顯示 error.name**（隱私紅線：永不 message/stack，而 message
// 裡帶著失敗的資產 URL）。
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import { createApp, nextTick } from 'vue'
import offlineWarmupSource from './OfflineWarmup.vue?raw'

const ctl = {
  ready: false,
  result: { ok: true },
  calls: 0,
  progress: [],
  /** 手動模式：run() 停在中間，讓測試自己餵進度。 */
  manual: false,
  /** 模擬 ensureOfflineAssets 自己丟例外（不是回 { ok:false }）。 */
  throws: false,
  resolve: null,
  onProgress: null,
}

vi.mock('../core/offlineAssets.js', () => ({
  isOfflineReady: () => ctl.ready,
  ensureOfflineAssets: ({ onProgress } = {}) => {
    ctl.calls += 1
    ctl.onProgress = onProgress
    if (ctl.throws) {
      const err = new RangeError('boom-with-secret-path C:/Users/cody/models/pose.task')
      return Promise.reject(err)
    }
    onProgress?.({ done: 0, total: 4, label: null })
    if (ctl.manual) return new Promise((resolve) => { ctl.resolve = resolve })
    for (const p of ctl.progress) onProgress?.(p)
    return Promise.resolve(ctl.result)
  },
}))

// Task 22d 護欄專用：只有下面「窮舉真實 label」那條測試會用 vi.importActual()
// 繞過上面那份假介面，去跑*真正*的 offlineAssets.js（藉此讀到 ASSET_LABELS
// 真實的值，不在測試裡自己抄一份）。那條真正的模組會 import
// '@mediapipe/tasks-vision'，這裡比照 offlineAssets.test.js 已經驗證過的
// 安全作法整個 mock 掉——forVisionTasks() 只回傳假路徑，真正的下載交給下面
// 也會被 stub 掉的 global fetch，全程不會有真的網路或 WASM 探測。
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn().mockResolvedValue({ wasmLoaderPath: '/wasm-loader', wasmBinaryPath: '/wasm-binary' }) },
}))

const { default: OfflineWarmup } = await import('./OfflineWarmup.vue')

function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(OfflineWarmup)
  app.mount(el)
  return {
    el,
    app,
    panel: () => el.querySelector('.warmup'),
    text: () => el.textContent,
    button: () => el.querySelector('.act'),
    unmount() { app.unmount(); el.remove() },
  }
}

beforeEach(() => {
  ctl.ready = false
  ctl.result = { ok: true }
  ctl.calls = 0
  ctl.progress = []
  ctl.manual = false
  ctl.throws = false
  ctl.resolve = null
})

describe('OfflineWarmup：已經暖機過的裝置完全不出現', () => {
  it('isOfflineReady() 為 true 時不渲染任何東西（不佔版面、不打擾小孩）', async () => {
    ctl.ready = true
    const m = mount()
    await nextTick()
    expect(m.panel()).toBeNull()
    m.unmount()
  })

  it('還沒暖機時出現，並說明「第一次要連網」', async () => {
    const m = mount()
    await nextTick()
    expect(m.panel()).not.toBeNull()
    expect(m.text()).toContain('第一次要連網')
    expect(m.button().textContent.trim()).toBe('開始下載')
    m.unmount()
  })
})

describe('OfflineWarmup：進度與就緒', () => {
  it('下載中顯示進度（done/total 與目前項目），完成後顯示就緒、按鈕消失', async () => {
    ctl.manual = true
    const m = mount()
    await nextTick()

    m.button().click()
    await nextTick()
    expect(m.el.querySelector('[role="progressbar"]'), '下載中要有進度條').not.toBeNull()

    ctl.onProgress({ done: 2, total: 4, label: '姿勢模型' })
    await nextTick()
    expect(m.text()).toContain('2/4')
    expect(m.text()).toContain('姿勢模型')
    expect(m.el.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('2')

    ctl.resolve({ ok: true })
    await nextTick()
    await nextTick()

    expect(m.text()).toContain('遊戲資料下載完成')
    expect(m.button(), '就緒之後不該再有下載按鈕').toBeNull()
    expect(m.el.querySelector('[role="progressbar"]')).toBeNull()

    m.unmount()
  })

  it('下載中再按也不會重複觸發（按鈕在下載中根本不存在，這條是第二道保險）', async () => {
    ctl.manual = true
    const m = mount()
    await nextTick()

    m.button().click()
    await nextTick()
    expect(m.button(), '下載中不該還留著按鈕').toBeNull()
    expect(ctl.calls).toBe(1)

    ctl.resolve({ ok: true })
    await nextTick()
    m.unmount()
  })
})

describe('OfflineWarmup：失敗與重試', () => {
  it('失敗時給重試按鈕，而且只顯示 error.name——不得洩漏 message（隱私紅線）', async () => {
    const err = new Error('資產下載失敗：https://exhibition.local/models/pose_landmarker.task（HTTP 404）')
    err.name = 'TypeError'
    ctl.result = { ok: false, error: err }

    const m = mount()
    await nextTick()
    m.button().click()
    await nextTick()
    await nextTick()

    const text = m.text()
    expect(text).toContain('下載失敗')
    expect(text).toContain('TypeError')
    // 有 bug 的版本（顯示 error.message）會在這裡紅：message 帶著資產 URL。
    expect(text, '不得出現 error.message').not.toContain('pose_landmarker')
    expect(text).not.toContain('HTTP 404')
    expect(m.button().textContent.trim()).toBe('再試一次')

    m.unmount()
  })

  it('按「再試一次」會重新呼叫 ensureOfflineAssets（它自己就是重試，快取命中的項目不會重打）', async () => {
    const err = new Error('boom')
    err.name = 'NetworkError'
    ctl.result = { ok: false, error: err }

    const m = mount()
    await nextTick()
    m.button().click()
    await nextTick()
    await nextTick()
    expect(ctl.calls).toBe(1)

    ctl.result = { ok: true }
    m.button().click()
    await nextTick()
    await nextTick()

    expect(ctl.calls).toBe(2)
    expect(m.text()).toContain('遊戲資料下載完成')
    expect(m.text(), '成功之後不該還掛著上次的錯誤').not.toContain('NetworkError')

    m.unmount()
  })

  it('ensureOfflineAssets 直接丟例外時不會卡在「下載中」（Nit-2 的 try/finally）', async () => {
    ctl.throws = true
    const m = mount()
    await nextTick()
    m.button().click()
    await nextTick()
    await nextTick()

    // 沒有 finally 的版本會永遠停在 running：進度條凍住、重試按鈕
    // （v-if="!running"）不出現，展場上完全沒有出路。
    expect(m.button(), '要回得到可重試的狀態').not.toBeNull()
    expect(m.button().textContent.trim()).toBe('再試一次')
    expect(m.el.querySelector('[role="progressbar"]'), '不該還停在下載中').toBeNull()
    expect(m.text()).toContain('RangeError')
    expect(m.text(), '隱私紅線：不得洩漏 message').not.toContain('boom-with-secret-path')

    m.unmount()
  })

  it('error 沒有 name 時退回 "Error"，不會顯示 undefined', async () => {
    ctl.result = { ok: false, error: null }
    const m = mount()
    await nextTick()
    m.button().click()
    await nextTick()
    await nextTick()

    expect(m.text()).toContain('Error')
    expect(m.text()).not.toContain('undefined')
    m.unmount()
  })
})

describe('OfflineWarmup：結構性防線', () => {
  // 複審第 1 輪 Nit-3：新元件也要納入既有的 v-html 檢查（DebugHud.test.js 的
  // 先例）。只剔除「整行都是註解」的行——挖空器會有假陰性，見
  // BreakScreen.test.js 的 codeLinesOnly() 說明。
  const codeOnly = offlineWarmupSource
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--'))
    })
    .join('\n')

  it('沒有使用 v-html', () => {
    expect(codeOnly).not.toContain('v-html')
    expect(codeOnly, '自我檢查：過濾後程式碼還在').toContain('<template>')
  })

  it('畫面文案與 aria-label 都不出現「離線」（spec：不顯示線上／離線狀態）', () => {
    // 複審第 1 輪 IMP-2：aria-label 也是文案，螢幕閱讀器會唸出來。這條鎖住
    // 整個 template（含屬性值），不是只鎖看得見的那幾句。
    const template = offlineWarmupSource.slice(
      offlineWarmupSource.indexOf('<template>'),
      offlineWarmupSource.indexOf('</template>'),
    )
    const templateCode = template
      .split('\n')
      .filter((line) => !line.trim().startsWith('<!--') && !line.trim().startsWith('*'))
      .join('\n')
    expect(templateCode).not.toContain('離線')
    expect(templateCode, '自我檢查：真的抓到 template 了').toContain('aria-label')
  })
})

describe('OfflineWarmup 護欄：進度文字組合窮舉（Task 22d）', () => {
  /**
   * 背景：`下載中 ${done}/${total} ${label}` 這句原本把 label 併進同一句，
   * offlineAssets.js 的 ASSET_LABELS.wasm 是「MediaPipe 推論引擎」（14 字），
   * 併起來一律破 15 字上限——而且 wasm 是 ITEMS 第一項，這是每一台新裝置
   * 暖機時必然出現的第一句畫面文字。跟 postureCoach.js 的 CAUSE_LABEL +
   * POSTURE_COPY 是同一種「片段各自合格、組起來才破線」的盲點：
   * copyGuardrail.js 的長度規則只掃靜態字面值，看不到執行期變數代進去之後
   * 的長度（copyGuardrail.js 檔頭註解 (f) 就是在講這件事）。
   *
   * 這裡不重新在測試裡刻一份「下載中 X/Y」的公式去比對——那樣就算
   * OfflineWarmup.vue 裡真正拿去組字串的那一行壞掉，這條測試也不會知道，
   * 等於白做（brief 原話：「如果改長了還是綠，代表護欄又只是在掃靜態片段」）。
   * 改成兩層：
   *   1. 用 vi.importActual() 繞過本檔案頂部對 offlineAssets.js 的假介面，
   *      跑一次*真正*的 ensureOfflineAssets()（fetch／FilesetResolver 都
   *      stub 成瞬間成功），從它真正回報的 onProgress 事件收集 ASSET_LABELS
   *      的真實值與真實 total——不在這裡自己抄一份常數，offlineAssets.js
   *      改了哪個 label 或加了第五個資產，這裡會自動抓到新的值。
   *   2. 用本檔案原本就有的假介面實際「掛載元件」，把步驟 1 收集到的每一個
   *      label，交叉配上 0..total 的每一個 done，逐一觸發 onProgress、
   *      讀真正渲染出來的 DOM 文字（不是重算公式）斷言 ≤15 字、不含禁用詞。
   *      這樣如果有人把 OfflineWarmup.vue 裡合成文字的那一行改壞，這條測試
   *      會真的紅（已經手動驗證過，見 task-22d-report.md 的突變紀錄）。
   */
  it('對 offlineAssets.js 真實的每一個 label × 所有 done/total 組合，畫面上渲染出的每一句都 ≤15 字、不含禁用詞', async () => {
    const { MAX_SHORT_LINE_LENGTH, firstBannedWord } = await import('../core/copyGuardrail.js')

    // 步驟 1：只是要「讀真實常數」，不是真的要下載 35MB——把 fetch／
    // localStorage 都 stub 成瞬間成功／無副作用，讓真正的 ensureOfflineAssets()
    // 一口氣跑完，藉此收集它每一步回報的真實 label。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    let harvested
    try {
      const real = await vi.importActual('../core/offlineAssets.js')
      const events = []
      const result = await real.ensureOfflineAssets({ onProgress: (p) => events.push(p) })
      harvested = { result, events }
    } finally {
      vi.unstubAllGlobals()
    }

    expect(harvested.result.ok, '沒抓到真實資料就窮舉不出真正的組合，這條護欄會失去意義').toBe(true)
    const total = harvested.events[0].total
    const realLabels = [...new Set(harvested.events.map((e) => e.label).filter((l) => l))]
    expect(realLabels.length, '自我檢查：真的從 offlineAssets.js 收到至少一個 label').toBeGreaterThan(0)
    expect(realLabels.length, '自我檢查：收到的 label 數量要跟 total 對得上（每個項目一個 label）').toBe(total)

    // 步驟 2：交叉窮舉，每一組都真的掛載、餵 onProgress、讀 DOM。
    for (const label of ['', ...realLabels]) {
      for (let done = 0; done <= total; done += 1) {
        ctl.manual = true
        const m = mount()
        await nextTick()
        m.button().click()
        await nextTick()
        ctl.onProgress({ done, total, label: label || null })
        await nextTick()

        const rendered = [
          m.el.querySelector('.msg')?.textContent ?? '',
          m.el.querySelector('.msg-detail')?.textContent ?? '',
        ].filter((t) => t.length > 0)

        for (const text of rendered) {
          expect(
            text.length,
            `label=${JSON.stringify(label)} done=${done}/${total} 渲染出「${text}」，長度 ${text.length} 超過 ${MAX_SHORT_LINE_LENGTH} 字`,
          ).toBeLessThanOrEqual(MAX_SHORT_LINE_LENGTH)
          expect(
            firstBannedWord(text),
            `label=${JSON.stringify(label)} done=${done}/${total} 渲染出「${text}」，含禁用詞`,
          ).toBe(null)
        }

        ctl.resolve({ ok: true })
        await nextTick()
        m.unmount()
      }
    }
  })
})

describe('OfflineWarmup 護欄：「技術細節」不與 errorName 併句（Task 22d 第 2 輪）', () => {
  /**
   * 背景：`技術細節：{{ errorName }}` 原本併成一句，`技術細節：NetworkError`
   * 已經是 17 字，破 15 字上限——而且 NetworkError 正是離線暖機最可能出現的
   * 那一種失敗，不是罕見邊角案例。
   *
   * 跟第一件事（line／itemLabel）同一種病：字面字首＋變數併成一句。修法也
   * 一樣——把 errorName 從那句組合裡拆出來獨立成行（.detail 只留固定前綴
   * 「技術細節」，errorName 自己一行 .detail-name）。
   *
   * 這條護欄能鎖多少鎖多少，誠實分兩半：
   *   1. 固定前綴「技術細節」是**靜態、不隨 errorName 變動**的文字，可以
   *      無條件斷言 ≤15 字、不含禁用詞（用 copyGuardrail.js 的真正常數，
   *      不抄一份）。
   *   2. errorName 那一行**無法窮舉**——error.name 的定義域是瀏覽器／JS
   *      平台給的技術識別字（TypeError／RangeError／NetworkError／未來
   *      可能出現的 AbortError／QuotaExceededError……），不是像 ASSET_LABELS
   *      那樣本專案自己審過的封閉集合，沒辦法對每一種可能值斷言「≤15 字」。
   *      這裡鎖的是這個修正**真正保證**的性質：errorName 是獨立的文字節點，
   *      不論它多長、內容是什麼，都不會跟「技術細節」這個固定前綴併成同一句
   *      去疊加長度。這鎖得住迴歸：下次有人把兩行併回同一個節點，這條測試
   *      會紅（已經手動驗證，見 task-22d-report.md 的突變紀錄）。
   */
  it('固定前綴「技術細節」獨立成行且 ≤15 字、不含禁用詞；errorName 獨立成另一行，不論多長都不與前綴併句', async () => {
    const { MAX_SHORT_LINE_LENGTH, firstBannedWord } = await import('../core/copyGuardrail.js')

    // 'NetworkError' 是原本真的破線的那一個；'A'.repeat(40) 是刻意誇張長、
    // 完全不像真實例外名稱的假值，用來證明「不併句」這個性質不依賴
    // errorName 剛好夠短——就算它長到 40 字，也不該混進前綴那一行。
    for (const errorNameValue of ['NetworkError', 'A'.repeat(40)]) {
      const err = new Error('boom')
      err.name = errorNameValue
      ctl.result = { ok: false, error: err }

      const m = mount()
      await nextTick()
      m.button().click()
      await nextTick()
      await nextTick()

      const prefixEl = m.el.querySelector('.detail')
      const nameEl = m.el.querySelector('.detail-name')
      expect(prefixEl, `errorName=${errorNameValue}：找不到 .detail`).not.toBeNull()
      expect(nameEl, `errorName=${errorNameValue}：找不到 .detail-name`).not.toBeNull()

      const prefixText = prefixEl.textContent.trim()
      const nameText = nameEl.textContent.trim()

      // 不併句：兩個節點互不包含對方的內容。
      expect(prefixText, `errorName=${errorNameValue}：前綴節點不該混進 errorName`).not.toContain(errorNameValue)
      expect(nameText, `errorName=${errorNameValue}：errorName 節點不該混進前綴文字`).not.toContain('技術細節')
      expect(nameText, `errorName=${errorNameValue}：errorName 節點應該就是 errorName 本身`).toBe(errorNameValue)

      // 靜態前綴可以無條件斷言：它不隨 errorName 變動。
      expect(prefixText.length, `前綴「${prefixText}」超過 ${MAX_SHORT_LINE_LENGTH} 字`).toBeLessThanOrEqual(MAX_SHORT_LINE_LENGTH)
      expect(firstBannedWord(prefixText), `前綴「${prefixText}」含禁用詞`).toBe(null)

      // 誠實標註：這裡刻意不斷言 nameText.length ≤ 15——error.name 的定義域
      // 由瀏覽器／JS 平台決定，不在本專案控制範圍內，沒辦法窮舉去保證這件
      // 事（上面用 'A'.repeat(40) 就是刻意示範一個超過 15 字的 errorName，
      // 這條測試依然只驗證「不併句」，不驗證它本身的長度）。

      m.unmount()
    }
  })
})
