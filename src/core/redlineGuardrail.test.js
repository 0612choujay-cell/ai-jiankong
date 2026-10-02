/**
 * 工程紅線的原始碼護欄（Blocking B-2）。
 *
 * `final-review-context.md` 白紙黑字列了幾條「不可違反的紅線」，複審把其中三條
 * **全部改壞**，666 條測試一條都沒紅：
 *
 *   | 紅線 | 位置 | 突變後 |
 *   |---|---|---|
 *   | `getUserMedia` 必須 `audio: false` | `core/cameraCapture.js` | 改成 true → 全綠 |
 *   | `_headers` 必須有 `Permissions-Policy` | `public/_headers` | 整行刪掉 → 全綠 |
 *   | 禁用 `SpeechRecognition` | 全專案 0 命中 | 沒有任何護欄可攻 |
 *
 * 第一條的後果是**開啟兒童的麥克風**，而且 iOS 的語音辨識會把音訊送到 Apple
 * 伺服器——同時隱私說明頁還寫著「不會要麥克風權限，不錄音」。三條的共同形狀
 * 都是這個專案「缺陷家族」那一節描述的那一種：**沒有錯誤訊息，沒有人會發現。**
 *
 * ## 裝在哪一層（Ruling DK）
 *
 * 裝在**違規會發生的地方**——原始碼本身，不是「最好測的地方」。這個專案已經
 * 連續兩次把護欄裝錯層（測 store 方法、複審把呼叫點改回直寫、全綠）。
 * 一條「這個 API 不准出現在任何地方」的規則，唯一裝得對的地方就是對所有
 * 原始檔案做全掃。
 *
 * ## 為什麼沿用 copyGuardrail.js 的基礎設施
 *
 * `listFilesRecursive()` / `listPublicTextFiles()` / `blankPureCommentLines()` /
 * `stripHtmlCommentSpans()` 這些「把檔案系統內容轉成可斷言的資料」的工具早就
 * 存在，只是從來沒有人拿它們來守工程紅線。掃描範圍由 `readdirSync` 決定而不是
 * 由人工檔名清單決定，這正是 Ruling CA 當初要的性質：新增檔案不需要有人記得
 * 回來加一行。這個檔案另外開一份，而不是塞進 `copyGuardrail.test.js`：那個檔案
 * 守的是文案（禁用詞、長度），這裡守的是工程紅線（API、header），兩件事的
 * 例外清單與判準完全不同，混在一起只會讓兩邊的邊界都變模糊。
 *
 * ## 這些護欄鎖不到什麼（誠實記錄）
 *
 * - **只掃字面值。** `navigator['media' + 'Devices']` 或
 *   `window[atob('U3BlZWNo…')]` 這種拼出來的寫法掃不到。這裡擋的是「下一個
 *   維護者大方地加一個功能」，不是一個會主動規避掃描的對手。
 * - **整行註解會先被挖空**（見 `blankPureCommentLines()`），所以註解裡寫
 *   `// 禁用 SpeechRecognition` 不會被誤判成違規；相對地，**行尾附掛**的
 *   行內註解不會被挖空，那種位置寫禁用 API 的名稱會誤報（假陽性，由人看一眼
 *   確認，不是假陰性）。
 * - **`public/_headers` 只有 Cloudflare Pages / Netlify 這類 host 會認**
 *   （M-2）。這裡只能斷言「這個檔案裡寫著這幾行」，斷言不了「真的 host 回了
 *   這幾個 header」——那要靠展前檢查清單裡用 curl 做的實機驗證。
 * - **CSP 會不會誤擋 MediaPipe 載入 wasm／模型，jsdom 測不出來。** 這裡斷言的
 *   是「CSP 在兩個載體裡都存在、而且值一致、而且沒有放行任何外部主機」，
 *   不是「它在 iPadOS Safari 上實際生效且沒有副作用」。後者只能在真機上確認。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  SRC_DIR, PUBLIC_DIR, REPO_ROOT_DIR,
  listFilesRecursive, listPublicTextFiles, fileExists,
  blankPureCommentLines, stripHtmlCommentSpans,
} from './copyGuardrail.js'

const CAMERA_CAPTURE = path.join(SRC_DIR, 'core', 'cameraCapture.js')
const HEADERS_FILE = path.join(PUBLIC_DIR, '_headers')
const INDEX_HTML = path.join(REPO_ROOT_DIR, 'index.html')

/**
 * 掃描範圍：`src/**\/*.js` ＋ `src/**\/*.vue`（排除 `*.test.js`）＋ `public/` 的
 * 文字類靜態資產（含 vendored 的 emscripten wasm glue）＋ `index.html`。
 *
 * 刻意**不**沿用 `listAllJsSourceFiles()`：那個函式為了文案護欄的需要排除了
 * `copyGuardrail.js` 自己（它必須逐字含有每一個禁用詞），但工程紅線沒有那個
 * 豁免理由——這裡要掃的是每一個檔案。唯一的排除是 `*.test.js`，理由跟
 * copyGuardrail 一樣、而且是明文的：這個檔案自己必須逐字寫出禁用 API 的名稱，
 * 否則下面那條規則無從比對。
 */
function firstPartyFiles() {
  return [
    ...listFilesRecursive(SRC_DIR, ['.js', '.vue']).filter((f) => !f.endsWith('.test.js')),
    INDEX_HTML,
  ]
}

function allSourceFiles() {
  return [...firstPartyFiles(), ...listPublicTextFiles()]
}

/**
 * vendored 的第三方產物：`public/wasm/` 底下那三個 emscripten glue
 * （各約 332KB 的 minified JS，合計約 1MB）。
 *
 * 這個判斷用目錄而不是檔名清單：日後 MediaPipe 換版、檔名改了，判斷仍然成立。
 * `public/` 的其他文字檔（`manifest.webmanifest`、`_headers`）是我們自己寫的，
 * 不走這條路。
 */
function isVendoredArtifact(file) {
  return rel(file).startsWith('public/wasm/')
}

/**
 * 讀檔並挖掉整行註解與配對得到的 `<!-- -->` 區塊（見 copyGuardrail.js 的說明）。
 *
 * ── 為什麼 vendored 檔案走不同的路徑（偶發逾時的根因）──────────────
 *
 * 剝註解（`stripHtmlCommentSpans` 的配對掃描）是**逐字元**的。對第一方程式碼
 * 它是實質的：這個專案有十幾處註解在解釋鏡頭生命週期時逐字提到
 * `getUserMedia`、`MediaRecorder` 這些名字，不挖掉就會被誤判成違規——那正是
 * 複審 Blocking-2 修過的東西，**不准拿掉**。
 *
 * 但對 `public/wasm/` 底下那 1MB 的 minified glue，剝註解是在為一件不需要的事
 * 付全部的成本：這個檔案對它們的唯一斷言是「提到 `.getUserMedia(` 的非第一方
 * 檔案就只有這三個，一個不多」——那是**成員資格**檢查，不是內容分析。
 * minified 產物裡本來就幾乎沒有註解，而「它剛好在註解裡提到禁用 API」這種
 * 誤判對一個我們不打算修改、只想釘住成員資格的第三方產物來說也無所謂：
 * 誤判的方向是「多列一個檔名」，會被人看見，不是靜默漏掉。
 *
 * 這件事在單獨跑這個檔案時撐得住（12 條測試各自重掃一次，合計約 80ms），
 * 全套 54 個 worker 搶 CPU 時就會爆掉預設逾時——已經有兩次獨立目擊。
 * 不調大逾時：那會讓這條護欄在 CI 或更慢的機器上繼續偶發紅，而每一次紅都要
 * 有人重跑一遍才知道是不是真的。偶發逾時跟順序依賴是同一種稅。
 *
 * 第二層修正是 `scanCache`：同一個檔案在這個檔案裡會被掃 7 次（每條禁用 API
 * 一次 ＋ getUserMedia 那兩條），而檔案在一次測試執行中不會變。
 */
const scanCache = new Map()

function readCode(file) {
  if (scanCache.has(file)) return scanCache.get(file)
  const raw = readFileSync(file, 'utf8')
  const text = isVendoredArtifact(file) ? raw : blankPureCommentLines(stripHtmlCommentSpans(raw))
  scanCache.set(file, text)
  return text
}

function rel(file) {
  return path.relative(REPO_ROOT_DIR, file).replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// 紅線 1：getUserMedia 必須 audio: false，而且全專案只有一個呼叫點
// ---------------------------------------------------------------------------

describe('紅線：getUserMedia 的 audio 永遠是 false（改壞的後果是開啟兒童的麥克風）', () => {
  it('cameraCapture.js 的 CONSTRAINTS 寫著 audio: false，而且整個檔案裡沒有 audio: true', () => {
    expect(fileExists(CAMERA_CAPTURE), 'cameraCapture.js 不見了——這條紅線失去了它的錨點').toBe(true)
    const code = readCode(CAMERA_CAPTURE)
    expect(/\baudio\s*:\s*false\b/.test(code), 'getUserMedia 的 constraints 必須明確 audio: false').toBe(true)
    expect(/\baudio\s*:\s*true\b/.test(code), 'audio 在任何情況下都不得為 true').toBe(false)
  })

  it('第一方程式碼裡只有 cameraCapture.js 一個檔案真的呼叫 .getUserMedia()', () => {
    // 用「`.getUserMedia(` 這個呼叫形狀」而不是裸字串 `getUserMedia`：這個專案
    // 有十幾處註解在解釋鏡頭的生命週期時提到這個名字（App.vue、BattleView.vue、
    // session.js…），整行註解雖然已經被挖空，但用呼叫形狀比對意圖更清楚，
    // 也不會因為某天有人把說明寫成行尾註解就誤報。
    const callers = firstPartyFiles()
      .filter((f) => readCode(f).includes('.getUserMedia('))
      .map(rel)
      .sort()
    expect(callers, '鏡頭入口只能有一個；多一個就是多一條沒有人在看的隱私路徑').toEqual([
      'src/core/cameraCapture.js',
    ])
  })

  /**
   * 寫這條護欄時才發現的事（不是原本的三條紅線之一，但屬於同一條線）：
   * vendored 的 emscripten glue 裡有一支 SDL 時代的 `getUserMedia` shim——
   *
   *   getUserMedia(func) {
   *     window.getUserMedia ||= navigator["getUserMedia"] || navigator["mozGetUserMedia"];
   *     window.getUserMedia(func);
   *
   * 三個 glue 檔各有一份。它走的是早已被移除的**前綴版舊 API**，而且掛在
   * SDL 的音訊擷取路徑上，MediaPipe 的 vision task 不會走到；`navigator.getUserMedia`
   * 在現代 Safari 上是 undefined，真的被叫到只會當場 TypeError，不會開麥克風。
   * 我們**沒有**去改這三個檔案（它們是原樣 vendored 的第三方產物，改了下一次
   * 重新 vendored 就沒了——跟 B-1 不去 patch MediaPipe bundle 是同一個理由）。
   *
   * 這條測試把「哪些非第一方檔案可以出現這個名字」釘成一份具名清單：日後重新
   * vendored 一份行為不同的 glue、或有人在 `public/` 放進第四個含 getUserMedia
   * 的檔案，這裡會當場紅。
   */
  const VENDORED_GLUE_WITH_SHIM = [
    'public/wasm/vision_wasm_internal.js',
    'public/wasm/vision_wasm_module_internal.js',
    'public/wasm/vision_wasm_nosimd_internal.js',
  ]

  it('除了第一方那一個呼叫點，只有這三個 vendored emscripten glue 檔提到 getUserMedia', () => {
    const all = allSourceFiles()
      .filter((f) => readCode(f).includes('.getUserMedia('))
      .map(rel)
      .sort()
    expect(all).toEqual(['src/core/cameraCapture.js', ...VENDORED_GLUE_WITH_SHIM].sort())
  })

  it('只有那三個 vendored glue 走「不剝註解」的快路徑，第一方檔案一個都不准走', () => {
    // 這條護欄守的是上面 readCode() 那個效能修正**本身**：`isVendoredArtifact()`
    // 一旦寫錯（例如 Windows 的路徑分隔沒被正規化、或有人把判斷放寬），
    // 症狀會是第一方程式碼不再剝註解——那會讓「註解裡提到 MediaRecorder」
    // 變成違規，是很吵的假陽性；但反方向（vendored 又開始剝註解）是**安靜的**，
    // 只會讓偶發逾時悄悄回來。所以兩個方向都在這裡釘住。
    const publicFiles = listPublicTextFiles()
    expect(publicFiles.filter(isVendoredArtifact).map(rel).sort())
      .toEqual([...VENDORED_GLUE_WITH_SHIM].sort())
    expect(
      publicFiles.filter((f) => !isVendoredArtifact(f)).map(rel),
      '我們自己寫的 public 檔案要照常剝註解',
    ).toContain('public/manifest.webmanifest')
    expect(
      firstPartyFiles().some(isVendoredArtifact),
      '第一方程式碼的剝註解是實質的（複審 Blocking-2），不准被跳過',
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 紅線 2：public/_headers 的 Permissions-Policy 與 CSP
// ---------------------------------------------------------------------------

/**
 * 從一段 CSP 字串裡取出 connect-src 的 token 清單。
 * 回傳 null 代表這段字串裡根本沒有 connect-src。
 */
function connectSrcTokens(csp) {
  const m = /connect-src([^;]*)/.exec(csp)
  if (!m) return null
  return m[1].trim().split(/\s+/).filter(Boolean)
}

/** connect-src 只准出現這三個 token（見 index.html 與 public/_headers 的註解）。 */
const EXPECTED_CONNECT_SRC = ["'self'", 'blob:', 'data:']

/**
 * `public/_headers` 裡那條 CSP 的內容。
 * `_headers` 的註解以 `#` 開頭，一定要先濾掉——否則註解裡引用的指令文字會讓
 * 「header 被整行刪掉」這種突變仍然通過（Ruling CH 的反面：綠得沒有理由）。
 */
function headersCsp() {
  return readFileSync(HEADERS_FILE, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .find((l) => l.includes('Content-Security-Policy:')) ?? null
}

/**
 * `index.html` 裡 `<meta http-equiv="Content-Security-Policy">` 的 content 值。
 * 同樣要先挖掉 `<!-- -->` 註解：那段註解正在解釋 CSP 為什麼存在，不挖空的話
 * 把 `<meta>` 整條刪掉這幾條測試還是會綠。
 */
function metaCsp() {
  const code = stripHtmlCommentSpans(readFileSync(INDEX_HTML, 'utf8'))
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(code)
  return m ? m[1] : null
}

describe('紅線：public/_headers 的宣告式防線', () => {
  it('Permissions-Policy 那一行逐字存在（camera=(self), microphone=()）', () => {
    expect(fileExists(HEADERS_FILE)).toBe(true)
    const text = readFileSync(HEADERS_FILE, 'utf8')
    expect(
      text.includes('Permissions-Policy: camera=(self), microphone=()'),
      '麥克風的宣告式防線。複審把這一行整行刪掉，666 條測試一條都沒紅。',
    ).toBe(true)
  })

  it('Content-Security-Policy 的 connect-src 存在，而且沒有放行任何外部主機（B-1）', () => {
    const cspLine = headersCsp()
    expect(cspLine, 'public/_headers 必須有 Content-Security-Policy（B-1 的正式部署防線）').toBeTruthy()
    expect(connectSrcTokens(cspLine)).toEqual(EXPECTED_CONNECT_SRC)
  })
})

describe('紅線：index.html 的 <meta> CSP（_headers 靜默失效時唯一還在的那一份）', () => {
  it('meta http-equiv 的 connect-src 存在，而且沒有放行任何外部主機', () => {
    const content = metaCsp()
    expect(content, 'index.html 必須有 <meta http-equiv="Content-Security-Policy">（M-2：換 host 時 _headers 會靜默消失）').toBeTruthy()
    expect(connectSrcTokens(content)).toEqual(EXPECTED_CONNECT_SRC)
  })

  it('兩個載體的 connect-src 逐字一致（兩套真相家族：同一件事有兩個來源，遲早會不一致）', () => {
    expect(connectSrcTokens(metaCsp() ?? '')).toEqual(connectSrcTokens(headersCsp() ?? ''))
  })
})

// ---------------------------------------------------------------------------
// 紅線 3：禁用 API 全專案零命中
// ---------------------------------------------------------------------------

/**
 * 每一筆都必須寫明「為什麼這個 API 在這個專案裡是紅線」——這份清單的價值
 * 在於半年後有人想加語音啟動時，他看到的不是一個沒有理由的禁令。
 */
const FORBIDDEN_APIS = [
  {
    name: 'SpeechRecognition',
    reason: 'iOS 的語音辨識會把音訊送到 Apple 伺服器。隱私說明頁寫著「不會要'
      + '麥克風權限，不錄音」——用了它，那句話就是假的。（這個字串同時涵蓋 '
      + 'webkitSpeechRecognition，Safari 只提供帶前綴的那一個。）',
  },
  {
    name: 'MediaRecorder',
    reason: '錄影／錄音。隱私紅線第一句：影像用後即 close()，永不序列化。',
  },
  {
    name: 'getDisplayMedia',
    reason: '螢幕錄製。跟 MediaRecorder 同一條紅線，而且會把小孩正在做的功課'
      + '一起錄進去。',
  },
  {
    name: 'sendBeacon',
    reason: '背景上報通道。CSP 的 connect-src 擋得住它，但我們自己的程式碼'
      + '本來就不該出現它——B-1 的教訓是「送出去的那一行不會出現在你在看的'
      + '那個檔案裡」，第一方程式碼更沒有理由讓它出現。',
  },
]

describe('紅線：禁用 API 全專案零命中（複審：這一條完全沒有護欄可攻）', () => {
  it('掃描範圍本身不是空的（護欄不能是空轉的）', () => {
    const files = allSourceFiles()
    // 沒有這一條，只要掃描範圍算錯（例如目錄改名），下面那條就會「掃 0 個檔案
    // → 全綠」，變成 Ruling CH 說的那種看起來在保護、其實什麼都沒做的測試。
    expect(files.length).toBeGreaterThan(40)
    expect(files.map(rel)).toContain('src/core/cameraCapture.js')
    expect(files.map(rel)).toContain('src/components/PrivacyNotice.vue')
    expect(files.map(rel)).toContain('index.html')
  })

  for (const { name } of FORBIDDEN_APIS) {
    it(`${name} 在 src/、public/、index.html 全部零命中`, () => {
      const hits = []
      for (const file of allSourceFiles()) {
        if (readCode(file).includes(name)) hits.push(rel(file))
      }
      const reason = FORBIDDEN_APIS.find((a) => a.name === name).reason
      expect(hits, `${name} 是這個專案的紅線：${reason}`).toEqual([])
    })
  }
})
