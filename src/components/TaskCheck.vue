<template>
  <section class="task-check">
    <h3>你說要：{{ goal }}</h3>
    <p class="ask">拍下你做好的成果</p>
    <label class="shoot">
      📷 拍照
      <input type="file" accept="image/*" capture="environment" @change="onPhoto">
    </label>
    <img v-if="photoUrl" :src="photoUrl" alt="你拍的成果" class="photo">

    <article v-if="!finished" class="help">
      <h4>沒做完，下次這樣進步</h4>
      <ul>
        <li v-for="t in TIPS" :key="t">{{ t }}</li>
      </ul>
    </article>
  </section>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'

const props = defineProps({
  taskType: { type: String, default: 'homework' },
  taskLabel: { type: String, default: '' },
  // 自動判斷：把魔王打倒（討伐成功）＝這次的事做完了；沒打倒就給建議。
  result: { type: String, default: null },
})
const finished = computed(() => props.result === 'victory')

const NAMES = { homework: '寫作業', reading: '看書', vocab: '背單字', custom: '完成任務' }
const goal = computed(() => props.taskLabel || NAMES[props.taskType] || '完成任務')

const TIPS = [
  '開始前先估：要花多久',
  '把事情切成小塊',
  '一次只做一小塊',
  '卡住就先跳過，回頭再做',
  '先做最難的，精神好',
  '手機放遠，眼睛離開它',
]

const photoUrl = ref(null)

// 照片只放在這一頁的記憶體（object URL），不存、不上傳，離開頁面就釋放。
function onPhoto(ev) {
  const f = ev.target.files?.[0]
  if (!f) return
  if (photoUrl.value) URL.revokeObjectURL(photoUrl.value)
  photoUrl.value = URL.createObjectURL(f)
}
onBeforeUnmount(() => { if (photoUrl.value) URL.revokeObjectURL(photoUrl.value) })
</script>

<style scoped>
.task-check { max-width: 36em; margin: 12px auto; padding: 12px 16px; background: var(--c-surface); border-radius: 12px; text-align: center; }
.task-check h3 { margin: 0 0 8px; }
.ask { margin: 8px 0; }
.shoot { display: inline-block; min-height: var(--tap-min); line-height: var(--tap-min); padding: 0 24px; border-radius: 12px; background: var(--c-surface); border: 2px solid currentColor; cursor: pointer; }
.shoot input { display: none; }
.photo { display: block; max-width: 100%; max-height: 40vh; margin: 12px auto; border-radius: 8px; }
.help { margin-top: 12px; text-align: left; }
.help ul { margin: 0; padding-left: 1.2em; }
</style>
