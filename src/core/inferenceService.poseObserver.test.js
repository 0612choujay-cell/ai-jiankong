import { vi, describe, it, expect, beforeEach } from 'vitest'

/**
 * `inferenceService.onPoseFrame()`——骨架線疊加用的唯一原始 landmark 出口。
 *
 * ── 為什麼這一組測試單獨一個檔案 ────────────────────────────────────
 *
 * 這個專案已經有「一個模組、多個測試檔」的慣例（`session.*.test.js` 有七個），
 * 判準是「守的是不同的契約」。`inferenceService.test.js` 守的是排程契約
 * （單一 in-flight、失敗可觀察但不外洩）；這個檔案守的是**隱私界線本身**：
 * 座標從哪裡出來、出來之後誰碰得到、以及那條出口**沒有**順帶把座標塞進
 * 既有的資料流。兩件事的判準與突變點完全不同，混在一起只會讓兩邊都模糊。
 *
 * ── 這一組鎖得到什麼、鎖不到什麼（誠實記錄）────────────────────────
 *
 * 鎖得到：
 *   - `step()` 的回傳形狀沒有因此多出任何欄位（那是壓縮界線的形狀本身）。
 *   - 座標只用推的、沒有任何可以事後查詢的入口（API 清單完全相等比對）。
 *   - 繪圖成本不會被算進 `latencyEma`（那是單向不可升回降檔唯一的判準）。
 *   - 訂閱者壞掉不會讓 pose track 被判成失敗。
 *
 * 鎖不到：
 *   - 訂閱者自己把 landmarks 存起來。那是訂閱者那一層的事，護欄裝在
 *     `PoseSkeletonOverlay.test.js`（DOM canary ＋ setupState 遞迴掃描）。
 *   - 「真的畫出來對不對」。canvas 的像素沒有任何自動化測試看得到，
 *     那只能靠實機。
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

vi.stubGlobal('navigator', { userAgent: 'vitest' })
vi.stubGlobal('OffscreenCanvas', class {})

// 可控時鐘：latencyMs 是 performance.now() 的差，要驗「繪圖不算在裡面」就得
// 能決定每一次呼叫回傳什麼。
let clock = 0
vi.stubGlobal('performance', { now: () => clock })

const { createInferenceService } = await import('./inferenceService.js')

function fakeVideo() {
  return { readyState: 4, videoWidth: 640, videoHeight: 480 }
}

async function initSvc() {
  const svc = createInferenceService({ videoEl: fakeVideo() })
  const r = await svc.init()
  expect(r.ok).toBe(true)
  return svc
}

/**
 * 一組 33 點的假 landmarks，四個關鍵點（兩耳、兩肩）給明顯可辨識的值。
 * 座標值刻意用哨兵形狀的小數，方便其他測試檔比對同一組數字。
 */
function makeLandmarks() {
  const pts = []
  for (let i = 0; i < 33; i += 1) pts.push({ x: 0.5, y: 0.5, visibility: 0.9 })
  pts[7] = { x: 0.123456, y: 0.222222, visibility: 0.9 } // 左耳
  pts[8] = { x: 0.654321, y: 0.222222, visibility: 0.9 } // 右耳
  pts[11] = { x: 0.111111, y: 0.777777, visibility: 0.9 } // 左肩
  pts[12] = { x: 0.888888, y: 0.777777, visibility: 0.9 } // 右肩
  return pts
}

beforeEach(() => {
  clock = 0
  for (const m of Object.values(schedulerMocks)) m.mockReset()
  taskMocks.pose.detectForVideo.mockReset().mockReturnValue({ landmarks: [] })
  taskMocks.face.detectForVideo.mockReset().mockReturnValue({ faceBlendshapes: [] })
  taskMocks.object.detectForVideo.mockReset().mockReturnValue({ detections: [] })
  schedulerMocks.pick.mockReturnValue(null)
})

describe('onPoseFrame()：座標只用推的，而且只推那一幀', () => {
  it('pose 這一輪把 detectForVideo() 當場回傳的那個陣列原樣推給訂閱者', async () => {
    const svc = await initSvc()
    const landmarks = makeLandmarks()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [landmarks] })
    schedulerMocks.pick.mockReturnValue('pose')

    const seen = []
    svc.onPoseFrame((l) => seen.push(l))
    await svc.step(100)

    expect(seen.length).toBe(1)
    // toBe（同一個參照）而不是 toEqual：骨架線的來源必須是原始結果本身，
    // 不是從壓縮後的 metrics 反推出來的東西。
    expect(seen[0]).toBe(landmarks)
  })

  it('沒偵測到人時推 null——畫布才清得掉，不會卡在上一幀的殘影', async () => {
    const svc = await initSvc()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [] })
    schedulerMocks.pick.mockReturnValue('pose')

    const seen = []
    svc.onPoseFrame((l) => seen.push(l))
    await svc.step(100)

    expect(seen).toEqual([null])
  })

  it('face／object 這兩輪完全不通知——那兩條 track 根本沒有 landmark', async () => {
    const svc = await initSvc()
    const seen = []
    svc.onPoseFrame((l) => seen.push(l))

    schedulerMocks.pick.mockReturnValue('face')
    await svc.step(100)
    schedulerMocks.pick.mockReturnValue('object')
    await svc.step(200)

    expect(seen).toEqual([])
  })

  it('沒有任何「事後查詢」的入口：對外 API 清單完全相等比對', async () => {
    const svc = await initSvc()
    // 完全相等比對（不是 toContain）：新增任何一個對外方法都必須被有意識地
    // 核准過。這條擋的是「加一個 lastLandmarks() 方便除錯」——有了它，
    // 任何人在任何時間點都能把座標撈出來放進任何地方，推送式設計就白做了。
    expect(Object.keys(svc).sort()).toEqual([
      'actualFps',
      'destroy',
      'health',
      'init',
      'isReady',
      'latencyEma',
      'onPoseFrame',
      'setCalibrationBoost',
      'setEnabled',
      'setScale',
      'step',
    ])
  })

  it('連續兩幀推的是各自那一幀的陣列，服務本身不留快取', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('pose')
    const a = makeLandmarks()
    const b = makeLandmarks()

    const seen = []
    svc.onPoseFrame((l) => seen.push(l))

    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [a] })
    await svc.step(100)
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [b] })
    await svc.step(200)

    expect(seen[0]).toBe(a)
    expect(seen[1]).toBe(b)
  })
})

describe('onPoseFrame()：不得碰到既有的壓縮界線', () => {
  it('step() 的回傳形狀一個欄位都沒變，metrics 仍然只有純量（沒有夾帶原始座標）', async () => {
    const svc = await initSvc()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    schedulerMocks.pick.mockReturnValue('pose')
    svc.onPoseFrame(() => {})

    const r = await svc.step(100)

    // 這兩條就是那條「壓縮界線」的形狀本身。骨架線若圖方便讓 step() 順便
    // 回傳 landmarks，session.js／focusStateMachine.js／storageService.js
    // 的 ALLOWED_FIELDS 全部都要重新審查一次隱私。
    // tiltRatio／handNearRatio／earsValid 是這一輪新增的頭歪／撐頭偵測純量
    // （見 poseGeometry.js），跟 neckRatio／shoulderWidth 同一種東西——
    // 純數字，不是座標，加進來不影響這條護欄要鎖的事。
    expect(Object.keys(r).sort()).toEqual(['key', 'latencyMs', 'metrics'])
    expect(Object.keys(r.metrics).sort()).toEqual(
      ['earsValid', 'handNearRatio', 'neckRatio', 'shoulderWidth', 'tiltRatio', 'valid'],
    )
  })

  it('訂閱／解除訂閱都不碰任何既有的 setter（不是「順便」改推論設定的後門）', async () => {
    const svc = await initSvc()
    schedulerMocks.setScale.mockClear()
    schedulerMocks.setEnabled.mockClear()

    const off = svc.onPoseFrame(() => {})
    off()

    expect(schedulerMocks.setScale).not.toHaveBeenCalled()
    expect(schedulerMocks.setEnabled).not.toHaveBeenCalled()
  })

  it('推送那一幀也不碰任何既有的 setter', async () => {
    const svc = await initSvc()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    schedulerMocks.pick.mockReturnValue('pose')
    svc.onPoseFrame(() => {})
    schedulerMocks.setScale.mockClear()
    schedulerMocks.setEnabled.mockClear()

    await svc.step(100)

    expect(schedulerMocks.setScale).not.toHaveBeenCalled()
    expect(schedulerMocks.setEnabled).not.toHaveBeenCalled()
  })
})

describe('onPoseFrame()：繪圖成本不得推高降檔判準（單向、不可升回）', () => {
  it('訂閱者花掉的時間不算進 latencyMs／latencyEma', async () => {
    const svc = await initSvc()
    schedulerMocks.pick.mockReturnValue('pose')
    // 推論本身花 10ms
    taskMocks.pose.detectForVideo.mockImplementation(() => {
      clock += 10
      return { landmarks: [makeLandmarks()] }
    })
    // 訂閱者（繪圖）花 500ms——遠超過 perfMonitor 的 150ms 門檻
    svc.onPoseFrame(() => { clock += 500 })

    const r = await svc.step(100)

    // 這一條就是全部的鑑別力：把 notifyPoseFrame() 移到 latencyMs 算出來
    // 之前，這裡會變成 510，而 perfMonitor 會在 10 秒內觸發那個**再也升不
    // 回來**的降檔——等於「畫骨架線」自己把偵測頻率降下去。
    expect(r.latencyMs).toBe(10)
    expect(svc.latencyEma()).toBe(10)
  })
})

describe('onPoseFrame()：訂閱者壞掉不得汙染推論', () => {
  it('訂閱者丟例外時，step() 照樣回傳結果、pose track 不被記成失敗', async () => {
    const svc = await initSvc()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    schedulerMocks.pick.mockReturnValue('pose')
    svc.onPoseFrame(() => { throw new TypeError('canvas 壞了') })

    const r = await svc.step(100)

    expect(r?.key).toBe('pose')
    expect(r.metrics.valid).toBe(true)
    // 若例外冒到 step() 的 catch：consecutiveFailures 會變 1、step() 回 null，
    // 於是「骨架線畫錯」會升級成「整場偵測不到姿勢」。
    expect(svc.health().pose.consecutiveFailures).toBe(0)
    expect(svc.health().pose.lastErrorName).toBe(null)
    expect(schedulerMocks.complete).toHaveBeenCalledTimes(1)
  })

  it('其中一個訂閱者丟例外，另一個照樣收得到', async () => {
    const svc = await initSvc()
    const landmarks = makeLandmarks()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [landmarks] })
    schedulerMocks.pick.mockReturnValue('pose')

    const seen = []
    svc.onPoseFrame(() => { throw new Error('boom') })
    svc.onPoseFrame((l) => seen.push(l))

    await svc.step(100)

    expect(seen).toEqual([landmarks])
  })
})

describe('onPoseFrame()：訂閱的生命週期', () => {
  it('解除訂閱之後不再收到，重複解除是安全的', async () => {
    const svc = await initSvc()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    schedulerMocks.pick.mockReturnValue('pose')

    const seen = []
    const off = svc.onPoseFrame((l) => seen.push(l))
    await svc.step(100)
    expect(seen.length).toBe(1)

    off()
    off() // 冪等：元件卸載路徑可能走兩次（watch 清理 ＋ onBeforeUnmount）
    await svc.step(200)

    expect(seen.length, '解除訂閱之後這一幀不該再推給它').toBe(1)
  })

  it('兩個畫面在轉場那一瞬間同時訂閱時，兩個都收得到（不是單槽靜默覆蓋）', async () => {
    const svc = await initSvc()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    schedulerMocks.pick.mockReturnValue('pose')

    const a = []
    const b = []
    svc.onPoseFrame((l) => a.push(l))
    svc.onPoseFrame((l) => b.push(l))
    await svc.step(100)

    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
  })

  it('傳非函式進去不會被登記，回傳的仍然是一個可以安全呼叫的解除函式', async () => {
    // 誠實記錄這條測試的鑑別力邊界：`onPoseFrame(null)` 有沒有把 null 推進
    // 清單，從外面**看不出來**（notifyPoseFrame 的 try/catch 會把它吞掉）。
    // 這條鎖得住的是「回傳值一定是可呼叫的」——呼叫端（元件的卸載路徑）
    // 無條件會呼叫它，回傳一個非函式會在卸載時炸成 TypeError。
    const svc = await initSvc()
    const off = svc.onPoseFrame(null)
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()

    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    schedulerMocks.pick.mockReturnValue('pose')
    await expect(svc.step(100)).resolves.toBeTruthy()
  })

  it('destroy() 會把訂閱者清單一起清掉', async () => {
    const svc = await initSvc()
    taskMocks.pose.detectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    schedulerMocks.pick.mockReturnValue('pose')

    const seen = []
    svc.onPoseFrame((l) => seen.push(l))
    await svc.step(100)
    expect(seen.length).toBe(1)

    svc.destroy()
    // destroy() 之後 ready=false，step() 早退；這裡再 init 一次證明清單真的
    // 空了，而不是「因為 step() 沒跑到」才沒有推送。
    await svc.init()
    await svc.step(200)

    expect(seen.length).toBe(1)
  })
})
