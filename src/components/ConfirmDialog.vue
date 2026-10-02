<template>
  <div ref="root" class="backdrop" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
    <div class="box">
      <h3>{{ title }}</h3>
      <p>{{ body }}</p>
      <div class="row">
        <!-- 「繼續討伐」在上、實心強調色；「結束」在下、次要樣式——
             誤觸的成本不對稱：多按一次「繼續」沒有代價，誤按「結束」會提早收掉這一輪。 -->
        <button class="primary keep" @click="$emit('cancel')">{{ cancelText }}</button>
        <button class="primary stop" @click="$emit('confirm')">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

defineProps({
  title: { type: String, default: '要結束這一輪嗎？' },
  body: { type: String, default: '現在結束，成績依然保留' },
  confirmText: { type: String, default: '結束這一輪' },
  cancelText: { type: String, default: '繼續討伐' },
})
defineEmits(['confirm', 'cancel'])

// Important 3（版面／可及性複審）：這個元件宣告 aria-modal="true"，但複審
// 發現全專案**零焦點管理**（沒有 .focus()、autofocus、tabindex、inert）——
// 宣告了一件程式沒有做到的事。VoiceOver 或外接鍵盤使用者可以在對話框開著
// 的時候，用 Tab／線性導覽「穿過」它，繼續在背景內容上移動。
//
// 這裡補上最小可行的焦點管理：開啟時把焦點移進對話框（優先給第一顆按鈕，
// 找不到就退回對話框自己的根節點——tabindex="-1" 讓一個沒有原生可聚焦性的
// <div> 也能被程式化 focus()，但不會被 Tab 巡覽到，符合它只是「保底」不是
// 正常路徑的定位），關閉（卸載）時把焦點送回開啟它之前使用者所在的元素。
//
// focus trap（Tab 循環鎖在對話框內）：這裡做了，因為這個對話框固定只有
// 兩顆按鈕，範圍小、邏輯單純，直接鎖比拿掉 aria-modal 更誠實地兌現了
// 「模態」這個宣告。
//
// 已知局限（誠實記錄，做不到的部分）：
// - iOS Safari 有個廣為人知的行為——輕觸按鈕預設**不會**把它變成
//   document.activeElement（跟其他瀏覽器不一樣）。這代表「記住觸發它的
//   元素、關閉後還回去」這件事，在單純觸控操作、沒有 VoiceOver 的情境下，
//   previouslyFocused 很可能從一開始就是 document.body，還原等於沒動作
//   ——但這個 App 的主要使用者正是這種「觸控、沒有輔具」的小孩，所以這個
//   局限對他們沒有實際影響（他們本來就感覺不到焦點環）。真正在意這件事的
//   是 VoiceOver 使用者，而 VoiceOver 的觸控互動模型會把無障礙焦點對應到
//   DOM focus，所以對這個元件真正的目標族群，這裡的行為預期是正確的——
//   但這個假設沒有在真機上驗證過，列進文末的「必須真機確認」清單。
// - 這裡沒有處理 Escape 鍵關閉：這個 App 的兩個危險/安全按鈕都已經在畫面
//   上，鍵盤使用者不常見，加 Escape 語意上等同「取消」，但目前沒有測試
//   覆蓋，暫不加，避免引入一個沒被驗證過的新出口。
const root = ref(null)
let previouslyFocused = null

function focusableEls() {
  if (!root.value) return []
  return [...root.value.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.disabled)
}

function trapTab(e) {
  if (e.key !== 'Tab') return
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
.box { background: var(--c-surface); border-radius: var(--radius); padding: 24px;
       max-width: 460px; text-align: center; }
h3 { font-size: var(--fs-title); margin: 0 0 12px; }
p { font-size: var(--fs-body); color: var(--c-text-dim); margin: 0 0 24px; }
.row { display: flex; gap: var(--gap); flex-direction: column; }
.row button { min-height: var(--tap-primary); touch-action: manipulation; }
.keep { background: var(--c-accent); color: #06212b; }
.stop { background: transparent; outline: 2px solid var(--c-text-dim); }
</style>
