import { describe, it, expect } from 'vitest'
import { buildSummary } from './summary.js'
// Task 22 收尾（controller）：原本在測試裡直接寫一個四個詞的陣列，比正式清單
// 少了「笨」「胖」「醜」。改成 import 單一來源，日後 copyGuardrail.js 加詞，
// 這條測試會自動跟上，不需要有人記得來補。
import { BANNED_WORDS } from './copyGuardrail.js'

const record = {
  id: 's-record',
  durationMs: 15 * 60_000,
  postureDurationMs: { upright: 11 * 60_000, slouch: 3 * 60_000, forwardHead: 60_000, drowsy: 0, gazeAway: 0 },
  distractionDurationMs: { phone: 0, away: 0 },
  attacks: 120, score: 1200, result: 'victory',
  startedAt: Date.parse('2026-09-11T10:00:00Z'),
}

describe('buildSummary', () => {
  it('沒有歷史時走冷啟動分支，含分鐘數、端正分鐘、百分比與刀數', () => {
    const { headline } = buildSummary(record, [])
    expect(headline).toContain('15')
    expect(headline).toContain('11')
    expect(headline).toContain('73%')
    expect(headline).toContain('120')
  })

  it('冷啟動分支不得提到昨天或連續天數', () => {
    const { headline } = buildSummary(record, [])
    for (const w of ['昨', '連續', '天']) expect(headline).not.toContain(w)
  })

  it('有歷史且端正比例進步時，提到進步', () => {
    const worse = {
      ...record,
      id: 's-worse',
      postureDurationMs: { ...record.postureDurationMs, upright: 6 * 60_000 },
      startedAt: record.startedAt - 86_400_000,
    }
    const { headline } = buildSummary(record, [worse])
    expect(headline).toContain('進步')
  })

  it('有歷史但沒進步時退回最高頻姿態問題', () => {
    const better = {
      ...record,
      id: 's-better',
      postureDurationMs: { ...record.postureDurationMs, upright: 14 * 60_000 },
      startedAt: record.startedAt - 86_400_000,
    }
    const { headline } = buildSummary(record, [better])
    expect(headline).toContain('駝背')
  })

  it('永遠給出下次目標，且目標高於本次', () => {
    const { nextGoal } = buildSummary(record, [])
    expect(nextGoal).toContain('%')
    const target = Number(nextGoal.match(/(\d+)%/)[1])
    expect(target).toBeGreaterThan(73)
  })

  it('端正比例已達 95% 以上時目標封頂在 100，不得超過', () => {
    const great = { ...record, postureDurationMs: { ...record.postureDurationMs, upright: 15 * 60_000 } }
    const target = Number(buildSummary(great, []).nextGoal.match(/(\d+)%/)[1])
    expect(target).toBeLessThanOrEqual(100)
  })

  it('沒有任何姿態問題時不硬湊出一個問題來講', () => {
    const perfect = {
      ...record,
      postureDurationMs: { upright: 15 * 60_000, slouch: 0, forwardHead: 0, drowsy: 0, gazeAway: 0 },
    }
    const { headline } = buildSummary(perfect, [])
    expect(headline).not.toContain('最常發生')
  })

  it('文案不含禁用詞', () => {
    const { headline, nextGoal } = buildSummary(record, [])
    for (const w of BANNED_WORDS) {
      expect(headline + nextGoal).not.toContain(w)
    }
  })

  // ── 更正 3：history 必須用 record.id 濾掉本場自己 ──────────────────────
  //
  // 真實呼叫路徑（session.js 的 endBattle()）是先 saveSession(本場) 再
  // listSessions() 抓歷史，所以 history 的第一筆就是本場自己，跟這裡手工
  // 模擬的情境一模一樣。這條測試是這個更正的全部價值所在：拿掉 record.id
  // 過濾邏輯的話，`prev` 會排序選到 startedAt 更新的 selfCopy（跟本場一樣
  // 的 startedAt），prevUp 會等於 up，「進步」分支永遠不成立，這條測試會
  // 變紅，而 brief 原始版本手工餵的 history 從不含本場自己，完全測不出來。
  it('history 陣列裡放進本場紀錄本身，仍然要走到「進步」分支', () => {
    const worse = {
      ...record,
      id: 's-worse',
      postureDurationMs: { ...record.postureDurationMs, upright: 6 * 60_000 },
      startedAt: record.startedAt - 86_400_000,
    }
    const selfCopy = { ...record } // 同一個 id、同一個 startedAt——模擬 listSessions() 抓回本場自己
    const { headline } = buildSummary(record, [selfCopy, worse])
    expect(headline).toContain('進步')
  })

  // ── 更正 4：下次目標拿掉絕對下限 ──────────────────────────────────────
  it('端正比例 20% 的紀錄，下次目標必須 ≤30（不得被拉到 65 這種絕對下限）', () => {
    const low = { ...record, postureDurationMs: { ...record.postureDurationMs, upright: 3 * 60_000 } }
    const { nextGoal } = buildSummary(low, [])
    const target = Number(nextGoal.match(/(\d+)%/)[1])
    expect(target).toBeLessThanOrEqual(30)
    expect(target).toBe(25) // 20% + 5，鎖住精確值，不是只鎖上限
  })

  // ── 更正 6：結算頁文案不受 15 字上限（靜態長文、不朗讀） ───────────────
  it('文案不受單句 15 字上限（見 src/data/copy/summary.js 檔頭說明）', () => {
    const { headline } = buildSummary(record, [])
    expect(headline.length).toBeGreaterThan(15)
  })
})
