<template>
  <!-- 純裝飾層，同 PoseSkeletonOverlay：aria-hidden、pointer-events:none。
       三張畫布各畫一種來源（身體／臉／手），各自清各自的，互不覆蓋。 -->
  <canvas ref="bodyEl" class="openpose" aria-hidden="true" />
  <canvas ref="faceEl" class="openpose" aria-hidden="true" />
  <canvas ref="handEl" class="openpose" aria-hidden="true" />
</template>

<script setup>
/**
 * OpenPose 風格的細節骨架：手臂＋手、臉部輪廓／五官、每隻手 21 點。
 *
 * 隱私界線跟 PoseSkeletonOverlay.vue 完全一樣（讀它的檔頭）：landmarks 只能是
 * draw 函式的參數，不得存進 ref／reactive／模組變數／DOM，畫布不得序列化，
 * 不得 import session／storage／poseGeometry。這個元件只負責畫，不做任何判斷。
 *
 * 座標換算（object-fit 的裁切／留白）與 scaleX(-1) 鏡像跟 PoseSkeletonOverlay
 * 同一套：畫的是未鏡像的影像座標，靠 CSS transform 對齊鏡像預覽。
 */
import { ref, watch, onBeforeUnmount } from 'vue'
import { HandLandmarker } from '@mediapipe/tasks-vision'

const props = defineProps({
  inference: { type: Object, default: null },
  video: { type: Object, default: null },
  fit: { type: String, default: 'cover', validator: (v) => v === 'cover' || v === 'contain' },
})

const MIN_VISIBILITY = 0.5

// 官方連線表（MediaPipe 內建常數），不自己手抄索引。
const HAND_LINES = HandLandmarker.HAND_CONNECTIONS
// 身體只畫手臂與手指（躯幹與頸線由 PoseSkeletonOverlay 負責，會隨姿勢變色）。
// 索引：肩 11/12、肘 13/14、腕 15/16、小指 17/18、食指 19/20、拇指 21/22。
const ARM_LINES = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [15, 21], [17, 19],
  [16, 18], [16, 20], [16, 22], [18, 20],
]
// 臉部粗點：鼻 0、眼 2/5、耳 7/8、嘴角 9/10（pose 模型自帶，臉網格沒偵測到時的備援）。
const FACE_DOTS = [0, 2, 5, 7, 8, 9, 10]

const bodyEl = ref(null)
const faceEl = ref(null)
const handEl = ref(null)

// 繪圖內部快取，刻意是 let（理由同 PoseSkeletonOverlay）。
const layers = [
  { el: bodyEl, ctx: null, w: 0, h: 0 },
  { el: faceEl, ctx: null, w: 0, h: 0 },
  { el: handEl, ctx: null, w: 0, h: 0 },
]

// 取得（必要時重配置）畫布，回傳 [layer, W, H] 或 null。
function prepare(layer) {
  const el = layer.el.value
  if (!el) return false
  if (layer.ctx === null) {
    layer.ctx = typeof el.getContext === 'function' ? el.getContext('2d') : null
    if (!layer.ctx) return false
  }
  const cw = el.clientWidth
  const ch = el.clientHeight
  if (cw > 0 && ch > 0 && (cw !== layer.w || ch !== layer.h)) {
    layer.w = cw
    layer.h = ch
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0
      ? Math.min(window.devicePixelRatio, 2) : 1
    el.width = Math.round(cw * dpr)
    el.height = Math.round(ch * dpr)
  }
  if (!(el.width > 0) || !(el.height > 0)) return false
  layer.ctx.clearRect(0, 0, el.width, el.height)
  return true
}

// 影像座標 → 畫布像素的 [offsetX, offsetY, scaleX, scaleY]。
function mapping(W, H) {
  const vw = props.video?.videoWidth ?? 0
  const vh = props.video?.videoHeight ?? 0
  if (!(vw > 0 && vh > 0)) return [0, 0, W, H]
  const k = props.fit === 'contain' ? Math.min(W / vw, H / vh) : Math.max(W / vw, H / vh)
  return [(W - vw * k) / 2, (H - vh * k) / 2, vw * k, vh * k]
}

const ok = (p) => !!p && (p.visibility === undefined || p.visibility >= MIN_VISIBILITY)

// OpenPose 的特色：每一段用不同色相。用 index 算色相，不需要色表。
const hue = (i, n) => `hsl(${Math.round((i / n) * 330)} 95% 60%)`

function lineTo(ctx, a, b, ox, oy, sx, sy) {
  ctx.beginPath()
  ctx.moveTo(ox + a.x * sx, oy + a.y * sy)
  ctx.lineTo(ox + b.x * sx, oy + b.y * sy)
  ctx.stroke()
}

function dot(ctx, p, r, ox, oy, sx, sy) {
  ctx.beginPath()
  ctx.arc(ox + p.x * sx, oy + p.y * sy, r, 0, Math.PI * 2)
  ctx.fill()
}

function drawBody(lm) {
  const layer = layers[0]
  if (!prepare(layer)) return
  if (!Array.isArray(lm) || lm.length < 33) return
  const { width: W, height: H } = layer.el.value
  const [ox, oy, sx, sy] = mapping(W, H)
  const ctx = layer.ctx
  const lw = Math.max(2, W * 0.005)
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  for (let i = 0; i < ARM_LINES.length; i += 1) {
    const a = lm[ARM_LINES[i][0]]
    const b = lm[ARM_LINES[i][1]]
    if (!ok(a) || !ok(b)) continue
    ctx.strokeStyle = hue(i, ARM_LINES.length)
    lineTo(ctx, a, b, ox, oy, sx, sy)
  }
  ctx.fillStyle = '#fff'
  for (let i = 11; i <= 22; i += 1) if (ok(lm[i])) dot(ctx, lm[i], lw * 1.1, ox, oy, sx, sy)
  for (let i = 0; i < FACE_DOTS.length; i += 1) {
    const p = lm[FACE_DOTS[i]]
    if (ok(p)) dot(ctx, p, lw * 0.9, ox, oy, sx, sy)
  }
}

function drawHands(hands) {
  const layer = layers[2]
  if (!prepare(layer)) return
  if (!Array.isArray(hands)) return
  const { width: W, height: H } = layer.el.value
  const [ox, oy, sx, sy] = mapping(W, H)
  const ctx = layer.ctx
  const lw = Math.max(1.5, W * 0.0035)
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  for (let h = 0; h < hands.length; h += 1) {
    const lm = hands[h]
    if (!Array.isArray(lm) || lm.length < 21) continue
    for (let i = 0; i < HAND_LINES.length; i += 1) {
      const a = lm[HAND_LINES[i].start]
      const b = lm[HAND_LINES[i].end]
      if (!a || !b) continue
      // 五根手指各一個色相（連線表依手掌＋拇指→小指排列，用終點 index 分組）。
      ctx.strokeStyle = hue(Math.ceil(HAND_LINES[i].end / 4), 5)
      lineTo(ctx, a, b, ox, oy, sx, sy)
    }
    ctx.fillStyle = '#fff'
    for (let i = 0; i < 21; i += 1) dot(ctx, lm[i], lw * 0.9, ox, oy, sx, sy)
  }
}

let unsubs = []
function unsubscribeAll() {
  for (let i = 0; i < unsubs.length; i += 1) unsubs[i]?.()
  unsubs = []
}

watch(() => props.inference, (inf) => {
  unsubscribeAll()
  if (!inf) return
  unsubs = [
    typeof inf.onPoseFrame === 'function' ? inf.onPoseFrame(drawBody) : null,
    // 臉部網格線（使用者要求拿掉）：不再訂閱 onFaceFrame，也不畫臉。
    typeof inf.onHandFrame === 'function' ? inf.onHandFrame(drawHands) : null,
  ]
}, { immediate: true })

onBeforeUnmount(() => {
  unsubscribeAll()
  for (const l of layers) l.ctx = null
})
</script>

<style scoped>
/* 盒子與鏡像 transform 跟 PoseSkeletonOverlay 逐字相同，線條才會對準預覽。
   刻意沒有 transition／animation／filter。 */
.openpose {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  transform: scaleX(-1);
}
</style>
