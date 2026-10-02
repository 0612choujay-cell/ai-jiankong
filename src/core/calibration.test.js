import { describe, it, expect } from 'vitest'
import { createCalibrationCollector, MIN_SAMPLES } from './calibration.js'

const valid = (neckRatio, shoulderWidth = 0.30) => ({ neckRatio, shoulderWidth, valid: true })

describe('createCalibrationCollector', () => {
  it('取樣不足時 result 回報 not_enough', () => {
    const c = createCalibrationCollector()
    c.add(valid(1.0))
    const r = c.result()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_enough')
  })

  it('取中位數而非平均，離群值不影響結果', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0))
    c.add(valid(5.0))  // 一個極端離群值
    c.add(valid(-3.0))
    expect(c.result().profile.baselineNeckRatio).toBeCloseTo(1.0, 3)
  })

  it('偶數筆取樣時取中間兩筆的平均', () => {
    const c = createCalibrationCollector()
    // 12 筆互不相同的遞增值，中間兩筆（sorted index 5, 6）刻意選不相等，
    // 這樣 median() 的偶數分支如果算錯 index（例如少 1 或多 1），這個
    // 斷言才抓得到——只斷言 ok === true 對這種錯誤沒有鑑別力。
    const values = [0.80, 0.85, 0.88, 0.90, 0.92, 0.94, 0.98, 1.00, 1.02, 1.05, 1.10, 1.20]
    for (const v of values) c.add(valid(v))
    const r = c.result()
    expect(r.ok).toBe(true)
    expect(r.profile.baselineNeckRatio).toBeCloseTo((0.94 + 0.98) / 2, 5)
  })

  it('無效取樣不計入', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES + 5; i++) c.add({ neckRatio: 0, shoulderWidth: 0, valid: false })
    expect(c.result().ok).toBe(false)
    expect(c.count()).toBe(0)
  })

  // 實機驗收修的另一個 bug 的連帶：poseMetrics() 這一輪起在耳朵不可見時
  // 仍會回傳 valid:true（只是 neckRatio 退化成 0，見 poseGeometry.js），
  // 是為了不強迫整幀失效——但校準絕對不能把這種「量不到耳朵」的樣本
  // 當真，混進中位數會把基準拉向 0，之後整場姿態判斷都跟著偏。
  it('valid 為 true 但 earsValid 為 false 的樣本不計入（量不到耳朵，不是真的量到 neckRatio=0）', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0))
    for (let i = 0; i < 5; i++) c.add({ neckRatio: 0, shoulderWidth: 0.30, valid: true, earsValid: false })
    expect(c.count()).toBe(MIN_SAMPLES)
    expect(c.result().profile.baselineNeckRatio).toBeCloseTo(1.0, 3)
  })

  it('沒有 earsValid 欄位（舊呼叫端／舊測試資料）視為可信，照樣計入', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0)) // valid() 沒有帶 earsValid 欄位
    expect(c.count()).toBe(MIN_SAMPLES)
  })

  it('肩寬與頸比各自獨立取中位數', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0, 0.30))
    c.add(valid(1.0, 0.99))
    const p = c.result().profile
    expect(p.baselineShoulderWidth).toBeCloseTo(0.30, 3)
  })

  it('成功時回傳 id 為 default 的 profile', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0))
    const p = c.result().profile
    expect(p.id).toBe('default')
    expect(p.baselineNeckRatio).toBeGreaterThan(0)
  })

  it('reset 後重新開始', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0))
    c.reset()
    expect(c.count()).toBe(0)
    expect(c.result().ok).toBe(false)
  })
})
