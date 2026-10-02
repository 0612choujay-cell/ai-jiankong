import { describe, it, expect } from 'vitest'
import { createMessageQueue, PRIORITY } from './messageQueue.js'
import { createFocusStateMachine } from './focusStateMachine.js'
import { copyKeyForEvent } from './bossDialogue.js'
import { BOSS_COPY, NO_VOICE_BOSS_KEYS } from '../data/copy/boss.js'
import { POSTURE_COPY, NO_VOICE_POSTURE_KEYS } from '../data/copy/posture.js'

/**
 * ## 為什麼這個檔案不再用 NO_VOICE_* 當窮舉來源（fix round：測試鑑別力 T-1／B-5）
 *
 * 原本這裡有一張 `NO_VOICE_TABLE = { boss: NO_VOICE_BOSS_KEYS, posture:
 * NO_VOICE_POSTURE_KEYS }`，測試迴圈「把這兩份清單裡的每一個 key 都發布一次、
 * 斷言 voice 被壓成 false」。那是套套邏輯：**它窮舉的清單就是它要驗的那份
 * 清單**。把 `'phone'` 從 `NO_VOICE_POSTURE_KEYS` 拿掉——也就是「偵測到手機
 * 出現」從此會被 TTS 念出來，正是紅線要防的「把使用者被抓包的事廣播給旁邊的
 * 人」——這條測試照樣綠，因為迴圈跟著變短了。（總審實測：全套只紅 1 條，而且
 * 紅的是 voiceArbitration.integration.test.js，不是這裡。）
 *
 * 紅線的語意不是「NO_VOICE 表裡的東西不准念」，那只是實作；語意是
 * **「分心類的提示不得朗讀」**。所以真相來源必須是「分心類有哪些」這個語意上
 * 的定義，而且要來自跟 NO_VOICE 表無關的地方。這裡用兩個獨立來源交叉推導：
 *
 * 1. **`focusStateMachine` 的 `distractionDurationMs` 桶名** ——
 *    那是整個 App 對「什麼算分心」的唯一行為定義（`tick()` 用它記帳、
 *    `openTrap()` 用同一組 kind 開陷阱、結算頁用它顯示分心時長）。它跟
 *    `data/copy/*.js` 的 NO_VOICE 表完全沒有 import 關係。
 * 2. **`bossDialogue.copyKeyForEvent()` 的 trapCommitted 映射** ——
 *    那是「一個分心 kind 會講出哪一句魔王台詞」的唯一映射器。boss 側的 key
 *    名（phoneTrap／awayTrap）因此不是測試自己寫死的字面值，而是從分心 kind
 *    推導出來的。
 *
 * 兩者都有自我檢查（推導出來的 key 必須真的存在於 POSTURE_COPY／BOSS_COPY），
 * 免得哪天推導鏈斷掉變成在空清單上跑迴圈、恆真。
 */
function distractionKinds() {
  const fsm = createFocusStateMachine({ durationMs: 60_000, demoMode: false })
  return Object.keys(fsm.snapshot().distractionDurationMs)
}

/** 分心 kind → 該念不得念的 boss 台詞 key（走真正的映射器，不是寫死字面值）。 */
function bossKeyForDistraction(kind) {
  const mapped = copyKeyForEvent({ type: 'trapCommitted', kind })
  expect(mapped, `copyKeyForEvent 對分心 kind "${kind}" 沒有映射`).not.toBe(null)
  expect(mapped.ns).toBe('boss')
  return mapped.key
}

const msg = (kind, priority, text = 't', ttlMs = 4000) => ({ kind, priority, text, ttlMs })

describe('createMessageQueue', () => {
  it('沒有訊息時 current 為 null', () => {
    expect(createMessageQueue().current(0)).toBe(null)
  })

  it('同時最多顯示一則', () => {
    const mq = createMessageQueue()
    mq.publish(msg('a', PRIORITY.battle, 'A'), 0)
    mq.publish(msg('b', PRIORITY.battle, 'B'), 0)
    expect(mq.current(0).text).toBe('A') // 同優先序時先到先得，不被後來的擠掉
  })

  it('高優先直接搶佔', () => {
    const mq = createMessageQueue()
    mq.publish(msg('battle', PRIORITY.battle, '−20'), 0)
    mq.publish(msg('posture', PRIORITY.posture, '背靠椅背'), 100)
    expect(mq.current(100).text).toBe('背靠椅背')
  })

  it('低優先直接丟棄，不排隊等高優先結束', () => {
    const mq = createMessageQueue()
    mq.publish(msg('safety', PRIORITY.safety, '休息一下', 10_000), 0)
    mq.publish(msg('battle', PRIORITY.battle, '−20'), 100)
    expect(mq.current(100).text).toBe('休息一下')
    expect(mq.current(11_000)).toBe(null) // 過期後不會冒出被丟棄的那則
  })

  it('ttl 到期後自動消失', () => {
    const mq = createMessageQueue()
    mq.publish(msg('a', PRIORITY.battle, 'A', 3000), 0)
    expect(mq.current(2999)).not.toBe(null)
    expect(mq.current(3000)).toBe(null)
  })

  it('同 kind 重複發布會刷新內容與 ttl', () => {
    const mq = createMessageQueue()
    mq.publish(msg('posture', PRIORITY.posture, '舊', 3000), 0)
    mq.publish(msg('posture', PRIORITY.posture, '新', 3000), 1000)
    expect(mq.current(1000).text).toBe('新')
    expect(mq.current(3500)).not.toBe(null)
  })

  it('過期後較低優先的新訊息可以出線', () => {
    const mq = createMessageQueue()
    mq.publish(msg('safety', PRIORITY.safety, '休息', 2000), 0)
    mq.publish(msg('battle', PRIORITY.battle, '−20', 3000), 2500)
    expect(mq.current(2500).text).toBe('−20')
  })

  it('clear 立刻清空', () => {
    const mq = createMessageQueue()
    mq.publish(msg('a', PRIORITY.safety, 'A', 10_000), 0)
    mq.clear()
    expect(mq.current(0)).toBe(null)
  })

  it('優先序常數的相對大小符合 spec', () => {
    expect(PRIORITY.safety).toBeGreaterThan(PRIORITY.posture)
    expect(PRIORITY.posture).toBeGreaterThan(PRIORITY.trap)
    expect(PRIORITY.trap).toBeGreaterThan(PRIORITY.battle)
  })
})

describe('voice 紅線：要念出聲一定要能追溯到文案 key', () => {
  it('voice:true 但沒帶 ns 會直接 throw', () => {
    const mq = createMessageQueue()
    expect(() => mq.publish(
      { kind: 'posture', priority: PRIORITY.posture, text: 't', voice: true, key: 'slouch' }, 0,
    )).toThrow(TypeError)
  })

  it('voice:true 但沒帶 key 會直接 throw', () => {
    const mq = createMessageQueue()
    expect(() => mq.publish(
      { kind: 'posture', priority: PRIORITY.posture, text: 't', voice: true, ns: 'posture' }, 0,
    )).toThrow(TypeError)
  })

  it('voice:false（或未傳）不強制要求 ns／key', () => {
    const mq = createMessageQueue()
    expect(() => mq.publish(
      { kind: 'battle', priority: PRIORITY.battle, text: '−20' }, 0,
    )).not.toThrow()
    expect(mq.current(0).text).toBe('−20')
  })

  it('每一種分心（由 focusStateMachine 的分心桶定義）的提示都無條件不朗讀，但訊息照樣顯示', () => {
    const kinds = distractionKinds()
    // 自我檢查：推導鏈還通著。沒有這行的話，哪天 snapshot 改名，下面的迴圈
    // 會在空陣列上跑零次而恆真——那正是這條測試被改寫前的病。
    expect(kinds.length, '推導不出任何分心種類，這條測試會變成恆真').toBeGreaterThan(0)

    for (const kind of kinds) {
      // posture 側：分心提示的文案 key 就是分心 kind 本身。自我檢查證明這不是
      // 測試自己編出來的 key，而是 POSTURE_COPY 裡真的有一句話的 key。
      expect(POSTURE_COPY, `POSTURE_COPY 少了分心 kind "${kind}" 的文案`)
        .toHaveProperty(kind)
      // boss 側：從 trapCommitted 事件經由真正的映射器推導出來。
      const bossKey = bossKeyForDistraction(kind)
      expect(BOSS_COPY, `BOSS_COPY 少了 "${bossKey}" 的台詞`).toHaveProperty(bossKey)

      for (const [ns, key] of [['posture', kind], ['boss', bossKey]]) {
        const mq = createMessageQueue()
        mq.publish(
          { kind: 'battle', priority: PRIORITY.battle, text: '出現了', voice: true, ns, key }, 0,
        )
        const current = mq.current(0)
        expect(current, `${ns}/${key} 的訊息不見了`).not.toBe(null)
        // 紅線是「不准念」，不是「不准顯示」——畫面文字必須照樣在。
        expect(current.text).toBe('出現了')
        expect(current.voice, `${ns}/${key} 是分心類提示，不得朗讀`).toBe(false)
      }
    }
  })

  it('NO_VOICE 兩張表的內容恰好等於「分心類」的語意定義，不多也不少（兩套真相的對帳）', () => {
    // 上面那條鎖的是行為（分心的都不准念）。這條鎖的是**表本身沒有漂移**：
    //   - 少了一項 → 上面那條會紅，這條也會紅（兩層都指向同一個原因）。
    //   - 多了一項 → 上面那條測不到（多壓幾個 key 不會讓任何分心提示被念出來），
    //     但那代表有非分心的提示被靜音了，例如把 'slouch' 誤加進去會讓
    //     「背靠椅背」這句真正需要被聽到的提醒從此消失，而且沒有任何人會發現。
    // 用排序後的完整陣列相等比對，跟 BANNED_WORDS（copyGuardrail.test.js:33）
    // 同一種鎖法。
    const kinds = distractionKinds()
    expect(kinds.length).toBeGreaterThan(0)
    expect([...NO_VOICE_POSTURE_KEYS].sort()).toEqual([...kinds].sort())
    expect([...NO_VOICE_BOSS_KEYS].sort())
      .toEqual([...new Set(kinds.map(bossKeyForDistraction))].sort())
  })

  it('不在 NO_VOICE_BOSS_KEYS 內的一般 boss 台詞仍可朗讀（反向測試，防止一律壓成 false）', () => {
    // 用 'regroup' 不用 'hit'：'hit' 現在被 NO_VOICE_PRAISE_BOSS_KEYS 關掉
    // 語音（見下面「戰況旁白太吵」那組測試），不再適合當這條反向測試的例子
    // ——這條要驗證的是「不在任何一張表內的 key 真的能念」，換一個真正
    // 兩張表都沒收錄的 key 才對。
    const mq = createMessageQueue()
    mq.publish(
      { kind: 'battle', priority: PRIORITY.battle, text: '調整一下再來', voice: true, ns: 'boss', key: 'regroup' }, 0,
    )
    expect(NO_VOICE_BOSS_KEYS).not.toContain('regroup')
    expect(mq.current(0).voice).toBe(true)
  })

  it('戰況旁白太吵（hit／combo／phase2）：voice 被壓成 false，但文字（text/current）照常顯示', () => {
    // 這幾個 key 不是分心類，不該出現在 NO_VOICE_BOSS_KEYS 裡（那條測試是
    // 上面「兩張表對帳」那條），但語音一樣要被關掉——關的是另一張表
    // （NO_VOICE_PRAISE_BOSS_KEYS），理由見 data/copy/boss.js 檔頭註解。
    for (const key of ['hit', 'combo', 'phase2']) {
      const mq = createMessageQueue()
      mq.publish(
        { kind: 'battle', priority: PRIORITY.battle, text: '測試文字', voice: true, ns: 'boss', key }, 0,
      )
      const current = mq.current(0)
      expect(current, `${key} 應該照常顯示，只是不念`).not.toBeNull()
      expect(current.text).toBe('測試文字')
      expect(current.voice, `${key} 是戰況旁白，不該被念出來`).toBe(false)
    }
  })

  it('不在 NO_VOICE_POSTURE_KEYS 內的一般 posture 台詞仍可朗讀（反向測試，防止一律壓成 false）', () => {
    const mq = createMessageQueue()
    mq.publish(
      { kind: 'posture', priority: PRIORITY.posture, text: '背靠椅背', voice: true, ns: 'posture', key: 'slouch' }, 0,
    )
    expect(NO_VOICE_POSTURE_KEYS).not.toContain('slouch')
    expect(mq.current(0).voice).toBe(true)
  })
})
