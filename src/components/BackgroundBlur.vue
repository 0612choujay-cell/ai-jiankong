<template>
  <div ref="el" class="dof" aria-hidden="true">
    <div class="near" :style="nearStyle" />
    <div class="far" :style="farStyle" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { personEllipse, smoothEllipse, growClearRegion, handCircles, carveHands } from '../core/blurRegion.js'

// 景深模糊（像人像模式）：離人越遠越糊。兩層 backdrop-filter 疊起來——
// near 層輕度模糊（人以外的整個背景），far 層重度模糊（離人 FAR_GROW_PX 以外），
// 都用人像分割遮罩把「人」留清楚；拿不到遮罩時退回用姿勢外框算的橢圓。
// 跟骨架疊加層一樣只吃 onPoseFrame() 的推送，landmark 算完橢圓就丟。
// 還沒偵測到人（開場）時整個畫面都先模糊，偵測到之後橢圓／人像範圍內才變清楚。
const props = defineProps({
  inference: { type: Object, default: null },
  video: { type: Object, default: null },
})

const el = ref(null)
const ellipse = ref(null)
const nearUrl = ref(null)
const farUrl = ref(null)
let off = null
let offMask = null
let nearCanvas = null
let farCanvas = null
let offHand = null
let lastRaw = null // 最近一張遮罩（背景透明度，純陣列），手的位置更新時重畫
let circles = [] // 手周圍的清楚圓（純量）

// 人像遮罩（{ w, h, data }：背景透明度）→ PNG data URL，當 CSS mask-image 用。
// 遮罩只活在這次呼叫裡，轉成圖之後不保留原始陣列。
const GROW_PX = 10 // 使用者要求：清楚範圍再往外擴 10px
const FAR_GROW_PX = 90 // 離人這麼遠以外才套重度模糊（景深的「遠景」）
function onHands(hands) {
  const v = props.video
  circles = handCircles(hands, v?.videoWidth && v?.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3)
  if (lastRaw) render(lastRaw)
}

function onMask(raw) {
  if (!raw?.w || !raw?.h) return
  lastRaw = raw
  render(raw)
}

function toUrl(canvas, m) {
  canvas.width = m.w
  canvas.height = m.h
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(m.w, m.h)
  for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = m.data[i]
  ctx.putImageData(img, 0, 0)
  return `url(${canvas.toDataURL('image/png')})`
}

function render(raw) {
  try {
    const box = el.value?.parentElement
    const vw = props.video?.videoWidth
    const vh = props.video?.videoHeight
    const cover = box && vw && vh ? Math.max(box.clientWidth / vw, box.clientHeight / vh) : 1
    // 遮罩一格 ≈ 影片 vw/raw.w 個影片像素 × cover 個螢幕像素
    const pxPerCell = ((vw || raw.w) / raw.w) * cover
    nearCanvas ??= document.createElement('canvas')
    farCanvas ??= document.createElement('canvas')
    nearUrl.value = toUrl(nearCanvas, carveHands(growClearRegion(raw, GROW_PX, pxPerCell), circles))
    farUrl.value = toUrl(farCanvas, carveHands(growClearRegion(raw, FAR_GROW_PX, pxPerCell), circles))
  } catch {
    nearUrl.value = null // 轉不出來就退回橢圓
    farUrl.value = null
  }
}

function onPose(landmarks) {
  const box = el.value?.parentElement
  const next = personEllipse(
    landmarks,
    { w: props.video?.videoWidth, h: props.video?.videoHeight },
    { w: box?.clientWidth, h: box?.clientHeight },
  )
  ellipse.value = smoothEllipse(ellipse.value, next)
}

function maskStyle(url) {
  // 遮罩是原始影像方向；預覽是水平鏡像，所以把這層翻過來（模糊本身左右對稱，翻轉不影響畫面）。
  return {
    transform: 'scaleX(-1)',
    maskImage: url,
    WebkitMaskImage: url,
    maskSize: 'cover',
    WebkitMaskSize: 'cover',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
  }
}

function ellipseStyle(e, k) {
  const mask = `radial-gradient(ellipse ${e.rx * k}px ${e.ry * k}px at ${e.cx}px ${e.cy}px, transparent 70%, #000 100%)`
  return { maskImage: mask, WebkitMaskImage: mask }
}

const nearStyle = computed(() => {
  if (nearUrl.value) return maskStyle(nearUrl.value)
  return ellipse.value ? ellipseStyle(ellipse.value, 1) : null
})
const farStyle = computed(() => {
  if (farUrl.value) return maskStyle(farUrl.value)
  return ellipse.value ? ellipseStyle(ellipse.value, 1.6) : null
})

watch(() => props.inference, (inf) => {
  off?.()
  offMask?.()
  offHand?.()
  off = typeof inf?.onPoseFrame === 'function' ? inf.onPoseFrame(onPose) : null
  offMask = typeof inf?.onMaskFrame === 'function' ? inf.onMaskFrame(onMask) : null
  offHand = typeof inf?.onHandFrame === 'function' ? inf.onHandFrame(onHands) : null
}, { immediate: true })

onBeforeUnmount(() => { off?.(); off = null; offMask?.(); offMask = null; offHand?.(); offHand = null; lastRaw = null })
</script>

<style scoped>
.dof { position: absolute; inset: 0; pointer-events: none; }
.near, .far { position: absolute; inset: 0; }
.near { -webkit-backdrop-filter: blur(5px); backdrop-filter: blur(5px); }
.far { -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
</style>
