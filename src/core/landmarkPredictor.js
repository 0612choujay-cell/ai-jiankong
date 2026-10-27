/**
 * 動作預測：用「上一幀→這一幀」的移動速度，把座標往前推一小段，
 * 抵銷推論本身的延遲（偵測結果出來時，畫面上的人早就又動了一點）。
 *
 * 只用來讓**畫面上的線**更跟手，不影響任何判斷（判斷吃的是未預測的原始值）。
 * 這裡只留上一幀的純座標數字（Float32Array，不含任何身分資料），而且只活在
 * 畫線元件自己的閉包裡，不外送、不存檔。
 */
export const PREDICT_AHEAD_MS = 90
const MAX_GAP_MS = 400 // 兩幀隔太久（人消失又出現）就不外推
const MAX_LEAD = 1.5 // 最多往前推 1.5 個幀間隔，避免突然暴衝

export function createPredictor({ aheadMs = PREDICT_AHEAD_MS } = {}) {
  let prev = null // Float32Array [x0,y0,x1,y1,...]
  let prevT = 0

  return {
    /** @returns 新陣列（每點 {x,y,visibility}）；第一幀或隔太久就原樣照抄 */
    predict(lm, nowMs) {
      if (!Array.isArray(lm)) { prev = null; return lm }
      const n = lm.length
      const out = new Array(n)
      const dt = nowMs - prevT
      const canPredict = prev && prev.length === n * 2 && dt > 1 && dt <= MAX_GAP_MS
      const lead = canPredict ? Math.min(aheadMs / dt, MAX_LEAD) : 0
      const cur = new Float32Array(n * 2)
      for (let i = 0; i < n; i++) {
        const p = lm[i]
        if (!p) { out[i] = p; continue }
        cur[2 * i] = p.x
        cur[2 * i + 1] = p.y
        out[i] = lead
          ? { ...p, x: p.x + (p.x - prev[2 * i]) * lead, y: p.y + (p.y - prev[2 * i + 1]) * lead }
          : p
      }
      prev = cur
      prevT = nowMs
      return out
    },
    reset() { prev = null },
  }
}
