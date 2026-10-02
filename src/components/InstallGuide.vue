<template>
  <div v-if="show" class="install" role="note">
    <!-- 靜態橫幅，不朗讀、不會被下一則取代，所以不受「單句 ≤15 字」那條
         短暫提示上限約束（跟 BreakScreen 的伸展清單同一個例外理由）；仍然
         拆成兩行，因為一行擠 30 幾個字對這個年齡層本來就讀不完。 -->
    <p class="msg">
      把遊戲加到主畫面，下次不用開瀏覽器
      <small>分享鈕 → 加入主畫面</small>
    </p>
    <button aria-label="關閉安裝提示" @click="dismiss">✕</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const KEY = 'focus-quest:install-dismissed'

// 已經是從主畫面啟動的就不必再提示。兩種偵測都留著：display-mode 是標準做法，
// navigator.standalone 是 iOS Safari 自己的舊旗標，而這個 App 的目標裝置正是
// iPad Safari——只看標準那條在某些 iPadOS 版本上會漏判。
// 兩層 optional chaining 都是必要的：matchMedia 本身可能不存在（舊 WebView），
// 回傳值在測試替身裡也可能是 undefined。
const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
                || window.navigator.standalone === true

// Safari 私密瀏覽／儲存被封鎖時，光是 getItem 就會丟例外——當成「沒關過」處理，
// 一個安裝提示不值得讓整個畫面掛掉。
function dismissedBefore() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

const show = ref(!standalone && !dismissedBefore())

function dismiss() {
  show.value = false
  try { localStorage.setItem(KEY, '1') } catch { /* 私密瀏覽時放棄記憶，不影響主流程 */ }
}
</script>

<style scoped>
/*
 * 版面紅線自查算式（更正 5）：這條橫幅跟 StatsDashboard 的 .actions
 * （「再討伐一次」「回主畫面」兩顆主按鈕，也是 position:fixed 的底部列）
 * **不得相交**。這個專案已經因為「覆蓋層蓋住它自己叫你按的按鈕」踩過三次，
 * 而這裡更糟一點：橫幅上有一顆 ✕ 要點，所以不能用 pointer-events:none 把
 * 症狀蓋掉——真的要算一次矩形。
 *
 * .actions 實際佔用的視覺高度（見 StatsDashboard.vue 的同一份算式）：
 *   按鈕高（--tap-primary）＋上 padding（--gap）＋下 padding（max(--gap, inset-bottom)）
 *   ＝ --tap-primary + --gap + max(--gap, inset-bottom)
 *
 * 所以這條橫幅的 bottom 取：
 *   --tap-primary + --gap*2 + max(--gap, inset-bottom)
 * 兩式相減，橫幅底緣永遠剛好在 .actions 上緣再上方 1 個 --gap（16px），
 * 不管 env(safe-area-inset-bottom) 實際是 0 還是 iPad Pro 的 34px——因為
 * 兩式共用同一個 max(--gap, inset-bottom) 項。這個值跟 .stats 自己的
 * padding-bottom 是同一個算式，也就是說橫幅剛好落在「內容保留給底部列的
 * 那段空白」的上緣。
 *
 * 這件事有測試鎖著（InstallGuide.test.js：直接從兩個元件的原始碼裡把這兩個
 * CSS 算式抓出來、代入 token 實際值與多組 inset 求值，再比較矩形），不是
 * 「改了 CSS 就算數」。
 *
 * 另一個畫面（TaskSelector，screen === 'task'）底部沒有 fixed 元素，橫幅
 * 浮高一點只是留白，不會蓋到任何東西。
 */
.install {
  position: fixed;
  left: max(var(--gap), env(safe-area-inset-left));
  right: max(var(--gap), env(safe-area-inset-right));
  bottom: calc(var(--tap-primary) + var(--gap) * 2 + max(var(--gap), env(safe-area-inset-bottom)));
  z-index: 8;
  display: flex; align-items: center; gap: 12px;
  background: var(--c-surface); border-radius: var(--radius); padding: 10px 12px 10px 16px;
}
.msg { margin: 0; font-size: 15px; flex: 1; line-height: 1.5; }
.msg small { display: block; color: var(--c-text-dim); }
.install button { width: var(--tap-min); height: var(--tap-min); background: transparent;
                  font-size: 18px; flex: none; }
</style>
