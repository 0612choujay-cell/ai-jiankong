/**
 * 單向緊急降檔。
 *
 * 只有一檔、而且不可升回：反覆升降會在臨界點附近震盪，
 * 使用者會看到偵測時快時慢卻找不到原因。
 *
 * 刻意只看推論延遲，不看 rAF 掉幀率——在主執行緒架構下掉幀多半來自
 * 動畫與 Chart.js，降推論頻率救不了，只會一路降到底把偵測卡死。
 *
 * `sustainMs` 這個視窗的語意是「持續超標 10 秒」，而「持續」隱含連續取樣。
 * 呼叫端（session.js 的 frame()）只在 `!state.paused` 的每一個 rAF 都呼叫
 * sample()——暫停、切背景／螢幕鎖（rAF 根本不觸發）、兩場之間的交接／校準／
 * 選任務（迴圈已停），這些期間完全不會呼叫 sample()。`overSince` 是牆鐘時間戳，
 * 如果只在「有取樣、而且低於門檻」時才清掉，這些空窗期間它不會被作廢——取樣
 * 恢復時 `now` 已經是幾十秒甚至幾分鐘後，`now - overSince >= sustainMs`
 * 在恢復後第一幀就成立，等於「暫停久一點」或「換下一位訪客」就能無中生有
 * 觸發一次降檔（複審 B-1 的 PROBE-1／PROBE-2）。
 *
 * 修法：sample() 自己記上一次被呼叫的時間，一旦兩次呼叫之間的間隔超過
 * `gapMs`，視為取樣中斷過，把 overSince 作廢——中斷之前累積的那一截不再
 * 構成「持續超標」的證據，若中斷當下仍然超標，就在這一筆重新起算。
 *
 * gapMs 預設 2000（2 秒），憑什麼是這個數字，而不是隨便挑一個：
 * - sample() 是跟著 rAF 走的（frame() 每一幀都呼叫一次，不是跟著
 *   inferenceScheduler 的模型頻率走——見 inferenceScheduler.js 的
 *   fps 範圍 0.33~3fps／interval 333~3030ms，那是「模型多久跑一次」，
 *   不是「rAF 多久觸發一次」）。60fps 下 rAF 間隔是 16.7ms；即使
 *   `inference.step()` 因為模型變慢而拉長單幀耗時（這正是 latencyEma
 *   會超標的原因），也是那一次 await 變長，不是 rAF 停止——真實裝置上
 *   一次 await 拉到 2 秒是「卡死」等級的異常，不是「持續超標」的正常樣態。
 * - 這個專案在同一個 rAF 迴圈裡已經有兩個做同一件事的既有常數，這裡刻意
 *   跟它們對齊，不是自己另挑一個：session.js 的 `FRESHNESS_TIMEOUT_MS`
 *   （2000ms，「多久沒有新資料就不能再信任舊資料」）跟
 *   focusStateMachine.js 的 dt 上限（`Math.min(t - lastTickAt, 2000)`，
 *   「單次 tick 最多只能代表 2 秒的流逝時間」），兩者都已經在同一個
 *   session.js frame() 迴圈裡把 2 秒當作「還算同一段連續執行」跟
 *   「中間已經斷過」的分界。poseAnalyzer.js 的 `MAX_SAMPLE_GAP_MS`
 *   （1500ms）是同一個概念，但那是給 Pose/Face 這種 0.33~2fps 的取樣
 *   節奏用的，跟這裡跟著 rAF 走的取樣節奏不是同一個時間尺度，不能直接
 *   套用同一個數字。
 * - 2 秒遠大於任何真實的連續 rAF 間隔，又遠小於任何一次真正的空窗
 *   （暫停、切背景、交接／校準／選任務，實測都是幾十秒到幾分鐘），
 *   兩邊都留了足夠的安全邊界。
 */
export function createPerfMonitor({ thresholdMs = 150, sustainMs = 10_000, gapMs = 2000 } = {}) {
  let overSince = null
  let downshifted = false
  let lastSampleAt = null

  return {
    sample(latencyEma, now) {
      if (downshifted) return 'ok'

      // 取樣中斷過（暫停／背景／輪次交接）：中斷之前累積的超標時間不再
      // 構成「持續超標」的證據，作廢重算。第一次呼叫（lastSampleAt 為
      // null）沒有「上一次」可比，不算中斷。
      if (lastSampleAt !== null && now - lastSampleAt > gapMs) {
        overSince = null
      }
      lastSampleAt = now

      if (latencyEma > thresholdMs) {
        if (overSince === null) overSince = now
        if (now - overSince >= sustainMs) {
          downshifted = true
          overSince = null
          return 'downshift'
        }
      } else {
        overSince = null
      }
      return 'ok'
    },

    isDownshifted: () => downshifted,

    reset() {
      overSince = null
      downshifted = false
      lastSampleAt = null
    },
  }
}
