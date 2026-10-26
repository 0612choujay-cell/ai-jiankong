/**
 * 事件紀錄：姿勢或物品「出現」的瞬間，記下時間與原因。
 *
 * 隱私：只存 { at, tMs, reason } 三個純量（時鐘字串、場次內毫秒、原因 key），
 * 不存影像、不存 landmark 座標——跟 session.state 的隱私紅線同一條。
 * 只在「由無變有」的上升邊緣記一筆，持續中的狀態不會洗版。
 */
export const EVENT_LOG_MAX = 200

export const EVENT_REASON_LABEL = {
  slouch: '駝背',
  forwardHead: '低頭',
  handProp: '撐頭',
  headTilt: '歪頭',
  gazeAway: '視線離開',
  drowsy: '疑似睡著／躺下',
  phone: '看到手機',
}

function clock(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function createEventLog({ max = EVENT_LOG_MAX } = {}) {
  let entries = []
  let prev = new Set()

  return {
    /** 每個 frame 呼叫；回傳這一次新增的筆數 */
    observe({ posture, drowsy, phoneVisible }, tMs, wallMs = Date.now()) {
      const now = new Set()
      if (posture && posture !== 'upright') now.add(posture)
      if (drowsy) now.add('drowsy')
      if (phoneVisible) now.add('phone')
      let added = 0
      for (const reason of now) {
        if (prev.has(reason)) continue
        entries.push({ at: clock(new Date(wallMs)), tMs, reason })
        added += 1
      }
      if (entries.length > max) entries = entries.slice(entries.length - max)
      prev = now
      return added
    },
    entries() { return entries.slice() },
    reset() { entries = []; prev = new Set() },
  }
}
