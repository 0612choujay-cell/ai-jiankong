<template>
  <div v-if="!readyAtMount" class="warmup" role="status">
    <p class="msg">{{ line }}</p>

    <!-- Task 22d：目前在下載的項目名稱獨立成第二句，不併進 line（見下方
         line 上方的說明——併起來會破 15 字上限，而且是每一台新裝置暖機時
         必然出現的第一句）。只在下載中顯示，完成／失敗後不留著舊值。 -->
    <p v-if="itemLabel" class="msg-detail">{{ itemLabel }}</p>

    <!-- 進度條：文字的 done/total 已經是完整資訊，這條只是讓「還要等多久」
         看得出來。用 aria-valuenow 而不是只靠寬度，讀螢幕的人也拿得到。
         aria-label 的用字規則見 <script> 裡 line 上方的說明（複審第 1 輪
         IMP-2）——它也是文案。 -->
    <div
      v-if="running" class="bar" role="progressbar"
      aria-label="遊戲資料下載進度"
      aria-valuemin="0" :aria-valuemax="total" :aria-valuenow="done"
    >
      <div class="fill" :style="{ width: pct + '%' }" />
    </div>

    <button v-if="!running && !ready" class="act" @click="run">
      {{ errorName ? '再試一次' : '開始下載' }}
    </button>

    <!-- 隱私紅線：只留 error.name，永不 message/stack（message 會帶著失敗的
         資產 URL，跟 session.js 的 loopError／storageError 是同一條線）。

         Task 22d 複查「其他組合字串」時發現、第 2 輪裁決要修：這裡原本是
         `技術細節：{{ errorName }}` 併成一句，`技術細節：NetworkError` 已經
         是 17 字，破 15 字上限，而且 NetworkError 正是這個暖機流程最可能
         出現的那一種失敗。跟 line／itemLabel 是同一種「字首字面值＋變數併成
         一句」的病，修法也一樣：把 errorName 從那句組合裡拆出來獨立成行，固定
         前綴「技術細節」自己一行（4 字，靜態、穩定 ≤15 字），errorName
         自己一行——兩句不再併在一起，errorName 本身多長都不會跟前綴湊出
         超字的句子。

         誠實記錄（見 OfflineWarmup.test.js 對應護欄的說明）：error.name
         的定義域是瀏覽器／JS 平台給的技術識別字，不像 ASSET_LABELS 是本
         專案審過的封閉集合，沒辦法窮舉所有值去斷言「這一行本身 ≤15 字」。
         這裡能保證、也已經用測試鎖住的，只有「不併句」這個性質——
         errorName 不會再跟任何固定文案湊成同一句去疊加長度。 -->
    <p v-if="errorName" class="detail"><small>技術細節</small></p>
    <p v-if="errorName" class="detail-name"><small>{{ errorName }}</small></p>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ensureOfflineAssets, isOfflineReady } from '../core/offlineAssets.js'

/**
 * 展場離線暖機的 UI（Task 20 補做的驗收項目：offlineAssets.js 至今沒有任何
 * 畫面接它）。
 *
 * 為什麼掛在任務設定畫面（screen === 'task'）：暖機這件事的本質是**第一次要
 * 連網**，把 wasm 推論引擎與三個模型（約 35.5MB）真的灌進 Cache Storage，
 * 之後展場斷網也能玩。它是工作人員在「兩位訪客之間」做的事，不是小孩流程的
 * 一部分——任務設定畫面正是那個空檔，而且這裡沒有任何時間壓力（戰鬥畫面
 * 不能有東西擋路、校準畫面要對著鏡頭、結算畫面是小孩的成果）。
 *
 * 已經暖機過就整個不渲染（isOfflineReady() 讀的是 localStorage 的版本旗標），
 * 所以正常情況下這個元件在畫面上完全不存在，不佔版面、不打擾小孩。
 */
// 掛載當下就已經暖機過的裝置：整個元件不渲染（v-if 讀的是這個，不是下面
// 會變動的 ready）。刻意分成兩個變數——用 ready 當 v-if 的話，這一輪剛暖機
// 成功的瞬間整條橫幅會直接消失，工作人員看不到「成功了沒」，只會看到東西
// 不見了；那正是需要明確回饋的時刻。
const readyAtMount = isOfflineReady()
const ready = ref(readyAtMount)
const running = ref(false)
const done = ref(0)
const total = ref(0)
const label = ref('')
const errorName = ref(null)

const pct = computed(() => (total.value ? Math.round((done.value / total.value) * 100) : 0))

// 文案：每一句都 ≤15 字（這幾句會互相取代，屬於短暫提示，受上限約束）。
// 不指責、不用驚嘆號——失敗多半是展場的 Wi-Fi，不是誰做錯了什麼。
// 刻意不出現「離線」兩個字（spec 紅線：畫面上不顯示「線上／離線」狀態，
// 顯示離線只會製造焦慮）。這裡要講的是「第一次要連網把遊戲資料抓下來」這件
// 具體的事，不是在報告網路狀態——講完就消失，也不會出現在戰鬥畫面上。
//
// 複審第 1 輪 IMP-2：這條規則**包含 aria-label**。aria-label 一樣是文案，
// 螢幕閱讀器會把它唸出來，所以進度條的標籤原本那個用字（含「離」「線」二字）
// 也得改掉——這是本工項唯一一處漏網。OfflineWarmup.test.js 有一條結構性測試
// 掃整個 <template>（含屬性值）鎖住它，不是只鎖看得見的那幾句。
//
// Task 22d 修正：這裡原本把 label 併進同一句（`下載中 ${done}/${total} ${label}`），
// 而 offlineAssets.js 的 ASSET_LABELS.wasm 是「MediaPipe 推論引擎」，光這個
// label 自己就是 14 字，併起來一律破 15 字上限——而且 wasm 是 ITEMS 的第一項，
// 這句話是**每一台新裝置暖機時必然出現的第一個畫面文字**。跟 postureCoach.js
// 的 CAUSE_LABEL + POSTURE_COPY 是同一種「片段各自合格、組起來才破線」的盲點，
// copyGuardrail.js 的長度規則只掃靜態字面值，看不到執行期變數代進去之後的
// 長度。ASSET_LABELS 不是這個檔案的（在 offlineAssets.js，不屬於本工項檔案
// 界線），所以解法在這一側：把「目前項目」拆成獨立一句（見下面的
// itemLabel／template 的 .msg-detail），line 這裡只留「下載中 幾/幾」，
// 不論 done/total 是多少都遠低於 15 字。OfflineWarmup.test.js 有一條護欄
// 對 offlineAssets.js 真實的每一個 label（不是抄一份常數）× 所有 done/total
// 組合窮舉，直接掛載元件讀 DOM 斷言——不是重新在測試裡刻一份公式。
const line = computed(() => {
  if (running.value) return `下載中 ${done.value}/${total.value}`
  if (ready.value) return '遊戲資料下載完成'
  if (errorName.value) return '下載失敗，請檢查網路'
  return '第一次要連網下載遊戲資料'
})

// 目前在下載哪一項——獨立於 line 之外的第二句（拆行，不是縮寫 label）。
// 只在下載中顯示：ready／error 之後 label 這個 ref 本身不會被清空（沒有
// 必要），但畫面不該繼續留著上一輪下載到一半的項目名稱。
const itemLabel = computed(() => (running.value ? label.value : ''))

/**
 * 可重複呼叫，天然就是「重試」：已經進快取的項目會在 sw.js 的 cacheFirst
 * 命中，幾乎立刻完成，只有真的還沒下載或上次失敗的項目才會再打一次網路
 * （見 ensureOfflineAssets 的說明）。所以這裡不自己做重試迴圈。
 */
async function run() {
  if (running.value) return
  running.value = true
  errorName.value = null
  done.value = 0
  // 複審第 1 輪 Nit-2：`running` 的歸位放 finally。ensureOfflineAssets() 今天
  // 自己會把例外收成 { ok:false, error }，但那是它的實作細節——只要哪天它漏
  // 丟一個例外出來，沒有 finally 的版本會永遠停在「下載中」：進度條凍在那裡、
  // 重試按鈕（v-if="!running"）不出現，工作人員在展場上完全沒有出路。
  try {
    const r = await ensureOfflineAssets({
      onProgress: (p) => {
        done.value = p.done
        total.value = p.total
        label.value = p.label ?? ''
      },
    })
    if (r.ok) { ready.value = true; return }
    errorName.value = r.error?.name ?? 'Error'
  } catch (error) {
    // 隱私紅線：只留 error.name（跟 session.js 的 loopError／storageError 一致）。
    errorName.value = error?.name ?? 'Error'
  } finally {
    running.value = false
  }
}
</script>

<style scoped>
/*
 * 錨在**上緣**，跟 InstallGuide（錨在下緣）刻意分開兩端：兩者都可能同時出現
 * 在任務設定畫面上，疊在一起就會互相遮蔽——跟更正 5 要避免的是同一類問題。
 * 任務設定畫面（.stack）的內容是垂直置中的，上緣這一條只會落在留白上。
 */
.warmup {
  position: fixed;
  top: max(var(--gap), env(safe-area-inset-top));
  left: max(var(--gap), env(safe-area-inset-left));
  right: max(var(--gap), env(safe-area-inset-right));
  z-index: 8;
  display: flex; align-items: center; flex-wrap: wrap; gap: 12px;
  background: var(--c-surface); border-radius: var(--radius); padding: 10px 16px;
}
.msg { margin: 0; font-size: 15px; }
.msg-detail { margin: 0; font-size: 13px; color: var(--c-text-dim); }
.detail { margin: 0; color: var(--c-text-dim); }
.detail-name { margin: 0; color: var(--c-text-dim); }
.bar { flex: 1; min-width: 120px; height: 8px; border-radius: 4px; background: var(--c-bg); overflow: hidden; }
.fill { height: 100%; background: var(--c-hero); }
.act { min-height: var(--tap-min); padding: 0 18px; }
</style>
