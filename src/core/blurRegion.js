/**
 * 背景模糊：算出「人」的橢圓範圍（容器像素），橢圓外的畫面會被模糊。
 *
 * 不是真正的人像分割——用姿勢關鍵點的外框撐出一個橢圓，成本幾乎是零，
 * 代價是邊緣不貼身（寬鬆一點，寧可多留清楚的地方，也不要把手臉糊掉）。
 * 純函式；只回傳 4 個純量，不保存 landmark。
 */
const MIN_VIS = 0.5
const GROW_X = 1.55
const GROW_Y = 1.35

/** @returns {{cx:number, cy:number, rx:number, ry:number} | null} */
export function personEllipse(lm, video, box) {
  if (!lm || !video?.w || !video?.h || !box?.w || !box?.h) return null
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
  let n = 0
  for (let i = 0; i <= 24; i++) {
    const p = lm[i]
    if (!p || (p.visibility ?? 1) < MIN_VIS) continue
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x)
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
    n += 1
  }
  if (n < 4) return null
  const cover = Math.max(box.w / video.w, box.h / video.h)
  const dw = video.w * cover
  const dh = video.h * cover
  const ox = (box.w - dw) / 2
  const oy = (box.h - dh) / 2
  // 水平鏡像：顯示用的 x 是 1 - nx
  const cx = ox + (1 - (x0 + x1) / 2) * dw
  const cy = oy + ((y0 + y1) / 2) * dh
  const rx = Math.max(((x1 - x0) / 2) * dw * GROW_X, 0.12 * box.w)
  const ry = Math.max(((y1 - y0) / 2) * dh * GROW_Y, 0.15 * box.h)
  return { cx, cy, rx, ry }
}

/** 平滑：避免橢圓每次姿勢更新都跳一下 */
export function smoothEllipse(prev, next, k = 0.5) {
  if (!next) return null
  if (!prev) return next
  const mix = (a, b) => a + (b - a) * k
  return { cx: mix(prev.cx, next.cx), cy: mix(prev.cy, next.cy), rx: mix(prev.rx, next.rx), ry: mix(prev.ry, next.ry) }
}
