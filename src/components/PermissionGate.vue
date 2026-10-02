<!--
  Task 19：授權前已經在 PrivacyNotice.vue 說明過用途，這個畫面才是真正觸發
  `getUserMedia` 的地方（`request()` 呼叫 `session.boot()`）。

  spec 明確只做 `NotAllowedError` 這一條復原路徑（完整的五步驟設定路徑＋
  「我設定好了，重試」），不做四種錯誤分流、不做無鏡頭降級模式——其餘錯誤
  一律走 `otherError` 的通用訊息。

  文案長度例外聲明（同 PrivacyNotice.vue，給 Task 22a 的全域文案護欄用）：
  這個檔案裡的說明文字（開場一句話、五步驟設定路徑、通用錯誤訊息）**不受
  「單句 ≤15 字」的長度上限**——那條規則約束的是會被語音播報、或會被下一則
  短暫提示取代的文字（見 App.vue 戰鬥中提示的護欄）；這裡是靜態、可從容
  閱讀、不會被朗讀也不會被取代的說明文字，不適用。禁用詞規則仍然全部適用。
-->
<template>
  <div class="stack">
    <template v-if="!denied">
      <h2>接下來要開啟鏡頭</h2>
      <p class="why">
        iPad 會問你要不要允許使用相機，請按「<strong>允許</strong>」。<br>
        影像只在這台 iPad 上分析，不會被存起來也不會傳出去。
      </p>
      <button class="primary go" :disabled="working" @click="request">
        {{ working ? '開啟中…' : '開啟鏡頭' }}
      </button>
    </template>

    <template v-else>
      <h2>鏡頭被擋住了</h2>
      <p class="why">沒有鏡頭就沒辦法看坐姿。照下面的步驟打開它：</p>
      <ol class="steps">
        <li>打開 iPad 的「<strong>設定</strong>」App</li>
        <li>往下找到「<strong>Safari</strong>」並點進去</li>
        <li>點「<strong>相機</strong>」</li>
        <li>選「<strong>詢問</strong>」或「<strong>允許</strong>」</li>
        <li>回到這個畫面，按下面的按鈕</li>
      </ol>
      <button class="primary go" :disabled="working" @click="request">我設定好了，重試</button>
    </template>

    <!-- 複審第 1 輪 I1：這裡原本把 error.name 直接嵌在主句中間（「鏡頭啟動
         失敗（NotReadableError）」），一段英文代碼擋在小孩看得懂的句子正
         中央；而且「請確認沒有其他 App 正在使用相機」對 NotFoundError（這台
         iPad 根本沒有可用鏡頭）是文不對題的建議，重試永遠不會成功——跟 B1
         同一條紅線（文案指向的操作必須是使用者做得到的操作）。改成：主句用
         不預設成因的中文，error.name 降級成次要小字（跟開機錯誤舊版「技術
         細節」同一個做法）；NotFoundError 額外補一句「重試不會成功，因為
         真的沒有鏡頭」，不算四種錯誤分流——分流指的是四條不同的復原路徑，
         這裡仍然只有一條路徑（按同一顆按鈕重試），只是多了一句誠實的提醒。 -->
    <template v-if="otherError">
      <p class="err" role="alert">
        鏡頭沒辦法打開。請確認沒有其他分頁或 App 正在使用相機，再按一次重試。
      </p>
      <p v-if="otherError === 'NotFoundError'" class="err" role="alert">
        這台 iPad 找不到可以用的鏡頭。
      </p>
      <p class="hint"><small>技術細節：{{ otherError }}</small></p>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useSession } from '../stores/session.js'

const props = defineProps({ videoEl: { type: Object, default: null } })
const emit = defineEmits(['granted'])

const session = useSession()
const denied = ref(false)
const otherError = ref('')
const working = ref(false)

async function request() {
  working.value = true
  otherError.value = ''
  const r = await session.boot(props.videoEl)
  working.value = false

  if (r.ok) { emit('granted'); return }

  // spec 只做 NotAllowedError 這一條復原路徑，其餘統一顯示通用訊息
  if (r.error?.name === 'NotAllowedError') denied.value = true
  else otherError.value = r.error?.name ?? '未知錯誤'
}
</script>

<style scoped>
h2 { font-size: var(--fs-title); margin: 0; }
.why { font-size: 20px; line-height: 1.8; max-width: 32em; margin: 0; }
.steps { text-align: left; font-size: 20px; line-height: 2.2; max-width: 24em;
         background: var(--c-surface); border-radius: var(--radius); padding: 20px 20px 20px 48px; }
.go { min-width: 280px; }
.err { color: var(--c-danger); font-size: var(--fs-body); max-width: 32em; }
</style>
