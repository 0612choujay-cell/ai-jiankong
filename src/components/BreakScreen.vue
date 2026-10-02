<template>
  <div class="stack break">
    <p class="tag">休息回合</p>
    <p class="clock">{{ mm }}:{{ ss }}</p>

    <ul class="moves">
      <li v-for="m in MOVES" :key="m">{{ m }}</li>
    </ul>

    <p class="boss-line">{{ bossLine }}</p>

    <button class="primary done" @click="finish">休息夠了，繼續討伐</button>

    <button class="skip" @click="onSkip">
      {{ skipArmed ? '再按一次就跳過休息' : '跳過休息' }}
    </button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { BOSS_COPY } from '../data/copy/boss.js'

const emit = defineEmits(['done'])

const props = defineProps({
  /**
   * 抽休戰台詞用的亂數來源（複審第 1 輪 Nit-5）。
   *
   * 原本是裸的 `Math.random()`：測試沒辦法決定性地驗證「抽到哪一句」，也沒辦法
   * 驗證下面那條「不要連續兩次抽到同一句」的規則。注入之後兩件事都測得到，
   * App.vue 照常什麼都不用傳。
   */
  rand: { type: Function, default: null },
})

const BREAK_MS = 3 * 60_000
const SKIP_ARMED_MS = 3000

/**
 * 伸展建議。
 *
 * 複審第 1 輪 IMP-4：這段原本宣告自己是「單句 ≤15 字」的顯式例外、並要求把
 * 它列進全域文案護欄的例外表——那是**不成立的前提**。複審用 t22a 真正的擷取器
 * 跑過這四行：14／15／14／4 字，全部 ≤15，護欄根本不會抓到它們，不需要任何
 * 例外條目。留著一個不存在的需求，下一個人會照著去加一筆無效的例外，而那筆
 * 例外會讓清單看起來比實際需要更寬。所以改成事實：
 *
 *   這四行**本來就符合** 15 字上限，沒有申請例外；新增或改寫時請維持 ≤15 字。
 *
 * 其餘紅線照樣適用：禁用詞、以及「不得出現任何身體外觀描述」——所以這裡講的
 * 是動作（轉肩膀、看遠方、深呼吸、喝水），不是身體。
 */
const MOVES = [
  '站起來，肩膀往後轉 10 圈',
  '看向窗外或最遠的牆，數到 20',
  '手臂往上伸直，深呼吸 3 次',
  '喝一口水',
]

const remain = ref(BREAK_MS)
const skipArmed = ref(false)

/**
 * 魔王的休戰台詞：**靜態顯示，不朗讀**。
 *
 * 「魔王台詞一律走 messageQueue.publish() 帶 ns/key」那條紅線管的是**會被
 * 唸出來、會排隊、會互相蓋掉**的戰鬥訊息——它要的是「只有一個朗讀呼叫點、
 * 只有一個仲裁者」。休息畫面這一行不進那條管線：它不排隊（畫面上只有它一
 * 則）、不會被取代、也不會被朗讀，所以這裡直接讀文案池顯示，而**不是**另開
 * 一個朗讀呼叫點——後者才是那條紅線真正在防的事。
 * BreakScreen.test.js 有一條測試把「這個畫面不得觸發任何 TTS」鎖住。
 *
 * 為什麼不改走 store 的 CopyEngine（複審第 1 輪 Nit-5 的另一個選項）：
 * `take()` 有 45 秒 cooldown 且**會回 null**，而 `'boss'/'regroup'` 正是戰鬥中
 * `regroupStart` 事件在用的同一個 key——「打瞌睡 → 按休息」離上一次重整旗鼓
 * 很可能不到 45 秒，那時休息畫面會安靜地少一行字（畫面上沒有「這次不講話」這個
 * 選項）；`peek()` 則不消耗 bag，連續兩次休息會拿到同一句。所以這裡維持直接讀
 * 文案池，只把亂數來源開放注入（上面的 `rand` prop），讓它測得到。
 *
 * 刻意**不**自己再做一套「不連續重複」的記憶：那需要一個模組層的狀態，會讓
 * 「抽到哪一句」取決於這個元件過去被掛載過幾次——測試之間互相影響，而換來的
 * 只是三句台詞偶爾重複一次。不重複邏輯只該有一份（CopyEngine），不該長分身。
 */
function pickBossLine(rand) {
  const pool = BOSS_COPY.regroup
  // clamp：rand() 回傳 1（或任何 ≥1 的怪值）時 floor 會落在池子外面。
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)))
  return pool[i]
}

const bossLine = pickBossLine(props.rand ?? Math.random)

const mm = computed(() => String(Math.floor(remain.value / 60_000)).padStart(2, '0'))
const ss = computed(() => String(Math.floor((remain.value % 60_000) / 1000)).padStart(2, '0'))

let timer = 0
let skipTimer = 0

/**
 * 「休息結束」只准發生一次。
 *
 * 三個來源都走這裡：倒數歸零、按「休息夠了」、連按兩下「跳過休息」。少了這道
 * 閘，同一次休息會 emit 兩次 done——而 done 在 App.vue 那邊可能是
 * `startBattle()`（結算頁進來的那條路），等於連開兩場，第一場立刻被第二場
 * 取代。這個年齡層「按了沒反應就再按一次」是預設行為（session.js 對兩顆
 * 相鄰按鈕也做過同樣的假設），而 onBreakDone() 是 async，畫面不會在點擊的
 * 同一個 tick 就切走——空窗是真的存在的。
 */
let finished = false

function finish() {
  if (finished) return
  finished = true
  clearInterval(timer)
  clearTimeout(skipTimer)
  timer = 0
  skipTimer = 0
  emit('done')
}

// 跳過要點兩下：一下就跳過等於沒有休息回合，完全不給跳過又會卡住想繼續的人。
// 3 秒沒有第二下就解除備妥狀態——不解除的話，休息到一半誤觸一下，兩分鐘後
// 再誤觸一下就直接跳過了，那跟一下就跳過沒有差別。
function onSkip() {
  if (skipArmed.value) { finish(); return }
  skipArmed.value = true
  clearTimeout(skipTimer)
  skipTimer = setTimeout(() => { skipArmed.value = false }, SKIP_ARMED_MS)
}

onMounted(() => {
  // 用「結束時刻」倒推剩餘時間，不是每 tick 減 1000：setInterval 在背景分頁
  // 會被節流、也不保證準點，累減會讓三分鐘的休息變成四分鐘甚至更久。
  const endsAt = Date.now() + BREAK_MS
  timer = setInterval(() => {
    remain.value = Math.max(0, endsAt - Date.now())
    if (remain.value === 0) finish()
  }, 1000)
})

// timer 不清掉的話，休息畫面卸載之後那個 interval 還會每秒跑一次、而且還握著
// 一個會 emit('done') 的 closure（已經被 finished 擋住，但一個永遠跑下去的
// interval 本身就是洩漏）。skipTimer 同理。
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(skipTimer) })
</script>

<style scoped>
.break { gap: 20px; }
.tag { font-size: var(--fs-body); color: var(--c-text-dim); margin: 0; letter-spacing: .3em; }
.clock { font-size: clamp(64px, 18vmin, 140px); font-weight: 800; margin: 0;
         font-variant-numeric: tabular-nums; line-height: 1; }
.moves { list-style: none; padding: 20px; margin: 0; background: var(--c-surface);
         border-radius: var(--radius); text-align: left; font-size: 20px; line-height: 2.1;
         max-width: 28em; }
.boss-line { font-size: var(--fs-number); color: var(--c-boss); margin: 0; }
.done { min-width: 280px; }
.skip { min-height: var(--tap-min); padding: 0 18px; background: transparent; color: var(--c-text-dim); }
</style>
