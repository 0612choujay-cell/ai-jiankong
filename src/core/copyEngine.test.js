import { describe, it, expect, vi } from 'vitest'
import { createCopyEngine } from './copyEngine.js'
// Task 22a：BANNED_WORDS 原本在這裡（跟另外三個元件測試檔）各自獨立宣告，
// 現在收斂成一份匯出常數，全域文案護欄（copyGuardrail.test.js）跟其他測試
// 檔都改成 import 同一份。
import { BANNED_WORDS } from './copyGuardrail.js'

const pools = {
  posture: { slouch: ['背靠椅背', '肩膀打開', '坐直一點', '往後靠'] },
  boss: { hit: ['再來！', '不痛不癢', '就這樣？'] },
  summary: { firstRun: ['你專注了 {minutes} 分鐘'] },
}

const make = () => createCopyEngine({ pools, cooldownMs: 45_000 })

describe('createCopyEngine', () => {
  it('第一次取句成功，repeat 為 1', () => {
    const e = make()
    const r = e.take('posture', 'slouch', {}, 0)
    expect(pools.posture.slouch).toContain(r.text)
    expect(r.repeat).toBe(1)
  })

  it('cooldown 內再取同一個 key 回傳 null', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    expect(e.take('posture', 'slouch', {}, 10_000)).toBe(null)
    expect(e.take('posture', 'slouch', {}, 44_999)).toBe(null)
  })

  it('cooldown 過後可再取，repeat 累加', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    const r = e.take('posture', 'slouch', {}, 45_000)
    expect(r).not.toBe(null)
    expect(r.repeat).toBe(2)
  })

  it('不同 key 的 cooldown 互不影響', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    expect(e.take('boss', 'hit', {}, 100)).not.toBe(null)
  })

  it('shuffle bag：整袋取完前不重複', () => {
    const e = make()
    const seen = new Set()
    for (let i = 0; i < 4; i++) {
      const r = e.take('posture', 'slouch', {}, i * 45_000)
      expect(seen.has(r.text)).toBe(false)
      seen.add(r.text)
    }
    expect(seen.size).toBe(4)
  })

  it('整袋取完後重新洗牌繼續供應', () => {
    const e = make()
    for (let i = 0; i < 9; i++) {
      expect(e.take('posture', 'slouch', {}, i * 45_000)).not.toBe(null)
    }
  })

  it('填入變數', () => {
    const e = make()
    expect(e.take('summary', 'firstRun', { minutes: 15 }, 0).text).toBe('你專注了 15 分鐘')
  })

  it('未提供的變數保留原樣，不得輸出 undefined', () => {
    const e = make()
    expect(e.take('summary', 'firstRun', {}, 0).text).toBe('你專注了 {minutes} 分鐘')
  })

  it('未知 namespace 或 key 回傳 null 而不丟例外', () => {
    const e = make()
    expect(e.take('nope', 'nope', {}, 0)).toBe(null)
    expect(e.take('posture', 'nope', {}, 0)).toBe(null)
  })

  it('resetSession 清掉 cooldown 與 repeat 計數', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    e.resetSession()
    const r = e.take('posture', 'slouch', {}, 1000)
    expect(r).not.toBe(null)
    expect(r.repeat).toBe(1)
  })

  it('peek 忽略 cooldown', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    expect(e.peek('posture', 'slouch', {})).not.toBe(null)
  })

  it('peek 不會消耗或打亂 shuffle bag，take 出句序列不受干擾', () => {
    const shufflePools = { posture: { slouch: ['A', 'B', 'C', 'D'] } }
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9)
    try {
      const e1 = createCopyEngine({ pools: shufflePools, cooldownMs: 45_000 })
      const seq1 = []
      for (let i = 0; i < 4; i++) seq1.push(e1.take('posture', 'slouch', {}, i * 45_000).text)

      const e2 = createCopyEngine({ pools: shufflePools, cooldownMs: 45_000 })
      const seq2 = []
      for (let i = 0; i < 4; i++) {
        e2.peek('posture', 'slouch', {})
        e2.peek('posture', 'slouch', {})
        e2.peek('posture', 'slouch', {})
        seq2.push(e2.take('posture', 'slouch', {}, i * 45_000).text)
      }

      expect(seq2).toEqual(seq1)
    } finally {
      randomSpy.mockRestore()
    }
  })

  it('peek 不會影響 take 的 repeat 計數', () => {
    const e = make()
    e.peek('posture', 'slouch', {})
    e.peek('posture', 'slouch', {})
    const r = e.take('posture', 'slouch', {}, 0)
    expect(r.repeat).toBe(1)
  })

  it('now 不是有限數字時拋錯，訊息帶收到的值', () => {
    const e = make()
    expect(() => e.take('posture', 'slouch', {}, undefined)).toThrow(/undefined/)
    expect(() => e.take('posture', 'slouch', {}, NaN)).toThrow(/NaN/)
  })
})

describe('文案內容紅線', () => {
  it('所有文案不得出現禁用詞', async () => {
    const posture = (await import('../data/copy/posture.js')).POSTURE_COPY
    const boss = (await import('../data/copy/boss.js')).BOSS_COPY
    const summary = (await import('../data/copy/summary.js')).SUMMARY_COPY

    const all = []
    for (const pool of [posture, boss, summary]) {
      for (const lines of Object.values(pool)) all.push(...lines)
    }
    expect(all.length).toBeGreaterThan(0)
    for (const line of all) {
      for (const word of BANNED_WORDS) {
        expect(line, `「${line}」含禁用詞「${word}」`).not.toContain(word)
      }
    }
  })

  // Task 14 fix round 1（Important）：這裡原本有一條「魔王台詞、姿態提示長度
  // 都不超過 15 字」的測試，只手動掃 BOSS_COPY／POSTURE_COPY 兩個 pool——
  // POSTURE_COPY 的 drowsy[0]「眼睛快閉上囉，起來動一動 30 秒」（17 字）因此
  // 活到現在沒被抓到。Task 22a 把這條規則收斂進全域文案護欄
  // （src/core/copyGuardrail.test.js），改成走 src/data/copy/** 的目錄遞迴
  // 掃描（含明確理由的例外清單），不再是這裡手動列舉兩個 pool 名稱——
  // 這裡繼續留著等於跟全域護欄各自維護一份會飄走的清單，違反這次要解決的
  // 問題本身，所以整條移除，長度規則只留一份在 copyGuardrail.test.js。

  it('NO_VOICE_BOSS_KEYS 每個 key 都真的存在於 BOSS_COPY', async () => {
    const { BOSS_COPY, NO_VOICE_BOSS_KEYS } = await import('../data/copy/boss.js')
    expect(NO_VOICE_BOSS_KEYS.length).toBeGreaterThan(0)
    for (const key of NO_VOICE_BOSS_KEYS) {
      expect(
        Object.prototype.hasOwnProperty.call(BOSS_COPY, key),
        `NO_VOICE_BOSS_KEYS 含未知 key「${key}」`
      ).toBe(true)
    }
  })

  it('NO_VOICE_PRAISE_BOSS_KEYS 每個 key 都真的存在於 BOSS_COPY，而且跟 NO_VOICE_BOSS_KEYS 沒有重疊（兩張表分屬不同政策，不該有交集）', async () => {
    const { BOSS_COPY, NO_VOICE_BOSS_KEYS, NO_VOICE_PRAISE_BOSS_KEYS } = await import('../data/copy/boss.js')
    expect(NO_VOICE_PRAISE_BOSS_KEYS.length).toBeGreaterThan(0)
    for (const key of NO_VOICE_PRAISE_BOSS_KEYS) {
      expect(
        Object.prototype.hasOwnProperty.call(BOSS_COPY, key),
        `NO_VOICE_PRAISE_BOSS_KEYS 含未知 key「${key}」`
      ).toBe(true)
      expect(
        NO_VOICE_BOSS_KEYS.includes(key),
        `「${key}」同時出現在兩張表——尊嚴保護與嫌吵是兩個不同的政策，不該共用同一個 key`
      ).toBe(false)
    }
  })
})
