<template>
  <div v-if="message" class="banner" :class="message.kind" role="status" aria-live="polite">
    <p class="text">{{ message.text }}</p>
    <p v-if="undoRemainSec !== null" class="countdown">還剩 {{ undoRemainSec }} 秒</p>
    <!-- 撤銷鈕的文字要對得上陷阱的原因，不能兩種都講同一句：「我沒有在玩
         那個」是回應「畫面裡有東西」，套在「你離開了專注畫面」上文不對題
         ——小孩看不懂自己在否認什麼。message.icon 在這裡等同陷阱種類
         （'phone'／'away'，見 postureCoach.js 發布 trapPending 訊息時
         `icon: key` 那一行，跟畫面上顯示的說明文字用同一個判準，不是另外
         發明一個欄位）。 -->
    <button v-if="message.trapId" class="undo" @click="$emit('undo', message.trapId)">
      {{ message.icon === 'away' ? '我沒有離開' : '我沒有在玩那個' }}
    </button>
    <button v-if="message.showBreakButton" class="undo" @click="$emit('break')">
      休息一下
    </button>
  </div>
</template>

<script setup>
defineProps({
  message: { type: Object, default: null },
  // 陷阱撤銷窗口還剩幾秒；只有 message.trapId 存在時才有意義。這不是次要裝飾——
  // 撤銷是「我沒有在摸魚」的唯一出口，看不到剩多少時間，小孩會不知道還來不來得及按。
  undoRemainSec: { type: Number, default: null },
})
defineEmits(['undo', 'break'])
</script>

<style scoped>
.banner {
  position: absolute;
  top: max(var(--gap), env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  max-width: min(92vw, 760px);
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--gap);
  padding: 12px 20px;
  border-radius: var(--radius);
  background: var(--c-surface);
  /* 不單靠顏色：每一類都有各自的左側粗邊 */
  border-left: 8px solid var(--c-text-dim);
}
.banner.safety { border-left-color: var(--c-ok); }
.banner.posture { border-left-color: var(--c-warn); }
.banner.trap { border-left-color: var(--c-danger); }
.text { margin: 0; font-size: var(--fs-coach); font-weight: 700; line-height: 1.3; }
.countdown {
  margin: 0; font-size: var(--fs-body); font-weight: 700;
  color: var(--c-danger); font-variant-numeric: tabular-nums;
}
.undo { min-width: var(--tap-min); min-height: var(--tap-primary); padding: 0 18px;
        white-space: nowrap; background: var(--c-bg); touch-action: manipulation; }
@media (orientation: portrait) {
  .text { font-size: 28px; }
}
</style>
