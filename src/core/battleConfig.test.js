import { describe, it, expect } from 'vitest'
import { BATTLE, DEMO, bossHpFor, attackIntervalFor,
         DURATION_PRESETS, DURATION_MIN_MIN, DURATION_MAX_MIN,
         needsBreakAfter, BREAK_AFTER_MS } from './battleConfig.js'

const MIN = 60_000

describe('bossHpFor', () => {
  it('用 144 × 分鐘 × regroupMarginRatio', () => {
    for (const minutes of [15, 5, 40]) {
      const expected = Math.round(BATTLE.bossHpPerMinute * minutes * BATTLE.regroupMarginRatio)
      expect(bossHpFor(minutes * MIN, false)).toBe(expected)
    }
  })

  it('套用了 regroupMarginRatio：拿掉這個係數會被抓到', () => {
    // 鎖住「有打折」這件事本身，避免日後有人把 bossHpFor 裡的乘法拿掉。
    const noMarginHp = Math.round(BATTLE.bossHpPerMinute * (15 * MIN / 60_000))
    expect(bossHpFor(15 * MIN, false)).toBeLessThan(noMarginHp)
    expect(bossHpFor(15 * MIN, false))
      .toBe(Math.round(noMarginHp * BATTLE.regroupMarginRatio))
  })

  it('不變式：60% 專注率打出的名目傷害，乘上 regroupMarginRatio 後等於實際魔王血量', () => {
    for (const minutes of [5, 10, 15, 20, 25, 40]) {
      const durationMs = minutes * MIN
      const attacks = Math.floor(durationMs / BATTLE.attackIntervalMs)
      const hits = Math.floor(attacks * 0.6)
      const nominalHp = hits * BATTLE.damagePerAttack // 零邊際名目值，和 bossHpPerMinute 反推的那條測試互相印證
      expect(bossHpFor(durationMs, false)).toBe(Math.round(nominalHp * BATTLE.regroupMarginRatio))
    }
  })

  it('展示模式回傳固定 240，忽略傳入時長', () => {
    expect(bossHpFor(DEMO.durationMs, true)).toBe(240)
    expect(bossHpFor(15 * MIN, true)).toBe(240)
  })

  it('展示模式同樣滿足 60% 不變式', () => {
    const attacks = Math.floor(DEMO.durationMs / DEMO.attackIntervalMs)
    expect(Math.floor(attacks * 0.6) * BATTLE.damagePerAttack).toBe(DEMO.bossHp)
  })

  it('非法 durationMs 時拋錯', () => {
    expect(() => bossHpFor(NaN, false)).toThrow()
    expect(() => bossHpFor(undefined, false)).toThrow()
    expect(() => bossHpFor(0, false)).toThrow()
    expect(() => bossHpFor(-1000, false)).toThrow()
  })

  it('展示模式時不檢查 durationMs', () => {
    expect(bossHpFor(NaN, true)).toBe(240)
    expect(bossHpFor(undefined, true)).toBe(240)
    expect(bossHpFor(0, true)).toBe(240)
    expect(bossHpFor(-1000, true)).toBe(240)
  })
})

describe('attackIntervalFor', () => {
  it('一般 5 秒、展示 1 秒', () => {
    expect(attackIntervalFor(false)).toBe(5000)
    expect(attackIntervalFor(true)).toBe(1000)
  })
})

describe('時長設定', () => {
  it('可調範圍 5-40 分鐘，快捷鍵 10/15/20/25 都在範圍內', () => {
    expect(DURATION_MIN_MIN).toBe(5)
    expect(DURATION_MAX_MIN).toBe(40)
    expect(DURATION_PRESETS).toEqual([10, 15, 20, 25])
    for (const p of DURATION_PRESETS) {
      expect(p).toBeGreaterThanOrEqual(DURATION_MIN_MIN)
      expect(p).toBeLessThanOrEqual(DURATION_MAX_MIN)
    }
  })
})

describe('BATTLE 常數對齊 spec', () => {
  it('逐項比對', () => {
    expect(BATTLE.damagePerAttack).toBe(20)
    expect(BATTLE.scorePerHit).toBe(10)
    expect(BATTLE.playerHpMax).toBe(100)
    expect(BATTLE.postureDamage).toBe(3)
    expect(BATTLE.postureDamageIntervalMs).toBe(5000)
    expect(BATTLE.regroupMs).toBe(10_000)
    expect(BATTLE.regroupHp).toBe(30)
    expect(BATTLE.trapBossHealRatio).toBe(0.05)
    expect(BATTLE.trapScorePenalty).toBe(100)
    expect(BATTLE.trapUndoWindowMs).toBe(20_000)
    expect(BATTLE.phoneTrapHoldMs).toBe(3000)
    expect(BATTLE.phoneWarnAtMs).toBe(2500)
    expect(BATTLE.awayTrapMs).toBe(5000)
    expect(BATTLE.drowsyHoldMs).toBe(2000)
    expect(BATTLE.phase2RefillRatio).toBe(0.4)
    expect(BATTLE.attackIntervalMs).toBe(5000)
    expect(BATTLE.bossHpPerMinute).toBe(144)
    expect(BATTLE.focusThreshold).toBe(0.6)
  })

  it('focusThreshold 與 bossHpPerMinute 的關聯', () => {
    // 12 次攻擊/分 × 60% 專注率 × 20 傷害 = 144
    // 反推：bossHpPerMinute = (60_000 / attackIntervalMs) × focusThreshold × damagePerAttack
    const attacksPerMin = 60_000 / BATTLE.attackIntervalMs
    const expectedBossHpPerMin = attacksPerMin * BATTLE.focusThreshold * BATTLE.damagePerAttack
    expect(expectedBossHpPerMin).toBe(BATTLE.bossHpPerMinute)
  })
})

describe('needsBreakAfter（Task 20：休息回合的唯一門檻判斷）', () => {
  it('剛好 20 分鐘就要休息，19 分 59 秒不用', () => {
    expect(needsBreakAfter({ durationMs: BREAK_AFTER_MS })).toBe(true)
    expect(needsBreakAfter({ durationMs: BREAK_AFTER_MS - 1000 })).toBe(false)
  })

  it('展示模式一律不觸發（試玩 20 秒不該被請去休息三分鐘）', () => {
    expect(needsBreakAfter({ durationMs: 40 * MIN, demoMode: true })).toBe(false)
  })

  it('沒有紀錄、或紀錄少了 durationMs 時不觸發（不能靠 undefined 去比大小）', () => {
    expect(needsBreakAfter(null)).toBe(false)
    expect(needsBreakAfter(undefined)).toBe(false)
    expect(needsBreakAfter({})).toBe(false)
  })

  it('讀的是實際坐的時間，不是使用者設定的時長', () => {
    // 設 30 分鐘但兩分鐘就按結束的那一輪不需要休息。
    expect(needsBreakAfter({ durationMs: 2 * MIN, durationMin: 30 })).toBe(false)
  })
})
