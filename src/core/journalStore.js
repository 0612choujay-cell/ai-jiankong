/**
 * 日曆日記：使用者自己選任務、拍下成果照之後，把「日期＋做了什麼＋照片」存在這台
 * iPad 的 IndexedDB，之後（明天、明年）可以在日曆上翻回來看。
 *
 * 這是使用者明確要求的「照片會被保存」例外，所以刻意放在**獨立的資料庫**
 * （focus-quest-journal），跟只存統計數字的 focus-quest（storageService.js）完全分開：
 * 那一個仍然保證不含任何影像。這裡只在使用者自己按「拍照」之後才會寫入，
 * 不上傳、不同步。
 */
const DB_NAME = 'focus-quest-journal'
const STORE = 'entries'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' })
      store.createIndex('date', 'date')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const result = fn(t.objectStore(STORE))
    t.oncomplete = () => { db.close(); resolve(result?.result) }
    t.onerror = () => { db.close(); reject(t.error) }
    t.onabort = () => { db.close(); reject(t.error) }
  }))
}

export function localDateKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** entry: { id, at(ms), label, photo(data URL), finished(true|false|null) }；date 自動算 */
export function saveEntry(entry) {
  const rec = { ...entry, date: localDateKey(entry.at) }
  return tx('readwrite', (s) => s.put(rec))
}

export function listEntries() {
  return tx('readonly', (s) => s.getAll()).then((rows) => (rows ?? []).sort((a, b) => a.at - b.at))
}

export function deleteEntry(id) {
  return tx('readwrite', (s) => s.delete(id))
}
