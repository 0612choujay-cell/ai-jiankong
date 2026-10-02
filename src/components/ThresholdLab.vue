<!--
  ThresholdLab：姿態閾值量測畫面。只給工作人員／開發者在真機上操作，
  用來量出 src/core/postureProfiles.js 的 BASE 該填什麼數字，不是給小孩
  看的畫面（所以不受單句 ≤15 字的長度規則所限，見 copyGuardrail.js 的
  VUE_LENGTH_RULE_EXCEPTIONS 裡這個檔案的那一筆例外與理由）。

  這個元件不自己開鏡頭：camera/inference/videoEl 都是外面（負責掛載的
  工項）傳進來的既有實例，這裡只讀 inference.step() 的結果。專案吃過
  「第二個鏡頭擁有者繞過 session store 判準」的虧（見 thresholdLab.js
  檔頭），所以刻意不呼叫 getUserMedia 或 camera.start()。

  隱私：只從 lab.report()／lab.count() 拿彙總純量（count / p5 / p50 / p95 /
  value / note 字串）顯示。pose 的 r.metrics 只丟給 lab.push() 與即時狀態
  （後者只讀 valid 一個布林值），用完即棄，不進任何 ref 或 DOM。
  object 的 r.metrics 只讀 phoneVisible 一個布林值——那是全專案唯一一個
  從 inferenceService 往外走的物件偵測結果，不含類別名稱、信心分數或
  bounding box，畫面上顯示的字也刻意不是任何品名。
-->
<template>
  <div class="threshold-lab">
    <h2>ThresholdLab 量測工具</h2>
    <p class="hint">
      這個畫面只給工作人員／開發者操作。量到的數字要填回
      src/core/postureProfiles.js 的 BASE。
    </p>
    <!--
      實機驗收加的取樣姿勢說明。不加這段的話，操作者最直覺的做法是
      「抬頭看著螢幕坐正」——而那正是量不準的做法。

      理由跟 CalibrationWizard 的指示是同一個：這個工具量的是耳朵相對於肩膀
      的高度（neckRatio）。抬頭看螢幕跟低頭寫作業，這個數字差很多。用抬頭的
      姿勢量出來的閾值，套到低頭做事的小孩身上，會整場誤判。

      「駝背取樣」要刻意駝，不是隨便亂坐：兩組分佈要分得開，thresholdLab.js
      才給得出建議值；分不開時它會明說「先調鏡頭高度再量一次，不要硬填數字」。
    -->
    <p class="hint">
      取樣姿勢：拿真的作業本或書放好，用<strong>做事的姿勢</strong>量，不要抬頭看螢幕。
      「坐正取樣」＝背挺直、低頭看本子；「駝背取樣」＝刻意駝背趴向桌面。
      兩組都各收 8 筆以上。
    </p>

    <p v-if="stepError" class="warn" data-testid="step-error">
      量測迴圈發生錯誤（已自動接住並繼續）：{{ stepError }}
    </p>

    <!--
      即時量測狀態。跟兩顆取樣鈕的狀態完全無關、一直更新——這是它存在的
      全部理由。

      要解決的問題：使用者回報「按了坐正取樣，計數卻不動」。在只有兩個計數
      的畫面上，至少五種完全不同的原因看起來一模一樣，都是「數字不動」：

        1. rAF 迴圈根本沒在跑（或已經斷掉）→ 迴圈影格 0.0
        2. 推論引擎還沒載好（step() 直接回 null）→ 推論就緒 否
        3. 影像還沒送進來（videoWidth 是 0、或 readyState < 2）→ 影像尺寸 0×0
        4. pose track 沒有被排到（排程／啟用狀態問題）→ 姿態結果 0.0
        5. pose 有在跑，但人沒被偵測到（metrics.valid 一直是 false）
           → 姿態結果 > 0 而有效姿態 0.0

      五種原因的修法完全不同，所以現場一定要能當場分辨。由上往下讀，第一個
      是 0 的那一列就是斷點；五列都正常而計數還是不動，才輪到 lab.push() 或
      標籤狀態本身有問題（第 6 種）。

      最後兩列（物品偵測／物品取樣）是另一條 track 的事，不影響上面五列，
      理由與三態設計寫在 script 裡 objectSeen 的說明。

      三個速率都是這個元件自己在迴圈裡數的，不是讀 inference.actualFps()：
      actualFps 要兩筆完成記錄才算得出數字，而且它不隨時間衰減（停擺之後會
      凍結在舊值，看起來永遠健康）——那兩個性質拿來當「現在到底有沒有在跑」
      的指示燈都是錯的。這裡改用固定 3 秒的滑動窗口數次數，停擺時會在 3 秒
      內自己歸零。

      隱私：三個都只是「最近 3 秒發生幾次」的計數，metrics 只被讀取
      `valid` 這一個布林值，neckRatio／shoulderWidth／landmark 一律不進
      任何 ref、也不進 DOM。影像尺寸是擷取設定（cameraCapture.js 的
      CONSTRAINTS），不是影像內容。
    -->
    <dl class="live" data-testid="live">
      <dt>推論就緒</dt>
      <dd data-testid="live-ready">{{ readyText }}</dd>
      <dt>影像尺寸</dt>
      <dd data-testid="live-frame">{{ frameSize }}</dd>
      <dt>迴圈影格</dt>
      <dd data-testid="live-loop">{{ perSec(loopHits) }}</dd>
      <dt>姿態結果</dt>
      <dd data-testid="live-pose">{{ perSec(poseHits) }}</dd>
      <dt>有效姿態</dt>
      <dd data-testid="live-valid">{{ perSec(validHits) }}</dd>
      <dt>物品偵測</dt>
      <dd data-testid="live-object">{{ objectText }}</dd>
      <dt>物品取樣</dt>
      <dd data-testid="live-object-samples">{{ objectSamples }}</dd>
    </dl>
    <p class="hint">
      上面幾列跟取樣鈕無關，一直更新。由上往下讀，第一個是 0 的那一列就是
      斷點：推論就緒是「否」代表模型還沒載好；影像尺寸是 0×0 代表鏡頭畫面
      還沒送進來；迴圈影格是 0 代表量測迴圈停了；姿態結果是 0 代表 pose
      沒有被排到；有效姿態是 0 代表 pose 有在跑但畫面裡沒有偵測到人
      （調鏡頭角度或坐近一點）。這幾列都有數字、計數卻還是不動，才是取樣
      標籤或樣本被過濾掉的問題。
    </p>
    <p class="hint">
      驗證物品偵測：把手機舉到鏡頭前面，「物品偵測」那一列要從「沒有東西」
      變成「有東西」。物品偵測每三秒才跑一次，舉著不要動，等「物品取樣」
      那個數字往上跳一次再看結果。取樣一直是 0 代表那條 track 根本沒在跑；
      取樣有在跳、字卻一直是「沒有東西」，代表跑得起來但門檻擋掉了。
    </p>

    <div class="controls">
      <button
        type="button"
        class="sample-btn"
        data-testid="btn-good"
        :aria-pressed="currentLabel === 'good' ? 'true' : 'false'"
        @click="toggleLabel('good')"
      >
        坐正取樣
      </button>
      <button
        type="button"
        class="sample-btn"
        data-testid="btn-bad"
        :aria-pressed="currentLabel === 'bad' ? 'true' : 'false'"
        @click="toggleLabel('bad')"
      >
        駝背取樣
      </button>
    </div>

    <dl class="counts">
      <dt>坐正取樣數</dt>
      <dd data-testid="good-count">{{ goodCount }}</dd>
      <dt>駝背取樣數</dt>
      <dd data-testid="bad-count">{{ badCount }}</dd>
    </dl>

    <div class="actions">
      <button type="button" @click="generateReport">產生結果</button>
      <button type="button" @click="resetLab">重新量測</button>
      <button type="button" @click="emit('close')">關閉</button>
    </div>

    <section v-if="report" class="report" aria-live="polite" data-testid="report">
      <h3>量測結果（原樣照抄進 postureProfiles.js 的 BASE）</h3>

      <p v-if="report.baseline" data-testid="baseline">
        baselineNeckRatio: {{ report.baseline.baselineNeckRatio }}，
        baselineShoulderWidth: {{ report.baseline.baselineShoulderWidth }}
      </p>
      <p v-else class="warn">尚未取得坐正基準（good 樣本不足）</p>

      <ul>
        <li v-for="s in report.suggestions" :key="s.key" :data-testid="'suggestion-' + s.key">
          <strong>{{ s.key }}</strong>：{{ s.ok ? '成立' : '不成立' }}
          <span v-if="s.ok" data-testid="value">，value = {{ s.value }}</span>
          <br>
          <span class="note" data-testid="note">{{ s.note }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { createThresholdLab } from '../core/thresholdLab.js'

/**
 * 即時狀態的滑動窗口長度。3 秒是取兩件事的折衷：短到停擺之後操作者在現場
 * 等得住（3 秒內三個速率會自己歸零），長到 pose 的名目頻率（2fps，校準期間
 * 提頻到 6fps）在窗口裡至少有 6 筆，不會因為單一次抖動就跳成 0。
 *
 * 分母固定用這個窗口長度、不用「掛載到現在的實際經過時間」：固定分母在測試
 * 裡是決定性的（餵 N 幀就是 N/3），而代價只有「剛掛載的前 3 秒讀數會偏低」
 * ——那三秒本來就在等模型暖機，操作者不會在那時候下判斷。
 */
const LIVE_WINDOW_MS = 3000

const props = defineProps({
  camera: { type: Object, required: true },
  inference: { type: Object, required: true },
  videoEl: { type: Object, default: null },
})
const emit = defineEmits(['close'])

const lab = createThresholdLab()

const goodCount = ref(0)
const badCount = ref(0)
const currentLabel = ref(null)
const report = ref(null)
const stepError = ref(null)

// 即時狀態（見 template 裡 .live 上方的說明）。只存「最近 3 秒發生幾次」
// 的計數與擷取尺寸，不存任何一筆 metrics 的值。
const loopHits = ref(0)
const poseHits = ref(0)
const validHits = ref(0)
const frameW = ref(0)
const frameH = ref(0)
const ready = ref(false)

/**
 * 物品偵測的即時狀態。
 *
 * 為什麼這一列非有不可：使用者的原話是「設定面板、手機偵測、量測工具這個
 * 東西就只有一個按鈕，也沒有畫面出來，也沒有辦法測說實際上有沒有偵測到」。
 * 設定面板上的「手機偵測」開關給不出即時回饋——那個面板只在選任務畫面
 * 開啟，而那個畫面上鏡頭是關著的，開關本來就只是設定一個之後開打才生效的
 * 偏好。**這個畫面是全 App 唯一一個鏡頭開著、又能把結果顯示出來的地方。**
 *
 * 資料本來就已經流過下面那個 loop()：'lab' 畫面上 object track 跟 pose
 * 一起在跑（enterLab() 會重新打開三個 track），loop() 每隔幾秒就會收到一次
 * `r.key === 'object'`，只是以前沒有人讀它。
 *
 * 三態而不是兩態（null／true／false）：預設值如果是 false，「object track
 * 根本沒在跑」跟「跑了但沒偵測到」在畫面上會長得一模一樣——那正是這整個
 * 工項要消滅的那種黑盒。所以還沒收到過任何一筆 object 結果時顯示「尚無
 * 資料」，並且另外列一個累計取樣數：那個數字不動就是 track 沒在跑，
 * 有在跳而字一直是「沒有東西」才是門檻的問題。
 *
 * 累計數而不是「每秒幾次」：object 的名目頻率是 0.33fps（每 3 秒一次），
 * 放進上面那個 3 秒窗口只會在 0.0 與 0.3 之間跳，讀不出東西。累計數在
 * 現場的讀法很單純——盯著它，每三秒該跳一次。
 *
 * 隱私：只讀 `phoneVisible` 這一個布林值。它是全專案唯一一個從
 * inferenceService 往外走的物件偵測結果，本來就不含類別名稱、信心分數或
 * bounding box；這裡也不新增任何別的欄位。畫面上的字刻意是「有東西／
 * 沒有東西」而不是任何品名——即使只是暫時顯示也不行。
 */
const objectSeen = ref(null)
const objectSamples = ref(0)

// 時間戳陣列刻意放在 reactive 之外：它們每一幀都會被 push/shift，包成 ref
// 等於每幀觸發一次陣列層級的變更通知，而畫面只需要長度。
const loopStamps = []
const poseStamps = []
const validStamps = []

const readyText = computed(() => (ready.value ? '是' : '否'))
const objectText = computed(() => {
  if (objectSeen.value === null) return '尚無資料'
  return objectSeen.value ? '有東西' : '沒有東西'
})
const frameSize = computed(() => `${frameW.value}×${frameH.value}`)
const perSec = (hits) => (hits / (LIVE_WINDOW_MS / 1000)).toFixed(1)

function prune(stamps, now) {
  while (stamps.length > 0 && now - stamps[0] > LIVE_WINDOW_MS) stamps.shift()
  return stamps.length
}

/**
 * 每一幀都要呼叫一次——**包含 step() 丟例外的那一幀**。
 *
 * 「迴圈影格」的用途是回答「這個迴圈還活著嗎」，只在成功路徑上數的話，
 * step() 一直丟例外時它會歸零，看起來跟「迴圈斷掉」一模一樣，正好把這個
 * 指示燈要分開的兩件事又混在一起。
 *
 * 隱私：metrics 只被讀 `valid` 一個布林值，讀完就沒有任何參照留下來。
 */
function refreshLive(now, result) {
  loopStamps.push(now)
  if (result?.key === 'pose') {
    poseStamps.push(now)
    if (result.metrics?.valid) validStamps.push(now)
  } else if (result?.key === 'object') {
    objectSamples.value += 1
    objectSeen.value = Boolean(result.metrics?.phoneVisible)
  }
  loopHits.value = prune(loopStamps, now)
  poseHits.value = prune(poseStamps, now)
  validHits.value = prune(validStamps, now)
  frameW.value = props.videoEl?.videoWidth ?? 0
  frameH.value = props.videoEl?.videoHeight ?? 0
  // 舊的呼叫端（與測試替身）不一定有 isReady——沒有就當作「否」，不要因為
  // 少一個方法就整個元件炸掉。
  ready.value = Boolean(props.inference.isReady?.())
}

let rafId = 0
let alive = true

function toggleLabel(name) {
  const next = currentLabel.value === name ? null : name
  lab.setLabel(next)
  currentLabel.value = next
}

function generateReport() {
  report.value = lab.report()
}

function resetLab() {
  lab.reset()
  goodCount.value = 0
  badCount.value = 0
  currentLabel.value = null
  report.value = null
}

async function loop() {
  const now = performance.now()
  try {
    const r = await props.inference.step(now)
    // await 到下一次 requestAnimationFrame 之間至少有一個 microtask 間隙，
    // 卸載可能剛好落在這裡；卸載後就不再 push 樣本、也不再排下一幀
    // （同 CalibrationWizard.vue 的作法，見它的檔頭註解）。
    if (!alive) return
    refreshLive(now, r)
    if (r?.key === 'pose') {
      lab.push(r.metrics)
      goodCount.value = lab.count('good')
      badCount.value = lab.count('bad')
    }
    rafId = requestAnimationFrame(loop)
  } catch (error) {
    // 複審第 1 輪 I-2（controller 裁決要加，跟 CalibrationWizard.vue 不同）：
    // inferenceService.step() 內部三個 track 各自 try/catch、理論上不會
    // reject，跟 CalibrationWizard 用的是同一個呼叫端——但那個範本只跑 5 秒
    // 單次校準，壞了小孩會叫大人；這個畫面是交付門檻本身，展前架設時連續跑
    // 好幾分鐘，操作者手上沒有 devtools，正式 bundle 又用
    // `esbuild: { drop: ['console'] }` 把 console 全部拔掉。一旦這裡的
    // rAF 鏈斷掉（未接住的 rejection），唯一的症狀是「計數停在某個數字不動」
    // ——取樣本來就是慢慢累積的，操作者會以為還在跑，繼續坐著等到放棄，
    // 不會知道要重開。所以照 session.js 的 frame() 先例：接住例外、只記
    // `error.name`（隱私紅線：不留 message/stack，那可能包含執行環境細節）、
    // 顯示在畫面上（不顯示就等於沒接，操作者一樣看不出哪裡壞了）、照樣排下一幀。
    if (!alive) return
    refreshLive(now, null)
    stepError.value = error?.name ?? 'Error'
    rafId = requestAnimationFrame(loop)
  }
}

onMounted(() => { rafId = requestAnimationFrame(loop) })
onBeforeUnmount(() => {
  alive = false
  cancelAnimationFrame(rafId)
})
</script>

<style scoped>
.threshold-lab {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  /* Important 4（版面／可及性複審）：這是全 App 唯一一個沒有跟進 `.stack`
     這個 safe-area 慣例的頂層畫面（原本固定 `padding: var(--gap)`，不管
     safe-area）。它是展前架設時工作人員橫向拿著 iPad 操作的量測畫面，
     橫向時 home indicator 佔掉的 bottom≈21px 沒有被排除，最底下一排按鈕
     或量測結果文字有可能貼著、甚至部分位於安全區之外。跟 layout.css 的
     `.stack` 用同一個 `max(gap, safe-inset)` 寫法，四個方向都補齊，
     不是只補 bottom——直向 top≈24 一樣不能漏掉。 */
  padding: max(var(--gap), env(safe-area-inset-top))
           max(var(--gap), env(safe-area-inset-right))
           max(var(--gap), env(safe-area-inset-bottom))
           max(var(--gap), env(safe-area-inset-left));
  color: var(--c-text);
}
h2 { font-size: var(--fs-title); margin: 0; }
.hint { font-size: var(--fs-body); color: var(--c-text-dim); margin: 0; }
.controls, .actions { display: flex; gap: var(--gap); flex-wrap: wrap; }
.sample-btn { min-height: var(--tap-primary); min-width: var(--tap-min); }
.sample-btn[aria-pressed="true"] { border-color: var(--c-ok); color: var(--c-ok); }
.counts { display: grid; grid-template-columns: auto auto; gap: 4px var(--gap); font-size: var(--fs-number); }
/* 即時狀態用等寬字體：五個數字每一幀都在變，比例字體會讓數字左右跳動，
   而這五列存在的目的就是讓人盯著看它動不動。版面沿用 .counts 的兩欄
   （名稱一欄、數值一欄）而不是「橫向時攤成五欄」——dl 的 dt/dd 是交錯
   排列的，欄數只要不是 2，名稱與數值就會錯開配對。兩欄在直橫兩向都正確，
   這是直橫同等重要在這個元件上的具體作法。 */
.live {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px var(--gap);
  margin: 0;
  font-family: ui-monospace, monospace;
  font-size: var(--fs-body);
}
.live dt { color: var(--c-text-dim); }
.live dd { margin: 0; }
.report { border-top: 1px solid var(--c-text-dim); padding-top: var(--gap); }
.note { color: var(--c-warn); }
.warn { color: var(--c-warn); }
</style>
