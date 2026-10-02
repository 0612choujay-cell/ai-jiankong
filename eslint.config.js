import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'

export default [
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: { window: 'readonly', document: 'readonly', navigator: 'readonly',
                 localStorage: 'readonly', indexedDB: 'readonly', performance: 'readonly',
                 speechSynthesis: 'readonly', SpeechSynthesisUtterance: 'readonly',
                 setTimeout: 'readonly', clearTimeout: 'readonly',
                 setInterval: 'readonly', clearInterval: 'readonly',
                 requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
                 AbortController: 'readonly', URL: 'readonly',
                 fetch: 'readonly', OffscreenCanvas: 'readonly',
                 // Task 18：StatsDashboard.vue 讀 CSS 自訂屬性（--c-hero 等）
                 // 餵給 Chart.js 當顏色，主執行緒（Window）本來就有這個全域。
                 getComputedStyle: 'readonly',
                 // CalibrationWizard.vue 的對齊框 letterbox 計算：iPad 轉向
                 // 時用 ResizeObserver 觀察容器尺寸變化，loadedmetadata 用
                 // Event 建構子在測試裡手動觸發（真實瀏覽器事件不需要這個
                 // 建構子，但 jsdom 的測試環境要靠它組出事件）。
                 ResizeObserver: 'readonly', Event: 'readonly' },
    },
    rules: {
      // 隱私紅線：v-html 會讓文案池變成 XSS 面
      'vue/no-v-html': 'error',
      'no-console': 'warn',

      // 以下兩條純排版規則刻意關掉。它們是 eslint-plugin-vue recommended 帶進來的，
      // 只會噴 warning，但這個專案還有八個元件要進來，警告會累積到沒人看 lint 輸出為止。
      // 一直被忽略的警告等同沒有 lint——要嘛執行要嘛移除，這裡選移除，
      // 讓 lint 輸出維持在「有東西就是真的有事」的狀態。
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    // src/sw.js 跑在 ServiceWorkerGlobalScope，不是主執行緒：self/caches/
    // Response 是它專屬的全域，window/document/localStorage 等只掛在 Window
    // 的全域在那個執行緒裡根本不存在（indexedDB、OffscreenCanvas 則是
    // [Exposed=(Window,Worker)]，Worker 系執行緒本來就有，這裡不關）。
    // 以前這些全域全部混在同一個共用區塊，代表「在 SW 裡誤用 window.foo」
    // 這種錯誤 lint 完全抓不到，只會在執行期才炸成 ReferenceError。分開之後
    // lint 才能真的幫忙擋這類錯誤。
    // src/swLogic.js 是 sw.js 抽出來的純邏輯（同一個執行緒環境，只是被
    // vite 內聯進同一個輸出檔——見該檔開頭註解），套同一組全域規則。
    files: ['src/sw.js', 'src/swLogic.js'],
    languageOptions: {
      globals: {
        window: 'off', document: 'off', localStorage: 'off',
        speechSynthesis: 'off', SpeechSynthesisUtterance: 'off',
        requestAnimationFrame: 'off', cancelAnimationFrame: 'off',
        self: 'readonly', caches: 'readonly', Response: 'readonly', Request: 'readonly',
      },
    },
  },
]
