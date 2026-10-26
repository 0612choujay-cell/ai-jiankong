<template>
  <div ref="el" class="bg-blur" :style="style" aria-hidden="true" />
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { personEllipse, smoothEllipse, growClearRegion, handCircles, carveHands } from '../core/blurRegion.js'

// 背景模糊：在鏡頭畫面上蓋一層 backdrop-filter，用人像分割遮罩把「人」留清楚；
// 拿不到遮罩時退回用姿勢外框算的橢圓。
// 跟骨架疊加層一樣只吃 onPoseFrame() 的推送，landmark 算完橢圓就丟。
// 還沒偵測到人（開場）時整個畫面都先模糊，偵測到之後橢圓內才變清楚。
const props = defineProps({
  inference: { type: Object, default: null },
  video: { type: Object, default: null },
})

const el = ref(null)
const ellipse = ref(null)
const maskUrl = ref(null)
let off = null
let offMask = null
let maskCanvas = null
let offHand = null
let lastRaw = null // 最近一張遮罩（背景透明度，純陣列），手的位置更新時重畫
let circles = [] // 手周圍的清楚圓（純量）

// 人像遮罩（{ w, h, data }：背景透明度）→ PNG data URL，當 CSS mask-image 用。
// 遮罩只活在這次呼叫裡，轉成圖之後不保留原始陣列。
const GROW_PX = 10 // 使用者要求：清楚範圍再往外擴 10px
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

function render(raw) {
  try {
    const box = el.value?.parentElement
    const vw = props.video?.videoWidth
    const vh = props.video?.videoHeight
    const cover = box && vw && vh ? Math.max(box.clientWidth / vw, box.clientHeight / vh) : 1
    // 遮罩一格 ≈ 影片 vw/raw.w 個影片像素 × cover 個螢幕像素
    const m = carveHands(growClearRegion(raw, GROW_PX, ((vw || raw.w) / raw.w) * cover), circles)
    maskCanvas ??= document.createElement('canvas')
    maskCanvas.width = m.w
    maskCanvas.height = m.h
    const ctx = maskCanvas.getContext('2d')
    const img = ctx.createImageData(m.w, m.h)
    for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = m.data[i]
    ctx.putImageData(img, 0, 0)
    maskUrl.value = `url(${maskCanvas.toDataURL('image/png')})`
  } catch {
    maskUrl.value = null // 轉不出來就退回橢圓
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

const style = computed(() => {
  if (maskUrl.value) {
    // 遮罩是原始影像方向；預覽是水平鏡像，所以把這層翻過來（模糊本身左右對稱，翻轉不影響畫面）。
    return {
      transform: 'scaleX(-1)',
      maskImage: maskUrl.value,
      WebkitMaskImage: maskUrl.value,
      maskSize: 'cover',
      WebkitMaskSize: 'cover',
      maskPosition: 'center',
      WebkitMaskPosition: 'center',
    }
  }
  const e = ellipse.value
  if (!e) return null
  const mask = `radial-gradient(ellipse ${e.rx}px ${e.ry}px at ${e.cx}px ${e.cy}px, transparent 70%, #000 100%)`
  return { maskImage: mask, WebkitMaskImage: mask }
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
.bg-blur {
  position: absolute; inset: 0; pointer-events: none;
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
}
</style>
