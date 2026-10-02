import { FilesetResolver } from '@mediapipe/tasks-vision'
import { MODEL_ASSET_PATHS } from './inferenceService.js'

// 只存一個版本字串，不存任何使用者資料（隱私紅線）。用字串而非單純布林，
// 是為了讓日後模型/wasm 資產真的換了一批（見 src/sw.js 的 MODEL_CACHE
// 命名註解——那時要手動改 MODEL_CACHE 的字串本身），這裡也能配合改一個
// 新字串，逼所有裝置的 isOfflineReady() 回到 false、觸發重新暖機。
const READY_FLAG_KEY = 'fq-offline-ready'
const READY_FLAG_VALUE = 'v1'

const ASSET_LABELS = {
  wasm: 'MediaPipe 推論引擎',
  pose: '姿勢模型',
  face: '臉部模型',
  object: '物件偵測模型',
}

function readFlag() {
  try {
    return localStorage.getItem(READY_FLAG_KEY)
  } catch {
    // Safari 私密瀏覽或儲存被封鎖時 localStorage 可能直接丟例外，
    // 當成「尚未就緒」處理，不讓呼叫端跟著炸掉。
    return null
  }
}

function writeFlag() {
  try {
    localStorage.setItem(READY_FLAG_KEY, READY_FLAG_VALUE)
  } catch {
    // 寫入失敗不當成致命錯誤：這一輪資產本身多半已經成功寫進 Cache
    // Storage（由 sw.js 的 cacheFirst 負責），只是「就緒旗標」這個使用者
    // 體感提示掛了。下次呼叫 isOfflineReady() 會回 false，UI 只是會多問
    // 使用者跑一次熱身而已，不影響真正的離線可用性。
  }
}

/** 同步查詢是否已經完成過一輪離線暖機（見 ensureOfflineAssets）。 */
export function isOfflineReady() {
  return readFlag() === READY_FLAG_VALUE
}

/**
 * fetch 一個 URL，確認真的下載成功（不是 fetch() resolve 就代表成功——
 * 4xx/5xx 也會 resolve，要另外檢查 response.ok）。
 *
 * 不在這裡自己做逾時：src/sw.js 的 cacheFirst() 已經對每一個同源請求套了
 * 12 秒的 AbortController 逾時（ASSET_TIMEOUT_MS），逾時會讓這個 fetch()
 * reject，往上被 ensureOfflineAssets() 的 try/catch 接住，不需要在主執行緒
 * 這邊重複一層。
 */
async function primeUrl(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`資產下載失敗：${url}（HTTP ${response.status}）`)
}

/**
 * 暖 MediaPipe wasm 推論引擎的快取。
 *
 * 刻意不維護第二份 wasm 檔名清單：路徑一律問
 * FilesetResolver.forVisionTasks('/wasm')（跟 inferenceService.js 的
 * init() 呼叫方式完全一致，同一套 SIMD 偵測邏輯），不會跟正式推論路徑
 * 挑到不同檔案。
 *
 * 已讀過 @mediapipe/tasks-vision 原始碼確認一件容易誤會的事：
 * forVisionTasks() 本身**不會**下載 wasm binary——它只用一段內嵌的
 * WebAssembly bytecode 在本地做 SIMD 能力探測（WebAssembly.instantiate，
 * 不是網路請求），然後回傳算好的 { wasmLoaderPath, wasmBinaryPath }
 * 字串。真正的下載發生在 createFromOptions() 內部——但那會建立 GL
 * context、佔用 GPU 資源，這裡的目的只是把 sw.js 的 HTTP 快取填滿，
 * 不需要、也不應該真的初始化任何推論器。所以這裡在拿到路徑之後自己補一次
 * fetch()，讓請求照樣經過 sw.js 的 cacheFirst 寫進快取，全程不碰
 * createFromOptions()。
 */
async function primeWasm() {
  const fileset = await FilesetResolver.forVisionTasks('/wasm')
  await Promise.all([primeUrl(fileset.wasmLoaderPath), primeUrl(fileset.wasmBinaryPath)])
}

const ITEMS = [
  { key: 'wasm', label: ASSET_LABELS.wasm, run: primeWasm },
  { key: 'pose', label: ASSET_LABELS.pose, run: () => primeUrl(MODEL_ASSET_PATHS.pose) },
  { key: 'face', label: ASSET_LABELS.face, run: () => primeUrl(MODEL_ASSET_PATHS.face) },
  { key: 'object', label: ASSET_LABELS.object, run: () => primeUrl(MODEL_ASSET_PATHS.object) },
]

/**
 * 主動把展場離線需要的所有資產（wasm 推論引擎 + 3 個模型，合計約 35.5MB）
 * 都跑過一次下載，讓 src/sw.js 的 cacheFirst 把它們寫進 Cache Storage，
 * 而不是被動等使用者自己剛好把三個 track 都用過一輪。
 *
 * 可重覆呼叫、天然可當「重試」用：已經進快取的項目會在 sw.js 的
 * cache.match() 命中，這裡的 fetch() 幾乎立刻 resolve，不會重打網路；
 * 只有真的還沒快取或上次失敗的項目才會真的再打一次。UI 端只要在失敗時
 * 提供一個按鈕重新呼叫這個函式即可，不需要在這裡另外做重試迴圈。
 *
 * @param {{ onProgress?: (p: { done: number, total: number, label: string | null }) => void }} [options]
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function ensureOfflineAssets({ onProgress } = {}) {
  const total = ITEMS.length
  onProgress?.({ done: 0, total, label: null })
  let done = 0
  for (const item of ITEMS) {
    try {
      await item.run()
    } catch (error) {
      return { ok: false, error }
    }
    done += 1
    onProgress?.({ done, total, label: item.label })
  }
  writeFlag()
  return { ok: true }
}
