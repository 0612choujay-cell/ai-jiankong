import { FilesetResolver, PoseLandmarker, FaceLandmarker, ObjectDetector } from '@mediapipe/tasks-vision'
import { createScheduler } from './inferenceScheduler.js'
import { poseMetrics, faceMetrics } from './poseGeometry.js'

const SPECS = [{ key: 'pose', fps: 2 }, { key: 'face', fps: 3 }, { key: 'object', fps: 0.33 }]
/**
 * 「不該出現在書桌上的東西」的清單。
 *
 * 這裡原本只有 `'cell phone'` 一個標籤。實機驗收時使用者指出偵測應該涵蓋
 * 「眼球／動作／不應該出現的物品」三個面向，而前兩者程式裡都有
 * （`poseGeometry.js` 的 gaze／eyeClosed、以及駝背與脖子前伸），
 * 只有第三項實際上只看手機一種。
 *
 * 擴充不需要換模型：載的 `efficientdet_lite0` 是 COCO 訓練的，本來就認得
 * 80 類。所以這是一份清單的問題，不是能力的問題。
 *
 * ── 為什麼清單這麼短、而且刻意不收書桌上常見的東西 ──────────────
 *
 * 誤判的代價是**一個小孩在別人面前被機器指控**，而且因為「東西在畫面上就
 * 停止攻擊」這條規則（focusStateMachine.js 的攻擊條件），一次誤判的後果是
 * **整場打不到魔王**，不是幾秒鐘。所以這份清單的判準是
 * **「幾乎不可能是學習用品」**，不是「可能會分心」：
 *
 *   收：手機、遙控器
 *   不收：書、筆記型電腦、杯子、瓶子、剪刀、鍵盤、滑鼠、螢幕、玩偶
 *
 * 書跟筆電在書桌上太正常了——看書任務本來就要有書。把它們收進來，
 * 等於讓遊戲在小孩做對事情的時候扣他血。
 *
 * ── controller 裁決：拿掉 `'tv'` 與 `'teddy bear'` ──────────────
 *
 * `'tv'` 在 COCO 裡涵蓋 **tvmonitor**——也就是**任何螢幕**。這是一台放在
 * IEYI 展場的 iPad，前鏡頭對著小孩，而小孩背後是整個展場：別的隊伍的螢幕、
 * 電視牆、海報架上的顯示器。**展場背景有螢幕是必然，不是風險**，而它的後果
 * 是「魔王 15 分鐘一滴血不掉、畫面上沒有任何字」。所以它被移除，不是調門檻。
 *
 * `'teddy bear'` 同理但理由不同：這是一場**兒童**發明展，攤位上的玩偶、
 * 書包上的吊飾、甚至小孩自己帶來的娃娃都是理所當然會出現的東西——它通不過
 * 上面那條「一個認真做功課的小孩，桌上有沒有可能理所當然地出現這個東西？」
 * 的判準。清單短一點沒關係：**誤判的代價比漏抓高。**
 *
 * `'remote'` 留著，而且它的價值比字面上大：efficientdet_lite0 對「平放在桌上
 * 的長方形深色物體」很常給出 `remote` 而不是 `cell phone`——留著它其實是在
 * 補手機偵測的漏抓，而展場桌上出現真正的電視遙控器是極不可能的。
 *
 * 新增任何一個標籤前，先問同一個問題：**一個認真做功課的小孩，
 * 桌上有沒有可能理所當然地出現這個東西？** 會，就不要收。
 *
 * COCO 的標籤字串是模型定義的，不是我們能改的；拼字錯了不會有任何錯誤，
 * 只會**靜默地永遠偵測不到**——`inferenceService.test.js` 的
 * 「COCO 標籤護欄」那一組測試鎖住這份清單的每個字串都在 COCO 的 80 類裡面，
 * 並且反向鎖住學習用品與上面兩個被裁掉的標籤不得再被加回來。
 * （那條護欄在複審時被指出「宣稱存在但根本不存在」——現在它真的在了。）
 */
const DISTRACTING_LABELS = Object.freeze([
  'cell phone',
  'remote',
])
/**
 * 判定用的信心分數門檻。同時也被當成 ObjectDetector 的 `scoreThreshold`
 * 傳下去（見 init()）——這一點很重要，見下面第 3 點。
 *
 * ── feat/diag 重新評估的結論：這一輪不動 ──────────────────────
 *
 * 1. **0.45 並不是一個偏嚴的設定。** MediaPipe 官方的 ObjectDetector
 *    範例（含 web/JS 那一份）用的是 `scoreThreshold: 0.5`；0.45 已經比
 *    官方預設鬆。把「使用者完全沒偵測到」直接歸因到這個門檻太嚴，
 *    沒有依據。
 * 2. **往下調是所有可選動作裡誤判風險最高的那一個。** 清單裡的
 *    `'remote'` 之所以留著，正是因為 efficientdet_lite0 很常把
 *    「平放在桌上的長方形深色物體」叫成 remote（見 DISTRACTING_LABELS
 *    的說明）。門檻降到 0.3，鉛筆盒、計算機、深色書背都可能以 0.3x 的
 *    分數通過，而誤判一次的後果是**整場打不到魔王而且畫面上沒有解釋**。
 * 3. **這個參數把用來檢驗它的證據濾掉了。** 它同時是偵測器的地板，
 *    所以低於 0.45 的偵測結果我們從來看不到——「模型其實有認出手機，
 *    只是分數 0.32」這個假說，在現在的結構下**無法被證實也無法被否證**，
 *    調高調低都只是換一個猜。
 *
 * 已知的模型限制（承認，但不構成這一輪改它的理由）：手機被手部部分遮擋、
 * 非正面角度時，輕量模型的信心分數普遍偏低。要驗證這件事在目標機上的
 * 實際影響，正確作法是把偵測器地板與判定門檻拆開再加一個純量計數器
 * （見 DISTRACTING_MIN_AREA_RATIO 底下「下一輪要先做的事」），
 * 不是先把門檻調鬆再看看會發生什麼。
 */
const PHONE_MIN_SCORE = 0.45

/**
 * 「東西必須夠大」閘門：偵測框面積佔畫面的比例下限（controller 裁決第 2 條）。
 *
 * ── 為什麼需要它 ──────────────────────────────────────────────
 *
 * 我們要抓的是「**桌上**的東西」，不是「房間另一頭的東西」。分數門檻
 * （PHONE_MIN_SCORE）完全不區分距離：一支在三公尺外鄰桌上的手機，只要模型
 * 有信心，分數一樣會過。展場的背景是整個展場，這條閘門是唯一能把
 * 「小孩自己桌上」跟「背景」分開的訊號，而且它不犧牲手機偵測——手機在桌上時
 * 本來就很大。
 *
 * ── 0.004（0.4% 畫面面積）是怎麼來的 ────────────────────────────
 *
 * 視角面積隨距離以 1/d² 衰減，所以這條閘門本質上是一條**距離**閘門。
 * 一支手機約 0.15 × 0.07 公尺（0.0105 m²）。注意**擷取解析度不進這個算式**
 * ——面積比的分子分母同時縮放，640×480 或 1280×960 算出來是同一個數字；
 * 唯一影響結果的是**視角**與**距離**。
 *
 * ── feat/diag 重新推導（第二輪，修正上一版的兩個問題）─────────────
 *
 * 問題一：上一版列了「110°」與「60°」兩種假設並宣稱「兩種假設下都落在
 * 桌上與背景之間」，但目標機根本不可能是 60°。iPad Pro M1 的前鏡頭是
 * 12MP 超廣角，Apple 標示 122° 視角；依 Apple 慣例那是**對角線**視角，
 * 4:3 下換算成水平視角是 2·atan(0.8·tan(61°)) ≈ 110.6°——也就是說上一版
 * 「110°」那一列其實是有根據的（比它自己以為的更有根據），而「60°」那一列
 * 描述的是另一種鏡頭，留著只會讓人誤以為門檻有兩倍的安全邊際。**那一列
 * 作廢。** 取而代之的第二種假設是「122° 其實是水平視角」（可能性較低但
 * 無法排除），它比 110.6° 更廣，算出來的面積更小，是保守的那一側。
 *
 * 問題二：上一版整張表都用**正對鏡頭的完整面積**。真實情境不是這樣——
 * 平放在桌上的手機被鏡頭俯視、手拿著的手機會傾斜，投影面積要乘上
 * cos φ（φ 是手機法線與視線的夾角）。φ=45° 就少掉 29%，φ=55° 少掉 43%。
 * 這一項上一版完全沒算，而它剛好把最需要被抓到的情境往門檻下面推。
 *
 *   正對鏡頭時的面積佔比（0.0105 / (W·H)，W = 2d·tan(θh/2)、H = 0.75W）：
 *
 *   | 距離 d | 110.6°（122° 對角線） | 122°（若為水平） |
 *   |---|---|---|
 *   | 0.30m 手持近 | 1.87% | 1.20% |
 *   | 0.40m 手持   | 1.05% | 0.67% |
 *   | 0.50m 手持遠 | 0.67% | 0.43% |
 *   | 0.60m 桌面   | 0.47% | 0.30% |
 *   | 0.80m 桌緣   | 0.26% | 0.17% |
 *   | 1.00m 旁人   | 0.17% | 0.11% |
 *   | 1.50m 鄰桌   | 0.075% | 0.048% |
 *   | 3.00m 展場   | 0.019% | 0.012% |
 *
 * 使用者回報的情境是「拿手機對著鏡頭」＝手持 0.30–0.50m。把 cos φ 算進去，
 * 這個情境的**最不利角落**是「122° 水平 ＋ 0.50m ＋ 傾斜 45°」＝
 * 0.43% × 0.707 ≈ 0.30%，**低於現在的 0.4%**。也就是說：在樂觀的視角假設
 * （110.6°）下這條閘門完全放行，在保守假設下它剛好卡在門檻上。
 *
 * 反過來，必須擋掉的那一側：1.0m 的旁人在最樂觀假設下是 0.17%。
 * 於是「必須抓到」與「必須擋掉」之間的可用窗口只有 0.17% – 0.30%，
 * **寬度 1.8 倍，比我對視角假設本身的不確定性還窄。**
 *
 * ── 這一輪的變動：真機驗收回報「漏抓」，往下調 ──────────────────
 *
 * 上一輪（feat/diag）算出「必須抓到」（手持 0.30–0.50m，最不利角落）與
 * 「必須擋掉」（1.0m 旁人）之間只有 0.17%–0.30% 這個 1.8 倍寬的窄窗口，
 * 而 0.4% 剛好落在那個窗口**外側**（比必須抓到的下限還高），所以理論上
 * 就已經有落空的風險。這一輪的實機測試證實了：使用者拿著手機對鏡頭，
 * 沒有被判定為分心。這正是上面文件說「這條閘門會無聲地否決真正該抓到的
 * 那一次」的那個結果，不是巧合。
 *
 * 依照上一輪自己寫下的指示（「如果漏抓，往下調」），改成 0.0022（0.22%）：
 * 落在窄窗口的中段，比「必須抓到」的下限（0.17%）高、比上限（0.30%）低，
 * 兩邊各留安全邊際，而不是卡在窗口邊緣。這仍然是**推測**，不是量出來的——
 * 下面「下一輪要先做的事」那兩個觀測計數器仍然沒有做，一次改數字一次測，
 * 結果一樣沒辦法歸因到面積閘門還是分數閘門。但窄窗口本身代表在這個區間
 * 內挑哪個數字都是同等品質的猜測，優先修正「已經證實在漏抓」比繼續等待
 * 觀測性建完更急迫。
 *
 * ── 下一輪要先做的事（順序不能顛倒，這一輪仍然沒有做）────────────
 *
 * 先讓這條管線可觀測，再談調數字。具體是兩個純量計數器（不是類別名稱、
 * 不是分數、不是 bounding box）：
 *   (a) 命中清單裡的標籤、但被面積閘門擋下的次數
 *   (b) 命中清單裡的標籤、但被分數門檻擋下的次數
 * 有這兩個數字，一次真機測試就能同時回答兩個門檻該不該動、該動哪一個。
 * 要拿到 (b) 還得先把 ObjectDetector 的 `scoreThreshold`（偵測器的地板）
 * 跟 PHONE_MIN_SCORE（判定的門檻）拆開——現在兩者是同一個值，等於這個
 * 參數自己把用來檢驗它的證據濾掉了。這兩件事都要改核心邏輯與 health()
 * 的白名單，留給下一個能碰這個檔案的工項。
 *
 * **這個數字跟 postureProfiles.js 的閾值同一個性質：沒有人在真機上系統性
 * 量過分佈**，只有這一次「拿著手機、沒抓到」的單一觀察。真機驗收時要做的
 * 事只有一件：把手機放在桌上不同位置，確認它仍然被抓到；如果還是漏抓，
 * 繼續往下調。往上調要非常小心——往上調會直接削掉手機偵測本身。
 *
 * ── 隱私 ─────────────────────────────────────────────────────
 *
 * bounding box **只在這個檔案內部用完即丟**：算完一個面積比、跟門檻比大小，
 * 原始座標立刻失去參照。不外傳、不儲存、不寫進任何 metrics——跟 landmark
 * 與 blendshape 完全一樣的處理方式。往外走的仍然只有一個布林值。
 */
const DISTRACTING_MIN_AREA_RATIO = 0.0022

/**
 * 校準期間的推論頻率倍率。5 秒內要蒐集到足夠的 pose 取樣，所以要提頻。
 *
 * 這個數字以前寫在 `CalibrationWizard.begin()` 裡（`setScale(3)`），跟它配對的
 * 「還原」也寫在元件裡（`restore()`）——那一對就是 Blocking B1 的根因，見
 * `setCalibrationBoost()`。
 */
const CALIBRATION_SCALE = 3

/**
 * 給測試與護欄用的唯讀檢視。不在正式路徑上被讀取——正式路徑直接用上面那個
 * 常數，避免每幀多一次陣列複製。
 *
 * 讀者是 `inferenceService.test.js` 的「COCO 標籤護欄」那一組測試。
 */
export function distractingLabels() {
  return [...DISTRACTING_LABELS]
}

/**
 * 三個模型檔的路徑，唯一來源。
 *
 * export 出來給 src/core/offlineAssets.js 共用，離線暖機才不會自己手寫
 * 一份路徑清單——那份清單日後很容易跟這裡實際用到的路徑跑掉不同步。
 */
export const MODEL_ASSET_PATHS = {
  pose: '/models/pose_landmarker_lite.task',
  face: '/models/face_landmarker.task',
  object: '/models/efficientdet_lite0.tflite',
}

/**
 * 建立唯一一塊給 MediaPipe 掛 GL context 用的 canvas。
 *
 * 這裡的 Safari 版本判斷是照抄 MediaPipe 自己的邏輯（vision_bundle.mjs 的 Ph()）：
 * 它在 Safari 17 以下不信任 OffscreenCanvas，會退回 document.createElement('canvas')。
 * 我們既然要搶在它前面把 canvas 生出來，就得用同一套判準，否則在舊 Safari 上
 * 等於強迫它吃它自己判定不可靠的東西。
 *
 * 目標機（iPad Pro M1 / iPadOS 17+）走的是 OffscreenCanvas 這條。
 */
function createInferenceCanvas() {
  const ua = navigator.userAgent
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome')
  const major = Number(ua.match(/Version\/(\d+).*Safari/)?.[1] ?? 0)
  const canUseOffscreen = typeof OffscreenCanvas !== 'undefined' && (!isSafari || major >= 17)
  if (canUseOffscreen) return new OffscreenCanvas(1, 1)
  const el = document.createElement('canvas')
  el.width = 1
  el.height = 1
  return el
}

/**
 * 唯一碰 MediaPipe 的檔。對外只有 async step()，
 * 介面刻意設計成日後要搬進 Worker 時只改這一個檔（spec 已核准的可逆性保留）。
 *
 * 隱私紅線：landmarks / blendshapes / detections 只在本檔內存活，
 * 換算成純量後原始資料立刻失去參照，絕不往外傳、絕不寫入任何儲存層。
 */
export function createInferenceService({ videoEl }) {
  const scheduler = createScheduler(SPECS)
  // 基準層：store 寫進來的「這個世界該是什麼樣子」。初始值必須跟 createScheduler()
  // 建構出來的狀態一致（三個 track 都 enabled、scale=1），否則這一層從第一刻起
  // 就在描述一個不存在的世界。
  const base = { scale: 1, pose: true, face: true, object: true }
  let calibrationBoost = false
  const tasks = { pose: null, face: null, object: null }
  let inFlight = false
  let ready = false
  let latencyEma = 0

  // 可觀測性：失敗的一輪照樣呼叫 scheduler.complete()（見下方 catch 的註解），
  // 所以 actualFps() 讀起來會完全正常，即使某個 track 其實一直在報錯、判定
  // 永遠凍結在舊值。這裡記每個 key 各自的連續失敗次數與最後一次錯誤的名稱，
  // 讓 UI 至少能分辨「真的沒偵測到」和「一直在報錯」。
  //
  // 隱私紅線：只留 error.name（如 'TypeError'），絕不留 error.message
  // （可能夾帶檔名、路徑或資料內容）、不留 stack、不留任何推論輸出。
  const health = {
    pose: { consecutiveFailures: 0, lastErrorName: null },
    face: { consecutiveFailures: 0, lastErrorName: null },
    object: { consecutiveFailures: 0, lastErrorName: null },
  }

  /**
   * ⚠ 骨架線疊加用的**唯一**原始 landmark 出口（`onPoseFrame()`）。
   *
   * ── 為什麼這件事需要一個全新的通道，而不是沿用既有資料流 ──────────
   *
   * 這個專案從第一天起就有一條界線：landmark 座標在本檔內部算成彙總純量
   * （`poseMetrics()` 的 `{ neckRatio, shoulderWidth, valid }`）之後才離開，
   * 原始座標永遠不進入 store／state machine／storage。`step()` 的回傳值就是
   * 那條界線的形狀，**這裡一個欄位都不會加**——只要 `step()` 開始夾帶座標，
   * 每一個碰過 metrics 的地方（session.js、focusStateMachine.js、
   * storageService.js 的 ALLOWED_FIELDS）都要重新審查一次隱私。
   *
   * 骨架線需要座標，所以它走一條**旁路**，而且這條旁路刻意做成
   * 「**推送**、不可查詢、不留存」三個性質：
   *
   *   1. **推送**：訂閱者只在那一幀被呼叫一次，拿到的是 `detectForVideo()`
   *      當場回傳的那個陣列。沒有 `getLandmarks()` 這種可以事後問的函式——
   *      有的話，任何人在任何時間點都能把座標撈出來放進任何地方。
   *   2. **不可查詢**：本檔不保留 `poseLandmarks` 的模組層參照。它是
   *      `step()` 的一個區域變數，那一輪結束就失去參照。
   *   3. **不留存**：這裡不對訂閱者做任何複製或快取。訂閱者（
   *      `PoseSkeletonOverlay.vue`）的契約是「畫完就丟」，它的護欄裝在
   *      它自己那一層（DOM canary ＋ setupState 掃描）。
   *
   * ── 呼叫時機：一定在延遲量測**之後** ─────────────────────────────
   *
   * `latencyMs = performance.now() - startedAt` 是 `perfMonitor` 那個
   * **單向、不可升回**的降檔唯一看的訊號。把繪圖算進那個視窗，等於讓
   * 「畫骨架線」自己把偵測頻率降下去。所以 `notifyPoseFrame()` 的呼叫點
   * 在 `latencyEma` 算完之後——`inferenceService.poseObserver.test.js`
   * 有一條測試鎖住這個順序（慢訂閱者不得推高 latencyEma）。
   *
   * ── 訂閱者丟例外不得汙染推論健康度 ───────────────────────────────
   *
   * 訂閱者是 UI 程式碼，它壞掉是 UI 的事。若讓例外往上冒到 `step()` 的
   * catch，pose track 會被記成連續失敗、`step()` 回 null，於是「骨架線畫錯」
   * 會變成「整場偵測不到姿勢」——最差的一種耦合。所以逐一 try/catch 吞掉。
   */
  const poseObservers = []

  function notifyPoseFrame(landmarks) {
    for (let i = 0; i < poseObservers.length; i += 1) {
      try {
        poseObservers[i](landmarks)
      } catch {
        // 訂閱者（畫面）壞掉不得讓推論這一輪被判成失敗。只吞掉，不記錄——
        // error.message／stack 是隱私紅線，而 health 是給 pose track 用的。
      }
    }
  }

  /**
   * ⚠ 這裡取的不是「bounding box 最大者」。
   *
   * 查證過 MediaPipe 的行為：`numPoses` / `numFaces` 只是傳給底層偵測器的
   * top-k 參數，NMS 是依「偵測信心分數」排序取前 N 個，不是依框的面積。
   * `numPoses: 1` / `numFaces: 1` 確實達成「不處理多於一個人的 landmark」
   * 這個隱私目的（第三人的 landmark 從沒被算出來過），但**不保證**
   * 那唯一一個結果就是使用者本人。
   *
   * 殘餘風險（v1 已知、暫不處理）：展場人多時，若背景有個姿態清晰、正面
   * 朝鏡頭的路人，信心分數可能高過側身或被桌子遮擋的主體（使用者本人），
   * 系統可能整場都在判讀錯的人，而且畫面上沒有任何提示。
   *
   * controller 裁決：v1 不把 `numPoses` 調成 2 再自己比框——那會讓我們
   * 實際處理到兩個人的 landmark，跟「不處理多於一個人」的隱私目的互相衝突，
   * 等於拿一個隱私問題換另一個。正確解法是日後加一道「主體合理性閘門」
   * （肩寬小於某個量出來的下限就視為路人、不採信），下限要用 thresholdLab
   * 量出來，不能用猜的——這件事目前還沒做，見 task-7-report.md 的 Step 10
   * 待辦清單。
   */
  function largestPose(result) {
    if (!result?.landmarks?.length) return null
    return result.landmarks[0] // numPoses:1，MediaPipe 依信心分數取的第一個
  }

  /**
   * 「東西必須夠大」閘門（見 DISTRACTING_MIN_AREA_RATIO 的完整推導）。
   *
   * MediaPipe 的 `boundingBox` 是**輸入影像的像素座標**（不是 0–1 的比例），
   * 所以分母要拿同一張影像的尺寸：`videoEl.videoWidth/videoHeight`。
   *
   * 量不到畫面尺寸時（影格還沒 decode、jsdom、或哪天有人換了影像來源）
   * 一律回 `false`＝當作沒偵測到。這個方向是刻意選的：**誤判的代價比漏抓高**
   * ——漏抓只是這幾秒沒開陷阱，誤判是整場打不到魔王而且畫面上沒有解釋。
   * 回 `true`（「量不到就放行」）等於在最沒有把握的時候做最重的判定。
   */
  /**
   * 把「基準層（store 擁有）」與「校準疊加層（元件擁有）」合成成 scheduler
   * 實際要用的值。**這是全檔唯一碰 scheduler.setScale / setEnabled 的地方。**
   *
   * 疊加層生效時：倍率提到 CALIBRATION_SCALE，face／object 一律關掉
   * （校準只看 pose，多跑兩條 track 只會讓 5 秒內取樣不足）。pose 仍然跟著
   * base 走——「現在到底該不該有推論在跑」始終是 store 的事，校準不覆寫它。
   *
   * 刻意**不做**「值沒變就不送」的去重：去重會讓「這一層現在認為世界是什麼
   * 樣子」變成只有它自己知道的內部狀態，外面（包含測試）再也看不到終局是
   * 怎麼來的。代價只是轉場時多送幾次同值的 setEnabled——`scheduler.setEnabled`
   * 打開時會把 nextDueAt 歸零並清掉 fps 樣本，而「轉場之後三個 track 立刻可跑、
   * 統計重新起算」本來就是我們要的行為。這個函式只在轉場與校準起訖被呼叫，
   * 不在每幀路徑上。
   */
  function applyLayers() {
    scheduler.setScale(calibrationBoost ? CALIBRATION_SCALE : base.scale)
    for (const key of ['pose', 'face', 'object']) {
      scheduler.setEnabled(key, calibrationBoost && key !== 'pose' ? false : base[key])
    }
  }

  function isBigEnough(box) {
    const frameArea = (videoEl?.videoWidth ?? 0) * (videoEl?.videoHeight ?? 0)
    if (!(frameArea > 0)) return false
    const boxArea = Math.max(0, box?.width ?? 0) * Math.max(0, box?.height ?? 0)
    if (!(boxArea > 0)) return false
    return boxArea / frameArea >= DISTRACTING_MIN_AREA_RATIO
  }

  return {
    async init() {
      try {
        const fileset = await FilesetResolver.forVisionTasks('/wasm')

        // 三個 task 共用同一個 canvas / GL context。
        //
        // 已於 @mediapipe/tasks-vision@1.0.1 原始碼確認：三個 task 的
        // createFromOptions 都走同一個工廠函式，第一件事就是讀 options.canvas；
        // 不給的話「每個 task 各自 new OffscreenCanvas(1,1)」= 三個 GL context。
        // 所以共用是官方支援的路徑，不是 hack。
        //
        // 尺寸固定 1×1：這塊 canvas 只是 GL context 的載體，推論走 texture，
        // 不畫到它的 backing store。給 640×480 等於白白配置 1.2MB drawing buffer。
        //
        // 三條紅線（違反會噴 "You cannot use a canvas that is already bound to
        // a different type of rendering context."）：
        //   1. 這塊 canvas 絕對不能拿去 getContext('2d')
        //   2. 不能掛進 DOM、不能當預覽畫面
        //   3. 三個 task 要一起 close()，不能只關其中一個（共用 context）
        const canvas = createInferenceCanvas()

        tasks.pose = await PoseLandmarker.createFromOptions(fileset, {
          canvas,
          baseOptions: { modelAssetPath: MODEL_ASSET_PATHS.pose, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        })
        tasks.face = await FaceLandmarker.createFromOptions(fileset, {
          canvas,
          baseOptions: { modelAssetPath: MODEL_ASSET_PATHS.face, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
        })
        tasks.object = await ObjectDetector.createFromOptions(fileset, {
          canvas,
          baseOptions: { modelAssetPath: MODEL_ASSET_PATHS.object, delegate: 'GPU' },
          runningMode: 'VIDEO',
          scoreThreshold: PHONE_MIN_SCORE,
          maxResults: 5,
        })

        ready = true
        return { ok: true }
      } catch (error) {
        return { ok: false, error }
      }
    },

    async step(now) {
      if (!ready) return null
      if (inFlight) {
        // 單一 in-flight：不排隊，直接丟棄這一輪。
        // 排隊會在主執行緒卡頓時累積一長串已經過期的影格。
        scheduler.skip()
        return null
      }
      const key = scheduler.pick(now)
      if (!key) return null
      if (videoEl.readyState < 2) return null

      inFlight = true
      const startedAt = performance.now()
      try {
        let metrics = null
        // 這一輪的原始 landmarks。**區域變數，不是模組狀態**——這一次 step()
        // 回傳之後它就失去參照（見上方 notifyPoseFrame 的完整說明）。
        let poseLandmarks = null
        if (key === 'pose') {
          poseLandmarks = largestPose(tasks.pose.detectForVideo(videoEl, now))
          metrics = poseMetrics(poseLandmarks)
        } else if (key === 'face') {
          const r = tasks.face.detectForVideo(videoEl, now)
          // r.faceLandmarks[0] 是同一次推論算出來的 478 點臉部網格（含虹膜，
          // 見 poseGeometry.js 的 irisSideOffset() 完整說明）——這裡只是把它
          // 遞進 faceMetrics()，跟遞 blendshapes 同一個模式：原始座標一過
          // faceMetrics() 就變成純量，不會再流到別的地方。
          metrics = faceMetrics(r?.faceBlendshapes?.[0]?.categories ?? null, r?.faceLandmarks?.[0] ?? null)
        } else {
          const r = tasks.object.detectForVideo(videoEl, now)
          // 欄位名維持 `phoneVisible`：它的語意從一開始就是「現在有沒有不該
          // 出現的東西」，只是當初清單裡只有手機。改名要動 session.js、
          // focusStateMachine.js、storageService 的 ALLOWED_FIELDS 白名單與
          // 一整排測試，而那些檔案這一輪有別人在改——改名的收益是措辭好看，
          // 代價是跨四個檔案的合併衝突。不值得，所以留著並在這裡說清楚。
          //
          // 隱私：只回傳一個布林值。類別名稱與 bounding box **不往外送**——
          // 送出去的話，「這個小孩桌上有什麼」就變成可以被記錄的東西了。
          // 下面的 bbox 只用來算一個面積比，算完就失去參照。
          const phoneVisible = (r?.detections ?? []).some((d) =>
            isBigEnough(d.boundingBox) && (d.categories ?? []).some(
              (c) => DISTRACTING_LABELS.includes(c.categoryName) && c.score >= PHONE_MIN_SCORE,
            ))
          metrics = { phoneVisible }
        }

        const latencyMs = performance.now() - startedAt
        latencyEma = latencyEma === 0 ? latencyMs : latencyEma * 0.8 + latencyMs * 0.2
        scheduler.complete(key, now)
        health[key].consecutiveFailures = 0
        health[key].lastErrorName = null
        // 一定在 latencyMs 算完之後（見 notifyPoseFrame 的說明）。pose 這一輪
        // 就算沒偵測到人也要通知（landmarks 為 null），否則畫布會卡在上一幀的
        // 殘影——「偵測不到」必須在畫面上看得出來，不能靜默地留著舊骨架。
        if (key === 'pose') notifyPoseFrame(poseLandmarks)
        return { key, metrics, latencyMs }
      } catch (error) {
        // 失敗也要排下一次，否則整條流程停住——這行不要改。
        // 但要記下來，不然畫面上的 fps 看起來完全正常，沒人知道這個 track
        // 其實一直在報錯。只留 error.name，不留 message/stack（隱私紅線）。
        scheduler.complete(key, now)
        health[key].consecutiveFailures += 1
        health[key].lastErrorName = error?.name ?? 'Error'
        return null
      } finally {
        inFlight = false
      }
    },

    latencyEma: () => latencyEma,

    // ── 基準層：唯一的「值」寫入者是 store ───────────────────────────
    // setScale / setEnabled 寫的是 base，不是 scheduler。真正送進 scheduler 的
    // 是 base 與校準疊加層合成出來的結果（applyLayers）。
    setScale: (s) => { base.scale = s; applyLayers() },
    setEnabled: (key, enabled) => {
      if (!(key in base)) return
      base[key] = enabled
      applyLayers()
    },

    /**
     * 校準疊加層的開關（Blocking B1 的結構性修法）。
     *
     * ── 出過什麼事 ────────────────────────────────────────────────
     *
     * 流程從「校準 → 選任務 → 開打」反轉成「選任務 → 校準 → 開打」之後，
     * `CalibrationWizard` 的卸載時機從「`setCalibration()` 換畫面時當場卸載」
     * 變成「排在 `startBattle()` 的 `await syncCameraAsync()` 那一刻 flush」。
     * 元件的 `restore()` 因此變成**開打前最後一個寫推論設定的人**，而它寫的是
     * 它自己以為的絕對值（`setEnabled('object', true)`、`setScale(restoreScale)`）
     * ——於是工作人員在設定面板關掉的手機偵測會被它無聲地打開，
     * 效能降檔關掉的 object track 也會在每一場戰鬥被重新打開：
     * **旗標說沒在跑、實際在跑。**
     *
     * ── 為什麼這個作法不怕 flush 順序改變 ──────────────────────────
     *
     * 關鍵不是「讓 store 排在元件後面」——那是把正確性押在 flush 順序上，
     * 正是這次出事的原因，而且下一次 Vue 改排程或有人在流程中多插一個
     * `await` 就會再倒過來一次。
     *
     * 這裡改成：**元件不再寫任何值，它只翻一個布林。**
     * `setCalibrationBoost(false)` 不帶任何「該還原成什麼」的知識——它只是
     * 把疊加層拿掉，然後重新套用 `base`，而 `base` 完全由 store 擁有。
     * 於是兩個寫入者的關係從「誰最後寫誰贏」變成：
     *
     *   - store 寫 base → 合成 → scheduler
     *   - 元件翻疊加層 → 用**同一份 base** 合成 → scheduler
     *
     * 兩條路徑對同一份 base 算出同一個結果，所以**不管誰先誰後、跑幾次，
     * 終值都一樣**。順序不再是正確性的一部分，也就沒有東西需要被保證。
     *
     * 反過來說也成立：校準期間 store 若在某個轉場收斂了倍率，也不會把提頻
     * 打掉（疊加層還在，合成結果仍是 CALIBRATION_SCALE）。兩個方向都不打架。
     */
    setCalibrationBoost: (on) => { calibrationBoost = Boolean(on); applyLayers() },

    /**
     * 骨架線疊加的訂閱入口。完整的理由與紅線寫在 `notifyPoseFrame()` 上方。
     *
     * 契約（訂閱者必須守住，否則隱私界線在訂閱者那一端破掉）：
     * - `observer(landmarks)` 只在那一幀被呼叫，`landmarks` 是
     *   `PoseLandmarker.detectForVideo()` 當場回傳的陣列（沒偵測到人時是 null）。
     * - **呼叫回來就要用完**：不得存進任何 ref／reactive／store／DOM 屬性，
     *   不得複製一份留著。這個函式不提供第二次拿到同一份資料的方法。
     * - 回傳一個解除訂閱的函式，重複呼叫安全（冪等）。
     *
     * 這裡不做「同時只能有一個訂閱者」的限制：戰鬥畫面與校準畫面在轉場那一
     * 瞬間可能同時掛載，單槽設計會讓後來者靜默地把前一個踢掉（而前一個還在
     * 畫面上）。清單長度實務上是 0 或 1，遍歷成本可以忽略，而且 pose track
     * 本來就只有 2fps（校準期間 6fps），這不是每個 rAF 都跑的路徑。
     */
    onPoseFrame: (observer) => {
      if (typeof observer !== 'function') return () => {}
      poseObservers.push(observer)
      let live = true
      return () => {
        if (!live) return
        live = false
        const i = poseObservers.indexOf(observer)
        if (i !== -1) poseObservers.splice(i, 1)
      }
    },
    actualFps: (key, now) => scheduler.actualFps(key, now),
    isReady: () => ready,
    // 白名單，不是 spread。spread 是「裡面有什麼就吐什麼」——哪天有人為了除錯
    // 在 catch 裡多塞一個 lastError: error 或 lastMessage: error.message 進 health[key]，
    // spread 會原封不動把它送到畫面上。顯式挑欄位讓那種疏忽當場漏不出去。
    // 要加新欄位，就得先在這裡加，那一刻自然會想起這條紅線。
    health: () => {
      const safe = ({ consecutiveFailures, lastErrorName }) => ({ consecutiveFailures, lastErrorName })
      return { pose: safe(health.pose), face: safe(health.face), object: safe(health.object) }
    },

    /**
     * 只在整個 App 卸載時呼叫。每輪結束不得呼叫——重建會累積 GPU 記憶體並拖慢第二輪。
     * 三個 task 共用一個 GL context，所以要關就三個一起關，不提供單獨關掉某個 task 的介面。
     */
    destroy() {
      for (const t of Object.values(tasks)) t?.close?.()
      tasks.pose = tasks.face = tasks.object = null
      ready = false
      // 訂閱者清單一起清掉：整個 App 都要卸載了，留著一份指向已卸載元件的
      // 函式參照沒有任何用處，只是多一條可能讓元件活著的路。
      poseObservers.length = 0
    },
  }
}
