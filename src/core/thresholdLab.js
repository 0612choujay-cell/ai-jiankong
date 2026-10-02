/**
 * 姿態閾值量測工具。開發期的 LivePreview 開發期暫代畫面已在 Task 14 移除
 * （BattleView 上線，LivePreview 沒有任何檔案 import 它，留著只是一個
 * 繞過 session store 鏡頭判準的第二個鏡頭擁有者樣板）；本檔仍保留，是真機
 * 量測姿態閾值、交付前門檻要用的工具，之後由某個開發期用的呼叫端（例如
 * 一次性量測腳本或另開的量測頁面）直接 import 使用。
 *
 * 用法：坐正時 setLabel('good') 收幾秒，駝背時 setLabel('bad') 收幾秒，
 * 然後 report() 給出該填進 postureProfiles.js 的數字。
 *
 * 為什麼要檢查重疊：如果坐正和駝背量到的 neckRatio 分佈根本疊在一起，
 * 代表這個指標在這個人／這個坐姿下分不出差別。這時給出任何閾值都是擲骰子，
 * 必須先改鏡頭角度或改用另一個指標，而不是繼續調數字。
 */

const MIN_GAP_RATIO = 0.02 // 兩組之間至少要差基準值的 2%，否則視為分不開

function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b)
  return { p5: percentile(s, 5), p50: percentile(s, 50), p95: percentile(s, 95) }
}

const round2 = (x) => Math.round(x * 100) / 100

export function createThresholdLab({ minSamples = 8 } = {}) {
  const groups = { good: [], bad: [] }
  let label = null

  function stats(name) {
    const rows = groups[name]
    if (!rows.length) return null
    return {
      n: rows.length,
      neck: summarize(rows.map((r) => r.neckRatio)),
      shoulder: summarize(rows.map((r) => r.shoulderWidth)),
    }
  }

  /**
   * direction 'down'：壞姿勢時數值變小（neckRatio）
   * direction 'up'  ：壞姿勢時數值變大（shoulderWidth）
   */
  function suggest({ key, field, direction, good, bad }) {
    if (!good || !bad || good.n < minSamples || bad.n < minSamples) {
      return { key, ok: false, value: null, note: `樣本不足（坐正 ${good?.n ?? 0} 筆、駝背 ${bad?.n ?? 0} 筆，各需 ${minSamples} 筆）` }
    }
    const g = good[field]
    const b = bad[field]
    const gap = MIN_GAP_RATIO * g.p50
    const [lo, hi] = direction === 'down' ? [b.p95, g.p5] : [g.p95, b.p5]
    if (!(hi > lo + gap)) {
      return {
        key,
        ok: false,
        value: null,
        note: `兩組分佈分不開（坐正 ${round2(g.p5)}–${round2(g.p95)}、駝背 ${round2(b.p5)}–${round2(b.p95)}）。`
            + '先調鏡頭高度或坐姿距離再量一次，不要硬填數字。',
      }
    }
    const boundary = (lo + hi) / 2
    const value = direction === 'down' ? 1 - boundary / g.p50 : boundary / g.p50 - 1
    if (value <= 0) {
      return { key, ok: false, value: null, note: '算出來的容許量 ≤ 0，量測有問題' }
    }
    return {
      key,
      ok: true,
      value: round2(value),
      note: `基準 ${round2(g.p50)}、判定邊界 ${round2(boundary)}`,
    }
  }

  return {
    setLabel(next) {
      label = next === 'good' || next === 'bad' ? next : null
    },
    push(metrics) {
      if (!label || !metrics?.valid) return
      const { neckRatio, shoulderWidth } = metrics
      if (!Number.isFinite(neckRatio) || !Number.isFinite(shoulderWidth)) return
      groups[label].push({ neckRatio, shoulderWidth })
    },
    count: (name) => groups[name]?.length ?? 0,
    currentLabel: () => label,
    reset() {
      groups.good = []
      groups.bad = []
      label = null
    },
    report() {
      const good = stats('good')
      const bad = stats('bad')
      return {
        good,
        bad,
        // 基準值直接取坐正組的中位數：這是這個人在這個鏡頭位置下的真實值，
        // 不是猜的 1.0。校準精靈（Task 9）之後會用同樣的取中位數作法。
        baseline: good ? { baselineNeckRatio: round2(good.neck.p50), baselineShoulderWidth: round2(good.shoulder.p50) } : null,
        suggestions: [
          suggest({ key: 'neckDropRatio', field: 'neck', direction: 'down', good, bad }),
          suggest({ key: 'shoulderGrowRatio', field: 'shoulder', direction: 'up', good, bad }),
        ],
      }
    },
  }
}
