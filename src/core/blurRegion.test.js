import { describe, it, expect } from 'vitest'
import { personEllipse, smoothEllipse, growClearRegion } from './blurRegion.js'

const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }))
lm[0] = { x: 0.5, y: 0.3, visibility: 1 }
lm[11] = { x: 0.6, y: 0.6, visibility: 1 }
lm[12] = { x: 0.4, y: 0.6, visibility: 1 }
const V = { w: 640, h: 480 }
const B = { w: 640, h: 480 }

describe('blurRegion', () => {
  it('centers the ellipse on the person', () => {
    const e = personEllipse(lm, V, B)
    expect(e.cx).toBeCloseTo(320, 0)
    expect(e.rx).toBeGreaterThan(0)
    expect(e.ry).toBeGreaterThan(0)
  })
  it('mirrors horizontally', () => {
    const shifted = lm.map((p) => ({ ...p, x: p.x - 0.2 })) // 人在原始影像左側 → 顯示在右側
    expect(personEllipse(shifted, V, B).cx).toBeGreaterThan(320)
  })
  it('returns null with too few visible points or no input', () => {
    expect(personEllipse(lm.map(() => ({ x: 0, y: 0, visibility: 0 })), V, B)).toBeNull()
    expect(personEllipse(null, V, B)).toBeNull()
  })
  it('smooths between ellipses', () => {
    const a = { cx: 0, cy: 0, rx: 10, ry: 10 }
    const b = { cx: 100, cy: 0, rx: 10, ry: 10 }
    expect(smoothEllipse(a, b).cx).toBe(50)
    expect(smoothEllipse(null, b)).toBe(b)
    expect(smoothEllipse(a, null)).toBeNull()
  })
})

describe('growClearRegion', () => {
  it('extends the clear (0) area outward by px / pxPerCell cells', () => {
    const data = new Uint8ClampedArray(9 * 1).fill(255)
    data[4] = 0
    const out = growClearRegion({ w: 9, h: 1, data }, 20, 10) // 2 格
    expect([...out.data]).toEqual([255, 255, 0, 0, 0, 0, 0, 255, 255])
  })
  it('is a no-op for 0 radius', () => {
    const m = { w: 2, h: 1, data: new Uint8ClampedArray([0, 255]) }
    expect(growClearRegion(m, 0, 10)).toBe(m)
  })
})
