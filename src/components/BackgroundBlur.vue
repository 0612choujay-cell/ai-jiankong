<template>
  <div ref="el" class="bg-blur" :style="style" aria-hidden="true" />
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { personEllipse, smoothEllipse } from '../core/blurRegion.js'

// 背景模糊：在鏡頭畫面上蓋一層 backdrop-filter，用橢圓遮罩把「人」留清楚。
// 跟骨架疊加層一樣只吃 onPoseFrame() 的推送，landmark 算完橢圓就丟。
// 還沒偵測到人（開場）時整個畫面都先模糊，偵測到之後橢圓內才變清楚。
const props = defineProps({
  inference: { type: Object, default: null },
  video: { type: Object, default: null },
})

const el = ref(null)
const ellipse = ref(null)
let off = null

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
  const e = ellipse.value
  if (!e) return null
  const mask = `radial-gradient(ellipse ${e.rx}px ${e.ry}px at ${e.cx}px ${e.cy}px, transparent 70%, #000 100%)`
  return { maskImage: mask, WebkitMaskImage: mask }
})

watch(() => props.inference, (inf) => {
  off?.()
  off = typeof inf?.onPoseFrame === 'function' ? inf.onPoseFrame(onPose) : null
}, { immediate: true })

onBeforeUnmount(() => { off?.(); off = null })
</script>

<style scoped>
.bg-blur {
  position: absolute; inset: 0; pointer-events: none;
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
}
</style>
