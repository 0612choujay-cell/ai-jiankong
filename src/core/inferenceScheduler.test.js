import { describe, it, expect } from 'vitest'
import { createScheduler } from './inferenceScheduler.js'

// 注意：每條測試都要把三個 track 都排進場景，而且要跟著模擬時間一路 complete()。
// 有兩種不同的「測試場景不完整」會讓 EDF 理所當然地挑中某個 track，
// 測到的於是不是測試名稱講的那件事：
//   1. 從沒 complete() 過的 track，nextDueAt 停在初始值 0，等於「從開機起就一直逾期」，
//      它會贏過任何排過班的 track。
//   2. complete() 過但之後就沒再更新的 track，due 被凍結在很久以前的時刻；
//      模擬時間往前走之後，那個舊 due 仍然小於別人的新 due，它一樣會贏。
// 兩種都不是 bug，是場景沒鋪完。第 2 種特別容易漏看，因為那個 track 明明「有排過班」。

const SPECS = [{ key: 'pose', fps: 2 }, { key: 'face', fps: 3 }, { key: 'object', fps: 0.33 }]

describe('createScheduler', () => {
  it('起始時三個模型都已到期，依 fps 高者優先', () => {
    const s = createScheduler(SPECS)
    expect(s.pick(0)).toBe('face')
  })

  it('完成後依各自 fps 排下一次', () => {
    const s = createScheduler(SPECS)
    s.complete('face', 0)   // 下次 333ms
    s.complete('pose', 0)   // 下次 500ms
    s.complete('object', 0) // 下次 3030ms
    expect(s.pick(100)).toBe(null)
    expect(s.pick(400)).toBe('face')
    s.complete('face', 400) // face 這一輪跑完了，下次 733ms
    expect(s.pick(600)).toBe('pose')
  })

  it('被丟棄時不重置 due time，低頻模型不會餓死', () => {
    const s = createScheduler(SPECS)
    // pose / face 一路正常完成到 3000 附近，模擬高頻模型持續在跑
    for (let t = 0; t <= 3000; t += 500) s.complete('pose', t)   // 最後 due 3500
    for (let t = 0; t <= 3000; t += 333) s.complete('face', t)   // 最後 due 約 3330
    s.complete('object', 0)                                       // due 3030
    for (let i = 0; i < 20; i++) s.skip()                         // 期間被丟棄 20 次
    expect(s.pick(3100)).toBe('object')
  })

  it('同時到期時挑最早到期的（而非最高 fps）', () => {
    const s = createScheduler(SPECS)
    s.complete('pose', 0)   // due 500
    s.complete('face', 400) // due 733
    s.complete('object', 0) // due 3030，讓它離開 t=0 的永久逾期狀態
    expect(s.pick(800)).toBe('pose')
  })

  it('setScale(0.5) 讓所有間隔加倍', () => {
    const s = createScheduler(SPECS)
    s.setScale(0.5)
    s.complete('pose', 0)   // 間隔加倍：due 1000（原本 500）
    s.complete('face', 600) // due 1266
    s.complete('object', 0) // due 6060
    expect(s.pick(600)).toBe(null)   // scale 1 時 pose 早就到期了，加倍後還沒
    expect(s.pick(1100)).toBe('pose')
  })

  it('setScale 只影響之後排的班，不追溯已排定的', () => {
    const s = createScheduler(SPECS)
    s.complete('pose', 0)   // scale 1：due 500
    s.complete('face', 400) // scale 1：due 733
    s.complete('object', 0) // scale 1：due 3030
    s.setScale(0.5)
    expect(s.pick(600)).toBe('pose') // pose 的 due 仍是 500，沒有被追溯改成 1000
  })

  it('pick 是純讀取：沒有 complete 之前重複 pick 回傳同一個 key', () => {
    const s = createScheduler(SPECS)
    s.complete('pose', 0)
    s.complete('face', 0)
    s.complete('object', 0)
    expect(s.pick(400)).toBe('face')
    expect(s.pick(400)).toBe('face') // 沒 complete，狀態不該變
    expect(s.pick(400)).toBe('face')
  })

  it('停用的模型永不被挑中', () => {
    const s = createScheduler(SPECS)
    s.setEnabled('object', false)
    s.complete('pose', 0)
    s.complete('face', 0)
    expect(s.pick(10_000)).not.toBe('object')
  })

  it('重新啟用後立刻可被挑中', () => {
    const s = createScheduler(SPECS)
    s.setEnabled('object', false)
    s.setEnabled('object', true)
    s.complete('pose', 0)
    s.complete('face', 0)
    expect(s.pick(10_000)).toBe('object')
  })

  it('actualFps 以最近的完成間隔估算', () => {
    const s = createScheduler(SPECS)
    for (let t = 0; t <= 2000; t += 500) s.complete('pose', t)
    expect(s.actualFps('pose', 2000)).toBeCloseTo(2, 1)
  })

  it('未知 key 的 complete 不丟例外', () => {
    const s = createScheduler(SPECS)
    expect(() => s.complete('nope', 0)).not.toThrow()
  })

  // Task 5 parked finding（見 progress.md）：track 被 setEnabled(false) 停用一段
  // 時間後再 setEnabled(true) 重新啟用，如果不清掉 completions，重新啟用後短時間內
  // actualFps() 會把停用前的舊樣本跟停用後的新樣本混在一起計算，讀數失真。
  // 只影響 DebugHud 顯示的數字，不是安全路徑，但既然要秀給人看，數字就不能是錯的。
  it('停用一段時間後重新啟用，actualFps 不沿用停用前的舊完成記錄', () => {
    const s = createScheduler(SPECS)
    // 停用前留下一串「密集」的舊完成記錄（每 500ms 一次）
    for (let t = 0; t <= 2000; t += 500) s.complete('pose', t)
    s.setEnabled('pose', false)
    // 停用很長一段時間（模擬暫停、或降檔關掉整個 track 一陣子）
    s.setEnabled('pose', true)
    // 重新啟用後只發生「一次」完成——樣本數不足 2，估不出 fps，必須老實回 0，
    // 不能撿到停用前的舊時間戳去算出一個看似合理但其實是混到舊資料的數字。
    s.complete('pose', 50_100)
    expect(s.actualFps('pose', 50_100)).toBe(0)
  })

  it('重新啟用後累積到兩筆新完成記錄，actualFps 只反映新樣本的間隔', () => {
    const s = createScheduler(SPECS)
    for (let t = 0; t <= 2000; t += 500) s.complete('pose', t) // 停用前：2fps 的密集舊樣本
    s.setEnabled('pose', false)
    s.setEnabled('pose', true)
    s.complete('pose', 50_100)
    s.complete('pose', 50_600) // 新樣本間隔 500ms → 2fps
    expect(s.actualFps('pose', 50_600)).toBeCloseTo(2, 1)
  })
})
