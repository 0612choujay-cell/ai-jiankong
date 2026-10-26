import { describe, it, expect, vi } from 'vitest'
import { shouldAlert, playGong, PHONE_ALERT_COOLDOWN_MS, PHONE_ALERT_TEXT } from './phoneAlert.js'
import { firstBannedWord } from './copyGuardrail.js'

describe('phoneAlert', () => {
  it('手機從沒有變成有才提醒；一直拿著不重複', () => {
    expect(shouldAlert({ wasVisible: false, isVisible: true, lastAt: null, now: 0 })).toBe(true)
    expect(shouldAlert({ wasVisible: true, isVisible: true, lastAt: null, now: 0 })).toBe(false)
    expect(shouldAlert({ wasVisible: true, isVisible: false, lastAt: null, now: 0 })).toBe(false)
  })
  it('冷卻內不再提醒，過了才可以', () => {
    expect(shouldAlert({ wasVisible: false, isVisible: true, lastAt: 1000, now: 1000 + PHONE_ALERT_COOLDOWN_MS - 1 })).toBe(false)
    expect(shouldAlert({ wasVisible: false, isVisible: true, lastAt: 1000, now: 1000 + PHONE_ALERT_COOLDOWN_MS })).toBe(true)
  })
  it('playGong 對 null 安全，有 AudioContext 時建立泛音振盪器', () => {
    expect(playGong(null)).toBe(false)
    const osc = () => ({ type: '', frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() })
    const gain = () => ({ gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() })
    const ctx = { state: 'running', currentTime: 0, destination: {}, createOscillator: vi.fn(osc), createGain: vi.fn(gain) }
    expect(playGong(ctx)).toBe(true)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(5)
  })
  it('台詞不含禁用詞且 ≤15 字', () => {
    expect(firstBannedWord(PHONE_ALERT_TEXT)).toBeNull()
    expect(PHONE_ALERT_TEXT.length).toBeLessThanOrEqual(15)
  })
})
