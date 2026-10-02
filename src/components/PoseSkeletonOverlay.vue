<template>
  <!--
    純裝飾層：aria-hidden（螢幕閱讀器沒有辦法讀一張畫布，念出「canvas」只是
    噪音）、pointer-events:none（不得擋住任何既有可互動元素）。

    這個節點刻意**只有兩個靜態屬性**。校準畫面的屬性清單護欄
    （CalibrationWizard.mount.test.js 的完全相等比對）會逐字列出它們——
    任何人日後在這裡掛一個 :title / :data-* 把座標帶出去，那條護欄當場紅。
  -->
  <canvas ref="canvasEl" class="skeleton" aria-hidden="true" />
</template>

<script setup>
/**
 * 骨架線疊加層：把偵測到的姿勢關鍵點連成幾條線，畫在鏡像鏡頭預覽上面。
 *
 * ═══ 這個檔案是全專案隱私界線最薄的一塊，先讀完這段再改 ═══════════════
 *
 * 這個 App 的隱私架構有一條從第一天守到現在的界線：**landmark 座標在
 * `inferenceService.js` 內部被 `poseGeometry.poseMetrics()` 壓縮成
 * `{ neckRatio, shoulderWidth, valid }` 三個數字之後才離開那一層**，
 * 原始座標永遠不進 store、不進 state machine、不進 storage、不進 DOM。
 *
 * 畫骨架線需要的正是那條界線要擋的東西。所以它走一條**全新、獨立、不與任何
 * 既有資料流交叉**的旁路，而這個檔案是那條旁路的終點：
 *
 *   PoseLandmarker.detectForVideo()                （inferenceService.js 內）
 *     → step() 的區域變數 poseLandmarks            （那一輪結束就失去參照）
 *     → inference.onPoseFrame() 推給訂閱者
 *     → 這個檔案的 draw(landmarks)                 （函式參數，只活在這一次呼叫）
 *     → CanvasRenderingContext2D 的幾條線          （只活在螢幕上的像素）
 *     → 終點。沒有下一站。
 *
 * 這個檔案必須守住的四條紅線：
 *
 * 1. **`landmarks` 只能是 `draw()` 的參數。** 不得指派給 `ref()`／
 *    `reactive()`／任何 top-level 變數／任何 DOM 屬性。Vue 的 devtools 看
 *    `setupState`，所以「存進一個沒有用在模板上的 ref」一樣算違規——
 *    `PoseSkeletonOverlay.test.js` 有一條測試會遞迴掃描 `setupState` 找哨兵值。
 * 2. **畫布不得被序列化。** 沒有 `toDataURL()`、`toBlob()`、`getImageData()`，
 *    不寫進 localStorage／IndexedDB、不存進任何 ref。像素跟這個專案處理攝影機
 *    影格一樣：用後即丟。（原始碼層護欄在測試檔裡。）
 * 3. **不得把座標交給任何既有模組。** 這個檔案沒有 import `session.js`／
 *    `focusStateMachine.js`／`storageService.js`／`poseGeometry.js`——
 *    一個都沒有，而且不該有。
 * 4. **不得為了骨架線放寬任何既有護欄。** 既有的 DOM canary、屬性清單、
 *    ALLOWED_FIELDS 白名單全部原封不動繼續生效。
 *
 * ═══ 效能 ═══════════════════════════════════════════════════════════
 *
 * 這是每個 pose 影格都要跑的東西，而這個 App 有一個**單向、不可升回**的
 * 效能降檔（`perfMonitor.js`：推論延遲 EMA 連續超標 10 秒就降頻，之後這一輪
 * 再也升不回來）。兩道保護：
 *
 * - `onPoseFrame()` 的呼叫點在 `inferenceService.step()` 量完 latency **之後**
 *   （見該檔），所以繪圖成本不會被算進降檔的判準裡。
 * - `draw()` 本身**每幀零配置**：沒有 `new`、沒有陣列字面值、沒有物件字面值、
 *   沒有 `map/filter/forEach` 的回呼、沒有暫時字串。只有一次 `clearRect`、
 *   兩條 `stroke` 用的直線、三個小圓點，全部用區域數字變數算。
 *   backing store 只在元素尺寸真的變了才重新配置（寫 `canvas.width` 會清空
 *   畫布並重新配置記憶體，每幀寫等於每幀重配 1 張全螢幕 bitmap）。
 *
 * ═══ prefers-reduced-motion ════════════════════════════════════════
 *
 * 骨架線本身不是動畫：它沒有 transition、沒有 animation、沒有淡入淡出，
 * 只有「這一幀畫在哪裡」。所以沒有東西需要對 reduced-motion 做例外處理。
 * 這個性質由測試鎖住（`<style>` 區塊裡不得出現 transition/animation）——
 * 日後有人加淡入效果，那條測試會紅，提醒他一併處理 reduced-motion。
 */
import { ref, watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  /**
   * `inferenceService` 實例（戰鬥畫面用 `session.inference()`、校準畫面用
   * 自己的 `props.inference`）。只用到 `onPoseFrame()` 這一個方法，而且只讀
   * 不寫——這個元件**不得**呼叫任何會改變推論生命週期或啟用狀態的方法
   * （`init`／`destroy`／`setScale`／`setEnabled`／`setCalibrationBoost`）。
   */
  inference: { type: Object, default: null },
  /**
   * 底下那個鏡像預覽 `<video>` 元素。只讀它的 `videoWidth`／`videoHeight`
   * （影像的原生尺寸），用來換算 `object-fit` 的裁切／留白，讓線條落在
   * 影像上正確的位置。不讀影像內容、不碰 `srcObject`、不呼叫任何方法。
   */
  video: { type: Object, default: null },
  /**
   * 底下那個 `<video>` 實際套用的 `object-fit`。**必須跟 CSS 寫的一致**，
   * 否則線條會整體偏移——這是典型的「兩套真相」，所以
   * `PoseSkeletonOverlay.test.js` 有一條護欄逐一比對兩個宿主元件的
   * `.cam { object-fit: … }` 與這裡傳進來的值。
   *
   * 量不到影像原生尺寸時（jsdom、影格還沒 decode）兩者都退回「整個拉滿」，
   * 那是唯一不需要原生尺寸的假設。
   */
  fit: {
    type: String,
    default: 'cover',
    validator: (v) => v === 'cover' || v === 'contain',
  },
  /**
   * 依姿態變色（使用者要求：「正常是黃線，駝背異常是紅線」）。
   *
   * 預設 `null`：**維持這個元件原本唯一的行為**——單一固定色（讀 CSS 的
   * `color`，正常路徑是 `--c-accent`）。校準畫面（`CalibrationWizard.vue`）
   * 刻意不傳這個 prop，因為校準當下遊戲還不知道「正確答案」是什麼
   * （那正是校準要建立的基準），沒有東西可以拿來判斷好壞——傳一個假的
   * 判準只會誤導人。所以校準畫面的線維持原本的顏色，這個改動對它零影響。
   *
   * 只有戰鬥畫面（`BattleView.vue`）會傳真正的值，因為那裡才有已經算好、
   * 安全的彙總姿態分類（`session.state.posture`，字串列舉，不含座標）。
   *
   * 只分兩色，不分三種姿態各一色（`slouch`／`forwardHead`／`gazeAway`）：
   * 這個年齡層一眼要判讀得出來，顏色太多反而增加認知負擔，而且三者的
   * 處理方式（回去坐正）是一樣的，不需要分開的視覺語言。`'upright'` 以外
   * 一律算異常，包含未來新增的姿態分類——這裡故意用「不是 upright」而不是
   * 條列所有異常字串，才不會漏掉以後新加的分類。
   */
  posture: { type: String, default: null },
})

/**
 * landmark 索引。**這四行必須跟 `src/core/poseGeometry.js` 的同一行逐字相同**
 * ——那裡是「唯一知道 landmark 索引的地方」，這裡是不得不的第二份（畫線的人
 * 本來就得知道要連哪兩個點）。兩份飄掉的後果是靜默的：畫面上的線跟遊戲實際
 * 在量的點不是同一組，而小孩會照著線調整姿勢。
 *
 * 所以不靠人工同步：`PoseSkeletonOverlay.test.js` 讀兩個檔案的原始碼，逐字
 * 比對這三行常數宣告。改了其中一邊就會紅。
 */
const EAR_L = 7, EAR_R = 8, SHOULDER_L = 11, SHOULDER_R = 12
const MIN_VISIBILITY = 0.5
const MIN_SHOULDER_WIDTH = 0.02

/**
 * 線條顏色的 fallback。`props.posture === null`（校準畫面）時的正常路徑是
 * 讀這個 canvas 的 computed `color`（scoped style 裡寫的是 `var(--c-accent)`，
 * 不是色碼），只有在讀不到的環境（jsdom、或 CSS 還沒套上）才用這個字面值。
 *
 * 它逐字等於 `src/styles/tokens.css` 的 `--c-accent`，而且由測試鎖住兩者
 * 相等——否則這裡就是一個「發明出來的色碼」，會在某些情況下靜默地跟整個
 * 配色不一致。
 */
const FALLBACK_STROKE = '#5ad1ff'

/**
 * 依姿態變色的兩個顏色。跟 `FALLBACK_STROKE` 是同一個理由的字面值，
 * 逐字等於 `tokens.css` 的 `--c-warn`／`--c-danger`，測試鎖住兩者相等。
 *
 * 用字面值而不是 `getComputedStyle` 現讀：這兩個顏色不需要每幀重算
 * （不像既有的 `strokeColor` 快取要應付「元素還沒套上 CSS」這種一次性的
 * 不確定性）——它們是固定色碼，讀一次跟寫死一份字面值在效果上沒有差異，
 * 但字面值省掉每幀一次 DOM 查詢（`getComputedStyle` 不便宜）。
 */
const STROKE_OK = '#fbbf24'
const STROKE_BAD = '#fb7185'

const canvasEl = ref(null)

// 以下四個刻意是 `let`，不是 `ref()`：它們是繪圖的內部快取，放進 reactive
// 系統只會讓每幀寫入觸發不必要的更新，而且會出現在 Vue devtools 裡。
let ctx = null
let strokeColor = null
let lastW = 0
let lastH = 0

function visibleEnough(p) {
  return p.visibility === undefined || p.visibility >= MIN_VISIBILITY
}

/**
 * 唯一一個看得到原始座標的函式。
 *
 * `landmarks` 是參數，畫完就結束；離開這個函式之後，這個元件再也沒有任何
 * 路徑可以拿到它。**不要把它存起來。**
 *
 * 傳進 null／無效姿勢時只清空畫布並 return——「偵測不到」必須看得出來，
 * 不能讓上一幀的線留在畫面上假裝還在追蹤。
 */
function draw(landmarks) {
  const el = canvasEl.value
  if (!el) return
  if (ctx === null) {
    ctx = typeof el.getContext === 'function' ? el.getContext('2d') : null
    if (!ctx) return
    // 只在 props.posture === null（校準畫面）時才需要這次一次性的 CSS 讀取；
    // 有 posture 值的路徑（戰鬥畫面）用下面固定的兩個字面值，跟這次初始化
    // 無關，所以不管哪種情況都只做這一次查詢，不會每幀重算。
    const computed = typeof window !== 'undefined' && window.getComputedStyle
      ? window.getComputedStyle(el).color
      : ''
    strokeColor = computed || FALLBACK_STROKE
  }
  // 依姿態變色：`props.posture` 是 null 時（校準畫面）沿用上面快取的固定色，
  // 不做任何比較——這條件本身就是校準畫面「零改動」的保證。有值時
  // （戰鬥畫面）每幀重新選色：這只是一次字串比較賦值，不是配置，不違反
  // 「每幀零配置」——選色跟兩個常數本身都不會產生新物件。
  const frameStroke = props.posture === null
    ? strokeColor
    : (props.posture === 'upright' ? STROKE_OK : STROKE_BAD)

  // backing store 只在版面尺寸真的變了才重寫（寫 width/height 會清空畫布並
  // 重新配置記憶體）。dpr 上限 2：iPad 上再高只是多配置幾 MB 的 bitmap，
  // 對「幾條線」的清晰度沒有可見差別。
  const cw = el.clientWidth
  const ch = el.clientHeight
  if (cw > 0 && ch > 0 && (cw !== lastW || ch !== lastH)) {
    lastW = cw
    lastH = ch
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0
      ? Math.min(window.devicePixelRatio, 2)
      : 1
    el.width = Math.round(cw * dpr)
    el.height = Math.round(ch * dpr)
  }

  const W = el.width
  const H = el.height
  if (!(W > 0) || !(H > 0)) return
  ctx.clearRect(0, 0, W, H)

  if (!Array.isArray(landmarks) || landmarks.length < 33) return
  const earL = landmarks[EAR_L]
  const earR = landmarks[EAR_R]
  const shL = landmarks[SHOULDER_L]
  const shR = landmarks[SHOULDER_R]
  if (!earL || !earR || !shL || !shR) return
  // 判準跟 poseGeometry.poseMetrics() 的 INVALID 條件一致：遊戲說「沒有有效
  // 姿勢」的那一刻，畫面上的線也要跟著消失，不能兩邊講不一樣的話。
  if (!visibleEnough(earL) || !visibleEnough(earR)) return
  if (!visibleEnough(shL) || !visibleEnough(shR)) return
  if (Math.hypot(shR.x - shL.x, shR.y - shL.y) < MIN_SHOULDER_WIDTH) return

  // 正規化座標（0–1，相對於送進模型的那張影像）→ 畫布像素。
  // object-fit 的裁切／留白：cover 取放大倍率的較大者、contain 取較小者，
  // 兩者都置中，所以只差一個 max/min。量不到原生尺寸就整個拉滿（fill）。
  let sx = W
  let sy = H
  let ox = 0
  let oy = 0
  const vw = props.video?.videoWidth ?? 0
  const vh = props.video?.videoHeight ?? 0
  if (vw > 0 && vh > 0) {
    const k = props.fit === 'contain'
      ? Math.min(W / vw, H / vh)
      : Math.max(W / vw, H / vh)
    sx = vw * k
    sy = vh * k
    ox = (W - sx) / 2
    oy = (H - sy) / 2
  }

  const shLx = ox + shL.x * sx
  const shLy = oy + shL.y * sy
  const shRx = ox + shR.x * sx
  const shRy = oy + shR.y * sy
  const shMidX = (shLx + shRx) / 2
  const shMidY = (shLy + shRy) / 2
  const earMidX = ox + ((earL.x + earR.x) / 2) * sx
  const earMidY = oy + ((earL.y + earR.y) / 2) * sy

  const lw = Math.max(2, W * 0.006)
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = frameStroke
  ctx.fillStyle = frameStroke

  ctx.beginPath()
  // 肩線：poseGeometry 的 shoulderWidth 就是這兩點的距離。
  ctx.moveTo(shLx, shLy)
  ctx.lineTo(shRx, shRy)
  // 頸線：兩耳中點 → 兩肩中點。poseGeometry 的 neckRatio 量的就是這一段的
  // 垂直分量除以肩寬，所以畫面上看到的線跟遊戲在判斷的量是同一件事。
  ctx.moveTo(earMidX, earMidY)
  ctx.lineTo(shMidX, shMidY)
  ctx.stroke()

  // 三個關節點：兩肩＋頸線頂端。半徑跟線寬連動，不另外發明尺寸。
  const r = lw * 0.9
  ctx.beginPath()
  ctx.moveTo(shLx + r, shLy)
  ctx.arc(shLx, shLy, r, 0, Math.PI * 2)
  ctx.moveTo(shRx + r, shRy)
  ctx.arc(shRx, shRy, r, 0, Math.PI * 2)
  ctx.moveTo(earMidX + r, earMidY)
  ctx.arc(earMidX, earMidY, r, 0, Math.PI * 2)
  ctx.fill()
}

let unsubscribe = null

/**
 * 訂閱／解除訂閱。用 watch（而不是只在 onMounted 做一次）是因為宿主元件的
 * `inference` 可能在元件生命週期之內才變成非 null（`session.inference()` 在
 * `boot()` 之前是 null）。`immediate: true` 讓首次也走同一條路徑，
 * 不需要兩份訂閱程式碼。
 *
 * `draw` 直接當訂閱者傳出去，不包一層箭頭函式：包一層等於每次訂閱多配置一個
 * 閉包，而且會讓「訂閱者是誰」在解除訂閱時變得不明確。
 */
watch(() => props.inference, (inf) => {
  unsubscribe?.()
  unsubscribe = typeof inf?.onPoseFrame === 'function' ? inf.onPoseFrame(draw) : null
}, { immediate: true })

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  // ctx 是這個元件唯一持有的畫布參照，卸載時一起放掉。畫布本身跟著節點被
  // 移除，裡面的像素隨之消失——沒有任何地方留下那一幀的副本。
  ctx = null
})
</script>

<style scoped>
/*
  跟底下的鏡像 <video> 完全同一個盒子（兩者都相對於 .arena__hero 的
  position:relative），所以線條與影像不會有任何偏移。

  transform: scaleX(-1) 跟兩個宿主元件的 .cam 逐字相同——繪圖用的是**未鏡像**
  的影像座標（模型看到的那一張），靠這個 transform 讓它跟畫面上鏡像過的預覽
  對齊。少了它，使用者往右偏頭、線往左跑，比沒有線更糟。
  （`PoseSkeletonOverlay.test.js` 有一條護欄比對兩邊都寫著 scaleX(-1)。）

  z-index: 0 而不是更高：它要蓋在 <video> 上面（DOM 順序在後），但必須讓
  校準畫面的對齊框（.frame）、戰鬥畫面的「重整旗鼓」（.regroup, z-index 1）、
  血條與角落按鈕（z-index 3/4）全部畫在它上面。

  pointer-events: none：不吃任何觸控。角落的暫停／結束、撤銷鈕都在這一層
  上面而且照樣點得到。

  刻意沒有 transition / animation / filter：這一層每幀重畫，任何過渡效果都
  只會製造殘影與額外的合成成本（而且會讓 prefers-reduced-motion 變成必須
  處理的問題）。這個性質由測試鎖住。
*/
.skeleton {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  transform: scaleX(-1);
  color: var(--c-accent);
}
</style>
