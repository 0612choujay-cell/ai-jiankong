import { describe, it, expect } from 'vitest'
import { createPredictor } from './landmarkPredictor.js'

const pt = (x, y) => [{ x, y, visibility: 1 }]

describe('landmarkPredictor', () => {
  it('passes the first frame through unchanged', () => {
    const p = createPredictor()
    const lm = pt(0.5, 0.5)
    expect(p.predict(lm, 0)[0]).toEqual(lm[0])
  })
  it('extrapolates along the velocity', () => {
    const p = createPredictor({ aheadMs: 50 })
    p.predict(pt(0.5, 0.5), 0)
    const out = p.predict(pt(0.6, 0.5), 100) // 速度 0.1/100ms，往前 50ms → +0.05
    expect(out[0].x).toBeCloseTo(0.65, 5)
    expect(out[0].y).toBeCloseTo(0.5, 5)
  })
  it('does not extrapolate across a long gap and caps the lead', () => {
    const p = createPredictor({ aheadMs: 50 })
    p.predict(pt(0.5, 0.5), 0)
    expect(p.predict(pt(0.9, 0.5), 1000)[0].x).toBe(0.9)
    const q = createPredictor({ aheadMs: 500 })
    q.predict(pt(0.5, 0.5), 0)
    expect(q.predict(pt(0.6, 0.5), 10)[0].x).toBeCloseTo(0.6 + 0.1 * 1.5, 5)
  })
  it('does not mutate the input and tolerates null', () => {
    const p = createPredictor()
    const lm = pt(0.1, 0.1)
    p.predict(lm, 0); p.predict(pt(0.2, 0.1), 50)
    expect(lm[0].x).toBe(0.1)
    expect(p.predict(null, 100)).toBeNull()
  })
})
