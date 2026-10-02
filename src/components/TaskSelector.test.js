// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createApp, nextTick } from 'vue'
import TaskSelector from './TaskSelector.vue'
import {
  DURATION_PRESETS, DURATION_MIN_MIN, DURATION_MAX_MIN, DEFAULT_DURATION_MIN, bossHpFor,
} from '../core/battleConfig.js'
// 這個年齡層的產品文案紅線：單句 ≤15 字、不得出現對人格／外觀的負面描述。
// 這裡不靠人工複查，寫成護欄——之後任何人改文案，破線就會直接紅燈。
// Task 22a：收斂自四份各自獨立、互不同步的 BANNED_WORDS 清單，見
// src/core/copyGuardrail.js。
import { BANNED_WORDS } from '../core/copyGuardrail.js'

// TaskSelector 沒有 props，emit 用 defineEmits('start')；這個專案沒有裝
// @vue/test-utils，跟 CalibrationWizard.mount.test.js 一樣手動 createApp+mount。
// 監聽 emit（vnode 層級，不是 DOM 事件）要透過一個包一層的宿主元件，把它轉成
// 外部看得到的回呼。
function mountWithHandler(handlerName, handler) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const Host = {
    components: { TaskSelector },
    template: `<TaskSelector @${handlerName}="onEvt" />`,
    setup() {
      return { onEvt: handler }
    },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app }
}

describe('TaskSelector：預設值', () => {
  it('掛載時任務類型預設「寫作業」、時長預設 DEFAULT_DURATION_MIN，選中狀態同時用 aria-checked 標示', () => {
    const { el, app } = mountWithHandler('start', () => {})

    const radios = [...el.querySelectorAll('[role="radio"]')]
    expect(radios.length).toBe(4)
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked.length).toBe(1)
    expect(checked[0].textContent).toContain('寫作業')

    expect(el.textContent).toContain(`${DEFAULT_DURATION_MIN}`)

    app.unmount()
    el.remove()
  })

  it('不做任何選擇，直接按「準備開始」也能觸發 start，帶著預設值', () => {
    let payload = null
    const { el, app } = mountWithHandler('start', (p) => { payload = p })

    const goButton = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('準備開始'))
    expect(goButton).not.toBeUndefined()
    goButton.click()

    expect(payload).toEqual({ taskType: 'homework', durationMin: DEFAULT_DURATION_MIN, demoMode: false })

    app.unmount()
    el.remove()
  })
})

describe('TaskSelector：任務類型選擇', () => {
  it('點擊「看書」後該按鈕變成唯一 aria-checked=true，且按準備開始會帶上新的 taskType', async () => {
    let payload = null
    const { el, app } = mountWithHandler('start', (p) => { payload = p })

    const readingBtn = [...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent.includes('看書'))
    readingBtn.click()
    await nextTick()

    const checked = [...el.querySelectorAll('[role="radio"]')].filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked.length).toBe(1)
    expect(checked[0]).toBe(readingBtn)

    const goButton = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('準備開始'))
    goButton.click()
    expect(payload.taskType).toBe('reading')

    app.unmount()
    el.remove()
  })
})

describe('TaskSelector：時長步進器與邊界夾住', () => {
  it('按「增加 1 分鐘」與「減少 1 分鐘」會改變顯示的分鐘數', async () => {
    const { el, app } = mountWithHandler('start', () => {})

    const inc = el.querySelector('button[aria-label="增加 1 分鐘"]')
    const dec = el.querySelector('button[aria-label="減少 1 分鐘"]')
    expect(inc).not.toBeNull()
    expect(dec).not.toBeNull()

    inc.click()
    await nextTick()
    expect(el.textContent).toContain(`${DEFAULT_DURATION_MIN + 1}`)

    dec.click()
    dec.click()
    await nextTick()
    expect(el.textContent).toContain(`${DEFAULT_DURATION_MIN - 1}`)

    app.unmount()
    el.remove()
  })

  it('連續按「減少」超過下限時停在 DURATION_MIN_MIN，不再往下', async () => {
    const { el, app } = mountWithHandler('start', () => {})
    const dec = el.querySelector('button[aria-label="減少 1 分鐘"]')

    for (let i = 0; i < 60; i += 1) dec.click()
    await nextTick()

    const strong = el.querySelector('.minutes strong')
    expect(strong.textContent).toBe(`${DURATION_MIN_MIN}`)

    app.unmount()
    el.remove()
  })

  it('連續按「增加」超過上限時停在 DURATION_MAX_MIN，不再往上', async () => {
    const { el, app } = mountWithHandler('start', () => {})
    const inc = el.querySelector('button[aria-label="增加 1 分鐘"]')

    for (let i = 0; i < 60; i += 1) inc.click()
    await nextTick()

    const strong = el.querySelector('.minutes strong')
    expect(strong.textContent).toBe(`${DURATION_MAX_MIN}`)

    app.unmount()
    el.remove()
  })

  it('點擊時長快捷鍵（DURATION_PRESETS）會直接設成該值', async () => {
    const { el, app } = mountWithHandler('start', () => {})

    const target = DURATION_PRESETS.find((p) => p !== DEFAULT_DURATION_MIN)
    const presetBtn = [...el.querySelectorAll('.preset')].find((b) => b.textContent.includes(`${target}`))
    expect(presetBtn).not.toBeUndefined()
    presetBtn.click()
    await nextTick()

    const strong = el.querySelector('.minutes strong')
    expect(strong.textContent).toBe(`${target}`)

    app.unmount()
    el.remove()
  })
})

describe('TaskSelector：魔王血量即時顯示', () => {
  // 血量數字是單一來源 bossHpFor() 算出來的，這裡刻意不寫死任何字面值
  // （brief 附的手動驗收範例「15 分 → 2160」是舊版 regroupMarginRatio=1 算出來的、
  // 已經跟目前 battleConfig.js 的 0.85 對不上——目前 15 分鐘實際算出來是 1836。
  // 護欄只認 battleConfig.js 這個單一事實來源，不認過期的手動 QA 筆記）。
  it('切換時長時，畫面顯示的魔王血量會跟著 bossHpFor(durationMin*60000, false) 走', async () => {
    const { el, app } = mountWithHandler('start', () => {})

    const expectDefault = bossHpFor(DEFAULT_DURATION_MIN * 60_000, false)
    expect(el.textContent).toContain(`${expectDefault}`)

    const target = DURATION_PRESETS.find((p) => p !== DEFAULT_DURATION_MIN)
    const presetBtn = [...el.querySelectorAll('.preset')].find((b) => b.textContent.includes(`${target}`))
    presetBtn.click()
    await nextTick()

    const expectAfter = bossHpFor(target * 60_000, false)
    expect(el.textContent).toContain(`${expectAfter}`)

    app.unmount()
    el.remove()
  })
})

describe('TaskSelector：主按鈕不得承諾它到不了的地方', () => {
  // 【分任務校準】流程反轉之後，這顆按鈕的下一個畫面是**校準**不是戰鬥。
  // 原本的文字「開始討伐」因此變成假話，而且沒有任何測試會發現——
  // 它只是一個字串，改流程的人不會想到要回來看它。
  //
  // 這條護欄鎖的是「按鈕不得用戰鬥字眼承諾一個它到不了的畫面」。
  // 鎖不到的是：如果日後有人把流程改回去（按下去真的直接開打），
  // 這條測試會變成一條擋著正確文案的絆腳石——那時候請連同這段註解一起刪掉，
  // 不要為了讓它綠而把按鈕文字寫得更含糊。
  it('主按鈕不出現「討伐」這種戰鬥字眼——它的下一步是校準', () => {
    const { el, app } = mountWithHandler('start', () => {})

    const go = el.querySelector('button.primary.go')
    expect(go, '任務畫面要有一顆主按鈕').not.toBeNull()
    expect(go.textContent).not.toContain('討伐')
    expect(go.textContent.trim().length).toBeGreaterThan(0)
    expect(go.textContent.trim().length).toBeLessThanOrEqual(15)

    app.unmount()
    el.remove()
  })
})

describe('TaskSelector：展示模式', () => {
  it('按「展示模式」emit start 且 demoMode 為 true', () => {
    let payload = null
    const { el, app } = mountWithHandler('start', (p) => { payload = p })

    const demoBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('展示模式'))
    expect(demoBtn).not.toBeUndefined()
    demoBtn.click()

    expect(payload.demoMode).toBe(true)
    expect(payload.taskType).toBe('homework')

    app.unmount()
    el.remove()
  })
})

describe('TaskSelector：常駐隱私一行字（Task 19 複審第 1 輪 I3）', () => {
  it('底部有常駐的 .privacy-line，內容誠實（不宣稱「最靠近鏡頭」這種程式無法保證的事）', () => {
    const { el, app } = mountWithHandler('start', () => {})

    const line = el.querySelector('.privacy-line')
    expect(line).not.toBeNull()
    expect(line.textContent).toContain('離線')
    expect(line.textContent).toContain('影像不會離開這台 iPad')
    // 複審第 1 輪 B2 打回的說法：MediaPipe 不保證取到的是「最靠近鏡頭」的人。
    expect(line.textContent).not.toContain('最靠近鏡頭')
    // 合併 Task 22a 時一併修掉的 park 項目：原文「完全離線運作」講得比程式
    // 能保證的強——首次資產暖機要連網。PrivacyNotice.vue 誠實寫了這件事，
    // 主畫面這句常駐文字卻沒有，兩處對家長的說法不一致。
    // 斷言「有講到第一次要連網」而不是斷言完整句子：鎖的是這個**事實有被講出來**，
    // 不是鎖某一種措辭。
    expect(line.textContent).toContain('第一次要連網')
    expect(line.textContent).not.toContain('完全離線')

    app.unmount()
    el.remove()
  })
})

describe('TaskSelector：文案紅線（單句 ≤15 字、無禁用詞）', () => {
  it('固定文案（標題、任務標籤、按鈕）逐一檢查長度與禁用詞', () => {
    const { el, app } = mountWithHandler('start', () => {})

    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent.trim())
    expect(headings.length).toBeGreaterThan(0)
    for (const line of headings) {
      expect(line.length, `「${line}」超過 15 字`).toBeLessThanOrEqual(15)
    }

    const buttonTexts = [...el.querySelectorAll('button')].map((b) => b.textContent.trim())
    for (const line of buttonTexts) {
      expect(line.length, `「${line}」超過 15 字`).toBeLessThanOrEqual(15)
    }

    const fullText = el.textContent
    for (const word of BANNED_WORDS) {
      expect(fullText).not.toContain(word)
    }

    app.unmount()
    el.remove()
  })
})
