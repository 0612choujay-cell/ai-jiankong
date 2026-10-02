const FPS_WINDOW = 5

/**
 * EDF（earliest deadline first）排程器。
 *
 * 三個模型頻率差很多（0.33 ~ 3 fps），輪詢或固定順序都會讓低頻模型被高頻模型擠掉。
 * 改成每個模型各自記 nextDueAt，每次挑「已到期且最早到期」的那一個。
 *
 * skip() 刻意不動任何 nextDueAt：被丟棄的那一輪不算它跑過，
 * 否則 ObjectDetector 每次排隊都被往後推，展場上手機偵測就等於沒有。
 */
export function createScheduler(specs) {
  let scale = 1
  const tracks = new Map()

  for (const { key, fps } of specs) {
    tracks.set(key, { key, fps, enabled: true, nextDueAt: 0, completions: [] })
  }

  function intervalOf(track) {
    return 1000 / (track.fps * scale)
  }

  return {
    pick(now) {
      let best = null
      for (const track of tracks.values()) {
        if (!track.enabled) continue
        if (track.nextDueAt > now) continue
        if (best === null || track.nextDueAt < best.nextDueAt) best = track
        // 同時到期（多半是起始的 0）時，讓 fps 高的先跑，開機畫面比較快有反應
        else if (track.nextDueAt === best.nextDueAt && track.fps > best.fps) best = track
      }
      return best ? best.key : null
    },

    complete(key, now) {
      const track = tracks.get(key)
      if (!track) return
      track.nextDueAt = now + intervalOf(track)
      track.completions.push(now)
      if (track.completions.length > FPS_WINDOW) track.completions.shift()
    },

    skip() {
      // 刻意什麼都不做——見檔頭說明
    },

    // Task 5 parked finding（見 progress.md，Task 16 覆核維持原判）：只影響之後
    // 排的班，不追溯已排定的 nextDueAt——最壞情況下，剛完成一輪、interval 最長
    // 的 object（0.33fps，scale=1 時 3030ms）要等到它自己下一次到期才會套用新
    // scale。相對於觸發降檔本身要件的 10 秒 EMA 超標窗口，這個交接空隙可接受，
    // 這裡不改：改成「立即重算所有 track 的 nextDueAt」會讓 pick() 在 setScale()
    // 呼叫的當下產生副作用，跟 pick() 是純讀取、只有 complete()/skip() 才改變
    // 排程狀態的既有設計互相矛盾（見 pick() 上方測試檔的說明）。
    setScale(next) {
      scale = next
    },

    setEnabled(key, enabled) {
      const track = tracks.get(key)
      if (!track) return
      track.enabled = enabled
      if (enabled) {
        track.nextDueAt = 0 // 重新啟用後立刻可跑
        // Task 5 parked finding：停用期間累積的舊 completions 不清掉的話，
        // actualFps() 會把停用前後的樣本混在一起算出失真的讀數（見同名測試）。
        // 只影響 DebugHud 顯示，不是安全路徑，但秀出來的數字不能是錯的。
        track.completions = []
      }
    },

    actualFps(key, now) {
      const track = tracks.get(key)
      if (!track || track.completions.length < 2) return 0
      const first = track.completions[0]
      const last = track.completions[track.completions.length - 1]
      const span = Math.max(1, (now >= last ? last : now) - first)
      return ((track.completions.length - 1) * 1000) / span
    },
  }
}
