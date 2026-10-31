import { describe, it, expect, vi } from 'vitest'
import { playBeeps, createBackAlarm } from './backAlarm.js'

const node = () => ({ connect: vi.fn(), start: vi.fn(), stop: vi.fn(), frequency: {}, gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } })
const fakeCtx = () => ({
  currentTime: 0, state: 'running', destination: {},
  createOscillator: vi.fn(node), createGain: vi.fn(node), createBufferSource: vi.fn(node),
})

describe('backAlarm', () => {
  it('plays two beeps by default', () => {
    const ctx = fakeCtx()
    expect(playBeeps(ctx)).toBe(true)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2)
    expect(playBeeps(null)).toBe(false)
  })

  it('with a recorded buffer, schedules the whole sequence on the audio clock and cancels it all on stop', () => {
    const ctx = fakeCtx()
    const alarm = createBackAlarm({ getCtx: () => ctx, getBuffer: () => ({}) })
    alarm.start()
    alarm.start() // 重複呼叫不會疊加
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(20)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(40)
    // 語音在每輪嗶聲開始後 1 秒
    const first = ctx.createBufferSource.mock.results[0].value
    expect(first.start.mock.calls[0][0]).toBeCloseTo(0.05 + 1, 5)
    const srcs = ctx.createBufferSource.mock.results.map((r) => r.value)
    alarm.stop()
    for (const s of srcs) expect(s.stop).toHaveBeenCalled()
    expect(alarm.isRunning()).toBe(false)
  })

  it('without a buffer, falls back to repeating beeps + browser speech', () => {
    vi.useFakeTimers()
    const ctx = fakeCtx()
    const alarm = createBackAlarm({ getCtx: () => ctx })
    alarm.start()
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3500)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4)
    alarm.stop()
    vi.advanceTimersByTime(10000)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })
})
