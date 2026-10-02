import { describe, it, expect } from 'vitest'
import { createThresholdLab } from './thresholdLab.js'

function feed(lab, label, { neckRatio, shoulderWidth }, n = 12) {
  lab.setLabel(label)
  for (let i = 0; i < n; i++) lab.push({ neckRatio, shoulderWidth, valid: true })
  lab.setLabel(null)
}

function suggestion(report, key) {
  return report.suggestions.find((s) => s.key === key)
}

describe('createThresholdLab', () => {
  it('沒有任何取樣時兩個建議都不成立', () => {
    const r = createThresholdLab().report()
    expect(suggestion(r, 'neckDropRatio').ok).toBe(false)
    expect(suggestion(r, 'neckDropRatio').note).toContain('樣本不足')
  })

  it('樣本數未達 minSamples 不給建議', () => {
    const lab = createThresholdLab({ minSamples: 8 })
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 }, 3)
    feed(lab, 'bad', { neckRatio: 0.8, shoulderWidth: 0.36 }, 3)
    expect(suggestion(lab.report(), 'neckDropRatio').ok).toBe(false)
  })

  it('沒有 label 時 push 不進任何一組', () => {
    const lab = createThresholdLab()
    lab.push({ neckRatio: 1.0, shoulderWidth: 0.30, valid: true })
    expect(lab.count('good')).toBe(0)
    expect(lab.count('bad')).toBe(0)
  })

  it('valid:false 的取樣要丟掉', () => {
    const lab = createThresholdLab()
    lab.setLabel('good')
    lab.push({ neckRatio: 1.0, shoulderWidth: 0.30, valid: false })
    expect(lab.count('good')).toBe(0)
  })

  it('兩組分離時算出 neckDropRatio：邊界取兩組中點', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    feed(lab, 'bad', { neckRatio: 0.8, shoulderWidth: 0.36 })
    const s = suggestion(lab.report(), 'neckDropRatio')
    expect(s.ok).toBe(true)
    // 邊界 (1.0+0.8)/2 = 0.9，相對基準 1.0 掉了 10%
    expect(s.value).toBeCloseTo(0.10, 2)
  })

  it('shoulderGrowRatio 方向相反：駝背時肩寬變大', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    feed(lab, 'bad', { neckRatio: 0.8, shoulderWidth: 0.36 })
    const s = suggestion(lab.report(), 'shoulderGrowRatio')
    expect(s.ok).toBe(true)
    // 邊界 (0.30+0.36)/2 = 0.33，相對基準 0.30 長了 10%
    expect(s.value).toBeCloseTo(0.10, 2)
  })

  it('兩組分佈重疊時明確拒絕給建議，而不是給一個看起來很像的數字', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    feed(lab, 'bad', { neckRatio: 0.99, shoulderWidth: 0.302 })
    const s = suggestion(lab.report(), 'neckDropRatio')
    expect(s.ok).toBe(false)
    expect(s.note).toContain('分不開')
  })

  it('report 附上兩組的百分位數供人工判讀', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    const r = lab.report()
    expect(r.good.n).toBe(12)
    expect(r.good.neck.p50).toBeCloseTo(1.0, 3)
    expect(r.bad).toBe(null)
  })

  it('reset 清掉兩組', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    lab.reset()
    expect(lab.count('good')).toBe(0)
  })
})
