import { BATTLE } from './battleConfig.js'

const WINDOW_MS = 6000
const MIN_SAMPLES = 2

/**
 * 單一取樣區間最多只能貢獻這麼多「持有時間」。
 * 零階保持假設「沒有新樣本時狀態不變」，這個假設在正常取樣節奏下成立，
 * 但推論卡住幾秒時就不成立了——那幾秒我們其實什麼都沒觀測到。
 * 沒有上限的話，一筆邊緣的壞讀值後面接一個 5 秒空窗，就會被算成「壞姿勢持續 5 秒」而扣血。
 *
 * 取值 1500：Pose 2fps = 500ms 一筆，緊急降檔後減半 = 1000ms 一筆，
 * 兩者都在上限內、完整計入；超過 1500ms 代表真的卡住了，不該全額採信。
 * 這個值必須小於所有 profile 裡最小的 hold 門檻（見下面的不變式測試）。
 */
export const MAX_SAMPLE_GAP_MS = 1500

/**
 * 零階保持 + 時間積分的滑動窗口。
 *
 * 為什麼不能只看「最新一幀」：Pose 只有 2fps，單幀誤判會讓狀態每 500ms 跳一次，
 * 畫面上的提示會抖到無法閱讀。改成「在最近 6 秒內，這個狀態總共持有幾毫秒」，
 * 每筆取樣持有到下一筆取樣為止（零階保持），超過閾值才切換狀態。
 */
function createTrack() {
  return { samples: [] } // { t, value } — value 由呼叫端定義
}

function push(track, t, value) {
  const last = track.samples[track.samples.length - 1]
  if (last && t <= last.t) return // 時間必須單調遞增，亂序的取樣直接丟棄
  track.samples.push({ t, value })
}

function prune(track, now) {
  const cutoff = now - WINDOW_MS
  // 保留一筆窗口外的取樣，讓窗口起點的零階保持有值可用
  let firstInside = 0
  while (firstInside < track.samples.length && track.samples[firstInside].t < cutoff) firstInside++
  const keepFrom = Math.max(0, firstInside - 1)
  if (keepFrom > 0) track.samples.splice(0, keepFrom)
}

/**
 * 在 [now - WINDOW_MS, now] 內，predicate 為真的取樣總共持有多少毫秒。
 * 回傳 null 表示窗口內取樣數不足，不得據以判定。
 */
function heldMs(track, now, predicate) {
  prune(track, now)
  const from = now - WINDOW_MS
  const s = track.samples
  let inside = 0
  for (const sample of s) if (sample.t >= from) inside++
  if (inside < MIN_SAMPLES) return null

  let total = 0
  for (let i = 0; i < s.length; i++) {
    const start = Math.max(s[i].t, from)
    const end = i + 1 < s.length ? Math.min(s[i + 1].t, now) : now
    if (end > start && predicate(s[i].value)) total += Math.min(end - start, MAX_SAMPLE_GAP_MS)
  }
  return total
}

export function createPoseAnalyzer({ baseline, profile }) {
  let poseTrack = createTrack()
  let faceTrack = createTrack()

  return {
    pushPose({ t, metrics }) {
      push(poseTrack, t, metrics)
    },

    pushFace({ t, metrics }) {
      push(faceTrack, t, metrics)
    },

    reset() {
      poseTrack = createTrack()
      faceTrack = createTrack()
    },

    evaluate(now) {
      // earsValid !== false（而不是 === true）：舊測試與部分呼叫端餵的假
      // metrics 沒有這個欄位，undefined 一律當作可信，只有 poseGeometry.js
      // 明確量不到耳朵時才會是 false（見該檔的完整說明）。
      const neckDropped = (m) =>
        m.valid && m.earsValid !== false
        && m.neckRatio < baseline.baselineNeckRatio * (1 - profile.neckDropRatio)
      const shoulderGrown = (m) =>
        m.valid && m.shoulderWidth > baseline.baselineShoulderWidth * (1 + profile.shoulderGrowRatio)
      const tilted = (m) =>
        m.valid && m.earsValid !== false && (m.tiltRatio ?? 0) > profile.headTiltRatio
      const handPropped = (m) =>
        m.valid && m.earsValid !== false && (m.handNearRatio ?? Infinity) < profile.handPropRatio

      const slouchPredicate = profile.requireBothForSlouch
        ? (m) => neckDropped(m) && shoulderGrown(m)
        : shoulderGrown

      const slouchMs = heldMs(poseTrack, now, slouchPredicate)
      const forwardMs = heldMs(poseTrack, now, neckDropped)
      const handPropMs = heldMs(poseTrack, now, handPropped)
      const tiltMs = heldMs(poseTrack, now, tilted)
      const awayMs = heldMs(faceTrack, now, (m) => m.gaze === 'away')
      const closedMs = heldMs(faceTrack, now, (m) => m.eyeClosed)

      const drowsy = (closedMs ?? 0) >= BATTLE.drowsyHoldMs

      // 互斥優先序：塌陷 > 前傾 > 撐頭 > 歪頭 > 視線偏移。
      // 撐頭／歪頭排在視線偏移之前：兩者都是看得到的坐姿問題，比「眼神飄走」
      // 這種較模糊的訊號更該優先講出具體原因。
      // drowsy 是獨立布林值，不進 posture — 瞌睡不影響戰鬥數值，但駝背要扣血。
      let posture = 'upright'
      if ((slouchMs ?? 0) >= profile.postureHoldMs) posture = 'slouch'
      else if ((forwardMs ?? 0) >= profile.postureHoldMs) posture = 'forwardHead'
      else if ((handPropMs ?? 0) >= profile.postureHoldMs) posture = 'handProp'
      else if ((tiltMs ?? 0) >= profile.postureHoldMs) posture = 'headTilt'
      else if ((awayMs ?? 0) >= profile.gazeAwayHoldMs) posture = 'gazeAway'

      return { posture, drowsy }
    },
  }
}
