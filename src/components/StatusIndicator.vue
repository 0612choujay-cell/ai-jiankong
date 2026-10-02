<template>
  <div class="status-indicator">
    <button class="dot-row" :aria-expanded="open" @click="open = !open">
      <span class="dot" :class="worst" aria-hidden="true" />
      <span class="text">{{ headline }}</span>
    </button>

    <ul v-if="open || worst !== 'ok'" class="list">
      <li v-for="item in visible" :key="item.id" :class="item.level">
        <span class="tag" aria-hidden="true">{{ ICON[item.level] }}</span>
        <span>{{ item.text }}</span>
        <button v-if="item.action" class="act" @click="$emit('action', item.id)">
          {{ item.action }}
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

/**
 * 正常時只是一個綠點＋「偵測中」，一直攤開一堆狀態列只會製造焦慮而沒有資訊量
 * （見 brief 的產品判斷）。異常或降級才展開細節；點擊也能手動展開/收合。
 *
 * 刻意不在這裡放 camera/inference 健康度：那兩件事已經有 App.vue 自己的
 * health-overlay（經過好幾輪審查、有明確的「按暫停再按繼續」復原指引），
 * 這裡重複顯示反而會變成兩套並存的復原路徑，對小孩是更混亂的畫面。這個
 * 元件目前只承載「效能降級」「手機偵測暫停」這類目前完全沒有任何 UI
 * 反映、但小孩會直接感受到（偵測變慢／收起手機卻還是被判定分心）的狀態。
 */
const props = defineProps({ items: { type: Array, default: () => [] } })
defineEmits(['action'])

const ICON = { ok: '●', warn: '▲', error: '■' }
const open = ref(false)

// 正常時收斂為一個綠點；異常/降級才展開
const visible = computed(() => props.items.filter((i) => i.level !== 'ok'))
const worst = computed(() => {
  if (props.items.some((i) => i.level === 'error')) return 'error'
  if (props.items.some((i) => i.level === 'warn')) return 'warn'
  return 'ok'
})
const headline = computed(() => (worst.value === 'ok' ? '偵測中' : `${visible.value.length} 項需要注意`))
</script>

<style scoped>
.status-indicator { font-size: var(--fs-body); }
.dot-row {
  display: flex; align-items: center; gap: 8px; background: transparent;
  min-height: var(--tap-min); padding: 0 8px; touch-action: manipulation;
}
/* 不單靠顏色：形狀（●▲■）與文字同時傳達。只用 background-color/border-radius
   這類不觸發 layout 的靜態切換，不做任何 transition/動畫——見 Task 16 對
   「量測與動畫本身不能變成效能問題」的要求，這顆點常駐在畫面上、疊在
   鏡頭畫面之上，box-shadow/filter 成本高，這裡刻意不用。 */
.dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
.dot.ok { background: var(--c-ok); }
.dot.warn { background: var(--c-warn); border-radius: 2px; }
.dot.error { background: var(--c-danger); border-radius: 0; }
.list {
  list-style: none; margin: 8px 0 0; padding: 10px; background: var(--c-surface);
  border-radius: var(--radius); display: flex; flex-direction: column; gap: 10px;
  max-width: min(80vw, 320px);
}
.list li { display: flex; align-items: center; gap: 8px; }
.list .warn { color: var(--c-warn); }
.list .error { color: var(--c-danger); }
/* 掃描時發現的同一類缺口（見 App.vue 的 Blocking 修復註解）：`.text`／
   `.tag` 在 template 裡用到，但這裡從來沒有為它們寫過對應規則。跟 App.vue
   的 .hint/.warn 不同，這裡沒有「其他元件定義了同名 class、讓人誤以為
   套用了對應樣式」這種混淆來源，純粹是漏寫，視覺上目前沒有缺陷（純文字／
   圖示 span 本來就靠父層與瀏覽器預設值正確顯示）。
   `.tag`（●▲■ 三種圖示字元，寬度不同）給一個固定的最小寬度並置中，讓
   後面接著的文字在三種狀態下對齊起始位置一致，是這裡唯一有實際視覺效果
   的補強；`.text` 只是把既有的隱含行為（inline 排版）明文寫出來。 */
.text { display: inline; }
.tag { display: inline-block; min-width: 1.2em; text-align: center; }
.act {
  min-width: var(--tap-min); min-height: var(--tap-min); padding: 0 12px;
  background: var(--c-bg); color: var(--c-text); touch-action: manipulation;
}
</style>
