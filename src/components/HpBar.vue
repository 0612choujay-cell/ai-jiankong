<template>
  <div class="hp" :class="side">
    <div class="label">
      <span>{{ label }}</span>
      <span class="num">{{ displayValue }} / {{ max }}</span>
    </div>
    <!-- 分形態顯示：segments 有內容時，同一條 track 橫向切成 N 小段，
         每段一個形態，不是另外疊一行——這樣 .boss-hud 的高度跟只有一條
         血條時完全一樣，BattleView.vue 那組大招碰撞手算（.boss-hud 下緣
         的安全餘裕）不必重算。沒有 segments（hero 側、或魔王還在第一形態）
         就是原本那條單一血條，一個字都沒變。 -->
    <div
      class="track" :class="{ segmented: segments && segments.length > 1 }" role="progressbar"
      :aria-valuenow="displayValue" :aria-valuemin="0" :aria-valuemax="max" :aria-label="label"
    >
      <template v-if="segments && segments.length > 1">
        <div v-for="(seg, i) in segments" :key="i" class="seg" :class="{ cleared: seg.cleared }">
          <div class="fill" :style="{ transform: `scaleX(${segRatio(seg)})` }" />
        </div>
      </template>
      <div v-else class="fill" :style="{ transform: `scaleX(${ratio})` }" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  label: { type: String, required: true },
  value: { type: Number, required: true },
  max: { type: Number, required: true },
  side: { type: String, default: 'hero' }, // 'hero' | 'boss'
  /**
   * 選用：依形態切分的血條區段，只有魔王側、形態 > 1 時才會傳。
   * 每個元素 `{ ratio, cleared }`——`ratio` 是該區段自己的 [0,1] 填滿比例
   * （已破的形態固定是 1，正在打的當前形態是即時算出來的比例），`cleared`
   * 是它是不是已經破過的形態（true 時用 --c-ok 綠色，跟正在打的那格
   * 用魔王色區分開，一眼看得出「這幾格已經贏了」）。
   *
   * 這個 prop 完全不影響 value／max／aria-*：那三個永遠代表**當前形態**
   * 的即時血量，跟 segments 是純視覺疊加層，兩者不是同一組真相——
   * 就算哪天 segments 算錯，畫面上的數字（80 / 100）仍然誠實。
   */
  segments: { type: Array, default: null },
})

// 數字一律顯示，不單靠顏色與長度傳達；數字與血條長度必須套用同一個 [0, max]
// clamp，否則會出現「血條已經畫滿但數字顯示 999/100」這種自我矛盾的畫面——
// 數字存在的意義就是給血條長度一個可核對的依據，兩者不一致等於白做。
const displayValue = computed(() => Math.max(0, Math.min(props.max, Math.round(props.value))))
const ratio = computed(() => Math.max(0, Math.min(1, props.value / props.max)))

// 跟上面的 ratio 同一個 clamp：segments 是外部（BattleView）算出來的資料，
// 這裡不信任它一定落在 [0,1] 內——理由跟 displayValue／ratio 一樣，畫面
// 不能因為呼叫端算錯而畫出 scaleX > 1 或負值。
function segRatio(seg) {
  return Math.max(0, Math.min(1, seg?.ratio ?? 0))
}
</script>

<style scoped>
.hp { width: 100%; }
.label { display: flex; justify-content: space-between; font-size: var(--fs-body); margin-bottom: 4px; }
.num { font-variant-numeric: tabular-nums; }
.track { height: 18px; background: var(--c-surface); border-radius: 9px; overflow: hidden; }
/* 只動 transform，不動 width——動 width 會觸發 layout */
.fill { height: 100%; transform-origin: left center; transition: transform .25s ease-out; }
.hero .fill { background: var(--c-hero); }
.boss .fill { background: var(--c-boss); }

/* 分段模式：track 本身不再直接畫底色／圓角，改由每一段各自的 .seg 負責，
   段與段之間留一條縫（gap）當分隔線——不用 border，border 在極小高度
   （18px）下視覺上太重。 */
.track.segmented { display: flex; gap: 3px; background: transparent; border-radius: 0; overflow: visible; }
.seg { flex: 1; height: 100%; background: var(--c-surface); border-radius: 6px; overflow: hidden; }
.seg.cleared .fill { background: var(--c-ok); }
</style>
