<!--
  Task 19：授權前先說明用途。這是整個 App 開場的第一個畫面（session.js 的
  `state.screen` 預設就是 'privacy'），在任何 getUserMedia 對話框跳出來之前，
  先讓使用者知道「這個 App 要鏡頭做什麼、資料存在哪裡、怎麼刪掉」。

  文案長度例外聲明（給 Task 22a 的全域文案護欄用）：這個檔案裡的說明文字
  （一行字摘要、家長／老師版的展開說明、清除紀錄的提示與錯誤訊息）**不受
  「單句 ≤15 字」的長度上限**。那條上限的理由是語音播報／下一則提示會蓋掉
  這一則（見 App.vue、session.js 戰鬥中提示的註解），約束的是會被朗讀、或
  會被下一則短暫訊息取代的文字。這裡的文字是靜態、可從容閱讀、完全不會被
  TTS 唸出、也不會被別的提示取代——不適用同一條規則。禁用詞規則（「懶惰」
  「摸魚」「沒用」「果然做不到」「笨」「胖」「醜」、任何身體外觀描述）仍然
  全部適用，這裡沒有例外。
-->
<template>
  <div class="stack">
    <h1>專注討伐戰：分心大魔王</h1>

    <p class="one-liner">
      這個遊戲會用 iPad 的前鏡頭看你的坐姿，<strong>影像不會離開這台 iPad</strong>。
    </p>

    <button class="more" :aria-expanded="open" @click="open = !open">
      {{ open ? '收起說明' : '給家長／老師看的完整說明' }}
    </button>

    <div v-if="open" ref="detailEl" class="detail" @scroll="updateScrollHint">
      <h2>這個 App 會做什麼</h2>
      <ul>
        <li>用前鏡頭即時分析坐姿與眼睛狀態，判斷有沒有駝背、低頭、想睡。</li>
        <li>所有分析都在這台 iPad 上完成；第一次暖機需要網路下載模型，<strong>暖機完成後就可以開飛航模式玩</strong>。</li>
        <!-- 複審第 1 輪 B2：這裡原本寫「只分析畫面中最靠近鏡頭的一個人」——
             這句話不實。去讀 inferenceService.js 第 70 行起的註解：
             MediaPipe 的 numPoses:1 取的是信心分數最高者，不是 bounding box
             最大者，不保證是離鏡頭最近的人（v1 已知風險：展場人多時可能整場
             都在判讀路人）。改成只講程式真正能保證的兩件事：一次只分析一個
             人（其他人的 landmark 從頭到尾不會被算出來），也不會被存下來。 -->
        <li>一次只分析一個人，<strong>其他人的身形資料從頭到尾不會被算出來</strong>，也不會被存下來。</li>
      </ul>

      <h2>會存下什麼</h2>
      <ul>
        <li>只存每一輪的統計數字：專注了幾分鐘、端正幾分鐘、打了幾刀、得幾分。</li>
        <li><strong>不會</strong>存任何照片、影片、人臉特徵或身體座標。</li>
        <li>資料只存在這台 iPad 的瀏覽器裡，不會上傳到任何地方。</li>
      </ul>

      <h2>不會做什麼</h2>
      <ul>
        <li>不會要麥克風權限，不錄音。</li>
        <!-- Blocking B-1 / I-4：這一行原本寫「不會連線到外部伺服器，不會把任何
             資料傳出去」，那句話在兩個層面上都不誠實：
             (a) @mediapipe/tasks-vision 內建一支關不掉的遙測通道，每 60 秒
                 POST 到 odml.pa.googleapis.com，我們的任何 DOM／儲存／文案護欄
                 都看不到它，因為它根本不經過我們的程式碼。現在由 CSP 的
                 connect-src 在瀏覽器層擋掉（index.html 的 meta ＋ public/_headers，
                 兩份的理由見那兩個檔案的註解）。
             (b) 就算沒有 (a)，它跟上面第 31 行「第一次暖機需要網路下載模型」
                 自相矛盾——首次暖機要從 host 下載 35.5MB，那當然是在連伺服器。
             改成同時涵蓋這兩件事、而且在 CSP 生效後仍然為真的講法，用詞與
             TaskSelector.vue 常駐那一行「第一次要連網，之後可離線玩」一致。 -->
        <li>除了第一次下載遊戲資料，不會連線到任何伺服器，也不會把你的資料傳出去。</li>
        <li>不會記錄使用者是誰，也沒有帳號。</li>
      </ul>

      <h2>怎麼刪掉紀錄</h2>
      <p>按下面的「清除所有紀錄」，這台 iPad 上的所有紀錄會立刻消失，無法復原。</p>
      <button class="danger" @click="onClear">清除所有紀錄</button>
      <p v-if="clearState === 'done'" class="cleared" role="status">已經清除了。</p>
      <!-- 更正 4：clearAll() 內部保證 localStorage 的崩潰保險 crumb 一定先清掉，
           才去開 IndexedDB（storageService.js clearAll() 的說明）——IndexedDB
           被私密瀏覽或儲存空間政策封鎖時，crumb 已經真的沒了，但 IndexedDB
           裡存的歷史紀錄可能還在。這句話要誠實反映「清了一部分」，不能讓
           家長以為按了按鈕什麼都沒發生，也不能謊稱全部清乾淨了。 -->
      <p v-if="clearState === 'error'" class="err" role="alert">
        清除沒有完全成功：暫存的紀錄已經清掉，但完整的歷史紀錄可能還留著。
        請確認沒有開啟私密瀏覽模式，或稍後再試一次。
      </p>
      <!-- I4c：只在真的被截斷、還沒捲到底時出現的捲動提示，見下方 script
           的 computeScrollHint() 說明。 -->
      <p v-if="scrollHintVisible" class="scroll-hint" aria-hidden="true">往下滑，還有內容</p>
    </div>

    <button class="primary go" @click="$emit('agree')">我知道了，開始</button>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { clearAll } from '../core/storageService.js'

defineEmits(['agree'])
const open = ref(false)
// 'idle' | 'done' | 'error'：用三態取代原本 brief 裡的單一布林 `cleared`，
// 才有地方放「失敗」這個狀態（更正 4）。
const clearState = ref('idle')

async function onClear() {
  try {
    await clearAll()
    clearState.value = 'done'
  } catch {
    // 隱私紅線：這裡不記錄 error.name/message/stack——這顆按鈕的意義是給
    // 家長一個明確的結果，不是除錯用的訊號，跟 session.js 的 storageError
    // 是兩回事。
    clearState.value = 'error'
  }
}

/**
 * I4c（Task 22b-3 收尾）：橫式時 `.detail` 有自己的內部捲動（見下方
 * `@media (orientation: landscape)` 的 max-height + overflow-y:auto），
 * 觸控裝置上沒有常駐可見的捲軸，家長看到的是一段沒有結尾訊號的文字，
 * 容易誤以為卡住了。這裡加一個「往下滑，還有內容」的提示，只在真的
 * 被截斷、還沒捲到底時出現。
 *
 * 判斷邏輯抽成 computeScrollHint()，只吃 scrollHeight/clientHeight/scrollTop
 * 三個數字，不直接依賴 DOM 元素本身——jsdom 這三個屬性恆為 0，測不出真實
 * 版面，但抽成純函式之後，測試可以直接餵三個數字進去驗證判斷邏輯本身
 * 對不對（PrivacyNotice.test.js 有說明，鎖不到真實版面，要靠實機驗收）。
 *
 * +1px 容差：`scrollTop`/`scrollHeight` 是可能有次像素捨入誤差的浮點數，
 * 嚴格比較 `===` 容易因為 0.3px 的誤差誤判成「還沒捲到底」，讓提示卡在
 * 畫面上關不掉。
 */
function computeScrollHint({ scrollHeight, clientHeight, scrollTop }) {
  const truncated = scrollHeight - clientHeight > 1
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1
  return truncated && !atBottom
}

const detailEl = ref(null)
const scrollHintVisible = ref(false)

function updateScrollHint() {
  const el = detailEl.value
  scrollHintVisible.value = el ? computeScrollHint(el) : false
}

// 展開的瞬間（v-if 剛把 .detail 插進 DOM）先算一次；收起時直接歸零，不留著
// 上一次展開的判斷結果。
watch(open, async (isOpen) => {
  if (!isOpen) { scrollHintVisible.value = false; return }
  await nextTick()
  updateScrollHint()
})

// 直向／橫向切換會改變 .detail 是否有 max-height + overflow-y:auto
// （見下方媒體查詢），resize 事件涵蓋 iPad 旋轉螢幕這個情境，重新算一次。
function handleResize() {
  if (open.value) updateScrollHint()
}
window.addEventListener('resize', handleResize)
onBeforeUnmount(() => window.removeEventListener('resize', handleResize))
</script>

<style scoped>
h1 { font-size: var(--fs-title); margin: 0; }
.one-liner { font-size: 22px; line-height: 1.7; max-width: 34em; margin: 0; }
.more { min-height: var(--tap-min); padding: 0 18px; color: var(--c-accent); background: transparent;
        text-decoration: underline; }
.detail { text-align: left; max-width: 44em; background: var(--c-surface);
          border-radius: var(--radius); padding: 20px; font-size: var(--fs-body); line-height: 1.8; }
.detail h2 { font-size: 19px; margin: 18px 0 6px; }
.detail h2:first-child { margin-top: 0; }
.detail ul { margin: 0; padding-left: 1.3em; }

/* 複審第 1 輪 I4：橫式視窗高度較窄，家長版完整說明（.detail，字最多的地方）
   展開後如果不設高度上限，可能把唯一的出口——底下的「我知道了，開始」
   （.go）——推到摺線以下，跟直式版面同等重要這條規則牴觸。設高度上限＋
   內部捲動，讓 .detail 以外的元素（標題、一行摘要、展開／收合按鈕、.go）
   的總高度跟展開內容的長度脫鉤——不管家長版說明未來加多長，都不會影響
   .go 是否在畫面內，只會影響 .detail 自己要不要捲動。
   （jsdom 不算版面，這個結構性保證用原始碼文字護欄鎖在
   PrivacyNotice.test.js，不是拿 getBoundingClientRect 斷言——跟 App.vue
   health-overlay 那段測試同一個既有先例。） */
@media (orientation: landscape) {
  .detail {
    max-height: min(58dvh, 460px);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
}
.danger { min-height: var(--tap-primary); padding: 0 20px; margin-top: 12px;
          outline: 2px solid var(--c-danger); color: var(--c-danger); background: transparent; }
.cleared { color: var(--c-ok); }
.err { color: var(--c-danger); }

/* I4c：只在橫式（.detail 有內部捲動時，見上面的 landscape 媒體查詢）才有
   機會出現，判斷邏輯見 script 的 computeScrollHint()。這裡只負責視覺：
   - position: sticky + bottom: 0，貼在 .detail 這個捲動容器底部，不會跑到
     容器外面去蓋住 .go（.go 在 .detail 之外，是文件流裡的下一個兄弟元素，
     結構上就蓋不到）。
   - pointer-events: none：這一行文字本身不能吃掉任何捲動手勢或點擊，
     使用者的手指穿透過去，捲動照常由 .detail 的原生 overflow-y:auto 處理，
     不用 JS 另外攔截／轉發事件。
   - 用漸層背景（不是純色）讓提示疊在文字上方時、被蓋住的那一兩行仍然
     隱約看得見一部分，減少「內容被硬生生切掉」的觀感，不需要動畫或
     filter（成本考量與 Task 16 的要求一致）。 */
.scroll-hint {
  position: sticky; bottom: 0; margin: 8px -20px -20px; padding: 10px 20px 6px;
  background: linear-gradient(to bottom, transparent, var(--c-surface) 60%);
  color: var(--c-text-dim); font-size: 15px; text-align: center;
  pointer-events: none;
}

/* 同意按鈕（.go）刻意留在 .detail 之外、屬於整頁一般文件流的一部分，不是
   另一個獨立的捲動容器：body/html 沒有設 overflow-y 限制（見 base.css），
   長內容天生就能靠瀏覽器原生垂直捲動觸及到它，不需要額外處理；也因為它
   是 .detail 後面的下一個兄弟元素（不是疊在上面的 fixed/absolute 元素），
   不可能蓋住 .detail 最後一行文字。這是 brief 允許的兩種做法之一，這裡
   選「按鈕在捲動容器外、靠一般頁面捲動觸及」這種。 */
.go { min-width: 280px; }
</style>
