<template>
  <div ref="root" class="backdrop" role="dialog" aria-modal="true" aria-label="工作人員設定" tabindex="-1">
    <div class="sheet">
      <div class="scroll">
        <h2>工作人員設定</h2>

        <div class="row">
          <span class="label">語音提示</span>
          <button
            class="switch" :class="{ on: voiceEnabled }"
            role="switch" :aria-checked="voiceEnabled"
            @click="$emit('toggle-voice')"
          >
            {{ voiceEnabled ? '開啟' : '關閉' }}
          </button>
        </div>

        <div class="row">
          <span class="label">手機偵測</span>
          <button
            class="switch" :class="{ on: phoneDetectEnabled }"
            role="switch" :aria-checked="phoneDetectEnabled"
            @click="$emit('toggle-phone-detect')"
          >
            {{ phoneDetectEnabled ? '開啟' : '關閉' }}
          </button>
        </div>
        <p class="hint">關閉後不判定在滑手機</p>

        <!-- Ruling CR：降檔是自動發生、畫面上沒有主動提示，工作人員不會主動
             想到來按按鈕。這裡不只放一顆按鈕，而是先給一句永遠看得到的狀態字，
             跟 perfMode 綁在一起，狀態變了字就跟著變。 -->
        <div class="row">
          <span class="label">效能模式</span>
          <span class="status">{{ perfMode ? '目前是省電模式' : '目前是完整模式' }}</span>
        </div>
        <button
          class="reset" :disabled="!perfMode"
          @click="$emit('reset-perf-mode')"
        >
          重設效能模式
        </button>

        <div class="danger">
          <button
            class="clear" :disabled="clearState === 'busy'"
            @click="showConfirm = true"
          >
            {{ clearButtonLabel }}
          </button>
          <p v-if="clearState === 'done'" class="clear-msg ok">已清除本地紀錄</p>
          <p v-if="clearState === 'error'" class="clear-msg err">清除失敗，請再試</p>
        </div>
      </div>

      <button class="close" @click="$emit('close')">關閉設定</button>
    </div>

    <ConfirmDialog
      v-if="showConfirm"
      title="清除所有本地紀錄？"
      body="清除本地紀錄，之後回不來"
      confirm-text="清除紀錄"
      cancel-text="先不要"
      @confirm="onConfirmClear"
      @cancel="showConfirm = false"
    />
  </div>
</template>

<script setup>
import {
  ref, computed, onMounted, onBeforeUnmount,
} from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps({
  voiceEnabled: { type: Boolean, required: true },
  phoneDetectEnabled: { type: Boolean, required: true },
  perfMode: { type: Boolean, required: true },
  clearState: { type: String, required: true }, // 'idle' | 'busy' | 'done' | 'error'
})

const emit = defineEmits([
  'toggle-voice', 'toggle-phone-detect', 'reset-perf-mode', 'clear-all', 'close',
])

// 這個元件不持有真相：對話框開關是唯一的本地 UI 狀態，其餘全部來自 props。
const showConfirm = ref(false)

// clearState 有四種，按鈕文字各自要清楚——尤其 'error' 不能長得像成功。
const clearButtonLabel = computed(() => {
  if (props.clearState === 'busy') return '清除中'
  if (props.clearState === 'done') return '清除所有紀錄'
  if (props.clearState === 'error') return '再清一次'
  return '清除所有紀錄'
})

function onConfirmClear() {
  showConfirm.value = false
  emit('clear-all')
}

// Important 3（版面／可及性複審）：跟 ConfirmDialog.vue 同一個修法與同一份
// 已知局限，理由見那個檔案的註解，這裡不重複整段——差異只有一點：
//
// 這個面板自己的 <ConfirmDialog>（清除所有紀錄的二次確認）在 DOM 上是
// `root`（本元件的 .backdrop）底下的子節點，所以 root.value.querySelectorAll
// 找可聚焦元素時，showConfirm 為 true 時也會抓到巢狀 ConfirmDialog 的兩顆
// 按鈕。如果這裡的 trapTab 在那個當下還繼續運作，會跟 ConfirmDialog 自己的
// trap 同時搶著處理同一個 Tab 事件（兩個 document 層級的 keydown 監聽器都
// 會被觸發，先跑的那個一改 focus，後跑的那個又基於新的 activeElement 再判斷
// 一次，兩層 trap 互相干擾）。guard 很單純：showConfirm 開著的時候，這一層
// 的 trap 整個讓開，焦點循環完全交給巢狀的 ConfirmDialog 處理；它自己關閉
// 時會把焦點還給觸發它的「清除所有紀錄」按鈕，剛好還在這一層的可聚焦清單裡，
// 不需要這裡再做任何事。
const root = ref(null)
let previouslyFocused = null

function focusableEls() {
  if (!root.value) return []
  return [...root.value.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.disabled)
}

function trapTab(e) {
  if (e.key !== 'Tab' || showConfirm.value) return
  const items = focusableEls()
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  previouslyFocused = document.activeElement
  const items = focusableEls()
  ;(items[0] ?? root.value)?.focus()
  document.addEventListener('keydown', trapTab)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', trapTab)
  if (previouslyFocused && document.body.contains(previouslyFocused)) previouslyFocused.focus()
})
</script>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center;
            background: rgba(0, 0, 0, .6); padding: var(--gap); }
.sheet {
  background: var(--c-surface); border-radius: var(--radius);
  width: min(480px, 100%); max-height: 90vh;
  display: flex; flex-direction: column;
  padding-bottom: calc(var(--gap) + env(safe-area-inset-bottom));
}
/* 複審 Important #3：這裡原本寫了一個 max-height 公式
   （90vh - tap-primary - gap），想預先算出「扣掉 .close 之後剩多少高度」，
   但公式忘了扣 .sheet 的 padding-bottom（約 36px），數字本身對不上。而且
   即使公式算對，也只是「重算一次 .sheet/.close 已經用 flex 保證過的事」——
   真正讓 .close 不被捲出去的是 .close 的 flex-shrink:0（絕不壓縮）跟
   .scroll 的 overflow-y:auto（依 flexbox 規範讓它的自動最小高度為 0，
   可被無限壓縮），這兩條已經是唯一事實來源。一個對不上、也沒有在做事的
   死數字比沒有數字更危險——本專案這一輪另一個工項也是同樣理由刪掉一段
   死碼，這裡採同一個方向：不重算，直接讓 flex 自己收斂高度，靠
   overflow-y:auto 在真的塞不下時顯示捲動軸。 */
.scroll {
  overflow-y: auto;
  padding: var(--gap); display: flex; flex-direction: column; gap: var(--gap);
}
h2 { font-size: var(--fs-title); margin: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--gap); }
.label { font-size: var(--fs-body); }
.switch {
  min-width: 88px; min-height: var(--tap-min); border-radius: var(--radius);
  background: transparent; outline: 2px solid var(--c-text-dim); color: var(--c-text-dim);
}
.switch.on { background: var(--c-accent); color: #06212b; outline: none; }
.hint { margin: -8px 0 0; font-size: 14px; color: var(--c-text-dim); }
.status { font-size: var(--fs-body); color: var(--c-text-dim); }
.reset {
  min-height: var(--tap-min); background: transparent; outline: 2px solid var(--c-accent);
  color: var(--c-text);
}
.reset:disabled { outline-color: var(--c-text-dim); color: var(--c-text-dim); opacity: .6; }
.danger { display: flex; flex-direction: column; gap: 8px; }
.clear { min-height: var(--tap-primary); background: transparent; outline: 2px solid var(--c-danger); color: var(--c-danger); }
.clear:disabled { opacity: .6; }
.clear-msg { margin: 0; font-size: var(--fs-body); }
.clear-msg.ok { color: var(--c-ok); }
.clear-msg.err { color: var(--c-danger); }
.close {
  flex-shrink: 0; min-height: var(--tap-primary); margin: 0 var(--gap) var(--gap);
  background: var(--c-accent); color: #06212b;
}
</style>
