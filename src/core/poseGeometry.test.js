import { describe, it, expect } from 'vitest'
import { poseMetrics, faceMetrics } from './poseGeometry.js'

// MediaPipe pose landmark 索引：7 左耳 8 右耳 11 左肩 12 右肩
function makeLandmarks({ earY, shoulderY, shoulderHalfWidth, visibility = 0.9 }) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  pts[7] = { x: 0.5 - shoulderHalfWidth * 0.4, y: earY, z: 0, visibility }
  pts[8] = { x: 0.5 + shoulderHalfWidth * 0.4, y: earY, z: 0, visibility }
  pts[11] = { x: 0.5 - shoulderHalfWidth, y: shoulderY, z: 0, visibility }
  pts[12] = { x: 0.5 + shoulderHalfWidth, y: shoulderY, z: 0, visibility }
  return pts
}

describe('poseMetrics', () => {
  it('端正坐姿：neckRatio 為正、shoulderWidth 等於兩肩距離', () => {
    const m = poseMetrics(makeLandmarks({ earY: 0.30, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    expect(m.valid).toBe(true)
    expect(m.shoulderWidth).toBeCloseTo(0.30, 5)
    expect(m.neckRatio).toBeCloseTo(0.30 / 0.30, 5) // (0.60-0.30)/0.30
  })

  it('低頭時 neckRatio 變小', () => {
    const upright = poseMetrics(makeLandmarks({ earY: 0.30, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    const down = poseMetrics(makeLandmarks({ earY: 0.45, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    expect(down.neckRatio).toBeLessThan(upright.neckRatio)
  })

  it('靠近鏡頭時 shoulderWidth 變大', () => {
    const far = poseMetrics(makeLandmarks({ earY: 0.30, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    const near = poseMetrics(makeLandmarks({ earY: 0.25, shoulderY: 0.62, shoulderHalfWidth: 0.22 }))
    expect(near.shoulderWidth).toBeGreaterThan(far.shoulderWidth)
  })

  it('可見度不足時 valid 為 false', () => {
    expect(poseMetrics(makeLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15, visibility: 0.2 })).valid).toBe(false)
  })

  it('landmarks 為空或長度不足時 valid 為 false，不得丟例外', () => {
    expect(poseMetrics(null).valid).toBe(false)
    expect(poseMetrics([]).valid).toBe(false)
  })

  it('肩寬趨近 0 時 valid 為 false（避免除以零）', () => {
    expect(poseMetrics(makeLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.0005 })).valid).toBe(false)
  })
})

// MediaPipe pose landmark 索引：15 左手腕 16 右手腕（跟檔頭 EAR_L/EAR_R/
// SHOULDER_L/SHOULDER_R 同一組官方 33 點拓樸，見 poseGeometry.js 的常數）。
function makeFullLandmarks({
  earY, shoulderY, shoulderHalfWidth, visibility = 0.9, earVisibility = visibility, wristL = null, wristR = null,
}) {
  const pts = makeLandmarks({ earY, shoulderY, shoulderHalfWidth, visibility })
  pts[7] = { ...pts[7], visibility: earVisibility }
  pts[8] = { ...pts[8], visibility: earVisibility }
  pts[15] = wristL ?? { x: 5, y: 5, visibility: 0 } // 預設遠離頭部、不可見＝沒有在撐頭
  pts[16] = wristR ?? { x: -5, y: 5, visibility: 0 }
  return pts
}

describe('poseMetrics：耳朵能見度與肩膀能見度分開判斷（實機驗收：低頭時常被整幀判 invalid）', () => {
  it('耳朵不可見、肩膀可見：valid 仍為 true（塌陷偵測只需要肩膀），但 earsValid 為 false', () => {
    const m = poseMetrics(makeFullLandmarks({
      earY: 0.45, shoulderY: 0.6, shoulderHalfWidth: 0.2, earVisibility: 0.1,
    }))
    expect(m.valid).toBe(true)
    expect(m.earsValid).toBe(false)
    expect(m.shoulderWidth).toBeCloseTo(0.4, 5)
  })

  it('耳朵不可見時，neckRatio／tiltRatio／handNearRatio 一律回傳安全預設值，不是量到一半的髒資料', () => {
    const m = poseMetrics(makeFullLandmarks({
      earY: 0.45, shoulderY: 0.6, shoulderHalfWidth: 0.2, earVisibility: 0.1,
    }))
    expect(m.neckRatio).toBe(0)
    expect(m.tiltRatio).toBe(0)
    expect(m.handNearRatio).toBe(Infinity)
  })

  it('雙耳可見時 earsValid 為 true', () => {
    const m = poseMetrics(makeFullLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15 }))
    expect(m.earsValid).toBe(true)
  })
})

describe('poseMetrics：歪頭（tiltRatio）', () => {
  it('兩耳等高：tiltRatio 為 0', () => {
    const m = poseMetrics(makeFullLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15 }))
    expect(m.tiltRatio).toBeCloseTo(0, 5)
  })

  it('歪頭：其中一耳明顯偏低，tiltRatio 隨落差變大', () => {
    const pts = makeFullLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15 })
    pts[8] = { ...pts[8], y: 0.45 } // 右耳往下掉，模擬頭往右肩歪
    const m = poseMetrics(pts)
    expect(m.tiltRatio).toBeCloseTo(0.15 / 0.3, 5) // |0.45-0.30| / shoulderWidth(0.3)
  })
})

describe('poseMetrics：撐頭（handNearRatio）', () => {
  it('手腕遠離頭部（預設值）：handNearRatio 為 Infinity，不會被誤判成撐頭', () => {
    const m = poseMetrics(makeFullLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15 }))
    expect(m.handNearRatio).toBe(Infinity)
  })

  it('手腕貼近耳朵：handNearRatio 隨距離縮小', () => {
    const pts = makeFullLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15 })
    // 右耳在 (0.5+0.06, 0.30)；手腕貼上去，只差 0.03 的水平距離
    pts[16] = { x: 0.5 + 0.06 + 0.03, y: 0.30, visibility: 0.9 }
    const m = poseMetrics(pts)
    expect(m.handNearRatio).toBeCloseTo(0.03 / 0.3, 5)
  })

  it('手腕能見度不足：視為那隻手不存在，不強迫整幀失效、也不算撐頭', () => {
    const pts = makeFullLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15 })
    pts[16] = { x: 0.5 + 0.06 + 0.03, y: 0.30, visibility: 0.1 } // 位置貼著耳朵，但能見度太低
    const m = poseMetrics(pts)
    expect(m.valid).toBe(true)
    expect(m.handNearRatio).toBe(Infinity)
  })

  it('兩手都貼近頭：取較近的那一隻', () => {
    const pts = makeFullLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15 })
    pts[15] = { x: 0.5 - 0.06 - 0.10, y: 0.30, visibility: 0.9 } // 左手腕，距離 0.10
    pts[16] = { x: 0.5 + 0.06 + 0.02, y: 0.30, visibility: 0.9 } // 右手腕，距離 0.02（較近）
    const m = poseMetrics(pts)
    expect(m.handNearRatio).toBeCloseTo(0.02 / 0.3, 5)
  })
})

function bs(map) {
  return Object.entries(map).map(([categoryName, score]) => ({ categoryName, score }))
}

// MediaPipe FaceLandmarker 478 點網格：33/133 右眼兩眼角、468 右虹膜中心；
// 263/362 左眼兩眼角、473 左虹膜中心（索引來源見 poseGeometry.js 的
// irisSideOffset() 檔頭註解——直接 import @mediapipe/tasks-vision 在
// Node 印出官方常數核對過，不是猜的）。
function makeFaceLandmarks({ offsetRatio = 0, eyeWidth = 0.05, length = 478 } = {}) {
  const pts = Array.from({ length }, () => ({ x: 0.5, y: 0.5 }))
  const set = (i, x) => { if (i < length) pts[i] = { x, y: 0.5 } }
  const rCenterX = 0.30
  set(33, rCenterX - eyeWidth / 2)
  set(133, rCenterX + eyeWidth / 2)
  set(468, rCenterX + offsetRatio * eyeWidth)
  const lCenterX = 0.70
  set(263, lCenterX - eyeWidth / 2)
  set(362, lCenterX + eyeWidth / 2)
  set(473, lCenterX + offsetRatio * eyeWidth)
  return pts
}

describe('faceMetrics', () => {
  it('雙眼閉合分數高於門檻視為閉眼', () => {
    expect(faceMetrics(bs({ eyeBlinkLeft: 0.8, eyeBlinkRight: 0.75 })).eyeClosed).toBe(true)
    expect(faceMetrics(bs({ eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 })).eyeClosed).toBe(false)
  })

  it('視線往下判為 down（看書，不算分心）', () => {
    expect(faceMetrics(bs({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6 })).gaze).toBe('down')
  })

  it('往下優先於往旁：低頭斜看書不得被判成分心', () => {
    const m = faceMetrics(bs({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6, eyeLookOutLeft: 0.7 }))
    expect(m.gaze).toBe('down')
  })

  it('視線往旁或往上判為 away', () => {
    // 往左看時左眼外轉、右眼同時往鼻子方向內轉，兩訊號同時升高才是生理上
    // 一致的側視（兩眼同時「外轉」是不可能的姿勢，不能拿來當測試資料）
    expect(faceMetrics(bs({ eyeLookOutLeft: 0.6, eyeLookInRight: 0.55 })).gaze).toBe('away')
    expect(faceMetrics(bs({ eyeLookUpLeft: 0.6, eyeLookUpRight: 0.6 })).gaze).toBe('away')
  })

  it('都不明顯時判為 center', () => {
    expect(faceMetrics(bs({ eyeLookDownLeft: 0.1, eyeLookOutLeft: 0.1 })).gaze).toBe('center')
  })

  it('blendshapes 為空時 gaze 為 center、eyeClosed 為 false、valid 為 false（沒偵測到臉）', () => {
    expect(faceMetrics(null)).toEqual({ eyeClosed: false, gaze: 'center', valid: false })
    expect(faceMetrics([])).toEqual({ eyeClosed: false, gaze: 'center', valid: false })
  })

  it('真的偵測到臉時 valid 為 true', () => {
    expect(faceMetrics(bs({ eyeLookDownLeft: 0.1 })).valid).toBe(true)
  })
})

describe('faceMetrics：虹膜座標側視偵測（face_landmarker.task 本來就有算，這次開始讀）', () => {
  it('沒有傳 landmarks（第二參數省略）：行為跟舊版一模一樣，只看 blendshape', () => {
    // 舊呼叫端（還沒改的地方，或量不到 faceLandmarks 的情境）不必跟著改，
    // 這是相容性保證，不是順便測到的副作用。
    expect(faceMetrics(bs({ eyeLookOutLeft: 0.1, eyeLookInRight: 0.1 })).gaze).toBe('center')
  })

  it('blendshape 都不明顯，但虹膜明顯偏向一側 → away（新訊號真的能單獨觸發判定）', () => {
    const landmarks = makeFaceLandmarks({ offsetRatio: 0.25 }) // > IRIS_SIDE_THRESHOLD(0.15)
    const m = faceMetrics(bs({ eyeLookOutLeft: 0.05, eyeLookInRight: 0.05 }), landmarks)
    expect(m.gaze).toBe('away')
  })

  it('虹膜置中（offsetRatio 0）、blendshape 也不明顯 → center', () => {
    const landmarks = makeFaceLandmarks({ offsetRatio: 0 })
    const m = faceMetrics(bs({ eyeLookOutLeft: 0.05, eyeLookInRight: 0.05 }), landmarks)
    expect(m.gaze).toBe('center')
  })

  it('虹膜偏移低於門檻 → 不觸發（跟門檻本身的存在對帳，不是只測極端值）', () => {
    const landmarks = makeFaceLandmarks({ offsetRatio: 0.05 }) // < IRIS_SIDE_THRESHOLD(0.15)
    const m = faceMetrics(bs({ eyeLookOutLeft: 0.05, eyeLookInRight: 0.05 }), landmarks)
    expect(m.gaze).toBe('center')
  })

  it('往下優先於虹膜側視：低頭時虹膜也會跟著偏移，但不能被判成分心', () => {
    const landmarks = makeFaceLandmarks({ offsetRatio: 0.25 })
    const m = faceMetrics(bs({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6 }), landmarks)
    expect(m.gaze).toBe('down')
  })

  it('眼寬量不到（太小）時虹膜訊號視為 0，退回只看 blendshape，不會誤觸發', () => {
    const landmarks = makeFaceLandmarks({ offsetRatio: 0.5, eyeWidth: 0.005 }) // 小於 MIN_EYE_WIDTH
    const m = faceMetrics(bs({ eyeLookOutLeft: 0.05, eyeLookInRight: 0.05 }), landmarks)
    expect(m.gaze).toBe('center')
  })

  it('landmarks 長度不足 478（沒有虹膜點的模型版本）：不得丟例外，視為沒有這個訊號', () => {
    const short = makeFaceLandmarks({ offsetRatio: 0.5, length: 100 })
    expect(() => faceMetrics(bs({ eyeLookOutLeft: 0.05, eyeLookInRight: 0.05 }), short)).not.toThrow()
    expect(faceMetrics(bs({ eyeLookOutLeft: 0.05, eyeLookInRight: 0.05 }), short).gaze).toBe('center')
  })

  it('landmarks 是 null／不是陣列：不得丟例外，等同沒有這個訊號', () => {
    expect(() => faceMetrics(bs({}), null)).not.toThrow()
    expect(() => faceMetrics(bs({}), {})).not.toThrow()
    expect(faceMetrics(bs({ eyeLookOutLeft: 0.05, eyeLookInRight: 0.05 }), null).gaze).toBe('center')
  })

  it('blendshape 本身已經過線時，虹膜訊號量不到也不影響既有判定（新訊號只加分，不扣分）', () => {
    const m = faceMetrics(bs({ eyeLookOutLeft: 0.6, eyeLookInRight: 0.55 }), null)
    expect(m.gaze).toBe('away')
  })
})
