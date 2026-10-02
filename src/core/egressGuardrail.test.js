/**
 * 對外網路端點的護欄（Blocking B-1）——**對 build 產物斷言**，不是對原始碼。
 *
 * ## 為什麼非得掃 build 產物不可
 *
 * 這個專案前幾輪的隱私審查問的都是「**我們自己的**程式碼會不會把資料送出去」，
 * 答案一直是不會（`fetch` / `XMLHttpRequest` / `sendBeacon` / `WebSocket` /
 * `EventSource` / `RTCPeerConnection` 在 `src/` 全掃過，只有同源的 `/models`、
 * `/wasm` 與 Service Worker 的 cacheFirst）。但 `@mediapipe/tasks-vision@1.0.1`
 * **自己帶了一支上報通道**：`vision_bundle.mjs` 裡的 `Fh` class 每 60 秒用原生
 * `fetch()` POST 到 `https://odml.pa.googleapis.com/v1/log`，無條件啟用，
 * 全 bundle 搜 `enableLogging` / `disableLogging` / `doNotTrack` / `optOut`
 * 全部 0 命中——沒有任何 opt-out。
 *
 * 那條通道**不經過我們的程式碼**，所以專案裡任何 DOM／儲存／文案護欄都看不到
 * 它；掃 `src/` 的護欄也看不到它。唯一看得到的地方是**打包之後的 bundle**。
 * 這就是這條測試存在的理由，也是這次沒有人發現的原因。
 *
 * ## 這條護欄鎖得到什麼
 *
 * 真的跑一次 `vite build`（這個專案實測約 0.3 秒，見下方 buildOnce() 的說明），
 * 然後把**打包產物**裡所有 `http://` / `https://` 字面值抓出來，逐一比對兩份
 * 清單：`ALLOWED_URL_PREFIXES`（根本不是請求目標的識別字與文件連結）與
 * `KNOWN_BLOCKED_ENDPOINTS`（真的是端點、拿不掉、改由 CSP 擋住的那一個）。
 * 下一次升級 MediaPipe、或加任何一個新的相依套件時，只要那個套件的程式碼裡
 * 出現新的端點，這條測試會當場紅——不需要有人記得回來加檔名、加關鍵字，
 * 也不需要有人主動去 grep。
 *
 * ## 鎖不到什麼（誠實記錄）
 *
 * 1. **只認得「字面值寫在 bundle 裡」的 URL。** 拼接出來的
 *    （`'https://' + host`）、Base64／編碼過的、或從執行期資料讀出來的端點，
 *    這條測試看不到。它擋的是「相依套件大方地把端點寫在程式碼裡」這個**實際
 *    發生過**的情境，不是一個會主動規避掃描的對手。
 * 2. **不掃 `dist/wasm/`。** 那三個 emscripten glue 檔是從 `public/wasm/`
 *    原樣複製過去的，裡面有幾十個**註解裡的**說明連結（MDN、emscripten 的
 *    issue 頁、`http://server.com` 這種文件範例），全部不是執行期請求。
 *    把它們納進來只會逼人維護一份幾十筆的白名單，那份白名單很快就沒有人看。
 *    代價（明文接受）：日後若有人重新 vendored 一份帶有真實端點的 wasm glue，
 *    這條測試不會發現——那要靠下面第 3 點與實機驗證。
 * 3. **它不是「資料不會外流」的證明，只是「端點沒有偷偷多出來」的證明。**
 *    真正把外送擋掉的是 CSP 的 `connect-src`（`index.html` 的 `<meta>` ＋
 *    `public/_headers`，由 `redlineGuardrail.test.js` 鎖住兩份都在且值一致）。
 *    這條測試是**告警**，CSP 才是**防線**——而 CSP 在 iPadOS Safari 上會不會
 *    誤擋 MediaPipe 載入 wasm／模型，jsdom 測不出來，只能在真機上確認
 *    （展前檢查清單有對應的必做項目）。
 * 4. `dist/` 是 gitignore 的，這條測試每次都自己重建，不依賴上一次的殘留產物
 *    （Ruling CH (b)：讀一份過期的 dist 等於讓這條護欄變成恆綠的裝飾）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { REPO_ROOT_DIR } from './copyGuardrail.js'

const DIST_DIR = path.join(REPO_ROOT_DIR, 'dist')

/**
 * 白名單。每一筆都必須寫明「為什麼它不是一個外送端點」——靜默跳過是被禁止的。
 * 比對用**前綴**而不是完全相等：w3.org 的命名空間有三個（svg / xlink / MathML），
 * vuejs.org 的錯誤說明頁後面會接錯誤碼。
 */
const ALLOWED_URL_PREFIXES = [
  {
    prefix: 'http://www.w3.org/',
    reason: 'XML／SVG 的命名空間字串（svg、xlink、MathML）。Vue 用它呼叫 '
      + 'document.createElementNS()，是一個識別字，不是會被請求的位址。',
  },
  {
    prefix: 'https://vuejs.org/error-reference/',
    reason: 'Vue 執行期警告訊息裡附的說明文件連結，只會被印進 console，'
      + '不會被 fetch。（本專案的正式 bundle 連 console 都被 drop 掉了。）',
  },
]

/**
 * 「已知的真實端點，留在 bundle 裡、由 CSP 在瀏覽器層擋住」——跟上面那份
 * 白名單**性質完全不同**，所以分成兩份，不混在一起。
 *
 * 上面那份是「這根本不是一個會被請求的位址」；這一份是「這**確實**是一個會被
 * 請求的位址，我們沒辦法把它從第三方的 minified bundle 裡拿掉，所以改成在
 * 瀏覽器層擋掉，並且把它釘在這裡」。
 *
 * 為什麼不直接把它從 bundle 裡刪掉：那要 patch `node_modules` 裡一個 minified
 * 的 vendored 檔案，下一次 `npm i` 就沒了，而且沒有人會發現——那比現在這個
 * 狀態更危險，因為它會讓人以為問題解決了。
 *
 * 釘在這裡的價值：MediaPipe 升版之後如果這個端點**變了**，或者多出第二個，
 * 這條測試會當場紅（下面那條「這份清單必須逐字相符」的測試），逼下一個人
 * 重新做一次 CSP 是否還擋得住的判斷。
 *
 * ⚠ 由此推論出的一件事，報告與展前檢查清單都必須寫清楚：
 *   `grep -ohE "https?://…" dist/assets/*.js` **仍然會看到這個 URL**。
 *   它留在 bundle 裡是預期中的；真正該驗的是「執行期它有沒有真的送出去」，
 *   那件事只有在 iPadOS Safari 真機上、看 devtools 的 CSP 阻擋紀錄才驗得到。
 */
const KNOWN_BLOCKED_ENDPOINTS = [
  {
    url: 'https://odml.pa.googleapis.com/v1/log',
    reason: '@mediapipe/tasks-vision@1.0.1 內建、無法關閉的遙測上報端點'
      + '（vision_bundle.mjs 的 Fh class，每 60 秒一次原生 fetch POST）。'
      + '由 CSP 的 connect-src 擋掉，見 index.html 的 <meta> 與 public/_headers。',
  },
]

/** 抓出文字裡所有 http:// 或 https:// 開頭的字面值。 */
const URL_RE = /https?:\/\/[a-zA-Z0-9./_-]+/g

function urlsIn(text) {
  return text.match(URL_RE) ?? []
}

/**
 * 掃描範圍：`dist/` 底下**由打包器產生**的文字檔。
 * - `dist/assets/*.js`：第一方程式碼 ＋ 所有 npm 相依套件都在這裡。
 * - `dist/sw.js`：Service Worker（獨立進入點，見 vite.config.js）。
 * - `dist/index.html`、`dist/manifest.webmanifest`：入口與 PWA manifest。
 * 刻意排除 `dist/wasm/`（理由見檔頭「鎖不到什麼」第 2 點）與 `dist/models/`、
 * `dist/icons/`（二進位）。
 */
function listBuiltTextFiles() {
  const out = []
  const assetsDir = path.join(DIST_DIR, 'assets')
  if (existsSync(assetsDir)) {
    for (const name of readdirSync(assetsDir)) {
      if (name.endsWith('.js')) out.push(path.join(assetsDir, name))
    }
  }
  for (const name of ['sw.js', 'index.html', 'manifest.webmanifest']) {
    const full = path.join(DIST_DIR, name)
    if (existsSync(full)) out.push(full)
  }
  return out
}

/**
 * 真的跑一次 `vite build`。
 *
 * 直接用 node 執行本地的 vite bin，不透過 npm／npx：跨平台（Windows 上 npx 是
 * npx.cmd，不開 shell 的 execFile 叫不到）、不多一層 process、也不會因為使用者
 * 的 PATH 不同而失效。實測這個專案 build 一次約 0.3 秒（79 個模組），比起「掃
 * node_modules 猜哪些檔案會進 bundle」這種替代方案，直接建一次既快又準確。
 */
function buildOnce() {
  const viteBin = path.join(REPO_ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  execFileSync(process.execPath, [viteBin, 'build'], {
    cwd: REPO_ROOT_DIR,
    stdio: 'pipe',
    encoding: 'utf8',
    // NODE_ENV 一定要明寫成 production。vitest 會把 NODE_ENV 設成 'test'，
    // 子行程原樣繼承的話，Vue 會被解析成帶 __DEV__ 警告字串的那一份建置
    // ——實測：不設這一行，bundle 裡會多出 cli.vuejs.org／github.com 兩個
    // 只存在於開發版警告訊息裡的 URL，而 `npm run build` 產出的 bundle 沒有。
    // 那會讓這條護欄掃的東西跟真正要出貨的東西**不是同一個**，白名單也會被
    // 迫放行兩筆根本不該存在的項目。
    env: { ...process.env, NODE_ENV: 'production' },
  })
}

describe('Blocking B-1：build 產物不得出現白名單以外的網路端點', () => {
  beforeAll(() => { buildOnce() }, 120_000)

  it('dist/ 的打包產物裡確實有東西可以掃（護欄本身不能是空轉的）', () => {
    const files = listBuiltTextFiles()
    // 沒有這一條，build 失敗或輸出目錄改名時下面那條會「掃 0 個檔案 → 全綠」，
    // 變成 Ruling CH 說的那種看起來在保護、其實什麼都沒做的測試。
    expect(files.length, 'dist/ 裡找不到任何打包產物，這條護欄等於沒跑').toBeGreaterThan(0)
    const bundles = files.filter((f) => f.includes(`${path.sep}assets${path.sep}`))
    expect(bundles.length, 'dist/assets/*.js 是唯一會含相依套件程式碼的地方').toBeGreaterThan(0)
    // 掃描器本身也要證明它真的看得到 URL：Vue 的命名空間字串一定在 bundle 裡。
    const all = bundles.flatMap((f) => urlsIn(readFileSync(f, 'utf8')))
    expect(all.length, 'bundle 裡連一個 URL 都抓不到，代表這個掃描器壞了').toBeGreaterThan(0)
  })

  it('打包產物裡出現的真實端點，逐字就是 KNOWN_BLOCKED_ENDPOINTS 這一份，不多不少', () => {
    // 這一條把「B-1 抓到的那個端點」釘死。MediaPipe 升版換了位址、或多出
    // 第二支上報通道時，這裡會紅——那正是下一個人必須重新判斷「CSP 還擋不擋
    // 得住」的時機點。用完全相等（不是 toContain）：少了也要紅，因為那代表
    // 上游改了行為，這份註解與 CSP 的理由也得跟著重新確認。
    const found = new Set()
    for (const file of listBuiltTextFiles()) {
      for (const url of urlsIn(readFileSync(file, 'utf8'))) {
        if (ALLOWED_URL_PREFIXES.some((a) => url.startsWith(a.prefix))) continue
        found.add(url)
      }
    }
    expect([...found].sort()).toEqual(KNOWN_BLOCKED_ENDPOINTS.map((e) => e.url).sort())
  })

  it('每一個出現在打包產物裡的 URL 都必須在白名單或已知清單上（新相依套件的新端點會在這裡當場紅）', () => {
    const offenders = []
    for (const file of listBuiltTextFiles()) {
      for (const url of urlsIn(readFileSync(file, 'utf8'))) {
        if (ALLOWED_URL_PREFIXES.some((a) => url.startsWith(a.prefix))) continue
        if (KNOWN_BLOCKED_ENDPOINTS.some((e) => e.url === url)) continue
        offenders.push(`${path.relative(REPO_ROOT_DIR, file)} → ${url}`)
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      '打包產物裡出現了白名單以外的網路端點。這通常代表某個相依套件自己帶了一支'
      + '上報／下載通道（B-1 抓到的 MediaPipe 遙測就是這樣進來的）。請先確認它'
      + '是什麼、會不會在執行期被請求：確定它根本不是請求目標（命名空間、文件'
      + '連結）就加進 ALLOWED_URL_PREFIXES；確定它是真的端點、只能靠 CSP 擋，'
      + '就加進 KNOWN_BLOCKED_ENDPOINTS。兩者都必須寫明理由。',
    ).toEqual([])
  })

  it('正式 bundle 不得殘留任何 console 輸出（隱私紅線，順帶鎖住 vite.config.js 的 minify 設定）', () => {
    // 這一條本來只在審查報告裡用 grep 手動確認過，沒有任何測試在守它。
    // vite.config.js 的註解已經記錄了「esbuild.drop 在 vite@8 會被忽略、
    // 真正生效的是 rolldown 的 output.minify.compress.dropConsole」——那代表
    // 這個設定曾經悄悄失效過一次，正好是需要護欄的形狀。
    for (const file of listBuiltTextFiles()) {
      if (!file.endsWith('.js')) continue
      const text = readFileSync(file, 'utf8')
      expect(text.includes('console.'), `${path.relative(REPO_ROOT_DIR, file)} 殘留 console 呼叫`).toBe(false)
      expect(text.includes('debugger'), `${path.relative(REPO_ROOT_DIR, file)} 殘留 debugger`).toBe(false)
    }
  })

  it('dist/ 不得產生 source map（註解裡的內部推導不能連同原始碼一起送出去）', () => {
    // 這個專案的註解寫了大量內部推導（閾值是沒人量過的佔位值、哪些護欄裝錯過
    // 層、哪些失敗模式已知未修）。source map 等於把這些連同原始碼送給任何打開
    // devtools 的人。同樣是只在審查報告裡手動確認過、沒有護欄的一條。
    for (const file of listBuiltTextFiles()) {
      if (!file.endsWith('.js')) continue
      const text = readFileSync(file, 'utf8')
      expect(text.includes('sourceMappingURL'), `${path.relative(REPO_ROOT_DIR, file)} 有 sourceMappingURL`).toBe(false)
    }
    // listBuiltTextFiles() 只挑 .js/.html/.webmanifest，掃不到 .map 檔本身，
    // 所以這裡直接翻 dist/assets 與 dist/ 根層目錄。
    const mapFiles = [
      ...(existsSync(path.join(DIST_DIR, 'assets')) ? readdirSync(path.join(DIST_DIR, 'assets')) : []),
      ...readdirSync(DIST_DIR),
    ].filter((name) => name.endsWith('.map'))
    expect(mapFiles).toEqual([])
  })
})
