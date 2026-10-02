import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BANNED_WORDS, MAX_SHORT_LINE_LENGTH, DATA_COPY_DIR, SRC_DIR, REPO_ROOT_DIR,
  listFilesRecursive, listTopLevelFiles, listAllJsSourceFiles, listPublicTextFiles,
  collectCopyPoolEntries, firstBannedWord,
  scanRawFileForBannedWords, isLengthExempt, LENGTH_RULE_EXCEPTIONS, fileExists,
  collectVueLengthCandidates, isVueLengthExempt, VUE_LENGTH_RULE_EXCEPTIONS,
  blankPureCommentLines, stripHtmlCommentSpans,
} from './copyGuardrail.js'

/**
 * 全域文案護欄（Task 22a，Ruling CA 的落實）。
 *
 * 跟這個專案裡其他「文案護欄」測試最大的不同：這裡的掃描目標一律用
 * fs.readdirSync 遞迴走目錄取得（見 copyGuardrail.js 的 listFilesRecursive /
 * collectCopyPoolEntries），不是把檔名寫死在陣列裡列舉。理由見檔頭那七次
 * 「護欄宣稱的覆蓋範圍與實際不符」的紀錄（(a)-(d) 是這個工項發起的原因，
 * (e)-(g) 是複審第 1 輪在這條護欄自己身上又找到的三個）——每一次都是因為
 * 掃描範圍或規則本身用了人工維護的清單／假設，新情況不會自動落進去。
 *
 * 隱私：這裡的斷言訊息刻意只帶檔案路徑／匯出名稱／字數／禁用詞本身，
 * 不把違規那一行的完整文案內容印進斷言訊息或任何檔案。
 */

describe('全域文案護欄（Task 22a）', () => {
  describe('規則 A：禁用詞——全部適用，沒有例外', () => {
    it('唯一一份禁用詞清單，不是四份重複清單', () => {
      // 以 copyEngine.test.js:133（Ruling CA 指定的版本）為準；BattleView.test.js／
      // ConfirmDialog.test.js／TaskSelector.test.js／copyEngine.test.js 現在都
      // 改成 import 這裡的 BANNED_WORDS，不再各自宣告。
      expect(BANNED_WORDS).toEqual(['懶惰', '摸魚', '沒用', '果然做不到', '笨', '胖', '醜'])
    })

    it('src/data/copy/** 底下所有匯出字串都不含禁用詞（遞迴走物件／陣列，不列舉 key）', async () => {
      const entries = await collectCopyPoolEntries()
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        const hit = firstBannedWord(entry.text)
        expect(
          hit,
          `${path.basename(entry.file)} 的 ${entry.exportName}.${entry.path} 含禁用詞「${hit}」`,
        ).toBe(null)
      }
    })

    it('src/**/*.vue 都不含禁用詞（遞迴走整個 src，自動含 App.vue 與 components 底下所有元件）', () => {
      // T11 M2：TaskSelector 的血量文字曾經不在掃描範圍，起因是掃描器只看
      // 「認為該看」的那一塊模板文字。這裡直接對整個檔案做全文字串比對
      // （含 <script>／屬性值——註解已依區塊類型正確挖空，見 I-1 的修正），
      // 不做語法解析，才不會重蹈覆轍。
      const vueFiles = listFilesRecursive(SRC_DIR, ['.vue'])
      expect(vueFiles.length).toBeGreaterThan(0)
      for (const file of vueFiles) {
        const hits = scanRawFileForBannedWords(file)
        expect(
          hits.length,
          hits.length > 0
            ? `${path.relative(REPO_ROOT_DIR, file)} 第 ${hits[0].line} 行含禁用詞「${hits[0].word}」`
            : undefined,
        ).toBe(0)
      }
    })

    it('src/**/*.js（排除 *.test.js）都不含禁用詞（複審 B-1：原本只掃 data/copy，漏掉一般 .js 檔裡的真實文案）', () => {
      // postureCoach.js 的 CAUSE_LABEL 就是活生生的例子：真實使用者文案，
      // 放在 src/core 底下的一般 .js 檔，不在 src/data/copy 目錄裡。
      const jsFiles = listAllJsSourceFiles()
      expect(jsFiles.length).toBeGreaterThan(0)
      for (const file of jsFiles) {
        const hits = scanRawFileForBannedWords(file)
        expect(
          hits.length,
          hits.length > 0
            ? `${path.relative(REPO_ROOT_DIR, file)} 第 ${hits[0].line} 行含禁用詞「${hits[0].word}」`
            : undefined,
        ).toBe(0)
      }
    })

    it('repo 根目錄的 *.html 都不含禁用詞（複審 I-2：改走目錄這一層，不是寫死 index.html 這個檔名）', () => {
      const htmlFiles = listTopLevelFiles(REPO_ROOT_DIR, ['.html'])
      expect(htmlFiles.length).toBeGreaterThan(0)
      for (const file of htmlFiles) {
        const hits = scanRawFileForBannedWords(file)
        expect(
          hits.length,
          hits.length > 0 ? `${path.basename(file)} 第 ${hits[0].line} 行含禁用詞「${hits[0].word}」` : undefined,
        ).toBe(0)
      }
    })

    it('public/ 底下的文字類靜態資產都不含禁用詞（複審 I-2：改走目錄＋副檔名白名單，不是寫死 manifest.webmanifest 這個檔名）', () => {
      // PWA 加到主畫面後，圖示下方顯示的就是 manifest.webmanifest 的
      // name/short_name——這是走 public/ 目錄自動掃到的，不是為它單獨開一條測試。
      const files = listPublicTextFiles()
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const hits = scanRawFileForBannedWords(file)
        expect(
          hits.length,
          hits.length > 0 ? `${path.relative(REPO_ROOT_DIR, file)} 第 ${hits[0].line} 行含禁用詞「${hits[0].word}」` : undefined,
        ).toBe(0)
      }
    })
  })

  describe('註解挖空器本身的迴歸測試（複審修正第 2 輪：Blocking-1／Blocking-2）', () => {
    // 這兩條不需要真的建立 .vue 檔——blankPureCommentLines／
    // stripHtmlCommentSpans 是純字串函式，直接餵行內字串固定住行為，
    // 比每次都要在磁碟上放一個探針檔案更持久、更不會被之後的重構悄悄改壞。

    it('Blocking-1：<style> 裡未閉合的 /* 不會吃掉後面的內容（不追蹤跨行狀態）', () => {
      const css = [
        '.probe {',
        '  color: red;',
        '/*',
        '懶惰的樣式先留著沒關掉',
        '}',
      ].join('\n')
      const blanked = blankPureCommentLines(css)
      // 「懶惰的樣式先留著沒關掉」這一行不是以註解記號開頭，必須原樣保留
      // ——舊版逐字元狀態機會因為前面那個沒配對到的 /* 把這一行也吃掉。
      expect(blanked).toContain('懶惰的樣式先留著沒關掉')
    })

    it('Blocking-2：SFC 區塊外、解釋禁用詞規則的多行說明註解不會被誤判成違規', () => {
      const header = [
        '<!--',
        '  這個檔案為什麼要遵守禁用詞規則：不得出現「懶惰」「摸魚」「沒用」',
        '  「果然做不到」「笨」「胖」「醜」這幾個詞。',
        '-->',
        '<template><div>探針</div></template>',
      ].join('\n')
      const stripped = blankPureCommentLines(stripHtmlCommentSpans(header))
      for (const word of BANNED_WORDS) expect(stripped).not.toContain(word)
      // 反方向：同一個檔案裡真正的違規仍然要抓得到，證明不是整份都不掃了。
      const withRealViolation = header.replace('探針', '你今天很懶惰喔')
      const strippedReal = blankPureCommentLines(stripHtmlCommentSpans(withRealViolation))
      expect(strippedReal).toContain('懶惰')
    })
  })

  describe('規則 B：短暫提示單句 ≤15 字，只適用於會被朗讀或會被取代的文字', () => {
    it('例外清單本身有效：清單裡的檔案／匯出必須真的存在，且每一筆都要有非空的理由', async () => {
      // 這條測試存在的理由：例外清單如果只驗證「格式對不對」，日後某個
      // 檔案被刪除或改名，例外清單卻繼續躺在那裡，就會慢慢腐爛成一份
      // 「掃不到東西的護欄」——這正是這個專案已經踩過四次的坑。
      expect(LENGTH_RULE_EXCEPTIONS.length).toBeGreaterThan(0)
      for (const exc of LENGTH_RULE_EXCEPTIONS) {
        const full = path.join(DATA_COPY_DIR, exc.file)
        expect(fileExists(full), `例外清單裡的檔案不存在：${exc.file}`).toBe(true)

        // 例外清單筆數很小，循序驗證即可
        const mod = await import(pathToFileURL(full).href)
        expect(
          Object.prototype.hasOwnProperty.call(mod, exc.exportName),
          `例外清單裡的匯出不存在：${exc.file} 的 ${exc.exportName}`,
        ).toBe(true)

        expect(
          typeof exc.reason === 'string' && exc.reason.trim().length >= 10,
          `例外清單缺少足夠的理由說明：${exc.file} / ${exc.exportName}`,
        ).toBe(true)
      }
    })

    it('src/data/copy/** 底下沒有被例外清單排除的字串，長度都 ≤15 字', async () => {
      const entries = await collectCopyPoolEntries()
      const checked = entries.filter((e) => !isLengthExempt(e))
      expect(checked.length).toBeGreaterThan(0)
      for (const entry of checked) {
        expect(
          entry.text.length <= MAX_SHORT_LINE_LENGTH,
          `${path.basename(entry.file)} 的 ${entry.exportName}.${entry.path} 長度 `
          + `${entry.text.length} 字，超過上限 ${MAX_SHORT_LINE_LENGTH} 字`,
        ).toBe(true)
      }
    })

    it('BOSS_COPY／POSTURE_COPY 不得出現在長度例外清單裡（這兩池的文字會被 TTS 唸出來，必須受長度限制）', async () => {
      const entries = await collectCopyPoolEntries()
      const mustBeChecked = entries.filter((e) => e.exportName === 'BOSS_COPY' || e.exportName === 'POSTURE_COPY')
      expect(mustBeChecked.length).toBeGreaterThan(0)
      for (const entry of mustBeChecked) {
        expect(isLengthExempt(entry), `${entry.exportName} 不應該出現在長度例外清單裡`).toBe(false)
      }
    })
  })

  describe('規則 B 擴充：.vue 的短暫提示（複審 B-3）', () => {
    // Ruling CA 記錄的 (b)：App.vue 的健康度提示沒有全域護欄涵蓋，只靠
    // App.mount.test.js 一條個別撰寫的渲染測試保護。那條測試很紮實（見
    // task-22a-report.md 對它的更正說明），但它是「這個元件」專屬的——
    // 換一個新元件（例如未來的 BreakScreen.vue）不會自動被涵蓋。這裡補上
    // 靜態掃描版本的系統性保護，兩張網並存。

    it('vue 長度例外清單本身有效：檔案必須真的存在，且每一筆都要有理由（複審 Important-1：粒度改成整檔）', () => {
      // 上一輪用「檔案＋精確文字」逐字比對，複審拿主線真實存在的
      // PrivacyNotice.vue／PermissionGate.vue 實測，結果要另外補 16 筆
      // 才夠——16 筆手動維護的逐字條目本身就是這個工項要消滅的東西。
      // 改成整檔豁免後，這裡只驗證「檔案真的存在」與「有理由」，不再
      // 驗證某一句精確文字是否還在檔案裡（那個粒度已經不存在了）。
      expect(VUE_LENGTH_RULE_EXCEPTIONS.length).toBeGreaterThan(0)
      for (const exc of VUE_LENGTH_RULE_EXCEPTIONS) {
        const full = path.join(SRC_DIR, exc.file)
        expect(fileExists(full), `vue 長度例外清單裡的檔案不存在：${exc.file}`).toBe(true)

        expect(
          typeof exc.reason === 'string' && exc.reason.trim().length >= 10,
          `vue 長度例外清單缺少足夠的理由說明：${exc.file}`,
        ).toBe(true)
      }
    })

    it('src/**/*.vue 底下沒有被例外清單排除的靜態文字，長度都 ≤15 字', () => {
      const vueFiles = listFilesRecursive(SRC_DIR, ['.vue'])
      expect(vueFiles.length).toBeGreaterThan(0)
      let checked = 0
      for (const file of vueFiles) {
        if (isVueLengthExempt(file)) continue
        const rel = path.relative(SRC_DIR, file)
        for (const { text } of collectVueLengthCandidates(file)) {
          checked += 1
          expect(
            text.length <= MAX_SHORT_LINE_LENGTH,
            `${rel} 有一段靜態文字長度 ${text.length} 字，超過上限 ${MAX_SHORT_LINE_LENGTH} 字`,
          ).toBe(true)
        }
      }
      expect(checked).toBeGreaterThan(0)
    })
  })

  describe('合成後的文案長度（複審 B-2：不只掃字面量）', () => {
    // T10 F6 的傷害重演：postureCoach.js 把 CAUSE_LABEL 跟 POSTURE_COPY
    // 的句子接在一起（`${cause}，${lineText}`），兩邊字面量各自都 ≤15 字，
    // 合成後一度最長觸及 24 字，而且帶 voice:true，會被 TTS 唸出來——這正是
    // 15 字上限存在的原始理由。只掃字面量的護欄看不到「合成」這個動作，
    // 因為每個片段各自都合規。這裡直接呼叫合成函式本身，窮舉每個 reason
    // （不是寫死 ['slouch','forwardHead','gazeAway']，是從 CAUSE_LABEL 的
    // key 取得）× 該 reason 在真實 POSTURE_COPY 裡的每一句 × repeat 1~4，
    // 對輸出斷言長度——保護的是「使用者實際會看到／聽到的那個字串」，
    // 不是原始碼裡個別字串字面量。
    it('formatPostureMessage() 對每個 reason × POSTURE_COPY 該 reason 下的每一句 × repeat 1~4，輸出都 ≤15 字', async () => {
      const { formatPostureMessage, CAUSE_LABEL, CAUSE_FORMAT_LIMIT } = await import('./postureCoach.js')
      const { POSTURE_COPY } = await import('../data/copy/posture.js')

      const reasons = Object.keys(CAUSE_LABEL)
      expect(reasons.length).toBeGreaterThan(0)

      let checked = 0
      for (const reason of reasons) {
        const lines = POSTURE_COPY[reason]
        expect(Array.isArray(lines) && lines.length > 0, `POSTURE_COPY 沒有 ${reason} 這個 key`).toBe(true)
        for (const lineText of lines) {
          for (let repeat = 1; repeat <= CAUSE_FORMAT_LIMIT + 1; repeat += 1) {
            const text = formatPostureMessage({ reason, lineText, repeat })
            expect(
              text.length <= MAX_SHORT_LINE_LENGTH,
              `postureCoach 合成訊息（reason=${reason}, repeat=${repeat}）長度 `
              + `${text.length} 字，超過上限 ${MAX_SHORT_LINE_LENGTH} 字`,
            ).toBe(true)
            checked += 1
          }
        }
      }
      expect(checked).toBeGreaterThan(0)
    })

    it('含 {變數} 樣板的文案池必須已被長度規則豁免（複審盲點 4：copyEngine.fill() 是結構上相同的第二個合成點）', async () => {
      // copyEngine.js 的 fill()（`{var}` 樣板變數代換）跟 postureCoach 的
      // formatPostureMessage() 是同一種「合成」風險：模板字面量代入變數
      // 後可能變長。目前唯一用到 `{var}` 的是 summary.js 的 SUMMARY_COPY，
      // 它剛好已經整體豁免長度規則——但那是「唯一用戶剛好被豁免」的巧合，
      // 不是設計上的保證。這條測試把這個前提「釘」住：只要有新的文案池
      // 用了 `{var}` 樣板卻沒有申請長度豁免，這裡就會紅，提醒要嘛幫它加
      // 豁免（附理由），要嘛比照 formatPostureMessage() 幫它寫窮舉測試。
      const entries = await collectCopyPoolEntries()
      const templated = entries.filter((e) => /\{[a-zA-Z]+\}/.test(e.text))
      expect(templated.length).toBeGreaterThan(0) // 目前至少 summary.js 有，這條測試才有意義
      for (const entry of templated) {
        expect(
          isLengthExempt(entry),
          `${entry.exportName}.${entry.path} 含 {變數} 樣板卻沒有被長度規則豁免——`
          + 'copyEngine.fill() 代入變數後的實際長度沒有被窮舉檢查，請幫它加豁免或窮舉測試',
        ).toBe(true)
      }
    })
  })

  describe('掃描範圍由目錄決定，不是人工清單（驗收項目 4 的機制驗證）', () => {
    it('src/data/copy 底下的 .js 檔清單來自 fs.readdirSync，不是寫死的陣列', () => {
      // 刻意用 arrayContaining 而不是「完整陣列相等」：後者等於把檔案清單
      // 重新寫死一份在測試裡，日後有人加新檔案，這條測試反而會變成
      // 「凍結檔案清單」的路障，跟這個護欄要解決的問題背道而馳。
      const names = listFilesRecursive(DATA_COPY_DIR, ['.js']).map((f) => path.basename(f))
      expect(names).toEqual(expect.arrayContaining(['boss.js', 'posture.js', 'summary.js']))
    })

    it('collectCopyPoolEntries 對任何存在於目錄下的 .js 檔都會 import 並展開其匯出（不靠檔名白名單）', async () => {
      const entries = await collectCopyPoolEntries()
      const files = new Set(entries.map((e) => path.basename(e.file)))
      expect(files.has('boss.js')).toBe(true)
      expect(files.has('posture.js')).toBe(true)
      expect(files.has('summary.js')).toBe(true)
    })

    it('listAllJsSourceFiles／listTopLevelFiles／listPublicTextFiles 都來自 fs.readdirSync，能看到目前已知的檔案', () => {
      const jsNames = listAllJsSourceFiles().map((f) => path.basename(f))
      expect(jsNames).toEqual(expect.arrayContaining(['postureCoach.js', 'sw.js']))
      // copyGuardrail.js 是唯一明文排除的檔名（見該函式的說明：BANNED_WORDS
      // 清單的定義本身必須逐字包含每個禁用詞），不是掃描範圍有漏洞。
      expect(jsNames).not.toContain('copyGuardrail.js')

      const htmlNames = listTopLevelFiles(REPO_ROOT_DIR, ['.html']).map((f) => path.basename(f))
      expect(htmlNames).toEqual(expect.arrayContaining(['index.html']))

      const publicNames = listPublicTextFiles().map((f) => path.basename(f))
      expect(publicNames).toEqual(expect.arrayContaining(['manifest.webmanifest']))
    })
  })
})
