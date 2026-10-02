import { describe, it, expect } from 'vitest'
import { createPoseAnalyzer, MAX_SAMPLE_GAP_MS } from './poseAnalyzer.js'
import { PROFILES, profileFor } from './postureProfiles.js'
import { BATTLE } from './battleConfig.js'

const baseline = { baselineNeckRatio: 1.0, baselineShoulderWidth: 0.30 }

function makeAnalyzer(taskType = 'vocab') {
  return createPoseAnalyzer({ baseline, profile: profileFor(taskType) })
}

// 以 500ms 一筆（Pose 2fps）連續餵同一種姿態
// tiltRatio／handNearRatio 預設值（0／Infinity）刻意選在兩個新門檻的安全側，
// 讓既有呼叫端（不知道這兩個新欄位）不會意外被判成 headTilt／handProp。
function feedPose(a, { from, to, neckRatio, shoulderWidth = 0.30, tiltRatio = 0, handNearRatio = Infinity }) {
  for (let t = from; t <= to; t += 500) {
    a.pushPose({ t, metrics: { neckRatio, shoulderWidth, tiltRatio, handNearRatio, earsValid: true, valid: true } })
  }
}

function feedFace(a, { from, to, eyeClosed = false, gaze = 'center' }) {
  for (let t = from; t <= to; t += 333) {
    a.pushFace({ t, metrics: { eyeClosed, gaze } })
  }
}

describe('createPoseAnalyzer', () => {
  it('沒有任何取樣時回傳 upright 且不 drowsy', () => {
    expect(makeAnalyzer().evaluate(0)).toEqual({ posture: 'upright', drowsy: false })
  })

  // fix round（測試鑑別力 T-3／FG-9）：這條測試原本的標題是「單一離群幀不得
  // 改變狀態（窗口內至少要 2 個取樣點）」，但括號裡那句話它沒有在測——它餵的
  // 是 13 筆正常取樣再加一個離群值，測到的是滑動窗口／零階保持把離群值稀釋
  // 掉，`MIN_SAMPLES` 閘門一條都沒走到（總審實測：把 `inside < MIN_SAMPLES`
  // 改成 `inside < 0` 全套 0 紅）。標題改成它真正在測的東西，閘門本身另外補
  // 在下面「取樣不足不得判定」那一組。
  it('單一離群幀不得改變狀態（窗口內大量正常取樣把它稀釋掉——測的是滑動窗口／零階保持）', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 6000, neckRatio: 1.0 })
    a.pushPose({ t: 6500, metrics: { neckRatio: 0.5, shoulderWidth: 0.30, valid: true } })
    expect(a.evaluate(6600).posture).toBe('upright')
  })

  it('持續低頭超過 3 秒判為 forwardHead', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80 }) // 較基準低 20% > 12%
    expect(a.evaluate(4000).posture).toBe('forwardHead')
  })

  it('低頭未滿 3 秒不判定', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 2000, neckRatio: 0.80 })
    expect(a.evaluate(2000).posture).toBe('upright')
  })

  it('持續塌向桌面判為 slouch，且優先於 forwardHead', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80, shoulderWidth: 0.36 })
    expect(a.evaluate(4000).posture).toBe('slouch')
  })

  it('看書 profile：只有肩寬變大但沒低頭時不判 slouch', () => {
    const a = makeAnalyzer('reading')
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, shoulderWidth: 0.36 })
    expect(a.evaluate(4000).posture).toBe('upright')
  })

  it('看書 profile 容許更大的低頭幅度', () => {
    const a = makeAnalyzer('reading')
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.85 }) // 下降 15%，vocab 會判、reading 不判
    expect(a.evaluate(4000).posture).toBe('upright')

    const b = makeAnalyzer('vocab')
    feedPose(b, { from: 0, to: 4000, neckRatio: 0.85 })
    expect(b.evaluate(4000).posture).toBe('forwardHead')
  })

  it('視線往旁持續 2 秒判為 gazeAway', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0 })
    feedFace(a, { from: 0, to: 3000, gaze: 'away' })
    expect(a.evaluate(3000).posture).toBe('gazeAway')
  })

  it('視線往下不判分心', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 6000, neckRatio: 1.0 })
    feedFace(a, { from: 0, to: 6000, gaze: 'down' })
    expect(a.evaluate(6000).posture).toBe('upright')
  })

  it('閉眼超過 2 秒 drowsy 為 true，且與 posture 正交', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0 })
    feedFace(a, { from: 0, to: 3000, eyeClosed: true })
    const r = a.evaluate(3000)
    expect(r.drowsy).toBe(true)
    expect(r.posture).toBe('upright')
  })

  it('眨眼（0.3 秒）不算 drowsy', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0 })
    a.pushFace({ t: 1000, metrics: { eyeClosed: true, gaze: 'center' } })
    a.pushFace({ t: 1300, metrics: { eyeClosed: false, gaze: 'center' } })
    expect(a.evaluate(4000).drowsy).toBe(false)
  })

  it('零階保持：取樣間的空窗要算進持有時間', () => {
    const a = makeAnalyzer()
    // 只餵 3 筆、間隔 1.5 秒，涵蓋 0→3000ms，持有時間需累積到 3000ms 才會判定
    a.pushPose({ t: 0, metrics: { neckRatio: 0.8, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 1500, metrics: { neckRatio: 0.8, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 3000, metrics: { neckRatio: 0.8, shoulderWidth: 0.30, valid: true } })
    expect(a.evaluate(3100).posture).toBe('forwardHead')
  })

  it('狀態回正後，滑動窗口會把舊的不良取樣淘汰掉', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80 })
    expect(a.evaluate(4000).posture).toBe('forwardHead')
    feedPose(a, { from: 4500, to: 12_000, neckRatio: 1.0 })
    expect(a.evaluate(12_000).posture).toBe('upright')
  })

  it('無效取樣（人離開鏡頭）不累積任何不良狀態', () => {
    const a = makeAnalyzer()
    for (let t = 0; t <= 8000; t += 500) {
      a.pushPose({ t, metrics: { neckRatio: 0, shoulderWidth: 0, valid: false } })
    }
    expect(a.evaluate(8000).posture).toBe('upright')
  })

  it('reset 清空所有累積', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80 })
    a.reset()
    expect(a.evaluate(4000).posture).toBe('upright')
  })
})

// 實機驗收回報「頭歪撐頭都沒有偵測到」：這兩個是這一輪新增的姿態訊號。
describe('createPoseAnalyzer：撐頭（handProp）與歪頭（headTilt）', () => {
  it('持續撐頭超過 3 秒判為 handProp', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, handNearRatio: 0.2 }) // < 0.55 門檻
    expect(a.evaluate(4000).posture).toBe('handProp')
  })

  it('手離頭稍遠（未過門檻）不判 handProp', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, handNearRatio: 0.6 }) // > 0.55 門檻
    expect(a.evaluate(4000).posture).toBe('upright')
  })

  it('撐頭未滿 3 秒不判定', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 2000, neckRatio: 1.0, handNearRatio: 0.2 })
    expect(a.evaluate(2000).posture).toBe('upright')
  })

  it('持續歪頭超過 3 秒判為 headTilt', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, tiltRatio: 0.5 }) // > 0.30 門檻
    expect(a.evaluate(4000).posture).toBe('headTilt')
  })

  it('輕微歪頭（未過門檻）不判 headTilt', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, tiltRatio: 0.1 }) // < 0.30 門檻
    expect(a.evaluate(4000).posture).toBe('upright')
  })

  it('優先序：slouch／forwardHead 優先於 handProp／headTilt', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80, handNearRatio: 0.2, tiltRatio: 0.5 })
    expect(a.evaluate(4000).posture).toBe('forwardHead')
  })

  it('優先序：handProp 優先於 headTilt', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, handNearRatio: 0.2, tiltRatio: 0.5 })
    expect(a.evaluate(4000).posture).toBe('handProp')
  })

  it('優先序：headTilt 優先於 gazeAway', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, tiltRatio: 0.5 })
    feedFace(a, { from: 0, to: 3000, gaze: 'away' })
    expect(a.evaluate(3000).posture).toBe('headTilt')
  })

  it('耳朵不可見時（earsValid: false）不判 handProp／headTilt——這兩個訊號本來就需要耳朵當參考點', () => {
    const a = makeAnalyzer()
    for (let t = 0; t <= 4000; t += 500) {
      a.pushPose({
        t, metrics: {
          neckRatio: 1.0, shoulderWidth: 0.30, tiltRatio: 0.5, handNearRatio: 0.2, earsValid: false, valid: true,
        },
      })
    }
    expect(a.evaluate(4000).posture).toBe('upright')
  })
})

/**
 * fix round（測試鑑別力 FG-9／I-7）：`heldMs()` 回傳 `null` 代表「窗口內取樣
 * 數不足，不得據以判定」，這個語意原本**完全沒有測試**。
 *
 * 為什麼重要：取樣不足的成因是推論卡住、人不在鏡頭裡、剛切回前景——那些時候
 * 我們其實什麼都沒觀測到，卻可能因為零階保持把「最後一筆壞讀值」一路拖長而
 * 判定成壞姿勢並扣血。這個閘門就是「沒看到就不要亂講」。
 *
 * 這一組跟 MAX_SAMPLE_GAP_MS 那一組守的不是同一件事：那組管的是**單一區間**
 * 最多能貢獻多少時間（上限 1500ms），這組管的是**區間數量**夠不夠。下面的
 * 建構刻意讓兩個 clamp 後的區間加起來剛好跨過 3000ms 的門檻，好證明在
 * MAX_SAMPLE_GAP_MS 完全生效的情況下，擋下判定的仍然只有取樣數閘門。
 */
describe('MIN_SAMPLES：窗口內取樣數不足時不得判定（heldMs 回傳 null 的語意）', () => {
  // 窗口 = [now-6000, now] = [2000, 8000]。
  // t=0 這筆在窗口外（prune 會刻意保留一筆窗口外的取樣，讓窗口起點有值可用），
  // 所以窗口內只有 t=4000 這一筆 → inside = 1 < MIN_SAMPLES(2)。
  // 零階保持算出來的持有時間卻是 clamp(4000−2000) + clamp(8000−4000)
  //   = 1500 + 1500 = 3000ms，剛好等於 vocab profile 的 postureHoldMs——
  // 也就是說，少了閘門，這兩筆取樣就足以宣告「低頭 3 秒」。
  it('窗口內只有 1 筆取樣時不判定，即使零階保持算出來的持有時間已經達到門檻', () => {
    const a = makeAnalyzer()
    a.pushPose({ t: 0, metrics: { neckRatio: 0.80, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 4000, metrics: { neckRatio: 0.80, shoulderWidth: 0.30, valid: true } })
    expect(a.evaluate(8000).posture).toBe('upright')
  })

  it('對照組：同樣的兩筆再多餵一筆幾乎不貢獻時間的取樣（+1ms），窗口內變成 2 筆就會判定', () => {
    // 唯一的差別是「窗口內有幾筆取樣」，持有時間只多了 1ms（3000 → 3001）。
    // 這條的作用是證明上面那條的 upright 真的是被取樣數閘門擋下來的，
    // 不是因為持有時間本來就不夠——沒有它，上面那條會退化成
    // 「隨便湊個不到門檻的情境」，而那種測試拿掉閘門也照樣綠。
    const a = makeAnalyzer()
    a.pushPose({ t: 0, metrics: { neckRatio: 0.80, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 4000, metrics: { neckRatio: 0.80, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 7999, metrics: { neckRatio: 0.80, shoulderWidth: 0.30, valid: true } })
    expect(a.evaluate(8000).posture).toBe('forwardHead')
  })

  it('face track 走同一個閘門：窗口內只有 1 筆閉眼取樣時不得判定 drowsy', () => {
    // drowsyHoldMs = 2000，clamp 後兩段各 1500 → 3000 已經超過門檻，
    // 但窗口內只有 t=4000 這一筆 face 取樣。pose track 餵滿正常取樣，
    // 確保 posture 這一路不會干擾（也順便讓 drowsy 成為唯一的變因）。
    const a = makeAnalyzer()
    feedPose(a, { from: 2000, to: 8000, neckRatio: 1.0 })
    a.pushFace({ t: 0, metrics: { eyeClosed: true, gaze: 'center' } })
    a.pushFace({ t: 4000, metrics: { eyeClosed: true, gaze: 'center' } })
    expect(a.evaluate(8000).drowsy).toBe(false)
  })
})

describe('MAX_SAMPLE_GAP_MS：單一取樣區間的持有時間要有上限', () => {
  it('不變式：MAX_SAMPLE_GAP_MS 必須嚴格小於所有會被 heldMs 結果拿去比較的 hold 門檻（否則單一區間就可能獨力觸發狀態）', () => {
    for (const [taskType, profile] of Object.entries(PROFILES)) {
      expect(MAX_SAMPLE_GAP_MS, `${taskType}.postureHoldMs`).toBeLessThan(profile.postureHoldMs)
      expect(MAX_SAMPLE_GAP_MS, `${taskType}.gazeAwayHoldMs`).toBeLessThan(profile.gazeAwayHoldMs)
    }
    // drowsyHoldMs 來自 battleConfig.js 的 BATTLE，不在 PROFILES 裡、迴圈遍歷不到它，
    // 但 evaluate() 一樣拿它去跟 heldMs(faceTrack, ..., eyeClosed) 的結果比較（closedMs >= drowsyHoldMs），
    // 漏掉它一起鎖住，這個不變式就只保護 posture 三態、drowsy 的保護只剩「數字剛好躲掉」
    expect(MAX_SAMPLE_GAP_MS, 'BATTLE.drowsyHoldMs').toBeLessThan(BATTLE.drowsyHoldMs)
  })

  it('單一離群幀後接一段長空窗（推論卡頓）不得單獨觸發 slouch / forwardHead / gazeAway', () => {
    const a = makeAnalyzer()
    // t=0 這筆同時踩中「低頭」與「肩寬變大」兩種壞姿態的門檻，緊接著卡頓 5 秒
    // （裝置過熱降頻、WebGL 卡頓等）才送到下一筆好姿態——這 5 秒是推論卡頓造成的
    // 空窗，不是小孩真的維持壞姿勢 5 秒，不該被零階保持整段算成壞姿勢持有時間
    a.pushPose({ t: 0, metrics: { neckRatio: 0.5, shoulderWidth: 0.40, valid: true } })
    a.pushPose({ t: 5000, metrics: { neckRatio: 1.0, shoulderWidth: 0.30, valid: true } })
    a.pushFace({ t: 0, metrics: { eyeClosed: false, gaze: 'away' } })
    a.pushFace({ t: 5000, metrics: { eyeClosed: false, gaze: 'center' } })

    expect(a.evaluate(5000).posture).toBe('upright')
  })

  it('單一閉眼幀後接一段長空窗（推論卡頓）不得單獨觸發 drowsy', () => {
    const a = makeAnalyzer()
    // 同一個 clamp 也要保護 drowsy 這條路徑：t=0 閉眼、卡頓 5 秒才送到下一筆睜眼，
    // 不該被算成「閉眼持續 5 秒」而跳出休息建議打斷小孩
    a.pushPose({ t: 0, metrics: { neckRatio: 1.0, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 5000, metrics: { neckRatio: 1.0, shoulderWidth: 0.30, valid: true } })
    a.pushFace({ t: 0, metrics: { eyeClosed: true, gaze: 'center' } })
    a.pushFace({ t: 5000, metrics: { eyeClosed: false, gaze: 'center' } })

    expect(a.evaluate(5000).drowsy).toBe(false)
  })
})
