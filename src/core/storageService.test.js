// @vitest-environment jsdom
//
// IndexedDB 在 jsdom 裡完全不存在（vitest 啟動時可以直接驗到
// `typeof globalThis.indexedDB === 'undefined'`），而這個專案不為了測試安裝
// fake-indexeddb 這類新依賴（package.json 目前沒有，task-17 brief 明確要求
// 不要自行加）。所以這裡自己寫一個只實作 storageService.js 實際用到的那幾個
// IndexedDB 方法（open/onupgradeneeded/transaction/objectStore/put/clear/
// index/openCursor）的最小假物件，透過 `__setIndexedDBFactoryForTests()`
// 這個依賴注入的替換點掛進去——sanitizeRecord() 之外，saveSession()/
// listSessions()/clearAll()/reconcile() 也因此有真正的測試覆蓋，不是只測
// 純邏輯那一半。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  sanitizeRecord, ALLOWED_FIELDS,
  openDb, saveSession, listSessions, clearAll,
  writeCrumb, readCrumb, clearCrumb, reconcile,
  __setIndexedDBFactoryForTests, DB_OPEN_TIMEOUT_MS,
} from './storageService.js'

const valid = {
  id: 's-1', startedAt: 1000, endedAt: 2000, durationMs: 1000, status: 'completed',
  taskType: 'homework',
  postureDurationMs: { upright: 600, slouch: 200, forwardHead: 100, drowsy: 50, gazeAway: 50 },
  distractionDurationMs: { phone: 0, away: 0 },
  trapCount: { phone: 0, phoneUndone: 0, away: 0, awayUndone: 0 },
  attacks: 12, score: 120, bossHpRemaining: 0, bossHpMax: 240,
  phase2Damage: 0, result: 'victory', demoMode: false,
}

describe('sanitizeRecord', () => {
  it('白名單內的欄位原樣保留', () => {
    expect(sanitizeRecord(valid)).toEqual(valid)
  })

  it('剝除 landmark 座標（隱私紅線）', () => {
    const dirty = { ...valid, landmarks: [{ x: 0.1, y: 0.2, z: 0 }] }
    expect(sanitizeRecord(dirty).landmarks).toBeUndefined()
  })

  it('剝除 blendshape 數值', () => {
    expect(sanitizeRecord({ ...valid, blendshapes: { eyeBlinkLeft: 0.8 } }).blendshapes).toBeUndefined()
  })

  it('剝除影像與快照', () => {
    const dirty = { ...valid, snapshot: 'data:image/png;base64,AAA', frame: new ArrayBuffer(8) }
    const out = sanitizeRecord(dirty)
    expect(out.snapshot).toBeUndefined()
    expect(out.frame).toBeUndefined()
  })

  it('剝除原始角度時序', () => {
    const dirty = { ...valid, angleSeries: [1.0, 0.98, 0.95], neckRatioSeries: [1, 2] }
    expect(sanitizeRecord(dirty).angleSeries).toBeUndefined()
    expect(sanitizeRecord(dirty).neckRatioSeries).toBeUndefined()
  })

  it('剝除裝置識別碼', () => {
    const dirty = { ...valid, deviceId: 'abc-123', userAgent: 'Safari', deviceProfileId: 'ipad' }
    const out = sanitizeRecord(dirty)
    expect(out.deviceId).toBeUndefined()
    expect(out.userAgent).toBeUndefined()
    expect(out.deviceProfileId).toBeUndefined()
  })

  it('白名單本身不得含有任何可識別個人或原始生物特徵的欄位', () => {
    const banned = ['landmarks', 'blendshapes', 'snapshot', 'frame', 'image',
      'angleSeries', 'neckRatioSeries', 'deviceId', 'userAgent', 'deviceProfileId']
    for (const b of banned) expect(ALLOWED_FIELDS).not.toContain(b)
  })

  it('缺欄位不補假值，缺什麼就是沒有', () => {
    const out = sanitizeRecord({ id: 's-2' })
    expect(out).toEqual({ id: 's-2' })
  })

  // 上面那條用 toEqual：vitest/jest 的 toEqual 對「鍵不存在」跟「鍵存在但值是
  // undefined」視為相等，測不出「補了一個 undefined 佔位」這種變體（IndexedDB
  // 的 structured clone 不會像 JSON.stringify 那樣自動丟掉 undefined 屬性，
  // 兩者存進去的紀錄形狀其實不同）。這裡直接檢查鍵本身在不在，把這個變體也鎖住。
  it('缺欄位是鍵本身不存在，不是鍵存在但值為 undefined', () => {
    const out = sanitizeRecord({ id: 's-2' })
    expect(Object.keys(out)).toEqual(['id'])
    expect(Object.prototype.hasOwnProperty.call(out, 'startedAt')).toBe(false)
  })

  it('null / undefined 回傳 null', () => {
    expect(sanitizeRecord(null)).toBe(null)
    expect(sanitizeRecord(undefined)).toBe(null)
  })

  // 白名單是「列舉允許的欄位」而不是「刪掉已知的壞欄位」——這條測試不重複
  // 上面已經逐項列舉過的壞欄位，而是塞一個上面**從來沒有出現過**的全新欄位
  // （模擬「明天有人在 SessionRecord 上新增一個沒人想到要拉黑的欄位」）。
  // 只有白名單式的實作才會擋下它；黑名單式的實作（列舉已知壞欄位、其餘照抄）
  // 會讓它原封不動地通過。
  it('白名單擋得住從未列舉過的全新欄位（證明是白名單而非黑名單）', () => {
    const dirty = { ...valid, deviceFingerprint: 'canvas-hash-abc123' }
    const out = sanitizeRecord(dirty)
    expect(out.deviceFingerprint).toBeUndefined()
    expect(out).toEqual(valid)
  })
})

// 複審第 1 輪 F1（Blocking）：頂層白名單原本只擋第一層鍵，`postureDurationMs`/
// `distractionDurationMs`/`trapCount` 是參照複製，內容完全不檢查——landmark
// 陣列、dataURL、`ArrayBuffer` 塞進這三個子物件會原封不動通過，IndexedDB 的
// structured clone 連 `ArrayBuffer` 都存得下去。下面三條就是複審點名要重建
// 的探針：每一條分別在三個巢狀容器之一塞一個具體的違規值，斷言它被剝除。
describe('sanitizeRecord：巢狀物件也要白名單（F1）', () => {
  it('探針 1：postureDurationMs 裡塞 landmark 陣列會被剝除', () => {
    const dirty = {
      ...valid,
      postureDurationMs: { ...valid.postureDurationMs, landmarks: [{ x: 0.1, y: 0.2, z: 0 }] },
    }
    const out = sanitizeRecord(dirty)
    expect(out.postureDurationMs.landmarks).toBeUndefined()
    expect(out.postureDurationMs).toEqual(valid.postureDurationMs)
  })

  it('探針 1b：null / false / [] 這類會被 Number() 轉成 0 的值要丟棄該鍵，不能寫成 0', () => {
    // Number(null)、Number(false)、Number('')、Number([]) 全都等於 0，所以
    // 只用 Number.isFinite(Number(v)) 把關的話，「這個欄位壞了」會被靜默記成
    // 「駝背 0 毫秒」——統計上照樣有數字，沒有人看得出上游出過錯。
    // 丟棄該鍵（讓它不存在）才跟頂層白名單的行為一致。
    for (const junk of [null, false, '', [], [5], new Date(0)]) {
      const out = sanitizeRecord({ ...valid, postureDurationMs: { ...valid.postureDurationMs, upright: junk } })
      expect(Object.prototype.hasOwnProperty.call(out.postureDurationMs, 'upright')).toBe(false)
    }
    // 對照組：合法的數值與數值字串仍要保留（IndexedDB 讀回的舊紀錄可能是字串）
    expect(sanitizeRecord({ ...valid, postureDurationMs: { ...valid.postureDurationMs, upright: 0 } })
      .postureDurationMs.upright).toBe(0)
    expect(sanitizeRecord({ ...valid, postureDurationMs: { ...valid.postureDurationMs, upright: '600' } })
      .postureDurationMs.upright).toBe(600)
  })

  it('handProp／headTilt（這一輪新增的姿態桶）也在白名單內，不會被當成未知欄位剝除', () => {
    const dirty = {
      ...valid,
      postureDurationMs: { ...valid.postureDurationMs, handProp: 30, headTilt: 20 },
    }
    const out = sanitizeRecord(dirty)
    expect(out.postureDurationMs.handProp).toBe(30)
    expect(out.postureDurationMs.headTilt).toBe(20)
  })

  it('探針 2：distractionDurationMs 裡塞 dataURL 快照會被剝除', () => {
    const dirty = {
      ...valid,
      distractionDurationMs: { ...valid.distractionDurationMs, snapshot: 'data:image/png;base64,AAA' },
    }
    const out = sanitizeRecord(dirty)
    expect(out.distractionDurationMs.snapshot).toBeUndefined()
    expect(out.distractionDurationMs).toEqual(valid.distractionDurationMs)
  })

  it('探針 3：trapCount 裡塞 ArrayBuffer 會被剝除', () => {
    const dirty = { ...valid, trapCount: { ...valid.trapCount, frame: new ArrayBuffer(8) } }
    const out = sanitizeRecord(dirty)
    expect(out.trapCount.frame).toBeUndefined()
    expect(out.trapCount).toEqual(valid.trapCount)
  })

  // 複審原話點名的具體情境：明天有人在 snapshot 裡加一個
  // `postureDurationMs.samples = [...每幀角度...]`——那是紅線清單上白紙黑字
  // 的「原始角度時序」，只是換了個地方藏。
  it('明天有人加的全新巢狀欄位（未列舉過）：postureDurationMs.samples 這種原始時序也要被剝除', () => {
    const dirty = { ...valid, postureDurationMs: { ...valid.postureDurationMs, samples: [1.0, 0.98, 0.95] } }
    const out = sanitizeRecord(dirty)
    expect(out.postureDurationMs.samples).toBeUndefined()
    expect(out.postureDurationMs).toEqual(valid.postureDurationMs)
  })

  it('允許的子鍵本身被塞進非數值（landmark 陣列）：丟棄該鍵，不是強轉成 NaN/0 存進去', () => {
    const dirty = { ...valid, postureDurationMs: { ...valid.postureDurationMs, upright: [{ x: 0.1 }] } }
    const out = sanitizeRecord(dirty)
    expect(Object.prototype.hasOwnProperty.call(out.postureDurationMs, 'upright')).toBe(false)
  })

  it('數值字串會被 Number() 轉型（值一律強制轉型的規則）', () => {
    const dirty = { ...valid, trapCount: { ...valid.trapCount, phone: '3' } }
    const out = sanitizeRecord(dirty)
    expect(out.trapCount.phone).toBe(3)
  })

  it('巢狀物件整個不是物件（例如直接塞一個字串）：回傳空物件，不是原樣通過', () => {
    const dirty = { ...valid, distractionDurationMs: 'not-an-object' }
    const out = sanitizeRecord(dirty)
    expect(out.distractionDurationMs).toEqual({})
  })

  it('writeCrumb() 寫進 localStorage 的 crumb 同樣套用巢狀白名單', () => {
    writeCrumb({ ...valid, trapCount: { ...valid.trapCount, deviceId: 'abc' } })
    const crumb = readCrumb()
    expect(crumb.trapCount).toEqual(valid.trapCount)
    clearCrumb()
  })
})

// ------------------------------------------------------------ 假的 IndexedDB
//
// 複審第 1 輪 F4（Important）：第一版的假 IndexedDB 從不觸發
// `onupgradeneeded`（`objectStoreNames.contains()` 寫死回 `true`），等於
// `storageService.js` 裡真正建 schema 的那段程式碼（`createObjectStore`/
// `createIndex`）從來沒有被任何測試執行過——`DB_NAME`/`DB_VERSION`/`STORE`/
// `keyPath`/`createIndex` 的參數全部改錯，284 條測試依然全線。
//
// 這一版改成用一個「資料庫登記表」（`databases`：name → { version, stores }）
// 模擬真實 IndexedDB 的持久化語意：
//   - `open(name, version)` 只在 `version > 已登記的 version`（含全新資料庫）
//     時才觸發 `onupgradeneeded`，之後才 `onsuccess`——схема 只建一次。
//   - `objectStoreNames.contains()` 依「這個資料庫真的呼叫過 createObjectStore
//     嗎」誠實回答，而不是寫死 `true`——這樣 `storageService.js` 裡
//     `if (!contains(STORE)) { createObjectStore(...); createIndex(...) }`
//     才會真的被執行到。
//   - `put(value)` 依**建立 store 時真正傳入的 keyPath** 取值當 key，
//     key 求不出值（keyPath 打錯）時同步丟出例外，模擬真實 IndexedDB 的
//     `DataError`（規格上 `put()` 這個失敗是同步丟出，不是走 `tx.onerror`）。
//   - `index(name).openCursor()` 依**建立索引時真正傳入的 keyPath** 排序，
//     不是寫死讀 `.startedAt`——`createIndex` 的兩個參數任何一個打錯字都會
//     讓排序變成別的欄位、產生看得出來的錯誤順序。
function nextMicrotask(fn) { Promise.resolve().then(fn) }

function createFakeIndexedDB() {
  const databases = new Map() // name -> { version, stores: Map<storeName, {keyPath, indexes, rows}> }

  function makeRequest() {
    return { result: undefined, error: undefined, onsuccess: null, onerror: null }
  }

  function getOrCreateDatabase(name) {
    if (!databases.has(name)) databases.set(name, { version: 0, stores: new Map() })
    return databases.get(name)
  }

  function makeDbHandle(dbEntry) {
    return {
      objectStoreNames: { contains: (name) => dbEntry.stores.has(name) },
      createObjectStore(name, options = {}) {
        const storeEntry = { keyPath: options.keyPath, indexes: new Map(), rows: new Map() }
        dbEntry.stores.set(name, storeEntry)
        return {
          createIndex(indexName, indexKeyPath) {
            storeEntry.indexes.set(indexName, { keyPath: indexKeyPath })
          },
        }
      },
      transaction() {
        const tx = { oncomplete: null, onerror: null, error: undefined }
        tx.objectStore = (name) => {
          const storeEntry = dbEntry.stores.get(name)
          return {
            put(value) {
              const key = storeEntry ? value[storeEntry.keyPath] : undefined
              if (key === undefined) {
                // 真實 IndexedDB：keyPath 求不出值時 put() 同步丟出 DataError，
                // 不是透過 tx.onerror——這裡忠實重現，讓 keyPath 打錯字這個
                // 突變真的會讓 saveSession() reject。
                throw new Error('DataError: 找不到 keyPath 對應的值')
              }
              storeEntry.rows.set(key, value)
            },
            clear() { storeEntry?.rows.clear() },
            index(indexName) {
              const indexEntry = storeEntry?.indexes.get(indexName)
              return {
                openCursor(_query, direction) {
                  const keyPath = indexEntry?.keyPath
                  const sorted = [...(storeEntry?.rows.values() ?? [])].sort((a, b) => (
                    direction === 'prev' ? b[keyPath] - a[keyPath] : a[keyPath] - b[keyPath]
                  ))
                  let i = 0
                  const req = makeRequest()
                  const step = () => {
                    if (i >= sorted.length) {
                      req.result = null
                    } else {
                      const value = sorted[i]
                      req.result = {
                        value,
                        continue() { i += 1; nextMicrotask(step) },
                      }
                    }
                    req.onsuccess?.()
                  }
                  nextMicrotask(step)
                  return req
                },
              }
            },
          }
        }
        // 同一個 tick 內：transaction() 回傳後，呼叫端會同步做完
        // objectStore().put()/clear()，才輪到這裡指派 oncomplete——所以排在
        // microtask 裡觸發不會搶在賦值之前執行。
        nextMicrotask(() => tx.oncomplete?.())
        return tx
      },
    }
  }

  return {
    open(name, version) {
      const req = makeRequest()
      const dbEntry = getOrCreateDatabase(name)
      const needsUpgrade = version > dbEntry.version
      nextMicrotask(() => {
        req.result = makeDbHandle(dbEntry)
        if (needsUpgrade) {
          req.onupgradeneeded?.()
          dbEntry.version = version
        }
        req.onsuccess?.()
      })
      return req
    },
    _databases: databases,
  }
}

describe('IndexedDB 操作（用假的 IndexedDB，依賴注入取代 fake-indexeddb 套件）', () => {
  let fakeIdb

  beforeEach(() => {
    fakeIdb = createFakeIndexedDB()
    __setIndexedDBFactoryForTests(() => fakeIdb)
    clearCrumb()
  })

  afterEach(() => {
    __setIndexedDBFactoryForTests(null)
    clearCrumb()
  })

  it('openDb() 回傳同一個連線（快取），只呼叫一次 open()', async () => {
    let opens = 0
    const counted = { ...fakeIdb, open: (...args) => { opens += 1; return fakeIdb.open(...args) } }
    __setIndexedDBFactoryForTests(() => counted)
    const [a, b] = await Promise.all([openDb(), openDb()])
    expect(a).toBe(b)
    expect(opens).toBe(1)
  })

  // 複審第 1 輪 F4：DB_NAME/DB_VERSION 用「open() 實際收到的參數」直接釘住；
  // STORE/keyPath/createIndex 用「schema 真的建出來的樣子」直接釘住——不是
  // 靠某個間接的行為推論回去，五個常數任何一個改錯，這條測試都會直接紅。
  it('openDb() 用專案指定的 DB_NAME/DB_VERSION 開啟連線，並建立 keyPath=id 的 sessions store 與 startedAt 索引', async () => {
    const opens = []
    const wrapped = { open: (name, version) => { opens.push({ name, version }); return fakeIdb.open(name, version) } }
    __setIndexedDBFactoryForTests(() => wrapped)

    await openDb()

    expect(opens).toEqual([{ name: 'focus-quest', version: 1 }])
    const dbEntry = fakeIdb._databases.get('focus-quest')
    expect(dbEntry.stores.has('sessions')).toBe(true)
    const store = dbEntry.stores.get('sessions')
    expect(store.keyPath).toBe('id')
    expect(store.indexes.get('startedAt')).toEqual({ keyPath: 'startedAt' })
  })

  it('saveSession() 把記錄寫進去，listSessions() 讀得回來，且已經是白名單過的版本', async () => {
    await saveSession({ ...valid, landmarks: [{ x: 1 }] })
    const out = await listSessions()
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(valid)
    expect(out[0].landmarks).toBeUndefined()
  })

  it('沒有 id 的記錄不會被寫入，saveSession() 回傳 false', async () => {
    const ok = await saveSession({ ...valid, id: undefined })
    expect(ok).toBe(false)
    expect(await listSessions()).toHaveLength(0)
  })

  it('listSessions() 依 startedAt 由新到舊排序，並套用 limit', async () => {
    // endedAt 刻意跟 startedAt 的順序完全相反（不是同一個值、也不是同向）：
    // 如果 createIndex() 的 keyPath 被打錯字（例如錯存成 'endedAt'），排序
    // 會用到這裡而不是 startedAt，馬上就能看出一個確定性的錯誤順序，
    // 而不是「剛好排出一樣的結果」這種測不出來的巧合。
    await saveSession({ ...valid, id: 's-a', startedAt: 100, endedAt: 9999 })
    await saveSession({ ...valid, id: 's-b', startedAt: 300, endedAt: 1 })
    await saveSession({ ...valid, id: 's-c', startedAt: 200, endedAt: 50 })

    const all = await listSessions()
    expect(all.map((r) => r.id)).toEqual(['s-b', 's-c', 's-a'])

    const limited = await listSessions(2)
    expect(limited.map((r) => r.id)).toEqual(['s-b', 's-c'])
  })

  it('clearAll() 清空所有紀錄，且一併清掉 crumb（清除所有本地紀錄的交付門檻）', async () => {
    await saveSession({ ...valid, id: 's-x' })
    writeCrumb({ ...valid, id: 's-y', startedAt: 999 })
    expect(readCrumb()).not.toBeNull()

    await clearAll()

    expect(await listSessions()).toHaveLength(0)
    expect(readCrumb()).toBeNull()
  })

  // 複審第 1 輪 F3（Important）：IndexedDB 打不開時（私密瀏覽、儲存空間政策）
  // `openDb()` reject、`clearAll()` 整段拋出——但 localStorage 的 crumb
  // 是這個情境下唯一真的存在於磁碟上的資料，不能因為 IndexedDB 那一半失敗
  // 就跟著留著沒清。
  it('clearAll()：IndexedDB 打不開時仍然清掉 crumb，即使整個 promise 最後 reject', async () => {
    writeCrumb({ ...valid, id: 's-z', startedAt: 42 })
    expect(readCrumb()).not.toBeNull()

    const brokenIdb = { open: () => { throw new Error('IndexedDB 被封鎖') } }
    __setIndexedDBFactoryForTests(() => brokenIdb)

    await expect(clearAll()).rejects.toThrow()
    expect(readCrumb()).toBeNull()
  })

  // 複審第 1 輪 F6（Important）：`open()` 沒有逾時，WebKit 已知偶發完全不
  // 回應；`dbPromise` 失敗後如果永久卡住，會變成「崩潰過一次之後遊戲就再也
  // 開不起來」。
  //
  // 這裡刻意**不**透過 `__setIndexedDBFactoryForTests()` 切換到另一個
  // IndexedDB 實作來間接證明「下一次呼叫會重新嘗試」——那個函式本身就會
  // 重置 `dbPromise`（見它自己的實作），會把「毒化有沒有被清掉」這件事跟
  // 「測試自己手動清掉了」混在一起，測不出 `openDb()` 內部是不是真的有做
  // 這件事。改成用同一個（仍然會卡住的）假 IndexedDB 直接數 `open()` 被
  // 呼叫了幾次：如果失敗後 `dbPromise` 沒被清掉，第二次 `openDb()` 會拿到
  // 同一個已經 reject 過的快取，`open()` 不會被呼叫第二次。
  it('openDb()：open() 逾時會 reject，且不會永久毒化快取——下一次呼叫會重新嘗試而不是拿到同一個永遠 reject 的快取', async () => {
    vi.useFakeTimers()
    try {
      let opens = 0
      const hungIdb = { open: () => { opens += 1; return { onsuccess: null, onerror: null, onupgradeneeded: null } } }
      __setIndexedDBFactoryForTests(() => hungIdb)

      const first = openDb()
      let firstRejected = false
      first.catch(() => { firstRejected = true })
      await vi.advanceTimersByTimeAsync(DB_OPEN_TIMEOUT_MS + 10)
      expect(firstRejected).toBe(true)
      expect(opens).toBe(1)

      const second = openDb()
      let secondRejected = false
      second.catch(() => { secondRejected = true })
      // 真的又呼叫了一次 open()：證明失敗之後快取被清掉、重新嘗試了，
      // 不是拿到同一個已經 reject 過的 promise。
      expect(opens).toBe(2)

      await vi.advanceTimersByTimeAsync(DB_OPEN_TIMEOUT_MS + 10)
      expect(secondRejected).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('reconcile()', () => {
    it('沒有 crumb 時什麼都不做，回傳 false', async () => {
      expect(await reconcile()).toBe(false)
      expect(await listSessions()).toHaveLength(0)
    })

    it('crumb 比 IndexedDB 最新一筆還新：補寫成 completed，並清掉 crumb', async () => {
      await saveSession({ ...valid, id: 's-old', startedAt: 100 })
      writeCrumb({ ...valid, id: 's-crumb', startedAt: 200, status: 'in_progress' })

      const changed = await reconcile()

      expect(changed).toBe(true)
      expect(readCrumb()).toBeNull()
      const out = await listSessions()
      const saved = out.find((r) => r.id === 's-crumb')
      expect(saved.status).toBe('completed')
    })

    it('IndexedDB 裡已經有更新的一筆（同一輪已經正常存檔過）：crumb 是過期的，只清掉不補寫', async () => {
      await saveSession({ ...valid, id: 's-new', startedAt: 500 })
      writeCrumb({ ...valid, id: 's-new', startedAt: 500, status: 'in_progress' })

      const changed = await reconcile()

      expect(changed).toBe(false)
      expect(readCrumb()).toBeNull()
      const out = await listSessions()
      expect(out).toHaveLength(1) // 沒有被補寫成第二筆
    })

    it('crumb 缺 id：視為無效 crumb，不觸碰 IndexedDB', async () => {
      writeCrumb({ startedAt: 100 }) // 缺 id，writeCrumb 白名單只留下 startedAt
      expect(await reconcile()).toBe(false)
    })
  })
})

describe('writeCrumb / readCrumb / clearCrumb（localStorage，同步）', () => {
  afterEach(() => { clearCrumb() })

  it('writeCrumb() 寫進去的也是白名單過的版本', () => {
    writeCrumb({ ...valid, landmarks: [{ x: 1 }], deviceId: 'abc' })
    const crumb = readCrumb()
    expect(crumb).toEqual(valid)
  })

  it('沒有 crumb 時 readCrumb() 回傳 null', () => {
    expect(readCrumb()).toBeNull()
  })

  it('clearCrumb() 之後 readCrumb() 回傳 null', () => {
    writeCrumb(valid)
    clearCrumb()
    expect(readCrumb()).toBeNull()
  })

  it('localStorage 丟例外（例如私密瀏覽）時 writeCrumb()/readCrumb() 不丟例外，安靜放棄', () => {
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        setItem() { throw new Error('QuotaExceededError') },
        getItem() { throw new Error('SecurityError') },
        removeItem() { throw new Error('SecurityError') },
      },
    })
    try {
      expect(() => writeCrumb(valid)).not.toThrow()
      expect(readCrumb()).toBeNull()
      expect(() => clearCrumb()).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original })
    }
  })
})
