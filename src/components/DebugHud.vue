<template>
  <div class="hud" role="note">
    <p>延遲 EMA {{ round(stats.latencyEma) }}ms / p95 {{ round(stats.latencyP95) }}ms</p>
    <p>fps 姿態 {{ fixed2(stats.fpsPose) }} / 表情 {{ fixed2(stats.fpsFace) }} / 手機 {{ fixed2(stats.fpsObject) }}</p>
    <p>rAF 間隔 p95 {{ round(stats.rafP95) }}ms / max {{ round(stats.rafMax) }}ms</p>
    <p>本輪 {{ round(stats.sessionSec) }}s / 累計輪數 {{ stats.rounds }}</p>
    <p>效能模式 {{ yesNo(stats.perfMode) }} / 手機偵測 {{ onOff(stats.objectOn) }}{{ objectNote }}</p>
    <p>螢幕喚醒鎖 {{ onOff(stats.wakeLockActive) }}</p>
    <p>連續失敗 姿態 {{ stats.poseFailures }}（{{ nameOr(stats.poseErrorName) }}） 表情 {{ stats.faceFailures }}（{{ nameOr(stats.faceErrorName) }}） 手機 {{ stats.objectFailures }}（{{ nameOr(stats.objectErrorName) }}）</p>
    <p>姿態分類 {{ stats.posture }} / 嗜睡 {{ yesNo(stats.drowsy) }}</p>
  </div>
</template>

<script setup>
/**
 * 展場用的效能／診斷面板，給工作人員或開發者看，不給小孩看（開啟方式見
 * BattleView.vue 的隱藏手勢，那裡有完整說明）。
 *
 * 隱私紅線（跟 inferenceService.js 的 health() 是同一條規則）：這裡刻意用
 * template 具名 interpolation，不做 `v-bind="stats"` 或任何形式的整包展開
 * ——呼叫端不管在 stats 裡多塞什麼欄位（例如除錯用的 error.message、
 * stack、或哪天有人手滑把 landmarks 塞進來），這個元件都沒有任何管道把
 * 它秀出來。要加新欄位，就得先在這個 template 裡明確加一行，那一刻自然
 * 會想起這條紅線。
 *
 * 只顯示彙總／狀態類：fps、延遲、rAF 間隔、連續失敗次數、error.name、
 * 姿態分類結果（字串）。不顯示：landmark 座標、blendshape 數值、影像／
 * 快照、原始角度時序、裝置識別碼、error.message/stack——一個都不顯示。
 *
 * 沒有 GPU/記憶體用量：Safari 沒有 performance.memory，也沒有任何量測
 * GPU 記憶體的 Web API，硬加一個「大多數時候顯示不支援」的欄位對目標機
 * （iPad Pro M1 / Safari）沒有實際價值，這裡刻意不做。
 */
import { computed } from 'vue'

const props = defineProps({ stats: { type: Object, required: true } })

/**
 * 「手機偵測開著、但 object track 一筆取樣都沒有」的判讀註記。
 *
 * 為什麼要把兩個既有欄位併成一句話：使用者回報「拿手機對著鏡頭，從頭到尾
 * 什麼都沒發生」時，工作人員要回答的第一個問題是「object track 到底有沒有
 * 在跑」。答案本來就在畫面上（上面那行的 `fps … 手機 0.00` 與這一行的
 * 「手機偵測 開」），但它分散在兩行、而且 `0.00` 夾在另外兩個 fps 數字中間，
 * 現場讀的人得自己把兩件事兜起來才知道「開著卻沒在跑」。這裡不新增任何資料
 * 來源，只是把已經顯示的兩個純量合成一個當場讀得懂的結論。
 *
 * 為什麼判準是 `!(fpsObject > 0)` 而不是 `fpsObject === 0`：NaN／undefined
 * （呼叫端哪天漏傳）也要落進「尚無取樣」，而不是靜靜地顯示成沒有註記的
 * 正常狀態——這個註記存在的意義就是不讓「看起來正常」變成預設答案。
 *
 * 讀這個註記要知道的邊界（inferenceScheduler.js 的 actualFps）：它要**兩筆**
 * 完成記錄才算得出 fps，而 object 是 0.33fps，所以每一場戰鬥開頭大約前 6 秒
 * 一定會顯示「尚無取樣」，那是正常的暖機，不是故障。反過來也有一個盲點：
 * actualFps 是拿最近幾次完成的時間間隔算的，不隨時間衰減——某個 track 跑過
 * 兩次之後就完全停擺，這個數字會一直凍結在舊值、看起來永遠健康。那個盲點
 * 這一層修不掉（要改 scheduler），此處只負責「從來沒跑過」這一半。
 *
 * 隱私：只讀 objectOn／fpsObject 兩個既有的彙總純量，沒有新增任何資料來源。
 */
const objectNote = computed(
  () => (props.stats.objectOn && !(props.stats.fpsObject > 0) ? '（尚無取樣）' : ''),
)

const round = (n) => Math.round(n ?? 0)
const fixed2 = (n) => (n ?? 0).toFixed(2)
const yesNo = (b) => (b ? '是' : '否')
const onOff = (b) => (b ? '開' : '關')
const nameOr = (name) => name ?? '正常'
</script>

<style scoped>
/* 常駐在鏡頭畫面之上的面板：只用純色背景＋文字，不用 filter/box-shadow
   （成本高，見 Task 16 對「量測與顯示本身不能變成效能問題」的要求）。
   position:fixed 不吃 BattleView 的 .arena 版面流，直橫兩向都固定在同一個
   螢幕角落，不需要另外處理 orientation。
   bottom 的基底是 tap-primary + gap*2（跟 BattleView.vue 的 .hero-hud
   同一個公式）——BattleView 的「結束」按鈕（.corner-br）也錨在螢幕右下角，
   單純 bottom:8px 會讓這個面板疊在它正上方。雖然 pointer-events:none 讓
   點擊可以穿透過去，但視覺上會被蓋住，這個面板存在的唯一目的就是讓工作
   人員讀到最底下那一行數字，被蓋住就等於沒有這個面板，跟 Ruling CL
   （健康度提示不能蓋住暫停/結束按鈕）是同一類問題，這裡直接抬高避開，
   不留給點擊穿透去補償視覺上的問題。

   F3（Task 22b-3 收尾）：這個基底本身沒有納入 env(safe-area-inset-bottom)，
   橫向時 iPad 的 home indicator 會壓到面板最底下那一行——選 calc()「相加」
   而不是 max()「取大」，理由是兩者在真實 safe-area 值下的結果不一樣：

   .corner-br（結束鈕）的 bottom 是 max(var(--gap), env(safe-area-inset-bottom))
   （見 layout.css），也就是說 safe-area 一旦大於 --gap(16px)，結束鈕的底部
   位移量會直接變成 safe-area 本身，鈕的頂部邊緣（離螢幕底部的距離）就是
   safe-area + 60（tap-primary）。

   如果這裡也用 max(92px, env(safe-area-inset-bottom))：safe-area 只要超過
   32px，面板底部就會被結束鈕的頂部蓋過去（92 < safe-area+60 ⇔ safe-area>32）
   ——iPad 常見的 home indicator inset 落在 20~24px 這個區間，看起來離 32px
   不遠，不能假設「反正 iPad 的 safe-area 不會那麼大」就跳過这個算式。

   改用 calc(92px + env(safe-area-inset-bottom))：面板底部與結束鈕頂部的
   間隙 = (92 + safeArea) − (max(16, safeArea) + 60)。當 safeArea ≤ 16 時
   間隙 = 92+safeArea−76 = 16+safeArea ≥ 16px；當 safeArea > 16 時間隙化簡成
   (92+safeArea)−(safeArea+60) = 32px，恆定不隨 safeArea 變化。兩段都
   ≥ Task 16 審查手算要求的 12px 底線，calc() 對任何非負的 safeArea 值都
   保證不相交，max() 做不到這件事，這裡因此選 calc()。 */
.hud {
  position: fixed; right: 8px; z-index: 20;
  bottom: calc(var(--tap-primary) + var(--gap) * 2 + env(safe-area-inset-bottom));
  background: rgba(0, 0, 0, .82); color: #9df;
  font: 12px/1.5 ui-monospace, monospace;
  padding: 8px 10px; border-radius: 8px; pointer-events: none;
  max-width: min(92vw, 420px);
}
.hud p { margin: 0; }
</style>
