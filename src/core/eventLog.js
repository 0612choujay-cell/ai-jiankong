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
  leftPage: '離開頁面',
}

/** 結算頁照片下方的說明：這張照片拍到了什麼 */
export const EVENT_REASON_DETAIL = {
  slouch: '駝背：上半身彎下去了',
  forwardHead: '低頭：頭往前低下去了',
  handProp: '撐頭：用手撐著頭',
  headTilt: '歪頭：頭歪向一邊',
  gazeAway: '視線離開：眼睛沒有看前方',
  drowsy: '疑似睡著或躺下',
  phone: '看到手機',
  leftPage: '離開頁面：切到別的網頁或 App',
}

/** 場次內毫秒 → m:ss */
export function formatElapsed(tMs) {
  const sec = Math.max(0, Math.floor((tMs ?? 0) / 1000))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
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
    /** 不是「姿勢／物品出現」型的單次事件（例如離開頁面），直接記一筆 */
    add(reason, tMs, wallMs = Date.now()) {
      entries.push({ at: clock(new Date(wallMs)), tMs, reason })
      if (entries.length > max) entries = entries.slice(entries.length - max)
    },
    entries() { return entries.slice() },
    reset() { entries = []; prev = new Set() },
  }
}
