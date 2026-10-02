<template>
  <div class="arena">
    <div class="arena__hero">
      <video ref="localVideo" class="cam" playsinline muted autoplay />
      <!-- 骨架線疊加層：校準時最需要看得到「系統看到我的哪幾個點」——這個
           畫面正在要求小孩照著指示坐好，而他到目前為止完全沒有回饋可以知道
           自己有沒有被看見。完整的隱私推導在 PoseSkeletonOverlay.vue 的檔頭。
           fit 必須跟下面 .cam 的 object-fit 一致（contain），有護欄鎖住。 -->
      <PoseSkeletonOverlay :inference="inference" :video="localVideo" fit="contain" />
      <div class="frame" :class="{ good: sampling && collected > 0 }" :style="frameRect" />
    </div>

    <div class="arena__boss guide">
      <!--
        實機驗收發現的問題（使用者原話：「開頭在測試姿勢也有點難懂，是要坐正
        臉看鏡頭還是要測看書寫作業的樣子」）。原本第三行寫「眼睛看著 iPad」，
        那是錯的指示，而且錯在最要命的地方：

        校準量的是「耳朵相對於肩膀的高度」（poseGeometry.js 的 neckRatio）。
        抬頭看 iPad 跟低頭寫作業，這個數字差很多。用前者當基準、拿後者來玩，
        遊戲會整場認為小孩在駝背——而他其實坐得很好。

        上一輪先改成一句對三種任務都成立的話（「按開始，然後看著你的本子」），
        並在當時的註解裡記下這是**結構限制**：校準發生在選任務之前，這個畫面
        還不知道等一下要做什麼。

        【分任務校準】這一輪把那個結構限制拿掉了——流程改成「選任務 → 校準」，
        所以這裡讀得到 taskType，每一種任務給它自己真實會有的姿勢。四組文案
        的完整判準寫在 <script> 的 TASK_STEPS 上方。
      -->
      <h2>先坐好，我來記住你的姿勢</h2>
      <ol class="how">
        <li v-for="(step, i) in steps" :key="i">{{ step }}</li>
      </ol>

      <p v-if="cameraMissing" class="hint warn">鏡頭還沒接上</p>

      <p v-if="!sampling" class="hint">準備好就按開始</p>
      <p v-else class="countdown" aria-live="polite">{{ remainText }}</p>

      <template v-if="failed">
        <p class="hint warn">鏡頭看不到肩膀</p>
        <p class="hint warn">請往後坐一點</p>
      </template>

      <button v-if="!sampling" class="primary go" @click="begin">
        {{ failed ? '再試一次' : '開始校準' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { createCalibrationCollector } from '../core/calibration.js'
import PoseSkeletonOverlay from './PoseSkeletonOverlay.vue'

const props = defineProps({
  camera: { type: Object, required: true },
  inference: { type: Object, required: true },
  videoEl: { type: Object, default: null },
  /**
   * 這一次要校準給哪一種任務用（【分任務校準】）。
   *
   * 預設 `'custom'`：那是四組裡唯一「不假設小孩在做什麼」的一組，也是未知值
   * 落下來時唯一誠實的答案（見 steps 的 fallback）。單獨掛載這個元件的測試
   * 不必每次都傳。
   *
   * 為什麼是 prop 而不是在元件裡 `useSession()`：這個元件目前是純 props，
   * 它的測試用 `createApp(CalibrationWizard, props)` 直接掛載、完全沒有 store。
   * 一旦這裡開始讀 store，那些測試就得各自補一份 session 的替身，而替身跟真實
   * state 脫節正是 App.mount.test.js 吃過的虧。
   */
  taskType: { type: String, default: 'custom' },
})
const emit = defineEmits(['done'])

const SAMPLE_MS = 5000

/**
 * 「背挺直，肩膀放鬆往後打開」——四組共用的那一句，而且**四組都不能少**。
 *
 * 這不是排版上的偷懶，是反向風險的防線：如果小孩一開始就駝著背校準，那個
 * 駝背會被 `collector` 記成正確基準（neckRatio 偏低），之後整場都不會提醒他
 * ——他坐得越糟，遊戲越認為他坐得好。抽成一個共用常數而不是在四組裡各抄一次，
 * 就是為了讓「少寫一組」這件事在結構上做不到。
 *
 * （另一個方向的風險由每組自己的第 1、3 句負責：用抬頭看螢幕的姿勢校準、
 * 卻低頭寫作業，遊戲會整場認為他在駝背。兩個方向缺一不可。）
 */
const POSTURE_STEP = '背挺直，肩膀放鬆往後打開'

/**
 * 四種任務的姿勢指示。每一組三句：**東西放哪裡 → 背挺直 → 按開始之後看哪裡**。
 *
 * 判準（不是文案品味，是這個校準量得到什麼的直接後果）：
 *
 * - 每一句都必須是**那個任務真實會有的姿勢**。校準量的是耳朵相對於肩膀的
 *   高度，而那個數字完全由「小孩的視線落在哪裡」決定：作業本平放在桌面
 *   （最低）、書攤開在桌上（略高一點，但仍然是低頭）、單字卡拿在手上
 *   （最高，接近平視）。三者不能共用一句話——那正是上一輪只能給通用指示、
 *   而這一輪要修掉的東西。
 * - 第 3 句一律是「按開始，然後看著…」而不是「看著…」：按鈕按下去才開始
 *   取樣，先講動作順序，小孩才不會為了讀畫面而在取樣期間一直抬頭。
 * - `custom`（自己選）**沒有已知的姿勢**，所以誠實地給一句通用的話
 *   （「用平常做事的姿勢」），不假裝知道他要做什麼。為了湊滿四種而編一個
 *   具體姿勢，會比通用指示更糟：那會讓基準值系統性地偏向一個他等一下根本
 *   不會用的姿勢。
 *
 * 沒有列在這裡的 taskType（未來新增的任務、或某次重構打錯字）一律落到
 * `custom`，見 steps。
 */
const TASK_STEPS = Object.freeze({
  homework: Object.freeze(['把作業本放到平常寫的位置', POSTURE_STEP, '按開始，然後看著作業本']),
  reading: Object.freeze(['把書攤開放在桌上', POSTURE_STEP, '按開始，然後看著書']),
  vocab: Object.freeze(['單字卡拿在手上', POSTURE_STEP, '按開始，然後看著單字卡']),
  custom: Object.freeze(['把等一下要做的東西放好', POSTURE_STEP, '按開始，用平常做事的姿勢']),
})

const localVideo = ref(null)
const sampling = ref(false)
const failed = ref(false)
const cameraMissing = ref(false)
const collected = ref(0)
const remainMs = ref(SAMPLE_MS)

/**
 * 對齊框（.frame）的位置與尺寸，用來取代原本寫死的 `inset: 12% 18%`。
 *
 * 實機驗收發現的問題（使用者原話：「現在畫的外框和顯示的方向不相同」）：
 * `.arena__hero` 這個容器本身的長寬比會隨 iPad 直橫翻轉——直式時它是上下
 * 對半的「矮胖」盒子，橫式時是左右對半的「瘦高」盒子——但相機串流的原生
 * 長寬比不會跟著轉，`.cam` 又是 `object-fit: contain`，所以「影像實際畫在
 * 容器裡的哪個矩形（留白／letterbox 在哪一側）」在兩個方向下完全不同。
 * 對齊框如果只用容器的固定百分比去畫，只會在其中一個方向剛好對到影像，
 * 另一個方向就會畫在留白處，變成「框」跟「畫面顯示的方向不相同」。
 *
 * 這裡改成量出跟 PoseSkeletonOverlay.vue 完全同一套 letterbox 公式
 * （`k = min(容器寬/影片原生寬, 容器高/影片原生高)`，contain 取較小值）
 * 算出的實際影像矩形，框只在那個矩形內部再收一圈 inset，不會畫到留白。
 * 兩處算法不同步的風險由 CalibrationWizard.mount.test.js 的一條原始碼
 * 比對測試鎖住。
 *
 * jsdom 量不到真實 layout（clientWidth/clientHeight 恆為 0），量不到的時候
 * 保留這組初始值當 fallback——外觀等同原本寫死的 `inset: 12% 18%`，不是
 * 憑空選的數字。
 */
const frameRect = reactive({ left: '18%', top: '12%', width: '64%', height: '76%' })
let resizeObserver = null

function updateFrame() {
  const host = localVideo.value?.parentElement
  const W = host?.clientWidth ?? 0
  const H = host?.clientHeight ?? 0
  if (!W || !H) return // 量不到就維持上一次（或初始）的值，不要拿 0 去除

  const vw = localVideo.value?.videoWidth ?? 0
  const vh = localVideo.value?.videoHeight ?? 0
  let sx = W, sy = H, ox = 0, oy = 0
  if (vw > 0 && vh > 0) {
    const k = Math.min(W / vw, H / vh) // object-fit: contain，跟 PoseSkeletonOverlay.vue 同一個公式
    sx = vw * k
    sy = vh * k
    ox = (W - sx) / 2
    oy = (H - sy) / 2
  }

  // 框收在「實際畫出影像」的矩形內部再留一圈，比例沿用原本 inset:12% 18%
  // 的視覺份量（上下留 12%、左右留 18%），只是現在量的基準換成影像矩形
  // 本身，不是整個容器。
  const insetX = sx * 0.18
  const insetY = sy * 0.12
  frameRect.left = `${ox + insetX}px`
  frameRect.top = `${oy + insetY}px`
  frameRect.width = `${Math.max(0, sx - insetX * 2)}px`
  frameRect.height = `${Math.max(0, sy - insetY * 2)}px`
}

const collector = createCalibrationCollector()
let rafId = 0
let startedAt = 0
let alive = true

const remainText = computed(() => `保持這個姿勢 ${Math.ceil(remainMs.value / 1000)} 秒`)

// 未知的 taskType 落到 custom：那是四組裡唯一不假設小孩在做什麼的一組。
// 不寫成 `TASK_STEPS[props.taskType]` 然後讓 v-for 跑在 undefined 上——那會
// 是一個「步驟清單整個消失、畫面上只剩標題跟按鈕」的靜默失敗，而校準照樣
// 會跑完 5 秒、照樣記下一組基準值。
const steps = computed(() => TASK_STEPS[props.taskType] ?? TASK_STEPS.custom)

// App 裡真正接了 getUserMedia 的 video 元素是外面傳進來的 props.videoEl
// （見 cameraCapture.js：它在建構時就綁死一個 video 節點）。這個元件自己的
// <video> 是另一個節點，從來沒人餵過串流——這裡只是把同一個 MediaStream
// 再掛一份到本地這個節點上做鏡像預覽，不搬動、不佔有外面那個節點（那個節點
// 可能同時是別的畫面在用的），所以卸載這個元件不會連帶把它殺掉。
function attachPreview() {
  const stream = props.videoEl?.srcObject ?? null
  // 只在真的換了串流時才指派：srcObject 的 setter 即使給同一個物件參照，
  // 瀏覽器仍會重跑 media load algorithm，畫面會黑一下。begin() 每次都會呼叫
  // 這個函式（含「再試一次」），少了這道比較，小孩每按一次就閃一次。
  if (localVideo.value && localVideo.value.srcObject !== stream) {
    localVideo.value.srcObject = stream
    // 實機驗收第一次上 iPad 就抓到的 bug（在此之前 732 條測試全綠）：
    // 指派 srcObject **不會**讓 <video> 開始播放。少了 autoplay 屬性又沒有人
    // 呼叫 play()，這個節點在 iOS Safari 上會維持 paused——校準畫面左半邊
    // 整片空白，而小孩正被要求「照著畫面坐好」。
    //
    // BattleView.vue 的同一段鏡像預覽（:7 與 :436）從一開始就同時有 autoplay
    // 與這個 play() 呼叫，這裡沒有——兩個元件做同一件事，一個對一個錯，
    // 而 jsdom 不渲染 video，所以沒有任何測試看得出差別。
    // 作法逐字照抄 BattleView，不另外發明第二種寫法。
    //
    // Promise.resolve() 包一層：jsdom 的 play() 回傳 undefined（不是 Promise），
    // 真實瀏覽器才回傳 Promise——兩種情況都要安全吞掉「被中斷的 play()」。
    Promise.resolve(localVideo.value.play?.()).catch(() => { /* 被中斷的 play() 不算失敗 */ })
  }
  cameraMissing.value = !stream
  updateFrame()
}

function begin() {
  failed.value = false
  collected.value = 0
  collector.reset()
  attachPreview()
  // 校準期間提頻並關掉用不到的模型，5 秒內才蒐集得到足夠取樣。
  // 這個元件**不寫任何絕對值**——見 restore() 上方的完整說明（Blocking B1）。
  props.inference.setCalibrationBoost(true)
  sampling.value = true
  startedAt = performance.now()
  rafId = requestAnimationFrame(loop)
}

/**
 * 校準結束／元件卸載時把疊加層拿掉。
 *
 * ── 這個函式刻意**不知道**該還原成什麼（Blocking B1）──────────────
 *
 * 它以前寫的是絕對值：`setScale(props.restoreScale)`、
 * `setEnabled('face', true)`、`setEnabled('object', true)`。
 * 流程反轉（選任務 → 校準 → 開打）之後，這個元件的卸載被排到
 * `startBattle()` 的 `await` 之中，於是這三行變成**開打前最後一個寫推論設定
 * 的人**：工作人員在設定面板關掉的手機偵測會被那個無條件的 `true` 打開，
 * 效能降檔關掉的 object track 也會在每一場戰鬥被重新打開——而
 * `state.objectDetectorOn` 還停在 false，畫面上不會有任何字說得出為什麼。
 *
 * 修法不是「想辦法排在 store 後面」（`await nextTick()` 之類）：那是把正確性
 * 押在 flush 順序上，而 flush 順序正是這次被流程反轉倒過來的東西。
 * 改成**元件不再持有任何值**——它只翻一個布林，合成與還原都由
 * `inferenceService` 用 store 寫進去的基準層去算（見該檔的
 * `setCalibrationBoost()`）。誰先誰後都算出同一個結果，順序因此不再是
 * 正確性的一部分。
 *
 * 連帶：`restoreScale` 這個 prop 不再存在，App.vue 也不必再算一份
 * `s.perfMode ? 0.5 : 1`（那份重複的 0.5 曾經是事故 #4 的來源）。
 *
 * 護欄（Ruling DK，裝在違規會發生的地方＝這個檔案）：
 * `CalibrationWizard.mount.test.js` 的「不得寫絕對值」那一組會掃這個元件的
 * 原始碼，任何人把 `inference.setScale(` / `inference.setEnabled(` 寫回來就會紅。
 */
function restore() {
  props.inference.setCalibrationBoost(false)
}

async function loop() {
  const now = performance.now()
  remainMs.value = Math.max(0, SAMPLE_MS - (now - startedAt))

  const r = await props.inference.step(now)
  // await 到 requestAnimationFrame(loop) 之間至少有一個 microtask 間隙，
  // 卸載可能剛好落在這裡；用區域旗標（而非共享狀態）判斷這次呼叫還算不算數，
  // 卸載後就不再排下一幀，避免留下持續呼叫共用推論資源的殘留迴圈。
  if (!alive) return
  if (r?.key === 'pose') {
    collector.add(r.metrics)
    collected.value = collector.count()
  }

  if (remainMs.value > 0) {
    rafId = requestAnimationFrame(loop)
    return
  }

  sampling.value = false
  restore()
  const result = collector.result()
  if (!result.ok) { failed.value = true; return }
  emit('done', { ...result.profile, calibratedAt: Date.now() })
}

onMounted(() => {
  attachPreview()
  // videoWidth/videoHeight 在 srcObject 指派當下多半還是 0（metadata 還沒
  // 解出來），loadedmetadata 觸發時才量得到真正的影片原生尺寸。
  localVideo.value?.addEventListener?.('loadedmetadata', updateFrame)
  // ResizeObserver 而不是 window resize/orientationchange：iPad 旋轉、
  // Split View 改變寬度都會改變 .arena__hero 這個容器本身的大小，直接觀察
  // 容器比監聽視窗事件更準（也不必自己再判斷「是不是真的轉向了」）。
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(updateFrame)
    if (localVideo.value?.parentElement) resizeObserver.observe(localVideo.value.parentElement)
  }
})
onBeforeUnmount(() => {
  alive = false
  cancelAnimationFrame(rafId)
  restore()
  localVideo.value?.removeEventListener?.('loadedmetadata', updateFrame)
  resizeObserver?.disconnect()
})
</script>

<style scoped>
/* object-fit 與 display 這兩個值以前是靠瀏覽器預設值（HTML 的建議 UA 樣式表
   給 <video> 的是 object-fit: contain，而 <video> 預設是 inline，行框的
   descender 會在下緣留幾 px 的空隙）。骨架線疊加層必須知道影像實際怎麼被
   擺進這個盒子才算得出線的位置，把它寫明白：
   - `object-fit: contain` 只是把既有的預設值寫出來，畫面完全不變，但它從
     「隱性的瀏覽器預設」變成「這個檔案自己宣告、而且有護欄比對」的值。
   - `display: block` 消掉 inline 造成的下緣空隙，讓 <video> 的盒子跟
     .arena__hero（疊加層 inset:0 對齊的那個盒子）真的一樣大。 */
.cam { display: block; width: 100%; height: 100%; object-fit: contain; transform: scaleX(-1); }
/* 對齊框：純邊框，不用 filter/box-shadow 動畫（常駐 video 上方的合成成本）。
   位置與尺寸改由 <script> 的 frameRect 算出來，用 inline style 覆蓋
   left/top/width/height——理由見 frameRect 上方的完整註解（letterbox 對齊
   問題）。這裡只留邊框樣式，不再寫死 inset。 */
.frame {
  position: absolute;
  border: 4px dashed var(--c-text-dim);
  border-radius: var(--radius);
  transition: border-color .2s;
}
.frame.good { border-color: var(--c-ok); border-style: solid; }
.guide { flex-direction: column; gap: var(--gap); padding: var(--gap); }
h2 { font-size: var(--fs-title); margin: 0; }
.how { text-align: left; font-size: var(--fs-body); line-height: 1.9; }
.countdown { font-size: var(--fs-coach); font-weight: 700; margin: 0; }
.hint { font-size: var(--fs-body); color: var(--c-text-dim); }
.hint.warn { color: var(--c-warn); }
.go { min-width: 220px; }
</style>
