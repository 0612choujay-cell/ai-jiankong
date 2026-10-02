import { describe, it, expect } from 'vitest'
import { radarAxes } from './radar.js'

const record = {
  durationMs: 100_000,
  postureDurationMs: { upright: 60_000, slouch: 20_000, forwardHead: 10_000, drowsy: 5000, gazeAway: 5000 },
  distractionDurationMs: { phone: 10_000, away: 0 },
}

describe('radarAxes', () => {
  it('回傳五軸', () => {
    expect(radarAxes(record).map((a) => a.key))
      .toEqual(['upright', 'neck', 'back', 'awake', 'resist'])
  })

  it('坐姿端正＝upright 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'upright').value).toBe(60)
  })

  it('頸部健康＝1 − forwardHead 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'neck').value).toBe(90)
  })

  it('背部健康＝1 − slouch 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'back').value).toBe(80)
  })

  it('清醒度＝1 − drowsy 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'awake').value).toBe(95)
  })

  it('抗干擾＝1 − 分心總時長佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'resist').value).toBe(90)
  })

  it('軸標籤用國小生讀得懂的白話，不用術語', () => {
    const labels = radarAxes(record).map((a) => a.label)
    for (const term of ['前傾', '佔比', '指數', 'ratio']) {
      expect(labels.join('')).not.toContain(term)
    }
  })

  it('所有值夾在 0-100 之間', () => {
    const weird = {
      durationMs: 10_000,
      postureDurationMs: { upright: 0, slouch: 99_999, forwardHead: 0, drowsy: 0, gazeAway: 0 },
      distractionDurationMs: { phone: 99_999, away: 99_999 },
    }
    for (const a of radarAxes(weird)) {
      expect(a.value).toBeGreaterThanOrEqual(0)
      expect(a.value).toBeLessThanOrEqual(100)
    }
  })

  it('時長為 0 時不產生 NaN', () => {
    const zero = {
      durationMs: 0,
      postureDurationMs: { upright: 0, slouch: 0, forwardHead: 0, drowsy: 0, gazeAway: 0 },
      distractionDurationMs: { phone: 0, away: 0 },
    }
    for (const a of radarAxes(zero)) expect(Number.isFinite(a.value)).toBe(true)
  })
})
