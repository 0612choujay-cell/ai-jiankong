import { describe, it, expect } from 'vitest'
import { framingSample, computeChestUpZoom, ZOOM_MAX } from './zoomFraming.js'

const lm = (o) => {
  const a = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }))
  Object.assign(a[0], o.nose); Object.assign(a[11], o.l); Object.assign(a[12], o.r)
  return a
}
const good = lm({ nose: { x: 0.5, y: 0.35 }, l: { x: 0.6, y: 0.55 }, r: { x: 0.4, y: 0.55 } })

describe('zoomFraming', () => {
  it('returns null when shoulders are not visible', () => {
    expect(framingSample(lm({ nose: {}, l: { visibility: 0.1 }, r: {} }))).toBeNull()
    expect(framingSample(null)).toBeNull()
  })
  it('zooms in (>1) and stays inside the frame', () => {
    const s = framingSample(good)
    const z = computeChestUpZoom([s, s, s], { w: 640, h: 480 }, { w: 640, h: 480 })
    expect(z.scale).toBeGreaterThan(1)
    expect(z.scale).toBeLessThanOrEqual(ZOOM_MAX)
    expect(z.tx).toBeLessThanOrEqual(0)
    expect(z.ty).toBeLessThanOrEqual(0)
    expect(z.tx).toBeGreaterThanOrEqual(640 - z.scale * 640)
    expect(z.ty).toBeGreaterThanOrEqual(480 - z.scale * 480)
  })
  it('does not zoom when already close, and handles empty input', () => {
    const near = framingSample(lm({ nose: { x: 0.5, y: 0.3 }, l: { x: 0.85, y: 0.7 }, r: { x: 0.15, y: 0.7 } }))
    expect(computeChestUpZoom([near], { w: 640, h: 480 }, { w: 640, h: 480 }).scale).toBe(1)
    expect(computeChestUpZoom([], { w: 640, h: 480 }, { w: 640, h: 480 })).toBeNull()
  })
})
