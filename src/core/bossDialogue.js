/**
 * 事件 → 文案 key 的映射器。刻意不持有任何文案資料（資料在 CopyEngine），
 * 這樣新增台詞只要改 data/copy/boss.js 一個檔。
 *
 * 刻意**不**在這裡算 `voice`（Task 15 複審第 1 輪拿掉的）：這個函式跟
 * messageQueue 都是從同一份 `NO_VOICE_BOSS_KEYS`（data/copy/boss.js）匯入，
 * 資料本身不會漂移，但「同一份資料被算兩次」本身就是問題——多算的那一次
 * 唯一的實際後果，是讓端到端測試對 messageQueue 這個唯一仲裁者失去鑑別力
 * （複審驗過：就算把這裡的 voice 改成永遠 true，經過 messageQueue 之後的
 * 端到端測試依然全線綠燈，因為 messageQueue 自己那層本來就足夠）。
 * 呼叫端（BattleView 的 sayBoss()）一律把 `voice:true` 交給
 * `messageQueue.publish()`，是不是真的能朗讀，全權交給 messageQueue 內部的
 * NO_VOICE 表決定——這裡不重複判斷。
 */
export function copyKeyForEvent(event) {
  const key = keyFor(event)
  if (key === null) return null
  return { ns: 'boss', key }
}

/**
 * Task 22d 複查：`src/data/copy/boss.js` 的 `BOSS_COPY.open`（3 句開場台詞）
 * 是死文案——下面這個 switch 沒有任何分支映射到 `'open'`，而且已經追過整條
 * 呼叫鏈確認沒有第二個觸發點：
 *   - 全 repo 唯一呼叫 `copyKeyForEvent()` 的地方是 BattleView.vue 的
 *     `sayBoss()`，而 `sayBoss()` 只在 `onEvents()` 的 switch 裡被呼叫
 *     （case 'attack'／'trapCommitted'／'phase'／'regroupStart'／'drowsy'／
 *     'sessionEnd'），沒有任何地方（含 onMounted）直接餵一個代表「戰鬥
 *     開場」的事件進來。
 *   - `src/core/focusStateMachine.js` 是唯一產生 `event.type` 的地方，
 *     完整清單是：attack／trapCommitted／trapPending／trapWarning／
 *     trapUndone／phase／regroupStart／regroupEnd／drowsy／playerDamage／
 *     sessionEnd——沒有任何一種代表「戰鬥開場」（沒有 battleStart／open／
 *     sessionStart 這一類事件）。
 * 換句話說，不是「漏接」，是這個觸發時機從一開始就不存在。
 *
 * 決定：刪除（而非接上）。理由：
 *   1. 接上等於憑空造一個沒有人設計過的觸發時機——brief 明確要求不要為了
 *      「留著比較保險」而這樣做。
 *   2. 這個專案的慣例偏向刪除不可達的程式碼/文案（這一輪另一個工項也刪了
 *      一段不可達的早退）；死文案還會混進台詞簽核表，讓審稿的成人花時間
 *      讀一段永遠不會出現的話。
 *
 * 這裡沒有實際刪掉 `BOSS_COPY.open` 那三句：資料在 `src/data/copy/boss.js`，
 * 不在本工項（Task 22d）核准的檔案界線內（只能動這個檔案跟它的測試，以及
 * OfflineWarmup 的兩個檔案）。下面 bossDialogue.test.js 有一條測試把「這三句
 * 目前沒有任何觸發路徑」的結論鎖住，實際從資料池刪除留給下一個能碰
 * `src/data/copy/boss.js` 的工項處理（見 task-22d-report.md）。
 */
function keyFor(event) {
  switch (event.type) {
    case 'attack':
      return event.streak >= 3 ? 'combo' : 'hit'
    case 'trapCommitted':
      return event.kind === 'phone' ? 'phoneTrap' : 'awayTrap'
    case 'drowsy':
      return 'drowsy'
    case 'regroupStart':
      return 'regroup'
    case 'phase':
      return 'phase2'
    case 'sessionEnd':
      return event.result === 'victory' ? 'victory' : 'timeout'
    default:
      return null
  }
}
