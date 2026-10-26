<template>
  <div ref="boxEl" class="zoom-layer" :style="style">
    <slot />
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { framingSample, computeChestUpZoom } from '../core/zoomFraming.js'

// 開場拉近到胸口以上：收集幾筆肩線／鼻子的純量（不保留 landmark），取中位數
// 算一次 scale／translate 後就固定，不跟著人晃（晃動會讓骨架線看起來飄）。
// 跟兩個骨架疊加層一樣只吃 onPoseFrame() 的推送，landmark 不離開 onPose()。
const props = defineProps({
  inference: { type: Object, default: null },
  video: { type: Object, default: null },
})

const SAMPLES = 6
const boxEl = ref(null)
const zoom = ref(null)
const style = computed(() => (zoom.value
  ? { transform: `translate(${zoom.value.tx}px, ${zoom.value.ty}px) scale(${zoom.value.scale})` }
  : null))

let samples = []
let off = null

function onPose(landmarks) {
  if (zoom.value) return
  const sample = framingSample(landmarks)
  if (!sample) return
  samples.push(sample)
  if (samples.length < SAMPLES) return
  const box = boxEl.value?.parentElement
  zoom.value = computeChestUpZoom(
    samples,
    { w: props.video?.videoWidth, h: props.video?.videoHeight },
    { w: box?.clientWidth, h: box?.clientHeight },
  )
  samples = []
  if (zoom.value) { off?.(); off = null }
}

watch(() => props.inference, (inf) => {
  off?.()
  off = typeof inf?.onPoseFrame === 'function' ? inf.onPoseFrame(onPose) : null
}, { immediate: true })

onBeforeUnmount(() => { off?.(); off = null })
</script>

<style scoped>
.zoom-layer {
  position: absolute; inset: 0; overflow: hidden;
  transform-origin: 0 0; transition: transform .8s ease;
}
</style>
