import { describe, it, expect } from 'vitest'
import { createPostureCoach } from './postureCoach.js'
import { createCopyEngine } from './copyEngine.js'
import { createMessageQueue } from './messageQueue.js'
import { POSTURE_COPY } from '../data/copy/posture.js'
import { BOSS_COPY } from '../data/copy/boss.js'

function make() {
  const copy = createCopyEngine({ pools: { posture: POSTURE_COPY, boss: BOSS_COPY }, cooldownMs: 45_000 })
  const mq = createMessageQueue()
  return { coach: createPostureCoach({ copy, mq }), mq }
}

const damage = (reason) => ({ type: 'playerDamage', amount: 3, playerHp: 97, reason })

describe('createPostureCoach', () => {
  it('前 3 次用因果格式（因果標籤＋頓號＋姿態指令）', () => {
    const { coach, mq } = make()
    for (let i = 0; i < 3; i++) {
      coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, i * 46_000)
      const text = mq.current(i * 46_000).text
      expect(text).toContain('駝背了')
      expect(text).toContain('，')
      // 複審 B-2：這句是「合成」出來的，不能只信任個別片段各自 ≤15 字——
      // 這裡鎖住合成後的實際輸出；窮舉所有 reason × POSTURE_COPY 組合的
      // 完整覆蓋留給 copyGuardrail.test.js 直接呼叫 formatPostureMessage()。
      expect(text.length, `「${text}」超過 15 字`).toBeLessThanOrEqual(15)
      mq.clear()
    }
  })

  it('第 4 次起簡化為純指令', () => {
    const { coach, mq } = make()
    for (let i = 0; i < 4; i++) {
      coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, i * 46_000)
      if (i < 3) mq.clear()
    }
    const text = mq.current(3 * 46_000).text
    expect(text).not.toContain('駝背了')
    expect(POSTURE_COPY.slouch).toContain(text)
  })

  it('cooldown 內不重複發布', () => {
    const { coach, mq } = make()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 0)
    mq.clear()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 5000)
    expect(mq.current(5000)).toBe(null)
  })

  it('瞌睡走 safety 優先序，會蓋掉姿態提示', () => {
    const { coach, mq } = make()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 0)
    coach.handle([{ type: 'drowsy' }], { posture: 'slouch', drowsy: true }, 100)
    expect(POSTURE_COPY.drowsy).toContain(mq.current(100).text.replace(/^[^（]*/, '') || mq.current(100).text)
    expect(mq.current(100).kind).toBe('safety')
  })

  it('分心類提示一律不朗讀', () => {
    const { coach, mq } = make()
    coach.handle([{ type: 'trapPending', trapId: 'phone-1', kind: 'phone' }], { posture: 'upright', drowsy: false }, 0)
    expect(mq.current(0).voice).toBe(false)
    mq.clear()
    coach.handle([{ type: 'trapPending', trapId: 'away-1', kind: 'away' }], { posture: 'upright', drowsy: false }, 50_000)
    expect(mq.current(50_000).voice).toBe(false)
  })

  it('姿態提示允許朗讀，但同狀態第 2 次起關閉語音', () => {
    const { coach, mq } = make()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 0)
    expect(mq.current(0).voice).toBe(true)
    mq.clear()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 46_000)
    expect(mq.current(46_000).voice).toBe(false)
  })

  it('陷阱待確認的提示帶上 trapId，供撤銷按鈕使用', () => {
    const { coach, mq } = make()
    coach.handle([{ type: 'trapPending', trapId: 'phone-7', kind: 'phone' }], { posture: 'upright', drowsy: false }, 0)
    expect(mq.current(0).trapId).toBe('phone-7')
  })

  it('沒有相關事件時不發布任何訊息', () => {
    const { coach, mq } = make()
    coach.handle([{ type: 'attack', damage: 20, bossHp: 100, score: 10, streak: 1 }],
                 { posture: 'upright', drowsy: false }, 0)
    expect(mq.current(0)).toBe(null)
  })

  it('同一次 events 同時有 trapPending 與 playerDamage 時，姿態修正贏（PRIORITY.posture > PRIORITY.trap）', () => {
    const { coach, mq } = make()
    coach.handle(
      [
        { type: 'trapPending', trapId: 'phone-9', kind: 'phone' },
        damage('slouch'),
      ],
      { posture: 'slouch', drowsy: false },
      0,
    )
    expect(mq.current(0).kind).toBe('posture')
  })
})
