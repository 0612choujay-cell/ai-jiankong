<template>
  <section class="task-check">
    <h3>你說要：{{ goal }}</h3>
    <p class="ask">拍下你做好的成果</p>
    <label class="shoot">
      📷 拍照
      <input type="file" accept="image/*" capture="environment" @change="onPhoto">
    </label>
    <img v-if="photoUrl" :src="photoUrl" alt="你拍的成果" class="photo">

    <p v-if="status === 'checking'" class="ask">AI 正在看你的成果⋯</p>
    <p v-else-if="status === 'error'" class="ask">AI 暫時看不了，請自己選</p>

    <template v-if="status === 'error'">
      <p class="ask">有做完嗎？</p>
      <div class="row">
        <button type="button" :class="{ on: done === true }" @click="done = true">做完了</button>
        <button type="button" :class="{ on: done === false }" @click="done = false">還沒做完</button>
      </div>
    </template>

    <p v-if="done === true && status === 'ok'" class="ask">✅ 都寫完了</p>
    <article v-if="done === false" class="help">
      <h4>沒做完，下次這樣進步</h4>
      <p v-if="reason" class="reason">{{ reason }}</p>
      <ul>
        <li v-for="t in TIPS" :key="t">{{ t }}</li>
      </ul>
    </article>
  </section>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { checkTaskPhoto } from '../core/taskPhotoCheck.js'

const props = defineProps({
  taskType: { type: String, default: 'homework' },
  taskLabel: { type: String, default: '' },
})

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
const done = ref(null)
const status = ref('idle') // idle | checking | ok | error
const reason = ref('')

// 照片只放在這一頁的記憶體（object URL），不存、不上傳，離開頁面就釋放。
function onPhoto(ev) {
  const f = ev.target.files?.[0]
  if (!f) return
  if (photoUrl.value) URL.revokeObjectURL(photoUrl.value)
  photoUrl.value = URL.createObjectURL(f)
  runCheck(f)
}
// 照片縮小後送到雲端 AI 判斷有沒有寫完（使用者要求；隱私說明頁已寫明）。
async function runCheck(f) {
  status.value = 'checking'
  done.value = null
  reason.value = ''
  try {
    const r = await checkTaskPhoto(f, goal.value)
    done.value = r.finished === true
    reason.value = r.finished ? '' : (r.reason ?? '')
    status.value = 'ok'
  } catch {
    status.value = 'error'
  }
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
.row { display: flex; gap: 12px; justify-content: center; }
.row button { min-height: var(--tap-min); padding: 0 20px; }
.row button.on { outline: 3px solid currentColor; }
.help { margin-top: 12px; text-align: left; }
.help ul { margin: 0; padding-left: 1.2em; }
</style>
