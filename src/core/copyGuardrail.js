/**
 * 全域文案護欄的共用邏輯（Task 22a，Ruling CA 的落實）。
 *
 * 這個檔案只做一件事：把檔案系統的內容轉成可斷言的資料。不對外呼叫、
 * 不讀系統時鐘、不快取結果——每次呼叫都重新走一次檔案系統，這樣「掃描
 * 範圍由目錄決定」才是真的，不是「啟動時掃一次、之後就是一份記憶體裡的
 * 人工清單」。實際斷言（禁用詞、長度、例外清單驗證）留在 copyGuardrail.test.js。
 *
 * 背景（見 task-22a-brief.md）：這個專案的文案護欄已經四次「宣稱的覆蓋
 * 範圍與實際不符」——每次都不是文案寫錯，是護欄掃不到該掃的地方：
 *   (a) copyEngine.test.js 曾經只掃 BOSS_COPY，POSTURE_COPY 沒護欄。
 *   (b) App.vue 的健康度覆蓋層文字沒有任何測試會渲染到它。
 *   (c) TaskSelector 的血量文字不在掃描範圍。
 *   (d) index.html 的 <title> 含禁用詞，四份各自維護的 BANNED_WORDS
 *       陣列沒有一份掃 index.html。
 * 這四次失敗的共同原因是「掃描範圍由人記得去維護的清單決定」。這裡改成
 * 全部用 fs.readdirSync 遞迴走目錄：新增檔案不需要有人記得回來加一行。
 *
 * 複審第 1 輪追加的第五類失敗（這條護欄自己製造的）：
 *   (e) 規則 A 原本只掃 src/data/copy/**、src/**\/*.vue 跟三個寫死的檔名
 *       （index.html／manifest.webmanifest／sw.js），src/**\/*.js 的其餘
 *       檔案完全沒被掃——而 postureCoach.js 的 CAUSE_LABEL 就是活生生的
 *       例子：真實使用者文案，放在 data/copy 以外的一般 .js 檔裡。
 *   (f) 規則 B（長度 ≤15）只掃字面量字串，抓不到「合成後才變長」的違規：
 *       postureCoach.js 把 CAUSE_LABEL 跟 POSTURE_COPY 的句子接在一起，
 *       兩邊字面量各自都 ≤15 字，合成後最長觸及 24 字，而且會被 TTS 念出來。
 *   (g) 規則 B 完全不掃 .vue——App.vue 的健康度提示屬於規則 B 明確點名的
 *       「短暫提示」類別，卻只靠 App.mount.test.js 那條個別撰寫的渲染測試
 *       保護，沒有這條全域護欄的系統性覆蓋，換一個新元件就得重新祈禱
 *       有人記得寫。
 * 這一輪的修正，見下面 (e)(f)(g) 對應的區塊註解。
 *
 * 複審第 2 輪追加的第三類失敗（依然是這條護欄自己身上的）：
 *   (h) 依語法逐字元追蹤註解狀態的挖空器，在 <style> 裡放一個沒配對到
 *       `*\/` 的 `/*`，會一路吃掉後面所有內容——包含後面的禁用詞，
 *       規則 A 的假陰性，而且測試看起來是綠的。
 *   (i) 同一套挖空器只處理 <template>/<script>/<style> 三個區塊「內部」，
 *       區塊以外的內容（例如 SFC 檔頭的說明註解）完全不挖空——
 *       `PrivacyNotice.vue` 檔頭列出全部 7 個禁用詞解釋這條規則，
 *       會被整段誤判成違規，規則 A 的假陽性，而且是上一輪修正自己
 *       引入的（修 (e)(g) 時新寫的程式碼造成的新洞）。
 * (h)(i) 的修法見 blankPureCommentLines() 的說明：放棄逐字元追蹤語法，
 * 改用「整行是不是純註解」這個更保守、範圍是整份檔案（不分區塊內外）的
 * 規則——寧可少挖而誤報，不要多挖而默默放行。
 *
 * 已知仍然存在、誠實記錄在這裡（也寫在 task-22a-report.md 的
 * 「已知的掃描邊界」）、這次沒有修的盲點：
 *   - 識別字／物件 key 名稱字面上剛好含禁用詞會被誤判（規則 A 是全文字
 *     比對，不分辨「這是不是使用者看得到的文案」）。
 *   - `copyEngine.js` 的 `fill()`（`{var}` 樣板變數代換）結構上跟
 *     `postureCoach.formatPostureMessage()` 是同一種「合成」風險：
 *     模板字面量代入變數後可能變長。目前唯一用戶 `SUMMARY_COPY` 已經
 *     整體排除在長度規則外，所以安全，但那是「唯一用戶剛好被豁免」的
 *     巧合，不是設計上的保證——見 copyGuardrail.test.js 那條「含
 *     `{變數}` 樣板的文案池必須已被長度規則豁免」的測試，釘住這個前提。
 *   - `stripHtmlCommentSpans()` 是這個檔案裡**唯一**還在做跨字元配對的
 *     地方（其餘一律是逐行前綴判斷）。複審第 3 輪構造對抗性輸入證明：
 *     若模板的**非註解語境**裡出現字面的 `<!--`（例如一段說明文字或
 *     屬性值裡剛好寫了這四個字元），它可能跟後面某個不相干的真 `-->`
 *     錯誤配對，把中間真正的違規一起吃掉——也就是 (h) 那個假陰性的
 *     同一種失效模式，只是觸發門檻高很多。
 *     實測：目前全專案沒有任何檔案觸發這個條件。
 *     沒有改掉的理由寫在 collectVueLengthCandidates() 裡：這個專案的模板
 *     大量使用「首行 <!--、中間好幾行沒有前綴、末行 -->」的多行註解，
 *     純逐行判斷會把那些延續行誤判成模板文字（實測曾誤判出 855 字的假
 *     違規）。換句話說這裡沒有「兩邊都好」的選項，只有「少挖而誤報」與
 *     「多挖而放行」的取捨，而多行註解的誤報量大到會讓護欄被關掉。
 *     → 若日後有人在模板裡寫出字面的 `<!--`，請改用 HTML parser，
 *       不要再加一層正則。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 規則 A（禁用詞）：全專案唯一一份清單，全部適用，沒有例外。
 * 以 copyEngine.test.js:133 那一份為準（Ruling CA 指定）。
 * 過去四份重複清單（BattleView.test.js／ConfirmDialog.test.js／
 * TaskSelector.test.js／copyEngine.test.js）現在都改成 import 這裡。
 */
export const BANNED_WORDS = ['懶惰', '摸魚', '沒用', '果然做不到', '笨', '胖', '醜']

/** 規則 B：短暫提示（會被朗讀、或會被下一則取代）單句上限。 */
export const MAX_SHORT_LINE_LENGTH = 15

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SRC_DIR = path.resolve(HERE, '..') // .../src
export const REPO_ROOT_DIR = path.resolve(SRC_DIR, '..') // repo 根目錄
export const DATA_COPY_DIR = path.join(SRC_DIR, 'data', 'copy')
export const PUBLIC_DIR = path.join(REPO_ROOT_DIR, 'public')

/**
 * public/ 底下會被掃描的「文字類」副檔名白名單。這不是一份檔名清單
 * （不用記得加 manifest.webmanifest 或未來的 robots.txt），是一份副檔名的
 * 型別判斷——只跳過真正的二進位資產（圖示 png、模型 tflite/task、wasm），
 * 新增的文字類靜態資產（例如未來的 robots.txt、humans.txt）會自動落進來，
 * 不需要有人記得回來加檔名。用 extension 白名單而不是「試著整份當文字讀」
 * 是因為對 tflite/wasm 這類二進位檔硬做字串搜尋，既浪費也可能因為隨機位元
 * 組合誤判出「含禁用詞」的假警報。
 */
export const TEXT_ASSET_EXTENSIONS = ['.webmanifest', '.json', '.html', '.txt', '.xml', '.svg', '.js', '.css']

/**
 * 遞迴列出目錄下所有符合副檔名的檔案（回傳絕對路徑）。純粹走檔案系統，
 * 不接受、也不需要一份人工維護的檔名清單——這正是這個護欄存在的理由。
 */
export function listFilesRecursive(dir, extensions) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

/** 只列出某個目錄「這一層」符合副檔名的檔案，不遞迴進子目錄。
 *  用在 repo 根目錄：根目錄底下有 node_modules／dist／docs 這類不該被走進去
 *  的大目錄，只掃這一層（目前只有 index.html，未來新增的根層 *.html 入口
 *  會自動落進來）比遞迴整個根目錄划算，也不會意外掃到建置產物或第三方碼。 */
export function listTopLevelFiles(dir, extensions) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/**
 * src/**\/*.js（排除 *.test.js 與這個護欄自己）的完整清單。
 *
 * 複審 B-1：規則 A 原本只掃 src/data/copy/**，src/core 底下其他 .js 檔
 * （例如 postureCoach.js 的 CAUSE_LABEL）完全不在掃描範圍——那是真實的
 * 使用者文案，只是剛好沒放在 data/copy 目錄裡。這裡改成掃整個 src 底下
 * 的 .js 檔（含 data/copy，兩邊掃描重疊沒有壞處），新增檔案自動落進來。
 *
 * 排除 copyGuardrail.js 本身，是**唯一**的檔名例外，理由跟排除
 * *.test.js 一樣：BANNED_WORDS 這份清單的定義本身必須逐字包含每一個
 * 禁用詞，否則規則 A 無從比對——這是清單的「定義」，不是「違規的文案」。
 * 這不是靜默跳過：這裡明文寫出來，而且排除的是「這個護欄自己的原始碼」
 * 這一個檔案，不是任何一份可能隨時間增減的人工清單。
 */
export function listAllJsSourceFiles() {
  return listFilesRecursive(SRC_DIR, ['.js'])
    .filter((f) => !f.endsWith('.test.js') && path.basename(f) !== 'copyGuardrail.js')
}

/** public/ 底下所有「文字類」靜態資產（見 TEXT_ASSET_EXTENSIONS 的說明）。 */
export function listPublicTextFiles() {
  return listFilesRecursive(PUBLIC_DIR, TEXT_ASSET_EXTENSIONS)
}

/**
 * 遞迴走訪任意巢狀的字串／陣列／物件，收集所有字串葉節點。
 * 刻意「不列舉 key」：呼叫端不需要事先知道 pool 裡有哪些 key，新增 key
 * 會自動被收進來。key 名稱只用來組成報錯訊息看得懂的路徑，不影響比對。
 */
export function collectStrings(value, pathPrefix = '') {
  const out = []
  if (typeof value === 'string') {
    out.push({ path: pathPrefix, text: value })
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => out.push(...collectStrings(item, `${pathPrefix}[${i}]`)))
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      out.push(...collectStrings(v, pathPrefix ? `${pathPrefix}.${key}` : key))
    }
  }
  return out
}

/**
 * 動態走訪 src/data/copy/**\/*.js（排除 *.test.js），import 每一個檔案，
 * 把每一個具名匯出遞迴展開成 {file, exportName, path, text} 清單。
 *
 * 用 fs.readdirSync + 動態 import()，不是人工列舉檔名：新增一個
 * src/data/copy/xxx.js 不需要有人記得回來這裡加一行，下一次跑測試就會
 * 自動出現在掃描結果裡（驗收項目 4 就是在證明這件事）。
 */
export async function collectCopyPoolEntries() {
  const files = listFilesRecursive(DATA_COPY_DIR, ['.js']).filter((f) => !f.endsWith('.test.js'))
  const out = []
  for (const file of files) {
    // 檔案數量小，循序 import 比引入額外併發複雜度划算
    const mod = await import(pathToFileURL(file).href)
    for (const [exportName, exportValue] of Object.entries(mod)) {
      for (const { path: p, text } of collectStrings(exportValue)) {
        out.push({ file, exportName, path: p, text })
      }
    }
  }
  return out
}

/** 找出文字裡第一個出現的禁用詞，沒有就回傳 null。 */
export function firstBannedWord(text) {
  return BANNED_WORDS.find((w) => text.includes(w)) ?? null
}

/**
 * 複審修正第 2 輪：整套「依語法逐字元追蹤註解狀態」的挖空器（原本的
 * stripCommentsWithRules／stripCommentsForVue）整條移除，換成下面這個
 * 更簡單、更保守的逐行規則。理由是複審實測抓到的兩個坑，而且兩個坑是
 * 同一種病：
 *
 * Blocking-1：`<style>` 裡放一個**沒有配對到 `*\/` 的 `/*`**，狀態機會
 * 一路把「block」狀態帶到檔案結尾（或帶到下一個湊巧出現的 `*\/`），
 * 沿途吃掉後面所有真正的內容——包含後面的禁用詞。這是規則 A 的假陰性：
 * 護欄看起來在保護、實際上放行了違規，而且沒有人會發現，因為測試是綠的。
 *
 * Blocking-2：舊版只在 `<template>`／`<script>`／`<style>` 三個區塊「內部」
 * 挖空，區塊**以外**的內容（例如檔頭在 `<template>` 之前的說明註解）完全
 * 原樣保留。`PrivacyNotice.vue` 的檔頭註解列出全部 7 個禁用詞來解釋「這個
 * 檔案為什麼要遵守這條規則」，這種區塊外的說明文字會被整段當成違規——
 * 這是規則 A 的假陽性，而且是這一輪修正自己引入的。
 *
 * 兩個坑的根源都是「試圖精確追蹤註解語法」：語法越精確，判斷錯一處
 * 的代價就越大（一個沒配對到的 `/*` 可以吃掉整份檔案），而且範圍越窄
 * （只認區塊內）越容易漏掉區塊外的內容。改用逐行的保守規則：
 *
 *   一行的「去頭尾空白後」如果以 `//`、`/*`、`*`、`<!--` 開頭，
 *   整行都當作註解，換成等長的空白（保留換行與長度，行號依然準確）；
 *   否則整行原樣保留，即使這一行技術上可能還在某個多行區塊註解裡面。
 *
 * 這個規則**不追蹤跨行狀態**，所以沒有「一個沒配對到的符號吃掉後面全部
 * 內容」這種災難性失效模式——這就是它同時修掉 Blocking-1 的原因。
 * 它對**整個檔案**逐行套用，不限定在任何區塊內或區塊外——這就是它同時
 * 修掉 Blocking-2 的原因。
 *
 * 代價（刻意接受、明文寫在這裡，不是沒發現）：
 *   - 多行區塊註解如果某一行的延續內容沒有照這個專案的慣例在行首加 `*`
 *     （例如 HTML 註解 `<!-- 第一行\n    延續行 -->` 的延續行沒有前綴），
 *     那一行不會被挖空，會照常被掃描——如果那一行剛好含禁用詞，會被
 *     誤判成違規（假陽性）。
 *   - 程式碼行尾端附掛的行內註解（例如 `const x = 1 // 說明`）不會被挖空，
 *     因為那一行不是「以註解符號開頭」——如果那段行內註解含禁用詞，一樣
 *     會被誤判成違規。
 * 這兩個代價都是**假陽性**（護欄多喊一次、由人看一眼確認），跟原本的
 * 假陰性（護欄放行真違規、沒有人會發現）不是同一個等級的風險——這正是
 * 這一輪修正要的方向：寧可少挖而誤報，不要多挖而默默放行。
 */
function isPureCommentLine(line) {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--')
}

export function blankPureCommentLines(text) {
  return text
    .split('\n')
    .map((line) => (isPureCommentLine(line) ? ' '.repeat(line.length) : line))
    .join('\n')
}

/**
 * 完整挖空「找得到配對」的 `<!-- -->` 區塊（含裡面沒有逐行前綴的延續行），
 * 找不到配對的 `<!--` 就完全不挖、原樣保留（安全 fallback）。規則 A
 * （scanRawFileForBannedWords）跟規則 B 的 .vue 長度擷取
 * （collectVueLengthCandidates）都會用到。
 *
 * 為什麼需要這個、而不是只靠 blankPureCommentLines()：這個專案大量使用
 * 「開頭一行 `<!--` 說明，後面接好幾行沒有逐行前綴的延續文字，最後一行
 * `-->`」這種多行 HTML 註解（例如 App.vue 的健康度覆蓋層那大段設計說明）。
 * blankPureCommentLines() 只認「這一行開頭是不是註解記號」，會漏掉那些
 * 沒有前綴的延續行——複審 Blocking-2 的重現場景正是這一種：SFC 檔頭用
 * 這種多行註解解釋「為什麼要遵守禁用詞規則」時，列出全部禁用詞的延續行
 * 沒被挖空，整段開發者說明被誤判成違規。
 *
 * 為什麼這裡可以比 blankPureCommentLines() 更「精確」而不會重蹈
 * Blocking-1 的覆轍：HTML 註解的起訖記號只有一種、不會跟其他語法混淆
 * （不像 `/* *\/` 在 CSS 裡有更多模稜兩可的可能），而且失敗時的行為是
 * 「什麼都不挖」而不是「吃到檔案結尾或吃到下一個湊巧出現的記號」——
 * 找不到配對只代表這個檔案的模板語法本身就是壞的，那種檔案連
 * `npm run build` 都過不了，不會是這個護欄實際掃到的目標。
 */
export function stripHtmlCommentSpans(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const start = text.indexOf('<!--', i)
    if (start === -1) { out += text.slice(i); break }
    const end = text.indexOf('-->', start + 4)
    if (end === -1) { out += text.slice(i); break } // 沒配對到：原樣保留，不冒險
    out += text.slice(i, start)
    const span = text.slice(start, end + 3)
    out += span.replace(/[^\n]/g, ' ') // 保留換行，長度／行號不跑掉
    i = end + 3
  }
  return out
}

/** .vue 檔的三個頂層區塊（<template>／<script>／<style>），依區塊出現順序配對
 *  開始／結束標籤與中間內容。只用在規則 B 的長度候選字串擷取——要知道
 *  「這段內容屬於哪個區塊」才能決定用文字節點解析還是字串字面量解析；
 *  跟禁用詞的挖空／掃描（見上方 blankPureCommentLines）無關，那邊不分區塊，
 *  對整份檔案一視同仁。 */
const VUE_BLOCK_RE = /(<(template|script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi

/**
 * 對單一原始檔案的完整內容做全文字串比對（涵蓋 <script>、<template>、
 * 屬性值、區塊以外的內容——不做語法解析；純註解行已用
 * blankPureCommentLines() 挖空），回傳每個出現的禁用詞與所在行號。
 *
 * 用在 .vue／.html／.js／public 靜態資產這類場景：禁用詞掃描只需要
 * 回答「這個詞有沒有出現在這個檔案任何會被使用者看到／聽到的地方」，
 * 結構化解析（例如只掃 <template> 的文字節點，或只掃三個 SFC 區塊內部）
 * 對這個問題沒有額外好處，反而會漏掉 <script> 裡的字面字串、HTML 屬性值
 * （例如 aria-label），或區塊以外的內容——T11 M2「血量文字不在掃描範圍」
 * 與複審 Blocking-2「SFC 區塊外的說明文字沒被挖空」都是同一種坑：
 * 掃描器只看了它認為「該看」的那一塊。
 */
export function scanRawFileForBannedWords(filePath) {
  // 先用 stripHtmlCommentSpans() 完整挖空找得到配對的多行 <!-- --> 註解
  // （含沒有逐行前綴的延續行），再用 blankPureCommentLines() 兜底單行
  // 註解與有逐行前綴的區塊註解。複審 Blocking-2 的重現場景正是這一種：
  // SFC 檔頭那種「開頭 <!-- 說明，後面接好幾行沒有前綴的延續文字，
  // 最後一行 -->」的多行 HTML 註解，若解釋禁用詞規則時列出全部禁用詞，
  // 光靠逐行前綴判斷會漏掉延續行、把整段開發者說明誤判成違規。
  // stripHtmlCommentSpans() 找不到配對時原樣保留（見它的說明），不會
  // 重蹈 Blocking-1「吃到檔案結尾」的覆轍。
  const text = blankPureCommentLines(stripHtmlCommentSpans(readFileSync(filePath, 'utf8')))
  const hits = []
  for (const word of BANNED_WORDS) {
    let from = 0
    let idx = text.indexOf(word, from)
    while (idx !== -1) {
      const line = text.slice(0, idx).split('\n').length
      hits.push({ file: filePath, word, line })
      from = idx + word.length
      idx = text.indexOf(word, from)
    }
  }
  return hits
}

export function fileExists(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 規則 B 的例外清單：只適用於「靜態、可從容閱讀、不會被朗讀、也不會被
 * 下一則訊息取代」的說明性文字。每一筆都必須寫明理由——靜默跳過是被禁止的。
 *
 * 範圍刻意限定在 src/data/copy/**：這個目錄底下的檔案全部走
 * collectCopyPoolEntries() 動態匯入，往後 Task 19／20 若把隱私說明、
 * 休息回合建議等文案也放進這個目錄（跟 boss.js／posture.js／summary.js
 * 同一種模式），會自動落進規則 B 的掃描範圍——除非像這裡一樣，
 * 明確加一筆有理由的例外。
 *
 * 目前唯一的例外是 summary.js：結算頁的總結段落是靜態呈現在畫面上給人
 * 從容閱讀的一段話，不會被 TTS 念出來，也不會被下一則訊息用倒數計時的
 * 方式取代掉——15 字上限的原始理由（TTS 念超長句會蓋掉下一則提示）在
 * 這裡不成立。
 */
export const LENGTH_RULE_EXCEPTIONS = [
  {
    file: 'summary.js',
    exportName: 'SUMMARY_COPY',
    reason: '結算頁總結段落：靜態顯示在畫面上，使用者可從容閱讀，不會被 TTS 朗讀，'
      + '也不是會被下一則訊息在倒數後取代掉的短暫提示。15 字上限的原始理由'
      + '（TTS 念超長句蓋掉下一則提示）在這裡不成立。',
  },
]

/**
 * 複審整理出的★盲點：這裡原本用 path.basename(entry.file) 比對例外清單，
 * 若 data/copy 底下出現兩個不同子目錄、但同檔名的檔案（例如未來有人加
 * `data/copy/legacy/summary.js`），basename 比對會把它們混為一談——
 * 可能誤放行不該例外的檔案，也可能讓例外清單「看起來」對不上真正想排除
 * 的那個檔案。改成用相對於 DATA_COPY_DIR 的路徑比對，徹底消掉這個語意
 * 落差（不是只在文件裡寫「已知有這個風險」了事）。
 */
export function isLengthExempt(entry) {
  const rel = path.relative(DATA_COPY_DIR, entry.file)
  return LENGTH_RULE_EXCEPTIONS.some((exc) => exc.file === rel && exc.exportName === entry.exportName)
}

/**
 * 複審 B-3：規則 B（長度 ≤15 字）原本完全不掃 .vue，Ruling CA 記錄的
 * (b) 那次失敗（App.vue 健康度提示沒人掃）正是這一類文字——它是規則 B
 * 明確點名的「短暫提示」，卻只靠 App.mount.test.js 一條個別撰寫的渲染
 * 測試保護（那條測試很紮實，見 task-22a-report.md 的更正說明，但它是
 *「這個元件」專屬的，換一個新元件不會自動被涵蓋）。
 *
 * 這裡從 .vue 檔案的原始內容擷取兩類「靜態候選字串」：
 *   1. <template> 區塊裡標籤之間的純文字節點，用 `{{ }}` 插值切開只留
 *      靜態片段（動態值在靜態掃描階段本來就無法得知長度，不勉強評估）。
 *   2. <script> 區塊裡含中文字元的字串常值／模板字面量，模板字面量一樣
 *      用 `${ }` 插值切開只留靜態片段。
 * <style> 區塊不擷取——CSS 值不是使用者文案。
 *
 * 刻意不擷取 `{{ }}` 插值運算式內部（例如
 * `{{ paused ? '繼續' : '暫停' }}`）裡的字面字串：這需要真的解析 JS
 * 運算式，這裡選擇誠實承認這個邊界（見 report「已知的掃描邊界」），
 * 而不是為了看起來覆蓋更完整而動手寫一個簡化、可能出錯的運算式解析器。
 */
const SCRIPT_STRING_LITERAL_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g
const HAS_CJK_RE = /[㐀-鿿]/

function staticFragmentsOf(raw, interpolationRe) {
  return raw
    .split(interpolationRe)
    .map((frag) => frag.replace(/\s+/g, ' ').trim())
    .filter((frag) => frag.length > 0)
}

/**
 * 取出 <template> 區塊裡「標籤之間」的純文字節點。
 *
 * 不能只用「找下一個 `>` 到下一個 `<`」這種正規表示法：這個專案的模板
 * 大量使用 `v-if="(battle?.phase ?? 1) > 1"` 這種在**屬性值裡**含有比較
 * 運算子 `>`／`<` 的寫法。單純用 `>` 當標籤結束記號，會把屬性值裡的那個
 * `>` 誤判成標籤結束，導致後面一段其實還在同一個標籤內的內容（例如
 * `1" class="phase">第`）被誤判成文字節點。這裡改成正確地逐字元掃描：
 * 進入 `<` 之後，正確追蹤雙引號／單引號屬性值的開關狀態，只有在**不在
 * 屬性值內**時遇到的 `>` 才算標籤真正結束。
 */
function extractTemplateTextFragments(templateInner) {
  const out = []
  const n = templateInner.length
  let i = 0
  let textBuf = ''
  const flush = () => {
    if (textBuf) out.push(...staticFragmentsOf(textBuf, /\{\{[\s\S]*?\}\}/g))
    textBuf = ''
  }
  while (i < n) {
    const c = templateInner[i]
    if (c === '<') {
      flush()
      i += 1
      let quote = null
      while (i < n) {
        const tc = templateInner[i]
        if (quote) {
          if (tc === quote) quote = null
        } else if (tc === '"' || tc === '\'') {
          quote = tc
        } else if (tc === '>') {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    textBuf += c
    i += 1
  }
  flush()
  return out
}

function extractScriptStringFragments(scriptInner) {
  const out = []
  SCRIPT_STRING_LITERAL_RE.lastIndex = 0
  let m = SCRIPT_STRING_LITERAL_RE.exec(scriptInner)
  while (m !== null) {
    const inner = m[0].slice(1, -1)
    for (const frag of staticFragmentsOf(inner, /\$\{[\s\S]*?\}/g)) {
      if (HAS_CJK_RE.test(frag)) out.push(frag)
    }
    m = SCRIPT_STRING_LITERAL_RE.exec(scriptInner)
  }
  return out
}

/**
 * 對單一 .vue 檔擷取規則 B 要檢查長度的候選字串清單（見上方說明）。
 * 回傳 {file, text} 陣列——不分「這是哪個元件的哪個 key」，.vue 沒有
 * data/copy 那種具名匯出結構，例外清單改用「整檔」比對
 * （見 VUE_LENGTH_RULE_EXCEPTIONS，複審 Important-1 修正）。
 */
export function collectVueLengthCandidates(file) {
  const raw = readFileSync(file, 'utf8')
  const out = []
  VUE_BLOCK_RE.lastIndex = 0
  let m = VUE_BLOCK_RE.exec(raw)
  while (m !== null) {
    const tag = m[2].toLowerCase()
    const content = m[3]
    if (tag === 'template') {
      // 這個專案大量使用「開頭一行 <!-- 說明，後面接好幾行沒有逐行前綴的
      // 延續文字，最後一行 -->」這種多行 HTML 註解（例如 App.vue 的健康度
      // 覆蓋層那大段設計說明）。只用 blankPureCommentLines()（逐行、只認
      // 「這一行開頭是不是註解記號」）會漏掉那些沒有前綴的延續行，讓整段
      // 開發者註解被誤判成模板文字節點（複審修正第 2 輪實測抓到：曾經因此
      // 誤判出一段 855 字的假違規）。
      //
      // 這裡先用 stripHtmlCommentSpans() 完整挖空「找得到配對」的
      // <!-- --> 區塊，找不到配對就完全不挖（安全 fallback，不會有
      // Blocking-1 那種「吃到檔案結尾」的風險——這個檔案能通過
      // `npm run build`，代表模板語法本身合法，<!-- 一定找得到對應的
      // -->，找不到只可能是這個函式自己的臭蟲，寧可什麼都不挖也不要
      // 冒險吃過頭）。再疊一層 blankPureCommentLines() 兜底單行註解。
      const stripped = blankPureCommentLines(stripHtmlCommentSpans(content))
      for (const text of extractTemplateTextFragments(stripped)) out.push({ file, text })
    } else if (tag === 'script') {
      // 一定要先挖空整行註解再抓字串字面量：JSDoc 註解裡常常出現單引號
      // （例如「這裡的 'foo'」這種舉例），沒先挖空的話，字串字面量的正規
      // 表示法會把「從註解裡那個引號開始，到後面某處程式碼裡剛好對上的
      // 下一個引號」整段誤判成一個字串，抓出遠超過實際字面量的一大段內容
      // （複審第 1 輪實測：曾經因此抓出一段 255 字的假字串）。
      const stripped = blankPureCommentLines(content)
      for (const text of extractScriptStringFragments(stripped)) out.push({ file, text })
    }
    m = VUE_BLOCK_RE.exec(raw)
  }
  return out
}

/**
 * 規則 B 對 .vue 的例外清單，複審 Important-1 修正：粒度從「檔案＋精確
 * 文字」改成「整個檔案」。
 *
 * 為什麼要改：上一輪用逐字精確比對（每一句要豁免的文字都得原封不動地
 * 列一筆），複審拿主線上真實存在的 `PrivacyNotice.vue`／`PermissionGate.vue`
 * 實測，結果要另外補 16 筆才夠——16 筆手動維護的逐字條目，就是這個工項
 * 從一開始要消滅的那種東西，只是從「四份 BANNED_WORDS 陣列」換成了
 * 「一份很長的豁免清單」，而且文案改一個字，那一筆豁免就跟著失效。
 *
 * 判準（可檢驗的事實，不是品味）：這個檔案的文字會不會被
 * `session.voice().speak()` 唸出來、會不會被 `messageQueue` 的下一則
 * 訊息取代掉。兩個都「否」，才適用整檔豁免。目前唯一一筆
 * （CalibrationWizard.vue）符合：它的文字是校準畫面的靜態步驟說明，
 * 從來不經過 copyEngine／messageQueue／voiceFeedback 那條「短暫提示」
 * 管線，是純模板文字。
 *
 * 代價（明文接受）：整檔豁免之後，如果這個檔案「之後」被加進一句真的
 * 短暫、會被朗讀的提示，這條護欄不會發現——粒度粗，保護力也跟著變粗。
 * 這是複審明確要求的取捨（見 report「修正第 2 輪」對 Important-1 的
 * 回應），比逐字清單規模化失控好。
 *
 * 刻意不為 Task 18／19 尚未落地的元件（`PrivacyNotice.vue`／
 * `PermissionGate.vue`）預先寫例外：那些檔案在這個分支上不存在，先加會
 * 讓下面「例外清單本身有效」的測試現在就紅。合併後要補的兩筆，連同判準
 * 是否成立的說明，寫在 task-22a-report.md 的「修正第 2 輪」一節，由合併
 * 當時的人補上。
 */
export const VUE_LENGTH_RULE_EXCEPTIONS = [
  {
    file: path.join('components', 'CalibrationWizard.vue'),
    reason: '校準畫面的步驟說明與倒數文字：純模板文字，從不經過 copyEngine／'
      + 'messageQueue／voiceFeedback，不會被朗讀、也不會被下一則訊息取代——'
      + '不符合「短暫提示」的判準，適用整檔豁免。',
  },
  // 以下三筆由 controller 在合併 Task 18/19/20 時補上。三個檔案都**親自查過
  // import**：都沒有 copyEngine／messageQueue／voiceFeedback，文字一律是靜態
  // v-if 掛載的模板節點，不會被朗讀、也不會被下一則訊息取代——符合整檔豁免的
  // 判準（而不是「為了讓測試變綠」）。
  {
    file: path.join('components', 'PrivacyNotice.vue'),
    reason: '隱私說明頁的家長版說明：這一頁是唯一一次有人會認真逐句讀的地方，'
      + '本來就該寫完整而不是寫短。靜態顯示、從容閱讀，不經過 copyEngine／'
      + 'messageQueue／voiceFeedback。',
  },
  {
    file: path.join('components', 'PermissionGate.vue'),
    reason: '權限引導頁的說明與五步驟 iPad 設定路徑：設定路徑寫短會變成家長'
      + '照著找不到，等於這條復原路徑不存在。判準與 PrivacyNotice 相同。',
  },
  {
    file: path.join('components', 'InstallGuide.vue'),
    reason: '安裝橫幅的單句說明（17 字）：常駐橫幅、可關閉、不朗讀，'
      + '也不會被下一則訊息取代。Task 20 複審實測確認整個工項只有這一句'
      + '超過 15 字。',
  },
  {
    file: path.join('components', 'ThresholdLab.vue'),
    reason: '姿態閾值量測畫面：只給工作人員／開發者在真機量測時操作，'
      + '不是給小孩看的畫面，也不經過 copyEngine／messageQueue／'
      + 'voiceFeedback，不會被朗讀、也不會被下一則訊息取代——不符合'
      + '「短暫提示」的判準。畫面上刻意保留 neckDropRatio 等專有名詞'
      + '原文（操作者要照抄進 postureProfiles.js），不為了縮短而改寫，'
      + '所以整檔豁免長度規則。',
  },
]

export function isVueLengthExempt(file) {
  const rel = path.relative(SRC_DIR, file)
  return VUE_LENGTH_RULE_EXCEPTIONS.some((exc) => exc.file === rel)
}
