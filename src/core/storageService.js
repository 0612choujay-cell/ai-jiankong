const DB_NAME = 'focus-quest'
const DB_VERSION = 1
const STORE = 'sessions'
const CRUMB_KEY = 'focus-quest:crumb'

/**
 * 白名單。只有列在這裡的欄位會被寫進儲存層。
 *
 * 這是隱私紅線的最後一道防線，用白名單而非黑名單：
 * 日後有人在 SessionRecord 裡多塞一個欄位，預設是「不會被存」，
 * 而不是「除非有人記得加進黑名單否則就存下去」。
 */
export const ALLOWED_FIELDS = Object.freeze([
  'id', 'startedAt', 'endedAt', 'durationMs', 'status', 'taskType',
  'postureDurationMs', 'distractionDurationMs', 'trapCount',
  'attacks', 'score', 'bossHpRemaining', 'bossHpMax', 'phase2Damage',
  'result', 'demoMode',
])

/**
 * 複審第 1 輪 F1（Blocking）：頂層白名單只過濾第一層鍵，
 * `postureDurationMs`/`distractionDurationMs`/`trapCount` 原本是參照複製，
 * 內容完全不檢查——landmark 陣列、dataURL、`ArrayBuffer` 塞進這三個子物件
 * 會原封不動通過 `sanitizeRecord()`，IndexedDB 的 structured clone 連
 * `ArrayBuffer` 都存得下去。這裡替這三個巢狀物件各自列舉「允許的子鍵」，
 * 跟頂層白名單同一個精神：明天有人在 snapshot 裡加一個
 * `postureDurationMs.samples = [...每幀角度...]`，預設是不會被存，而不是
 * 「除非有人記得多寫一條檢查否則就存下去」。
 *
 * 值一律用 `Number()` 強制轉型，非有限值（`NaN`/`Infinity`/物件轉不出數字）
 * 直接丟棄該鍵——跟頂層「鍵本身不存在」的行為一致，不是寫成 0 把上游的
 * bug 掩蓋掉。
 */
const NESTED_ALLOWED_FIELDS = Object.freeze({
  postureDurationMs: Object.freeze(
    ['upright', 'slouch', 'forwardHead', 'handProp', 'headTilt', 'drowsy', 'gazeAway'],
  ),
  distractionDurationMs: Object.freeze(['phone', 'away']),
  trapCount: Object.freeze(['phone', 'phoneUndone', 'away', 'awayUndone']),
})

function sanitizeNested(value, allowedKeys) {
  const out = {}
  if (value === null || typeof value !== 'object') return out
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    // 先擋型別再轉數值。只用 Number.isFinite(Number(v)) 是不夠的——
    // Number(null)、Number(false)、Number('')、Number([]) 全都等於 0，
    // 於是「這個欄位壞了」會被靜默記成「駝背 0 毫秒」，統計照樣有數字、
    // 看不出上游出過錯。丟棄該鍵（讓它不存在）跟頂層白名單的行為一致，
    // 讀的人才分得出「沒這個欄位」和「真的是 0」。
    // 字串仍然放行：IndexedDB 讀回來的舊紀錄可能是字串型別的數值。
    // 字串仍然放行：IndexedDB 讀回來的舊紀錄可能是字串型別的數值。
    // 但空字串／全空白要擋掉——Number('') 與 Number('  ') 也都是 0，
    // 跟上面那些一樣會把「壞掉的欄位」偽裝成一個合理的數字。
    const raw = value[key]
    const usable = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
    if (!usable) continue
    const n = Number(raw)
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}

export function sanitizeRecord(record) {
  if (!record) return null
  const out = {}
  for (const key of ALLOWED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    const nestedAllowed = NESTED_ALLOWED_FIELDS[key]
    out[key] = nestedAllowed ? sanitizeNested(record[key], nestedAllowed) : record[key]
  }
  return out
}

let dbPromise = null

// 測試用的替換點（依賴注入）：jsdom 沒有實作 IndexedDB，而專案不安裝
// fake-indexeddb 這類新依賴（task-17 brief 的明確要求）。production 路徑
// 一律讀 `globalThis.indexedDB`；測試可以呼叫 `__setIndexedDBFactoryForTests()`
// 換成一個只實作這個檔案實際用到的那幾個方法的假 IndexedDB，藉此把
// IndexedDB 相關的邏輯（saveSession/listSessions/clearAll/reconcile）也納入
// 測試範圍，而不是只測 sanitizeRecord() 這種純函式。
let idbFactory = () => globalThis.indexedDB

/** 僅供測試使用：替換 IndexedDB 實作，並清掉快取的連線（見上方說明）。 */
export function __setIndexedDBFactoryForTests(factory) {
  idbFactory = factory ?? (() => globalThis.indexedDB)
  dbPromise = null
}

/**
 * 複審第 1 輪 F6（Important）：`open()` 沒有逾時。`DB_VERSION` 固定為 1，
 * `blocked` 事件今天不可達，但 WebKit 已知 `open()` 偶發完全不回應（不
 * onsuccess、不 onerror），而 `reconcile()` 只在「上次崩潰留下 crumb」時才
 * 走到這裡——症狀會是「崩潰過一次之後遊戲就再也開不起來」，展場上是致命的。
 */
export const DB_OPEN_TIMEOUT_MS = 5000

export function openDb() {
  if (dbPromise) return dbPromise
  const attempt = new Promise((resolve, reject) => {
    const req = idbFactory().open(DB_NAME, DB_VERSION)
    const timer = setTimeout(() => reject(new Error('IndexedDB open() timed out')), DB_OPEN_TIMEOUT_MS)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('startedAt', 'startedAt')
      }
    }
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result) }
    req.onerror = () => { clearTimeout(timer); reject(req.error) }
  })
  dbPromise = attempt
  // 失敗（含逾時）不能讓 `dbPromise` 永久卡在一個壞掉的 promise 上——那會讓
  // 這次失敗之後，往後**每一次** `openDb()` 都直接拿到同一個永遠 reject 的
  // 快取，等同「崩潰過一次就再也存不進去」。只在快取仍然是這次自己建立的
  // `attempt` 時才清掉：如果在這段期間已經有更新一次的 `openDb()` 呼叫把
  // 快取換掉了，不該由這個過期的失敗把新的快取洗掉。
  attempt.catch(() => { if (dbPromise === attempt) dbPromise = null })
  return attempt
}

export async function saveSession(record) {
  const clean = sanitizeRecord(record)
  if (!clean?.id) return false
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(clean)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

export async function listSessions(limit = 60) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const out = []
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).index('startedAt').openCursor(null, 'prev')
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || out.length >= limit) { resolve(out); return }
      out.push(cursor.value)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

export async function clearAll() {
  // 複審第 1 輪 F3（Important）：`clearCrumb()` 原本排在 `await openDb()` 之後
  // ——IndexedDB 被封鎖（私密瀏覽、儲存空間政策）時 `openDb()` reject、整個
  // `clearAll()` 拋出，而 localStorage 的 crumb（那正是這個情境下唯一真的
  // 存在於磁碟上的資料）原封不動留著。家長按下「清除所有本地紀錄」以為清
  // 乾淨了，下次啟動 `reconcile()` 又把它撈回來。`clearCrumb()` 是同步 API，
  // 先做——跟 `handlePageHide()` 的 `writeCrumb()` 排最前面是同一個原則。
  clearCrumb()
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 崩潰保險。IndexedDB 是非同步的，iOS 可能在 commit 之前就凍結頁面，
 * 那一輪就整個不見。localStorage 是同步 API，在 pagehide 的 handler 裡寫得進去。
 */
export function writeCrumb(crumb) {
  try {
    localStorage.setItem(CRUMB_KEY, JSON.stringify(sanitizeRecord(crumb)))
  } catch { /* 私密瀏覽或空間不足時放棄保險，不影響主流程 */ }
}

export function readCrumb() {
  try {
    const raw = localStorage.getItem(CRUMB_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function clearCrumb() {
  try { localStorage.removeItem(CRUMB_KEY) } catch { /* 同上 */ }
}

/** 啟動時呼叫：crumb 比 IndexedDB 最新一筆還新就補寫進去 */
export async function reconcile() {
  const crumb = readCrumb()
  if (!crumb?.id) return false
  const recent = await listSessions(1)
  if (recent.length > 0 && recent[0].startedAt >= crumb.startedAt) { clearCrumb(); return false }
  await saveSession({ ...crumb, status: 'completed' })
  clearCrumb()
  return true
}
