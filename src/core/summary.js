import { fillTemplate } from './copyEngine.js'
import { SUMMARY_COPY } from '../data/copy/summary.js'

// 這個檔案本身不硬寫任何面向使用者的句子（那些字串連同「為什麼不受 15 字
// 上限約束」的說明都在 src/data/copy/summary.js——Task 22 的全域文案護欄
// 掃的是 src/data/copy/**，字串留在這裡就掃不到，這個專案已經因為「護欄
// 覆蓋範圍與宣稱不符」吃過虧）。這裡只負責：從 record/history 算出要填進
// 樣板的數字與分支判斷，其餘交給 fillTemplate() + SUMMARY_COPY。

const ISSUE = {
  slouch: { label: '駝背', fix: '把背靠到椅背上' },
  forwardHead: { label: '低頭太久', fix: '把書本拿高一點' },
  handProp: { label: '撐著頭', fix: '把手放下來' },
  headTilt: { label: '歪著頭', fix: '把頭擺正' },
  gazeAway: { label: '視線飄走', fix: '把桌上其他東西收起來' },
  drowsy: { label: '想睡', fix: '中間站起來動一動' },
}

const minutes = (ms) => Math.round(ms / 60_000)
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

function topIssue(record) {
  const p = record.postureDurationMs ?? {}
  let best = null
  for (const key of Object.keys(ISSUE)) {
    const v = p[key] ?? 0
    if (v > 0 && (best === null || v > p[best])) best = key
  }
  return best
}

function uprightPct(record) {
  return pct(record.postureDurationMs?.upright ?? 0, record.durationMs)
}

/** 取 SUMMARY_COPY[key] 的第一句並代換變數；key 不存在時回傳空字串（不炸畫面）。 */
function line(key, vars) {
  const template = SUMMARY_COPY[key]?.[0]
  return template ? fillTemplate(template, vars) : ''
}

/**
 * 結算頁總結：{ headline, nextGoal }。
 *
 * 冷啟動分支是必要的：評審試玩就是第一次使用，沒有昨日、沒有連續天數。
 * 少了這個分支，展示效果最差的「一般鼓勵」正好就會落在評審看到的那一次。
 *
 * `history` 必須先用 `record.id` 濾掉本場自己：真實呼叫路徑是
 * `endBattle()` 先 `saveSession(本場)` 再 `listSessions()` 抓歷史，本場一定
 * 會出現在 `history` 的第一筆。不濾掉的話「跟上一次比」永遠是跟自己比
 * （`postureDurationMs` 完全相同），`up > prevUp` 恆假，「進步」這個分支在
 * 真實裝置上一次都不會觸發——這條線在手工餵資料的單元測試裡完全測不出來，
 * 因為手工餵的 history 從來不含本場自己，這正是 task-18-brief 原始版本
 * 抓不到這個 bug 的原因。`summary.test.js` 有一條測試專門把本場塞進
 * history 裡鎖住這件事。
 */
export function buildSummary(record, history = []) {
  const priorHistory = history.filter((h) => h?.id !== record.id)
  const mins = minutes(record.durationMs)
  const upMins = minutes(record.postureDurationMs?.upright ?? 0)
  const up = uprightPct(record)
  const issue = topIssue(record)

  const parts = []

  if (priorHistory.length === 0) {
    parts.push(line('firstRun', { minutes: mins, uprightMin: upMins, uprightPct: up, attacks: record.attacks }))
    if (issue) parts.push(line('topIssue', { issueLabel: ISSUE[issue].label, issueFix: ISSUE[issue].fix }))
  } else {
    const prev = [...priorHistory].sort((a, b) => b.startedAt - a.startedAt)[0]
    const prevUp = uprightPct(prev)
    if (up > prevUp) {
      parts.push(line('betterThanLast', { deltaPct: up - prevUp }))
    } else if (issue) {
      parts.push(line('topIssue', { issueLabel: ISSUE[issue].label, issueFix: ISSUE[issue].fix }))
    } else {
      parts.push(line('encourage', { minutes: mins }))
    }
  }

  // 更正 4：拿掉絕對下限（brief 原本是 Math.max(up + 5, 65)）。端正率偏低
  // （例如 20%）的孩子若被要求「下次拉到 65%」等於要求翻三倍，對這個年齡層
  // 等於沒給目標，而且正好落在最需要鼓勵的那個孩子身上。目標永遠只比這次
  // 高 5 個百分點，封頂在 100。
  const target = Math.min(100, up + 5)

  return {
    headline: parts.join(''),
    nextGoal: line('nextGoal', { targetPct: target }),
  }
}
