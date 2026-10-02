// @vitest-environment jsdom
//
// jsdom 沒有實作 canvas，`new Chart(canvasEl)` 在元件測試裡會直接炸掉——
// 這裡整包 mock 掉 chart.js，只驗證「有沒有正確地建立/銷毀 Chart 實例、
// 傳進去的資料對不對」，不驗證 Chart.js 自己畫出來的東西（那不是這個元件的
// 職責，也超出 jsdom 能力範圍）。
import { describe, it, expect, vi } from 'vitest'
import { createApp, nextTick } from 'vue'

const chartInstances = []
vi.mock('chart.js', () => {
  class FakeChart {
    constructor(el, config) {
      this.el = el
      this.config = config
      this.destroyed = false
      chartInstances.push(this)
    }

    destroy() { this.destroyed = true }
  }
  FakeChart.register = vi.fn()
  const noop = {}
  return {
    Chart: FakeChart,
    PieController: noop, ArcElement: noop, LineController: noop, LineElement: noop,
    PointElement: noop, RadarController: noop, RadialLinearScale: noop, LinearScale: noop,
    CategoryScale: noop, Tooltip: noop,
  }
})

const { default: StatsDashboard } = await import('./StatsDashboard.vue')
const { BANNED_WORDS } = await import('../core/copyGuardrail.js')

// Task 22 收尾（controller）：這裡原本自己抄一份，而且**已經漂移**——
// 少了「笨」「胖」「醜」三個身體外觀詞，也就是這個檔案的護欄比它自以為的寬鬆。
// 改成 import 單一來源（copyGuardrail.js 的建立理由就是收斂這種抄本）。

function baseRecord(overrides = {}) {
  return {
    id: 's-1',
    startedAt: Date.parse('2026-09-12T09:00:00Z'),
    durationMs: 15 * 60_000,
    postureDurationMs: { upright: 11 * 60_000, slouch: 3 * 60_000, forwardHead: 60_000, drowsy: 0, gazeAway: 0 },
    distractionDurationMs: { phone: 0, away: 0 },
    attacks: 120,
    score: 1200,
    result: 'victory',
    bossHpMax: 1000,
    bossHpRemaining: 0,
    ...overrides,
  }
}

function mount(props) {
  chartInstances.length = 0
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(StatsDashboard, props)
  app.mount(el)
  return { el, app }
}

describe('StatsDashboard：Chart 生命週期', () => {
  it('掛載時建立 3 個 Chart 實例（圓餅／折線／雷達）', () => {
    const { el, app } = mount({ record: baseRecord(), history: [], dpsSeries: [] })
    expect(chartInstances.length).toBe(3)
    app.unmount()
    el.remove()
  })

  it('卸載時對每一個 Chart 實例呼叫 destroy()——回到這個畫面不會疊上新的 Chart 實例', () => {
    const { el, app } = mount({ record: baseRecord(), history: [], dpsSeries: [] })
    expect(chartInstances.length).toBe(3)
    expect(chartInstances.every((c) => c.destroyed)).toBe(false)

    app.unmount()

    expect(chartInstances.length).toBe(3) // 沒有多建立
    expect(chartInstances.every((c) => c.destroyed)).toBe(true)
    el.remove()
  })

  it('折線圖套 parsing:false／pointRadius:0，圓餅與雷達不套（brief 的刻意偏離）', () => {
    const { el, app } = mount({ record: baseRecord(), history: [], dpsSeries: [1, 2, 3] })
    const [pie, lineChart, radar] = chartInstances

    expect(pie.config.options.parsing).not.toBe(false)
    expect(radar.config.options.parsing).not.toBe(false)
    expect(lineChart.config.options.parsing).toBe(false)
    expect(lineChart.config.data.datasets[0].pointRadius).toBe(0)

    app.unmount()
    el.remove()
  })
})

describe('StatsDashboard：更正 5——手機時間要有數字，不能只有圓餅色塊', () => {
  it('圓餅圖把「看手機」與「離開座位」拆成兩塊（不是合併成一塊「分心」）', () => {
    const { el, app } = mount({
      record: baseRecord({ distractionDurationMs: { phone: 5 * 60_000, away: 2 * 60_000 } }),
      history: [], dpsSeries: [],
    })
    const [pie] = chartInstances
    expect(pie.config.data.labels).toContain('看手機')
    expect(pie.config.data.labels).toContain('離開座位')
    expect(pie.config.data.labels).not.toContain('分心')
    expect(pie.config.data.datasets[0].data.length).toBe(7)
    app.unmount()
    el.remove()
  })

  // 複審第 1 輪 F5：上面那條測試只各自檢查兩個陣列「有沒有含這個標籤／
  // 長度對不對」，完全沒檢查「看手機」那個索引位置的數值是不是真的來自
  // phone——把 pie.config.data.datasets[0].data 裡 phone／away 的值對調，
  // 上面那條測試不會發現。這裡直接用兩個不同的數值（7 分鐘 vs. 3 分鐘），
  // 鎖住 labels[i] 與 data[i] 的索引對應關係，而不是只驗證兩個陣列各自的
  // 內容——這是更正 5（Ruling AL：用誠實的手機時間數字換掉週期性懲罰）
  // 真正成立的前提：如果標籤跟數值對調，「看手機」那塊顯示的其實是離開
  // 座位的時間，那個交換條件就是假的。
  it('圓餅圖 labels 與 datasets[0].data 索引一一對應，看手機／離開座位不會對調', () => {
    const phoneMs = 7 * 60_000
    const awayMs = 3 * 60_000
    const { el, app } = mount({
      record: baseRecord({ distractionDurationMs: { phone: phoneMs, away: awayMs } }),
      history: [], dpsSeries: [],
    })
    const [pie] = chartInstances
    const { labels } = pie.config.data
    const data = pie.config.data.datasets[0].data
    const phoneIdx = labels.indexOf('看手機')
    const awayIdx = labels.indexOf('離開座位')
    expect(phoneIdx).toBeGreaterThanOrEqual(0)
    expect(awayIdx).toBeGreaterThanOrEqual(0)
    expect(data[phoneIdx]).toBe(Math.round(phoneMs / 1000))
    expect(data[awayIdx]).toBe(Math.round(awayMs / 1000))
    app.unmount()
    el.remove()
  })

  it('phone > 0 時，表格多一列用分鐘數呈現手機出現的時間', async () => {
    const { el, app } = mount({
      record: baseRecord({ distractionDurationMs: { phone: 12 * 60_000, away: 0 } }),
      history: [], dpsSeries: [],
    })
    await nextTick()
    expect(el.textContent).toContain('手機出現的時間')
    expect(el.textContent).toContain('12 分鐘')
    app.unmount()
    el.remove()
  })

  it('phone === 0 時不顯示這一列（不硬湊一個問題出來講）', async () => {
    const { el, app } = mount({
      record: baseRecord({ distractionDurationMs: { phone: 0, away: 3 * 60_000 } }),
      history: [], dpsSeries: [],
    })
    await nextTick()
    expect(el.textContent).not.toContain('手機出現的時間')
    app.unmount()
    el.remove()
  })

  it('手機時間極短（四捨五入為 0 分鐘）仍顯示至少 1 分鐘，不會讓「有出現過」看起來像沒發生', async () => {
    const { el, app } = mount({
      record: baseRecord({ distractionDurationMs: { phone: 5000, away: 0 } }), // 5 秒
      history: [], dpsSeries: [],
    })
    await nextTick()
    expect(el.textContent).toContain('手機出現的時間')
    expect(el.textContent).toContain('1 分鐘')
    app.unmount()
    el.remove()
  })
})

describe('StatsDashboard：更正 2——不做「休息一下再來」，底部只有兩顆按鈕', () => {
  it('emit 只有 again/home，沒有 break', async () => {
    const { el, app } = mount({ record: baseRecord(), history: [], dpsSeries: [] })
    await nextTick()
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['再討伐一次', '回主畫面'])
    app.unmount()
    el.remove()
  })

  it('按「再討伐一次」emit again，按「回主畫面」emit home', async () => {
    let againCalled = 0
    let homeCalled = 0
    const el = document.createElement('div')
    document.body.appendChild(el)
    const app = createApp(StatsDashboard, {
      record: baseRecord(), history: [], dpsSeries: [],
      onAgain: () => { againCalled += 1 },
      onHome: () => { homeCalled += 1 },
    })
    app.mount(el)
    await nextTick()

    const [again, home] = [...el.querySelectorAll('button')]
    again.click()
    home.click()

    expect(againCalled).toBe(1)
    expect(homeCalled).toBe(1)

    app.unmount()
    el.remove()
  })
})

describe('StatsDashboard：Task 20——長時段時第一顆按鈕改講「休息一下再來」', () => {
  // 仍然只有兩顆按鈕、仍然只 emit again（上面那條更正 2 的決定沒有被推翻）：
  // 改變的只有文字，以及 App.vue 接到 again 之後做什麼（App.break.test.js）。
  it('≥20 分鐘：按鈕文字變成「休息一下再來」，按鈕數量與 emit 都不變', async () => {
    let againCalled = 0
    const { el, app } = mount({
      record: baseRecord({ durationMs: 20 * 60_000 }),
      history: [], dpsSeries: [],
      onAgain: () => { againCalled += 1 },
    })
    await nextTick()

    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['休息一下再來', '回主畫面'])
    buttons[0].click()
    expect(againCalled, '仍然只 emit again，不新增第三種事件').toBe(1)

    app.unmount()
    el.remove()
  })

  it('19 分 59 秒還不到門檻：維持「再討伐一次」', async () => {
    const { el, app } = mount({
      record: baseRecord({ durationMs: 20 * 60_000 - 1000 }), history: [], dpsSeries: [],
    })
    await nextTick()
    expect(el.querySelector('.again').textContent).toBe('再討伐一次')
    app.unmount()
    el.remove()
  })

  it('展示模式再久也不觸發（評審試玩完不該被請去休息三分鐘）', async () => {
    const { el, app } = mount({
      record: baseRecord({ durationMs: 25 * 60_000, demoMode: true }), history: [], dpsSeries: [],
    })
    await nextTick()
    expect(el.querySelector('.again').textContent).toBe('再討伐一次')
    app.unmount()
    el.remove()
  })
})

describe('StatsDashboard：更正 7——顯示 storageError（結算頁是它唯一有意義的位置）', () => {
  it('storageError 有值時顯示中性提示，且是短句（≤15 字）、不含禁用詞', async () => {
    const { el, app } = mount({ record: baseRecord(), history: [], dpsSeries: [], storageError: 'TypeError' })
    await nextTick()
    expect(el.textContent).toContain('這次的紀錄沒有存起來')
    const hint = el.querySelector('.hint.warn')
    expect(hint).not.toBeNull()
    expect(hint.textContent.length).toBeLessThanOrEqual(15)
    for (const w of BANNED_WORDS) expect(hint.textContent).not.toContain(w)
    app.unmount()
    el.remove()
  })

  it('storageError 是 null 時不顯示提示', async () => {
    const { el, app } = mount({ record: baseRecord(), history: [], dpsSeries: [], storageError: null })
    await nextTick()
    expect(el.textContent).not.toContain('這次的紀錄沒有存起來')
    app.unmount()
    el.remove()
  })
})

// 複審第 1 輪 F1：storageError（存檔失敗）跟 historyError（讀歷史失敗）是兩件
// 獨立的事實，各自對應一句話，不能共用一個欄位——共用會在其中一種情境下
// 讓畫面講錯話（例如本場明明存成功了，卻顯示「這次的紀錄沒有存起來」）。
// 下面兩條測試分別鎖住兩種真實場景：只有存檔失敗、只有讀歷史失敗，各自
// 只出現對應的那一句，不出現另一句。
describe('StatsDashboard：複審第 1 輪 F1——storageError／historyError 分開顯示，各自對應各自的事實', () => {
  it('只有存檔失敗（讀歷史成功）時，只顯示「這次的紀錄沒有存起來」，不顯示「讀不到以前的紀錄」', async () => {
    const { el, app } = mount({
      record: baseRecord(), history: [], dpsSeries: [], storageError: 'TypeError', historyError: null,
    })
    await nextTick()
    expect(el.textContent).toContain('這次的紀錄沒有存起來')
    expect(el.textContent).not.toContain('讀不到以前的紀錄')
    app.unmount()
    el.remove()
  })

  it('只有讀歷史失敗（存檔成功）時，只顯示「讀不到以前的紀錄」，不顯示「這次的紀錄沒有存起來」', async () => {
    const { el, app } = mount({
      record: baseRecord(), history: [], dpsSeries: [], storageError: null, historyError: 'TypeError',
    })
    await nextTick()
    expect(el.textContent).toContain('讀不到以前的紀錄')
    expect(el.textContent).not.toContain('這次的紀錄沒有存起來')
    const hint = [...el.querySelectorAll('.hint.warn')].find((p) => p.textContent === '讀不到以前的紀錄')
    expect(hint).not.toBeUndefined()
    expect(hint.textContent.length).toBeLessThanOrEqual(15)
    for (const w of BANNED_WORDS) expect(hint.textContent).not.toContain(w)
    app.unmount()
    el.remove()
  })
})

// 複審第 1 輪 F7：record 為 null 時（理論上不該發生，但 App.vue 目前沒有任何
// 守衛擋著），複審實測掛載不會炸——這裡把這個行為釘住，不讓它變成沒人管的
// 隱性假設。
describe('StatsDashboard：複審第 1 輪 F7——record 為 null 時掛載不炸', () => {
  it('record 為 null 時仍能掛載，不丟例外，且不顯示任何百分比／刀數', async () => {
    expect(() => mount({ record: null, history: [], dpsSeries: [] })).not.toThrow()
    const { el, app } = mount({ record: null, history: [], dpsSeries: [] })
    await nextTick()
    expect(chartInstances.length).toBe(3) // 三張圖依然建立（全部是空/零資料）
    expect(el.textContent).toContain('打掉了 0%')
    app.unmount()
    el.remove()
  })
})

describe('StatsDashboard：文案紅線（靜態短句 ≤15 字、無禁用詞——headline/nextGoal 不在此限，見 summary.js）', () => {
  // fix round（測試鑑別力 T-5）：這條原本的第二層迴圈是
  //   for (const w of BANNED_WORDS) expect(label).not.toContain(w)
  // 而 `label` 是**測試檔案自己在上一行寫下的常數**——等於自己檢查自己，
  // 零鑑別力：元件渲染成什麼樣子完全不影響這個斷言。
  // 改成對**實際渲染出來的 DOM** 斷言，而且掃 innerHTML（屬性值也在裡面，
  // 跟 App.mount.test.js:479／DebugHud 的同型護欄一致）。
  //
  // 鎖得到什麼：任何**真的出現在這個畫面上**的禁用詞，包含由 summary.js
  // 算出來、copyGuardrail 的字面值掃描看不到的動態文案（headline／nextGoal／
  // topIssue 那一路），也包含掛在屬性上的文字。
  // 鎖不到什麼：這個元件在**這兩組 props 之外**的分支才會出現的文案——
  // 所以下面刻意跑「打贏」與「時間到、專注率低」兩種記錄，讓 summary.js 的
  // 兩條主要文案路徑都真的被渲染過一次。
  it('實際渲染出來的畫面（含屬性值與動態文案）沒有任何禁用詞，靜態標籤也真的在畫面上', async () => {
    const staticLabels = ['再討伐一次', '回主畫面', '時間都花在哪', '每 5 秒打出的傷害', '五項表現', '五項表現的數字']

    const cases = [
      ['打贏的記錄', baseRecord()],
      ['時間到、專注率低的記錄', baseRecord({
        result: 'timeout',
        bossHpRemaining: 400,
        postureDurationMs: { upright: 2 * 60_000, slouch: 9 * 60_000, forwardHead: 3 * 60_000, drowsy: 60_000, gazeAway: 0 },
        distractionDurationMs: { phone: 4 * 60_000, away: 90_000 },
        attacks: 12,
        score: 90,
      })],
    ]

    for (const [label, record] of cases) {
      const { el, app } = mount({ record, history: [], dpsSeries: [20, 0, 40] })
      await nextTick()

      // 自我檢查：真的渲染出東西了，下面的 not.toContain 才不是在空字串上恆真。
      const html = el.innerHTML
      expect(html.length, `${label}：innerHTML 是空的`).toBeGreaterThan(0)
      for (const s of staticLabels) {
        expect(el.textContent, `${label}：畫面上找不到「${s}」`).toContain(s)
      }

      for (const w of BANNED_WORDS) {
        expect(html, `${label}：渲染結果不得出現禁用詞「${w}」`).not.toContain(w)
      }

      app.unmount()
      el.remove()
    }
  })
})
