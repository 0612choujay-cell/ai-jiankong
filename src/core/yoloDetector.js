import * as ort from 'onnxruntime-web/wasm'

/**
 * YOLO（COCO 80 類）手機偵測，跑在 onnxruntime-web 的 wasm 後端。
 * 輸出格式刻意做成跟 MediaPipe ObjectDetector 一樣
 * （{ boundingBox: {originX, originY, width, height}, categories: [{categoryName, score}] }），
 * 這樣 inferenceService 後面的面積／人物範圍／標籤判斷完全不用改。
 *
 * 隱私：影像只在這個函式裡縮成 640×640 的張量，推論完就丟；沒有任何網路請求
 * （wasm 與模型都是同源檔案）。
 */
export const YOLO_MODEL_PATH = '/models/yolo11n.onnx'
export const YOLO_WASM_PATH = '/ort/'
const SIZE = 640
const MIN_CANDIDATE = 0.25
const NMS_IOU = 0.5

// COCO 的類別 id → 名稱，只列我們會用到的（其餘不需要名稱）。
const COCO_NAMES = { 39: 'bottle', 41: 'cup', 63: 'laptop', 65: 'remote', 67: 'cell phone', 73: 'book' }

function iou(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return inter / (a.w * a.h + b.w * b.h - inter || 1)
}

/**
 * 解碼 YOLOv8／11 的輸出 [1, 84, N]（前 4 列是 cx,cy,w,h，後 80 列是各類分數），
 * 只留 wantedIds 裡的類別。座標是 640×640 letterbox 空間，這裡換回原圖像素。
 * 純函式，方便不載模型就測試。
 */
export function decodeYolo(data, numAnchors, { scale, padX, padY, srcW, srcH }, wantedIds = Object.keys(COCO_NAMES).map(Number)) {
  const cands = []
  for (let i = 0; i < numAnchors; i++) {
    let best = 0
    let bestId = -1
    for (const id of wantedIds) {
      const sc = data[(4 + id) * numAnchors + i]
      if (sc > best) { best = sc; bestId = id }
    }
    if (best < MIN_CANDIDATE) continue
    const cx = data[i]
    const cy = data[numAnchors + i]
    const w = data[2 * numAnchors + i]
    const h = data[3 * numAnchors + i]
    const x = Math.max(0, (cx - w / 2 - padX) / scale)
    const y = Math.max(0, (cy - h / 2 - padY) / scale)
    const x2 = Math.min(srcW, (cx + w / 2 - padX) / scale)
    const y2 = Math.min(srcH, (cy + h / 2 - padY) / scale)
    cands.push({ x, y, w: x2 - x, h: y2 - y, score: best, id: bestId })
  }
  cands.sort((a, b) => b.score - a.score)
  const kept = []
  for (const c of cands) {
    if (kept.every((k) => k.id !== c.id || iou(k, c) < NMS_IOU)) kept.push(c)
    if (kept.length >= 10) break
  }
  return kept.map((k) => ({
    boundingBox: { originX: k.x, originY: k.y, width: k.w, height: k.h },
    categories: [{ categoryName: COCO_NAMES[k.id], score: k.score }],
  }))
}

export async function createYoloDetector({
  modelUrl = YOLO_MODEL_PATH, wasmPath = YOLO_WASM_PATH, session: injected = null,
} = {}) {
  ort.env.wasm.wasmPaths = wasmPath
  ort.env.wasm.numThreads = 1 // 多執行緒需要 COOP/COEP，Pages 上沒開
  ort.env.wasm.proxy = true // 推論放到 worker：YOLO 在主執行緒跑一次要數百毫秒，會卡住骨架線
  const session = injected ?? await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(SIZE, SIZE)
    : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE })
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const input = new Float32Array(3 * SIZE * SIZE)

  return {
    async detect(videoEl) {
      const srcW = videoEl.videoWidth
      const srcH = videoEl.videoHeight
      const scale = Math.min(SIZE / srcW, SIZE / srcH)
      const dw = Math.round(srcW * scale)
      const dh = Math.round(srcH * scale)
      const padX = (SIZE - dw) / 2
      const padY = (SIZE - dh) / 2
      ctx.fillStyle = 'rgb(114,114,114)'
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.drawImage(videoEl, padX, padY, dw, dh)
      const px = ctx.getImageData(0, 0, SIZE, SIZE).data
      const plane = SIZE * SIZE
      for (let i = 0; i < plane; i++) {
        input[i] = px[i * 4] / 255
        input[plane + i] = px[i * 4 + 1] / 255
        input[2 * plane + i] = px[i * 4 + 2] / 255
      }
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) })
      const t = out[session.outputNames[0]]
      return { detections: decodeYolo(t.data, t.dims[2], { scale, padX, padY, srcW, srcH }) }
    },
    close() { session.release?.() },
  }
}
