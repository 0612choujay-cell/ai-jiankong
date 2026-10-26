import { describe, it, expect } from 'vitest'
import { createEventLog, EVENT_LOG_MAX } from './eventLog.js'

const W = Date.UTC(2026, 0, 1, 12, 0, 0)

describe('eventLog', () => {
  it('records only on rising edge, with time and reason', () => {
    const log = createEventLog()
    expect(log.observe({ posture: 'upright', drowsy: false, phoneVisible: false }, 0, W)).toBe(0)
    expect(log.observe({ posture: 'slouch', drowsy: false, phoneVisible: false }, 1000, W)).toBe(1)
    expect(log.observe({ posture: 'slouch', drowsy: false, phoneVisible: false }, 2000, W)).toBe(0)
    log.observe({ posture: 'upright', drowsy: false, phoneVisible: false }, 3000, W)
    log.observe({ posture: 'slouch', drowsy: false, phoneVisible: false }, 4000, W)
    const e = log.entries()
    expect(e.map((x) => x.reason)).toEqual(['slouch', 'slouch'])
    expect(e[0]).toMatchObject({ tMs: 1000 })
    expect(e[0].at).toMatch(/^\d\d:\d\d:\d\d$/)
  })
  it('records drowsy and phone independently, only scalars', () => {
    const log = createEventLog()
    log.observe({ posture: 'upright', drowsy: true, phoneVisible: true }, 500, W)
    const e = log.entries()
    expect(e.map((x) => x.reason).sort()).toEqual(['drowsy', 'phone'])
    for (const x of e) expect(Object.keys(x).sort()).toEqual(['at', 'reason', 'tMs'])
  })
  it('caps length and resets', () => {
    const log = createEventLog({ max: 3 })
    for (let i = 0; i < 10; i++) {
      log.observe({ posture: 'slouch', phoneVisible: false }, i, W)
      log.observe({ posture: 'upright', phoneVisible: false }, i, W)
    }
    expect(log.entries().length).toBe(3)
    expect(EVENT_LOG_MAX).toBe(200)
    log.reset()
    expect(log.entries()).toEqual([])
  })
})
