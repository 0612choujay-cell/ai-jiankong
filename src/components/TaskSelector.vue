<template>
  <div class="stack">
    <h2>這次要做什麼？</h2>

    <div class="tasks" role="radiogroup" aria-label="任務類型">
      <button
        v-for="t in TASKS" :key="t.value"
        class="task" :class="{ on: taskType === t.value }"
        role="radio" :aria-checked="taskType === t.value"
        @click="taskType = t.value"
      >
        <span class="emoji" aria-hidden="true">{{ t.emoji }}</span>
        <span>{{ t.label }}</span>
      </button>
    </div>

    <h2>要專心多久？</h2>

    <div class="stepper">
      <button aria-label="減少 1 分鐘" @click="bump(-1)">−</button>
      <span class="minutes"><strong>{{ durationMin }}</strong> 分鐘</span>
      <button aria-label="增加 1 分鐘" @click="bump(1)">＋</button>
    </div>

    <div class="presets">
      <button
        v-for="p in DURATION_PRESETS" :key="p"
        class="preset" :class="{ on: durationMin === p }"
        @click="durationMin = p"
      >
        {{ p }} 分
      </button>
    </div>

    <p class="boss-hp">魔王血量 {{ bossHp }}</p>

    <!--
      按鈕文字從「開始討伐」改成「準備開始」（【分任務校準】的必然後果）。

      流程反轉之後，按下這顆按鈕的下一個畫面是**校準**，不是戰鬥——再寫
      「開始討伐」就是對使用者說謊，而且是這個專案一路在守的那條紅線：
      文案承諾的事情必須真的會發生。小孩按了「開始討伐」卻看到「先坐好，
      我來記住你的姿勢」，第一個反應是「我按錯了嗎」。

      「準備開始」同時涵蓋了「校準 → 戰鬥」這條兩段式的路，不必在這顆按鈕上
      解釋校準是什麼——下一個畫面自己會講。
    -->
    <button class="primary go" @click="emitStart(false)">準備開始</button>
    <button class="demo" @click="emitStart(true)">展示模式（20 秒）</button>

    <!-- Task 19 複審第 1 輪 I3：brief 明確要求主畫面常駐一行隱私說明，原始
         實作漏做了。這句話跟 PrivacyNotice.vue／PermissionGate.vue 檔頭聲明
         的例外同一類：靜態、可從容閱讀、不會被朗讀也不會被下一則提示取代，
         不受「單句 ≤15 字」的長度上限（那條上限的理由是語音播報／短暫提示
         會互相蓋掉，這裡都不適用）。

         文字不照 brief 原文（「只分析畫面中最靠近鏡頭的一個人」）：那句話
         跟複審第 1 輪 B2 打回 PrivacyNotice.vue 的理由一樣不實——MediaPipe
         numPoses:1 取的是信心分數最高者，不保證是離鏡頭最近的人（見
         inferenceService.js 第 70 行起的註解）。這裡改成跟 PrivacyNotice.vue
         一致、程式真正能保證的講法。 -->
    <!-- 合併 Task 22a 的全域文案護欄時拆行（controller）：原本是一句 29 字，
         破 15 字上限。這裡刻意**不**申請整檔豁免——TaskSelector 還有任務名稱、
         時長、魔王血量那些真正該短的互動標籤，整檔豁免會把它們一起蓋掉，
         那正是「寬粒度豁免順手放行真違規」的情形。拆成三句各自獨立讀得懂的
         短句，跟健康度提示、開機錯誤的處理方式一致。
         同時修掉一個 park 下來的問題：原文「完全離線運作」講得比程式能保證的
         強——首次資產暖機要連網（PrivacyNotice.vue 已經誠實寫了這件事，
         這裡卻沒有）。改成先講「第一次要連網」，與那一頁一致。 -->
    <p class="privacy-line">
      <span>第一次要連網，之後可離線玩</span>
      <span>一次只分析一個人</span>
      <span>影像不會離開這台 iPad</span>
    </p>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import {
  DURATION_PRESETS, DURATION_MIN_MIN, DURATION_MAX_MIN, DEFAULT_DURATION_MIN, bossHpFor,
} from '../core/battleConfig.js'

const emit = defineEmits(['start'])

const TASKS = [
  { value: 'homework', label: '寫作業', emoji: '✏️' },
  { value: 'reading', label: '看書', emoji: '📖' },
  { value: 'vocab', label: '背單字', emoji: '🔤' },
  { value: 'custom', label: '自己選', emoji: '⭐' },
]

// 預設值已選好，直接按開始就能玩——這個年齡層不該被強迫先做選擇才能進遊戲。
const taskType = ref('homework')
const durationMin = ref(DEFAULT_DURATION_MIN)

// 魔王血量永遠用一般模式（非展示）算給使用者看：展示模式血量是固定的
// DEMO.bossHp、跟這裡調的時長無關，顯示一般模式的數字才有參考意義。
const bossHp = computed(() => bossHpFor(durationMin.value * 60_000, false))

function bump(delta) {
  durationMin.value = Math.min(DURATION_MAX_MIN, Math.max(DURATION_MIN_MIN, durationMin.value + delta))
}

function emitStart(demoMode) {
  emit('start', { taskType: taskType.value, durationMin: durationMin.value, demoMode })
}
</script>

<style scoped>
h2 { font-size: var(--fs-title); margin: 0; }
.tasks, .presets { display: flex; gap: var(--gap); flex-wrap: wrap; justify-content: center; }
.task {
  min-width: 120px; min-height: var(--tap-primary);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 12px; font-size: var(--fs-body);
}
.task.on, .preset.on { outline: 3px solid var(--c-accent); background: var(--c-bg); }
.emoji { font-size: 28px; }
.stepper { display: flex; align-items: center; gap: var(--gap); }
.stepper button { width: var(--tap-primary); height: var(--tap-primary); font-size: 28px; }
.minutes { font-size: var(--fs-title); min-width: 140px; }
.minutes strong { font-size: 40px; }
.preset { min-width: 88px; min-height: var(--tap-min); }
.boss-hp { color: var(--c-text-dim); font-size: var(--fs-body); margin: 0; }
.go { min-width: 260px; }
.demo { min-height: var(--tap-min); color: var(--c-text-dim); background: transparent; }
.privacy-line { font-size: 15px; color: var(--c-text-dim); max-width: 36em; margin: 0;
                display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 10px; }
</style>
