import { describe, it, expect } from 'vitest'
import { createPerfMonitor } from './perfMonitor.js'

const make = () => createPerfMonitor({ thresholdMs: 150, sustainMs: 10_000 })

describe('createPerfMonitor', () => {
  it('延遲正常時回 ok', () => {
    const m = make()
    for (let t = 0; t <= 30_000; t += 500) expect(m.sample(80, t)).toBe('ok')
    expect(m.isDownshifted()).toBe(false)
  })

  it('超標未滿 10 秒不降檔', () => {
    const m = make()
    for (let t = 0; t <= 9500; t += 500) expect(m.sample(200, t)).toBe('ok')
    expect(m.isDownshifted()).toBe(false)
  })

  it('超標連續滿 10 秒觸發降檔，且只觸發一次', () => {
    const m = make()
    let downshifts = 0
    for (let t = 0; t <= 40_000; t += 500) {
      if (m.sample(200, t) === 'downshift') downshifts++
    }
    expect(downshifts).toBe(1)
    expect(m.isDownshifted()).toBe(true)
  })

  it('中途恢復正常會重新計時', () => {
    const m = make()
    for (let t = 0; t <= 8000; t += 500) m.sample(200, t)
    m.sample(50, 8500)
    for (let t = 9000; t <= 16_000; t += 500) expect(m.sample(200, t)).toBe('ok')
    expect(m.isDownshifted()).toBe(false)
  })

  it('單向不可升回：降檔後延遲恢復正常仍維持降檔', () => {
    const m = make()
    for (let t = 0; t <= 11_000; t += 500) m.sample(200, t)
    expect(m.isDownshifted()).toBe(true)
    for (let t = 12_000; t <= 60_000; t += 500) expect(m.sample(40, t)).toBe('ok')
    expect(m.isDownshifted()).toBe(true)
  })

  it('剛好等於門檻不算超標', () => {
    const m = make()
    for (let t = 0; t <= 20_000; t += 500) m.sample(150, t)
    expect(m.isDownshifted()).toBe(false)
  })

  it('reset 清除降檔狀態（換新一輪或手動重啟偵測時用）', () => {
    const m = make()
    for (let t = 0; t <= 11_000; t += 500) m.sample(200, t)
    m.reset()
    expect(m.isDownshifted()).toBe(false)
  })

  // 原本這裡是「t = 0 / 9999 / 10000」三個取樣點的邊界測試：相鄰兩次呼叫
  // sample() 間隔 9999ms。這個節奏在真機上不存在——sample() 是跟著 session.js
  // 的 frame() 每一個 rAF 呼叫一次的（60fps 下間隔 16.7ms），不是每 10 秒呼叫
  // 兩次；一個真實迴圈連續 9999ms 沒有觸發下一個 rAF，本身就已經是「取樣中斷」
  // （暫停／背景／卡死），而不是「持續超標」。用這個不存在的節奏去驗證
  // 「持續超標滿 10 秒才降檔」，驗到的其實是加法算得對不對，不是「持續」這件事。
  //
  // 加上間隙偵測（見 perfMonitor.js 頭註解）之後，這條舊測試會變成假紅：
  // 第二次呼叫（t=9999）本身就會因為與上一次（t=0）間隔 9999ms > gapMs
  // 而被判定成「中斷過」，把 overSince 作廢重算，於是 t=10000 那一次距離
  // 重算後的 overSince（9999）只過了 1ms，不會觸發降檔——這不是修法改壞了
  // 加法，而是這條測試本來就是用一個「取樣中斷」的節奏在檢查「持續超標」，
  // 兩者現在（正確地）被區分開來了。
  //
  // 新版鎖的是同一件事——「連續取樣、持續超標滿 sustainMs 才觸發降檔，且
  // 觸發點不必等超過」——但用真實的 rAF 節奏（16ms 一次）取樣，不再依賴一個
  // 不會出現的取樣間隔。
  it('sustainMs 邊界：連續取樣（真實 rAF 節奏）下，滿 10 秒即觸發，不必等超過', () => {
    const m = make()
    const FRAME_MS = 16 // 60fps 下的 rAF 間隔，遠小於 gapMs（預設 2000ms）
    let downshiftAt = null
    for (let t = 0; t <= 10_048; t += FRAME_MS) {
      const result = m.sample(200, t)
      if (result === 'downshift') { downshiftAt = t; break }
    }
    // 640 * 16 = 10240 一定會跨過 10_000 這個門檻；因為取樣是離散的，
    // 觸發點會是「第一個 >= overSince(0) + 10_000 的取樣點」，不會早於
    // 10_000，也不會因為節奏被拉遠。
    expect(downshiftAt).not.toBe(null)
    expect(downshiftAt).toBeGreaterThanOrEqual(10_000)
    expect(downshiftAt).toBeLessThan(10_000 + FRAME_MS) // 沒有多等一整個額外的間隔
    expect(m.isDownshifted()).toBe(true)
  })

  it('gapMs 邊界：間隔剛好等於 gapMs 不算中斷，仍然算連續，可以累積到降檔', () => {
    const m = make()
    const gapMs = 2000 // 對齊 perfMonitor.js 預設值；createPerfMonitor 沒有覆寫時就是它
    // 每次呼叫間隔都剛好是 gapMs（不大於，只是等於），連續五次共 10_000ms，
    // 若「等於 gapMs」被誤當成中斷，這裡會一路被作廢，永遠等不到降檔。
    expect(m.sample(200, gapMs * 0)).toBe('ok')
    expect(m.sample(200, gapMs * 1)).toBe('ok')
    expect(m.sample(200, gapMs * 2)).toBe('ok')
    expect(m.sample(200, gapMs * 3)).toBe('ok')
    expect(m.sample(200, gapMs * 4)).toBe('ok')
    expect(m.sample(200, gapMs * 5)).toBe('downshift') // 累計滿 10_000ms
  })

  it('gapMs 邊界：間隔一超過 gapMs 就視為中斷，overSince 從中斷後那一筆重新起算', () => {
    const m = make()
    const gapMs = 2000
    const restartAt = gapMs + 1 // 2001
    expect(m.sample(200, 0)).toBe('ok') // 第一次超標，開始計時
    expect(m.sample(200, restartAt)).toBe('ok') // 間隔 2001ms > gapMs：中斷，overSince 作廢並在此重新起算
    // 從 restartAt 重新起算，後續取樣間隔都必須 <= gapMs，否則會被判定成
    // 又一次中斷，驗不到「重新起算之後能不能累積到 10 秒」。
    expect(m.sample(200, restartAt + gapMs)).toBe('ok') // 累計 2000ms
    expect(m.sample(200, restartAt + gapMs * 2)).toBe('ok') // 累計 4000ms
    expect(m.sample(200, restartAt + gapMs * 3)).toBe('ok') // 累計 6000ms
    expect(m.sample(200, restartAt + gapMs * 4)).toBe('ok') // 累計 8000ms
    expect(m.sample(200, restartAt + 10_000 - 1)).toBe('ok') // 差 1ms 未滿 10_000ms
    expect(m.sample(200, restartAt + 10_000)).toBe('downshift') // 從 restartAt 起累計滿 10_000ms
  })

  it('B-1：超標後出現長間隙（暫停／背景／輪次交接），間隙後第一筆取樣不能用間隙前累積的時間直接降檔', () => {
    const m = make()
    expect(m.sample(200, 0)).toBe('ok') // 第一次超標，開始計時
    expect(m.sample(200, 5000)).toBe('ok') // 持續超標 5 秒，還沒滿 10 秒門檻
    // 長間隙：150 秒沒有任何取樣，對應「兩場之間的交接＋校準＋選任務」
    // （複審 PROBE-1）或「暫停 30 秒」（複審 PROBE-2）這類真實情境。
    const result = m.sample(200, 5000 + 150_000)
    // 錯誤的實作會因為「牆鐘時間已經比 overSince(0) 晚了 155 秒，遠超過
    // sustainMs」而在這裡誤判降檔——但這 155 秒裡有 150 秒完全沒有取樣，
    // 不構成「持續超標 10 秒」的證據。
    expect(result).toBe('ok')
    expect(m.isDownshifted()).toBe(false)
  })

  it('B-1：間隙之後重新累積，只要之後連續超標滿 sustainMs 仍然會降檔——不能把降檔功能整個關掉', () => {
    const m = make()
    m.sample(200, 0)
    m.sample(200, 5000)
    const gapEnd = 5000 + 150_000
    expect(m.sample(200, gapEnd)).toBe('ok') // 間隙後這一筆重新起算 overSince
    let downshifted = false
    for (let t = gapEnd; t <= gapEnd + 10_048; t += 16) {
      if (m.sample(200, t) === 'downshift') { downshifted = true; break }
    }
    expect(downshifted).toBe(true)
    expect(m.isDownshifted()).toBe(true)
  })

  it('reset 之後計時器也是全新的，不會沿用 reset 之前累積的超標時間', () => {
    const m = make()
    // 超標 8 秒（還不到 10 秒門檻），此時 reset
    for (let t = 0; t <= 8000; t += 500) m.sample(200, t)
    m.reset()
    // reset 之後只再超標 4 秒——如果沒有真的重新計時，
    // 會被誤判成「8+4=12 秒」而觸發降檔
    for (let t = 8500; t <= 12_000; t += 500) expect(m.sample(200, t)).toBe('ok')
    expect(m.isDownshifted()).toBe(false)
  })
})
