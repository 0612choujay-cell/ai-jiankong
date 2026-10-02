/** 5 秒 × 5-8fps，扣掉起步與無效幀後至少要有這麼多筆才算數 */
export const MIN_SAMPLES = 12

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 校準取樣器。
 *
 * 用中位數不用平均：5 秒內人一定會動，平均會被幾個離群幀拉走，
 * 而基準一旦偏掉，整輪的姿態判定都跟著偏。
 *
 * 刻意不做「晃太多請重來」的迴圈——國小生被擋在校準畫面外進不去遊戲，
 * 比基準稍微不準嚴重得多。
 *
 * 隱私：只累積 neckRatio / shoulderWidth 這兩個純量，不保留任何 landmark
 * 座標或逐幀快照，result() 只吐出彙總後的中位數。
 */
export function createCalibrationCollector() {
  let neckRatios = []
  let shoulderWidths = []

  return {
    add(metrics) {
      // earsValid === false（明確量不到耳朵，見 poseGeometry.js 的拆分說明）
      // 才擋：這一輪之前 metrics 沒有 earsValid 這個欄位，舊測試餵的假資料
      // 也沒有，undefined 一律當作可信，不然會整批被這裡擋掉。
      // 量不到耳朵的樣本不能拿去校準——neckRatio 這時只是 0 這個佔位值，
      // 混進中位數會把基準拉向一個假的耳肩高度，之後整場姿態判斷都跟著偏。
      if (!metrics?.valid || metrics?.earsValid === false) return
      neckRatios.push(metrics.neckRatio)
      shoulderWidths.push(metrics.shoulderWidth)
    },

    count() {
      return neckRatios.length
    },

    reset() {
      neckRatios = []
      shoulderWidths = []
    },

    result() {
      if (neckRatios.length < MIN_SAMPLES) {
        return { ok: false, reason: 'not_enough', profile: null }
      }
      return {
        ok: true,
        reason: null,
        profile: {
          id: 'default',
          baselineNeckRatio: median(neckRatios),
          baselineShoulderWidth: median(shoulderWidths),
          calibratedAt: null, // 由呼叫端補上，本檔不讀系統時鐘
        },
      }
    },
  }
}
