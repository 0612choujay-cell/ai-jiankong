/**
 * 任務類型決定姿態閾值。看書／寫作業本來就會低頭，
 * 用同一組閾值會整場都在喊「你低頭了」。
 *
 * spec 的「容許角度 +15°」在正規化比值下換算為「容許值放寬 50%」。
 *
 * ⚠ 下面 BASE 的四個數字仍然是佔位值，沒有人在 iPad 上用 thresholdLab
 * 量出真值——這條警語沒有拿掉。實機驗收回報「駝背判斷太寬鬆」（真的塌下去
 * 也不太會觸發）之後，這一輪把 neckDropRatio／shoulderGrowRatio 往下調緊
 * 一截（0.12→0.10／0.12→0.09，homework/reading 的 0.18→0.16），理由是
 * 「小孩收到的懲罰是誤判太少、不是誤判太多」這個方向性的實機證據，但**幅度**
 * 依然是推測，不是量出來的——下一輪真機測試要記得回頭看這兩個數字對不對，
 * 該用 thresholdLab 量真值這件事沒有變。
 */

const BASE = {
  // neckRatio 相對基準下降超過此比例 → 頭部前傾
  neckDropRatio: 0.10,
  // shoulderWidth 相對基準增加超過此比例 → 身體塌向桌面
  shoulderGrowRatio: 0.09,
  // 頭歪／撐頭這兩個不像上面兩個是「相對校準基準的變化量」——校準只收
  // neckRatio／shoulderWidth 兩個量，沒有人在校準時特地量「正常歪頭幾度」
  // 或「手正常放哪裡」當基準。這兩個是直接跟 poseGeometry.js 算出來的
  // 幾何比值比大小的絕對門檻（用肩寬正規化過，不受距離鏡頭遠近影響），
  // 跟同檔案 GAZE_SIDE_THRESHOLD 那組是同一種做法。任務類型不影響「頭歪」
  // 「撐頭」該不該算壞姿勢（不像低頭，寫作業本來就要低頭），所以不分
  // homework/reading 覆寫，四種任務共用同一組。
  //
  // 兩個數字都還沒有真機量測資料，是跟 GAZE_* 那幾個佔位值同一個性質的
  // 推算值——下一輪真機測試要用 thresholdLab 量真值回來覆蓋。
  headTiltRatio: 0.30,
  handPropRatio: 0.55,
  // 狀態需在窗口內持有多久才成立
  postureHoldMs: 3000,
  gazeAwayHoldMs: 2000,
  // 駝背是否必須「前傾且肩線塌陷」同時成立
  requireBothForSlouch: false,
}

export const PROFILES = Object.freeze({
  homework: Object.freeze({ ...BASE, neckDropRatio: 0.16, requireBothForSlouch: true }),
  reading:  Object.freeze({ ...BASE, neckDropRatio: 0.16, requireBothForSlouch: true }),
  vocab:    Object.freeze({ ...BASE }),
  custom:   Object.freeze({ ...BASE }),
})

export function profileFor(taskType) {
  return PROFILES[taskType] ?? PROFILES.custom
}
