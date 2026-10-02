/**
 * 把 MediaPipe 的原始輸出換算成少數幾個正規化純量。
 * 這是唯一知道 landmark 索引與 blendshape 名稱的地方。
 *
 * 隱私：本檔只回傳純量，呼叫端不得保留傳入的 landmarks / blendshapes。
 * faceMetrics() 這一輪起也會收臉部 478 點網格（含虹膜），跟 poseMetrics()
 * 收 33 點姿態網格是同一條紅線、同一種處理方式：進來算完幾個純量就丟，
 * 原始座標不流到這個檔案以外的任何地方。
 */

const EAR_L = 7, EAR_R = 8, SHOULDER_L = 11, SHOULDER_R = 12
const WRIST_L = 15, WRIST_R = 16
const MIN_VISIBILITY = 0.5
const MIN_SHOULDER_WIDTH = 0.02

const INVALID = Object.freeze({
  neckRatio: 0, shoulderWidth: 0, tiltRatio: 0, handNearRatio: Infinity, earsValid: false, valid: false,
})

function visible(p) {
  return !!p && (p.visibility === undefined || p.visibility >= MIN_VISIBILITY)
}

/**
 * 實機驗收回報「駝背的太寬鬆」之後才發現的另一個成因：耳朵跟肩膀以前是
 * 綁在同一個 all-or-nothing 判斷裡——四個點只要有一個能見度不足（含耳朵），
 * 整幀直接判 invalid，連 shoulderWidth 都不採信。小孩頭壓得越低，耳朵越
 * 容易被瀏海／下巴角度擋住能見度分數掉到門檻以下，於是「頭壓得最低的那一刻」
 * 反而是系統完全看不見任何姿態訊號的那一刻——駝背偵測在最該觸發的時候熄火。
 *
 * 這裡拆成兩層：只要兩肩看得到就可以算 shoulderWidth（塌陷偵測不需要耳朵），
 * 耳朵另外算一個 `earsValid`，只有耳朵也看得到時才附帶算 neckRatio／tiltRatio
 * ／handNearRatio——這三個純幾何量本來就需要耳朵當參考點，量不到就不該
 * 假裝量得到。呼叫端（poseAnalyzer.js）用 `earsValid !== false` 決定要不要
 * 採信這三個欄位，而不是靠「neckRatio 剛好是 0」這種巧合。
 */
export function poseMetrics(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 33) return INVALID

  const shL = landmarks[SHOULDER_L], shR = landmarks[SHOULDER_R]
  if (!visible(shL) || !visible(shR)) return INVALID

  const shoulderWidth = Math.hypot(shR.x - shL.x, shR.y - shL.y)
  if (shoulderWidth < MIN_SHOULDER_WIDTH) return INVALID

  const earL = landmarks[EAR_L], earR = landmarks[EAR_R]
  const earsValid = visible(earL) && visible(earR)

  let neckRatio = 0, tiltRatio = 0, handNearRatio = Infinity
  if (earsValid) {
    const earMidY = (earL.y + earR.y) / 2
    const shoulderMidY = (shL.y + shR.y) / 2
    // 影像座標 y 向下為正，所以「肩 − 耳」在頭抬起時為正值
    neckRatio = (shoulderMidY - earMidY) / shoulderWidth
    // 頭歪（歪頭靠向某一側肩膀）：兩耳的垂直落差，用肩寬正規化——正常抬頭
    // 兩耳幾乎等高，歪頭時其中一耳明顯低於另一耳。
    tiltRatio = Math.abs(earR.y - earL.y) / shoulderWidth

    // 撐頭（用手撐著下巴／臉頰）：手腕貼近耳朵這一側，用肩寬正規化。手腕
    // 不可見（垂在鏡頭外、被桌面擋住）時該手臂不計入，不強迫整幀失效——
    // 跟上面「耳朵不可見不強迫整幀失效」同一個原則。
    const wristL = landmarks[WRIST_L], wristR = landmarks[WRIST_R]
    if (visible(wristL)) handNearRatio = Math.min(handNearRatio, Math.hypot(wristL.x - earL.x, wristL.y - earL.y) / shoulderWidth)
    if (visible(wristR)) handNearRatio = Math.min(handNearRatio, Math.hypot(wristR.x - earR.x, wristR.y - earR.y) / shoulderWidth)
  }

  return { neckRatio, shoulderWidth, tiltRatio, handNearRatio, earsValid, valid: true }
}

const EYE_CLOSED_THRESHOLD = 0.5
const GAZE_DOWN_THRESHOLD = 0.35
// 實機驗收回報「眼神沒在看書也沒有抓到」：側視／上視的門檻原本是 0.40／0.35，
// 跟 postureProfiles.js 的四個數字同一個毛病——沒有人在 iPad 上量過真實
// blendshape 分數。這裡先往下調（0.40→0.30、0.35→0.28），讓真的往旁邊看的
// 情況更容易被抓到；跟駝背門檻同樣的但書：方向對（漏抓比誤判更該修），
// 幅度是推測，下一輪真機測試要用 ThresholdLab 量真值回來覆蓋。
const GAZE_SIDE_THRESHOLD = 0.30
const GAZE_UP_THRESHOLD = 0.28

/**
 * 虹膜座標側視偵測（跟上面的 blendshape side 併用，取兩者較大值，見
 * faceMetrics() 內的用法）。
 *
 * 為什麼要加這個：`face_landmarker.task`（已經在載入、已經在跑）本來就會
 * 輸出 478 點的臉部網格，其中 468–477 是虹膜（瞳孔）本身的座標，跟現在
 * 用的 blendshape 分數是**同一次推論**算出來的兩種輸出，不是另外多跑一個
 * 模型——零額外算力成本。blendshape 是 ARKit 那組表情係數，是對「側視」
 * 這個動作的間接估計；虹膜座標是直接量出瞳孔在眼眶裡的相對位置，理論上
 * 更準。既有程式碼完全沒讀過 `faceLandmarks`，這是白白放著沒用的訊號。
 *
 * 索引來源：`FaceLandmarker.FACE_LANDMARKS_LEFT_EYE` /
 * `FACE_LANDMARKS_RIGHT_EYE` / `FACE_LANDMARKS_LEFT_IRIS` /
 * `FACE_LANDMARKS_RIGHT_IRIS` 這幾個 MediaPipe 官方常數（在 Node 直接
 * import `@mediapipe/tasks-vision` 印出來核對過，不是查文件抄的）：
 * 右眼兩眼角＝33／133、虹膜中心＝468；左眼兩眼角＝263／362、虹膜中心＝473。
 * 「左右」跟現有 blendshape 命名（eyeLookOutLeft 等）同一個慣例，是本人
 * 自己的左右，不是鏡頭畫面上的左右。
 *
 * 算法：虹膜中心相對兩眼角中點的水平位移，除以眼寬正規化——0 代表瞳孔
 * 置中（正視前方），數值越大代表越往其中一側偏。雙眼同時算、取平均：
 * 兩顆眼球是同一組肌肉共軛運動，平均掉單眼量測雜訊，跟既有 blendshape
 * side 用「跨眼配對取平均」是同一個目的、不同的手法（虹膜位移本身已經
 * 帶方向，不需要像 blendshape 那樣跨眼配對才能辨向）。
 *
 * IRIS_SIDE_THRESHOLD 目前是推算值，不是量出來的——跟 postureProfiles.js
 * 那幾個佔位值同一個性質，等下一輪真機測試回頭校準。
 */
const RIGHT_EYE_CORNER_A = 33, RIGHT_EYE_CORNER_B = 133, RIGHT_IRIS_CENTER = 468
const LEFT_EYE_CORNER_A = 263, LEFT_EYE_CORNER_B = 362, LEFT_IRIS_CENTER = 473
const MIN_EYE_WIDTH = 0.015
const IRIS_SIDE_THRESHOLD = 0.15

function irisSideOffset(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 478) return 0

  const pts = [
    landmarks[RIGHT_EYE_CORNER_A], landmarks[RIGHT_EYE_CORNER_B], landmarks[RIGHT_IRIS_CENTER],
    landmarks[LEFT_EYE_CORNER_A], landmarks[LEFT_EYE_CORNER_B], landmarks[LEFT_IRIS_CENTER],
  ]
  if (pts.some((p) => !p)) return 0
  const [rA, rB, rIris, lA, lB, lIris] = pts

  const rWidth = Math.abs(rB.x - rA.x)
  const lWidth = Math.abs(lB.x - lA.x)
  // 眼寬量不到（臉太側、太遠、被遮）就不採信這條訊號，退回只靠 blendshape
  // ——跟 poseMetrics() 的 MIN_SHOULDER_WIDTH 同一個「量不準就不用」的原則。
  if (rWidth < MIN_EYE_WIDTH || lWidth < MIN_EYE_WIDTH) return 0

  const rOffset = (rIris.x - (rA.x + rB.x) / 2) / rWidth
  const lOffset = (lIris.x - (lA.x + lB.x) / 2) / lWidth
  return Math.abs((rOffset + lOffset) / 2)
}

function scoreOf(map, name) {
  const v = map.get(name)
  return typeof v === 'number' ? v : 0
}

/**
 * `valid` 的意義跟 poseMetrics 的 `valid` 對齊：是否真的偵測到一張臉，
 * 不是「這一幀的姿態判斷結果」。沒有這個欄位以前，鏡頭完全拍不到臉（被
 * 遮住、使用者離開座位但沒觸發 away 陷阱門檻）跟「真的一臉平靜地看著正前方、
 * 眼睛睜開」在回傳值上長得一模一樣（都是 `{ eyeClosed:false, gaze:'center' }`），
 * 導致呼叫端無法用資料新鮮度判斷推論是不是已經沒東西可看了——這正是
 * inferenceHealthy 的資料新鮮度看門狗需要的訊號（見 stores/session.js）。
 */
export function faceMetrics(blendshapes, landmarks = null) {
  if (!Array.isArray(blendshapes) || blendshapes.length === 0) {
    return { eyeClosed: false, gaze: 'center', valid: false }
  }
  const map = new Map(blendshapes.map((c) => [c.categoryName, c.score]))

  const blink = (scoreOf(map, 'eyeBlinkLeft') + scoreOf(map, 'eyeBlinkRight')) / 2
  const down = (scoreOf(map, 'eyeLookDownLeft') + scoreOf(map, 'eyeLookDownRight')) / 2
  const up = (scoreOf(map, 'eyeLookUpLeft') + scoreOf(map, 'eyeLookUpRight')) / 2
  // 側向視線：往左看時左眼外轉（eyeLookOutLeft↑）、右眼同時往鼻子方向內轉
  // （eyeLookInRight↑），兩訊號會一起升高，所以配成一對取平均；往右看則是
  // eyeLookOutRight + eyeLookInLeft 這一對。這個配對利用「雙眼同向一致」
  // 過濾 blendshape 雜訊——只有單眼訊號飆高（另一眼沒有相應反應）在生理上
  // 不會是真的側視，不該被平均拉高判成 away。
  const blendSide = Math.max(
    (scoreOf(map, 'eyeLookOutLeft') + scoreOf(map, 'eyeLookInRight')) / 2,
    (scoreOf(map, 'eyeLookOutRight') + scoreOf(map, 'eyeLookInLeft')) / 2,
  )
  // 虹膜座標是幾何比例（眼寬的幾分之幾），跟 blendshape 分數（ARKit 0–1
  // 係數）不是同一個量尺，不能直接取 max 再跟同一個門檻比——各自比各自的
  // 門檻，任一個過線就算 away。虹膜訊號被瀏海、眼鏡反光、極端角度擋住時
  // irisSideOffset() 退化成 0，這時完全靠 blendshape 撐住，新訊號量不到
  // 不會讓判斷變差，只會增加靈敏度。
  const irisSide = irisSideOffset(landmarks)

  let gaze = 'center'
  // 往下優先判定：低頭看書本來就會同時出現側向分量，不能因此被當成分心
  if (down > GAZE_DOWN_THRESHOLD) gaze = 'down'
  else if (blendSide > GAZE_SIDE_THRESHOLD || irisSide > IRIS_SIDE_THRESHOLD || up > GAZE_UP_THRESHOLD) gaze = 'away'

  return { eyeClosed: blink > EYE_CLOSED_THRESHOLD, gaze, valid: true }
}
