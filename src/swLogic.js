// src/sw.js 的純邏輯抽在這裡，唯一目的是讓它可以被 vitest import 並鎖住
// 行為（見 src/sw.test.js）。
//
// 這個檔案刻意不是 vite build 的獨立進入點（rolldownOptions.input 只列了
// main 跟 sw 兩個進入點，這個檔案不在裡面）：它只被 src/sw.js import，
// build 時會被整個內聯進 dist/sw.js 這唯一一個輸出檔裡，不會在正式站多
// 出一個檔案，也不會讓 dist/sw.js 殘留 import/export 語法——這點很關鍵，
// 因為 src/main.js 是用 navigator.serviceWorker.register('/sw.js')
// 註冊（沒有帶 { type: 'module' }），瀏覽器會把 /sw.js 當成 classic
// script 執行，殘留的 export 語句會直接讓整個 SW 註冊失敗（SyntaxError）。
// 已用 npm run build 實測確認：dist/sw.js 裡沒有任何 import/export 字樣。
//
// 這裡的函式跟原本寫在 sw.js 裡時一樣，倚賴 ServiceWorkerGlobalScope 的
// 環境全域（self / caches / fetch / Request / Response / AbortController /
// setTimeout / clearTimeout），不做依賴注入式的重構——測試裡用
// vi.stubGlobal 模擬這些全域，行為跟正式執行時完全一致，不需要另外維護
// 一套「測試用的介面」跟正式路徑分岔。

export const VERSION = 'v1'
export const SHELL_CACHE = `fq-shell-${VERSION}`
export const ASSET_CACHE = `fq-asset-${VERSION}`

// 這份快取刻意不含 VERSION：模型 + wasm 合計約 35.5MB（models 23.37MB +
// 目標裝置實際選中的單一 wasm 變體 11.76MB + 其 loader js 0.33MB，SIMD/nosimd
// 只會擇一下載，module 變體永遠不會被用到——見 src/core/inferenceService.js
// 與 src/core/offlineAssets.js 的路徑選擇邏輯）是使用者用網路換來的離線資產，
// 不隨程式碼改版而失效。如果跟 SHELL_CACHE/ASSET_CACHE 一樣繫在 VERSION 上，
// 日後任何一次改 sw.js（哪怕只是修一行 app-shell 邏輯的 bugfix、跟模型無關）
// 都會在 activate() 的清舊快取步驟把這 35.5MB 一起清掉，逼使用者在展場現場
// 重新暖機，而且沒有任何提示——這在展前最後一刻做修正時特別危險。
// 真的要換模型檔本身（需要讓舊快取失效）時，才手動改這個常數字串本身。
// staleCacheNames() 的測試（src/sw.test.js）直接鎖住這條：VERSION 換了
// 也不會讓 MODEL_CACHE 被 activate() 清掉。
export const MODEL_CACHE = 'fq-model-assets'

// install 只預快取極小的 app shell，確保安裝一定成功。
//
// 快取策略的取捨（展場零網路是硬要求，見 spec）：
// public/models + public/wasm 合計約 57MB（三個模型 + 三組 wasm 變體全部算
// 進去）。若在 install 階段全部 precache，使用者第一次「加入主畫面」就得先
// 扛住 50+MB 下載，網路稍差就整個安裝失敗、使用者根本連 app shell 都拿不到；
// 反之只快取 app shell（幾十 KB），安裝幾乎瞬間成功。真正需要離線可用的是
// 「已經完整開過一次之後」的第二次開啟——這正是 spec 描述的展場情境：開幕前
// 有網路、正式展出時飛航模式。因此模型與 wasm 改用下面 cacheFirst 的 runtime
// caching：第一次真的載入推論引擎時觸發下載並寫入 MODEL_CACHE，之後每次都
// 直接命中快取。代價是「必須至少完整成功跑過一次 app」才算完成離線安裝——
// 這點跟 iPad 展場 SOP（開幕前先開一次熱身）一致，寫進了驗收清單（Step 8）；
// src/core/offlineAssets.js 提供了可以主動觸發這次熱身、回報進度的介面，
// 不用依賴使用者自己恰好把三個模型都用過一輪。
// 另外 Safari 16+ 的 Cache Storage 配額是以可用磁碟空間的一個比例計算，
// 不是舊版那種幾十 MB 的死限制，57MB 本身不是配額問題，是「安裝等待時間」問題。
export const SHELL = ['/', '/index.html', '/manifest.webmanifest']

export const NAV_TIMEOUT_MS = 2000

// 背景暖資產（assets/icons/models/wasm）逾時比導覽的 2 秒寬鬆很多：這裡是
// 背景在補快取，使用者沒有被卡在白畫面，可以多等一點。但還是要有硬上限——
// 沒有這條，captive portal 情境下 fetch() 會 hang 到系統逾時（常見 60 秒以
// 上），讓 offlineAssets.js 的 ensureOfflineAssets() 永遠拿不到 resolve 也
// 拿不到 reject：進度條卡死、沒有任何錯誤可以顯示給工作人員看，這正是
// Task 21 想防的「卡白畫面」換了個地方發生。12 秒是抓「展場 wifi 慢但通」
// 與「明確判定它卡住了」之間的界線：合計最重的單一檔案(models 裡的
// efficientdet_lite0.tflite，實測 13,836,895 bytes ≈13.84MB)在很保守的
// 2MB/s 估計下約 7 秒可傳完，12 秒留了將近一倍餘裕。
export const ASSET_TIMEOUT_MS = 12000

const KEEP_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, MODEL_CACHE])

/** activate() 該刪掉的舊快取名稱——不在目前三個保留名單裡的全部視為舊版。 */
export function staleCacheNames(names) {
  return names.filter((n) => !KEEP_CACHES.has(n))
}

/**
 * 可否寫入快取。
 *
 * 刻意不用 request.mode 判斷：導覽請求的 mode 永遠是 'navigate'、
 * 子資源多半是 'no-cors'，用 mode 判斷會讓 index.html 根本進不了快取，
 * 離線時直接白畫面。正確條件是比對 origin、檢查 response.ok、排除 opaque。
 */
export function cacheable(request, response) {
  return new URL(request.url).origin === self.location.origin
      && response.ok
      && response.type !== 'opaque'
}

/** 擋 captive portal 登入頁汙染快取：必須是 HTML 且含有我們自己的標記 */
export async function isOurHtml(response) {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/html')) return false
  const text = await response.clone().text()
  return text.includes('data-app-root="focus-quest"')
}

/**
 * 寫快取是最佳努力，不該讓一個已經成功拿到的回應變成失敗。
 *
 * cache.put() 有可能失敗（例如 QuotaExceededError）。改成 await 是為了
 * 確保「頁面端看到成功」等於「真的寫進 Cache Storage」（見下面 cacheFirst/
 * handleNavigation 內的說明），但這只解決「該不該等」，沒解決「等到的是
 * 失敗該怎麼辦」——如果讓 cache.put() 的例外原封不動往外拋，會把
 * respondWith()/呼叫端的 promise 一起弄成 reject，等於「下載其實成功了、
 * 只是寫快取失敗」被降級成「連請求都失敗」。展場目標機是儲存空間充裕的
 * iPad Pro，觸發機率低，但方向不能反：快取寫不進去，該回傳的還是那個已經
 * 下載成功的 response，只是這次沒被存起來、下次還會再打一次網路而已。
 */
async function putBestEffort(cache, request, response) {
  try {
    await cache.put(request, response)
  } catch {
    // 吞掉，理由見上方函式註解。
  }
}

/**
 * install 階段把單一 app-shell 檔案寫進快取，套用跟 fetch 事件同一套
 * cacheable() 判準,並對 HTML 項目（'/'、'/index.html'）額外套 isOurHtml()
 * ——理由跟 handleNavigation 完全一樣，只是發生在 install 而非導覽時。
 *
 * HTTPS 下 captive portal 想在這裡冒充回應，得先通過我們的 TLS 憑證驗證，
 * 實務上不可能發生；就算真的發生，isOurHtml() 判假時這裡選擇「略過這個
 * 項目、不讓整個 install 失敗」，因為下一次成功的真實導覽
 * （handleNavigation）會自動把 index.html 覆蓋回正確版本。但如果是真的
 * 網路錯誤或伺服器回非 2xx，仍然要讓例外往外拋、讓 install 整個失敗——
 * 跟原本 cache.addAll() 的行為一致，安裝一半的 shell 不該被當成安裝成功。
 */
export async function cacheShellEntry(cache, url) {
  const request = new Request(url)
  const response = await fetch(request)
  if (!cacheable(request, response)) throw new Error(`shell asset not cacheable: ${url}`)
  const isHtmlEntry = url === '/' || url === '/index.html'
  if (isHtmlEntry && !(await isOurHtml(response))) return
  await putBestEffort(cache, request, response)
}

export async function handleNavigation(request) {
  const controller = new AbortController()
  // 真正的風險不是斷網（會立刻 reject），而是 captive portal——
  // 連上了但沒有對外網路，fetch 會 hang 到系統逾時，畫面一直空白。
  const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS)
  try {
    const response = await fetch(request, { signal: controller.signal })
    if (cacheable(request, response) && await isOurHtml(response)) {
      const cache = await caches.open(SHELL_CACHE)
      // 等寫入真的完成才回傳：respondWith 的 promise 沒結束之前 SW 不會被
      // 提前終止，這是唯一保證 cache.put() 真的落地、而不是被瀏覽器在
      // 背景中途砍掉的方式（同樣的理由也套在下面的 cacheFirst()）。
      // putBestEffort：寫入失敗不該讓已經拿到的 response 變成失敗。
      await putBestEffort(cache, '/index.html', response.clone())
    }
    return response
  } catch {
    const cached = await caches.match('/index.html')
    return cached ?? new Response('離線且尚未安裝完成', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  } finally {
    clearTimeout(timer)
  }
}

export async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS)
  try {
    const response = await fetch(request, { signal: controller.signal })
    // 等寫入真的完成才回傳（理由見 handleNavigation 內的同一句註解）：
    // 這對 35MB 的模型/wasm 尤其重要——這是 offlineAssets.js 暖快取時
    // 唯一能確保「頁面端看到下載成功」等於「真的寫進 Cache Storage」的作法。
    // putBestEffort：寫入失敗不該讓已經下載成功的 response 變成失敗。
    if (cacheable(request, response)) await putBestEffort(cache, request, response.clone())
    return response
  } finally {
    clearTimeout(timer)
  }
}
