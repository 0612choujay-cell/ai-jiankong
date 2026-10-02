import { reactive, readonly } from 'vue'
import { createCameraCapture } from '../core/cameraCapture.js'
import { createInferenceService } from '../core/inferenceService.js'
import { createPerfMonitor } from '../core/perfMonitor.js'
import { createPoseAnalyzer } from '../core/poseAnalyzer.js'
import { createFocusStateMachine } from '../core/focusStateMachine.js'
import { createWakeLock } from '../core/wakeLock.js'
import { createVoiceFeedback } from '../core/voiceFeedback.js'
import { createCopyEngine } from '../core/copyEngine.js'
import { saveSession, listSessions, writeCrumb, clearCrumb, reconcile, clearAll } from '../core/storageService.js'
import { profileFor } from '../core/postureProfiles.js'
import { DEFAULT_DURATION_MIN, DEMO } from '../core/battleConfig.js'
import { POSTURE_COPY } from '../data/copy/posture.js'
import { BOSS_COPY } from '../data/copy/boss.js'
import { SUMMARY_COPY } from '../data/copy/summary.js'

/**
 * 推論健康判斷分兩條獨立的線，兩條都要過，才算健康：
 *
 * 1) 例外次數（health()）：pose／face 任一連續丟例外 ≥ 3 次。3 次連續失敗換算
 *    成真實時間，pose(2fps)約 1.5 秒、face(3fps)約 1 秒——比單一影格的暫時性
 *    例外（手一瞬間擋住臉、動態模糊觸發例外）明顯更長，足以排除偶發雜訊，
 *    又不會讓小孩隨手轉頭半秒就被判定「推論壞掉」。
 *
 * 2) 資料新鮮度（見 FRESHNESS_TIMEOUT_MS）：這條是審查第 1 輪抓出來的真實漏洞
 *    （C1）——`step()` 在鏡頭被課本／手指擋住、串流凍結、`videoEl.readyState`
 *    掉到 2 以下這幾種情況下，都是在 try 之外就直接 return null，完全不會讓
 *    health() 的失敗計數增加。而 `poseAnalyzer.evaluate()` 在窗口內沒有有效
 *    資料時預設回傳 posture:'upright'（heldMs 回 null，`(null ?? 0) >= hold`
 *    恆為 false）——兩者疊加的結果是「把課本立在鏡頭前」會被系統判定成
 *    坐姿完美、持續打魔王。只看例外次數擋不住這個情境，必須另外追蹤
 *    「最後一次拿到*有效*（metrics.valid===true）結果是什麼時候」，超過門檻
 *    沒有任何一筆有效資料，一樣判定不健康。
 *
 * object track 不參與這兩條判斷：它只影響 phoneVisible（手機陷阱），卡住的
 * 後果頂多是「手機警示可能誤判」，不到需要暫停整場戰鬥計分的程度。但 object
 * 連續失敗到一定次數時，其陳舊的 phoneVisible 讀數不可信，見 frame() 裡
 * `health.object.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD` 那段的說明。
 */
const HEALTH_FAILURE_THRESHOLD = 3

/**
 * 資料新鮮度門檻：pose／face 只要有任何一個超過這麼久沒有拿到「有效」的
 * 一筆（不是沒收到 step() 結果，是收到了但 metrics.valid===false），就判定
 * 不健康。取 2000ms：pose 2fps（約每 500ms 嘗試一次）連續 4 次無效、
 * face 3fps（約每 333ms 嘗試一次）連續 6 次無效才會觸發，比單一幀的雜訊
 * （偶爾一幀因動態模糊判不出肩膀）更長，但比「一直丟例外」的
 * HEALTH_FAILURE_THRESHOLD 換算出的真實時間（約 1~1.5 秒）稍微寬一點——
 * 這條防的是「安靜地判成完美坐姿」這種更危險的失效模式（C1：把課本立在
 * 鏡頭前，6 秒內魔王照樣掉血），寧可比例外門檻更敏感，也不要留給使用者
 * 太久的作弊窗口。
 */
const FRESHNESS_TIMEOUT_MS = 2000

/** 持續不健康多久之後從「暫時不穩定」升級成明確的錯誤態（I5）。 */
const INFERENCE_STUCK_MS = 30_000

/**
 * 單向緊急降檔時套用的推論頻率倍率（`inference.setScale()`）。
 *
 * 抽成常數是複審 I-1 的連帶修正：這個數字原本只以字面值 0.5 出現在 frame()
 * 的降檔分支裡，而「降檔之後倍率該是多少」這件事至少有三個地方要知道
 * （降檔當下、resetPerfMode() 的復原、以及每一次轉場的收斂），散成三個
 * 字面值就是三套真相等著彼此漂移。
 */
const DOWNSHIFT_SCALE = 0.5

function computeInferenceHealthy(health, now, lastValidPoseAt, lastValidFaceAt) {
  const failuresOk = health.pose.consecutiveFailures < HEALTH_FAILURE_THRESHOLD
    && health.face.consecutiveFailures < HEALTH_FAILURE_THRESHOLD
  const freshOk = now - lastValidPoseAt < FRESHNESS_TIMEOUT_MS
    && now - lastValidFaceAt < FRESHNESS_TIMEOUT_MS
  return failuresOk && freshOk
}

const state = reactive({
  screen: 'privacy',
  booted: false,
  bootError: null,
  // 任一環節（推論、事件消費者……）丟出未預期例外時的錯誤名稱（隱私紅線：
  // 只留 error.name，不留 message/stack）。正常情況下永遠是 null。
  loopError: null,
  // 複審第 1 輪 F2：跟 loopError 同一個先例——本地儲存（IndexedDB 被封鎖、
  // 私密瀏覽、schema 打錯字……）失敗時不能靜默吞掉例外，正式 bundle 拔掉
  // console 之後連 unhandled rejection 都看不到。這裡只記錯誤名稱，不留
  // message/stack（隱私紅線；儲存失敗本身也不該讓遊戲玩不下去，只留一個
  // 可觀察的訊號給未來的畫面或除錯用）。
  storageError: null,
  // Task 18 複審第 1 輪 F1：跟 storageError 分開的獨立欄位，只用來記
  // listSessions() 失敗——「本場有沒有存起來」跟「讀不讀得到以前的紀錄」是
  // 兩個獨立事實，共用一個欄位、一句文案會讓畫面在其中一種情境下講錯話
  // （例如本場明明存成功了，卻顯示「這次的紀錄沒有存起來」）。同樣只留
  // error.name（隱私紅線）。
  historyError: null,
  profile: null,
  taskType: 'homework',
  durationMin: DEFAULT_DURATION_MIN,
  demoMode: false,
  // 隱私紅線：這裡以下四個欄位是唯一允許存進 reactive state 的推論相關資料——
  // 全部是彙總後的純量（字串／布林），不得把 svc.step() 回傳的 metrics 整包存進來。
  // metrics（landmark 座標、blendshape 數值、原始角度）只在 analyzer 內部的滑動窗口
  // 短暫存活，一離開 evaluate() 就不再有任何地方持有它們的參照。
  posture: 'upright',
  drowsy: false,
  phoneVisible: false,
  // 單向緊急降檔（perfMonitor.js）的觀測面：latencyEma 是純數字（推論延遲的
  // 指數移動平均），perfMode 一旦變 true 就不會變回 false（見 perf 變數上方
  // 說明），只能透過整個 App 重啟或未來的手動重啟偵測入口清除。
  // objectDetectorOn 同時服務兩個獨立來源：降檔會把它關掉；Task 22c 的設定
  // 面板透過 setPhoneDetectEnabled() 讓工作人員手動開關（展場手機誤判率偏高，
  // 需要能關掉）——兩者共用同一個「現在到底有沒有在跑」的旗標，沒有第二套真相。
  // 初始值是 false 而不是 true：boot() 之前根本沒有 inference，任何一個 track
  // 都不可能「正在跑」，寫 true 只是一句還沒被驗證過的樂觀宣告；boot() 會用
  // phoneDetectEnabled（見下面）把它收斂成真正的狀態。
  latencyEma: 0,
  perfMode: false,
  objectDetectorOn: false,
  /**
   * 手機（ObjectDetector）偵測的**使用者明示設定**，跟 objectDetectorOn
   * （現在到底有沒有在跑）是兩件不同的事：後者還會被自動降檔改寫，前者只有
   * 工作人員在設定面板按下去才會變。
   *
   * 預設 **true**。這個值在 Task 22c 原本是 false，理由是「展場人來人往，
   * 路人手裡的手機會進到畫面裡；判錯的成本不對稱——被冤枉的是小孩，而他對此
   * **完全無能為力**」。
   *
   * 那個理由的後半句是錯的，實機驗收才發現：`CoachBanner.vue` 上就有一顆
   * 「我沒有在玩那個」的撤銷鈕，而且它被認定為小孩提出異議的**唯一出口**
   * ——這一輪總審還特地修過「那顆鈕會被裝置異常提示蓋住」的問題。
   * 也就是說誤判的代價是**點一下**，不是含冤莫白。前提一旦不成立，
   * 從它推出來的結論就跟著失效。
   *
   * 而預設關閉的代價，是實機測試第一輪就撞到的：**手機陷阱這個核心遊戲機制
   * 對每一位訪客都靜默失效**，除非工作人員記得去設定面板打開。使用者拿起
   * 手機、魔王照樣掉血，看起來像偵測壞掉——而畫面上沒有任何東西說它是關的
   * （StatusIndicator 那則「手機偵測已暫停」只在戰鬥畫面、而且要展開才看得到）。
   *
   * 兩相比較：誤判 → 小孩點一下撤銷鈕；預設關閉 → 機制整場不存在且無人察覺。
   * 所以改成預設開啟，設定面板保留關閉的開關，給現場真的被路人手機干擾時用。
   */
  phoneDetectEnabled: true,
  // 「清除所有本地紀錄」的進度：'idle' | 'busy' | 'done' | 'error'。
  // 失敗一定要是 'error'，不得靜默當成功——這個專案已經吃過一次「兩種失敗
  // 共用一個旗標、結算畫面對使用者說謊」的虧（見 historyError 上方說明）。
  clearState: 'idle',
  paused: false,
  inferenceHealthy: true,
  // 持續不健康超過 INFERENCE_STUCK_MS 之後才會是 true（I5）：跟 inferenceHealthy
  // 分開兩個欄位，才能讓畫面在「剛開始不穩定」跟「已經確定是壞的」講不同的話。
  inferenceStuck: false,
  cameraHealthy: true,
  battle: null,
  lastRecord: null,
  // Task 18：結算頁（StatsDashboard）用來畫「跟上一次比」的歷史紀錄，
  // endBattle() 存完本場之後用 listSessions(60) 刷新（見該處的 try/catch）。
  // 刻意只放彙總後的 SessionRecord 陣列，跟隱私紅線一致（見 storageService.js
  // 的白名單）；不是 landmark／影像那類原始資料。
  history: [],
  // spec 要求預設關閉（不得自作主張幫使用者打開語音）；voiceAvailable 反映的是
  // 「這台裝置找不找得到中文語音」，不是使用者的開關選擇——兩者是正交的兩件事，
  // StatusIndicator（Task 16）要能分別顯示「語音關閉」跟「語音不可用」。
  voiceEnabled: false,
  voiceAvailable: false,
})

let camera = null
let inference = null
let analyzer = null
let fsm = null
const wakeLock = createWakeLock()
// 單一 PerfMonitor 單例，跟 camera/inference 一樣掛在 App 層、貫穿整個 App
// 生命週期（不是每輪重建）：降檔判斷本身依賴「裝置有沒有持續過熱／過載」，
// 一輪換到下一輪不代表裝置突然又變快了。降檔一旦觸發就不會自動復原——
// 這是 perfMonitor.js 本身的設計（見該檔頭註解），這裡刻意不在 startBattle()
// 裡呼叫 perf.reset()，跟 phoneVisible／cameraHealthy 那類「每輪必須歸零」
// 的欄位不是同一類問題：那些是單輪的暫態觀測，這是跨輪都成立的裝置狀態信號。
const perf = createPerfMonitor({ thresholdMs: 150, sustainMs: 10_000 })

// DebugHud 需要跨整個 App 生命週期（不是單輪）的效能統計，供 spec 要求但
// Safari 拿不到的量化指標（Long Tasks API／performance.memory／GPU 記憶體）
// 做替代驗收：p95 延遲、rAF 間隔 p95/max、累計輪數。只留最近 600 筆避免無限
// 成長；一輪大約十幾分鐘、rAF 60Hz 換算下 600 筆只是最近 10 秒，這裡要的是
// 「現在」的分佈，不是整輪的歷史，所以視窗小是刻意的。
const perfSamples = { latency: [], raf: [], rounds: 0 }
let lastFrameAt = 0

function pushSample(arr, v) {
  arr.push(v)
  if (arr.length > 600) arr.shift() // 只留最近 600 筆，避免無限成長
}

function p95(arr) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

// 單一 VoiceFeedback 單例，跟 wakeLock 同一個理由掛在 store 層：primed／enabled
// 這些狀態要跨整個 App 生命週期只有一份，不能讓 BattleView 每次掛載都自己
// createVoiceFeedback() 一份——那樣「開始討伐」按鈕暖機過的那份跟 BattleView
// 拿去 speak() 的那份會是兩個不同的實例，暖機等於白做。
const voice = createVoiceFeedback()

// 單一 CopyEngine 單例，跟 camera／inference 一樣掛在 App 層、貫穿整個 App 生命週期。
// 之所以由 store 持有而不是留給未來畫面自己 new 一個，是因為 resetSession() 一定要
// 打在「將要被實際拿去 take() 的那個實例」上——如果 BattleView 之後自己另外
// createCopyEngine()，store 這裡呼叫 resetSession() 就等於對空氣開槍。
const copy = createCopyEngine({ pools: { posture: POSTURE_COPY, boss: BOSS_COPY, summary: SUMMARY_COPY } })

let rafId = 0
// frame() 遞迴排程鏈上唯一的 await 點（inference.step()）讓出的空隙間，這一輪
// 有可能已經被新的 startBattle()／endBattle()／teardown() 取代（今天單執行緒＋
// 目前呼叫方式下不可達，但 inferenceService.js 明講日後要搬進 Worker，屆時就是
// 活的 bug——跟 CalibrationWizard.vue 的 `alive` 旗標是同一個理由）。frameGen
// 就是那個世代號：只要它跟自己拿到的 gen 對不上，就代表「這一幀已經不算數了」。
let frameGen = 0
// fsm.tick() 的 t 參數是「距離該輪開始的毫秒數」，不是 performance.now() 原值
// （見 focusStateMachine.js 檔頭註解）。battleStartAt 是這個換算的唯一原點，
// 只在 startBattle() 設一次；sessionT() 是唯一允許做這個換算的地方，
// 其他地方一律呼叫它，不准自己另外用 now 減掉什麼東西湊出 t。
let battleStartAt = 0
// fsm 內部 paused 旗標目前被同步成什麼值。只在「使用者暫停」或「推論／鏡頭不健康」
// 這個合成值真的改變時才呼叫 fsm.setPaused()——每一幀都呼叫的話，setPaused()
// 會把 fsm 內部的 lastTickAt 重設成當下的 t，緊接著同一幀再呼叫 tick(t) 算出來的
// dt 永遠是 0，整條戰鬥迴圈會被自己悄悄卡死（tick() 在 dt===0 時直接 return，
// 不會有任何報錯，只會看起來像魔王打不動）。
let fsmPausedCombined = false
// 最後一次拿到「有效」pose／face 結果的時間，見 FRESHNESS_TIMEOUT_MS 說明。
let lastValidPoseAt = 0
let lastValidFaceAt = 0
// 暫停／背景「這一次」開始的時間點；resume 時用來把 lastValid*At 往前平移
// （見 shiftFreshness()）。null 代表目前沒有處於暫停／背景造成的新鮮度懸置狀態。
let freshnessSuspendedAt = null
// state.inferenceHealthy 從 true 掉到 false 的那個時間點；恢復健康就清成 null。
let unhealthySince = null
// 第 3 輪的 pauseGen 與第 6 輪的 cameraSyncGen 已於第 7 輪合併成單一的
// camGen（宣告與完整規則見 bumpCamGen() 上方）。原本 pauseGen 要解決的問題
// 不變：togglePause() 恢復分支有 await（camera.resume()／wakeLock.request()），
// 這段空窗裡使用者完全可能再按一次——這個年齡層「按了沒反應就再按一次」是
// 預設行為——也可能直接按結束、或把 iPad 切到背景。
const handlers = new Set()

function emit(events) {
  if (!events.length) return
  for (const h of handlers) {
    try {
      h(events)
    } catch {
      // 一個事件消費者（未來 BattleView 的某個渲染／播音／動畫）壞掉，不該拖垮
      // 整條戰鬥迴圈——迴圈死掉的症狀是「畫面還在、但什麼都不再動」，比單一
      // 消費者的顯示錯誤嚴重得多。這裡刻意隔離、不重新丟出；迴圈本身的例外
      // 兜底見 frame() 的 try/catch（那裡才會設 state.loopError）。
    }
  }
}

function durationMs() {
  return state.demoMode ? DEMO.durationMs : state.durationMin * 60_000
}

function sessionT(now) {
  return now - battleStartAt
}

/** 是否允許把姿態餵進 fsm.tick() 繼續計分：使用者沒暫停、推論健康、鏡頭健康。 */
function scoringAllowed() {
  return !state.paused && state.inferenceHealthy && state.cameraHealthy
}

/**
 * 「當下這個世界」該不該讓鏡頭處於 live 且 enabled。
 *
 * 這是 togglePause() 裡那個「已經被更晚一次呼叫取代」的舊呼叫落地時，唯一還
 * 該做的事：它手上的資訊（ok、now、自己那次是暫停還是繼續）全部過期了，但它
 * 剛剛可能真的把鏡頭打開過（resume() 的快路 setEnabled(true)，或慢路 start()
 * 重新拿到一條預設 enabled 的新 track），所以一定要把鏡頭收斂回「現在該有的
 * 樣子」。問題只在於：「現在該有的樣子」的權威來源是誰。
 *
 * 選 `state.screen`（加上 `state.paused`），不是只看 `state.paused`：
 * - `state.paused` 是**戰鬥畫面內部**的狀態，離開戰鬥畫面就沒有意義。
 *   `endBattle()` 刻意不把它改回 true（對 stats 畫面而言「暫停」不成立，而
 *   `startBattle()` 一定會重設它），所以「按了繼續、隨即按結束」之後 paused
 *   會停在 false——只看 `!state.paused` 會得到「該開鏡頭」這個結論，把
 *   `endBattle()` 剛關掉的鏡頭再打開，而且之後沒有任何東西會把它關回去
 *   （要等下一次 `startBattle()` 或整個關掉 PWA）。使用者看到的是：已經回到
 *   開始畫面，iPad 的鏡頭指示燈卻一直亮著。這是審查第 4 輪抓到的 Critical，
 *   也是這個 App 的隱私承諾唯一會被打破的方式。
 * - 內部的 `fsm` 是否存在，在目前可達的狀態下跟 `screen === 'battle'` 完全
 *   同步（兩者都只在 startBattle()～endBattle() 之間成立），拿它當判準也會
 *   得到同樣的答案；但 `fsm` 是「計分機」，不是「鏡頭的擁有者」，兩者相等
 *   只是巧合而不是理由，而且它是模組私有變數，App.vue 與測試都看不到它。
 *   隱私紅線本身是用 UI 描述的（「UI 不在使用鏡頭時，鏡頭不得 live 且
 *   enabled」），判準就該寫在 UI 自己的狀態上。
 *
 * 三者不一致的地方就只有一處，但那一處正是這條線的全部理由：
 * `endBattle()` 之後 `screen='stats'`、`fsm=null`，而 `paused` 維持原值。
 *
 * ---
 *
 * 為什麼判準從「只有 battle」變成「battle + calibrate」（審查第 5 輪）：
 *
 * 第 4 輪這裡刻意把 'calibrate' 排除，理由是「togglePause() 只掛在戰鬥畫面的
 * 按鈕上，正常操作下不會有舊呼叫落在校準畫面；真要支援『結束 → 重新校準』，
 * 該處理的是 endBattle() 關掉鏡頭之後沒有人重新打開它這件事，不是在這裡多加
 * 一個 screen 值把症狀蓋掉」。那個推理在當時是對的——但它的前提是「沒有人會
 * 從 stats 回到 calibrate」，而那正是第 5 輪要修掉的 blocking 問題本身
 * （`endBattle()` 關掉鏡頭 → 按「開始」→ `boot()` 因 booted 早退 → 校準畫面
 * 對著一台關掉的鏡頭。展場輪流玩時，**第一位訪客之後的每一位都是第二場**）。
 * 前提一旦被修掉，結論就跟著失效。
 *
 * 現在這個函式有兩個呼叫點：togglePause() 的收斂行，以及 setScreen()——也就是
 * **每一次畫面轉換**。這是刻意的：讓「鏡頭現在該不該開」在整個專案只有一個
 * 答案。第 4 輪擔心的「遲到的 togglePause() 在校準畫面把鏡頭關掉」在 calibrate
 * 被納入判準之後自動消失（它會收斂成 enabled=true，而校準本來就需要鏡頭）；
 * 反過來，如果讓「收斂用的判準」跟「畫面轉換用的判準」各自回答一次，那就是
 * 兩套真相——前四輪這條線反覆長出分身的根因，正是同一個問題有兩個答案。
 *
 * 下一個維護者新增畫面時要問自己的，就只有一個問題：**這個畫面上的使用者，
 * 看得到、也預期得到鏡頭正在運作嗎？** 是就加進來（校準要照鏡子、戰鬥要偵測
 * 姿態，所以兩個都在），否就不要加（'privacy'／'task'／'stats' 都只是選單和
 * 結算，鏡頭亮著沒有任何理由，而這個 App 賣的就是這件事）。不要用「這個畫面
 * 有沒有 in-flight 的非同步呼叫」來回答——那是實作細節，會隨下一次重構改變；
 * 「使用者預期鏡頭開著嗎」不會。
 *
 * 第 6 輪又補了一個跟畫面無關的維度：App 在背景時一律 OFF（見函式內第一行）。
 * 「使用者看得到嗎」在背景時的答案恆為否，所以它蓋過所有畫面。
 *
 * Task 20 用上面那個問題回答了 `'break'`（休息回合）：**OFF**。那個畫面在叫
 * 小孩站起來離開座位去伸展，他不在鏡頭前面。完整理由見函式內 `'break'` 那段
 * 註解與 `enterBreak()`。
 *
 * Task 22c 用同一個問題回答了 `'lab'`（ThresholdLab 姿態閾值量測畫面）：**ON**。
 * 量測的人正對著鏡頭一次一次調整坐姿、看著畫面上的取樣數往上跳，他當然看得到
 * 也預期得到鏡頭正在運作——這個畫面的全部內容就是「現在鏡頭看到的你」的統計。
 * 注意判準問的**不是**「這個畫面有沒有 in-flight 的非同步呼叫」（ThresholdLab
 * 確實有一條自己的 rAF 迴圈在跑 inference.step()，但那是實作細節，會隨重構
 * 改變），問的是使用者的預期。
 *
 * ---
 *
 * 【分任務校準】流程從「校準 → 選任務」改成「選任務 → 校準」之後，這個函式
 * **一行都沒有改**——但這不是「不用管」，是重新問過一次之後答案相同，所以
 * 把問過的結果寫在這裡，讓下一個維護者不必再猜：
 *
 * - `'task'`（TaskSelector）：**維持 OFF**。它在新流程裡的位置從「校準完之後」
 *   換到了「校準之前」，但畫面內容一個字都沒變——四顆任務按鈕、一個時長
 *   stepper、一行隱私說明。使用者在這個畫面上看不到自己的影像，也沒有任何
 *   東西暗示鏡頭在運作；順序不是判準，「使用者看得到、也預期得到嗎」才是。
 *   （反過來說也成立：如果為了「反正等一下就要校準」而讓它先開著，就是拿
 *   實作方便去換掉這個 App 唯一在賣的那件事。）
 * - `'calibrate'`（CalibrationWizard）：**維持 ON**。畫面左半邊就是鏡像預覽，
 *   小孩正照著它坐好。這一格跟順序完全無關。
 *
 * 真正改變的只有「哪一個畫面接在哪一個畫面後面」，而那件事這個函式從來不看
 * ——它只看**當下**是哪一個畫面。這正是第 5 輪把判準集中到這裡的用意：轉場
 * 順序可以改，鏡頭紅線不必跟著重新推導一次。
 */
function cameraShouldBeEnabled() {
  // App 在背景時一律 OFF（第 6 輪）：這條擺在最前面，因為它蓋過所有畫面。
  // 之所以要進判準、而不是只留在 onHidden() 裡當一行 setEnabled(false)：
  // 判準是 syncCameraAsync() 在 await 之後重新比對的那個東西，而「使用者在
  // getUserMedia 還沒落地時切到別的 App」正是那段空窗裡最可能發生的事——
  // 判準不認得背景，落地後就會把鏡頭在背景打開（onHidden() 那行早就跑完了，
  // 不會再有人來關）。
  if (document.visibilityState === 'hidden') return false
  // Task 20：'break'（休息回合）刻意**不**列進來，而且這是本工項對「休息的
  // 時候鏡頭該不該開」這個問題的正式答案：**不該開**。用上面那句話問一次就
  // 知道——「這個畫面上的使用者，看得到、也預期得到鏡頭正在運作嗎？」休息
  // 回合整個畫面在叫小孩站起來離開座位去伸展、看窗外、喝水，他根本不在鏡頭
  // 前面，開著三分鐘只會拍到一張空椅子跟教室裡的其他人。所以答案是否，而
  // 'break' 不進名單，setScreen('break') 自己就會把鏡頭收斂關掉——enterBreak()
  // 那裡因此也不需要（更不准）另外補一行 setEnabled(false)。
  return (state.screen === 'battle' && !state.paused)
    || state.screen === 'calibrate'
    || state.screen === 'lab'
}

/**
 * 唯一允許改 `state.screen` 的地方（store 內外都是）：改完立刻用同一個判準把
 * 鏡頭收斂成新畫面該有的樣子。
 *
 * 沒有這個收斂點，「鏡頭該不該開」就會散成一堆各自為政的 setEnabled 呼叫，
 * 而第 5 輪修的那個 blocking 問題正是這種散落的產物：`endBattle()` 記得關，
 * 但回到 calibrate 的那條路上沒有任何人記得開。與其在每一條轉場路徑上各補
 * 一次「記得開/記得關」，不如讓轉場本身就帶著收斂——新增畫面的人只要更新
 * `cameraShouldBeEnabled()`，所有轉場自動正確。
 *
 * 注意這裡用的是 `setEnabled` 而不是 `start()`/`resume()`：這是**同步層**，
 * 只處理「track 還活著、只是被關掉」這個維度。stream 整個被 `stop()` 掉的
 * 情況救不回來（`setEnabled` 打在 `null` 上落空），那是下面
 * `syncCameraAsync()` 的工作。
 */
function setScreen(next) {
  state.screen = next
  camera?.setEnabled(cameraShouldBeEnabled())
}

/**
 * 落地收斂：任何一個「可能把鏡頭打開」的 await 結束之後，都要呼叫這個函式，
 * 用**當下**的判準（不是自己出發時的那個）把鏡頭調整回該有的樣子。
 *
 * 為什麼不是單純 `camera.setEnabled(cameraShouldBeEnabled())`：判準說 OFF 時
 * 還要再分一種情況——**App 已經在背景**。那條 stream 是在「沒有人要它」的
 * 世界裡才誕生的（使用者在 getUserMedia 還沒落地時就切走了），留著它等於
 * 在背景掛著一條 track 跟一個 `videoEl.srcObject`：iPadOS 對這種 track 會不會
 * 熄指示燈是我們驗不到的事（見報告的真機門檻），而且我們根本不知道使用者
 * 什麼時候會回來。整條放掉才是誠實的做法——這跟 `cameraCapture.open()` 自己
 * 「世代過期就把剛拿到的 stream stop() 掉」是同一條規則，只是判斷的依據從
 * 「cameraCapture 的世代」換成「這個 App 現在到底要不要鏡頭」。
 *
 * 前景時（暫停中、結算畫面……）維持只 `setEnabled(false)`：track 留著才有
 * 「按繼續立刻回來、不必重新要權限」這條快路，那是這個設計從第 2 輪就在
 * 保護的東西。
 */
function convergeCameraAfterAwait() {
  if (!camera) return
  if (cameraShouldBeEnabled()) { camera.setEnabled(true); return }
  if (document.visibilityState === 'hidden') camera.stop()
  else camera.setEnabled(false)
}

/**
 * 鏡頭生命週期世代號（第 7 輪：由 `pauseGen` 與 `cameraSyncGen` 合併而來）。
 *
 * 合併的理由是複審的 IN-1 證明的：兩套計數器守著同一份資源
 * （camera + `state.cameraHealthy` + wakeLock）卻**彼此不作廢**——
 * `togglePause()` 不動 `cameraSyncGen`，`onVisible()` 不動 `pauseGen`，於是
 * 一個過期的 `syncCameraAsync()` 落地時「自己的世代沒變」，就把
 * `cameraHealthy` 寫成過期的 `false`，整場計分凍結。修掉第八個分身而留著
 * 兩套，第九個只是時間問題。
 *
 * 規則只有兩條：
 * 1. **每一個會改變「鏡頭該做什麼」的入口都遞增它**（`bumpCamGen()` 的呼叫點：
 *    `togglePause` 的兩個分支、`enterCalibration`、`enterTaskSelect`、
 *    `enterLab`／`leaveLab`、`enterBreak`／`leaveBreak`、
 *    `startBattle`、`endBattle`、`teardown`、`onHidden`、`onVisible`、
 *    `handlePageHide`）。
 *    `setCalibration` 不在名單上，因為【分任務校準】之後它已經不再改畫面
 *    （見該方法的說明）——它現在純粹是 `state.profile` 的 setter，不改變
 *    「鏡頭該做什麼」，遞增世代號只會作廢別人正在飛的落地者。
 * 2. **每一個 await 落地者都比對它**，而且比對的是「現在的世界」而不是
 *    「我的世代號沒變 ⇒ 世界沒變」——後者在第 6 輪把 `visibilityState` 加進
 *    判準之後就不成立了（`onHidden()`／`onVisible()` 不走 `togglePause()`），
 *    那正是第八個分身的成因。所以鏡頭的收斂（`convergeCameraAfterAwait()`）
 *    **無條件執行**，世代號只決定「這次拿到的觀測值還能不能拿去寫狀態」。
 *
 * 注意 `frameGen` 是另一回事，沒有被合併進來：它回答的是「這一場戰鬥還是不是
 * 原來那一場」（`startBattle`／`endBattle`／`teardown` 才會動），而 `camGen`
 * 回答的是「鏡頭該做什麼變了沒」（按暫停、切背景都會動，但那兩件事都不會讓
 * 這一場戰鬥消失）。`startBattle()` 兩個都要用，正是因為它要分辨「使用者在
 * 空窗裡按了暫停」（這一場還在，照常排 rAF）跟「使用者按了結束」（這一場沒
 * 了，什麼都不該做）。
 */
let camGen = 0
function bumpCamGen() {
  camGen += 1
  return camGen
}

/**
 * 非同步收斂層。
 *
 * ## 為什麼是兩層，而不是一層
 *
 * 下一個維護者看到 `setScreen()` 跟這裡各收斂一次，第一反應會是「這不是重複
 * 嗎」，然後把其中一個拿掉。先回答：**「鏡頭該不該開」只有一個答案**——
 * 兩層讀的是同一個 `cameraShouldBeEnabled()`，沒有第二套真相。分歧只在
 * 「怎麼開」，因為「鏡頭沒開」有兩個獨立的失效維度：
 *
 * | 失效維度 | 誰造成的 | 怎麼修 |
 * | --- | --- | --- |
 * | (a) `track.enabled` 被關掉，track 還活著 | 暫停／`endBattle()`／`onHidden()` | `setEnabled(true)`，**同步** |
 * | (b) stream 整個被 `stop()` 掉 | `pagehide`（iOS PWA 進背景）／`teardown()` | 只有 `getUserMedia` 重來，**必然 async** |
 *
 * `setScreen()` 是同步函式，只能處理 (a)。把 (b) 塞進去就變成同步函式裡的
 * fire-and-forget async——那正是這條線前五輪競態的根因（一個沒有人 await、
 * 沒有人比對世代的 in-flight 呼叫），controller 明確禁止，我也同意。所以
 * (b) 獨立成這個 async 函式，掛在**所有「stream 可能已經死了」的入口**：
 * `onVisible()`（背景回來）、`enterCalibration()`、`startBattle()`。
 *
 * ## await 之後一定要重新比對判準
 *
 * `camera.resume()` 在慢路上是一次完整的 `getUserMedia`，真機上數百毫秒。
 * 這段空窗裡畫面可能已經換了、使用者可能已經按了暫停、也可能又來一次
 * `visibilitychange`。所以落地後一律呼叫 `convergeCameraAfterAwait()`
 * （用**當下**的判準，不是自己出發時的那個），並且用 `camGen` 判斷自己是不是
 * 還是最新的那一次——不是的話，它拿到的 `ok` 是過期的觀測，不准回傳給呼叫端
 * 去寫 `state.cameraHealthy`（跟 N2、以及第 7 輪的 IN-1 同一個理由）。
 *
 * 這個函式**自己不遞增 `camGen`**：遞增是「入口」的責任（見 `bumpCamGen()`）。
 * 巢狀呼叫若也遞增，會把呼叫端自己的世代號一併作廢——`onVisible()`／
 * `startBattle()` 在 `await syncCameraAsync()` 之後還要用自己的世代號決定
 * 要不要繼續做記帳、WakeLock、排 rAF，那些判斷就會永遠成立不了。
 *
 * @returns {Promise<boolean|undefined>} 判準為 OFF、沒有 camera、或這次呼叫
 *   已經被更晚的一次入口取代時回傳 `undefined`（呼叫端不該拿它寫任何狀態）。
 */
async function syncCameraAsync() {
  if (!camera) return undefined
  const myGen = camGen // 讀，不遞增：見上面說明
  if (!cameraShouldBeEnabled()) {
    camera.setEnabled(false)
    return undefined
  }
  const ok = await camera.resume()
  convergeCameraAfterAwait()
  return myGen === camGen ? ok : undefined
}

function syncFsmPaused(now) {
  if (!fsm) return
  const next = !scoringAllowed()
  if (next === fsmPausedCombined) return
  fsmPausedCombined = next
  fsm.setPaused(sessionT(now), next)
}

/**
 * 全新一場戰鬥的起點：還沒收到任何一筆資料，給推論一段「重新抓穩」的緩衝期，
 * 不要一開始就用舊的（甚至是 0 的）時間戳直接判定不健康。
 *
 * 只能用在 startBattle()——這是「初始化」，不是「恢復」。暫停／背景恢復要用
 * 下面的 shiftFreshness()，不能沿用這個：這裡曾經是漏洞（審查第 2 輪 F1）。
 * `togglePause()`／`onVisible()` 原本也呼叫這個函式，把兩個時間戳無條件設成
 * `now`——包含「暫停前資料就已經過期」的情況。後果：鏡頭全程被擋住時，只要
 * 每 2 秒點一次「暫停→繼續」，新鮮度看門狗就會被免費重置一次，魔王照樣掉血，
 * 而且比原本的漏洞更容易被小孩發現（那兩顆按鈕就長在戰鬥畫面上）。
 */
function resetFreshness(now) {
  lastValidPoseAt = now
  lastValidFaceAt = now
}

/**
 * 暫停或背景期間沒有新資料進來，那是「時間流逝但沒有觀測」，不是「推論突然
 * 變健康了」。把兩個時間戳往前平移「暫停了多久」，讓 (now - lastValid*At)
 * 這個差值在暫停前後維持不變——暫停前已經過期的 track，平移後還是過期；
 * 暫停前還新鮮的，平移後也還新鮮。這樣「按暫停/繼續」這個動作本身就無法
 * 影響新鮮度判定，只有暫停期間*之外*真正進來的有效資料才算數。
 */
function shiftFreshness(now) {
  if (freshnessSuspendedAt === null) return
  const delta = now - freshnessSuspendedAt
  lastValidPoseAt += delta
  lastValidFaceAt += delta
  freshnessSuspendedAt = null
}

/**
 * 暫停時關掉三個推論 track，省電，也不用對著黑畫面／靜止畫面繼續嘗試偵測。
 *
 * object track 多一道條件（Task 22c）：打開的那一側要看 `state.objectDetectorOn`
 * ——那是「手機偵測現在到底該不該跑」的唯一真相（來源有兩個：工作人員在設定
 * 面板的明示設定 `phoneDetectEnabled`，以及自動降檔，見 `resetPerfMode()`）。
 * 少了這道條件，「展場預設關閉手機偵測」這件事會在**下一次 startBattle()／
 * 按繼續**時被這一行無聲地推翻（它本來無條件 setEnabled('object', true)），
 * 而 `state.objectDetectorOn` 還停在 false——旗標說沒在跑、實際在跑，正是
 * 這個專案反覆長出分身 bug 的那種「兩套真相」。關掉的那一側不需要條件：
 * 不管本來開著沒開著，暫停／結束時三個 track 都該關。
 */
function setInferenceTracksEnabled(enabled) {
  inference?.setEnabled('pose', enabled)
  inference?.setEnabled('face', enabled)
  inference?.setEnabled('object', enabled && state.objectDetectorOn)
}

/**
 * 把推論頻率倍率收斂成「現在這個世界該用的那一個」（複審 I-1）。
 *
 * 跟 `setInferenceTracksEnabled()` 是同一個形狀、同一個理由：倍率有**兩個**
 * 會改它的來源——自動降檔（`frame()` 的 `setScale(DOWNSHIFT_SCALE)`）與
 * `CalibrationWizard` 校準期間的暫時提頻（`setScale(3)`）——而「現在該是多少」
 * 的唯一真相是 `state.perfMode`。
 *
 * 沒有這一層的後果是複審實測到的第四個「展場輪流玩」bug：訪客 A 打到降檔 →
 * 工作人員按「換人玩」→ 訪客 B 校準 → `CalibrationWizard.restore()` 把倍率
 * 還原成它以為的 1 → 之後**每一位訪客都跑在全解析度推論**，而設定面板永遠
 * 顯示「目前是省電模式」。旗標說在省電、實際沒有，而且沒有任何畫面會告訴
 * 任何人——正是這個檔案每一輪都在修的「兩套真相」。
 *
 * 收斂點跟 track 開關完全對齊（`enterCalibration`／`enterLab`／`startBattle`）：
 * 那三個就是「接下來真的會有人去讀 inference.step()」的三個入口。
 */
function syncInferenceScale() {
  inference?.setScale(state.perfMode ? DOWNSHIFT_SCALE : 1)
}

async function frame(gen) {
  try {
    const now = performance.now()
    // DebugHud 的 rAF 間隔統計：量測本身要便宜，這裡只是一次相減與陣列
    // push/shift，跟 inference.step() 的成本比起來可以忽略。刻意量在
    // await 之前——這是「這一次 rAF 真的隔了多久」，跟這幀最後算不算數
    // （見下面的 frameGen 比對）無關。
    if (lastFrameAt) pushSample(perfSamples.raf, now - lastFrameAt)
    lastFrameAt = now
    const r = await inference.step(now)
    if (gen !== frameGen) return // 已被新的一輪取代，這一幀不算數

    if (r) {
      pushSample(perfSamples.latency, r.latencyMs)
      if (r.key === 'pose') {
        analyzer.pushPose({ t: now, metrics: r.metrics })
        if (r.metrics?.valid) lastValidPoseAt = now
      } else if (r.key === 'face') {
        analyzer.pushFace({ t: now, metrics: r.metrics })
        if (r.metrics?.valid) lastValidFaceAt = now
      } else {
        state.phoneVisible = Boolean(r.metrics.phoneVisible)
      }
    }

    const health = inference.health()
    // object track 卡住到一定次數，陳舊的 phoneVisible 讀數就不可信了——保守側
    // 是當作「沒有手機」，不要讓一個卡死的 true 一路累加 distractionDurationMs
    // 或觸發本來不存在的陷阱（C2 的同類問題：陳舊布林值繼續參與計分）。
    if (health.object.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD) state.phoneVisible = false

    if (!state.paused) {
      // 單向緊急降檔：只看推論延遲 EMA，刻意不看 rAF 掉幀率（見 perfMonitor.js
      // 檔頭說明）。放在 `!state.paused` 裡面是必要的，不是巧合——暫停時三個
      // track 都被關掉（setInferenceTracksEnabled(false)），latencyEma 會凍結
      // 在暫停前的最後一個值；如果 perf.sample() 在暫停中仍持續拿真實時間去
      // 累計「超標了多久」，會把「使用者按了暫停」誤判成「延遲持續超標」，
      // 單純暫停久一點就能無中生有觸發一次降檔。
      //
      // Task 16 park 的 F2（Task 22c 補完這份紀錄）：這個 `!state.paused` 保護
      // 的**不只**降檔判斷那一件事。把它拿掉（改成 `if (true)`）跑全套，紅的
      // 是**三條**測試（複審覆核過同一個數字）：
      //   1. `togglePause() 暫停時 elapsedMs 不推進；恢復後正常推進`
      //      ——失敗在「恢復後」那一半（expected 2500 to be greater than 2500）
      //   2. `Task 16：暫停中即使延遲持續超標，也不會被算進降檔的 10 秒視窗`
      //   3. `Task 16：延遲 EMA 持續超標 10 秒後觸發單向降檔…`
      // 根因相同、不是巧合：這個區塊裡除了
      // perf.sample()，還有健康度收斂（inferenceHealthy／inferenceStuck）會被
      // 一起跳過——暫停中沒有任何新資料進來，卻仍拿真實時間去算新鮮度，會把
      // 「暫停」判成「推論壞掉」，接著 scoringAllowed() 連鎖失效，恢復之後
      // 計分也跟著不對。一句話：**暫停中不該跑這整段邏輯**，不是只有降檔。
      // 下一個維護者要縮小這個 if 的範圍時，請先知道它在保護兩件事。
      state.latencyEma = inference.latencyEma()
      if (perf.sample(state.latencyEma, now) === 'downshift') {
        inference.setScale(DOWNSHIFT_SCALE)
        inference.setEnabled('object', false)
        state.perfMode = true
        state.objectDetectorOn = false
        state.phoneVisible = false // 關掉偵測後殘留的 true 會讓陷阱一直掛著
      }

      const healthy = computeInferenceHealthy(health, now, lastValidPoseAt, lastValidFaceAt)
      if (healthy !== state.inferenceHealthy) {
        state.inferenceHealthy = healthy
        unhealthySince = healthy ? null : now
      }
      state.inferenceStuck = !state.inferenceHealthy && unhealthySince !== null
        && (now - unhealthySince >= INFERENCE_STUCK_MS)
    }
    syncFsmPaused(now)

    if (fsm) {
      if (scoringAllowed()) {
        const e = analyzer.evaluate(now)
        state.posture = e.posture
        state.drowsy = e.drowsy
        const events = fsm.tick({
          t: sessionT(now), posture: e.posture, drowsy: e.drowsy, phoneVisible: state.phoneVisible,
        })
        state.battle = fsm.snapshot()
        emit(events)
      }

      if (state.battle?.ended) {
        rafId = 0
        await api.endBattle('completed')
        return
      }
    }

    rafId = requestAnimationFrame(() => frame(gen))
  } catch (error) {
    // 任何一個環節（推論、analyzer、fsm.tick、事件消費者的兜底之外的意外）丟出
    // 未預期例外，都不該讓 rAF 的遞迴排程鏈斷掉——斷掉的症狀是「畫面還在、
    // 但魔王血量不動、時間不走、沒有任何訊息」，而正式 bundle 把 console 拔掉
    // 之後連 unhandled rejection 都看不到，使用者/評審完全沒有線索。這裡兜底：
    // 記下錯誤名稱（隱私紅線，不留 message/stack），照樣排下一幀。
    if (gen !== frameGen) return
    state.loopError = error?.name ?? 'Error'
    rafId = requestAnimationFrame(() => frame(gen))
  }
}

async function onVisible() {
  const now = performance.now()
  // 審查第 6 輪（controller 裁決）：這裡原本開頭就是 `if (state.paused) return`，
  // 後面接一個**無條件**的 `await camera.resume()`——也就是說鏡頭要不要開，
  // 在這條入口上完全不看 `state.screen`，唯一的守門員是 `state.paused`，
  // 正是第 4 輪自己認定「離開戰鬥畫面就沒有意義」的那個旗標。兩個方向都錯：
  // - 結算畫面（`paused=false`）被按 home 再回來 → 重新跑一次 getUserMedia，
  //   綠色指示燈在「開始」畫面上亮起來，而且不會自我修復（隱私紅線）。
  // - 暫停中結束、`paused` 停在 true 的情況下進背景（`pagehide` 把 stream
  //   整個 stop 掉）→ 回前景時這裡早退，沒有人重開 → 下一位訪客的校準畫面
  //   拿到一條死掉的 track，而且沒有任何復原路徑（暫停/繼續只長在戰鬥畫面）。
  //
  // 修法：**鏡頭衛生無條件執行**（交給 syncCameraAsync()，判準自己會回答
  // 「battle + paused 要關」這件事），`paused` 只保留它真正該保護的東西——
  // fsm 的「離開」記帳與 WakeLock（I3/I4 要保的是計分公平：暫停後離開不該
  // 被扣分，不是讓鏡頭在背景亮著）。
  //
  // F6：新鮮度平移要在任何 await 之前做完，不然若剛好有一幀 frame() 落在
  // 「await camera.resume() 尚未完成」跟「這裡執行完畢」之間，那一幀會用還沒
  // 平移過的（陳舊）時間戳算出 inferenceHealthy=false，畫面閃一下「推論暫時
  // 不穩定」才在下一幀自己恢復——雖然不會卡住，但沒有必要讓它閃這一下。
  // 可見性變了 ＝「鏡頭該做什麼」變了：作廢所有還在飛的落地者（第 7 輪）。
  const myGen = bumpCamGen()
  if (!state.paused) shiftFreshness(now)
  // iOS 從背景回來後語音佇列可能卡死，無條件清一次
  window.speechSynthesis?.cancel?.()
  // fsm 的「回來了」要在任何 await **之前**就記上去（第 7 輪修正）。理由跟 F6
  // 把 shiftFreshness 提前是同一類，但後果嚴重得多：`notifyVisible()` 必須跟
  // `onHidden()` 的 `notifyHidden()` 嚴格配對，配對一旦斷掉，fsm 就永遠停在
  // 「離開中」——elapsedMs 凍結、魔王不掉血，而且按暫停/繼續也救不回來。
  // 第 6 輪把它放在 `await syncCameraAsync()` 之後、又擋在 `if (state.paused)
  // return` 跟世代比對後面，於是「回前景之後、鏡頭還沒重開完成之前按了暫停」
  // 或「空窗中世界變了」都會把這次配對吃掉。這件事跟鏡頭無關，也跟世代無關：
  // App 真的回到前景了，就是真的回來了。
  if (!state.paused && fsm) {
    fsm.notifyVisible(sessionT(now))
    state.battle = fsm.snapshot()
  }
  const ok = await syncCameraAsync()
  // 以下都是「這次呼叫拿到的觀測值」與「該不該持有喚醒鎖」，過期就別做。
  if (myGen !== camGen) return
  if (ok !== undefined) state.cameraHealthy = ok
  // 暫停中（含上一場殘留的 paused）到此為止：鏡頭已經收斂成判準說的樣子，
  // 但暫停中不該持有喚醒鎖（I3/I4 保的是這件事）。
  if (state.paused || !fsm) return
  await wakeLock.request() // 隱藏時被系統釋放了，一定要重新取得
  // 拿鎖的過程中又切走／按暫停／按結束：不能讓螢幕停在「已取得喚醒鎖」。
  if (myGen !== camGen) wakeLock.release()
}

function onHidden() {
  const now = performance.now()
  // 崩潰保險（task-17）：跟 handlePageHide() 同一個理由，排在這個函式最前面、
  // 不受下面 paused／世代任何條件影響——`visibilitychange` 之後 iOS 隨時可能
  // 進一步把頁面凍結，這是本函式唯一「不做就會遺失資料」的一步。包進 try：
  // 複審第 1 輪 F7——`buildRecord()`/`fsm.snapshot()` 今天是純物件組裝，理論上
  // 不會丟例外，但萬一丟了，不能讓下面的 `bumpCamGen()`/`camera?.setEnabled()`
  // 跟著被跳過——T10 第 6 輪 Blocking-2 的結論是「鏡頭衛生必須無條件執行」，
  // 這裡不該在紅線路徑上開一個不必要的口子。
  if (fsm) {
    try {
      writeCrumb(buildRecord(fsm.snapshot(), state, 'in_progress'))
    } catch { /* 鏡頭衛生不能因為崩潰保險本身出錯而被跳過 */ }
  }
  // 同上：可見性變了就作廢所有還在飛的落地者。這一行是第八個分身那條路徑上
  // 「事後補的一道」——真正的修法是落地者自己重新看世界，不是靠這裡。
  bumpCamGen()
  // 見 onVisible() 的說明：鏡頭衛生無條件執行——App 進到背景，不管哪個畫面、
  // 不管暫停與否，鏡頭一律關掉。原本這行被擋在 `if (state.paused) return`
  // 後面，等於「暫停中切到背景」時鏡頭還留在上一個狀態。
  // 寫成判準而不是寫死 false：`document.visibilityState` 此時已經是 'hidden'，
  // 判準自己就會回答 false——這裡要的是「跟所有其他收斂點同一個答案」，
  // 不是「這一行自己決定關」。
  camera?.setEnabled(cameraShouldBeEnabled())
  // 以下才是 I3/I4 真正要保護的東西：暫停中離開不該被算成一次「離開」
  // （吃 away 陷阱、扣分、魔王回血），也不該去動已經放掉的 WakeLock。
  if (state.paused) return
  freshnessSuspendedAt = now
  wakeLock.release()
  window.speechSynthesis?.cancel?.()
  if (fsm) {
    fsm.notifyHidden(sessionT(now))
    state.battle = fsm.snapshot()
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') onHidden()
  else onVisible()
}

function handlePageHide() {
  // 崩潰保險（task-17，見 storageService.js 檔頭）：iOS 可能在這個 handler
  // 執行完之前就把頁面凍結——writeCrumb 是同步的 localStorage 寫入，排在最前面
  // 才寫得進去。下面兩行（停鏡頭、放開 wakeLock）不是「不做就會遺失資料」的
  // 操作，排在後面沒關係。包進 try 的理由同 onHidden()（複審第 1 輪 F7）。
  if (fsm) {
    try {
      writeCrumb(buildRecord(fsm.snapshot(), state, 'in_progress'))
    } catch { /* 鏡頭衛生不能因為崩潰保險本身出錯而被跳過 */ }
  }
  // stream 被整個停掉 ＝「鏡頭該做什麼」的世界變了（第 7 輪）。
  bumpCamGen()
  camera?.stop()
  wakeLock.release()
}

/**
 * 「換人玩之後的第一場，不要去撈歷史」（Task 22c，controller 裁決 3）。
 *
 * ## 問題
 *
 * `startNewVisitor()` 清掉了記憶體裡的 `history`／`lastRecord`，但那還不夠：
 * `endBattle()` 會用 `listSessions(60)` 從 IndexedDB **整批刷新** `history`，
 * 而 IndexedDB 裡仍然有上一位訪客的紀錄。於是新訪客打完第一場，結算頁的
 * `buildSummary()` 就會走「跟上一次比」那條分支——對一個八歲小孩說「你比上次
 * 退步了」，而那個「上次」是陌生人的成績。
 *
 * ## 這個旗標做什麼
 *
 * 只影響**換人之後的第一場**：那一場結束時不呼叫 `listSessions()`，讓
 * `state.history` 維持空陣列，`buildSummary()` 的 `priorHistory.length === 0`
 * 自然退回冷啟動分支（「讀不到／不該讀的歷史，就跟沒有歷史一樣對待」——跟
 * `listSessions()` 失敗時必須清空 history 是同一條規則）。旗標用完就清掉，
 * 第二場之後恢復正常，那時候「上一次」真的是他自己。
 *
 * ## 這是症狀緩解，不是根治
 *
 * 根治需要 `storageService` 有「這是誰的場次」這個維度（例如每位訪客一個
 * session 群組 id，`listSessions()` 只撈同一群組），那是 schema 層級的改動。
 * 這裡刻意不做，也刻意**不刪除任何資料**：展場上「換人玩」是一顆小孩碰得到
 * 的按鈕，不該讓它做不可逆的刪除；要真的清空，設定面板裡那顆有二次確認的
 * 「清除所有本地紀錄」才是入口。
 *
 * 已知殘留（寫下來，不要讓下一個維護者以為這裡處理完了）：IndexedDB 裡
 * 仍然混著所有訪客的紀錄，所以新訪客的**第二場**開始，「跟上一次比」比的
 * 會是他自己（對的），但更長的趨勢統計仍然混著別人的資料。
 */
let skipHistoryOnce = false

// 「開始」按鈕按下之後、boot() 完成之前的那個 in-flight promise（第 6 輪）。
// 見 api.boot() 上方的說明。
let bootInFlight = null

async function bootOnce(videoEl) {
  // 這三個 await（reconcile() 的 IndexedDB 補寫、getUserMedia 的權限對話框、
  // MediaPipe 模型下載）加起來是整個 App 最長的一段空窗，好幾秒。這段期間
  // 唯一可能發生的世界變化是 App 被卸載（開始畫面上沒有別的按鈕；
  // startBattle/endBattle 都還不可能被呼叫），而 teardown() 會讓 frameGen
  // 前進——所以拿它當「我還在不在」的判斷依據，在三個 await 之前就先擷取。
  // 第 7 輪做「每一個 await 落地後比對了什麼」那張表時補的：少了它，卸載之後
  // 落地的 boot() 會把 state.booted 設回 true、把事件監聽器再掛一次，而鏡頭
  // 早就被 teardown() 停掉了——下次掛載時 boot() 會因為 booted 早退，直接
  // 進到一台關掉的鏡頭前面（跟第 5 輪那個 blocking 同一個形狀）。
  const myFrameGen = frameGen
  // task-17：崩潰復原不需要鏡頭，排在 camera.start() 之前——早退
  // （api.boot() 的 `if (state.booted) return`）之後、鏡頭初始化之前，兩者都
  // 不綁在一起。reconcile() 失敗（例如私密瀏覽封鎖 IndexedDB）不該連鏡頭都
  // 開不了：這個功能是錦上添花的崩潰復原，不是開賽門檻，這裡放棄這一次補完，
  // 不阻塞接下來真正要緊的鏡頭/推論初始化——但複審第 1 輪 F2 指出空 catch
  // 會把 TypeError 這種程式錯誤跟「IndexedDB 被封鎖」這種環境錯誤混在一起、
  // 靜默到連 dist 拿掉 console 之後都看不到，所以照 frame() 的既有先例留下
  // 一個只留 error.name 的訊號（隱私紅線：不留 message/stack）。
  await reconcile().catch((error) => { state.storageError = error?.name ?? 'Error' })
  if (myFrameGen !== frameGen) {
    // teardown() 在 reconcile() 這段空窗裡發生過：App 已經卸載，不該再開鏡頭。
    return { ok: false, error: new Error('Superseded by teardown') }
  }
  camera = createCameraCapture({
    videoEl,
    onEnded: () => { state.cameraHealthy = false },
  })
  const cam = await camera.start()
  // 隱私紅線（複審 I-2）：這裡原本存的是**整顆原始 Error**（message + stack
  // 俱全），是全 store 唯一的例外——其他五條錯誤路徑都在捕捉當下就收斂成
  // `error.name`（frame loopError、reconcile、saveSession、listSessions，
  // 以及 OfflineWarmup／ThresholdLab 那兩個元件）。`state` 會經 `readonly()`
  // 暴露給每一個元件的 `s.bootError`，所以「今天沒有 template 讀它」不是理由：
  // 複審實測在 App.vue 兜底畫面加一行 `{{ s.bootError?.message }}` ＋
  // `:title="s.bootError?.stack"`，666/666 全綠——護欄看不見這條路。
  // 收斂成 name 之後，那條攻擊連可洩漏的東西都不存在了。
  // `return` 的 `{ error }` 保留原始物件：那是函式回傳值、不是長期持有的
  // reactive state，而 PermissionGate 只讀 `.name`（PermissionGate.vue:84）。
  if (!cam.ok) { state.bootError = cam.error?.name ?? 'Error'; return { ok: false, error: cam.error } }

  inference = createInferenceService({ videoEl })
  const init = await inference.init()
  if (!init.ok) {
    // 模型載不到就用不到鏡頭了——不關掉的話 iPad 的鏡頭指示燈會繼續亮著，
    // 對一個把「鏡頭只在該用的時候開」當賣點的 App 是說不過去的畫面（I1）。
    camera.stop()
    // 同上：只留 error.name，不留 message/stack（複審 I-2）。
    state.bootError = init.error?.name ?? 'Error'
    return { ok: false, error: init.error }
  }

  if (myFrameGen !== frameGen) {
    // teardown() 在這段空窗裡發生過：App 已經卸載，什麼都不該接手。
    camera.stop()
    return { ok: false, error: new Error('Superseded by teardown') }
  }

  // 手機偵測的初始狀態（Task 22c 第 4 項）：展場預設關閉，見 state.phoneDetectEnabled
  // 上方的完整理由。這一行是 objectDetectorOn 這個「現在到底有沒有在跑」的旗標
  // 唯一的初始化點——inferenceScheduler 建構時每個 track 都是 enabled:true，
  // 不主動關掉的話，預設值就只是寫在 state 裡好看的一句話。
  inference.setEnabled('object', state.phoneDetectEnabled)
  state.objectDetectorOn = state.phoneDetectEnabled

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', handlePageHide)

  // 只在這裡呼叫一次：boot() 因 state.booted 早退時不會重跑到這裡，跟
  // camera.start()／inference.init() 是同一批「只做一次」的初始化。第一次
  // getVoices() 在 iPad 上幾乎必定回空陣列，所以這裡先讀一次目前的結果，
  // 真正的中文語音多半要等下面這個 callback 由 voiceschanged 觸發才會更新。
  voice.init(() => { state.voiceAvailable = voice.isAvailable() })
  state.voiceAvailable = voice.isAvailable()

  state.booted = true
  state.bootError = null
  // 權限剛拿到，`camera.start()` 留下的是一條 live + enabled 的 track，但畫面
  // 還停在權限說明頁——「鏡頭該不該開」在這裡一樣由判準回答。少了這行，
  // `permission` 畫面就是窮舉表上唯一一格「判準說 OFF、實際是 ON」的例外，
  // 而例外正是這條線每一輪都在長分身的地方。
  //
  // 【分任務校準】之後下一個動作是 `enterTaskSelect()`（選任務），判準對它
  // 一樣是 OFF，所以這條 track 會維持 live 但 disabled，一路到使用者選完任務、
  // `enterCalibration()` 才把它打開——那是這個 App 第一次真的需要鏡頭的時刻。
  // 中間這段（權限 → 選任務）鏡頭指示燈不會亮，這是刻意的，不是漏掉。
  camera.setEnabled(cameraShouldBeEnabled())
  return { ok: true }
}

function buildRecord(s, st, reason) {
  const endedAt = Date.now()
  return {
    id: `s-${endedAt}`,
    startedAt: endedAt - s.elapsedMs,
    endedAt,
    durationMs: s.elapsedMs,
    status: reason === 'completed' ? 'completed' : 'in_progress',
    taskType: st.taskType,
    postureDurationMs: s.postureDurationMs,
    distractionDurationMs: s.distractionDurationMs,
    trapCount: s.trapCount,
    attacks: s.attacks,
    score: s.score,
    bossHpRemaining: s.bossHp,
    bossHpMax: s.bossHpMax,
    phase2Damage: s.phase2Damage,
    result: s.result ?? 'timeout',
    demoMode: st.demoMode,
  }
}

const api = {
  state: readonly(state),
  rawState: state,

  /**
   * 審查第 6 輪：`boot()` 原本完全沒有 in-flight 防護。空窗不是幾毫秒——是
   * 鏡頭權限對話框＋`inference.init()` 載 MediaPipe 的好幾秒，而「開始」按鈕
   * 全程既沒有 disabled、文字也不變。第二次呼叫會直接覆寫模組變數 `camera`，
   * 第一個 capture 拿到的 stream **沒有任何人持有參照**：它不會被
   * `setScreen()` 收斂（那個 camera 已經不是 `camera` 了）、不會被
   * `teardown()` 停掉，是一條永遠關不掉的 live + enabled track——跟第 4 輪
   * 認定為 Critical 的那條紅線是同一條。
   *
   * 修法是 in-flight promise 快取，不是世代號：世代號只能讓晚到的那次「放棄
   * 寫狀態」，救不回已經被建立出來的第二個 stream；這裡要的是「第二下按鈕
   * 根本不該建立第二個 capture」，那就是共用同一個 promise。
   *
   * 注意這**不是**動 `state.booted` 早退（第 3 輪判定風險最高的邊界，因為
   * 那個早退同時擋著 `inference.init()`，重跑會重建 MediaPipe task）——
   * 早退維持原樣，這裡只多擋「已經開始、還沒完成」這個狀態。
   */
  boot(videoEl) {
    if (state.booted) return Promise.resolve({ ok: true })
    if (bootInFlight) return bootInFlight
    bootInFlight = bootOnce(videoEl).finally(() => { bootInFlight = null })
    return bootInFlight
  },

  inference: () => inference,
  camera: () => camera,
  copy: () => copy,
  voice: () => voice,
  /**
   * 純讀取，跟 inference()/camera() 是同一類、既有的用法——DebugHud 拿去顯示，
   * 不影響 wakeLock 的生命週期。
   *
   * 為什麼要有這個：全專案掃過一輪，`wakeLock.isActive()` 從 Task 開始
   * 就存在，但**沒有任何畫面讀過它**。展場最怕的狀況是打到一半螢幕自己
   * 暗掉——iPad 切到背景會自動釋放 Wake Lock，回前景要重新申請
   * （見 wakeLock.js 檔頭），這段轉場本身很細，總審也抓到過一次
   * 「結算頁的喚醒鎖沒放掉」的問題。如果哪天它悄悄請求失敗（例如
   * `navigator.wakeLock` 不存在、或某次 request() 被系統拒絕），
   * 工作人員在這之前完全看不出來——螢幕暗掉才是第一個徵兆，而那時候
   * 已經來不及了。
   */
  wakeLockActive: () => wakeLock.isActive(),

  toggleVoice() {
    const next = !state.voiceEnabled
    voice.setEnabled(next)
    state.voiceEnabled = next
  },

  /**
   * 必須由 click handler 直接呼叫，中間不得插入任何 await——見 App.vue 的
   * onTaskChosen()。這是唯一一次「開始討伐」等同於使用者手勢的機會：
   * TaskSelector 的按鈕是同步 emit，一旦這行前面有 await，就已經脫離手勢的
   * 同步呼叫堆疊，iOS 之後每一次 speak() 都會被靜默忽略。
   *
   * 【分任務校準】重新推導過一次，結論是**位置不變**，理由寫下來免得下一個
   * 維護者又得自己推一遍：
   *
   * 1. iOS 的規則是「**第一次** speak() 有沒有落在使用者手勢的同步呼叫堆疊
   *    內」，不是「speak() 跟手勢隔了多久」。`primeFromGesture()` 當場就
   *    speak 掉那一次（見 voiceFeedback.js），所以只要它自己還在手勢堆疊裡，
   *    解鎖就已經完成了。
   * 2. 它仍然在同一顆按鈕的同步 handler 第一行——新流程只改了那顆按鈕**之後**
   *    要去哪裡（以前直接開打，現在先去校準），完全沒有動到 handler 的前半段。
   * 3. 新流程在解鎖與第一句真正的台詞之間插進了一段校準（最少 5 秒）。這段
   *    時間**不影響**解鎖：解鎖是 speechSynthesis 這個實例層級的一次性狀態，
   *    不會因為隔了幾秒就失效；而校準畫面本身不 speak()，不會消耗掉什麼。
   *
   * 反過來說，如果哪天有人把暖機搬到 CalibrationWizard 的「開始校準」按鈕上，
   * 那顆按鈕同樣是使用者手勢、同樣成立——但**不要**搬到 `@done` 那條路上：
   * 校準完成是計時器自己走完 5 秒觸發的，不是任何一次點擊，整場就會無聲。
   */
  primeVoiceFromGesture() {
    voice.primeFromGesture()
  },

  /**
   * 從隱私說明頁（'privacy'）進入「即將要求鏡頭權限」的說明頁（'permission'，
   * PermissionGate 接手）。
   *
   * Task 19：這一步發生在 `boot()` 之前——鏡頭什麼都還沒開始，`camera` 這時
   * 甚至還是 `null`。之所以還是要透過 `setScreen()` 而不是讓 App.vue 直接寫
   * `session.rawState.screen = 'permission'`，不是因為這一步本身有鏡頭副作用
   * 要收斂（`cameraShouldBeEnabled()` 對 `'privacy'` 與 `'permission'` 都回傳
   * false——兩者都只是說明頁，使用者看不到、也不預期鏡頭在運作，見該函式的
   * 窮舉規則），而是**不允許任何畫面轉場繞過這個唯一入口**：這條線在這個專案
   * 已經因為「例外」長出過至少八個分身（見 `camGen` 上方說明），今天多寫一次
   * `session.rawState.screen = ...` 看起來無害，只是因為此刻沒有 camera，
   * 但下一個維護者複製貼上這個寫法去改別的轉場時，可不會記得檢查這件事。
   */
  enterPermission() {
    setScreen('permission')
  },

  /**
   * 進入任務設定畫面（TaskSelector）。
   *
   * 【分任務校準】新增：流程從「隱私 → 權限 → 校準 → 選任務 → 戰鬥」改成
   * 「隱私 → 權限 → **選任務** → **校準** → 戰鬥」之後，`'task'` 變成
   * 「權限拿到之後的第一個畫面」，需要一個自己的入口。
   *
   * ## 為什麼順序要反過來（這個方法存在的根本理由）
   *
   * 校準量的是耳朵相對於肩膀的高度（`poseGeometry.js` 的 `neckRatio`）。
   * **抬頭看螢幕跟低頭寫作業，這個數字差很多**，而寫作業／看書／背單字三者
   * 的頭部角度也各不相同（作業本平放在桌面、書攤開在桌上、單字卡拿在手上）。
   * 舊流程在校準當下還不知道等一下要做什麼，所以 `CalibrationWizard` 只能給
   * 一句對三種任務都成立的話；反過來之後，那個畫面讀得到 `state.taskType`，
   * 可以給「那個任務真實會有的姿勢」。基準值對了，整場的姿態判定才有意義。
   *
   * ## 為什麼是 store 方法而不是 App.vue 直寫
   *
   * 跟 `enterPermission()` 逐字相同的理由：`cameraShouldBeEnabled()` 對
   * `'task'` 回傳 false，這一步今天確實沒有鏡頭副作用要收斂——但
   * **不允許任何畫面轉場繞過 `setScreen()`** 這條規則沒有例外，因為下一個
   * 維護者複製貼上這個寫法去改別的轉場時，不會記得檢查這件事。
   *
   * ## 它不做什麼（刻意的）
   *
   * 不碰推論 track、不碰倍率、不做非同步的 stream 收斂。任務畫面上沒有任何
   * 東西在讀 `inference.step()`（全 codebase 只有 battle／calibrate／lab 三個
   * 讀者），而 stream 死掉的情況由下一步的 `enterCalibration()` 負責救——
   * 那才是「接下來真的會有人用鏡頭」的那個入口。在這裡先做一次只是多一個
   * 之後必須有人記得維護的地方。
   */
  enterTaskSelect() {
    setScreen('task')
    // 這個方法自己沒有 await，但它改變了「鏡頭該做什麼」——還在飛的落地者
    // 不該再拿自己出發時的觀測值去寫 state.cameraHealthy（規則見 bumpCamGen()）。
    bumpCamGen()
  },

  /**
   * 從結算頁（StatsDashboard）回到任務選擇畫面（App.vue 的「回主畫面」按鈕）。
   *
   * 【分任務校準】起只是 `enterTaskSelect()` 的**薄包裝**，不再自己寫一套
   * `setScreen('task')`：兩個方法各自維護一份「進任務畫面要做什麼」就是兩套
   * 真相，而這個檔案每一輪審查修的都是這件事（先例：`toggleObjectDetector()`
   * 之於 `setPhoneDetectEnabled()`）。
   *
   * 保留這個名字而不是讓呼叫端直接改叫 `enterTaskSelect()`：它是
   * `StatsDashboard` 的「回主畫面」語意，`App.stats.test.js` 也是對著這個名字
   * 鎖住「不得直寫 rawState.screen」那條呼叫點護欄（Ruling DK）。
   */
  backToTaskSelect() {
    api.enterTaskSelect()
  },

  /**
   * 進入校準（【分任務校準】後：使用者在 TaskSelector 按下「開始討伐」之後，
   * 由 App.vue 的 onTaskChosen() 在 `setTask()` 之後呼叫）。
   *
   * 這個方法存在的唯一理由是讓這條轉場也走判準：原本 App.vue 是直接寫
   * `session.rawState.screen = 'calibrate'`，繞過了所有收斂——而第二位訪客
   * 之後的每一場都會走這條路（`boot()` 因 `state.booted` 早退，不會重新開
   * 鏡頭），那正是第 5 輪修的 blocking 問題的發生地點。
   *
   * 順序反轉之後它的**呼叫時機**變了（從「權限拿到之後立刻」變成「選完任務
   * 之後」），但它要做的事一件都沒少，而且每一件都變得**更**必要，因為
   * 「校準」在新流程裡是每一位訪客、每一次換任務都會重新走一次的畫面：
   * 重新打開 pose track、收斂倍率、必要時重新 getUserMedia（見下面三段）。
   *
   * 兩層都要走：`setScreen()` 同步把 `enabled` 收斂好（track 還活著的常見
   * 情況，零延遲），`syncCameraAsync()` 再處理 stream 已經被 `pagehide`
   * 停掉的情況（第 6 輪 Blocking-2：上一位暫停中離開 → 下一位按結束 →
   * 進背景 → 回前景 → 按開始，這條路上 stream 是死的）。
   */
  async enterCalibration() {
    setScreen('calibrate')
    // Task 22c（Ruling DY 的連帶修正）：這一行不是新功能，是「換人玩」把
    // 『結算之後再回到校準』這條路變成可達之後才暴露出來的既有漏洞。
    // `endBattle()` 會 `setInferenceTracksEnabled(false)` 把三個 track 全部
    // 關掉，而 CalibrationWizard.begin() 只做 setScale(3) 跟關掉 face／object
    // ——**從來沒有人重新打開 pose**。少了這一行，第二位訪客的校準會在一個
    // 永遠拿不到 pose 結果的世界裡跑滿 5 秒，然後說「取樣不足」，按「再試
    // 一次」也一樣，而且沒有任何錯誤訊息（跟第二位訪客黑畫面、第二位訪客
    // 跑在別人基準值上是同一個家族：展場是輪流玩的，流程卻是照一個人從頭
    // 玩到尾設計的）。object track 由旗標決定開不開，見該函式的說明。
    setInferenceTracksEnabled(true)
    syncInferenceScale()
    const myGen = bumpCamGen() // 畫面變了 ＝「鏡頭該做什麼」變了
    const ok = await syncCameraAsync()
    if (myGen !== camGen) return // 空窗中畫面又變了／切到背景了：這個 ok 是過期的觀測
    if (ok !== undefined) state.cameraHealthy = ok
  },

  /**
   * 「換人玩」（Ruling DY）：展場輪到下一位訪客時，從結算畫面或工作人員設定
   * 面板重跑校準。
   *
   * 為什麼非做不可：`setScreen('calibrate')` 全專案唯一的呼叫點是
   * `enterCalibration()`，而在這個方法出現之前，它唯一的呼叫點是 App.vue 的
   * `onGranted()`——只有 PermissionGate 發 `@granted` 時才會觸發，也就是整個
   * PWA 生命週期裡的**第一位訪客**。校準基準是身高、坐姿、鏡頭距離的函式，
   * 換一個小孩就不成立，症狀是「整場一直說他駝背」或「整場都不反應」，而且
   * 不會有任何錯誤訊息。
   *
   * ## 【分任務校準】：終點從 `'calibrate'` 改成 `'task'`（判斷與理由）
   *
   * 順序反轉之後，這個方法不能再直接跳進校準，理由有三，第三個是決定性的：
   *
   * 1. **新訪客要自己選任務。** 上一位選的是「寫作業 15 分鐘」，下一位可能是
   *    來看書的。沿用前一位的 `taskType`／`durationMin` 跟沿用前一位的校準
   *    基準是同一種錯——都是「把別人的設定當成他的」，也都不會有錯誤訊息。
   *    （這裡刻意**不**去重設 `state.taskType`／`durationMin` 成預設值：
   *    TaskSelector 自己有一組預設值、而且使用者馬上就要在那個畫面上選，
   *    在這裡先清一次只是多一個沒有人看得到的中間狀態。）
   * 2. **校準現在依賴任務類型。** 校準畫面要針對「寫作業／看書／背單字／
   *    自己選」給不同的姿勢指示，先跳進校準就等於拿上一位訪客的任務去指示
   *    這一位——正是這一輪要修掉的那個問題本身。
   * 3. **重新校準的保證沒有變弱。** 換成 `'task'` 之後，這個方法看起來不再
   *    「直接」保證重新校準，但 `'task'` 畫面只有一個出口：TaskSelector 的
   *    「開始討伐」→ `onTaskChosen()` → `enterCalibration()`。也就是說新訪客
   *    **一定**會走過校準，沒有任何一條路能從任務畫面直接跳進戰鬥。
   *    （這一點有測試鎖著，見 session.test.js 的「換人玩之後仍然一定會重新
   *    校準」與 App.taskSelector.test.js 的 onTaskChosen 呼叫點護欄。）
   *
   * 轉場一律走既有的 store 方法（這裡是 `enterTaskSelect()`），不自己寫第二套
   * （`setScreen()` 是 `state.screen` 的唯一寫入者，這條規則沒有例外）。
   *
   * ## 為什麼要清掉 `history` 與 `lastRecord`（判斷與理由）
   *
   * 清，但要知道它解決了什麼、沒解決什麼：
   *
   * - **有解決**：上一位訪客的成績不會再被這台 iPad 的任何畫面拿去顯示或
   *   運算。`lastRecord` 是結算畫面的資料來源、也是 `needsBreakAfter()` 的
   *   輸入（「這一輪坐了 20 分鐘，先休息」——那是**上一個小孩**坐的 20 分鐘）；
   *   `history` 是「跟上一次比」那句話的來源。換人之後，兩者都是別人的資料，
   *   留著只會讓畫面對新的訪客說一件不是他的事。這跟 `listSessions()` 失敗時
   *   必須把 `state.history` 清空是同一條理由：**讀不到／不該讀的歷史，就要
   *   跟沒有歷史一樣對待**，不能退回去撿殘留值。
   * - **沒有解決**（誠實記錄，不要讓下一個維護者以為這裡已經處理完了）：
   *   `endBattle()` 會用 `listSessions(60)` 從 IndexedDB 整批刷新 `history`，
   *   而 IndexedDB 裡**仍然有**上一位訪客的紀錄。所以新訪客打完第一場之後，
   *   結算頁的「跟上一次比」比的還是別人的成績。真正的修法需要 storageService
   *   有「這是誰的場次」這個維度（不是這個工項的檔案，也不該由一顆展場上
   *   小孩碰得到的按鈕去做不可逆的刪除）。今天工作人員手上唯一乾淨的做法，
   *   是設定面板裡那顆有二次確認的「清除所有本地紀錄」。
   *
   * 刻意**不**清 `state.profile`：下一步就是校準，`setCalibration()` 一定會
   * 覆寫它；在這裡先清成 null 只會讓「校準畫面中途被關掉」那個（今天不可達的）
   * 狀態多一種空指標形狀，不會讓任何人更安全。
   */
  startNewVisitor() {
    state.history = []
    state.lastRecord = null
    // 見 skipHistoryOnce 上方的完整說明（controller 裁決 3）：光是清掉記憶體
    // 裡這兩個欄位還不夠——這一位訪客打完第一場時，endBattle() 會用
    // listSessions(60) 把**上一位的紀錄**整批撈回來，結算頁就會對他說
    // 「跟上一次比」，而那個「上一次」是陌生人。
    skipHistoryOnce = true
    api.enterTaskSelect()
  },

  /**
   * 進入姿態閾值量測畫面（ThresholdLab，Task 22c 第 B 項）。
   *
   * 這個畫面是交付門檻本身：`postureProfiles.js` 的四個閾值目前是沒人量過的
   * 佔位值，而這個元件是把它們換成真值的唯一執行路徑。入口在工作人員設定
   * 面板（展前架設時用），不需要在展場中途進得去。
   *
   * 跟 `enterCalibration()` 同一個形狀，而且理由逐條相同：
   * 1. `setScreen('lab')` — 轉場的唯一入口，鏡頭由判準自己收斂（'lab' 已經
   *    列進 `cameraShouldBeEnabled()`，見那裡的說明）。
   * 2. `setInferenceTracksEnabled(true)` — 量測畫面讀的是 `inference.step()`
   *    的 pose 結果；從結算流程走進來時三個 track 都被 `endBattle()` 關掉了，
   *    少了這行，取樣數會永遠停在 0，而操作者手上沒有 devtools（正式 bundle
   *    連 console 都被拔掉），只會以為「還在暖機」然後一直等下去。
   * 3. 非同步層 — 上一位訪客把 iPad 交出去、螢幕鎖過（pagehide 會整條
   *    `camera.stop()`）之後，同步的 `setEnabled` 會打在一條死掉的 track 上
   *    落空；`syncCameraAsync()` 是唯一會重新 `getUserMedia` 的那一層。
   */
  async enterLab() {
    setScreen('lab')
    setInferenceTracksEnabled(true)
    syncInferenceScale()
    const myGen = bumpCamGen()
    const ok = await syncCameraAsync()
    if (myGen !== camGen) return
    if (ok !== undefined) state.cameraHealthy = ok
  },

  /**
   * 離開量測畫面。回 `'task'`（任務設定畫面）——那是設定面板被打開的地方，
   * 也是工作人員回到「可以把 iPad 交給下一個小孩」那個狀態的畫面。
   * 鏡頭由 `setScreen('task')` 依判準關掉，這裡不另外補一行 setEnabled(false)
   * （那是兩套真相，跟 `backToTaskSelect()` 同一條規則）。
   *
   * 推論 track 刻意不在這裡關掉：離開量測畫面之後沒有任何 rAF 迴圈會呼叫
   * `inference.step()`（迴圈只長在 battle／calibrate／lab 三個畫面上），開著
   * 的 track 不會產生任何工作量；而 `startBattle()` 一定會重新收斂一次。
   * 多一行「記得關」只會多一個之後必須有人記得維護的地方。
   */
  leaveLab() {
    // 【分任務校準】：改成走 `enterTaskSelect()` 而不是自己再寫一次
    // `setScreen('task')` + `bumpCamGen()`。行為完全相同（那個方法就是這兩行），
    // 但「進任務畫面要做什麼」從此只有一個地方在回答——這個檔案每一輪審查
    // 修的都是同一件事：同一件事有兩個來源，遲早會不一致。
    api.enterTaskSelect()
  },

  /**
   * 進入休息回合（Task 20）。**兩個入口共用這一個方法**：
   *
   *   A) 戰鬥中判定瞌睡 → CoachBanner 的「休息一下」。此時 `fsm` 存在，
   *      這一場**還在跑**。
   *   B) 結算頁的長時段（≥20 分鐘）→「休息一下再來」。此時 `fsm` 已經是
   *      null（endBattle() 清掉了），沒有進行中的戰鬥。
   *
   * 入口 A 一定要先把這一場**暫停**、而不是把它丟掉：小孩去伸展三分鐘回來，
   * 要回到**同一場**、同一個魔王血量、同一份計分——休息完直接
   * `startBattle()` 會開新的一場，這一場的進度整個蒸發。暫停一律走既有的
   * `togglePause()`（它會一併處理新鮮度懸置、推論 track、WakeLock、鏡頭），
   * 這裡不另外重寫一套暫停語意。已經在暫停中就不再 toggle 一次——那會變成
   * 「按休息反而繼續」。
   *
   * 鏡頭：休息回合**不該開鏡頭**，理由與完整推導見 cameraShouldBeEnabled()
   * 裡 'break' 那段註解。答案由判準回答，`setScreen('break')` 自己會收斂，
   * 這裡刻意不補第二套真相（那是第 5 輪特地拿掉的東西）。
   */
  async enterBreak() {
    if (fsm && !state.paused) await api.togglePause()
    setScreen('break')
    // 畫面變了 ＝「鏡頭該做什麼」變了（bumpCamGen() 的規則 1）。跟
    // setCalibration()／backToTaskSelect() 同一個理由：這個方法自己沒有
    // await，但還在飛的落地者不該再拿出發時的觀測值去寫 state.cameraHealthy。
    bumpCamGen()
  },

  /**
   * 離開休息回合。**兩個入口要兩種出口**，這是這個方法存在的全部理由：
   *
   *   A) 從戰鬥中進來的（`fsm` 還活著）→ 回到**同一場**，並恢復暫停。
   *   B) 從結算頁進來的（`fsm` 是 null）→ 這裡什麼都不做，回傳 false，
   *      由呼叫端（App.vue 的 onBreakDone）去開新的一場。
   *
   * 順序很敏感，兩件事都不能倒過來：
   *
   * 1. `setScreen('battle')` 要在恢復暫停**之前**。判準是
   *    `screen === 'battle' && !paused`，兩個條件都成立才會開鏡頭；先恢復
   *    暫停的話，`togglePause()` 的 `convergeCameraAfterAwait()` 會在 screen
   *    還是 'break' 的世界裡落地，把它剛拿到的 stream 又關掉（在背景時甚至
   *    整條 stop() 掉）。反過來則是安全的：`setScreen('battle')` 當下還在
   *    暫停中，判準說 OFF，什麼都不會被打開，等 `togglePause()` 恢復暫停
   *    時才真正打開。
   * 2. 恢復暫停一定要走 `togglePause()`，不能只把 `state.paused` 設回
   *    false、也不能只 `setEnabled(true)`。休息三分鐘，小孩把 iPad 放在桌上
   *    站起來——**螢幕會自動鎖定，iOS 發 pagehide，handlePageHide() 已經把
   *    整條 stream `camera.stop()` 掉了**。`setEnabled` 打在一條 ended 的
   *    track（或 null）上完全落空；只有 `togglePause()` 恢復分支的
   *    `camera.resume()` 會在 track 已死時整個 `start()` 重來、重新
   *    `getUserMedia`。這就是非同步收斂層存在的理由（見 syncCameraAsync()
   *    上方那張 (a)/(b) 失效維度表：休息回合踩的是 (b)）。
   *
   * `if (state.paused)` 這個保護今天不可達（enterBreak() 在 fsm 存在時一定
   * 讓它停在暫停狀態，休息畫面上也沒有任何暫停/繼續按鈕），留著是因為少了它
   * 的話，萬一哪天真的在未暫停狀態下走到這裡，`togglePause()` 會把這一場
   * **暫停**——症狀是「休息完回到戰鬥，畫面都在但魔王一滴血都不掉」，正是
   * 這個專案最難查的那一類失效。
   *
   * @returns {Promise<boolean>} true＝已經回到原本那一場（暫停也恢復了，
   *   呼叫端不必再做任何事）；false＝沒有進行中的戰鬥，呼叫端要自己開新的
   *   一場（`startBattle()`，它會自己走 setScreen('battle')）。
   */
  async leaveBreak() {
    if (!fsm) return false
    setScreen('battle')
    bumpCamGen()
    if (state.paused) await api.togglePause()
    return true
  },

  /**
   * 存下校準基準。**只做這一件事**——它不再改畫面。
   *
   * 【分任務校準】之前這裡是 `setScreen('task')`：校準完成 → 回任務設定畫面
   * → 使用者再按一次「開始討伐」才開打。順序反轉之後那條路不存在了（任務
   * 在校準**之前**就選好了），校準完成的下一步就是開打，而「開打」有自己的
   * 入口 `startBattle()`（它會 `setScreen('battle')`、重置整場狀態、開推論
   * track、必要時重開鏡頭、排 rAF）。
   *
   * ## 為什麼不在這裡直接 `await api.startBattle()`
   *
   * 試過，而且是刻意否決的：
   *
   * - `setCalibration()` 會變成一個「設定一個欄位，順便開始一整場戰鬥」的
   *   方法。全專案有七個測試檔把它當成單純的 profile setter 在鋪設狀態，
   *   那些地方會全部變成「不小心開了一場戰鬥」——而且症狀是安靜的（多一條
   *   rAF 迴圈、多一次 WakeLock）。
   * - 真正需要保證的是**順序**：`startBattle()` 讀 `state.profile` 去建
   *   analyzer，所以 profile 一定要先寫好。把兩者放在 App.vue 的同一個
   *   `@done` handler 裡（中間沒有 await）已經完全保證了這件事。
   * - 而「App.vue 有沒有真的接著開打」這件事，護欄裝在**呼叫點**
   *   （`App.taskSelector.test.js` 對 onCalibrated 的 spy 斷言），不是裝在
   *   store 方法裡——Ruling DK：這個專案已經連續兩次把護欄裝錯層。
   *
   * 少了畫面轉換，這個方法也就不再改變「鏡頭該做什麼」，所以**不呼叫**
   * `bumpCamGen()`（見該函式規則 1：遞增是「入口」的責任，這裡已經不是入口，
   * 多遞增一次只會把別人正在飛的落地者無故作廢）。
   */
  setCalibration(profile) {
    state.profile = profile
  },

  setTask({ taskType, durationMin, demoMode }) {
    state.taskType = taskType
    state.durationMin = durationMin
    state.demoMode = Boolean(demoMode)
  },

  async startBattle() {
    // 每一場新的讀書 session 都必須重置 CopyEngine：repeatCount／cooldown／shuffle bag
    // 不重置的話會跨場次延續，第二輪一開始（repeat 早就超過 CAUSE_FORMAT_LIMIT）就會
    // 跳過因果說明，直接講簡化版指令——小孩不會知道自己這次為什麼被打。
    copy.resetSession()
    // DebugHud 的「累計輪數」：跟 perf（見上方說明）不同類——這只是一個計數器，
    // 沒有「歸零」的問題，每開一場新戰鬥就該加一，不需要 reset。
    perfSamples.rounds += 1

    analyzer = createPoseAnalyzer({ baseline: state.profile, profile: profileFor(state.taskType) })
    fsm = createFocusStateMachine({ durationMs: durationMs(), demoMode: state.demoMode })
    fsmPausedCombined = false
    state.battle = fsm.snapshot()
    state.paused = false
    state.inferenceHealthy = true
    state.inferenceStuck = false
    state.loopError = null
    // task-17 F2：跟 loopError 一起歸零——上一輪儲存失敗的殘留訊息不該
    // 帶進下一輪，讓畫面（未來如果接上）誤以為這一輪也有問題。
    state.storageError = null
    // task-18 複審第 1 輪 F1：historyError 跟 storageError 同一個先例、同時歸零——
    // 兩者都是「上一輪儲存層面的殘留錯誤」，不歸零的話舊訊息會帶進這一輪。
    state.historyError = null
    // task-18：state.history 刻意不在這裡歸零，跟上面幾個「跨場次必須歸零」
    // 的欄位不是同一類問題。那幾個（phoneVisible／cameraHealthy）殘留會讓
    // 新的一場「安靜地」算錯分或卡住計分——是會影響這一輪判準的活躍狀態。
    // history 只是結算頁（screen==='stats'）拿來畫「跟上一次比」的展示用
    // 資料，battle／task/calibrate 畫面完全不讀它；就算帶著上一場的舊資料
    // 進到這一場，也不會被顯示或拿去做任何判斷——它會在這一場結束時被
    // endBattle() 的 listSessions(60) 整批換掉（見該處），沒有機會被誤讀。
    unhealthySince = null
    // 跨場次殘留的 phoneVisible 是真實漏洞（C2）：object track 只有 0.33fps，
    // 上一場最後一次讀到的值可能一路帶進下一場，讓小孩收起手機才開新的一場，
    // 卻在幾秒內被開一個根本不存在的手機陷阱。新的一場，畫面上什麼都還沒發生，
    // 一律視為「沒有手機」。
    state.phoneVisible = false
    // 跨場次殘留的 cameraHealthy 是跟 C2 同一類問題（F3）：上一場如果鏡頭被系統
    // 收走過，這個布林會卡在 false，而 App.vue 完全沒有分支顯示它——後果是新的
    // 一場從頭到尾 elapsedMs 停在 0、魔王一滴血不掉，畫面上卻一個字都不會出現
    // （因為 inferenceHealthy 本身完全正常，inferenceStuck 也永遠不會被觸發）。
    state.cameraHealthy = true
    // 同步層：setScreen() 會把鏡頭打開（battle 畫面在未暫停時就是「該開」）。
    // 第二場之所以能正常計分，靠的就是這一次收斂——不是這裡另外補一行
    // setEnabled。
    setScreen('battle')
    // 讓任何還卡在 await 的舊呼叫落地時發現自己已經過期（N1 的同一防線）。
    // 這一行是**深度防禦**，目前不可達：經由 UI 走到 startBattle() 一定先經過
    // endBattle()（或是第一次開場，那時根本還沒有人按過暫停），而 endBattle()
    // 已經讓 camGen 前進過了——所以拿掉它今天不會有任何測試變紅。留著的理由
    // 跟 frameGen 在這裡也遞增一次相同：startBattle() 是「這一場的起點」這個
    // 語意上的邊界，任何屬於上一場的 in-flight 呼叫在這裡就該全部作廢，不該
    // 依賴「呼叫者一定先經過 endBattle()」這個外部慣例。未來若多一條直接開新
    // 場的路徑（例如 stats 畫面的「再玩一次」不經過 endBattle()），少了這行
    // 就是活的 bug。
    const myCamGen = bumpCamGen()
    // 這一場的身分證（第 7 輪）：只有 startBattle／endBattle／teardown 會動它。
    // 下面兩個 await 落地時要靠它分辨兩件完全不同的事——「使用者在空窗裡按了
    // 暫停」（camGen 變了、frameGen 沒變 → 這一場還在，照常排 rAF，只是不能
    // 拿 WakeLock）跟「使用者按了結束」（frameGen 也變了 → 這一場已經不存在，
    // 什麼都不該做）。第 6 輪這裡沒有任何比對，所以空窗中按「結束」會讓
    // endBattle() 剛放掉的 WakeLock 被重新取回（而且之後沒有人會再 release），
    // 還會留下一條 fsm===null 的 rAF 迴圈永遠跑 inference.step()。
    frameGen += 1
    const myFrameGen = frameGen
    cancelAnimationFrame(rafId)
    rafId = 0
    // 推論 track 要在 await 之前打開：放在 await 之後的話，空窗中按「暫停」
    // 的使用者會在落地時被重新打開三個 track（X8-b）。
    setInferenceTracksEnabled(true)
    syncInferenceScale()

    // 非同步層：進戰鬥之前那幾個畫面（【分任務校準】之後是任務設定 → 校準）
    // 期間如果 App 進過背景（pagehide 會整個 stop() 掉 stream），上面那次
    // setEnabled 會打在 null 上落空，開場就是一台死掉的鏡頭。這裡是進戰鬥前
    // 最後一次補救的機會。
    const camOk = await syncCameraAsync()
    if (myFrameGen !== frameGen) return // 這一場已經被結束／被新的一場取代
    if (camOk !== undefined) state.cameraHealthy = camOk
    // battleStartAt 一定要在 await 之後才取：真機上 getUserMedia 可能花掉好幾
    // 百毫秒甚至幾秒，先取的話第一幀的 dt 會一口氣跳過那段時間，等於白送一段
    // 「坐姿完美」的計分。
    battleStartAt = performance.now()
    resetFreshness(battleStartAt) // 還沒收到任何一筆資料，不能立刻判定不健康
    freshnessSuspendedAt = null // 不該帶著上一場遺留的暫停/背景懸置狀態進新的一場

    if (myCamGen === camGen) {
      // 沒有人在空窗裡按暫停／切背景，才輪得到拿 WakeLock。
      await wakeLock.request()
      if (myFrameGen !== frameGen || myCamGen !== camGen) wakeLock.release()
    }
    if (myFrameGen !== frameGen) return
    rafId = requestAnimationFrame(() => frame(myFrameGen))
  },

  /**
   * 刻意不在這裡呼叫 speechSynthesis.cancel()：跟 onHidden()／onVisible()／
   * endBattle()／teardown() 那四處不同，暫停是使用者可能一秒內就按「繼續」
   * 復原的操作，而語音一句最長 15 字（voiceFeedback.js 的 MAX_CHARS），
   * 正常語速一兩秒內就會自然念完——硬生生切斷反而更突兀。真正需要打斷的
   * 是「使用者已經離開／再也聽不到現在這句話有沒有意義」的情境（切背景、
   * 結束、卸載），那幾處已經有既有的 cancel 呼叫在處理。
   */
  async togglePause() {
    const now = performance.now()
    state.paused = !state.paused
    // 世代號要在 state.paused 翻面之後才取：它代表的是「這次呼叫出發時，
    // 鏡頭該做什麼」的那個世界。
    const myGen = bumpCamGen()
    setInferenceTracksEnabled(!state.paused) // 暫停時推論沒有存在的意義，順便省電（見說明）

    if (state.paused) {
      freshnessSuspendedAt = now // 見 shiftFreshness()：記下懸置起點，resume 時往前平移
      // 走判準而不是寫死 false（第 7 輪）：方向上兩者恆等（暫停中判準必定是
      // OFF），但「沒有任何一行自己決定鏡頭該不該開」這條結構規則不該有例外
      // ——例外正是這條線每一輪長分身的地方。
      camera?.setEnabled(cameraShouldBeEnabled())
      syncFsmPaused(now)
      wakeLock.release()
      return
    }

    shiftFreshness(now) // F1：不能用 resetFreshness() 把暫停/繼續變成免費的看門狗重置鈕
    // F2：暫停恢復要走 resume()，不能只 setEnabled(true)——iOS Safari PWA 被系統
    // 暫停時會發 pagehide，handlePageHide() 會呼叫 camera.stop() 把 stream 整個
    // 關掉；純 setEnabled 救不回一個已經 stop() 的 stream，會讓「暫停→切到別的
    // App→回來→按繼續」這輪從此再也無法計分。resume() 已經處理好兩種情況：
    // track 還活著就 enable+play，track 已經死了就整個 start() 重來。
    const ok = await camera?.resume()

    // ★ 第七輪（第八個分身）：收斂**無條件執行，而且擺在世代比對之前**。
    //
    // 第 6 輪這裡是 `if (myGen !== pauseGen) { 收斂; return }`——收斂只長在
    // 「世代不符」那條路上，等於假設「我的世代號沒變 ⇒ 世界沒變」。那個等式在
    // 第 3～5 輪是成立的（判準只有 screen + paused，兩者必然伴隨 pauseGen 遞增），
    // 但第 6 輪把 visibilityState 加進判準之後就破了：onHidden() 不動 pauseGen。
    // 實測路徑：暫停 → 交出 iPad（pagehide，stream 死掉）→ 拿回來 → 按「繼續」
    // （resume() 走 getUserMedia 慢路，真機數百毫秒）→ 空窗中使用者又切走
    // （鎖屏／控制中心／分割視窗，iOS 這些只發 visibilitychange，不發 pagehide）
    // → 新 track 落地預設 enabled=true、srcObject 也掛上了，而世代相符所以
    // 什麼都不收斂 → App 在背景、鏡頭 live 且 enabled、不會自我修復。
    // 合併成 camGen 之後 onHidden() 也會讓世代前進，但那只是「剛好又補了一道」
    // ——真正的規則是：**落地就重新看現在的世界，不要問自己的世代號**。
    // 收斂細節（背景時整條 stop 掉、前景時只 disable）見
    // convergeCameraAfterAwait()。
    convergeCameraAfterAwait()

    // 世代號剩下的唯一職責：判斷「這次呼叫拿到的觀測值還能不能拿去寫狀態」。
    // 對不上代表這次呼叫已經被更晚的一次入口取代（再按一次、按結束、開新場、
    // 切背景、卸載），它手上的 ok／now 都是舊資訊：
    //   1. state.cameraHealthy = ok ...... 過期的觀測（N2；第 7 輪 IN-1 證明了
    //      兩套計數器時這裡會被過期的 syncCameraAsync 寫成 false、整場凍結）。
    //   2. syncFsmPaused(now) ............ now 是出發時的時間，拿去算 sessionT()
    //      已經不準；endBattle() 之後 fsm 是 null，本來也沒東西該被同步。
    //   3. await wakeLock.request() ...... 使用者可能已經改按暫停／結束／切走，
    //      三者都不該持有喚醒鎖（下面第二個檢查負責把遲到的那個放掉）。
    if (myGen !== camGen) return

    if (ok !== undefined) state.cameraHealthy = ok
    syncFsmPaused(now)
    await wakeLock.request()
    if (myGen !== camGen) {
      // 這段 await 期間又被取代了——不能讓 WakeLock 停留在「已取得」，暫停中
      // 或背景中螢幕不該一直亮著白耗電（跟上面是同一個根因的輕量分身）。
      wakeLock.release()
    }
  },

  undoTrap(trapId) {
    const ok = fsm?.undoTrap(trapId) ?? false
    if (ok) state.battle = fsm.snapshot()
    return ok
  },

  /**
   * 手動開關手機（ObjectDetector）偵測。展場手機到處都是、誤判率天生偏高，
   * 這顆開關給工作人員視現場狀況決定要不要打開。
   *
   * `state.phoneDetectEnabled` 是**使用者的明示設定**，`state.objectDetectorOn`
   * 是**現在到底有沒有在跑**（降檔也會改寫它）。兩者在這裡一起寫：使用者按了
   * 開關，那一刻兩件事必定一致，而且「誰後動誰算數」。
   *
   * 關掉時一定要同時把 `state.phoneVisible` 歸零，理由跟 `frame()` 裡
   * `health.object.consecutiveFailures >= 門檻` 以及降檔那兩處完全相同：
   * **關掉偵測之後殘留的 `true` 會讓手機陷阱一直掛著**，小孩把手機收起來也
   * 解不掉（object track 已經不跑了，沒有人會把它改回 false）。這是既有程式碼
   * 已經踩過兩次的坑，這裡是第三次寫下同一條規則。
   */
  setPhoneDetectEnabled(on) {
    const next = Boolean(on)
    state.phoneDetectEnabled = next
    inference?.setEnabled('object', next)
    state.objectDetectorOn = next
    if (!next) state.phoneVisible = false
  },

  /**
   * 保留原本的切換式 API（Task 16 加的），但只是 setPhoneDetectEnabled() 的
   * 薄包裝：兩個方法各自維護自己那一半狀態的話，就會出現「用 toggle 關掉、
   * 設定面板卻顯示開著」這種兩套真相——這個檔案每一輪審查修的都是這件事。
   */
  toggleObjectDetector() {
    api.setPhoneDetectEnabled(!state.phoneDetectEnabled)
  },

  /**
   * 手動解除效能降檔（Ruling CR）。降檔本身是**自動發生、畫面上沒有主動提示**
   * 的單向操作（見 perf 變數上方說明），所以一定要有一條人為的復原路徑，
   * 否則一台在展場中午過熱降過一次檔的 iPad，會用省電模式撐完整個下午。
   *
   * 降檔當時做了**兩件**事（見 frame() 裡 'downshift' 那段）：`setScale(0.5)`
   * 與 `setEnabled('object', false)`。復原就要把兩件都還原——只還原一半會留下
   * 一台「速度回來了、但手機偵測永遠關著」的裝置，而且畫面上不會有任何線索
   * 指向這裡（`state.perfMode` 已經是 false，設定面板的那顆按鈕還會變成
   * disabled，連再按一次都不行）。
   *
   * object track 的復原值是 `state.phoneDetectEnabled` 而不是寫死的 true：
   * 兩個真相來源打架時（工作人員明示關掉手機偵測 vs. 自動降檔也把它關掉），
   * **使用者的明示設定優先**。復原降檔不該順手打開一個工作人員刻意關掉的功能。
   */
  resetPerfMode() {
    perf.reset()
    state.perfMode = false
    syncInferenceScale() // 倍率的唯一真相是 state.perfMode（剛剛才設成 false）
    const on = state.phoneDetectEnabled
    inference?.setEnabled('object', on)
    state.objectDetectorOn = on
    if (!on) state.phoneVisible = false
  },

  /**
   * 設定面板每次打開時，把上一次「清除所有本地紀錄」留下的結果字樣收回 'idle'。
   *
   * 'error' 殘留最嚴重：面板一打開就顯示「清除失敗，請再試」，而這一次根本
   * 什麼都還沒做——那是畫面對工作人員說的一句假話。'done' 殘留也不該留著，
   * 它看起來像是「剛剛才清完」的即時回饋。
   */
  resetClearState() {
    state.clearState = 'idle'
  },

  /**
   * 清除這台裝置上所有本地紀錄（設定面板裡唯一不可逆的操作，元件那一側已經
   * 有二次確認對話框）。
   *
   * 三件事一定要做對：
   * 1. **失敗必須是 'error'，不得靜默當成功**。IndexedDB 在私密瀏覽／儲存
   *    空間政策下會直接 reject，而家長會以為資料已經刪乾淨了。這個專案已經
   *    吃過一次「兩種失敗共用一個旗標、結算畫面對使用者說謊」的虧。
   * 2. **`state.history` 要跟著清空**。`clearAll()` 清的是 IndexedDB 與
   *    localStorage 的 crumb，記憶體裡這份是結算頁「跟上一次比」的資料來源
   *    ——不清的話，畫面還會拿一筆使用者剛剛要求刪掉的資料去講比較。跟
   *    `listSessions()` 失敗時必須 `state.history = []` 是同一條理由。
   * 3. `state.lastRecord` 同理（結算頁顯示的那一筆、也是 `needsBreakAfter()`
   *    的輸入），一起清成 null。
   *
   * 只留 `error.name`（隱私紅線：不留 message/stack），跟 loopError／
   * storageError 的既有先例一致。不另外寫 `state.storageError`：那個欄位講的
   * 是「這一輪有沒有存起來」，跟「清除有沒有成功」是兩件事，共用會讓結算頁
   * 講錯話（見 historyError 上方那段同型修正）。
   */
  async clearAllLocalData() {
    state.clearState = 'busy'
    try {
      await clearAll()
      state.history = []
      state.lastRecord = null
      state.clearState = 'done'
    } catch {
      // 刻意不另外記 error.name：這個失敗**畫面上已經看得見**（SettingsSheet
      // 讀 clearState==='error' 顯示「清除失敗，請再試」），工作人員當下就在
      // 面板前面，不需要一個沒有任何畫面在讀的第二個欄位——loopError 當初就是
      // 這樣長出來、然後三個 Task 之後才有人發現沒有畫面顯示它（見本工項 G）。
      state.clearState = 'error'
    }
  },

  /**
   * DebugHud 專用的跨輪統計快照，見 perfSamples 上方說明。刻意不放進 reactive
   * state：這些數字只有 HUD 開著才需要重新讀，讀成 reactive 會讓每一幀的
   * push 都觸發不必要的響應式追蹤成本，而 HUD 本來就已經自己用 setInterval
   * 輪詢（跟 BattleView 其他輪詢用途一致），不需要 Vue 的響應性。
   */
  perfStats: () => ({
    latencyP95: p95(perfSamples.latency),
    rafP95: p95(perfSamples.raf),
    rafMax: perfSamples.raf.length ? Math.max(...perfSamples.raf) : 0,
    rounds: perfSamples.rounds,
  }),

  /** reason: 'completed' | 'aborted' */
  async endBattle(reason) {
    if (!fsm) return state.lastRecord // 已經結束過一次了，不要把 lastRecord 洗成 null
    frameGen += 1 // 讓任何還卡在 await inference.step() 的舊一輪 frame() 醒來後直接放棄
    // 同上，讓還卡在 await 的舊 togglePause() 呼叫落地時發現這一場已經結束。
    // 跟 startBattle() 那行不同，這行是**可達且必要**的：兩顆按鈕（繼續／結束）
    // 相鄰，小孩按了「繼續」沒看到反應就改按「結束」是預設行為，空窗就是
    // videoEl.play() 的數十毫秒或 getUserMedia 的數百毫秒。少了這行，那次舊呼叫
    // 落地後會照常走完剩下的副作用，其中 `await wakeLock.request()` 會把
    // endBattle() 剛剛放掉的喚醒鎖再拿回來，而且之後沒有任何人會再放掉它——
    // 回到開始畫面後螢幕永不變暗。
    bumpCamGen()
    cancelAnimationFrame(rafId)
    rafId = 0
    const snapshot = fsm.snapshot()
    fsm = null
    fsmPausedCombined = false
    setInferenceTracksEnabled(false)
    wakeLock.release()
    window.speechSynthesis?.cancel?.()
    state.battle = snapshot
    state.lastRecord = buildRecord(snapshot, state, reason)
    // task-17：展示模式不入庫——評審試玩幾十秒的資料混進統計裡會把趨勢圖弄髒。
    // 只有真正存進 IndexedDB 成功之後才清掉 localStorage 的 crumb：saveSession()
    // 失敗（例如私密瀏覽封鎖 IndexedDB）時 crumb 是這一輪唯一還在的復原路徑，
    // 清掉的話兩邊都沒了；同時吞掉例外，不讓一次儲存失敗擋住畫面切到 stats
    // ——那才是這一輪真正要緊的事，儲存只是錦上添花。
    if (state.lastRecord && !state.lastRecord.demoMode) {
      try {
        await saveSession(state.lastRecord)
        clearCrumb()
      } catch (error) {
        // 保留 crumb（下次 boot() 的 reconcile() 還有機會補救）；複審第 1 輪
        // F2：這裡原本是空 catch，會把 keyPath 打錯字這種程式錯誤（TypeError）
        // 跟「IndexedDB 被封鎖」這種環境錯誤混在一起靜默吞掉——兩者對「這一輪
        // 是不是真的存進去了」的答案完全不同，卻連一點線索都沒留下。跟
        // frame() 的既有先例一致，只留 error.name（隱私紅線）。
        state.storageError = error?.name ?? 'Error'
      }
    }
    // task-18 複審第 1 輪 F6：listSessions() 移到 setScreen('stats') 之前呼叫
    // （原本排在之後）。理由：結算頁一掛載就會用 state.history 算 buildSummary()
    // 的分支（冷啟動 vs. 跟上次比），如果先切畫面再補歷史，小孩會先看到冷啟動
    // 版總結，下一個 tick 那句話突然被換成比較版——這對這個年齡層是會造成
    // 困惑的「畫面自己在動」。搬到前面之後，掛載當下 props.history 已經是
    // 對的，headline 不會在使用者眼前跳動。
    //
    // 成本可接受的理由：上面 saveSession() 分支（非展示模式時）已經
    // `await openDb()` 過一次，`storageService.js` 的 `openDb()` 有連線快取
    // （`dbPromise`），這裡的 `listSessions()` 不會重新觸發 `indexedDB.open()`，
    // 只是同一條連線上多一次「最近 60 筆」的 cursor 讀取——這比 saveSession()
    // 剛做過的一次 transaction 寫入更輕量。展示模式（跳過 saveSession()）時
    // 這裡才是這一輪第一次 `openDb()`，但那本來就是 endBattle() 既有的行為
    // （這裡只是把它提前，不是新增一次 DB 開啟）。
    //
    // 仍然自己包 try/catch、仍然排在 setScreen('stats') 之前完成（不是「擋住」
    // 畫面切換，是画面切换本身就在等它）——這裡的取捨是「稍微晚一點點切到
    // stats，換取切過去之後畫面不再自己變」，跟 saveSession() 那條「儲存
    // 失敗也不能擋住畫面」的取捨方向不同，因為這裡談的是幾毫秒等級的單次
    // cursor 讀取，不是可能真的卡住的網路／裝置 I/O。
    //
    // 複審第 1 輪 F1 的連帶修正：listSessions() 失敗時，除了記錄
    // state.historyError，還必須把 state.history 清空。startBattle() 刻意不
    // 歸零 history（見上方註解），所以讀取失敗若不清空，buildSummary() 會
    // 撿到上一輪殘留的舊歷史去講「跟上一次比」——只是從「一輪讀取錯誤」換成
    // 「看起來正常、其實資料是舊的」的另一種不準確。清空之後
    // buildSummary() 的 priorHistory.length===0 會自然退回冷啟動分支，這是
    // 唯一誠實的呈現方式：讀不到歷史，就跟沒有歷史一樣對待。
    if (skipHistoryOnce) {
      // 換人玩之後的第一場：連撈都不撈（見 skipHistoryOnce 上方的說明）。
      // 寫 `state.history = []` 而不是「撈了但不給比較」的理由只有一個，但那
      // 一個就夠：**只有 `state.history` 一個欄位在餵結算頁**，多一個「撈到了
      // 但不准用」的旗標就是第二套真相——未來任何一個新元件讀 `s.history`
      // 都不會知道還有第二個旗標要查。
      //
      // 這**不是**隱私措施（複審把上一版寫在這裡的第二個理由判定為不成立，
      // 說得對）：那份資料本來就在同一台 iPad 的 IndexedDB 裡，而且這一位
      // 訪客的**第二場**結束時 `endBattle()` 就會把它整批撈回記憶體。「不撈」
      // 只是讓它在這一個視窗內不進記憶體，沒有把任何東西移出可及範圍。
      skipHistoryOnce = false
      state.history = []
    } else {
      try {
        state.history = await listSessions(60)
      } catch (error) {
        state.historyError = error?.name ?? 'Error'
        state.history = []
      }
    }

    // 鏡頭由 setScreen('stats') 依判準關掉，這裡不再另外寫一行 setEnabled(false)
    // ——那一行跟判準是兩套真相，正是第 5 輪要拿掉的東西（它記得關，卻沒有
    // 任何人記得在回到 calibrate 時打開）。stats 畫面只是結算，鏡頭不該亮著。
    setScreen('stats')

    // 註：這裡不呼叫 inference.destroy()。InferenceService 的生命週期掛在
    // App／store 層，跨輪重複使用同一個實例，每輪重建會累積 GPU 記憶體並拖慢
    // 第二輪——只有 teardown()（整個 App 卸載時）才准呼叫 destroy()。
    return state.lastRecord
  },

  onBattleEvent(handler) {
    handlers.add(handler)
    return () => handlers.delete(handler)
  },

  teardown() {
    frameGen += 1
    // 第三個讓 in-flight togglePause() 作廢的點（審查第 4 輪逐一對照 await 之後
    // 的副作用時補上）：App 卸載時若剛好有一次「繼續」卡在 await，落地後會
    // 照常走完 `await wakeLock.request()`，把 teardown() 剛放掉的喚醒鎖再拿
    // 回來——而此時已經沒有任何人會再呼叫 release()。camera 那邊不需要額外
    // 處理：teardown() 的 camera.stop() 會讓 cameraCapture.js 自己的 generation
    // counter 丟棄 in-flight 的 stream，收斂時 track() 回 null，setEnabled 落空。
    bumpCamGen()
    cancelAnimationFrame(rafId)
    rafId = 0
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('pagehide', handlePageHide)
    inference?.destroy()
    camera?.stop()
    wakeLock.release()
    // 跟 onHidden()／onVisible()／endBattle() 那三處既有的
    // `window.speechSynthesis?.cancel?.()` 是同一條規則的第四個、也是最後一個
    // 補齊點：App 整個卸載時，正在念的語音沒有理由繼續念下去。這裡刻意不呼叫
    // voice.cancel()（雖然功能上等價）——維持跟既有三處一致的寫法，不建立
    // 第二種「怎麼停止語音」的表達方式。
    window.speechSynthesis?.cancel?.()
    state.booted = false
  },
}

export function useSession() {
  return api
}
