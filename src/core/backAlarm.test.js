import { describe, it, expect, vi } from 'vitest'
import { playBeeps, createBackAlarm } from './backAlarm.js'

const fakeCtx = () => {
  const node = () => ({ connect: vi.fn(), start: vi.fn(), stop: vi.fn(), frequency: {}, gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } })
  return { currentTime: 0, state: 'running', createOscillator: vi.fn(node), createGain: vi.fn(node), destination: {} }
}

describe('backAlarm', () => {
  it('plays two beeps by default', () => {
    const ctx = fakeCtx()
    expect(playBeeps(ctx)).toBe(true)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2)
    expect(playBeeps(null)).toBe(false)
  })
  it('starts once, repeats, and stops cleanly', () => {
    vi.useFakeTimers()
    const ctx = fakeCtx()
    const alarm = createBackAlarm({ getCtx: () => ctx })
    alarm.start()
    alarm.start() // 重複呼叫不會疊加
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3500)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4)
    alarm.stop()
    expect(alarm.isRunning()).toBe(false)
    vi.advanceTimersByTime(10000)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })
})
