<template>
  <div class="stats">
    <header class="hero">
      <p class="result" :class="record?.result">
        {{ record?.result === 'victory' ? '討伐成功！' : `打掉了 ${knockedPct}%` }}
      </p>
      <p class="headline">{{ summary.headline }}</p>
      <p class="goal">{{ summary.nextGoal }}</p>
      <!-- 更正 7（收掉舊發現）：endBattle() 早就會在 saveSession() 失敗時設定
           state.storageError，但直到 Task 18 之前沒有任何畫面顯示它——結算頁
           是它唯一有意義的位置（「這一輪有沒有被記下來」正是這個畫面在回答
           的問題）。這一句是短提示（不是像 headline 那種靜態長文），一樣受
           15 字上限跟禁用詞規則約束：≤15 字、不指責小孩、不朗讀。

           複審第 1 輪 F1：這裡曾經共用同一個 storageError 講兩件事（本場有沒有
           存起來／讀不讀得到以前的紀錄），會在其中一種情境下講錯話（例如本場
           明明存成功了，卻顯示「這次的紀錄沒有存起來」）。現在拆成兩個獨立的
           prop、兩句互斥的話：storageError 只對應 saveSession() 失敗，
           historyError 只對應 listSessions() 失敗。兩者理論上可能同時發生
           （存跟讀都失敗），這時兩句都會顯示，不是設計上的互斥，是各自誠實
           反映各自的事實。 -->
      <p v-if="storageError" class="hint warn">這次的紀錄沒有存起來</p>
      <p v-if="historyError" class="hint warn">讀不到以前的紀錄</p>
    </header>

    <section class="charts">
      <figure><figcaption>時間都花在哪</figcaption><canvas ref="pieEl" /></figure>
      <figure><figcaption>每 5 秒打出的傷害</figcaption><canvas ref="lineEl" /></figure>
      <figure><figcaption>五項表現</figcaption><canvas ref="radarEl" /></figure>
    </section>

    <table class="axes">
      <caption>五項表現的數字</caption>
      <tbody>
        <tr v-for="a in axes" :key="a.key"><th scope="row">{{ a.label }}</th><td>{{ a.value }}%</td></tr>
        <!-- 更正 5(b)：圓餅圖的色塊讀不出「12 分鐘」，而分鐘數才是 Ruling AL
             用來取代週期性懲罰迴圈的東西——手機一直擺在桌上只觸發一次陷阱，
             真正誠實呈現代價的是這裡的分鐘數，不是圓餅上那一小塊顏色。
             phone === 0 時完全不顯示這一列，不硬湊一個問題出來講。 -->
        <tr v-if="phoneMs > 0">
          <th scope="row">手機出現的時間</th>
          <td>{{ phoneMinutes }} 分鐘</td>
        </tr>
      </tbody>
    </table>

    <footer class="actions">
      <!-- Task 20：本輪坐了 ≥20 分鐘時，同一顆按鈕改講「休息一下再來」——
           仍然只有兩顆按鈕、仍然只 emit again（Task 18 更正 2 的決定：底部
           不加第三顆按鈕），改變的只有文字與 App.vue 那邊接到之後做什麼。
           文字與行為讀同一個 needsBreakAfter()，不可能一邊寫著休息、一邊
           直接開打。 -->
      <button class="primary again" @click="$emit('again')">{{ againLabel }}</button>
      <button class="primary home" @click="$emit('home')">回主畫面</button>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  Chart, PieController, ArcElement, LineController, LineElement, PointElement,
  RadarController, RadialLinearScale, LinearScale, CategoryScale, Tooltip,
} from 'chart.js'
import { radarAxes } from '../core/radar.js'
import { buildSummary } from '../core/summary.js'
import { needsBreakAfter } from '../core/battleConfig.js'

Chart.register(PieController, ArcElement, LineController, LineElement, PointElement,
               RadarController, RadialLinearScale, LinearScale, CategoryScale, Tooltip)

const props = defineProps({
  record: { type: Object, default: null },
  history: { type: Array, default: () => [] },
  dpsSeries: { type: Array, default: () => [] },
  // 更正 7：session.js 的 endBattle() 早就有 state.storageError，這裡只是第一次
  // 有畫面顯示它。純展示，這個元件不負責清除它——那是 startBattle() 的職責
  // （跨場次歸零，見 session.js 的既有註解）。
  storageError: { type: String, default: null },
  // 複審第 1 輪 F1：跟 storageError 分開的獨立 prop，對應 session.js 的
  // state.historyError（listSessions() 失敗），講的是不同的事實。
  historyError: { type: String, default: null },
})
defineEmits(['again', 'home'])

const pieEl = ref(null)
const lineEl = ref(null)
const radarEl = ref(null)
const charts = []

const axes = computed(() => (props.record ? radarAxes(props.record) : []))
const summary = computed(() => (props.record ? buildSummary(props.record, props.history)
                                             : { headline: '', nextGoal: '' }))
// Task 20：長時段（≥20 分鐘）打完，下一輪開打前先休息——按鈕文字先講出來，
// 小孩才不會按下去之後才發現「怎麼跑出一個休息畫面」。判斷本身在
// battleConfig.js（App.vue 的 onAgain() 讀同一個函式決定真正做什麼）。
const againLabel = computed(() => (needsBreakAfter(props.record) ? '休息一下再來' : '再討伐一次'))
const knockedPct = computed(() => {
  const r = props.record
  if (!r?.bossHpMax) return 0
  return Math.round(((r.bossHpMax - r.bossHpRemaining) / r.bossHpMax) * 100)
})

// 更正 5：手機時間要有數字，不能只有圓餅色塊。phoneMs 用原始毫秒判斷
// 「有沒有出現過」（>0 就該講），phoneMinutes 是實際顯示的分鐘數——兩者分開
// 是因為極短暫的一次手機（例如 5 秒）四捨五入會變成 0 分鐘，但那仍然是
// 「有出現過」，不該因為顯示成 0 分鐘而看起來像沒發生，所以顯示至少 1 分鐘。
const phoneMs = computed(() => props.record?.distractionDurationMs?.phone ?? 0)
const phoneMinutes = computed(() => (phoneMs.value > 0 ? Math.max(1, Math.round(phoneMs.value / 60_000)) : 0))

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

onMounted(() => {
  const p = props.record?.postureDurationMs ?? {}
  const d = props.record?.distractionDurationMs ?? {}

  charts.push(new Chart(pieEl.value, {
    type: 'pie',
    data: {
      // 更正 5(a)：原本「分心」是 phone+away 合併成一塊，這裡拆成「看手機」
      // 跟「離開座位」兩塊——手機陷阱只觸發一次（Ruling AL），色塊本身讀不出
      // 「發生過幾次」，但至少能讓兩種完全不同的行為（滑手機 vs. 離開座位）
      // 在圖上分得開，數字則交給下面的表格（見 phoneMinutes）。
      labels: ['坐得端正', '駝背', '低頭', '想睡', '視線飄走', '看手機', '離開座位'],
      datasets: [{
        data: [p.upright ?? 0, p.slouch ?? 0, p.forwardHead ?? 0, p.drowsy ?? 0,
               p.gazeAway ?? 0, d.phone ?? 0, d.away ?? 0].map((ms) => Math.round(ms / 1000)),
        backgroundColor: [css('--c-hero'), css('--c-warn'), css('--c-accent'), css('--c-text-dim'),
                          css('--c-boss'), css('--c-danger'), css('--c-ok')],
      }],
    },
    // parsing:false 不套在圓餅/雷達：這兩種圖需要 Chart.js 自己解析 labels，
    // 關掉會直接畫不出來。它們各只有 5-7 個點，不套也沒有效能差別。
    options: { animation: false, responsive: true, maintainAspectRatio: false },
  }))

  charts.push(new Chart(lineEl.value, {
    type: 'line',
    data: {
      datasets: [{
        data: props.dpsSeries.map((v, i) => ({ x: i * 5, y: v })),
        borderColor: css('--c-accent'),
        pointRadius: 0,   // 180 個點，畫圓點只是噪音
        borderWidth: 2,
      }],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      parsing: false,   // 資料已經是 {x,y}，省下 180 點的解析
      scales: { x: { type: 'linear', title: { display: true, text: '秒' } }, y: { beginAtZero: true } },
      plugins: { tooltip: { enabled: false } },
    },
  }))

  charts.push(new Chart(radarEl.value, {
    type: 'radar',
    data: {
      labels: axes.value.map((a) => a.label),
      datasets: [{ data: axes.value.map((a) => a.value),
                   borderColor: css('--c-hero'), backgroundColor: 'rgba(74,222,128,.25)' }],
    },
    options: { animation: false, responsive: true, maintainAspectRatio: false,
               scales: { r: { min: 0, max: 100 } } },
  }))
})

// 不 destroy 的話，回到這個畫面會疊上新的 Chart 實例，記憶體與重繪都會一輪一輪累積
onBeforeUnmount(() => { for (const c of charts) c.destroy() })
</script>

<style scoped>
.stats {
  min-height: 100dvh;
  /* 複審第 1 輪 F4：四邊都跟 .stack（layout.css）同一個慣例——
     max(var(--gap), env(safe-area-inset-X))，橫式握持時左右不會被瀏海／
     圓角吃掉內容。 */
  padding: max(var(--gap), env(safe-area-inset-top))
           max(var(--gap), env(safe-area-inset-right))
           calc(var(--tap-primary) + var(--gap) * 2 + max(var(--gap), env(safe-area-inset-bottom)))
           max(var(--gap), env(safe-area-inset-left));
  /* 版面紅線自查算式（複審第 1 輪 F3：舊算式沒把 env(safe-area-inset-bottom)
     算進去，在有 home indicator 的 iPad 上算出來的餘裕跟實際不符）。

     底部 .actions 是 position:fixed，實際佔用的視覺高度＝
       按鈕高度（.primary 的 min-height，即 --tap-primary）
       ＋上 padding（var(--gap)）
       ＋下 padding（max(var(--gap), env(safe-area-inset-bottom))，見下面 .actions）
     ＝ --tap-primary + --gap + max(--gap, inset-bottom)

     這裡的 padding-bottom 用同一個 max(--gap, inset-bottom) 項，再多加一個
     --gap 當緩衝：
       --tap-primary + --gap*2 + max(--gap, inset-bottom)
     兩式相減，緩衝永遠剛好是 1 個 --gap（16px），不管 inset-bottom 實際是
     0（無 home indicator）還是遠大於 --gap（iPad Pro 的 home indicator 安全
     區）——舊算式用固定的 --gap*3 沒有把 inset-bottom 帶進去，inset-bottom
     一旦大於 --gap，餘裕就會被吃掉（複審實測某台 iPad 上只剩 12px），這裡
     改成算式本身會跟著真實的 inset-bottom 變動，餘裕恆定為 16px。 */
  overflow-y: auto;
}
.hero { text-align: center; margin-bottom: var(--gap); }
.result { font-size: 34px; font-weight: 800; margin: 0 0 8px; }
.result.victory { color: var(--c-hero); }
.headline { font-size: 22px; line-height: 1.6; margin: 0 auto; max-width: 44em; }
.goal { font-size: var(--fs-body); color: var(--c-text-dim); }
.hint { font-size: var(--fs-body); color: var(--c-text-dim); }
.hint.warn { color: var(--c-warn); }

/* 直式單欄、橫式三欄——兩個方向都完整可用 */
.charts { display: grid; gap: var(--gap); grid-template-columns: 1fr; }
@media (orientation: landscape) { .charts { grid-template-columns: repeat(3, 1fr); } }
figure { margin: 0; background: var(--c-surface); border-radius: var(--radius); padding: 12px; }
figcaption { font-size: var(--fs-body); margin-bottom: 8px; }
figure canvas { height: 240px !important; }

/* 圖表不是唯一的傳達管道：同樣的數字用表格再給一次 */
.axes { width: 100%; margin-top: var(--gap); border-collapse: collapse; font-size: var(--fs-body); }
.axes caption { text-align: left; color: var(--c-text-dim); padding-bottom: 8px; }
.axes th, .axes td { text-align: left; padding: 8px; border-bottom: 1px solid var(--c-surface); }
.axes td { text-align: right; font-variant-numeric: tabular-nums; }

/* 底部固定兩顆 ≥60pt 按鈕 */
.actions { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: var(--gap);
           /* 複審第 1 輪 F4：左右也跟著 safe-area 慣例，不是只有 bottom。 */
           padding: var(--gap) max(var(--gap), env(safe-area-inset-right))
                    max(var(--gap), env(safe-area-inset-bottom))
                    max(var(--gap), env(safe-area-inset-left));
           background: linear-gradient(transparent, var(--c-bg) 30%); }
.actions button { flex: 1; }
.home { background: transparent; outline: 2px solid var(--c-text-dim); }
</style>
