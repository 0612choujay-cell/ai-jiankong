/**
 * 結算頁（StatsDashboard，Task 18）文案池。由 `src/core/summary.js` 的
 * `buildSummary()` 用 `fillTemplate()`（見 copyEngine.js）代換出最終字串。
 *
 * ── 例外：這個檔案的字串不受全專案「單句 ≤15 字」的文案紅線約束 ──
 *
 * 那條上限的原始理由是語音播報／下一則提示會蓋掉上一句（魔王台詞、姿態
 * 教練、健康度覆蓋層、開機錯誤——全部是會被朗讀、或會被下一則取代的短暫
 * 提示）。這個檔案裡的句子只出現在結算頁：靜態、可從容閱讀、**不會被
 * `voiceFeedback.js` 拿去 `speak()`**，也不會被下一句蓋掉——沒有「來不及看完
 * 就被蓋掉」這個問題存在的前提，所以上限不適用。
 *
 * Task 22 做全域文案護欄（掃 `src/data/copy/**` 檢查長度／禁用詞）時，請把
 * 這個檔案列為顯式例外，而不是放寬全域規則。
 *
 * 禁用詞規則不在此例外範圍內，一樣全適用（見各 key 的內容）。
 */
export const SUMMARY_COPY = {
  firstRun: ['你專注了 {minutes} 分鐘，其中 {uprightMin} 分鐘坐得很端正（{uprightPct}%），砍了魔王 {attacks} 刀。'],
  // v1 刻意未接：這個 App 目前沒有任何地方在算「連續達標天數」（brief 也沒有
  // 這段邏輯，冷啟動分支的測試明確斷言 headline 不得出現「天」字）。
  // 留著這個 key 是為了保留文案池的完整性，給未來真的做連續天數功能的工項
  // 直接使用；下一個維護者看到它沒被 summary.js 引用，不代表是死碼可以刪，
  // 是還沒有人接上生產者端的邏輯。
  bestStreak: ['連續達標 {days} 天，是目前最好的紀錄！'],
  betterThanLast: ['端正時間比上一次多了 {deltaPct}%，有進步。'],
  topIssue: ['最常發生的是{issueLabel}，下次試試{issueFix}。'],
  encourage: ['這次專注了 {minutes} 分鐘，繼續保持。'],
  nextGoal: ['下次目標：端正時間拉到 {targetPct}%。'],
}
