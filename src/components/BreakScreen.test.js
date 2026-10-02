// @vitest-environment jsdom
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { createApp, nextTick } from 'vue'
import BreakScreen from './BreakScreen.vue'
import breakScreenSource from './BreakScreen.vue?raw'
import { BOSS_COPY } from '../data/copy/boss.js'

// 這個年齡層的產品文案紅線。Task 22 收尾（controller）：這裡原本自己抄一份，
// 註解還寫著「跟 BattleView.test.js／StatsDashboard.test.js 同一份清單」——
// 而實際上那兩份當時已經漂移了（少掉「笨」「胖」「醜」三個外觀詞）。
// 這正是 copyGuardrail.js 當初被建立的理由（見它的檔頭：收斂自四份各自獨立、
// 互不同步的清單），只是收的時候漏了這三個檔案。改成 import 單一來源。
import { BANNED_WORDS } from '../core/copyGuardrail.js'

/**
 * 只剔除「整行都是註解」的行（複審第 1 輪 IMP-1）。
 *
 * 這裡原本是一個用正則挖掉區塊註解的通用挖空器——那是**假陰性**：原始碼裡只要
 * 有一個字串含 `/*`，它就會把後面真正的違規一起吃掉，測試看起來在保護你、實際
 * 上默默放行。主線 `src/App.mount.test.js` 為同一件事明確拒絕過挖空器，理由完整
 * 寫在那裡：挖空器要處理字串內的 `//`、未閉合的 `/*`、template 與 style 的不同
 * 註解語法，任何一處判斷錯都會變成假陰性，而假陰性沒有人會發現。
 *
 * 「整行都是註解」的行則不可能藏住真的程式碼：一行程式碼不會以 `//`、`*`、
 * `/*`、`<!--` 開頭。代價是行尾註解裡提到 `speak(` 之類的字會誤報——那是可接受
 * 的方向（由人看一眼），寧可少刪而誤報，不要多刪而默默放行。
 */
function codeLinesOnly(source) {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--'))
    })
    .join('\n')
}

function mount(props = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  let doneCount = 0
  const app = createApp(BreakScreen, { ...props, onDone: () => { doneCount += 1 } })
  app.mount(el)
  return {
    el,
    app,
    doneCount: () => doneCount,
    btn: (text) => [...el.querySelectorAll('button')].find((b) => b.textContent.includes(text)),
    unmount() { app.unmount(); el.remove() },
  }
}

beforeEach(() => {
  // 倒數跟「跳過備妥 3 秒後解除」都是真實時間；沒有假時鐘就只能 sleep 三分鐘。
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BreakScreen：三分鐘倒數', () => {
  it('一掛載就顯示 03:00，過了 60 秒顯示 02:00（不是每 tick 減 1000 的累減）', async () => {
    const m = mount()
    await nextTick()
    expect(m.el.querySelector('.clock').textContent).toBe('03:00')

    vi.advanceTimersByTime(60_000)
    await nextTick()
    expect(m.el.querySelector('.clock').textContent).toBe('02:00')

    m.unmount()
  })

  it('倒數歸零時顯示 00:00 並 emit done——而且只 emit 一次（interval 已經停掉）', async () => {
    const m = mount()
    await nextTick()

    vi.advanceTimersByTime(3 * 60_000)
    await nextTick()
    expect(m.el.querySelector('.clock').textContent).toBe('00:00')
    expect(m.doneCount()).toBe(1)

    // 再讓時間跑下去：停掉的 interval 不該繼續 emit（父層那邊 done 可能是
    // startBattle()，每秒開一場新的戰鬥是災難級的失效）。
    vi.advanceTimersByTime(30_000)
    await nextTick()
    expect(m.doneCount()).toBe(1)

    m.unmount()
  })

  it('倒數還沒歸零之前不會自己 emit done', async () => {
    const m = mount()
    await nextTick()
    vi.advanceTimersByTime(3 * 60_000 - 1000)
    await nextTick()
    expect(m.doneCount()).toBe(0)
    m.unmount()
  })
})

describe('BreakScreen：跳過要點兩下（一下就跳過等於沒有休息回合）', () => {
  it('第一下只把按鈕變成「再按一次就跳過休息」，不 emit done', async () => {
    const m = mount()
    await nextTick()

    m.btn('跳過休息').click()
    await nextTick()

    expect(m.btn('再按一次就跳過休息')).not.toBeUndefined()
    expect(m.doneCount()).toBe(0)

    m.unmount()
  })

  it('連按兩下才 emit done', async () => {
    const m = mount()
    await nextTick()

    m.btn('跳過休息').click()
    await nextTick()
    m.btn('再按一次就跳過休息').click()
    await nextTick()

    expect(m.doneCount()).toBe(1)
    m.unmount()
  })

  it('第一下之後 3 秒沒有第二下，備妥狀態要解除（不然誤觸兩次也會跳過）', async () => {
    const m = mount()
    await nextTick()

    m.btn('跳過休息').click()
    await nextTick()
    expect(m.btn('再按一次就跳過休息')).not.toBeUndefined()

    vi.advanceTimersByTime(3000)
    await nextTick()

    expect(m.btn('再按一次就跳過休息'), '3 秒後要變回原樣').toBeUndefined()
    expect(m.btn('跳過休息')).not.toBeUndefined()
    expect(m.doneCount()).toBe(0)

    // 解除之後再按一下，仍然只是重新備妥，不會跳過
    m.btn('跳過休息').click()
    await nextTick()
    expect(m.doneCount()).toBe(0)

    m.unmount()
  })

  it('第一下之後 2.9 秒內按第二下仍然算數（3 秒不是「按太快不算」）', async () => {
    const m = mount()
    await nextTick()

    m.btn('跳過休息').click()
    await nextTick()
    vi.advanceTimersByTime(2900)
    await nextTick()
    m.btn('再按一次就跳過休息').click()
    await nextTick()

    expect(m.doneCount()).toBe(1)
    m.unmount()
  })
})

describe('BreakScreen：done 只准發生一次（這個年齡層按了沒反應就會再按一次）', () => {
  it('連按兩下「休息夠了，繼續討伐」只 emit 一次 done', async () => {
    const m = mount()
    await nextTick()

    const done = m.btn('休息夠了')
    done.click()
    done.click()
    await nextTick()

    expect(m.doneCount()).toBe(1)
    m.unmount()
  })

  it('按過「休息夠了」之後倒數歸零，不會再 emit 第二次', async () => {
    const m = mount()
    await nextTick()

    m.btn('休息夠了').click()
    vi.advanceTimersByTime(3 * 60_000)
    await nextTick()

    expect(m.doneCount()).toBe(1)
    m.unmount()
  })
})

describe('BreakScreen：卸載時把 timer 清乾淨', () => {
  it('卸載之後不留任何還在跑的 timer', async () => {
    const m = mount()
    await nextTick()
    // 倒數 interval 一定在跑；再按一下跳過，讓 skipTimer 也在跑。
    m.btn('跳過休息').click()
    await nextTick()
    expect(vi.getTimerCount(), '此時兩個 timer 都該在跑').toBeGreaterThanOrEqual(2)

    m.unmount()

    expect(vi.getTimerCount(), '卸載之後不得留下任何 timer').toBe(0)
  })
})

describe('BreakScreen：內容與文案紅線', () => {
  it('顯示四則伸展建議與一句魔王休戰台詞（台詞取自 BOSS_COPY.regroup）', async () => {
    const m = mount()
    await nextTick()

    const moves = [...m.el.querySelectorAll('.moves li')].map((li) => li.textContent)
    expect(moves.length).toBe(4)
    expect(moves.every((t) => t.trim().length > 0)).toBe(true)

    const line = m.el.querySelector('.boss-line').textContent.trim()
    expect(BOSS_COPY.regroup).toContain(line)

    m.unmount()
  })

  // 複審第 1 輪 Nit-5：亂數來源改成可注入之後，「抽到哪一句」才測得出來。
  // 兩條都刻意把 Math.random 釘在會抽到**不同**索引的值上，所以「元件根本沒接
  // 上 prop」跟「元件沒有 fallback」都會確定性地紅，不是機率性地紅。
  it('注入的亂數決定抽到哪一句（真的用 prop，不是裸 Math.random）', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9) // 沒接上 prop 就會抽到最後一句
    const m = mount({ rand: () => 0 })
    await nextTick()

    expect(m.el.querySelector('.boss-line').textContent.trim()).toBe(BOSS_COPY.regroup[0])
    expect(spy, '有注入就不該再去讀 Math.random').not.toHaveBeenCalled()

    spy.mockRestore()
    m.unmount()
  })

  it('沒有注入時退回 Math.random（App.vue 不必傳任何東西）', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const m = mount()
    await nextTick()

    expect(m.el.querySelector('.boss-line').textContent.trim())
      .toBe(BOSS_COPY.regroup[BOSS_COPY.regroup.length - 1])

    spy.mockRestore()
    m.unmount()
  })

  it('rand() 回傳 1 這種邊界值不會抽到池子外面（undefined 會變成空白的一行）', async () => {
    const m = mount({ rand: () => 1 })
    await nextTick()
    expect(m.el.querySelector('.boss-line').textContent.trim())
      .toBe(BOSS_COPY.regroup[BOSS_COPY.regroup.length - 1])
    m.unmount()
  })

  it('畫面上沒有任何禁用詞／身體外觀描述', async () => {
    const m = mount()
    await nextTick()
    const text = m.el.textContent
    for (const w of BANNED_WORDS) expect(text).not.toContain(w)
    m.unmount()
  })
})

describe('BreakScreen：休息畫面不得觸發任何 TTS（休戰台詞是靜態顯示）', () => {
  it('整個生命週期（掛載、倒數歸零、按按鈕）都沒有呼叫 speechSynthesis.speak', async () => {
    const speak = vi.fn()
    const original = window.speechSynthesis
    // jsdom 沒有實作 speechSynthesis，這裡塞一個全是 spy 的替身——要是元件
    // 哪天偷偷加了一行朗讀，這條會紅。
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak, cancel: vi.fn(), getVoices: () => [] },
      configurable: true,
    })

    const m = mount()
    await nextTick()
    m.btn('跳過休息').click()
    await nextTick()
    vi.advanceTimersByTime(3 * 60_000)
    await nextTick()

    expect(speak).not.toHaveBeenCalled()

    m.unmount()
    Object.defineProperty(window, 'speechSynthesis', { value: original, configurable: true })
  })

  // 上面那條只證明「這個元件自己沒有直接呼叫 speak」。這條是結構性防線：
  // 魔王台詞的朗讀一律走 messageQueue（唯一仲裁者），休息畫面連進那條管線
  // 都不該進——接上 voiceFeedback／messageQueue 就等於多開一個朗讀來源，
  // 而那正是紅線在防的事。
  it('原始碼不含任何朗讀管道（speak／SpeechSynthesisUtterance／voiceFeedback／messageQueue）', () => {
    // 先把「整行都是註解」的行拿掉再比對：這個檔案的註解本來就會**提到**這些
    // 名字（在解釋為什麼不用它們），拿整份原始碼去比對會變成「註解寫得越清楚
    // 越紅」，那是一條會逼人刪註解的假護欄。為什麼是行過濾而不是註解挖空器，
    // 見 codeLinesOnly() 上方。
    const code = codeLinesOnly(breakScreenSource)
    expect(code).not.toMatch(/\bspeak\s*\(/)
    expect(code).not.toContain('SpeechSynthesisUtterance')
    expect(code).not.toContain('voiceFeedback')
    expect(code).not.toContain('messageQueue')
    // 自我檢查：過濾之後程式碼還在（不然上面四條在空字串上恆真）。
    expect(code).toContain('BOSS_COPY.regroup')
    expect(code).toContain('const bossLine =')
  })

  it('沒有使用 v-html（結構性防線：文案池不會變成 XSS 面）', () => {
    const code = codeLinesOnly(breakScreenSource)
    expect(code).not.toContain('v-html')
    // fix round（測試鑑別力 T-6）：補上同伴們都有的自我檢查（上面那條、
    // InstallGuide.test.js:302、OfflineWarmup.test.js:237 都有）。
    // 少了它，哪天 codeLinesOnly() 的過濾規則被改壞、把整份原始碼都吃掉，
    // 上面那行會在空字串上恆真，而且不會有任何人發現——這條測試就從
    // 「守著 v-html」安靜地變成「什麼都不守」。
    expect(code).toContain('<template>')
    expect(code).toContain('BOSS_COPY.regroup')
  })
})
