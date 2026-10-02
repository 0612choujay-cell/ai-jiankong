import { vi, describe, it, expect, beforeEach } from 'vitest'

/**
 * 這個檔不需要真瀏覽器或 GPU：mock 掉 @mediapipe/tasks-vision 的三個
 * createFromOptions，再 mock 掉 inferenceScheduler.js，鎖住
 * inferenceService.js 對外的兩個關鍵契約：
 *
 *   1. 單一 in-flight：前一次推論還沒完成時，再呼叫 step() 只會
 *      scheduler.skip()，絕不 scheduler.complete()。
 *   2. 失敗要能被觀察到，但不能外洩任何隱私資訊（只留 error.name）。
 *
 * inflight 測試用「重入」模擬並發：detectForVideo 是同步呼叫，正常情況下
 * 兩次 step() 不會真的重疊；用 mock 讓第一次 detectForVideo 執行「期間」
 * 主動重入呼叫 svc.step()，這時 inFlight 已經被外層呼叫設成 true，
 * 剛好命中要鎖住的那個分支。
 */

const schedulerMocks = vi.hoisted(() => ({
  pick: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
  setScale: vi.fn(),
  setEnabled: vi.fn(),
  actualFps: vi.fn(),
}))

vi.mock('./inferenceScheduler.js', () => ({
  createScheduler: () => schedulerMocks,
}))

const taskMocks = vi.hoisted(() => ({
  pose: { detectForVideo: vi.fn(), close: vi.fn() },
  face: { detectForVideo: vi.fn(), close: vi.fn() },
  object: { detectForVideo: vi.fn(), close: vi.fn() },
}))

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn().mockResolvedValue({}) },
  PoseLandmarker: { createFromOptions: vi.fn().mockResolvedValue(taskMocks.pose) },
  FaceLandmarker: { createFromOptions: vi.fn().mockResolvedValue(taskMocks.face) },
  ObjectDetector: { createFromOptions: vi.fn().mockResolvedValue(taskMocks.object) },
}))

// createInferenceCanvas() 只在 init() 用得到，走 OffscreenCanvas 分支就不會碰
// navigator.userAgent 以外的任何瀏覽器 API。
vi.stubGlobal('navigator', { userAgent: 'vitest' })
vi.stubGlobal('OffscreenCanvas', class {})

const { createInferenceService, distractingLabels } = await import('./inferenceService.js')

// 640×480 = cameraCapture.js 的 CONSTRAINTS，也是「東西必須夠大」閘門的分母。
const FRAME_W = 640
const FRAME_H = 480
const FRAME_AREA = FRAME_W * FRAME_H

function fakeVideo(extra = {}) {
  return { readyState: 4, videoWidth: FRAME_W, videoHeight: FRAME_H, ...extra }
}

async function initSvc(videoEl = fakeVideo()) {
  const svc = createInferenceService({ videoEl })
  const r = await svc.init()
  expect(r.ok).toBe(true)
  return svc
}

describe('createInferenceService', () => {
  beforeEach(() => {
    for (const m of Object.values(schedulerMocks)) m.mockReset()
    taskMocks.pose.detectForVideo.mockReset().mockReturnValue({ landmarks: [] })
    taskMocks.face.detectForVideo.mockReset().mockReturnValue({ faceBlendshapes: [] })
    taskMocks.object.detectForVideo.mockReset().mockReturnValue({ detections: [] })
    schedulerMocks.pick.mockReturnValue(null)
  })

  it('scheduler.pick() 回 null 時，step() 回 null，不碰 skip 也不碰 complete', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue(null)
    const r = await svc.step(100)
    expect(r).toBe(null)
    expect(schedulerMocks.skip).not.toHaveBeenCalled()
    expect(schedulerMocks.complete).not.toHaveBeenCalled()
  })

  it('正常成功的一輪會呼叫 complete(key, now)', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('pose')
    const r = await svc.step(100)
    expect(r.key).toBe('pose')
    expect(schedulerMocks.complete).toHaveBeenCalledTimes(1)
    expect(schedulerMocks.complete).toHaveBeenCalledWith('pose', 100)
    expect(schedulerMocks.skip).not.toHaveBeenCalled()
  })

  it('inFlight 為真時，重入呼叫只會 scheduler.skip()，絕不 scheduler.complete()', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('pose')

    let reenteredPromise = null
    taskMocks.pose.detectForVideo.mockImplementation(() => {
      // 此刻外層 step() 已經把 inFlight 設成 true、還沒進到它自己的
      // scheduler.complete()。重入呼叫必須在「這個時間點」就只走 skip()。
      reenteredPromise = svc.step(999)
      expect(schedulerMocks.skip).toHaveBeenCalledTimes(1)
      expect(schedulerMocks.complete).not.toHaveBeenCalled()
      return { landmarks: [] }
    })

    const outerResult = await svc.step(100)
    const reenteredResult = await reenteredPromise

    // 外層那一輪照常成功；重入的那一輪拿到 null，且從頭到尾沒有被算進 complete。
    expect(outerResult.key).toBe('pose')
    expect(reenteredResult).toBe(null)
    expect(schedulerMocks.skip).toHaveBeenCalledTimes(1)
    expect(schedulerMocks.complete).toHaveBeenCalledTimes(1)
    expect(schedulerMocks.complete).toHaveBeenCalledWith('pose', 100)
  })

  it('detectForVideo 丟例外時，inFlight 會在 finally 重置，下一輪能正常跑', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('pose')
    taskMocks.pose.detectForVideo.mockImplementationOnce(() => {
      throw new TypeError('boom')
    })

    const r1 = await svc.step(100)
    expect(r1).toBe(null)
    // 失敗也要排下一次，否則整條流程停住——這一行本來就該被呼叫。
    expect(schedulerMocks.complete).toHaveBeenCalledWith('pose', 100)

    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [] })
    schedulerMocks.pick.mockReturnValue('pose')
    const r2 = await svc.step(200)
    expect(r2).not.toBe(null)
    expect(r2.key).toBe('pose')
  })

  it('失敗時 health(key) 的連續失敗次數遞增、只記 error.name；成功後歸零', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('pose')

    taskMocks.pose.detectForVideo.mockImplementationOnce(() => {
      throw new TypeError('first failure')
    })
    await svc.step(100)
    expect(svc.health().pose).toEqual({ consecutiveFailures: 1, lastErrorName: 'TypeError' })

    schedulerMocks.pick.mockReturnValue('pose')
    taskMocks.pose.detectForVideo.mockImplementationOnce(() => {
      throw new RangeError('second failure')
    })
    await svc.step(200)
    expect(svc.health().pose).toEqual({ consecutiveFailures: 2, lastErrorName: 'RangeError' })

    schedulerMocks.pick.mockReturnValue('pose')
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [] })
    await svc.step(300)
    expect(svc.health().pose).toEqual({ consecutiveFailures: 0, lastErrorName: null })
  })

  it('health() 絕不外洩 error.message 或其他隱私內容，只有 error.name', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('pose')
    const secret = '/Users/someone/secret-photo.jpg 之類不該外流的內容'
    taskMocks.pose.detectForVideo.mockImplementationOnce(() => {
      throw new Error(secret)
    })
    await svc.step(100)
    const h = svc.health()
    expect(h.pose.lastErrorName).toBe('Error')
    expect(JSON.stringify(h)).not.toContain(secret)
  })
})

// ---------------------------------------------------------------------------
// 虹膜座標側視偵測：face_landmarker.task 本來就會算出 478 點臉部網格
// （含虹膜），poseGeometry.js 的 faceMetrics() 已經有單元測試鎖住那個
// 純函式本身的行為，這裡要鎖的是**接線**——inferenceService.js 是否真的
// 把 r.faceLandmarks[0] 遞給 faceMetrics()，而不是遞了 undefined 進去
// 讓新訊號永遠不生效（那樣上面那組單元測試會全綠，因為它們直接呼叫
// faceMetrics()，繞過了這條接線）。
// ---------------------------------------------------------------------------
describe('faceMetrics 接線：r.faceLandmarks[0] 真的被傳進去，不是被漏接的死代碼', () => {
  // 跟 poseGeometry.test.js 的 makeFaceLandmarks() 同一份索引，各檔各自
  // 維護一份小 fixture 比共用抽象值得（兩邊各自獨立驗證同一組官方常數）。
  function makeFaceLandmarksWithIrisOffset(offsetRatio) {
    const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }))
    const eyeWidth = 0.05
    pts[33] = { x: 0.30 - eyeWidth / 2 }
    pts[133] = { x: 0.30 + eyeWidth / 2 }
    pts[468] = { x: 0.30 + offsetRatio * eyeWidth }
    pts[263] = { x: 0.70 - eyeWidth / 2 }
    pts[362] = { x: 0.70 + eyeWidth / 2 }
    pts[473] = { x: 0.70 + offsetRatio * eyeWidth }
    return pts
  }

  it('blendshape 都不明顯，但 faceLandmarks 帶著明顯偏移的虹膜座標 → phoneVisible 以外的 gaze 判定要是 away', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('face')
    taskMocks.face.detectForVideo.mockReturnValue({
      faceBlendshapes: [{ categories: [
        { categoryName: 'eyeLookOutLeft', score: 0.05 },
        { categoryName: 'eyeLookInRight', score: 0.05 },
      ] }],
      faceLandmarks: [makeFaceLandmarksWithIrisOffset(0.25)], // > IRIS_SIDE_THRESHOLD(0.15)
    })

    const r = await svc.step(100)
    expect(r.key).toBe('face')
    expect(r.metrics.gaze, '沒有這條接線的話，虹膜訊號量不到，這裡會是 center').toBe('away')
  })

  it('faceLandmarks 缺席（舊格式的回傳值）：不得丟例外，行為退回只看 blendshape', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('face')
    taskMocks.face.detectForVideo.mockReturnValue({
      faceBlendshapes: [{ categories: [
        { categoryName: 'eyeLookOutLeft', score: 0.05 },
        { categoryName: 'eyeLookInRight', score: 0.05 },
      ] }],
      // 沒有 faceLandmarks 欄位
    })

    const r = await svc.step(100)
    expect(r.metrics.gaze).toBe('center')
  })
})

// ---------------------------------------------------------------------------
// Blocking B2：「不該出現在書桌上的東西」那份清單
//
// 原始碼註解白紙黑字寫著「`inferenceService.test.js` 有一條護欄鎖住這份清單的
// 每個字串都在 COCO 的 80 類裡面」——**那條測試在複審時被證明根本不存在**
// （幽靈護欄：它讓下一個維護者放心地去改那份清單）。複審實測：把清單縮回只剩
// `'cell phone'`（M10）、把註解明文禁止的 `book`／`laptop`／`cup` 加進來（M11），
// 兩條突變都是 792 全綠。這一組就是那條被宣稱、而現在真的存在的護欄。
// ---------------------------------------------------------------------------

/**
 * COCO 2017 的 80 個 thing 類別，依類別 id 由小到大排列。
 *
 * 來源：COCO 2017 標註檔 `instances_*.json` 的 `categories`（80 個 supercategory
 * 為 thing 的類別），也就是 TFLite / MediaPipe 物件偵測範例隨附的
 * `coco_labels.txt` 所用的同一份 display name 清單；我們載的
 * `efficientdet_lite0.tflite`（MODEL_ASSET_PATHS.object）就是在這 80 類上訓練的。
 *
 * 三個容易踩到的拼寫（全部照 COCO 原文，不要「修正」它們）：
 *   - `tv`（不是 `tvmonitor`／`television`）——COCO 2017 的 display name 是 `tv`
 *   - `hair drier`（不是 `hair dryer`）
 *   - `couch`／`airplane`／`motorcycle`（不是 `sofa`／`aeroplane`／`motorbike`，
 *     那是 Pascal VOC 的說法）
 *
 * 這份清單放在測試檔而不是正式碼：正式路徑一個字都用不到它，放進 bundle 只是
 * 多幾百 bytes。它存在的唯一理由就是「拼錯了會靜默地永遠偵測不到」。
 */
const COCO_80 = Object.freeze([
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe',
  'backpack', 'umbrella', 'handbag', 'tie', 'suitcase',
  'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl',
  'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza',
  'donut', 'cake',
  'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet',
  'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
])

describe('Blocking B2：COCO 標籤護欄（原始碼註解宣稱存在、而在此之前並不存在的那一條）', () => {
  it('COCO_80 這份參考清單本身是 80 個不重複的類別（護欄的護欄）', () => {
    // 沒有這一條，上面那份清單少打／多打幾個字都不會有人發現，而它是下面
    // 「成員資格」那條斷言的分母——一份殘缺的參考清單會讓它變成假綠。
    expect(COCO_80.length).toBe(80)
    expect(new Set(COCO_80).size).toBe(80)
  })

  it('清單裡的每一個字串都真的是 COCO 的 80 類之一（拼錯不會報錯，只會靜默地永遠偵測不到）', () => {
    for (const label of distractingLabels()) {
      expect(COCO_80, `「${label}」不在 COCO 80 類裡，這條 track 會永遠偵測不到它`).toContain(label)
    }
  })

  it('不得收錄任何學習用品——收進來等於讓遊戲在小孩做對事情的時候扣他血', () => {
    // 反向清單，逐字對應 inferenceService.js 註解裡「不收」的那一排。
    // 複審的 M11 就是把前三個加進來，792 全綠。
    const STUDY_ITEMS = ['book', 'laptop', 'cup', 'bottle', 'scissors', 'keyboard', 'mouse',
      'chair', 'dining table', 'clock', 'backpack', 'person']
    const list = distractingLabels()
    for (const item of STUDY_ITEMS) {
      expect(list, `「${item}」是書桌上理所當然會有的東西，不得收進偵測清單`).not.toContain(item)
    }
  })

  it('`tv` 不得再被加回來——展場背景有螢幕是必然，不是風險', () => {
    // controller 裁決。`tv` 在 COCO 涵蓋 tvmonitor ＝ 任何螢幕。這是一台放在
    // IEYI 展場、鏡頭對著小孩而背景是整個展場的 iPad：背景只要有一台螢幕，
    // phoneVisible 就整場為 true ⇒ 小孩坐得再好，魔王 15 分鐘一滴血不掉，
    // 而且畫面上在 23 秒之後再也沒有任何文字。這是「整場不成立」等級的後果，
    // 不是「誤判幾秒」。
    expect(distractingLabels()).not.toContain('tv')
  })

  it('`teddy bear` 不得再被加回來——兒童發明展的攤位上有玩偶是理所當然的', () => {
    // controller 裁決（重新評估的結果）：展場攤位的玩偶、書包吊飾、小孩自己
    // 帶來的娃娃，都讓它通不過「一個認真做功課的小孩，桌上有沒有可能理所當然
    // 地出現這個東西？」這條判準。
    expect(distractingLabels()).not.toContain('teddy bear')
  })

  it('`cell phone` 一定要在——它是這整個機制存在的理由', () => {
    // 反方向的護欄：複審的 M10 把清單縮回只剩 cell phone 是 792 全綠，
    // 而「把 cell phone 也拿掉」同樣是全綠。兩個方向都要有人守。
    expect(distractingLabels()).toContain('cell phone')
  })

  it('`remote` 留著：模型很常把平放在桌上的手機判成 remote', () => {
    expect(distractingLabels()).toContain('remote')
  })
})

describe('Blocking B2：「東西必須夠大」閘門（桌上的東西 vs 房間另一頭的東西）', () => {
  function detection(areaRatio, categoryName = 'cell phone', score = 0.9) {
    // 用正方形反推一個面積剛好等於 areaRatio 的框：閘門只看面積，不看形狀。
    const side = Math.sqrt(areaRatio * FRAME_AREA)
    return {
      boundingBox: { originX: 10, originY: 10, width: side, height: side },
      categories: [{ categoryName, score }],
    }
  }

  async function phoneVisibleFor(detections, videoEl = fakeVideo()) {
    const svc = await initSvc(videoEl)
    schedulerMocks.pick.mockReturnValue('object')
    taskMocks.object.detectForVideo.mockReturnValue({ detections })
    const r = await svc.step(100)
    return r.metrics.phoneVisible
  }

  it('桌上的手機（面積 1%）算數', async () => {
    expect(await phoneVisibleFor([detection(0.01)])).toBe(true)
  })

  it('房間另一頭的手機（面積 0.05%）不算數——展場背景的誤判就是這樣進來的', async () => {
    expect(await phoneVisibleFor([detection(0.0005)])).toBe(false)
  })

  it('只要畫面上有一個夠大的，就算另外有一堆小的也算數（some 語意）', async () => {
    expect(await phoneVisibleFor([detection(0.0001), detection(0.0002), detection(0.01)])).toBe(true)
  })

  it('夠大但不是清單裡的東西（例如 book）仍然不算數——閘門是額外條件，不是替代條件', async () => {
    expect(await phoneVisibleFor([detection(0.2, 'book')])).toBe(false)
  })

  it('夠大、是清單裡的東西、但分數不夠仍然不算數', async () => {
    expect(await phoneVisibleFor([detection(0.2, 'cell phone', 0.2)])).toBe(false)
  })

  it('量不到畫面尺寸時一律不算數——誤判的代價比漏抓高', async () => {
    // 影格還沒 decode／換了影像來源時 videoWidth 是 0。此時放行等於在最沒有
    // 把握的時候做最重的判定（整場打不到魔王），所以保守側是「當作沒偵測到」。
    const blind = fakeVideo({ videoWidth: 0, videoHeight: 0 })
    expect(await phoneVisibleFor([detection(0.5)], blind)).toBe(false)
  })

  it('沒有 boundingBox 的偵測結果不算數，而且不會丟例外', async () => {
    const noBox = { categories: [{ categoryName: 'cell phone', score: 0.9 }] }
    expect(await phoneVisibleFor([noBox])).toBe(false)
  })

  it('隱私紅線：往外走的只有一個布林值，bounding box 與類別名稱都不得外流', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('object')
    taskMocks.object.detectForVideo.mockReturnValue({
      detections: [detection(0.01, 'cell phone')],
    })
    const r = await svc.step(100)
    expect(r.metrics).toEqual({ phoneVisible: true })
    expect(JSON.stringify(r)).not.toContain('cell phone')
    expect(JSON.stringify(r)).not.toContain('boundingBox')
  })
})

// ---------------------------------------------------------------------------
// Blocking B1：校準疊加層 —— 「誰最後寫」不再是正確性的一部分
// ---------------------------------------------------------------------------

describe('Blocking B1：校準疊加層與基準層的合成（順序無關）', () => {
  /** scheduler 目前的終局狀態：每個 key 最後一次被送進去的值。 */
  function finalState() {
    const enabled = {}
    for (const [key, value] of schedulerMocks.setEnabled.mock.calls) enabled[key] = value
    const scaleCalls = schedulerMocks.setScale.mock.calls
    return { enabled, scale: scaleCalls.length ? scaleCalls.at(-1)[0] : null }
  }

  it('疊加層生效時：倍率提到 3、face／object 關掉，pose 仍跟著基準層', async () => {
    const svc = await initSvc()
    svc.setEnabled('pose', true)
    svc.setEnabled('face', true)
    svc.setEnabled('object', true)
    svc.setScale(1)

    svc.setCalibrationBoost(true)

    const s = finalState()
    expect(s.scale).toBe(3)
    expect(s.enabled).toMatchObject({ pose: true, face: false, object: false })
  })

  it('疊加層生效期間，store 寫進來的基準值不會把提頻打掉（另一個方向）', async () => {
    const svc = await initSvc()
    svc.setCalibrationBoost(true)
    svc.setScale(0.5) // 例如某個轉場的 syncInferenceScale()
    expect(finalState().scale, '校準還沒結束，倍率不該被收斂打回去').toBe(3)

    svc.setCalibrationBoost(false)
    expect(finalState().scale, '疊加層一拿掉，立刻回到基準層寫的那個值').toBe(0.5)
  })

  /**
   * 這一條是 B1 的核心。
   *
   * 舊寫法裡元件的 restore() 寫的是**絕對值**，所以「store 收斂」與「元件還原」
   * 誰最後跑，結果就不一樣——而流程反轉正好把順序倒了過來。
   * 現在兩者的關係變成「store 寫基準、元件翻疊加層」，兩條路徑對同一份基準層
   * 算出同一個結果，所以**任何交錯順序的終局都必須一模一樣**。
   *
   * 這條測試不鏡射實作：它不檢查任何內部欄位，只比較兩種交錯順序跑完之後
   * scheduler 看到的終局，並且要求那個終局等於基準層本身。
   */
  it('不管「拿掉疊加層」排在 store 收斂之前還是之後，終局都等於基準層', async () => {
    // 工作人員在設定面板關掉手機偵測 ⇒ store 收斂出來的基準是 object=false。
    const base = { pose: true, face: true, object: false, scale: 0.5 }

    function applyBase(svc) {
      svc.setEnabled('pose', base.pose)
      svc.setEnabled('face', base.face)
      svc.setEnabled('object', base.object)
      svc.setScale(base.scale)
    }

    // 順序 A：元件先卸載（restore），store 後收斂
    const a = await initSvc()
    a.setCalibrationBoost(true)
    a.setCalibrationBoost(false)
    applyBase(a)
    const stateA = finalState()

    // 順序 B：store 先收斂，元件的卸載落在後面（＝流程反轉之後真正發生的順序）
    schedulerMocks.setEnabled.mockClear()
    schedulerMocks.setScale.mockClear()
    const b = await initSvc()
    b.setCalibrationBoost(true)
    applyBase(b)
    b.setCalibrationBoost(false)
    const stateB = finalState()

    expect(stateB).toEqual(stateA)
    expect(stateB.enabled, '手機偵測被工作人員關掉，就必須是關的').toMatchObject({
      pose: true, face: true, object: false,
    })
    expect(stateB.scale, '降檔中的倍率不得被校準還原打回全解析度').toBe(0.5)
  })
})
