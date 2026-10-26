/**
 * 開場把畫面拉近到「胸口以上」。
 *
 * 純函式：吃一次姿勢量測得到的幾個純量（肩寬、肩線中點、鼻子高度，皆為 0–1
 * 的影像正規化座標），吐出 CSS transform 要用的 scale／translate。
 * 隱私：只用純量，不保存任何 landmark 陣列。
 */
export const ZOOM_MAX = 2.5
const HEAD_ROOM = 0.9 // 鼻子上方留幾個「肩寬」
const CHEST_ROOM = 0.9 // 肩線下方留幾個「肩寬」
const SIDE_ROOM = 1.7 // 取景寬度＝幾個肩寬

/** landmarks（pose 33 點）→ 取景純量；肩膀看不清楚就回 null */
export function framingSample(lm) {
  const l = lm?.[11]
  const r = lm?.[12]
  const nose = lm?.[0]
  if (!l || !r || !nose) return null
  if ((l.visibility ?? 1) < 0.5 || (r.visibility ?? 1) < 0.5) return null
  const shoulderW = Math.abs(l.x - r.x)
  if (shoulderW < 0.05) return null
  return { cx: (l.x + r.x) / 2, shoulderY: (l.y + r.y) / 2, noseY: nose.y, shoulderW }
}

function median(a) {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

/**
 * @param samples framingSample() 的結果陣列
 * @param video   { w, h } 影片像素尺寸
 * @param box     { w, h } 顯示容器（object-fit: cover、水平鏡像）
 * @returns { scale, tx, ty }（transform-origin: 0 0）；樣本不足回 null
 */
export function computeChestUpZoom(samples, video, box) {
  if (!samples?.length || !video?.w || !video?.h || !box?.w || !box?.h) return null
  const cx = median(samples.map((s) => s.cx))
  const shoulderY = median(samples.map((s) => s.shoulderY))
  const noseY = median(samples.map((s) => s.noseY))
  const sw = median(samples.map((s) => s.shoulderW))

  const cover = Math.max(box.w / video.w, box.h / video.h)
  const dw = video.w * cover
  const dh = video.h * cover
  const ox = (box.w - dw) / 2
  const oy = (box.h - dh) / 2
  const toX = (nx) => ox + (1 - nx) * dw // 鏡像
  const toY = (ny) => oy + ny * dh

  const top = toY(noseY - HEAD_ROOM * sw * (video.w / video.h))
  const bottom = toY(shoulderY + CHEST_ROOM * sw * (video.w / video.h))
  const regionH = bottom - top
  const regionW = SIDE_ROOM * sw * dw
  const scale = Math.min(ZOOM_MAX, Math.max(1, Math.min(box.w / regionW, box.h / regionH)))
  const centerX = toX(cx)
  const centerY = (top + bottom) / 2
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const tx = clamp(box.w / 2 - scale * centerX, box.w - scale * box.w, 0)
  const ty = clamp(box.h / 2 - scale * centerY, box.h - scale * box.h, 0)
  return { scale, tx, ty }
}
