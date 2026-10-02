/**
 * 唯一碰 getUserMedia 的檔。
 *
 * 隱私紅線：audio 永遠是 false，任何情況都不得改。
 * 麥克風連要都不要，評審問起來才能直接回答「這個 App 沒有要過麥克風權限」。
 */
const CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { max: 15 },
  },
}

export function createCameraCapture({ videoEl, onEnded }) {
  let stream = null
  let generation = 0

  function track() {
    return stream ? stream.getVideoTracks()[0] ?? null : null
  }

  function detach() {
    if (stream) {
      for (const t of stream.getTracks()) {
        t.onended = null
        t.stop()
      }
    }
    stream = null
    if (videoEl) videoEl.srcObject = null
  }

  /**
   * 非同步開啟 stream。
   * @param {number} expectedGen - 呼叫端期待的世代。
   *        若 getUserMedia resolve 時世代已改變（更新或停止）則丟棄 stream。
   * @returns {Promise<boolean>} 成功寫入回傳 true；被取代回傳 false。
   */
  async function open(expectedGen) {
    const next = await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
    // 檢查世代是否仍符合，不符合表示此呼叫已被取代或被 stop() 打斷
    if (expectedGen !== generation) {
      next.getTracks().forEach(t => t.stop())
      return false
    }
    stream = next
    const t = track()
    if (t) t.onended = () => onEnded?.()
    videoEl.srcObject = next
    videoEl.setAttribute('playsinline', '')
    videoEl.muted = true
    await videoEl.play()
    return true
  }

  function getReadyState() {
    const t = track()
    return t ? t.readyState : 'none'
  }

  function setTrackEnabled(enabled) {
    const t = track()
    if (t) t.enabled = enabled
  }

  async function start() {
    generation += 1
    const myGen = generation
    try {
      detach()
      const success = await open(myGen)
      // open() 直接回傳成功/被取代的標記，不用看共享的 stream 變數
      if (!success) {
        return { ok: false, error: new Error('Superseded by newer start() call') }
      }
      return { ok: true }
    } catch (error) {
      // 只在自己還是最新呼叫時才清理共享狀態；已被取代就讓新呼叫處理
      if (myGen === generation) {
        detach()
      }
      return { ok: false, error }
    }
  }

  function stop() {
    generation += 1
    detach()
  }

  async function resume() {
    const state = getReadyState()
    if (state === 'live') {
      setTrackEnabled(true)
      try { await videoEl.play() } catch { /* play 被打斷不算失敗 */ }
      return true
    }
    const { ok } = await start()
    return ok
  }

  return {
    start,
    stop,
    setEnabled: setTrackEnabled,
    readyState: getReadyState,
    isRunning: () => getReadyState() === 'live',
    resume,
  }
}
