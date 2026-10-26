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

/**
 * 把「人」的清楚範圍往外擴 px 個螢幕像素：對背景透明度做最小值濾波（可分離）。
 * @param {{w:number,h:number,data:Uint8ClampedArray}} m 背景透明度遮罩
 * @param {number} px 要擴張的螢幕像素
 * @param {number} pxPerCell 遮罩一格對應幾個螢幕像素
 */
export function growClearRegion(m, px, pxPerCell) {
  const r = Math.max(0, Math.round(px / (pxPerCell || 1)))
  if (!r || !m?.w || !m?.h) return m
  const { w, h, data } = m
  const tmp = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 255
      for (let k = -r; k <= r; k++) {
        const xx = x + k
        if (xx >= 0 && xx < w) v = Math.min(v, data[y * w + xx])
      }
      tmp[y * w + x] = v
    }
  }
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 255
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy >= 0 && yy < h) v = Math.min(v, tmp[yy * w + x])
      }
      out[y * w + x] = v
    }
  }
  return { w, h, data: out }
}

const HAND_GROW = 2.0 // 手握的東西會超出指尖，清楚範圍取手的大小 × 2
const HAND_MIN_R = 0.06

/**
 * 手部 landmarks（每隻手 21 點）→ 只剩純量的清楚圓：{ x, y, r }，
 * x、y 是影像正規化座標，r 以影像寬度為單位。landmark 不保留。
 * @param {Array<Array<{x:number,y:number}>>|null} hands
 * @param {number} aspect 影片 寬/高
 */
export function handCircles(hands, aspect = 4 / 3) {
  if (!hands?.length) return []
  const out = []
  for (const h of hands) {
    if (!h || h.length < 21) continue
    const palm = [0, 5, 9, 13, 17].map((i) => h[i])
    const x = palm.reduce((a, p) => a + p.x, 0) / palm.length
    const y = palm.reduce((a, p) => a + p.y, 0) / palm.length
    let size = 0
    for (const p of h) size = Math.max(size, Math.hypot(p.x - x, (p.y - y) / aspect))
    out.push({ x, y, r: Math.max(HAND_MIN_R, size * HAND_GROW) })
  }
  return out
}

/** 在背景透明度遮罩上，把手周圍的圓挖成清楚（0）。回傳新遮罩。 */
export function carveHands(m, circles) {
  if (!circles?.length || !m?.w || !m?.h) return m
  const data = new Uint8ClampedArray(m.data)
  for (const c of circles) {
    const cx = c.x * m.w
    const cy = c.y * m.h
    const r = c.r * m.w
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(m.h - 1, Math.ceil(cy + r))
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(m.w - 1, Math.ceil(cx + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x - cx, y - cy) <= r) data[y * m.w + x] = 0
      }
    }
  }
  return { w: m.w, h: m.h, data }
}
