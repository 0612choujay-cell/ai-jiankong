<template>
  <!-- 取代原本的魔王造型：一面類比時鐘，指針指向「剩餘時間」。
       根節點沿用 .boss-sprite 與四個狀態 class，這樣 BattleView 既有的
       狀態綁定與 layout.css 的位置規則不必跟著改；時鐘本身不做動畫。 -->
  <div class="boss-sprite clock-face" :class="{ struck, charging, ultimate, attacking, phase2: phase >= 2 }" aria-hidden="true">
    <svg class="clock-svg" viewBox="0 0 200 200">
      <circle class="rim" cx="100" cy="100" r="92" />
      <circle class="face" cx="100" cy="100" r="86" />
      <line
        v-for="n in 12" :key="n" class="tick" :class="{ major: n % 3 === 0 }"
        x1="100" y1="20" x2="100" :y2="n % 3 === 0 ? 34 : 28"
        :transform="`rotate(${n * 30} 100 100)`"
      />
      <line class="hand minute" x1="100" y1="108" x2="100" y2="38" :transform="`rotate(${minuteAngle} 100 100)`" />
      <line class="hand second" x1="100" y1="114" x2="100" y2="28" :transform="`rotate(${secondAngle} 100 100)`" />
      <circle class="pin" cx="100" cy="100" r="6" />
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  remainMs: { type: Number, default: 0 },
  struck: Boolean,
  charging: Boolean,
  ultimate: Boolean,
  attacking: Boolean,
  phase: { type: Number, default: 1 },
})

// 秒針每秒走一圈、分針一小時一圈，跟真的時鐘一樣讀；整秒才跳一格，不補間。
const secondAngle = computed(() => (Math.floor(props.remainMs / 1000) % 60) * 6)
const minuteAngle = computed(() => ((props.remainMs / 60_000) % 60) * 6)
</script>

<style scoped>
.clock-svg { display: block; width: 100%; height: 100%; }
.rim { fill: var(--c-text); opacity: .85; }
.face { fill: var(--c-surface); }
.tick { stroke: var(--c-text-dim); stroke-width: 3; stroke-linecap: round; }
.tick.major { stroke: var(--c-text); stroke-width: 5; }
.hand { stroke-linecap: round; }
.minute { stroke: var(--c-text); stroke-width: 7; }
.second { stroke: var(--c-boss); stroke-width: 3; }
.pin { fill: var(--c-boss); }
</style>
