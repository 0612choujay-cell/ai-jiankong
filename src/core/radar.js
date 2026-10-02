const AXES = [
  { key: 'upright', label: '坐得直不直' },
  { key: 'neck', label: '脖子有沒有伸出去' },
  { key: 'back', label: '背有沒有靠好' },
  { key: 'awake', label: '精神好不好' },
  { key: 'resist', label: '有沒有被打斷' },
]

const pct = (part, whole) => {
  if (!whole || whole <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)))
}

/** 五軸全部由既有資料導出，不需額外蒐集。標籤刻意用白話，不用術語。 */
export function radarAxes(record) {
  const total = record.durationMs
  const p = record.postureDurationMs
  const d = record.distractionDurationMs
  const distraction = (d?.phone ?? 0) + (d?.away ?? 0)

  const values = {
    upright: pct(p?.upright ?? 0, total),
    neck: 100 - pct(p?.forwardHead ?? 0, total),
    back: 100 - pct(p?.slouch ?? 0, total),
    awake: 100 - pct(p?.drowsy ?? 0, total),
    resist: 100 - pct(distraction, total),
  }

  return AXES.map((a) => ({ ...a, value: Math.max(0, Math.min(100, values[a.key])) }))
}
