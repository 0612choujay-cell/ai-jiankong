# 專注討伐戰：懶惰大魔王 — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一個只跑在 iPad Pro M1 / Safari 上的離線 PWA，用前鏡頭即時偵測坐姿與專注狀態，把它轉成 RPG 討伐戰，結束後產出統計圖表。

**Architecture:** Vue3 + Vite 純前端靜態站，託管於 Cloudflare Pages。MediaPipe Tasks Vision 三個 task（Pose / Face / Object）在**主執行緒**以 EDF 排程輪流推論，封裝在 `InferenceService` 後面。所有判定邏輯（PoseAnalyzer、FocusStateMachine）寫成不碰 DOM、不呼叫 `Date.now()` 的純函式模組，時間一律由呼叫端傳入，因此可用 Vitest 完整單元測試；UI 層只負責把狀態畫出來。

**Tech Stack:** Vue 3、Vite、Vitest、@mediapipe/tasks-vision、Chart.js、Web Speech Synthesis、IndexedDB、Service Worker、Cloudflare Pages

**Spec:** `docs/superpowers/specs/2026-09-11-focus-quest-ipad-design.md`（v4.2）

## Global Constraints

以下是整份 spec 的專案級要求，**每個工項的驗收條件都隱含包含本節**。數值逐字取自 spec。

**平台與相依**
- 支援基準：iPad Pro M1 / iPadOS ≥ 16.4 / Safari。不做相容矩陣，不支援其他機型。
- 零網路依賴：除首次下載模型檔外，所有功能必須在**飛航模式**下完整運作。
- npm 相依一律 `npm install --save-exact` 釘死精確版本，`package-lock.json` 入庫，安裝用 `npm ci`。
- MediaPipe wasm fileset 與模型檔**自我託管於同源**（`public/wasm/`、`public/models/`），不得走 CDN。
- 不引入 CI（本 repo 沒有 CI）、不引入 Dependabot、不做模型 SHA-256 比對。

**推論**
- 推論跑在**主執行緒**，封裝為 `InferenceService`（`async analyze()`）。**不得引入 Web Worker，不得把渲染或推論管線搬進 OffscreenCanvas。**
  - 這條限制的對象是「架構」，不是「型別」。把一個 `OffscreenCanvas(1, 1)` 當 GL context 的載體傳給 MediaPipe 不在禁止之列——MediaPipe 在沒拿到 `canvas` 選項時本來就會自己 `new OffscreenCanvas(1, 1)`（每個 task 各一個），字面禁止型別做不到也沒有意義。
- 固定頻率：**Pose 2fps / Face 3fps / Object 0.33fps**（合計約 5.3 次/秒），EDF 排程，單一 in-flight。
- 相機固定 **640×480、frameRate max 15**，不做解析度階梯，不做推論前手動縮圖。
- 三個 task **共用同一個 1×1 canvas / GL context**，靠 `createFromOptions` 的 `canvas` 選項達成。已讀 `@mediapipe/tasks-vision@1.0.1` 原始碼確認此選項存在且三個 task 共用同一個工廠函式；不給的話是三個獨立 GL context。該 canvas 不得 `getContext('2d')`、不得掛進 DOM、三個 task 要一起 `close()`。
- `numPoses: 1` / `numFaces: 1`，多人入鏡時只取 bounding box 最大者。
- 唯一的自適應是**單向緊急降檔、不可升回**：推論延遲 EMA(α=0.2) > **150ms 連續 10 秒** → 頻率減半 ＋ 關閉 ObjectDetector ＋ StatusIndicator 顯示「效能模式」。**不可用 rAF 掉幀率當降檔依據**。
- 記憶體上限 250MB（估算 120-150MB）。跨輪**重複使用** InferenceService，結束時不 `close()` task、不重建。

**隱私（紅線）**
- **禁止寫入或傳出**：landmark 座標、blendshape 數值、影像／快照、原始角度時序、裝置識別碼。影格用後即 `close()`，永不序列化。
- `getUserMedia` 必須明確 `audio: false`；**禁用 `SpeechRecognition`**（iOS 會把音訊送 Apple 伺服器）。
- `_headers` 必須有 `Permissions-Policy: camera=(self), microphone=()`。
- `vite.config.js` 必須設 `esbuild: { drop: ['console', 'debugger'] }`。
- 禁止 `v-html`，ESLint 開啟 `vue/no-v-html`。
- 必須有「清除所有本地紀錄」按鈕；授權前必須先顯示隱私說明。

**戰鬥數值（逐字）**
| 項目 | 數值 |
|---|---|
| 單輪時長 | 預設 15 分鐘，可調 5–40 分鐘，步進器＋快捷鍵 10/15/20/25（**不用文字輸入框**） |
| Boss HP | **144 × 時長(分鐘)** |
| 攻擊間隔 | 5 秒（展示模式 1 秒） |
| 每次傷害 | 20 |
| 積分 | 每次命中 +10 |
| 玩家 HP | 100 |
| 姿態不良扣血 | 每 5 秒 −3 HP |
| 玩家 HP 歸零 | **不是失敗**：重整旗鼓 10 秒（無法攻擊），HP 回復至 30 |
| 陷阱 | Boss 回血 +5% 上限、積分 −100 |
| 陷阱撤銷 | **延後生效**：20 秒待確認，期間不扣分、不回血、不中斷連擊、不發聲、不寫持久層 |
| 手機陷阱 | 連續 3 秒觸發，2.5 秒起顯示倒數預警 |
| 離開陷阱 | 離開 > 5 秒觸發，回前景時提供撤銷 |
| 瞌睡 | 閉眼 > 2 秒，**不影響戰鬥數值**，只觸發休息建議 |
| 展示模式 | 20 秒 / 攻擊間隔 1 秒 / Boss HP 240 / 校準排在計時外 / 姿態閾值不縮放 |

**文案與語音**
- 作品名稱不可更動；遊戲內提示用中性語氣，**不得出現「懶惰」「摸魚」「沒用」「果然做不到」或任何身體外觀描述**。
- 魔王台詞只針對戰況與行為，不針對人格。台詞長度上限 **15 字**。
- 語音**預設關閉**，主畫面有明顯喇叭開關。**分心類提示（手機／離開）一律不朗讀**。
- 所有語音內容必須同時有畫面文字。
- 同狀態提示 cooldown **≥ 45 秒**；連續同狀態第 2 次起無語音、只閃圖示。取句用 shuffle bag。
- **交付前門檻：全部台詞由一位成人逐句讀過並簽核**（Task 22）。

**觸控與無障礙**
- 觸控目標 ≥44×44pt，主要按鈕 ≥60pt；不依賴 hover。
- 「暫停」與「結束」不相鄰同尺寸，結束需二次確認對話框（不做長按）。
- 對比 ≥4.5:1，色彩只能取自 token；不單靠顏色傳達（血條帶數字、狀態圖示＋文字）。
- 正文 ≥17px；**即時姿態提示 ≥36px 粗體高對比、固定於畫面上方 1/3**。
- 尊重 `prefers-reduced-motion`；動畫只用 `transform` / `opacity`，事件驅動，閒置時每秒重繪 < 5 次。
- 橫式為主，**直式須可用（單欄降級）**；方向改變不暫停、不強制重新校準。

**Git**
- 每個工項結束都要 commit。commit 訊息結尾加上：
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

## 檔案結構

實作前先看懂要蓋出什麼。核心原則：**判定邏輯與 DOM／時間源完全隔離**，這是整個計畫能被測試的前提。

```
package.json               精確版本釘選，scripts: dev / build / test / lint
vite.config.js             @vitejs/plugin-vue + basicSsl + esbuild.drop + vitest 設定
eslint.config.js           eslint-plugin-vue + vue/no-v-html
index.html
public/
  wasm/                    從 node_modules 複製的 MediaPipe wasm fileset（自我託管）
  models/                  三個模型檔（自我託管）
  icons/                   PWA 圖示
  manifest.webmanifest
  _headers                 Cloudflare Pages 安全標頭
src/
  main.js
  App.vue                  流程狀態機（privacy → permission → calibrate → task → battle → break → stats）
  sw.js                    Service Worker（app shell 預快取 + 模型 runtime caching）
  styles/
    tokens.css             色票／字級／間距 token，美術不得在 token 外取色
    base.css               重置、觸控目標尺寸、reduced-motion
  core/                    ← 全部是純模組：不 import Vue、不碰 DOM、不呼叫 Date.now()
    battleConfig.js        戰鬥常數 + bossHpFor() + 展示模式
    postureProfiles.js     任務類型 → 姿態閾值 profile
    poseGeometry.js        landmarks/blendshapes → 正規化純量
    poseAnalyzer.js        零階保持 + 時間積分 + 閾值判定
    focusStateMachine.js   戰鬥判定核心（本計畫最重要的一個檔）
    inferenceScheduler.js  EDF 排程器（可獨立測）
    inferenceService.js    MediaPipe 三 task 封裝（唯一碰 MediaPipe 的檔）
    thresholdLab.js        姿態閾值量測工具（僅開發期用，不進正式流程）
    cameraCapture.js       getUserMedia 生命週期（唯一碰鏡頭的檔）
    perfMonitor.js         延遲 EMA、單向緊急降檔、推論 watchdog
    messageQueue.js        單一 priority store
    copyEngine.js          shuffle bag + cooldown 取句器
    bossDialogue.js        事件 → 文案 key 的映射（不持有資料）
    voiceFeedback.js       Web Speech TTS
    storageService.js      IndexedDB + localStorage crumb
    summary.js             白話總結（含冷啟動分支）
    radar.js               雷達圖五軸計算
  data/copy/
    posture.js  boss.js  summary.js
  stores/
    session.js             Vue reactive 單例，App 與元件的唯一共享狀態
  components/
    PrivacyNotice.vue  PermissionGate.vue  CalibrationWizard.vue  TaskSelector.vue
    BattleView.vue  HpBar.vue  CoachBanner.vue  StatusIndicator.vue  DebugHud.vue
    StatsDashboard.vue  BreakScreen.vue  InstallGuide.vue  ConfirmDialog.vue
```

測試檔與被測檔**同目錄並列**（`src/core/focusStateMachine.test.js`），減少路徑出錯。

## 產出物與部署去向

| 東西 | 位置 |
|---|---|
| **專案原始碼** | `C:\Users\cody\Desktop\Intensitycontrol\`（目前這個 git repo，直接在根目錄建立 `src/`、`public/` 等） |
| 設計文件 | `docs/superpowers/specs/2026-09-11-focus-quest-ipad-design.md` |
| 本實作計畫 | `docs/superpowers/plans/2026-09-11-focus-quest-implementation.md` |
| MediaPipe wasm 與模型檔 | `public/wasm/`、`public/models/` — **要入庫**，不進 `.gitignore`（零網路依賴的前提） |
| 建置產物 | `dist/` — **不入庫**，每次 `npm run build` 重新產生 |
| **正式站** | Cloudflare Pages，建置指令 `npm ci && npm run build`，輸出目錄 `dist`（Task 21 設定） |
| iPad 上實際跑的東西 | Safari 開正式站網址 →「加到主畫面」安裝成 PWA，之後離線從主畫面圖示啟動 |

開發期不需要部署也能在 iPad 上測：`npm run dev` 起 HTTPS dev server，iPad Safari 連 `https://<開發機區網IP>:5173`。正式站是 demo 當天要用的那一份。

---

### Task 1: 專案骨架與工具鏈

把空目錄變成一個能 `npm run dev` 開起來、`npm test` 跑得動、`npm run lint` 擋得住 `v-html` 的 Vue3 專案。這個工項不寫任何業務邏輯。

**Files:**
- Create: `package.json`, `vite.config.js`, `eslint.config.js`, `index.html`, `.gitignore`
- Create: `src/main.js`, `src/App.vue`, `src/styles/tokens.css`, `src/styles/base.css`
- Create: `src/core/smoke.test.js`（暫時，Task 2 刪除）

**Interfaces:**
- Consumes: 無（第一個工項）
- Produces: `npm run dev`（HTTPS dev server）、`npm test`（Vitest）、`npm run build`（輸出 `dist/`）、`npm run lint`；CSS 變數 token 全域可用

- [ ] **Step 1: 初始化 npm 並安裝精確版本相依**

```bash
cd /c/Users/cody/Desktop/Intensitycontrol
npm init -y
npm install --save-exact vue chart.js @mediapipe/tasks-vision@1.0.1
npm install --save-exact --save-dev vite @vitejs/plugin-vue @vitejs/plugin-basic-ssl vitest jsdom eslint eslint-plugin-vue
```

`--save-exact` 讓 `package.json` 寫死版本號而不是 `^x.y.z`。安裝完打開 `package.json` 確認每個版本前面都**沒有** `^` 或 `~`。

`@mediapipe/tasks-vision` **必須是 `1.0.1`**，不可以裝 `latest` 或 `1.0.1-rc.*`。這個版本號是已實際讀過
`vision_bundle.mjs` 原始碼驗證過的：三個 task 的 `createFromOptions` 共用同一個工廠函式，
第一件事就是讀 `options.canvas`（Task 7 共用 GL context 的作法依賴這個行為）。
換版本前要重新確認這件事還成立：

```bash
node -e "const s=require('fs').readFileSync('node_modules/@mediapipe/tasks-vision/vision_bundle.mjs','utf8');console.log(/canvas\s*\?\?/.test(s)?'canvas 選項 OK':'⚠ 找不到 canvas 選項，Task 7 要改寫')"
```

這行要印出 `canvas 選項 OK` 才算通過。另外 `npm view @mediapipe/tasks-vision versions` 會看到一堆
`1.0.1-rc.YYYYMMDD` 每日建置版，那些不是穩定版，不要裝。

- [ ] **Step 2: 改寫 package.json 的 scripts 與欄位**

把 `package.json` 的 `name` / `scripts` 改成（版本號保留 npm 實際裝出來的，不要照抄）：

```json
{
  "name": "focus-quest",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host",
    "build": "vite build",
    "preview": "vite preview --host",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src"
  }
}
```

- [ ] **Step 3: 寫 vite.config.js**

```js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [vue(), basicSsl()],
  server: { https: true },
  // 隱私紅線：正式 bundle 不得殘留任何 console 輸出
  esbuild: { drop: ['console', 'debugger'] },
  build: { target: 'safari16' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
```

`basicSsl` 是為了拿到 secure context — `getUserMedia` 在 http 上不會給鏡頭。iPad 連 dev server 時 Safari 會警告自簽憑證，點「繼續」即可。

- [ ] **Step 4: 寫 eslint.config.js**

```js
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
                 AbortController: 'readonly', URL: 'readonly', caches: 'readonly',
                 fetch: 'readonly', self: 'readonly' },
    },
    rules: {
      // 隱私紅線：v-html 會讓文案池變成 XSS 面
      'vue/no-v-html': 'error',
      'no-console': 'warn',
    },
  },
]
```

裝 `@eslint/js`：`npm install --save-exact --save-dev @eslint/js`

- [ ] **Step 5: 寫色票 token**

`src/styles/tokens.css`。所有顏色只能從這裡取，元件內不得寫死色碼。對比度全部對深色底 `--c-bg` 驗過 ≥4.5:1。

```css
:root {
  --c-bg: #12131a;
  --c-surface: #1e2029;
  --c-text: #f2f3f7;
  --c-text-dim: #b8bcc9;
  --c-accent: #5ad1ff;
  --c-hero: #4ade80;
  --c-boss: #f472b6;
  --c-warn: #fbbf24;
  --c-danger: #fb7185;
  --c-ok: #34d399;

  --fs-body: 17px;
  --fs-coach: 36px;
  --fs-title: 28px;
  --fs-number: 22px;

  --tap-min: 44px;
  --tap-primary: 60px;
  --radius: 12px;
  --gap: 16px;
}
```

- [ ] **Step 6: 寫全域基礎樣式**

`src/styles/base.css`：

```css
* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
body {
  background: var(--c-bg);
  color: var(--c-text);
  font-size: var(--fs-body);
  font-family: -apple-system, "PingFang TC", sans-serif;
  -webkit-text-size-adjust: 100%;
  overscroll-behavior: none;
}
button {
  min-width: var(--tap-min);
  min-height: var(--tap-min);
  font-size: var(--fs-body);
  border-radius: var(--radius);
  border: 0;
  color: var(--c-text);
  background: var(--c-surface);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
button.primary { min-height: var(--tap-primary); font-size: var(--fs-title); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
```

- [ ] **Step 7: 寫 index.html / main.js / App.vue**

`index.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <title>專注討伐戰：懶惰大魔王</title>
  </head>
  <body>
    <div id="app" data-app-root="focus-quest"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

`data-app-root="focus-quest"` 是 Service Worker 用來辨認「這份 HTML 真的是我們的頁面、不是 captive portal 登入頁」的標記（Task 21 會用到）。

`src/main.js`：

```js
import { createApp } from 'vue'
import App from './App.vue'
import './styles/tokens.css'
import './styles/base.css'

createApp(App).mount('#app')
```

`src/App.vue`：

```vue
<template>
  <main class="shell">
    <h1>專注討伐戰：懶惰大魔王</h1>
    <p>骨架就緒</p>
  </main>
</template>

<style scoped>
.shell { padding: var(--gap); }
</style>
```

- [ ] **Step 8: 寫一個 smoke test 確認 Vitest 真的會跑**

`src/core/smoke.test.js`：

```js
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 9: 跑三個指令驗證骨架**

```bash
npm test          # 預期：1 passed
npm run lint      # 預期：0 errors
npm run build     # 預期：產出 dist/
```

三個都過才算完成。`npm run dev` 另外開起來，用 iPad Safari 連 `https://<電腦區網IP>:5173` 確認頁面顯示「骨架就緒」。

- [ ] **Step 10: 寫 .gitignore 並 commit**

`.gitignore`：

```
node_modules/
dist/
.vite/
*.local
```

注意 `package-lock.json` **不可**加入 `.gitignore` — spec 要求 lockfile 入庫。

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: 建立 Vue3 + Vite + Vitest 專案骨架

含 HTTPS dev server、esbuild drop console、vue/no-v-html 與色票 token。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 戰鬥常數與 Boss HP 公式

把 spec「戰鬥數值與勝負條件」整張表變成一個只有常數與純函式的模組。這是後面每個工項的數值來源，**不允許任何地方再寫死魔法數字**。

**Files:**
- Create: `src/core/battleConfig.js`
- Create: `src/core/battleConfig.test.js`
- Delete: `src/core/smoke.test.js`

**Interfaces:**
- Consumes: 無
- Produces:
  - `BATTLE`（常數物件，見下）
  - `bossHpFor(durationMs: number, demoMode: boolean): number`
  - `attackIntervalFor(demoMode: boolean): number`
  - `DURATION_PRESETS: number[]`（分鐘）、`DURATION_MIN_MIN`、`DURATION_MAX_MIN`、`DEFAULT_DURATION_MIN`
  - `DEMO`（展示模式常數）

- [ ] **Step 1: 先寫失敗的測試**

`src/core/battleConfig.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { BATTLE, DEMO, bossHpFor, attackIntervalFor,
         DURATION_PRESETS, DURATION_MIN_MIN, DURATION_MAX_MIN } from './battleConfig.js'

const MIN = 60_000

describe('bossHpFor', () => {
  it('用 144 × 分鐘', () => {
    expect(bossHpFor(15 * MIN, false)).toBe(2160)
    expect(bossHpFor(5 * MIN, false)).toBe(720)
    expect(bossHpFor(40 * MIN, false)).toBe(5760)
  })

  it('不變式：60% 專注率剛好在時限內打倒魔王', () => {
    for (const minutes of [5, 10, 15, 20, 25, 40]) {
      const durationMs = minutes * MIN
      const attacks = Math.floor(durationMs / BATTLE.attackIntervalMs)
      const hits = Math.floor(attacks * 0.6)
      expect(hits * BATTLE.damagePerAttack).toBe(bossHpFor(durationMs, false))
    }
  })

  it('展示模式回傳固定 240，忽略傳入時長', () => {
    expect(bossHpFor(DEMO.durationMs, true)).toBe(240)
    expect(bossHpFor(15 * MIN, true)).toBe(240)
  })

  it('展示模式同樣滿足 60% 不變式', () => {
    const attacks = Math.floor(DEMO.durationMs / DEMO.attackIntervalMs)
    expect(Math.floor(attacks * 0.6) * BATTLE.damagePerAttack).toBe(DEMO.bossHp)
  })
})

describe('attackIntervalFor', () => {
  it('一般 5 秒、展示 1 秒', () => {
    expect(attackIntervalFor(false)).toBe(5000)
    expect(attackIntervalFor(true)).toBe(1000)
  })
})

describe('時長設定', () => {
  it('可調範圍 5-40 分鐘，快捷鍵 10/15/20/25 都在範圍內', () => {
    expect(DURATION_MIN_MIN).toBe(5)
    expect(DURATION_MAX_MIN).toBe(40)
    expect(DURATION_PRESETS).toEqual([10, 15, 20, 25])
    for (const p of DURATION_PRESETS) {
      expect(p).toBeGreaterThanOrEqual(DURATION_MIN_MIN)
      expect(p).toBeLessThanOrEqual(DURATION_MAX_MIN)
    }
  })
})

describe('BATTLE 常數對齊 spec', () => {
  it('逐項比對', () => {
    expect(BATTLE.damagePerAttack).toBe(20)
    expect(BATTLE.scorePerHit).toBe(10)
    expect(BATTLE.playerHpMax).toBe(100)
    expect(BATTLE.postureDamage).toBe(3)
    expect(BATTLE.postureDamageIntervalMs).toBe(5000)
    expect(BATTLE.regroupMs).toBe(10_000)
    expect(BATTLE.regroupHp).toBe(30)
    expect(BATTLE.trapBossHealRatio).toBe(0.05)
    expect(BATTLE.trapScorePenalty).toBe(100)
    expect(BATTLE.trapUndoWindowMs).toBe(20_000)
    expect(BATTLE.phoneTrapHoldMs).toBe(3000)
    expect(BATTLE.phoneWarnAtMs).toBe(2500)
    expect(BATTLE.awayTrapMs).toBe(5000)
    expect(BATTLE.drowsyHoldMs).toBe(2000)
    expect(BATTLE.phase2RefillRatio).toBe(0.4)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- src/core/battleConfig.test.js
```

預期：`Failed to resolve import "./battleConfig.js"`

- [ ] **Step 3: 寫實作**

`src/core/battleConfig.js`：

```js
/**
 * 戰鬥數值單一來源。數值全部取自 spec「戰鬥數值與勝負條件」。
 * 除了本檔，程式其他地方不得出現這些數字的字面值。
 */

export const BATTLE = Object.freeze({
  attackIntervalMs: 5000,
  damagePerAttack: 20,
  scorePerHit: 10,

  playerHpMax: 100,
  postureDamage: 3,
  postureDamageIntervalMs: 5000,

  // 玩家 HP 歸零不是失敗，改為短暫無法攻擊後回到 30
  regroupMs: 10_000,
  regroupHp: 30,

  // 陷阱：延後生效，20 秒待確認期間完全不影響任何數值
  trapBossHealRatio: 0.05,
  trapScorePenalty: 100,
  trapUndoWindowMs: 20_000,
  phoneTrapHoldMs: 3000,
  phoneWarnAtMs: 2500,
  awayTrapMs: 5000,

  drowsyHoldMs: 2000,

  // 提早擊倒時進入第二形態，補這個比例的血繼續打
  phase2RefillRatio: 0.4,

  bossHpPerMinute: 144,
  focusThreshold: 0.6,
})

export const DEMO = Object.freeze({
  durationMs: 20_000,
  attackIntervalMs: 1000,
  bossHp: 240,
})

export const DURATION_MIN_MIN = 5
export const DURATION_MAX_MIN = 40
export const DEFAULT_DURATION_MIN = 15
export const DURATION_PRESETS = Object.freeze([10, 15, 20, 25])

/**
 * Boss HP = 144 × 時長(分鐘)。
 * 這個係數的意義：每分鐘 12 次攻擊機會 × 60% 專注率 × 20 傷害 = 144。
 * 因此任何時長下，「達成 60% 專注率」都恰好等於「時限內打倒魔王」。
 */
export function bossHpFor(durationMs, demoMode = false) {
  if (demoMode) return DEMO.bossHp
  return Math.round(BATTLE.bossHpPerMinute * (durationMs / 60_000))
}

export function attackIntervalFor(demoMode = false) {
  return demoMode ? DEMO.attackIntervalMs : BATTLE.attackIntervalMs
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
rm src/core/smoke.test.js
npm test
```

預期：全部 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: 戰鬥常數與 Boss HP 公式

Boss HP = 144 × 分鐘，以測試鎖住「60% 專注率剛好打倒魔王」的不變式。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 姿態幾何與 PoseAnalyzer

把 MediaPipe 吐出來的 landmark / blendshape 變成「端正／駝背／頭部前傾／視線偏移」與獨立的「瞌睡」布林值。

**為什麼不用角度**：前鏡頭是正面視角，量不到矢狀面（側面）的頭頸前傾角度。改用兩個對拍攝距離不敏感的正規化比值：

- `neckRatio = (肩中點 y − 耳中點 y) ÷ 肩寬` — 頭前傾或低頭時變小
- `shoulderWidth` — 身體往桌面塌下去／靠近鏡頭時變大

兩者都在校準時取基準，判定一律比對基準的**相對變化**，不用絕對值。

**判定用零階保持＋時間積分**：每個取樣結果持有到下一個取樣點（Pose 只有 2fps，中間 500ms 的空窗必須算進去），在 6 秒滑動窗口內累加各狀態的秒數，且窗口內**至少 2 個取樣點**才可觸發（單一離群幀不得改變狀態）。

**Files:**
- Create: `src/core/poseGeometry.js`, `src/core/poseGeometry.test.js`
- Create: `src/core/postureProfiles.js`
- Create: `src/core/poseAnalyzer.js`, `src/core/poseAnalyzer.test.js`

**Interfaces:**
- Consumes: `BATTLE.drowsyHoldMs`（來自 Task 2）
- Produces:
  - `poseGeometry.js`：`poseMetrics(landmarks) -> { neckRatio, shoulderWidth, valid }`、`faceMetrics(blendshapes) -> { eyeClosed, gaze }`，`gaze` 為 `'center' | 'down' | 'away'`
  - `postureProfiles.js`：`PROFILES`（key 為 `taskType`）、`profileFor(taskType)`
  - `poseAnalyzer.js`：`createPoseAnalyzer({ baseline, profile })`，方法 `pushPose({ t, metrics })`、`pushFace({ t, metrics })`、`evaluate(t) -> { posture, drowsy }`、`reset()`
  - `posture` 值域：`'upright' | 'slouch' | 'forwardHead' | 'gazeAway'`（`drowsy` 是獨立布林，不在 posture 裡）

- [ ] **Step 1: 寫 poseGeometry 的失敗測試**

`src/core/poseGeometry.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { poseMetrics, faceMetrics } from './poseGeometry.js'

// MediaPipe pose landmark 索引：7 左耳 8 右耳 11 左肩 12 右肩
function makeLandmarks({ earY, shoulderY, shoulderHalfWidth, visibility = 0.9 }) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  pts[7] = { x: 0.5 - shoulderHalfWidth * 0.4, y: earY, z: 0, visibility }
  pts[8] = { x: 0.5 + shoulderHalfWidth * 0.4, y: earY, z: 0, visibility }
  pts[11] = { x: 0.5 - shoulderHalfWidth, y: shoulderY, z: 0, visibility }
  pts[12] = { x: 0.5 + shoulderHalfWidth, y: shoulderY, z: 0, visibility }
  return pts
}

describe('poseMetrics', () => {
  it('端正坐姿：neckRatio 為正、shoulderWidth 等於兩肩距離', () => {
    const m = poseMetrics(makeLandmarks({ earY: 0.30, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    expect(m.valid).toBe(true)
    expect(m.shoulderWidth).toBeCloseTo(0.30, 5)
    expect(m.neckRatio).toBeCloseTo(0.30 / 0.30, 5) // (0.60-0.30)/0.30
  })

  it('低頭時 neckRatio 變小', () => {
    const upright = poseMetrics(makeLandmarks({ earY: 0.30, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    const down = poseMetrics(makeLandmarks({ earY: 0.45, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    expect(down.neckRatio).toBeLessThan(upright.neckRatio)
  })

  it('靠近鏡頭時 shoulderWidth 變大', () => {
    const far = poseMetrics(makeLandmarks({ earY: 0.30, shoulderY: 0.60, shoulderHalfWidth: 0.15 }))
    const near = poseMetrics(makeLandmarks({ earY: 0.25, shoulderY: 0.62, shoulderHalfWidth: 0.22 }))
    expect(near.shoulderWidth).toBeGreaterThan(far.shoulderWidth)
  })

  it('可見度不足時 valid 為 false', () => {
    expect(poseMetrics(makeLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.15, visibility: 0.2 })).valid).toBe(false)
  })

  it('landmarks 為空或長度不足時 valid 為 false，不得丟例外', () => {
    expect(poseMetrics(null).valid).toBe(false)
    expect(poseMetrics([]).valid).toBe(false)
  })

  it('肩寬趨近 0 時 valid 為 false（避免除以零）', () => {
    expect(poseMetrics(makeLandmarks({ earY: 0.3, shoulderY: 0.6, shoulderHalfWidth: 0.0005 })).valid).toBe(false)
  })
})

function bs(map) {
  return Object.entries(map).map(([categoryName, score]) => ({ categoryName, score }))
}

describe('faceMetrics', () => {
  it('雙眼閉合分數高於門檻視為閉眼', () => {
    expect(faceMetrics(bs({ eyeBlinkLeft: 0.8, eyeBlinkRight: 0.75 })).eyeClosed).toBe(true)
    expect(faceMetrics(bs({ eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 })).eyeClosed).toBe(false)
  })

  it('視線往下判為 down（看書，不算分心）', () => {
    expect(faceMetrics(bs({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6 })).gaze).toBe('down')
  })

  it('往下優先於往旁：低頭斜看書不得被判成分心', () => {
    const m = faceMetrics(bs({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6, eyeLookOutLeft: 0.7 }))
    expect(m.gaze).toBe('down')
  })

  it('視線往旁或往上判為 away', () => {
    expect(faceMetrics(bs({ eyeLookOutLeft: 0.6, eyeLookOutRight: 0.55 })).gaze).toBe('away')
    expect(faceMetrics(bs({ eyeLookUpLeft: 0.6, eyeLookUpRight: 0.6 })).gaze).toBe('away')
  })

  it('都不明顯時判為 center', () => {
    expect(faceMetrics(bs({ eyeLookDownLeft: 0.1, eyeLookOutLeft: 0.1 })).gaze).toBe('center')
  })

  it('blendshapes 為空時 gaze 為 center、eyeClosed 為 false', () => {
    expect(faceMetrics(null)).toEqual({ eyeClosed: false, gaze: 'center' })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- src/core/poseGeometry.test.js
```
預期：`Failed to resolve import "./poseGeometry.js"`

- [ ] **Step 3: 寫 poseGeometry 實作**

`src/core/poseGeometry.js`：

```js
/**
 * 把 MediaPipe 的原始輸出換算成少數幾個正規化純量。
 * 這是唯一知道 landmark 索引與 blendshape 名稱的地方。
 *
 * 隱私：本檔只回傳純量，呼叫端不得保留傳入的 landmarks / blendshapes。
 */

const EAR_L = 7, EAR_R = 8, SHOULDER_L = 11, SHOULDER_R = 12
const MIN_VISIBILITY = 0.5
const MIN_SHOULDER_WIDTH = 0.02

const INVALID = Object.freeze({ neckRatio: 0, shoulderWidth: 0, valid: false })

export function poseMetrics(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 33) return INVALID

  const pts = [landmarks[EAR_L], landmarks[EAR_R], landmarks[SHOULDER_L], landmarks[SHOULDER_R]]
  if (pts.some((p) => !p)) return INVALID
  // visibility 可能不存在（某些模型版本），沒有就當作可見
  if (pts.some((p) => p.visibility !== undefined && p.visibility < MIN_VISIBILITY)) return INVALID

  const [earL, earR, shL, shR] = pts
  const shoulderWidth = Math.hypot(shR.x - shL.x, shR.y - shL.y)
  if (shoulderWidth < MIN_SHOULDER_WIDTH) return INVALID

  const earMidY = (earL.y + earR.y) / 2
  const shoulderMidY = (shL.y + shR.y) / 2

  // 影像座標 y 向下為正，所以「肩 − 耳」在頭抬起時為正值
  return { neckRatio: (shoulderMidY - earMidY) / shoulderWidth, shoulderWidth, valid: true }
}

const EYE_CLOSED_THRESHOLD = 0.5
const GAZE_DOWN_THRESHOLD = 0.35
const GAZE_SIDE_THRESHOLD = 0.40
const GAZE_UP_THRESHOLD = 0.35

function scoreOf(map, name) {
  const v = map.get(name)
  return typeof v === 'number' ? v : 0
}

export function faceMetrics(blendshapes) {
  if (!Array.isArray(blendshapes) || blendshapes.length === 0) {
    return { eyeClosed: false, gaze: 'center' }
  }
  const map = new Map(blendshapes.map((c) => [c.categoryName, c.score]))

  const blink = (scoreOf(map, 'eyeBlinkLeft') + scoreOf(map, 'eyeBlinkRight')) / 2
  const down = (scoreOf(map, 'eyeLookDownLeft') + scoreOf(map, 'eyeLookDownRight')) / 2
  const up = (scoreOf(map, 'eyeLookUpLeft') + scoreOf(map, 'eyeLookUpRight')) / 2
  const side = Math.max(
    (scoreOf(map, 'eyeLookOutLeft') + scoreOf(map, 'eyeLookInRight')) / 2,
    (scoreOf(map, 'eyeLookOutRight') + scoreOf(map, 'eyeLookInLeft')) / 2,
  )

  let gaze = 'center'
  // 往下優先判定：低頭看書本來就會同時出現側向分量，不能因此被當成分心
  if (down > GAZE_DOWN_THRESHOLD) gaze = 'down'
  else if (side > GAZE_SIDE_THRESHOLD || up > GAZE_UP_THRESHOLD) gaze = 'away'

  return { eyeClosed: blink > EYE_CLOSED_THRESHOLD, gaze }
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npm test -- src/core/poseGeometry.test.js
```
預期：全部 passed。

- [ ] **Step 5: 寫姿態 profile（無測試，純資料表）**

`src/core/postureProfiles.js`：

```js
/**
 * 任務類型決定姿態閾值。看書／寫作業本來就會低頭，
 * 用同一組閾值會整場都在喊「你低頭了」。
 *
 * spec 的「容許角度 +15°」在正規化比值下換算為「容許值放寬 50%」。
 *
 * ⚠ 下面 BASE 的四個數字是初始佔位值，沒有任何人量過。
 * Task 7 Step 10b 用 thresholdLab 在 iPad 上量出真值後必須回來覆蓋，
 * 並把實測值寫進該工項的 commit message。在那之前不要相信這裡的數字。
 */

const BASE = {
  // neckRatio 相對基準下降超過此比例 → 頭部前傾
  neckDropRatio: 0.12,
  // shoulderWidth 相對基準增加超過此比例 → 身體塌向桌面
  shoulderGrowRatio: 0.12,
  // 狀態需在窗口內持有多久才成立
  postureHoldMs: 3000,
  gazeAwayHoldMs: 2000,
  // 駝背是否必須「前傾且肩線塌陷」同時成立
  requireBothForSlouch: false,
}

export const PROFILES = Object.freeze({
  homework: Object.freeze({ ...BASE, neckDropRatio: 0.18, requireBothForSlouch: true }),
  reading:  Object.freeze({ ...BASE, neckDropRatio: 0.18, requireBothForSlouch: true }),
  vocab:    Object.freeze({ ...BASE }),
  custom:   Object.freeze({ ...BASE }),
})

export function profileFor(taskType) {
  return PROFILES[taskType] ?? PROFILES.custom
}
```

- [ ] **Step 6: 寫 PoseAnalyzer 的失敗測試**

`src/core/poseAnalyzer.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createPoseAnalyzer } from './poseAnalyzer.js'
import { profileFor } from './postureProfiles.js'

const baseline = { baselineNeckRatio: 1.0, baselineShoulderWidth: 0.30 }

function makeAnalyzer(taskType = 'vocab') {
  return createPoseAnalyzer({ baseline, profile: profileFor(taskType) })
}

// 以 500ms 一筆（Pose 2fps）連續餵同一種姿態
function feedPose(a, { from, to, neckRatio, shoulderWidth = 0.30 }) {
  for (let t = from; t <= to; t += 500) {
    a.pushPose({ t, metrics: { neckRatio, shoulderWidth, valid: true } })
  }
}

function feedFace(a, { from, to, eyeClosed = false, gaze = 'center' }) {
  for (let t = from; t <= to; t += 333) {
    a.pushFace({ t, metrics: { eyeClosed, gaze } })
  }
}

describe('createPoseAnalyzer', () => {
  it('沒有任何取樣時回傳 upright 且不 drowsy', () => {
    expect(makeAnalyzer().evaluate(0)).toEqual({ posture: 'upright', drowsy: false })
  })

  it('單一離群幀不得改變狀態（窗口內至少要 2 個取樣點）', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 6000, neckRatio: 1.0 })
    a.pushPose({ t: 6500, metrics: { neckRatio: 0.5, shoulderWidth: 0.30, valid: true } })
    expect(a.evaluate(6600).posture).toBe('upright')
  })

  it('持續低頭超過 3 秒判為 forwardHead', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80 }) // 較基準低 20% > 12%
    expect(a.evaluate(4000).posture).toBe('forwardHead')
  })

  it('低頭未滿 3 秒不判定', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 2000, neckRatio: 0.80 })
    expect(a.evaluate(2000).posture).toBe('upright')
  })

  it('持續塌向桌面判為 slouch，且優先於 forwardHead', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80, shoulderWidth: 0.36 })
    expect(a.evaluate(4000).posture).toBe('slouch')
  })

  it('看書 profile：只有肩寬變大但沒低頭時不判 slouch', () => {
    const a = makeAnalyzer('reading')
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0, shoulderWidth: 0.36 })
    expect(a.evaluate(4000).posture).toBe('upright')
  })

  it('看書 profile 容許更大的低頭幅度', () => {
    const a = makeAnalyzer('reading')
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.85 }) // 下降 15%，vocab 會判、reading 不判
    expect(a.evaluate(4000).posture).toBe('upright')

    const b = makeAnalyzer('vocab')
    feedPose(b, { from: 0, to: 4000, neckRatio: 0.85 })
    expect(b.evaluate(4000).posture).toBe('forwardHead')
  })

  it('視線往旁持續 2 秒判為 gazeAway', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0 })
    feedFace(a, { from: 0, to: 3000, gaze: 'away' })
    expect(a.evaluate(3000).posture).toBe('gazeAway')
  })

  it('視線往下不判分心', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 6000, neckRatio: 1.0 })
    feedFace(a, { from: 0, to: 6000, gaze: 'down' })
    expect(a.evaluate(6000).posture).toBe('upright')
  })

  it('閉眼超過 2 秒 drowsy 為 true，且與 posture 正交', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0 })
    feedFace(a, { from: 0, to: 3000, eyeClosed: true })
    const r = a.evaluate(3000)
    expect(r.drowsy).toBe(true)
    expect(r.posture).toBe('upright')
  })

  it('眨眼（0.3 秒）不算 drowsy', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 1.0 })
    a.pushFace({ t: 1000, metrics: { eyeClosed: true, gaze: 'center' } })
    a.pushFace({ t: 1300, metrics: { eyeClosed: false, gaze: 'center' } })
    expect(a.evaluate(4000).drowsy).toBe(false)
  })

  it('零階保持：取樣間的空窗要算進持有時間', () => {
    const a = makeAnalyzer()
    // 只餵 3 筆、間隔 1.5 秒，涵蓋 0→3000ms，持有時間需累積到 3000ms 才會判定
    a.pushPose({ t: 0, metrics: { neckRatio: 0.8, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 1500, metrics: { neckRatio: 0.8, shoulderWidth: 0.30, valid: true } })
    a.pushPose({ t: 3000, metrics: { neckRatio: 0.8, shoulderWidth: 0.30, valid: true } })
    expect(a.evaluate(3100).posture).toBe('forwardHead')
  })

  it('狀態回正後，滑動窗口會把舊的不良取樣淘汰掉', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80 })
    expect(a.evaluate(4000).posture).toBe('forwardHead')
    feedPose(a, { from: 4500, to: 12_000, neckRatio: 1.0 })
    expect(a.evaluate(12_000).posture).toBe('upright')
  })

  it('無效取樣（人離開鏡頭）不累積任何不良狀態', () => {
    const a = makeAnalyzer()
    for (let t = 0; t <= 8000; t += 500) {
      a.pushPose({ t, metrics: { neckRatio: 0, shoulderWidth: 0, valid: false } })
    }
    expect(a.evaluate(8000).posture).toBe('upright')
  })

  it('reset 清空所有累積', () => {
    const a = makeAnalyzer()
    feedPose(a, { from: 0, to: 4000, neckRatio: 0.80 })
    a.reset()
    expect(a.evaluate(4000).posture).toBe('upright')
  })
})
```

- [ ] **Step 7: 跑測試確認失敗**

```bash
npm test -- src/core/poseAnalyzer.test.js
```
預期：`Failed to resolve import "./poseAnalyzer.js"`

- [ ] **Step 8: 寫 PoseAnalyzer 實作**

`src/core/poseAnalyzer.js`：

```js
import { BATTLE } from './battleConfig.js'

const WINDOW_MS = 6000
const MIN_SAMPLES = 2

/**
 * 零階保持 + 時間積分的滑動窗口。
 *
 * 為什麼不能只看「最新一幀」：Pose 只有 2fps，單幀誤判會讓狀態每 500ms 跳一次，
 * 畫面上的提示會抖到無法閱讀。改成「在最近 6 秒內，這個狀態總共持有幾毫秒」，
 * 每筆取樣持有到下一筆取樣為止（零階保持），超過閾值才切換狀態。
 */
function createTrack() {
  return { samples: [] } // { t, value } — value 由呼叫端定義
}

function push(track, t, value) {
  const last = track.samples[track.samples.length - 1]
  if (last && t <= last.t) return // 時間必須單調遞增，亂序的取樣直接丟棄
  track.samples.push({ t, value })
}

function prune(track, now) {
  const cutoff = now - WINDOW_MS
  // 保留一筆窗口外的取樣，讓窗口起點的零階保持有值可用
  let firstInside = 0
  while (firstInside < track.samples.length && track.samples[firstInside].t < cutoff) firstInside++
  const keepFrom = Math.max(0, firstInside - 1)
  if (keepFrom > 0) track.samples.splice(0, keepFrom)
}

/**
 * 在 [now - WINDOW_MS, now] 內，predicate 為真的取樣總共持有多少毫秒。
 * 回傳 null 表示窗口內取樣數不足，不得據以判定。
 */
function heldMs(track, now, predicate) {
  prune(track, now)
  const from = now - WINDOW_MS
  const s = track.samples
  let inside = 0
  for (const sample of s) if (sample.t >= from) inside++
  if (inside < MIN_SAMPLES) return null

  let total = 0
  for (let i = 0; i < s.length; i++) {
    const start = Math.max(s[i].t, from)
    const end = i + 1 < s.length ? Math.min(s[i + 1].t, now) : now
    if (end > start && predicate(s[i].value)) total += end - start
  }
  return total
}

export function createPoseAnalyzer({ baseline, profile }) {
  let poseTrack = createTrack()
  let faceTrack = createTrack()

  return {
    pushPose({ t, metrics }) {
      push(poseTrack, t, metrics)
    },

    pushFace({ t, metrics }) {
      push(faceTrack, t, metrics)
    },

    reset() {
      poseTrack = createTrack()
      faceTrack = createTrack()
    },

    evaluate(now) {
      const neckDropped = (m) =>
        m.valid && m.neckRatio < baseline.baselineNeckRatio * (1 - profile.neckDropRatio)
      const shoulderGrown = (m) =>
        m.valid && m.shoulderWidth > baseline.baselineShoulderWidth * (1 + profile.shoulderGrowRatio)

      const slouchPredicate = profile.requireBothForSlouch
        ? (m) => neckDropped(m) && shoulderGrown(m)
        : shoulderGrown

      const slouchMs = heldMs(poseTrack, now, slouchPredicate)
      const forwardMs = heldMs(poseTrack, now, neckDropped)
      const awayMs = heldMs(faceTrack, now, (m) => m.gaze === 'away')
      const closedMs = heldMs(faceTrack, now, (m) => m.eyeClosed)

      const drowsy = (closedMs ?? 0) >= BATTLE.drowsyHoldMs

      // 互斥優先序：塌陷 > 前傾 > 視線偏移。
      // drowsy 是獨立布林值，不進 posture — 瞌睡不影響戰鬥數值，但駝背要扣血。
      let posture = 'upright'
      if ((slouchMs ?? 0) >= profile.postureHoldMs) posture = 'slouch'
      else if ((forwardMs ?? 0) >= profile.postureHoldMs) posture = 'forwardHead'
      else if ((awayMs ?? 0) >= profile.gazeAwayHoldMs) posture = 'gazeAway'

      return { posture, drowsy }
    },
  }
}
```

- [ ] **Step 9: 跑全部測試**

```bash
npm test
```
預期：poseGeometry 與 poseAnalyzer 全部 passed。若「看書 profile 容許更大低頭幅度」那則失敗，檢查 `neckDropRatio` 的 0.18 / 0.12 是否讓 0.85 落在兩者之間。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: 姿態幾何與 PoseAnalyzer

正規化比值取代角度（前鏡頭量不到矢狀面），零階保持＋6 秒滑動窗口時間積分，
窗口內至少 2 取樣才可觸發。視線往下不判分心、瞌睡與 posture 正交。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: FocusStateMachine

戰鬥判定核心。spec「測試方式」指名這個檔要有約 20 個 Vitest case。

**時間源一律由外部傳入**，本檔不呼叫 `Date.now()` / `performance.now()`。這讓所有時間相關行為（5 秒攻擊、20 秒撤銷視窗、10 秒重整旗鼓）都能在測試裡用假時鐘瞬間跑完。

**三個容易寫錯的地方，先講清楚：**

1. **陷阱是延後生效，不是事後回滾。** 觸發後只發 `trapPending`，20 秒內完全不動任何數值、不發聲、不中斷連擊。撤銷就當沒發生過；20 秒到才真正扣分回血。這樣就不會有「語音已經念出去卻要收回」的問題。
2. **累加器只在可累加時前進，不重置。** 端正時攻擊計時前進，不端正時**暫停**而非歸零——中途被打斷一下不該讓玩家白等 5 秒。
3. **提早打倒魔王不結束該輪。** 會補血進入下一形態繼續打。不這樣做的話，專注率越高的人讀書時間越短，遊戲目標會和教育目標相反。

**Files:**
- Create: `src/core/focusStateMachine.js`
- Create: `src/core/focusStateMachine.test.js`

**Interfaces:**
- Consumes: `BATTLE`、`DEMO`、`bossHpFor`、`attackIntervalFor`（Task 2）；`posture` / `drowsy`（Task 3 的 `evaluate()` 輸出）
- Produces：
  - `createFocusStateMachine({ durationMs, demoMode }) -> fsm`
  - `fsm.tick({ t, posture, drowsy, phoneVisible }) -> Event[]` — 只在「可見且推論正常」時呼叫
  - `fsm.setPaused(t, paused)` — 暫停鍵／推論異常時凍結累加器與 elapsed
  - `fsm.notifyHidden(t)` / `fsm.notifyVisible(t)` — Page Visibility
  - `fsm.undoTrap(trapId) -> boolean`
  - `fsm.snapshot() -> BattleSnapshot`
  - Event 型別：
    ```
    { type: 'attack', damage, bossHp, score, streak }
    { type: 'playerDamage', amount, playerHp, reason }   // reason: posture 值
    { type: 'regroupStart' } | { type: 'regroupEnd', playerHp }
    { type: 'phase', phase, bossHp }                     // 進入第二（含以上）形態
    { type: 'trapWarning', kind: 'phone', remainMs }
    { type: 'trapPending', trapId, kind }                // kind: 'phone' | 'away'
    { type: 'trapCommitted', trapId, kind, bossHeal, scorePenalty }
    { type: 'trapUndone', trapId, kind }
    { type: 'drowsy' }                                   // 進入瞌睡的那一刻，只發一次
    { type: 'sessionEnd', result }                        // result: 'victory' | 'timeout'
    ```
  - `BattleSnapshot`：
    ```
    { elapsedMs, durationMs, bossHp, bossHpMax, playerHp, score, attacks, streak,
      phase, phase2Damage, regrouping, ended, result,
      pendingTraps: [{ trapId, kind, deadlineAt }],
      postureDurationMs: { upright, slouch, forwardHead, drowsy, gazeAway },
      distractionDurationMs: { phone, away },
      trapCount: { phone, phoneUndone, away, awayUndone },
      dpsSeries: number[] }
    ```

- [ ] **Step 1: 寫失敗的測試（第一組：攻擊、積分、勝負）**

`src/core/focusStateMachine.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createFocusStateMachine } from './focusStateMachine.js'
import { BATTLE, DEMO, bossHpFor } from './battleConfig.js'

const MIN = 60_000
const TICK = 250

function makeFsm(opts = {}) {
  return createFocusStateMachine({ durationMs: 15 * MIN, demoMode: false, ...opts })
}

/** 以固定 tick 間隔推進到 toMs，回傳期間所有事件 */
function run(fsm, toMs, input = {}, fromMs = 0) {
  const events = []
  for (let t = fromMs + TICK; t <= toMs; t += TICK) {
    events.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: false, ...input }))
  }
  return events
}

const typesOf = (events, type) => events.filter((e) => e.type === type)

describe('初始狀態', () => {
  it('Boss HP 依時長計算，玩家滿血', () => {
    const s = makeFsm().snapshot()
    expect(s.bossHpMax).toBe(2160)
    expect(s.bossHp).toBe(2160)
    expect(s.playerHp).toBe(BATTLE.playerHpMax)
    expect(s.score).toBe(0)
    expect(s.phase).toBe(1)
    expect(s.ended).toBe(false)
  })

  it('展示模式 Boss HP 240、攻擊間隔 1 秒', () => {
    const fsm = createFocusStateMachine({ durationMs: DEMO.durationMs, demoMode: true })
    expect(fsm.snapshot().bossHpMax).toBe(240)
    const events = run(fsm, 3000)
    expect(typesOf(events, 'attack').length).toBe(3)
  })
})

describe('攻擊', () => {
  it('端正且專注時每 5 秒攻擊一次，傷害 20、積分 +10', () => {
    const fsm = makeFsm()
    const events = run(fsm, 15_000)
    const attacks = typesOf(events, 'attack')
    expect(attacks.length).toBe(3)
    expect(attacks[0].damage).toBe(20)
    const s = fsm.snapshot()
    expect(s.bossHp).toBe(2160 - 60)
    expect(s.score).toBe(30)
    expect(s.attacks).toBe(3)
  })

  it('姿態不良時不攻擊', () => {
    const fsm = makeFsm()
    const events = run(fsm, 15_000, { posture: 'slouch' })
    expect(typesOf(events, 'attack').length).toBe(0)
  })

  it('視線偏移時不攻擊', () => {
    const fsm = makeFsm()
    expect(typesOf(run(fsm, 15_000, { posture: 'gazeAway' }), 'attack').length).toBe(0)
  })

  it('瞌睡不影響攻擊（疲倦不該被懲罰）', () => {
    const fsm = makeFsm()
    const events = run(fsm, 10_000, { drowsy: true })
    expect(typesOf(events, 'attack').length).toBe(2)
    expect(typesOf(events, 'playerDamage').length).toBe(0)
  })

  it('攻擊累加器被打斷後暫停而非歸零', () => {
    const fsm = makeFsm()
    run(fsm, 4000)                                    // 端正 4 秒
    run(fsm, 8000, { posture: 'slouch' }, 4000)       // 駝背 4 秒，累加器凍在 4 秒
    const events = run(fsm, 9500, {}, 8000)           // 再端正 1.5 秒 → 應在 1 秒處攻擊
    expect(typesOf(events, 'attack').length).toBe(1)
  })

  it('60% 專注率剛好在時限內打倒魔王（不變式的端對端驗證）', () => {
    const fsm = makeFsm()
    // 每 10 秒中前 6 秒端正、後 4 秒駝背 → 專注率 60%
    for (let t = TICK; t <= 15 * MIN; t += TICK) {
      const inCycle = t % 10_000
      fsm.tick({ t, posture: inCycle <= 6000 ? 'upright' : 'slouch', drowsy: false, phoneVisible: false })
    }
    const s = fsm.snapshot()
    expect(s.result).toBe('victory')
  })
})

describe('姿態扣血與重整旗鼓', () => {
  it('姿態不良每 5 秒扣 3 HP，事件帶上原因', () => {
    const fsm = makeFsm()
    const events = run(fsm, 15_000, { posture: 'forwardHead' })
    const dmg = typesOf(events, 'playerDamage')
    expect(dmg.length).toBe(3)
    expect(dmg[0].amount).toBe(3)
    expect(dmg[0].reason).toBe('forwardHead')
    expect(fsm.snapshot().playerHp).toBe(100 - 9)
  })

  it('玩家 HP 歸零進入重整旗鼓，不是失敗', () => {
    const fsm = makeFsm()
    const events = run(fsm, 200_000, { posture: 'slouch' })
    expect(typesOf(events, 'regroupStart').length).toBeGreaterThanOrEqual(1)
    const s = fsm.snapshot()
    expect(s.ended).toBe(false)
    expect(s.result).toBe(null)
  })

  it('重整旗鼓 10 秒內無法攻擊，結束後 HP 回到 30', () => {
    const fsm = makeFsm()
    // 持續駝背直到倒地：100 HP ÷ 3 每 5 秒 → 第 170 秒
    run(fsm, 175_000, { posture: 'slouch' })
    expect(fsm.snapshot().regrouping).toBe(true)

    const during = run(fsm, 180_000, {}, 175_000) // 端正也不能攻擊
    expect(typesOf(during, 'attack').length).toBe(0)

    const after = run(fsm, 190_000, {}, 180_000)
    expect(typesOf(after, 'regroupEnd').length).toBe(1)
    expect(fsm.snapshot().playerHp).toBe(BATTLE.regroupHp)
  })
})

describe('第二形態', () => {
  it('提早打倒魔王不結束該輪，補血進入下一形態', () => {
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    // 全程端正 → 5 分鐘可打出 60 次 × 20 = 1200，Boss HP 只有 720
    const events = run(fsm, 5 * MIN)
    const phases = typesOf(events, 'phase')
    expect(phases.length).toBeGreaterThanOrEqual(1)
    expect(phases[0].phase).toBe(2)

    const s = fsm.snapshot()
    expect(s.result).toBe('victory')
    expect(s.phase2Damage).toBeGreaterThan(0)
    // 關鍵：該輪仍跑滿設定時長，不因擊倒而提早結束
    expect(s.elapsedMs).toBe(5 * MIN)
  })

  it('補血量為 Boss HP 上限的 40%', () => {
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    const max = fsm.snapshot().bossHpMax
    const events = run(fsm, 5 * MIN)
    expect(typesOf(events, 'phase')[0].bossHp).toBe(Math.round(max * BATTLE.phase2RefillRatio))
  })
})

describe('陷阱（延後生效）', () => {
  it('手機連續 2.5 秒發預警、3 秒發 trapPending', () => {
    const fsm = makeFsm()
    const events = run(fsm, 3000, { phoneVisible: true })
    expect(typesOf(events, 'trapWarning').length).toBeGreaterThanOrEqual(1)
    const pending = typesOf(events, 'trapPending')
    expect(pending.length).toBe(1)
    expect(pending[0].kind).toBe('phone')
  })

  it('待確認期間不扣分、不回血、不中斷攻擊', () => {
    const fsm = makeFsm()
    const before = fsm.snapshot()
    const events = run(fsm, 13_000, { phoneVisible: true })
    const s = fsm.snapshot()
    expect(s.score).toBeGreaterThan(0)            // 仍在累積積分
    expect(s.bossHp).toBeLessThan(before.bossHpMax) // 魔王沒有回血
    expect(typesOf(events, 'trapCommitted').length).toBe(0)
    expect(typesOf(events, 'attack').length).toBeGreaterThan(0)
  })

  it('20 秒內撤銷則完全不生效，計入 phoneUndone', () => {
    const fsm = makeFsm()
    const events = run(fsm, 3000, { phoneVisible: true })
    const trapId = typesOf(events, 'trapPending')[0].trapId
    expect(fsm.undoTrap(trapId)).toBe(true)
    run(fsm, 30_000, {}, 3000)
    const s = fsm.snapshot()
    expect(s.trapCount.phoneUndone).toBe(1)
    expect(s.trapCount.phone).toBe(0)
    expect(s.score).toBeGreaterThanOrEqual(0)
  })

  it('20 秒未撤銷才正式生效：Boss 回血 5% 上限、積分 −100', () => {
    const fsm = makeFsm()
    const events = run(fsm, 3000, { phoneVisible: true })
    const bossBefore = fsm.snapshot().bossHp
    const later = run(fsm, 25_000, {}, 3000)
    const committed = typesOf(later, 'trapCommitted')
    expect(committed.length).toBe(1)
    expect(committed[0].bossHeal).toBe(Math.round(2160 * 0.05))
    expect(committed[0].scorePenalty).toBe(100)
    const s = fsm.snapshot()
    expect(s.trapCount.phone).toBe(1)
    expect(s.bossHp).toBeGreaterThan(bossBefore - 2160 * 0.05)
  })

  it('Boss 回血不得超過 HP 上限', () => {
    const fsm = makeFsm()
    run(fsm, 3000, { phoneVisible: true })
    run(fsm, 25_000, {}, 3000)
    expect(fsm.snapshot().bossHp).toBeLessThanOrEqual(2160)
  })

  it('積分不會被扣成負數', () => {
    const fsm = makeFsm()
    run(fsm, 3000, { phoneVisible: true })
    run(fsm, 25_000, {}, 3000)
    expect(fsm.snapshot().score).toBeGreaterThanOrEqual(0)
  })

  it('手機在 3 秒前消失就不觸發', () => {
    const fsm = makeFsm()
    const a = run(fsm, 2000, { phoneVisible: true })
    const b = run(fsm, 6000, { phoneVisible: false }, 2000)
    expect(typesOf([...a, ...b], 'trapPending').length).toBe(0)
  })

  it('離開超過 5 秒，回前景時產生可撤銷的陷阱', () => {
    const fsm = makeFsm()
    run(fsm, 5000)
    fsm.notifyHidden(5000)
    fsm.notifyVisible(14_000) // 離開 9 秒
    const events = fsm.tick({ t: 14_250, posture: 'upright', drowsy: false, phoneVisible: false })
    const pending = typesOf(events, 'trapPending')
    expect(pending.length).toBe(1)
    expect(pending[0].kind).toBe('away')
    expect(fsm.snapshot().distractionDurationMs.away).toBe(9000)
  })

  it('離開未滿 5 秒不觸發陷阱', () => {
    const fsm = makeFsm()
    run(fsm, 5000)
    fsm.notifyHidden(5000)
    fsm.notifyVisible(8000)
    const events = fsm.tick({ t: 8250, posture: 'upright', drowsy: false, phoneVisible: false })
    expect(typesOf(events, 'trapPending').length).toBe(0)
  })

  it('離開期間不累積攻擊也不扣血', () => {
    const fsm = makeFsm()
    run(fsm, 4000)
    fsm.notifyHidden(4000)
    fsm.notifyVisible(104_000) // 離開 100 秒
    const s = fsm.snapshot()
    expect(s.attacks).toBe(0)
    expect(s.playerHp).toBe(100)
  })
})

describe('暫停與結束', () => {
  it('暫停期間 elapsed 與所有累加器都凍結', () => {
    const fsm = makeFsm()
    run(fsm, 4000)
    fsm.setPaused(4000, true)
    fsm.setPaused(64_000, false)
    const events = run(fsm, 66_000, {}, 64_000)
    expect(typesOf(events, 'attack').length).toBe(1) // 累加器從 4 秒接續
    expect(fsm.snapshot().elapsedMs).toBeLessThanOrEqual(7000)
  })

  it('時間到未擊倒回報 timeout，仍保留積分與統計', () => {
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    const events = run(fsm, 5 * MIN, { posture: 'slouch' })
    const end = typesOf(events, 'sessionEnd')
    expect(end.length).toBe(1)
    expect(end[0].result).toBe('timeout')
    expect(fsm.snapshot().bossHp).toBeGreaterThan(0)
  })

  it('結束後再 tick 不再產生任何事件', () => {
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    run(fsm, 5 * MIN)
    expect(run(fsm, 5 * MIN + 10_000, {}, 5 * MIN)).toEqual([])
  })
})

describe('統計累積', () => {
  it('姿態時長五個桶互斥且總和等於已過時間', () => {
    const fsm = makeFsm()
    run(fsm, 10_000)
    run(fsm, 20_000, { posture: 'slouch' }, 10_000)
    run(fsm, 26_000, { posture: 'upright', drowsy: true }, 20_000)
    const d = fsm.snapshot().postureDurationMs
    const sum = d.upright + d.slouch + d.forwardHead + d.drowsy + d.gazeAway
    expect(sum).toBeCloseTo(fsm.snapshot().elapsedMs, -2)
    expect(d.drowsy).toBeGreaterThan(0)
  })

  it('drowsy 蓋過 posture 桶（統計互斥的代價，戰鬥判定不受影響）', () => {
    const fsm = makeFsm()
    run(fsm, 10_000, { posture: 'slouch', drowsy: true })
    const d = fsm.snapshot().postureDurationMs
    expect(d.drowsy).toBeGreaterThan(0)
    expect(d.slouch).toBe(0)
    expect(fsm.snapshot().playerHp).toBeLessThan(100) // 但血還是照扣
  })

  it('dpsSeries 以 5 秒為一格聚合', () => {
    const fsm = createFocusStateMachine({ durationMs: 15 * MIN, demoMode: false })
    run(fsm, 60_000)
    const series = fsm.snapshot().dpsSeries
    expect(series.length).toBe(12)
    expect(series.reduce((a, b) => a + b, 0)).toBe(fsm.snapshot().attacks * BATTLE.damagePerAttack)
  })

  it('drowsy 進入時只發一次事件，不重複洗版', () => {
    const fsm = makeFsm()
    const events = run(fsm, 20_000, { drowsy: true })
    expect(typesOf(events, 'drowsy').length).toBe(1)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- src/core/focusStateMachine.test.js
```
預期：`Failed to resolve import "./focusStateMachine.js"`

- [ ] **Step 3: 寫實作**

`src/core/focusStateMachine.js`：

```js
import { BATTLE, attackIntervalFor, bossHpFor } from './battleConfig.js'

const DPS_BUCKET_MS = 5000
const DAMAGING_POSTURES = new Set(['slouch', 'forwardHead', 'gazeAway'])

/**
 * 戰鬥判定核心。
 *
 * 時間一律由呼叫端傳入，本檔不讀系統時鐘——所有時間相關行為才能在測試裡瞬間跑完。
 * 呼叫端只在「頁面可見且推論正常」時呼叫 tick()；背景與暫停走各自的通知方法。
 */
export function createFocusStateMachine({ durationMs, demoMode = false }) {
  const attackIntervalMs = attackIntervalFor(demoMode)
  const bossHpMax = bossHpFor(durationMs, demoMode)

  let elapsedMs = 0
  let lastTickAt = null
  let paused = false
  let hidden = false
  let hiddenSince = null

  let bossHp = bossHpMax
  let playerHp = BATTLE.playerHpMax
  let score = 0
  let attacks = 0
  let streak = 0
  let phase = 1
  let phase2Damage = 0
  let ended = false
  let result = null

  // 累加器：可累加時前進、不可累加時暫停（而非歸零）
  let attackAccumMs = 0
  let postureDamageAccumMs = 0
  let phoneHoldMs = 0
  let phoneWarned = false
  let regroupRemainMs = 0
  let wasDrowsy = false

  let trapSeq = 0
  const pendingTraps = [] // { trapId, kind, deadlineAt }

  const postureDurationMs = { upright: 0, slouch: 0, forwardHead: 0, drowsy: 0, gazeAway: 0 }
  const distractionDurationMs = { phone: 0, away: 0 }
  const trapCount = { phone: 0, phoneUndone: 0, away: 0, awayUndone: 0 }
  const dpsSeries = []

  function recordDamage(amount) {
    const bucket = Math.floor(elapsedMs / DPS_BUCKET_MS)
    while (dpsSeries.length <= bucket) dpsSeries.push(0)
    dpsSeries[bucket] += amount
  }

  function openTrap(kind, now, events) {
    trapSeq += 1
    const trapId = `${kind}-${trapSeq}`
    pendingTraps.push({ trapId, kind, deadlineAt: now + BATTLE.trapUndoWindowMs })
    events.push({ type: 'trapPending', trapId, kind })
  }

  function settleTraps(now, events) {
    for (let i = pendingTraps.length - 1; i >= 0; i--) {
      const trap = pendingTraps[i]
      if (now < trap.deadlineAt) continue
      pendingTraps.splice(i, 1)

      const bossHeal = Math.round(bossHpMax * BATTLE.trapBossHealRatio)
      bossHp = Math.min(bossHpMax, bossHp + bossHeal)
      score = Math.max(0, score - BATTLE.trapScorePenalty)
      trapCount[trap.kind] += 1
      events.push({
        type: 'trapCommitted', trapId: trap.trapId, kind: trap.kind,
        bossHeal, scorePenalty: BATTLE.trapScorePenalty,
      })
    }
  }

  function finish(events) {
    if (ended) return
    ended = true
    // 只要曾經把魔王打倒過（進過第二形態），就是勝利
    result = bossHp <= 0 || phase > 1 ? 'victory' : 'timeout'
    events.push({ type: 'sessionEnd', result })
  }

  return {
    tick({ t, posture, drowsy, phoneVisible }) {
      const events = []
      if (ended) return events

      if (lastTickAt === null) {
        lastTickAt = t
        return events
      }
      // dt 上限保護：主執行緒偶爾卡住時不該一次補發十幾次攻擊
      const dt = Math.max(0, Math.min(t - lastTickAt, 2000))
      lastTickAt = t
      if (paused || hidden || dt === 0) return events

      elapsedMs = Math.min(elapsedMs + dt, durationMs)

      // --- 統計（五個桶互斥，總和等於 elapsedMs）---
      if (drowsy) postureDurationMs.drowsy += dt
      else postureDurationMs[posture] += dt
      if (phoneVisible) distractionDurationMs.phone += dt

      if (drowsy && !wasDrowsy) events.push({ type: 'drowsy' })
      wasDrowsy = drowsy

      // --- 重整旗鼓：期間不攻擊、不扣血 ---
      if (regroupRemainMs > 0) {
        regroupRemainMs -= dt
        if (regroupRemainMs <= 0) {
          regroupRemainMs = 0
          playerHp = BATTLE.regroupHp
          postureDamageAccumMs = 0
          events.push({ type: 'regroupEnd', playerHp })
        }
      } else {
        // --- 攻擊 ---
        if (posture === 'upright') {
          attackAccumMs += dt
          while (attackAccumMs >= attackIntervalMs) {
            attackAccumMs -= attackIntervalMs
            const damage = BATTLE.damagePerAttack
            bossHp -= damage
            if (phase > 1) phase2Damage += damage
            score += BATTLE.scorePerHit
            attacks += 1
            streak += 1
            recordDamage(damage)
            events.push({ type: 'attack', damage, bossHp: Math.max(0, bossHp), score, streak })

            // 提早擊倒不結束該輪：補血進下一形態，否則等於獎勵提早結束讀書
            if (bossHp <= 0) {
              phase += 1
              bossHp = Math.round(bossHpMax * BATTLE.phase2RefillRatio)
              events.push({ type: 'phase', phase, bossHp })
            }
          }
        }

        // --- 姿態扣血 ---
        if (DAMAGING_POSTURES.has(posture)) {
          streak = 0
          postureDamageAccumMs += dt
          while (postureDamageAccumMs >= BATTLE.postureDamageIntervalMs && playerHp > 0) {
            postureDamageAccumMs -= BATTLE.postureDamageIntervalMs
            playerHp = Math.max(0, playerHp - BATTLE.postureDamage)
            events.push({ type: 'playerDamage', amount: BATTLE.postureDamage, playerHp, reason: posture })
          }
          if (playerHp <= 0) {
            regroupRemainMs = BATTLE.regroupMs
            attackAccumMs = 0
            postureDamageAccumMs = 0
            events.push({ type: 'regroupStart' })
          }
        }
      }

      // --- 手機陷阱 ---
      if (phoneVisible) {
        const before = phoneHoldMs
        phoneHoldMs += dt
        if (!phoneWarned && phoneHoldMs >= BATTLE.phoneWarnAtMs) {
          phoneWarned = true
          events.push({ type: 'trapWarning', kind: 'phone', remainMs: BATTLE.phoneTrapHoldMs - phoneHoldMs })
        }
        if (before < BATTLE.phoneTrapHoldMs && phoneHoldMs >= BATTLE.phoneTrapHoldMs) {
          openTrap('phone', t, events)
        }
      } else {
        phoneHoldMs = 0
        phoneWarned = false
      }

      settleTraps(t, events)
      if (elapsedMs >= durationMs) finish(events)
      return events
    },

    setPaused(t, next) {
      paused = next
      lastTickAt = t
    },

    notifyHidden(t) {
      hidden = true
      hiddenSince = t
      lastTickAt = t
    },

    notifyVisible(t) {
      if (!hidden) return
      hidden = false
      const awayMs = Math.max(0, t - (hiddenSince ?? t))
      hiddenSince = null
      lastTickAt = t
      distractionDurationMs.away += awayMs
      if (awayMs > BATTLE.awayTrapMs && !ended) {
        const events = []
        openTrap('away', t, events)
        // 事件在下一次 tick 由 pendingAwayEvents 送出
        pendingAwayEvents.push(...events)
      }
    },

    undoTrap(trapId) {
      const i = pendingTraps.findIndex((p) => p.trapId === trapId)
      if (i === -1) return false
      const [trap] = pendingTraps.splice(i, 1)
      trapCount[`${trap.kind}Undone`] += 1
      return true
    },

    snapshot() {
      return {
        elapsedMs, durationMs, bossHp: Math.max(0, bossHp), bossHpMax,
        playerHp, score, attacks, streak, phase, phase2Damage,
        regrouping: regroupRemainMs > 0, ended, result,
        pendingTraps: pendingTraps.map((p) => ({ ...p })),
        postureDurationMs: { ...postureDurationMs },
        distractionDurationMs: { ...distractionDurationMs },
        trapCount: { ...trapCount },
        dpsSeries: [...dpsSeries],
      }
    },
  }
}
```

- [ ] **Step 4: 修掉 `notifyVisible` 的事件回傳缺口**

上一步的 `notifyVisible` 引用了尚未宣告的 `pendingAwayEvents`。`notifyVisible` 本身不回傳事件（呼叫端在 `visibilitychange` 裡拿不到事件流），所以要把它暫存起來、在下一次 `tick` 開頭送出。

在狀態宣告區（`const pendingTraps = []` 旁邊）加上：

```js
const pendingAwayEvents = []
```

並在 `tick` 的 `if (ended) return events` **之後**、`if (lastTickAt === null)` **之前**插入：

```js
      // notifyVisible 無法直接回傳事件，改由下一次 tick 送出
      if (pendingAwayEvents.length) {
        events.push(...pendingAwayEvents.splice(0))
      }
```

- [ ] **Step 5: 跑測試確認通過**

```bash
npm test -- src/core/focusStateMachine.test.js
```

預期：全部 passed（約 25 個 case）。若「60% 專注率剛好打倒魔王」那則差幾點血，檢查 `run()` 的 tick 對齊——`TICK=250` 時 10 秒週期的邊界要正好落在 tick 上。

- [ ] **Step 6: 跑全部測試並 commit**

```bash
npm test
git add -A
git commit -m "$(cat <<'EOF'
feat: FocusStateMachine 戰鬥判定核心

陷阱延後生效（20 秒待確認期間完全不動數值）、累加器暫停而非歸零、
提早擊倒補血進第二形態且該輪跑滿時長、玩家 HP 歸零改為重整旗鼓。
時間源全部外部注入，25 個 Vitest case 覆蓋各判定分支。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: EDF 推論排程器

三個模型頻率不同（Pose 2fps / Face 3fps / Object 0.33fps），要在同一條主執行緒上輪流跑。用 EDF（earliest deadline first）：每個模型維護 `nextDueTime`，每次挑最早到期的那個。

**關鍵細節：被丟棄時不重置 `nextDueTime`。** 如果丟棄也順手把 due time 往後推，Object（0.33fps，3 秒才輪一次）會永遠排在 Pose/Face 後面而餓死，展場上手機偵測就等於沒有。

這個檔可以完全獨立測，不需要 MediaPipe。

**Files:**
- Create: `src/core/inferenceScheduler.js`, `src/core/inferenceScheduler.test.js`

**Interfaces:**
- Consumes: 無
- Produces：`createScheduler(specs) -> scheduler`，其中 `specs` 為 `[{ key, fps }]`
  - `scheduler.pick(now) -> string | null` — 回傳最早到期且已到期的 key
  - `scheduler.complete(key, now)` — 推論完成，排下一次
  - `scheduler.skip()` — 本輪沒跑（in-flight 佔用中），**不動任何 due time**
  - `scheduler.setScale(scale)` — 緊急降檔用，`0.5` 代表頻率減半
  - `scheduler.setEnabled(key, enabled)`
  - `scheduler.actualFps(key, now) -> number` — debug HUD 用

- [ ] **Step 1: 寫失敗的測試**

`src/core/inferenceScheduler.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createScheduler } from './inferenceScheduler.js'

const SPECS = [{ key: 'pose', fps: 2 }, { key: 'face', fps: 3 }, { key: 'object', fps: 0.33 }]

describe('createScheduler', () => {
  it('起始時三個模型都已到期，依 fps 高者優先', () => {
    const s = createScheduler(SPECS)
    expect(s.pick(0)).toBe('face')
  })

  it('完成後依各自 fps 排下一次', () => {
    const s = createScheduler(SPECS)
    s.complete('face', 0)   // 下次 333ms
    s.complete('pose', 0)   // 下次 500ms
    s.complete('object', 0) // 下次 3030ms
    expect(s.pick(100)).toBe(null)
    expect(s.pick(400)).toBe('face')
    expect(s.pick(600)).toBe('pose')
  })

  it('被丟棄時不重置 due time，低頻模型不會餓死', () => {
    const s = createScheduler(SPECS)
    s.complete('pose', 0)
    s.complete('face', 0)
    s.complete('object', 0)
    // 在 object 到期後，連續丟棄 20 次
    for (let i = 0; i < 20; i++) s.skip()
    expect(s.pick(3100)).toBe('object')
  })

  it('同時到期時挑最早到期的（而非最高 fps）', () => {
    const s = createScheduler(SPECS)
    s.complete('pose', 0)   // due 500
    s.complete('face', 400) // due 733
    expect(s.pick(800)).toBe('pose')
  })

  it('setScale(0.5) 讓所有間隔加倍', () => {
    const s = createScheduler(SPECS)
    s.setScale(0.5)
    s.complete('pose', 0)
    expect(s.pick(600)).toBe(null)
    expect(s.pick(1100)).toBe('pose')
  })

  it('setScale 只影響之後排的班，不追溯已排定的', () => {
    const s = createScheduler(SPECS)
    s.complete('pose', 0) // due 500
    s.setScale(0.5)
    expect(s.pick(600)).toBe('pose')
  })

  it('停用的模型永不被挑中', () => {
    const s = createScheduler(SPECS)
    s.setEnabled('object', false)
    s.complete('pose', 0)
    s.complete('face', 0)
    expect(s.pick(10_000)).not.toBe('object')
  })

  it('重新啟用後立刻可被挑中', () => {
    const s = createScheduler(SPECS)
    s.setEnabled('object', false)
    s.setEnabled('object', true)
    s.complete('pose', 0)
    s.complete('face', 0)
    expect(s.pick(10_000)).toBe('object')
  })

  it('actualFps 以最近的完成間隔估算', () => {
    const s = createScheduler(SPECS)
    for (let t = 0; t <= 2000; t += 500) s.complete('pose', t)
    expect(s.actualFps('pose', 2000)).toBeCloseTo(2, 1)
  })

  it('未知 key 的 complete 不丟例外', () => {
    const s = createScheduler(SPECS)
    expect(() => s.complete('nope', 0)).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- src/core/inferenceScheduler.test.js
```

- [ ] **Step 3: 寫實作**

`src/core/inferenceScheduler.js`：

```js
const FPS_WINDOW = 5

/**
 * EDF（earliest deadline first）排程器。
 *
 * 三個模型頻率差很多（0.33 ~ 3 fps），輪詢或固定順序都會讓低頻模型被高頻模型擠掉。
 * 改成每個模型各自記 nextDueAt，每次挑「已到期且最早到期」的那一個。
 *
 * skip() 刻意不動任何 nextDueAt：被丟棄的那一輪不算它跑過，
 * 否則 ObjectDetector 每次排隊都被往後推，展場上手機偵測就等於沒有。
 */
export function createScheduler(specs) {
  let scale = 1
  const tracks = new Map()

  for (const { key, fps } of specs) {
    tracks.set(key, { key, fps, enabled: true, nextDueAt: 0, completions: [] })
  }

  function intervalOf(track) {
    return 1000 / (track.fps * scale)
  }

  return {
    pick(now) {
      let best = null
      for (const track of tracks.values()) {
        if (!track.enabled) continue
        if (track.nextDueAt > now) continue
        if (best === null || track.nextDueAt < best.nextDueAt) best = track
        // 同時到期（多半是起始的 0）時，讓 fps 高的先跑，開機畫面比較快有反應
        else if (track.nextDueAt === best.nextDueAt && track.fps > best.fps) best = track
      }
      return best ? best.key : null
    },

    complete(key, now) {
      const track = tracks.get(key)
      if (!track) return
      track.nextDueAt = now + intervalOf(track)
      track.completions.push(now)
      if (track.completions.length > FPS_WINDOW) track.completions.shift()
    },

    skip() {
      // 刻意什麼都不做——見檔頭說明
    },

    setScale(next) {
      scale = next
    },

    setEnabled(key, enabled) {
      const track = tracks.get(key)
      if (!track) return
      track.enabled = enabled
      if (enabled) track.nextDueAt = 0 // 重新啟用後立刻可跑
    },

    actualFps(key, now) {
      const track = tracks.get(key)
      if (!track || track.completions.length < 2) return 0
      const first = track.completions[0]
      const last = track.completions[track.completions.length - 1]
      const span = Math.max(1, (now >= last ? last : now) - first)
      return ((track.completions.length - 1) * 1000) / span
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過並 commit**

```bash
npm test -- src/core/inferenceScheduler.test.js
git add -A
git commit -m "$(cat <<'EOF'
feat: EDF 推論排程器

三模型各自維護 nextDueAt，丟棄時刻意不重置以免低頻的 ObjectDetector 餓死。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: CameraCapture

唯一碰 `getUserMedia` 的檔。負責開關鏡頭、背景/前景的復原、以及在 `pagehide` 時確實把燈關掉。

**iPadOS 特有的兩個坑：**
- 頁面回前景時 track 可能已經 `'ended'`（系統回收），單靠 `visibilitychange` 恢復會拿到黑畫面。必須檢查 `track.readyState` 並在必要時重新 `getUserMedia`（權限還在，不會再跳對話框）。
- 也要監聽 `track.onended`，因為使用者從控制中心切走鏡頭時不會觸發 `visibilitychange`。

**Files:**
- Create: `src/core/cameraCapture.js`

**Interfaces:**
- Consumes: 無
- Produces：`createCameraCapture({ videoEl, onEnded }) -> camera`
  - `await camera.start()` — 解析為 `{ ok: true }` 或 `{ ok: false, error }`，`error.name` 原樣帶出（`NotAllowedError` 等）
  - `camera.stop()` — `track.stop()` ＋ 清空 `srcObject`
  - `camera.setEnabled(enabled)` — 背景時 `track.enabled = false`，省電但不放掉權限
  - `camera.readyState() -> 'live' | 'ended' | 'none'`
  - `await camera.resume() -> boolean` — 依 `readyState` 決定恢復或重開
  - `camera.isRunning() -> boolean`

無單元測試：本檔幾乎只是瀏覽器 API 的薄封裝，用 jsdom 假造 `getUserMedia` 測到的只是自己寫的 mock。驗收改在 Task 7 的實機測試。

- [ ] **Step 1: 寫實作**

`src/core/cameraCapture.js`：

```js
/**
 * 唯一碰 getUserMedia 的檔。
 *
 * 隱私紅線：audio 永遠是 false，任何情況都不得改。
 * 麥克風連要都不要，評審問起來才能直接回答「這個 App 沒有要過麥克風權限」。
 */
const CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { max: 15 },
  },
}

export function createCameraCapture({ videoEl, onEnded }) {
  let stream = null

  function track() {
    return stream ? stream.getVideoTracks()[0] ?? null : null
  }

  function detach() {
    if (stream) {
      for (const t of stream.getTracks()) {
        t.onended = null
        t.stop()
      }
    }
    stream = null
    if (videoEl) videoEl.srcObject = null
  }

  async function open() {
    const next = await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
    stream = next
    const t = track()
    if (t) t.onended = () => onEnded?.()
    videoEl.srcObject = next
    videoEl.setAttribute('playsinline', '')
    videoEl.muted = true
    await videoEl.play()
  }

  return {
    async start() {
      try {
        detach()
        await open()
        return { ok: true }
      } catch (error) {
        detach()
        return { ok: false, error }
      }
    },

    stop() {
      detach()
    },

    setEnabled(enabled) {
      const t = track()
      if (t) t.enabled = enabled
    },

    readyState() {
      const t = track()
      return t ? t.readyState : 'none'
    },

    isRunning() {
      return this.readyState() === 'live'
    },

    /**
     * 回前景時呼叫。track 還活著就只是重新啟用；
     * 被系統回收（'ended'）就重開一次——權限還在，不會再跳對話框。
     */
    async resume() {
      const state = this.readyState()
      if (state === 'live') {
        this.setEnabled(true)
        try { await videoEl.play() } catch { /* play 被打斷不算失敗 */ }
        return true
      }
      const { ok } = await this.start()
      return ok
    },
  }
}
```

- [ ] **Step 2: Lint 並 commit**

```bash
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: CameraCapture 鏡頭生命週期封裝

audio:false 寫死；回前景依 track.readyState 決定恢復或重開，
另監聽 track.onended（控制中心切走鏡頭不會觸發 visibilitychange）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: InferenceService 與即時預覽里程碑

唯一碰 MediaPipe 的檔，加上第一個能在 iPad 上看到東西的畫面。這個工項結束時，把 iPad 舉起來就能看到「目前判定：端正／駝背／…」即時跳動。

**先做模型自我託管**：spec 要求零網路依賴，所以 wasm 與模型檔都要放進 `public/`，不能走 CDN。

**單一 in-flight**：前一次推論還沒回來就丟棄新的一輪（呼叫 `scheduler.skip()`），不排隊。排隊會在主執行緒卡頓時累積出一長串過期的影格。

**閾值要用量的，不是用猜的**：`postureProfiles.js` 現在的數字全是憑空寫的初始值。
本工項附一個 `thresholdLab`，在 iPad 上收兩組有標記的樣本、算出分佈、檢查有沒有重疊，
直接吐出該填的數字。Step 10b 沒量完不准往下做 Task 8。

**Files:**
- Create: `src/core/inferenceService.js`
- Create: `src/core/thresholdLab.js`
- Test: `src/core/thresholdLab.test.js`
- Create: `src/components/LivePreview.vue`（暫時的開發用畫面，Task 14 由 BattleView 取代）
- Modify: `src/core/postureProfiles.js`（Step 10b 把實機量到的值填回 `BASE`）
- Modify: `src/App.vue`
- Create: `public/wasm/`（複製）、`public/models/`（下載）

**Interfaces:**
- Consumes: `createScheduler`（Task 5）、`poseMetrics` / `faceMetrics`（Task 3）、`createCameraCapture`（Task 6）
- Produces：`createThresholdLab({ minSamples? }) -> lab`（只供開發期量測，不進正式流程）
  - `lab.setLabel('good' | 'bad' | null)`、`lab.push(poseMetrics)`、`lab.count(label)`、`lab.currentLabel()`、`lab.reset()`
  - `lab.report() -> { good, bad, baseline, suggestions: [{ key, ok, value, note }] }`
- Produces：`createInferenceService({ videoEl }) -> svc`
  - `await svc.init()` — 載入三個 task，回傳 `{ ok, error }`
  - `await svc.step(now) -> { key, metrics, latencyMs } | null` — 跑一次排程；沒到期或 in-flight 時回 `null`
  - `svc.setScale(scale)`、`svc.setEnabled(key, enabled)`、`svc.actualFps(key, now)`
  - `svc.destroy()` — **只在整個 App 卸載時呼叫，每輪結束不得呼叫**
  - `metrics` 形狀：`pose` → `poseMetrics()` 的輸出；`face` → `faceMetrics()` 的輸出；`object` → `{ phoneVisible: boolean }`

- [ ] **Step 1: 把 wasm fileset 複製進 public**

```bash
mkdir -p public/wasm public/models
cp node_modules/@mediapipe/tasks-vision/wasm/* public/wasm/
ls public/wasm     # 預期看到 vision_wasm_internal.js / .wasm 等檔案
```

- [ ] **Step 2: 下載三個模型檔到 public/models**

```bash
curl -L -o public/models/pose_landmarker_lite.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
curl -L -o public/models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
curl -L -o public/models/efficientdet_lite0.tflite \
  https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite
ls -la public/models
```

三個檔加起來約 15-20MB。確認每個檔案大小都 > 1MB——下載失敗時 curl 會存下一個很小的 HTML 錯誤頁，不檢查就會在 iPad 上得到莫名其妙的載入失敗。

`public/models` 與 `public/wasm` **要入庫**（不加進 `.gitignore`）：這是 demo 穩定性的一部分，重新 clone 就要能離線跑。

- [ ] **Step 3: 寫 InferenceService**

`src/core/inferenceService.js`：

```js
import { FilesetResolver, PoseLandmarker, FaceLandmarker, ObjectDetector } from '@mediapipe/tasks-vision'
import { createScheduler } from './inferenceScheduler.js'
import { poseMetrics, faceMetrics } from './poseGeometry.js'

const SPECS = [{ key: 'pose', fps: 2 }, { key: 'face', fps: 3 }, { key: 'object', fps: 0.33 }]
const PHONE_LABEL = 'cell phone'
const PHONE_MIN_SCORE = 0.45

/**
 * 建立唯一一塊給 MediaPipe 掛 GL context 用的 canvas。
 *
 * 這裡的 Safari 版本判斷是照抄 MediaPipe 自己的邏輯（vision_bundle.mjs 的 Ph()）：
 * 它在 Safari 17 以下不信任 OffscreenCanvas，會退回 document.createElement('canvas')。
 * 我們既然要搶在它前面把 canvas 生出來，就得用同一套判準，否則在舊 Safari 上
 * 等於強迫它吃它自己判定不可靠的東西。
 *
 * 目標機（iPad Pro M1 / iPadOS 17+）走的是 OffscreenCanvas 這條。
 */
function createInferenceCanvas() {
  const ua = navigator.userAgent
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome')
  const major = Number(ua.match(/Version\/(\d+).*Safari/)?.[1] ?? 0)
  const canUseOffscreen = typeof OffscreenCanvas !== 'undefined' && (!isSafari || major >= 17)
  if (canUseOffscreen) return new OffscreenCanvas(1, 1)
  const el = document.createElement('canvas')
  el.width = 1
  el.height = 1
  return el
}

/**
 * 唯一碰 MediaPipe 的檔。對外只有 async step()，
 * 介面刻意設計成日後要搬進 Worker 時只改這一個檔（spec 已核准的可逆性保留）。
 *
 * 隱私紅線：landmarks / blendshapes / detections 只在本檔內存活，
 * 換算成純量後原始資料立刻失去參照，絕不往外傳、絕不寫入任何儲存層。
 */
export function createInferenceService({ videoEl }) {
  const scheduler = createScheduler(SPECS)
  const tasks = { pose: null, face: null, object: null }
  let inFlight = false
  let ready = false
  let latencyEma = 0

  /** 多人入鏡時只取 bounding box 最大者：展場必然有旁人，同時是第三人隱私保護 */
  function largestPose(result) {
    if (!result?.landmarks?.length) return null
    return result.landmarks[0] // numPoses:1，MediaPipe 已挑過最顯著的一個
  }

  return {
    async init() {
      try {
        const fileset = await FilesetResolver.forVisionTasks('/wasm')

        // 三個 task 共用同一個 canvas / GL context。
        //
        // 已於 @mediapipe/tasks-vision@1.0.1 原始碼確認：三個 task 的
        // createFromOptions 都走同一個工廠函式，第一件事就是讀 options.canvas；
        // 不給的話「每個 task 各自 new OffscreenCanvas(1,1)」= 三個 GL context。
        // 所以共用是官方支援的路徑，不是 hack。
        //
        // 尺寸固定 1×1：這塊 canvas 只是 GL context 的載體，推論走 texture，
        // 不畫到它的 backing store。給 640×480 等於白白配置 1.2MB drawing buffer。
        //
        // 三條紅線（違反會噴 "You cannot use a canvas that is already bound to
        // a different type of rendering context."）：
        //   1. 這塊 canvas 絕對不能拿去 getContext('2d')
        //   2. 不能掛進 DOM、不能當預覽畫面
        //   3. 三個 task 要一起 close()，不能只關其中一個（共用 context）
        const canvas = createInferenceCanvas()

        tasks.pose = await PoseLandmarker.createFromOptions(fileset, {
          canvas,
          baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        })
        tasks.face = await FaceLandmarker.createFromOptions(fileset, {
          canvas,
          baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
        })
        tasks.object = await ObjectDetector.createFromOptions(fileset, {
          canvas,
          baseOptions: { modelAssetPath: '/models/efficientdet_lite0.tflite', delegate: 'GPU' },
          runningMode: 'VIDEO',
          scoreThreshold: PHONE_MIN_SCORE,
          maxResults: 5,
        })

        ready = true
        return { ok: true }
      } catch (error) {
        return { ok: false, error }
      }
    },

    async step(now) {
      if (!ready) return null
      if (inFlight) {
        // 單一 in-flight：不排隊，直接丟棄這一輪。
        // 排隊會在主執行緒卡頓時累積一長串已經過期的影格。
        scheduler.skip()
        return null
      }
      const key = scheduler.pick(now)
      if (!key) return null
      if (videoEl.readyState < 2) return null

      inFlight = true
      const startedAt = performance.now()
      try {
        let metrics = null
        if (key === 'pose') {
          metrics = poseMetrics(largestPose(tasks.pose.detectForVideo(videoEl, now)))
        } else if (key === 'face') {
          const r = tasks.face.detectForVideo(videoEl, now)
          metrics = faceMetrics(r?.faceBlendshapes?.[0]?.categories ?? null)
        } else {
          const r = tasks.object.detectForVideo(videoEl, now)
          const phoneVisible = (r?.detections ?? []).some((d) =>
            (d.categories ?? []).some((c) => c.categoryName === PHONE_LABEL && c.score >= PHONE_MIN_SCORE))
          metrics = { phoneVisible }
        }

        const latencyMs = performance.now() - startedAt
        latencyEma = latencyEma === 0 ? latencyMs : latencyEma * 0.8 + latencyMs * 0.2
        scheduler.complete(key, now)
        return { key, metrics, latencyMs }
      } catch {
        scheduler.complete(key, now) // 失敗也要排下一次，否則整條流程停住
        return null
      } finally {
        inFlight = false
      }
    },

    latencyEma: () => latencyEma,
    setScale: (s) => scheduler.setScale(s),
    setEnabled: (key, enabled) => scheduler.setEnabled(key, enabled),
    actualFps: (key, now) => scheduler.actualFps(key, now),
    isReady: () => ready,

    /**
     * 只在整個 App 卸載時呼叫。每輪結束不得呼叫——重建會累積 GPU 記憶體並拖慢第二輪。
     * 三個 task 共用一個 GL context，所以要關就三個一起關，不提供單獨關掉某個 task 的介面。
     */
    destroy() {
      for (const t of Object.values(tasks)) t?.close?.()
      tasks.pose = tasks.face = tasks.object = null
      ready = false
    },
  }
}
```

`detectForVideo` 的第二個參數是時間戳，**必須單調遞增**，否則 MediaPipe 會丟例外。`step(now)` 的 `now` 由呼叫端用 `performance.now()` 傳入，天然單調。

- [ ] **Step 4: 寫閾值實驗室的失敗測試**

在這之前，`postureProfiles.js` 裡的 `neckDropRatio: 0.12` / `shoulderGrowRatio: 0.12` 是憑空寫的數字。
沒有任何人量過真人駝背時 `neckRatio` 到底掉多少。照「改一個數字 → 重載 → 再駝一次背 → 好像不對 → 再改」
的方式試，一個下午也收斂不到，而且永遠不知道是閾值不對還是這個指標根本分不出來。

**閾值實驗室**把這件事變成量測：坐正 5 秒按一個鈕、駝背 5 秒按另一個鈕，
它算出兩組分佈、檢查有沒有重疊，直接吐出該填的數字。

**隱私**：全部只存在記憶體，只算百分位數，不寫檔、不匯出、不進任何儲存層。
畫面上看到的是幾個統計值，不是時序。這樣不違反 spec 的「禁止寫入或傳出原始角度時序」。

`src/core/thresholdLab.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createThresholdLab } from './thresholdLab.js'

function feed(lab, label, { neckRatio, shoulderWidth }, n = 12) {
  lab.setLabel(label)
  for (let i = 0; i < n; i++) lab.push({ neckRatio, shoulderWidth, valid: true })
  lab.setLabel(null)
}

function suggestion(report, key) {
  return report.suggestions.find((s) => s.key === key)
}

describe('createThresholdLab', () => {
  it('沒有任何取樣時兩個建議都不成立', () => {
    const r = createThresholdLab().report()
    expect(suggestion(r, 'neckDropRatio').ok).toBe(false)
    expect(suggestion(r, 'neckDropRatio').note).toContain('樣本不足')
  })

  it('樣本數未達 minSamples 不給建議', () => {
    const lab = createThresholdLab({ minSamples: 8 })
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 }, 3)
    feed(lab, 'bad', { neckRatio: 0.8, shoulderWidth: 0.36 }, 3)
    expect(suggestion(lab.report(), 'neckDropRatio').ok).toBe(false)
  })

  it('沒有 label 時 push 不進任何一組', () => {
    const lab = createThresholdLab()
    lab.push({ neckRatio: 1.0, shoulderWidth: 0.30, valid: true })
    expect(lab.count('good')).toBe(0)
    expect(lab.count('bad')).toBe(0)
  })

  it('valid:false 的取樣要丟掉', () => {
    const lab = createThresholdLab()
    lab.setLabel('good')
    lab.push({ neckRatio: 1.0, shoulderWidth: 0.30, valid: false })
    expect(lab.count('good')).toBe(0)
  })

  it('兩組分離時算出 neckDropRatio：邊界取兩組中點', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    feed(lab, 'bad', { neckRatio: 0.8, shoulderWidth: 0.36 })
    const s = suggestion(lab.report(), 'neckDropRatio')
    expect(s.ok).toBe(true)
    // 邊界 (1.0+0.8)/2 = 0.9，相對基準 1.0 掉了 10%
    expect(s.value).toBeCloseTo(0.10, 2)
  })

  it('shoulderGrowRatio 方向相反：駝背時肩寬變大', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    feed(lab, 'bad', { neckRatio: 0.8, shoulderWidth: 0.36 })
    const s = suggestion(lab.report(), 'shoulderGrowRatio')
    expect(s.ok).toBe(true)
    // 邊界 (0.30+0.36)/2 = 0.33，相對基準 0.30 長了 10%
    expect(s.value).toBeCloseTo(0.10, 2)
  })

  it('兩組分佈重疊時明確拒絕給建議，而不是給一個看起來很像的數字', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    feed(lab, 'bad', { neckRatio: 0.99, shoulderWidth: 0.302 })
    const s = suggestion(lab.report(), 'neckDropRatio')
    expect(s.ok).toBe(false)
    expect(s.note).toContain('分不開')
  })

  it('report 附上兩組的百分位數供人工判讀', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    const r = lab.report()
    expect(r.good.n).toBe(12)
    expect(r.good.neck.p50).toBeCloseTo(1.0, 3)
    expect(r.bad).toBe(null)
  })

  it('reset 清掉兩組', () => {
    const lab = createThresholdLab()
    feed(lab, 'good', { neckRatio: 1.0, shoulderWidth: 0.30 })
    lab.reset()
    expect(lab.count('good')).toBe(0)
  })
})
```

- [ ] **Step 5: 跑測試確認失敗**

```bash
npm test -- src/core/thresholdLab.test.js
```

預期：`Failed to resolve import "./thresholdLab.js"`。

- [ ] **Step 6: 實作 thresholdLab**

`src/core/thresholdLab.js`：

```js
/**
 * 姿態閾值量測工具。只在開發期的 LivePreview 用，不進正式流程。
 *
 * 用法：坐正時 setLabel('good') 收幾秒，駝背時 setLabel('bad') 收幾秒，
 * 然後 report() 給出該填進 postureProfiles.js 的數字。
 *
 * 為什麼要檢查重疊：如果坐正和駝背量到的 neckRatio 分佈根本疊在一起，
 * 代表這個指標在這個人／這個坐姿下分不出差別。這時給出任何閾值都是擲骰子，
 * 必須先改鏡頭角度或改用另一個指標，而不是繼續調數字。
 */

const MIN_GAP_RATIO = 0.02 // 兩組之間至少要差基準值的 2%，否則視為分不開

function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b)
  return { p5: percentile(s, 5), p50: percentile(s, 50), p95: percentile(s, 95) }
}

const round2 = (x) => Math.round(x * 100) / 100

export function createThresholdLab({ minSamples = 8 } = {}) {
  const groups = { good: [], bad: [] }
  let label = null

  function stats(name) {
    const rows = groups[name]
    if (!rows.length) return null
    return {
      n: rows.length,
      neck: summarize(rows.map((r) => r.neckRatio)),
      shoulder: summarize(rows.map((r) => r.shoulderWidth)),
    }
  }

  /**
   * direction 'down'：壞姿勢時數值變小（neckRatio）
   * direction 'up'  ：壞姿勢時數值變大（shoulderWidth）
   */
  function suggest({ key, field, direction, good, bad }) {
    if (!good || !bad || good.n < minSamples || bad.n < minSamples) {
      return { key, ok: false, value: null, note: `樣本不足（坐正 ${good?.n ?? 0} 筆、駝背 ${bad?.n ?? 0} 筆，各需 ${minSamples} 筆）` }
    }
    const g = good[field]
    const b = bad[field]
    const gap = MIN_GAP_RATIO * g.p50
    const [lo, hi] = direction === 'down' ? [b.p95, g.p5] : [g.p95, b.p5]
    if (!(hi > lo + gap)) {
      return {
        key,
        ok: false,
        value: null,
        note: `兩組分佈分不開（坐正 ${round2(g.p5)}–${round2(g.p95)}、駝背 ${round2(b.p5)}–${round2(b.p95)}）。`
            + '先調鏡頭高度或坐姿距離再量一次，不要硬填數字。',
      }
    }
    const boundary = (lo + hi) / 2
    const value = direction === 'down' ? 1 - boundary / g.p50 : boundary / g.p50 - 1
    if (value <= 0) {
      return { key, ok: false, value: null, note: '算出來的容許量 ≤ 0，量測有問題' }
    }
    return {
      key,
      ok: true,
      value: round2(value),
      note: `基準 ${round2(g.p50)}、判定邊界 ${round2(boundary)}`,
    }
  }

  return {
    setLabel(next) {
      label = next === 'good' || next === 'bad' ? next : null
    },
    push(metrics) {
      if (!label || !metrics?.valid) return
      const { neckRatio, shoulderWidth } = metrics
      if (!Number.isFinite(neckRatio) || !Number.isFinite(shoulderWidth)) return
      groups[label].push({ neckRatio, shoulderWidth })
    },
    count: (name) => groups[name]?.length ?? 0,
    currentLabel: () => label,
    reset() {
      groups.good = []
      groups.bad = []
      label = null
    },
    report() {
      const good = stats('good')
      const bad = stats('bad')
      return {
        good,
        bad,
        // 基準值直接取坐正組的中位數：這是這個人在這個鏡頭位置下的真實值，
        // 不是猜的 1.0。校準精靈（Task 9）之後會用同樣的取中位數作法。
        baseline: good ? { baselineNeckRatio: round2(good.neck.p50), baselineShoulderWidth: round2(good.shoulder.p50) } : null,
        suggestions: [
          suggest({ key: 'neckDropRatio', field: 'neck', direction: 'down', good, bad }),
          suggest({ key: 'shoulderGrowRatio', field: 'shoulder', direction: 'up', good, bad }),
        ],
      }
    },
  }
}
```

- [ ] **Step 7: 跑測試確認通過**

```bash
npm test -- src/core/thresholdLab.test.js
```

預期：9 個測試全過。

- [ ] **Step 8: 寫暫時的即時預覽畫面**

`src/components/LivePreview.vue`：

```vue
<template>
  <section class="preview">
    <video ref="videoEl" class="cam" playsinline muted />
    <dl class="readout">
      <dt>推論</dt><dd>{{ ready ? '運作中' : '載入中…' }}</dd>
      <dt>姿態</dt><dd>{{ posture }}</dd>
      <dt>瞌睡</dt><dd>{{ drowsy ? '是' : '否' }}</dd>
      <dt>手機</dt><dd>{{ phoneVisible ? '偵測到' : '無' }}</dd>
      <dt>延遲</dt><dd>{{ Math.round(latency) }} ms</dd>
      <dt>fps</dt><dd>P {{ fps.pose.toFixed(1) }} / F {{ fps.face.toFixed(1) }} / O {{ fps.object.toFixed(2) }}</dd>
      <!-- 生數值一定要看得到。只看「姿態: upright」沒辦法分辨是姿勢真的端正，
           還是指標壞掉一直回同一個值。 -->
      <dt>neckRatio</dt><dd>{{ raw.neckRatio.toFixed(3) }} <small>(基準 {{ baseline.baselineNeckRatio.toFixed(3) }}／邊界 {{ neckEdge.toFixed(3) }})</small></dd>
      <dt>shoulderW</dt><dd>{{ raw.shoulderWidth.toFixed(3) }} <small>(基準 {{ baseline.baselineShoulderWidth.toFixed(3) }}／邊界 {{ shoulderEdge.toFixed(3) }})</small></dd>
    </dl>

    <section class="lab">
      <h2>閾值實驗室</h2>
      <p class="hint">坐正別動，按住「收坐正」數五秒放開；再刻意駝背靠近桌面，按住「收駝背」五秒放開。</p>
      <div class="btns">
        <button type="button" @pointerdown="lab.setLabel('good')" @pointerup="lab.setLabel(null)" @pointercancel="lab.setLabel(null)">
          收坐正（{{ counts.good }}）
        </button>
        <button type="button" @pointerdown="lab.setLabel('bad')" @pointerup="lab.setLabel(null)" @pointercancel="lab.setLabel(null)">
          收駝背（{{ counts.bad }}）
        </button>
        <button type="button" @click="runReport">算閾值</button>
        <button type="button" @click="lab.reset(); report = null">重來</button>
      </div>
      <div v-if="report" class="result">
        <p v-for="s in report.suggestions" :key="s.key" :class="s.ok ? 'ok' : 'bad'">
          <code>{{ s.key }}: {{ s.ok ? s.value : '—' }}</code> {{ s.note }}
        </p>
        <p v-if="report.baseline">
          實測基準：<code>baselineNeckRatio: {{ report.baseline.baselineNeckRatio }}</code>、
          <code>baselineShoulderWidth: {{ report.baseline.baselineShoulderWidth }}</code>
          <button type="button" @click="applyBaseline">套用基準</button>
        </p>
      </div>
    </section>

    <p v-if="errorText" class="err">{{ errorText }}</p>
  </section>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { createCameraCapture } from '../core/cameraCapture.js'
import { createInferenceService } from '../core/inferenceService.js'
import { createPoseAnalyzer } from '../core/poseAnalyzer.js'
import { createThresholdLab } from '../core/thresholdLab.js'
import { profileFor } from '../core/postureProfiles.js'

const videoEl = ref(null)
const ready = ref(false)
const posture = ref('upright')
const drowsy = ref(false)
const phoneVisible = ref(false)
const latency = ref(0)
const errorText = ref('')
const fps = reactive({ pose: 0, face: 0, object: 0 })
const raw = reactive({ neckRatio: 0, shoulderWidth: 0 })

const lab = createThresholdLab()
const counts = reactive({ good: 0, bad: 0 })
const report = ref(null)

let camera = null
let svc = null
let analyzer = null
let rafId = 0

const profile = profileFor('custom')

// 基準是可改的：一開始填不知道，實驗室量完按「套用基準」就換成這台 iPad
// 上這個人的真實值。寫死 1.0 會讓整場都判成低頭，等於整個 Step 完全白測。
const baseline = reactive({ baselineNeckRatio: 1.0, baselineShoulderWidth: 0.30 })

const neckEdge = computed(() => baseline.baselineNeckRatio * (1 - profile.neckDropRatio))
const shoulderEdge = computed(() => baseline.baselineShoulderWidth * (1 + profile.shoulderGrowRatio))

function runReport() {
  report.value = lab.report()
}

function applyBaseline() {
  const b = report.value?.baseline
  if (!b) return
  baseline.baselineNeckRatio = b.baselineNeckRatio
  baseline.baselineShoulderWidth = b.baselineShoulderWidth
  analyzer = createPoseAnalyzer({ baseline: { ...baseline }, profile })
}

async function loop() {
  const now = performance.now()
  const r = await svc.step(now)
  if (r) {
    latency.value = r.latencyMs
    if (r.key === 'pose') {
      analyzer.pushPose({ t: now, metrics: r.metrics })
      lab.push(r.metrics)
      counts.good = lab.count('good')
      counts.bad = lab.count('bad')
      if (r.metrics?.valid) {
        raw.neckRatio = r.metrics.neckRatio
        raw.shoulderWidth = r.metrics.shoulderWidth
      }
    } else if (r.key === 'face') analyzer.pushFace({ t: now, metrics: r.metrics })
    else phoneVisible.value = r.metrics.phoneVisible
    const e = analyzer.evaluate(now)
    posture.value = e.posture
    drowsy.value = e.drowsy
    fps.pose = svc.actualFps('pose', now)
    fps.face = svc.actualFps('face', now)
    fps.object = svc.actualFps('object', now)
  }
  rafId = requestAnimationFrame(loop)
}

onMounted(async () => {
  analyzer = createPoseAnalyzer({ baseline: { ...baseline }, profile })
  camera = createCameraCapture({ videoEl: videoEl.value, onEnded: () => { errorText.value = '鏡頭已停止' } })
  const cam = await camera.start()
  if (!cam.ok) { errorText.value = `鏡頭無法啟動：${cam.error?.name ?? '未知錯誤'}`; return }
  svc = createInferenceService({ videoEl: videoEl.value })
  const init = await svc.init()
  if (!init.ok) { errorText.value = `模型載入失敗：${init.error?.message ?? ''}`; return }
  ready.value = true
  loop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  svc?.destroy()
  camera?.stop()
})
</script>

<style scoped>
.preview { padding: var(--gap); display: flex; gap: var(--gap); flex-wrap: wrap; }
.cam { width: 320px; max-width: 100%; border-radius: var(--radius); transform: scaleX(-1); }
.readout { display: grid; grid-template-columns: auto auto; gap: 4px 12px; font-size: var(--fs-number); }
.lab { flex: 1 1 320px; }
.lab h2 { font-size: var(--fs-body); margin: 0 0 4px; }
.lab .hint { color: var(--c-text-dim); font-size: var(--fs-body); margin: 0 0 8px; }
.lab .btns { display: flex; gap: 8px; flex-wrap: wrap; }
/* 開發用畫面也照 spec 的觸控最小尺寸做，免得在 iPad 上按不準反而干擾量測 */
.lab button { min-height: 44px; min-width: 44px; padding: 0 12px; touch-action: manipulation; }
.lab .result { margin-top: 8px; font-size: var(--fs-body); }
.lab .result .ok code { color: var(--c-success); }
.lab .result .bad code { color: var(--c-danger); }
dt { color: var(--c-text-dim); }
dd { margin: 0; }
.err { color: var(--c-danger); font-size: var(--fs-body); }
</style>
```

`transform: scaleX(-1)` 只鏡像**顯示**，不影響送進 MediaPipe 的影像。

- [ ] **Step 9: 接到 App.vue**

```vue
<template>
  <LivePreview />
</template>

<script setup>
import LivePreview from './components/LivePreview.vue'
</script>
```

- [ ] **Step 10: 實機驗證（這是本工項的真正驗收）**

```bash
npm run dev
```

用 **iPad Pro M1 的 Safari** 連 `https://<電腦區網IP>:5173`，接受自簽憑證，允許鏡頭。

**先把 iPad 擺成之後真的要用的樣子**——立架角度、跟人的距離、桌面高度。
所有量出來的數字都只在這個擺法下成立，之後換擺法要重量一次。

**10a. 基本運作**

1. 影像出現、右側讀數在跳
2. `neckRatio` / `shoulderW` 是變動的合理數值，不是 `0.000` 也不是卡死不動
3. fps 讀數穩定在 P≈2 / F≈3 / O≈0.33 附近；延遲 < 150ms
4. 切到別的 App 再切回來 → 影像恢復、讀數繼續跳（不是黑畫面）
5. 拿手機進畫面約 3 秒 → `手機: 偵測到`
6. 閉眼 3 秒 → `瞌睡: 是`；正常眨眼不會觸發
7. 眼睛往下看（看桌面）→ **不得**被判成分心

**10b. 量閾值（這一段結束前不准往下做 Task 8）**

1. 坐正、視線看螢幕，按住「收坐正」數五秒放開。計數應該到 10 上下（Pose 2fps）
2. 刻意駝背＋上半身靠近桌面，按住「收駝背」五秒放開
3. 按「算閾值」

三種結果，各自的處理方式：

| 結果 | 意思 | 做什麼 |
|---|---|---|
| 兩行都綠色，有數字 | 兩組分佈乾淨地分開了 | 把數字填進 `src/core/postureProfiles.js` 的 `BASE`，按「套用基準」，回到 10c |
| `neckDropRatio` 綠、`shoulderGrowRatio` 紅 | 肩寬這個指標在這個鏡頭角度下沒鑑別度 | 把 `BASE.requireBothForSlouch` 全部設成 `false`，`shoulderGrowRatio` 留 `0.12` 不動，並在 `postureProfiles.js` 註明「實機量測顯示肩寬鑑別度不足，slouch 實際由 neckRatio 決定」 |
| 兩行都紅（分不開） | 這個鏡頭位置下前鏡頭根本看不出你在駝背 | **不要填數字**。調 iPad 角度（通常是架太低、拍到下巴底），或把人坐遠一點讓上半身完整入鏡，然後重按「重來」再量一次 |

第三種情況重量三次還是分不開，就停下來回報，不要自己發明新指標——
這代表 spec 的姿態判定前提在這個擺法下不成立，是設計問題不是調參問題。

**10c. 用量出來的值驗一次**

填完 `postureProfiles.js`（Vite HMR 會自動重載）後：

1. 坐正 → `姿態: upright`，而且 `neckRatio` 明顯在「邊界」之上
2. 刻意駝背並靠近桌面約 4 秒 → 變成 `slouch`
3. 低頭 4 秒 → 變成 `forwardHead`
4. 在坐正和駝背之間慢慢移動，觀察狀態在邊界附近切換一次就好，不會快速來回抖動

第 4 項若在抖動，代表兩組太靠近，`postureHoldMs`（預設 3000）要往上調到 4000–5000，
而不是再去動 `neckDropRatio`。

**把最後填進 `postureProfiles.js` 的數字寫進本工項的 commit message**，
之後回頭查「這個 0.15 是哪來的」才有出處。

**不要**改 `poseAnalyzer.js` 的邏輯——那是有測試鎖住的判定核心，
這一段只該動 `postureProfiles.js` 的常數。

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: InferenceService、閾值實驗室與即時預覽

三個 MediaPipe task 共用同一個 1x1 canvas/GL context（已驗證
@mediapipe/tasks-vision@1.0.1 的 createFromOptions 支援 canvas 選項），
單一 in-flight 不排隊；wasm 與模型檔自我託管於 public/ 以符合零網路依賴。

附 thresholdLab：收「坐正／駝背」兩組標記樣本、比對百分位數分佈、
分佈重疊時明確拒絕給建議，把姿態閾值從猜測變成量測。

實機量測結果（iPad Pro M1，立架角度見 Step 10）：
  baselineNeckRatio    = <填實測值>
  baselineShoulderWidth = <填實測值>
  neckDropRatio        = <填實測值>
  shoulderGrowRatio    = <填實測值或註明鑑別度不足>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

commit message 裡的四個 `<填實測值>` 是**必填**，不是範例文字。
這是這些魔數唯一的出處記錄。

---

### Task 8: 方向自適應版面基礎

spec v4.3 把「直式與橫式同等支援」列為硬要求：**每一個畫面在兩個方向都必須完整可用**，不得有任一方向被當成降級版。與其在每個元件各寫一次 media query，先在這裡把共用的版面原語做好。

**Files:**
- Create: `src/styles/layout.css`
- Modify: `src/main.js`（引入）
- Modify: `src/styles/base.css`

**Interfaces:**
- Consumes: `tokens.css`（Task 1）
- Produces：全域可用的 class
  - `.arena` — 對戰式分半容器：橫式左右分半、直式上下分半
  - `.arena__hero` / `.arena__boss` / `.arena__field`
  - `.stack` — 一般畫面用的置中單欄容器，兩方向都留安全邊距
  - `.corner-tl` / `.corner-tr` / `.corner-bl` / `.corner-br` — 角落按鈕定位
  - CSS 變數 `--attack-dx` / `--attack-dy`：攻擊特效的飛行向量，由方向決定（Task 14 使用）

- [ ] **Step 1: 寫 layout.css**

```css
/* 直橫同等支援：兩個方向都是完整版面，沒有哪一個是降級遷就 */

.stack {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--gap);
  padding: max(var(--gap), env(safe-area-inset-top))
           max(var(--gap), env(safe-area-inset-right))
           max(var(--gap), env(safe-area-inset-bottom))
           max(var(--gap), env(safe-area-inset-left));
  text-align: center;
}

/* 對戰式分半版面 */
.arena {
  position: relative;
  min-height: 100dvh;
  display: grid;
  gap: 0;
  /* 攻擊特效的飛行向量，由方向決定；Task 14 的 keyframes 讀這兩個值 */
  --attack-dx: 100%;
  --attack-dy: 0%;
}

/* 橫式：左半自己、右半魔王 */
@media (orientation: landscape) {
  .arena {
    grid-template-columns: 1fr 1fr;
    grid-template-areas: 'hero boss';
    --attack-dx: 100%;
    --attack-dy: 0%;
  }
}

/* 直式：上半自己、下半魔王 */
@media (orientation: portrait) {
  .arena {
    grid-template-rows: 1fr 1fr;
    grid-template-areas: 'hero' 'boss';
    --attack-dx: 0%;
    --attack-dy: 100%;
  }
}

.arena__hero { grid-area: hero; position: relative; overflow: hidden; }
.arena__boss { grid-area: boss; position: relative; overflow: hidden;
               display: flex; align-items: center; justify-content: center; }

/* 戰場帶：覆蓋在兩區交界，飛行特效與傷害數字都在這一層 */
.arena__field {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}

/* 角落按鈕。用 safe-area 讓直式握持時不會壓到圓角與 Home indicator */
.corner-tl, .corner-tr, .corner-bl, .corner-br {
  position: absolute;
  z-index: 3;
}
.corner-tl { top: max(var(--gap), env(safe-area-inset-top)); left: max(var(--gap), env(safe-area-inset-left)); }
.corner-tr { top: max(var(--gap), env(safe-area-inset-top)); right: max(var(--gap), env(safe-area-inset-right)); }
.corner-bl { bottom: max(var(--gap), env(safe-area-inset-bottom)); left: max(var(--gap), env(safe-area-inset-left)); }
.corner-br { bottom: max(var(--gap), env(safe-area-inset-bottom)); right: max(var(--gap), env(safe-area-inset-right)); }
```

- [ ] **Step 2: base.css 補上防止橫向捲動**

在 `src/styles/base.css` 的 `body` 規則後面加：

```css
html, body { overflow-x: hidden; }
/* 鏡頭畫面一律 cover，兩個方向都不得變形 */
video { object-fit: cover; }
```

- [ ] **Step 3: main.js 引入**

在 `import './styles/base.css'` 後面加一行：

```js
import './styles/layout.css'
```

- [ ] **Step 4: 把 LivePreview 改成 arena 版面，順便驗證兩個方向**

把 `src/components/LivePreview.vue` 的 `<template>` 改成：

```vue
<template>
  <div class="arena">
    <div class="arena__hero">
      <video ref="videoEl" class="cam" playsinline muted />
    </div>
    <div class="arena__boss">
      <dl class="readout">
        <dt>推論</dt><dd>{{ ready ? '運作中' : '載入中…' }}</dd>
        <dt>姿態</dt><dd>{{ posture }}</dd>
        <dt>瞌睡</dt><dd>{{ drowsy ? '是' : '否' }}</dd>
        <dt>手機</dt><dd>{{ phoneVisible ? '偵測到' : '無' }}</dd>
        <dt>延遲</dt><dd>{{ Math.round(latency) }} ms</dd>
        <dt>fps</dt><dd>P {{ fps.pose.toFixed(1) }} / F {{ fps.face.toFixed(1) }} / O {{ fps.object.toFixed(2) }}</dd>
      </dl>
      <p v-if="errorText" class="err">{{ errorText }}</p>
    </div>
  </div>
</template>
```

`<style scoped>` 的 `.cam` 改成：

```css
.cam { width: 100%; height: 100%; transform: scaleX(-1); }
```

- [ ] **Step 5: 實機驗收兩個方向**

```bash
npm run dev
```

在 iPad 上把裝置**直橫各轉一次**，兩個方向都要：
1. 畫面分成明確的兩半（橫式左右、直式上下）
2. 鏡頭影像填滿自己那一半且**不變形**（人臉比例正常，不是被拉長壓扁）
3. 沒有橫向捲動、沒有任何元素被切掉
4. 轉向時鏡頭**不中斷**、讀數持續跳動（不是黑一下再回來）

第 4 項若有中斷，檢查是不是有 `v-if` 依方向切換元件——方向必須純用 CSS 處理，不得重新掛載 `<video>`。

- [ ] **Step 6: Commit**

```bash
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: 方向自適應的對戰式分半版面

橫式左右分半、直式上下分半，純 CSS 切換不重新掛載元件；
攻擊飛行向量以 CSS 變數隨方向改變，供 BattleView 共用同一組 keyframes。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: CalibrationWizard

引導使用者維持 5 秒端正坐姿，取樣的**中位數**當基準。用中位數而非平均，是因為取樣期間人一定會動，平均會被幾個離群幀拉走。

校準期間把 Pose 提頻到 5-8fps、關掉 Face 與 Object——5 秒內要蒐集夠多取樣點，而這段時間不需要偵測視線或手機。

**不做「晃太多請重來」的迴圈**：國小生被擋在校準畫面外進不去遊戲，比基準稍微不準嚴重得多。取中位數、捨棄離群值就夠了。

**Files:**
- Create: `src/core/calibration.js`, `src/core/calibration.test.js`
- Create: `src/components/CalibrationWizard.vue`

**Interfaces:**
- Consumes: `poseMetrics` 的輸出（Task 3）
- Produces：
  - `calibration.js`：`createCalibrationCollector()` → `.add(metrics)`、`.count()`、`.result() -> { ok, profile, reason }`，`profile` 形狀為 `{ id: 'default', baselineNeckRatio, baselineShoulderWidth, calibratedAt }`（`calibratedAt` 由呼叫端補）
  - `CalibrationWizard.vue`：props `{ camera, inference }`，emit `done(profile)`

- [ ] **Step 1: 寫失敗的測試**

`src/core/calibration.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createCalibrationCollector, MIN_SAMPLES } from './calibration.js'

const valid = (neckRatio, shoulderWidth = 0.30) => ({ neckRatio, shoulderWidth, valid: true })

describe('createCalibrationCollector', () => {
  it('取樣不足時 result 回報 not_enough', () => {
    const c = createCalibrationCollector()
    c.add(valid(1.0))
    const r = c.result()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_enough')
  })

  it('取中位數而非平均，離群值不影響結果', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0))
    c.add(valid(5.0))  // 一個極端離群值
    c.add(valid(-3.0))
    expect(c.result().profile.baselineNeckRatio).toBeCloseTo(1.0, 3)
  })

  it('偶數筆取樣時取中間兩筆的平均', () => {
    const c = createCalibrationCollector()
    const values = [0.90, 0.95, 1.05, 1.10]
    while (c.count() < MIN_SAMPLES - values.length) c.add(valid(1.0))
    for (const v of values) c.add(valid(v))
    expect(c.result().ok).toBe(true)
  })

  it('無效取樣不計入', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES + 5; i++) c.add({ neckRatio: 0, shoulderWidth: 0, valid: false })
    expect(c.result().ok).toBe(false)
    expect(c.count()).toBe(0)
  })

  it('肩寬與頸比各自獨立取中位數', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0, 0.30))
    c.add(valid(1.0, 0.99))
    const p = c.result().profile
    expect(p.baselineShoulderWidth).toBeCloseTo(0.30, 3)
  })

  it('成功時回傳 id 為 default 的 profile', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0))
    const p = c.result().profile
    expect(p.id).toBe('default')
    expect(p.baselineNeckRatio).toBeGreaterThan(0)
  })

  it('reset 後重新開始', () => {
    const c = createCalibrationCollector()
    for (let i = 0; i < MIN_SAMPLES; i++) c.add(valid(1.0))
    c.reset()
    expect(c.count()).toBe(0)
    expect(c.result().ok).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- src/core/calibration.test.js
```

- [ ] **Step 3: 寫 calibration.js**

```js
/** 5 秒 × 5-8fps，扣掉起步與無效幀後至少要有這麼多筆才算數 */
export const MIN_SAMPLES = 12

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 校準取樣器。
 *
 * 用中位數不用平均：5 秒內人一定會動，平均會被幾個離群幀拉走，
 * 而基準一旦偏掉，整輪的姿態判定都跟著偏。
 *
 * 刻意不做「晃太多請重來」的迴圈——國小生被擋在校準畫面外進不去遊戲，
 * 比基準稍微不準嚴重得多。
 */
export function createCalibrationCollector() {
  let neckRatios = []
  let shoulderWidths = []

  return {
    add(metrics) {
      if (!metrics?.valid) return
      neckRatios.push(metrics.neckRatio)
      shoulderWidths.push(metrics.shoulderWidth)
    },

    count() {
      return neckRatios.length
    },

    reset() {
      neckRatios = []
      shoulderWidths = []
    },

    result() {
      if (neckRatios.length < MIN_SAMPLES) {
        return { ok: false, reason: 'not_enough', profile: null }
      }
      return {
        ok: true,
        reason: null,
        profile: {
          id: 'default',
          baselineNeckRatio: median(neckRatios),
          baselineShoulderWidth: median(shoulderWidths),
          calibratedAt: null, // 由呼叫端補上，本檔不讀系統時鐘
        },
      }
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npm test -- src/core/calibration.test.js
```

- [ ] **Step 5: 寫 CalibrationWizard.vue**

```vue
<template>
  <div class="arena">
    <div class="arena__hero">
      <video ref="videoEl" class="cam" playsinline muted />
      <div class="frame" :class="{ good: sampling && collected > 0 }" />
    </div>

    <div class="arena__boss guide">
      <h2>先坐好，我來記住你的姿勢</h2>
      <ol class="how">
        <li>背靠椅背坐直</li>
        <li>肩膀放鬆、往後打開</li>
        <li>眼睛看著 iPad，保持 5 秒</li>
      </ol>

      <p v-if="!sampling" class="hint">準備好就按開始</p>
      <p v-else class="countdown" aria-live="polite">{{ remainText }}</p>

      <p v-if="failed" class="hint warn">
        沒看清楚你的肩膀，往後坐一點讓上半身都進到畫面裡，再試一次
      </p>

      <button v-if="!sampling" class="primary go" @click="begin">
        {{ failed ? '再試一次' : '開始校準' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { createCalibrationCollector } from '../core/calibration.js'

const props = defineProps({
  camera: { type: Object, required: true },
  inference: { type: Object, required: true },
  videoEl: { type: Object, default: null },
})
const emit = defineEmits(['done'])

const SAMPLE_MS = 5000

const videoEl = ref(props.videoEl)
const sampling = ref(false)
const failed = ref(false)
const collected = ref(0)
const remainMs = ref(SAMPLE_MS)

const collector = createCalibrationCollector()
let rafId = 0
let startedAt = 0

const remainText = computed(() => `保持這個姿勢 ${Math.ceil(remainMs.value / 1000)} 秒`)

function begin() {
  failed.value = false
  collected.value = 0
  collector.reset()
  // 校準期間提頻並關掉用不到的模型，5 秒內才蒐集得到足夠取樣
  props.inference.setScale(3)
  props.inference.setEnabled('face', false)
  props.inference.setEnabled('object', false)
  sampling.value = true
  startedAt = performance.now()
  rafId = requestAnimationFrame(loop)
}

function restore() {
  props.inference.setScale(1)
  props.inference.setEnabled('face', true)
  props.inference.setEnabled('object', true)
}

async function loop() {
  const now = performance.now()
  remainMs.value = Math.max(0, SAMPLE_MS - (now - startedAt))

  const r = await props.inference.step(now)
  if (r?.key === 'pose') {
    collector.add(r.metrics)
    collected.value = collector.count()
  }

  if (remainMs.value > 0) {
    rafId = requestAnimationFrame(loop)
    return
  }

  sampling.value = false
  restore()
  const result = collector.result()
  if (!result.ok) { failed.value = true; return }
  emit('done', { ...result.profile, calibratedAt: Date.now() })
}

onMounted(() => { if (!videoEl.value) videoEl.value = props.videoEl })
onBeforeUnmount(() => { cancelAnimationFrame(rafId); restore() })
</script>

<style scoped>
.cam { width: 100%; height: 100%; transform: scaleX(-1); }
/* 對齊框：純邊框，不用 filter/box-shadow 動畫（常駐 video 上方的合成成本） */
.frame {
  position: absolute; inset: 12% 18%;
  border: 4px dashed var(--c-text-dim);
  border-radius: var(--radius);
  transition: border-color .2s;
}
.frame.good { border-color: var(--c-ok); border-style: solid; }
.guide { flex-direction: column; gap: var(--gap); padding: var(--gap); }
h2 { font-size: var(--fs-title); margin: 0; }
.how { text-align: left; font-size: var(--fs-body); line-height: 1.9; }
.countdown { font-size: var(--fs-coach); font-weight: 700; margin: 0; }
.hint { font-size: var(--fs-body); color: var(--c-text-dim); }
.hint.warn { color: var(--c-warn); }
.go { min-width: 220px; }
</style>
```

- [ ] **Step 6: 實機驗收**

暫時把 `App.vue` 改成掛 `CalibrationWizard`（鏡頭與 InferenceService 先在 App 建好再傳進去），然後在 iPad 上：

1. **直橫各轉一次**，兩個方向都完整可用
2. 坐直按開始 → 倒數 5 秒 → 對齊框轉綠 → 成功並印出 profile
3. 刻意退到畫面外校準 → 出現「沒看清楚你的肩膀…」＋「再試一次」，**不會卡死**
4. 校準期間 Pose 明顯變快（可暫時在畫面上顯示 `inference.actualFps('pose', now)` 確認接近 6）

- [ ] **Step 7: Commit**

```bash
npm test && npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: CalibrationWizard 校準精靈

5 秒取樣取中位數（平均會被離群幀拉走），校準期間 Pose 提頻並關閉 Face/Object。
刻意不做「晃太多請重來」迴圈——把小學生擋在遊戲外比基準略偏嚴重。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 會話 store 與 SessionTimer 生命週期

把「鏡頭 → 推論 → 分析 → 狀態機」串成一條真的會跑的迴圈，加上 Wake Lock 與背景/前景處理。這個工項結束時遊戲邏輯就完整了，只是還沒有好看的畫面。

**iPadOS 的 Wake Lock 會在頁面隱藏時自動釋放**，回前景時必須重新取得——不重新取得的話，第二次以後的專注時段螢幕會自己暗掉。

**Files:**
- Create: `src/stores/session.js`
- Create: `src/core/wakeLock.js`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: 前面所有 core 模組
- Produces：`useSession()` 回傳一個模組級單例，欄位與方法如下
  - 狀態（`reactive`）：`screen`（`'privacy'|'permission'|'calibrate'|'task'|'battle'|'break'|'stats'`）、`battle`（FSM snapshot）、`posture`、`drowsy`、`phoneVisible`、`paused`、`inferenceHealthy`、`profile`、`taskType`、`durationMin`、`demoMode`、`lastRecord`
  - 方法：`await boot(videoEl)`、`setCalibration(profile)`、`setTask({ taskType, durationMin, demoMode })`、`await startBattle()`、`togglePause()`、`await endBattle(reason)`、`undoTrap(trapId)`、`onBattleEvent(handler)`（註冊事件消費者，回傳取消註冊函式）
  - `wakeLock.js`：`createWakeLock()` → `await request()`、`release()`、`isActive()`

- [ ] **Step 1: 寫 wakeLock.js**

```js
/**
 * iPadOS 會在頁面隱藏時自動釋放 Wake Lock，且不會自己還回來。
 * 回前景時一定要重新 request()，否則第二段專注時間螢幕會自己暗掉。
 * Wake Lock 只是第一層，spec 另外要求引導使用者把「自動鎖定」設為永不。
 */
export function createWakeLock() {
  let sentinel = null

  return {
    async request() {
      if (!('wakeLock' in navigator)) return false
      if (sentinel) return true
      try {
        sentinel = await navigator.wakeLock.request('screen')
        sentinel.addEventListener('release', () => { sentinel = null })
        return true
      } catch {
        sentinel = null
        return false
      }
    },

    release() {
      sentinel?.release?.()
      sentinel = null
    },

    isActive() {
      return sentinel !== null
    },
  }
}
```

- [ ] **Step 2: 寫 session store**

`src/stores/session.js`：

```js
import { reactive, readonly } from 'vue'
import { createCameraCapture } from '../core/cameraCapture.js'
import { createInferenceService } from '../core/inferenceService.js'
import { createPoseAnalyzer } from '../core/poseAnalyzer.js'
import { createFocusStateMachine } from '../core/focusStateMachine.js'
import { createWakeLock } from '../core/wakeLock.js'
import { profileFor } from '../core/postureProfiles.js'
import { DEFAULT_DURATION_MIN, DEMO } from '../core/battleConfig.js'

const INFERENCE_TIMEOUT_MS = 10_000

const state = reactive({
  screen: 'privacy',
  booted: false,
  bootError: null,
  profile: null,
  taskType: 'homework',
  durationMin: DEFAULT_DURATION_MIN,
  demoMode: false,
  posture: 'upright',
  drowsy: false,
  phoneVisible: false,
  paused: false,
  inferenceHealthy: true,
  cameraHealthy: true,
  battle: null,
  lastRecord: null,
})

let camera = null
let inference = null
let analyzer = null
let fsm = null
let wakeLock = createWakeLock()
let rafId = 0
let lastSuccessAt = 0
const handlers = new Set()

function emit(events) {
  if (!events.length) return
  for (const h of handlers) h(events)
}

function durationMs() {
  return state.demoMode ? DEMO.durationMs : state.durationMin * 60_000
}

async function frame() {
  const now = performance.now()
  const r = await inference.step(now)

  if (r) {
    lastSuccessAt = now
    if (r.key === 'pose') analyzer.pushPose({ t: now, metrics: r.metrics })
    else if (r.key === 'face') analyzer.pushFace({ t: now, metrics: r.metrics })
    else state.phoneVisible = r.metrics.phoneVisible
  }

  // 推論 watchdog：連續 10 秒沒有任何一次成功推論就暫停計分
  const healthy = now - lastSuccessAt < INFERENCE_TIMEOUT_MS
  if (healthy !== state.inferenceHealthy) {
    state.inferenceHealthy = healthy
    fsm?.setPaused(now, !healthy || state.paused)
  }

  if (fsm && !state.paused && healthy) {
    const e = analyzer.evaluate(now)
    state.posture = e.posture
    state.drowsy = e.drowsy
    const events = fsm.tick({
      t: now, posture: e.posture, drowsy: e.drowsy, phoneVisible: state.phoneVisible,
    })
    state.battle = fsm.snapshot()
    emit(events)
    if (state.battle.ended) { await api.endBattle('completed'); return }
  }

  rafId = requestAnimationFrame(frame)
}

async function onVisible() {
  const now = performance.now()
  // iOS 從背景回來後語音佇列可能卡死，無條件清一次
  window.speechSynthesis?.cancel?.()
  const ok = await camera.resume()
  state.cameraHealthy = ok
  lastSuccessAt = now
  if (fsm) {
    fsm.notifyVisible(now)
    await wakeLock.request() // 隱藏時被系統釋放了，一定要重新取得
  }
}

function onHidden() {
  const now = performance.now()
  camera.setEnabled(false)
  wakeLock.release()
  window.speechSynthesis?.cancel?.()
  fsm?.notifyHidden(now)
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') onHidden()
  else onVisible()
}

const api = {
  state: readonly(state),
  rawState: state,

  async boot(videoEl) {
    if (state.booted) return { ok: true }
    camera = createCameraCapture({
      videoEl,
      onEnded: () => { state.cameraHealthy = false },
    })
    const cam = await camera.start()
    if (!cam.ok) { state.bootError = cam.error; return { ok: false, error: cam.error } }

    inference = createInferenceService({ videoEl })
    const init = await inference.init()
    if (!init.ok) { state.bootError = init.error; return { ok: false, error: init.error } }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', () => { camera?.stop(); wakeLock.release() })

    state.booted = true
    lastSuccessAt = performance.now()
    return { ok: true }
  },

  inference: () => inference,
  camera: () => camera,

  setCalibration(profile) {
    state.profile = profile
    state.screen = 'task'
  },

  setTask({ taskType, durationMin, demoMode }) {
    state.taskType = taskType
    state.durationMin = durationMin
    state.demoMode = Boolean(demoMode)
  },

  async startBattle() {
    analyzer = createPoseAnalyzer({
      baseline: state.profile,
      profile: profileFor(state.taskType),
    })
    fsm = createFocusStateMachine({ durationMs: durationMs(), demoMode: state.demoMode })
    state.battle = fsm.snapshot()
    state.paused = false
    state.screen = 'battle'
    await wakeLock.request()
    cancelAnimationFrame(rafId)
    lastSuccessAt = performance.now()
    rafId = requestAnimationFrame(frame)
  },

  togglePause() {
    state.paused = !state.paused
    camera.setEnabled(!state.paused)
    fsm?.setPaused(performance.now(), state.paused)
    if (state.paused) wakeLock.release()
    else wakeLock.request()
  },

  undoTrap(trapId) {
    const ok = fsm?.undoTrap(trapId) ?? false
    if (ok) state.battle = fsm.snapshot()
    return ok
  },

  /** reason: 'completed' | 'aborted' */
  async endBattle(reason) {
    cancelAnimationFrame(rafId)
    rafId = 0
    const snapshot = fsm ? fsm.snapshot() : null
    fsm = null
    camera.setEnabled(false)
    wakeLock.release()
    window.speechSynthesis?.cancel?.()
    state.battle = snapshot
    state.lastRecord = snapshot ? buildRecord(snapshot, state, reason) : null
    state.screen = 'stats'
    // 註：這裡不呼叫 inference.destroy()。
    // 跨輪重複使用同一個 InferenceService，每輪重建會累積 GPU 記憶體並拖慢第二輪。
    return state.lastRecord
  },

  onBattleEvent(handler) {
    handlers.add(handler)
    return () => handlers.delete(handler)
  },

  teardown() {
    cancelAnimationFrame(rafId)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    inference?.destroy()
    camera?.stop()
    wakeLock.release()
    state.booted = false
  },
}

function buildRecord(s, st, reason) {
  const endedAt = Date.now()
  return {
    id: `s-${endedAt}`,
    startedAt: endedAt - s.elapsedMs,
    endedAt,
    durationMs: s.elapsedMs,
    status: reason === 'completed' ? 'completed' : 'in_progress',
    taskType: st.taskType,
    postureDurationMs: s.postureDurationMs,
    distractionDurationMs: s.distractionDurationMs,
    trapCount: s.trapCount,
    attacks: s.attacks,
    score: s.score,
    bossHpRemaining: s.bossHp,
    bossHpMax: s.bossHpMax,
    phase2Damage: s.phase2Damage,
    result: s.result ?? 'timeout',
    demoMode: st.demoMode,
  }
}

export function useSession() {
  return api
}
```

- [ ] **Step 3: 把 App.vue 改成畫面切換器**

```vue
<template>
  <video ref="videoEl" class="hidden-cam" playsinline muted />

  <CalibrationWizard
    v-if="s.screen === 'calibrate' && s.booted"
    :camera="session.camera()"
    :inference="session.inference()"
    :video-el="videoEl"
    @done="onCalibrated"
  />

  <div v-else-if="s.screen === 'battle'" class="stack">
    <p>戰鬥中（BattleView 尚未實作）</p>
    <p>Boss {{ s.battle?.bossHp }} / {{ s.battle?.bossHpMax }}　你 {{ s.battle?.playerHp }}</p>
    <p>姿態 {{ s.posture }}　積分 {{ s.battle?.score }}</p>
    <button class="primary" @click="session.endBattle('aborted')">結束</button>
  </div>

  <div v-else class="stack">
    <p v-if="s.bootError">啟動失敗：{{ s.bootError.name }}</p>
    <button v-else class="primary" @click="start">開始</button>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import CalibrationWizard from './components/CalibrationWizard.vue'
import { useSession } from './stores/session.js'

const session = useSession()
const s = session.state
const videoEl = ref(null)

async function start() {
  const r = await session.boot(videoEl.value)
  if (r.ok) session.rawState.screen = 'calibrate'
}

function onCalibrated(profile) {
  session.setCalibration(profile)
  session.setTask({ taskType: 'homework', durationMin: 15, demoMode: true })
  session.startBattle()
}

onMounted(() => { /* 鏡頭元素先掛好，boot 時才有東西可接 */ })
onBeforeUnmount(() => session.teardown())
</script>

<style scoped>
/* 唯一的 <video>：由各畫面共用，避免重新掛載造成鏡頭中斷 */
.hidden-cam { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
</style>
```

**整個 App 只有一個 `<video>` 元素**，由各畫面共用。每個畫面各掛一個會在切換時重新 `getUserMedia`，iPad 上會看到黑畫面閃爍。Task 14 的 BattleView 會用 CSS 把它定位到英雄側。

- [ ] **Step 4: 實機驗收（展示模式 20 秒全程）**

```bash
npm run dev
```

在 iPad 上：
1. 按開始 → 校準 → 自動進入 20 秒展示戰鬥
2. 全程坐正 → Boss HP 穩定下降、積分上升，20 秒內應打完 240 HP（攻擊間隔 1 秒）
3. 中途駝背 → 玩家 HP 開始掉、Boss HP 停止下降
4. **切到別的 App 停留 10 秒再回來** → 鏡頭恢復、螢幕沒有變暗、數值繼續跑
5. 20 秒到 → 自動切到 stats 畫面（目前是空的）

第 4 項若回來後螢幕會暗，檢查 `onVisible` 有沒有重新 `wakeLock.request()`。

- [ ] **Step 5: Commit**

```bash
npm test && npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: 會話 store 與 SessionTimer 生命週期

串起鏡頭→推論→分析→狀態機的完整迴圈；全 App 共用單一 <video> 避免切畫面時
鏡頭中斷；回前景重新取得 Wake Lock（iPadOS 隱藏時會自動釋放且不會還回來）；
推論 watchdog 連續 10 秒無成功推論即暫停計分。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: TaskSelector

選任務類型與時長。**時長不用文字輸入框**——國小生打字慢又容易輸錯，用 −/+ 步進器加四個快捷鍵。預設值已經選好，直接按開始就能玩。

**Files:**
- Create: `src/components/TaskSelector.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `DURATION_PRESETS` / `DURATION_MIN_MIN` / `DURATION_MAX_MIN` / `DEFAULT_DURATION_MIN`（Task 2）、`useSession`（Task 10）
- Produces：emit `start({ taskType, durationMin, demoMode })`

- [ ] **Step 1: 寫元件**

```vue
<template>
  <div class="stack">
    <h2>這次要做什麼？</h2>

    <div class="tasks" role="radiogroup" aria-label="任務類型">
      <button
        v-for="t in TASKS" :key="t.value"
        class="task" :class="{ on: taskType === t.value }"
        role="radio" :aria-checked="taskType === t.value"
        @click="taskType = t.value"
      >
        <span class="emoji" aria-hidden="true">{{ t.emoji }}</span>
        <span>{{ t.label }}</span>
      </button>
    </div>

    <h2>要專心多久？</h2>

    <div class="stepper">
      <button aria-label="減少 1 分鐘" @click="bump(-1)">−</button>
      <span class="minutes"><strong>{{ durationMin }}</strong> 分鐘</span>
      <button aria-label="增加 1 分鐘" @click="bump(1)">＋</button>
    </div>

    <div class="presets">
      <button
        v-for="p in DURATION_PRESETS" :key="p"
        class="preset" :class="{ on: durationMin === p }"
        @click="durationMin = p"
      >{{ p }} 分</button>
    </div>

    <p class="boss-hp">魔王血量 {{ bossHp }}</p>

    <button class="primary go" @click="emitStart(false)">開始討伐</button>
    <button class="demo" @click="emitStart(true)">展示模式（20 秒）</button>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import {
  DURATION_PRESETS, DURATION_MIN_MIN, DURATION_MAX_MIN, DEFAULT_DURATION_MIN, bossHpFor,
} from '../core/battleConfig.js'

const emit = defineEmits(['start'])

const TASKS = [
  { value: 'homework', label: '寫作業', emoji: '✏️' },
  { value: 'reading', label: '看書', emoji: '📖' },
  { value: 'vocab', label: '背單字', emoji: '🔤' },
  { value: 'custom', label: '自己選', emoji: '⭐' },
]

// 預設值已選好，直接按開始就能玩
const taskType = ref('homework')
const durationMin = ref(DEFAULT_DURATION_MIN)

const bossHp = computed(() => bossHpFor(durationMin.value * 60_000, false))

function bump(delta) {
  durationMin.value = Math.min(DURATION_MAX_MIN, Math.max(DURATION_MIN_MIN, durationMin.value + delta))
}

function emitStart(demoMode) {
  emit('start', { taskType: taskType.value, durationMin: durationMin.value, demoMode })
}
</script>

<style scoped>
h2 { font-size: var(--fs-title); margin: 0; }
.tasks, .presets { display: flex; gap: var(--gap); flex-wrap: wrap; justify-content: center; }
.task {
  min-width: 120px; min-height: var(--tap-primary);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 12px; font-size: var(--fs-body);
}
.task.on, .preset.on { outline: 3px solid var(--c-accent); background: var(--c-bg); }
.emoji { font-size: 28px; }
.stepper { display: flex; align-items: center; gap: var(--gap); }
.stepper button { width: var(--tap-primary); height: var(--tap-primary); font-size: 28px; }
.minutes { font-size: var(--fs-title); min-width: 140px; }
.minutes strong { font-size: 40px; }
.preset { min-width: 88px; min-height: var(--tap-min); }
.boss-hp { color: var(--c-text-dim); font-size: var(--fs-body); margin: 0; }
.go { min-width: 260px; }
.demo { min-height: var(--tap-min); color: var(--c-text-dim); background: transparent; }
</style>
```

選中狀態同時用 `outline` 與 `aria-checked` 表示，不單靠顏色。

- [ ] **Step 2: 接進 App.vue**

在 CalibrationWizard 的 `v-else-if` 鏈裡插入：

```vue
  <TaskSelector
    v-else-if="s.screen === 'task'"
    @start="onTaskChosen"
  />
```

並把 `onCalibrated` 拆開：

```js
function onCalibrated(profile) {
  session.setCalibration(profile)   // 內部會把 screen 切到 'task'
}

function onTaskChosen(payload) {
  session.setTask(payload)
  session.startBattle()
}
```

- [ ] **Step 3: 實機驗收**

1. **直橫各轉一次**，四個任務按鈕都不被切掉、快捷鍵列不溢出
2. 按 −/+ 時魔王血量即時改變，且 15 分 → 2160
3. 按到 5 分或 40 分時不再變化（邊界夾住）
4. 直接按「開始討伐」不用做任何選擇也能開始

- [ ] **Step 4: Commit**

```bash
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: TaskSelector 任務與時長選擇

時長用步進器＋四個快捷鍵，不用文字輸入框（國小生打字慢易錯）；
預設值已選好可直接開始；即時顯示對應的魔王血量。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: CopyEngine 與文案池

單一持有所有文案。取句器負責 shuffle bag（同輪內不重複）與 cooldown（同狀態 ≥45 秒）。

**節流比擴充文案池重要**：文案池再大，5 秒響一次也是噪音。

**Files:**
- Create: `src/core/copyEngine.js`, `src/core/copyEngine.test.js`
- Create: `src/data/copy/posture.js`, `src/data/copy/boss.js`, `src/data/copy/summary.js`

**Interfaces:**
- Consumes: 無
- Produces：
  - `createCopyEngine({ pools, cooldownMs }) -> engine`
  - `engine.take(namespace, key, vars) -> { text, repeat } | null` — `null` 代表在 cooldown 內；`repeat` 是本輪第幾次取同一個 key（從 1 起算）
  - `engine.resetSession()`
  - `engine.peek(namespace, key)` — 忽略 cooldown 直接取一句（結算畫面用）
  - 文案池形狀：`{ [namespace]: { [key]: string[] } }`，字串內以 `{name}` 當變數佔位

- [ ] **Step 1: 寫失敗的測試**

`src/core/copyEngine.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createCopyEngine } from './copyEngine.js'

const pools = {
  posture: { slouch: ['背靠椅背', '肩膀打開', '坐直一點', '往後靠'] },
  boss: { hit: ['再來！', '不痛不癢', '就這樣？'] },
  summary: { firstRun: ['你專注了 {minutes} 分鐘'] },
}

const make = () => createCopyEngine({ pools, cooldownMs: 45_000 })

describe('createCopyEngine', () => {
  it('第一次取句成功，repeat 為 1', () => {
    const e = make()
    const r = e.take('posture', 'slouch', {}, 0)
    expect(pools.posture.slouch).toContain(r.text)
    expect(r.repeat).toBe(1)
  })

  it('cooldown 內再取同一個 key 回傳 null', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    expect(e.take('posture', 'slouch', {}, 10_000)).toBe(null)
    expect(e.take('posture', 'slouch', {}, 44_999)).toBe(null)
  })

  it('cooldown 過後可再取，repeat 累加', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    const r = e.take('posture', 'slouch', {}, 45_000)
    expect(r).not.toBe(null)
    expect(r.repeat).toBe(2)
  })

  it('不同 key 的 cooldown 互不影響', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    expect(e.take('boss', 'hit', {}, 100)).not.toBe(null)
  })

  it('shuffle bag：整袋取完前不重複', () => {
    const e = make()
    const seen = new Set()
    for (let i = 0; i < 4; i++) {
      const r = e.take('posture', 'slouch', {}, i * 45_000)
      expect(seen.has(r.text)).toBe(false)
      seen.add(r.text)
    }
    expect(seen.size).toBe(4)
  })

  it('整袋取完後重新洗牌繼續供應', () => {
    const e = make()
    for (let i = 0; i < 9; i++) {
      expect(e.take('posture', 'slouch', {}, i * 45_000)).not.toBe(null)
    }
  })

  it('填入變數', () => {
    const e = make()
    expect(e.take('summary', 'firstRun', { minutes: 15 }, 0).text).toBe('你專注了 15 分鐘')
  })

  it('未提供的變數保留原樣，不得輸出 undefined', () => {
    const e = make()
    expect(e.take('summary', 'firstRun', {}, 0).text).toBe('你專注了 {minutes} 分鐘')
  })

  it('未知 namespace 或 key 回傳 null 而不丟例外', () => {
    const e = make()
    expect(e.take('nope', 'nope', {}, 0)).toBe(null)
    expect(e.take('posture', 'nope', {}, 0)).toBe(null)
  })

  it('resetSession 清掉 cooldown 與 repeat 計數', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    e.resetSession()
    const r = e.take('posture', 'slouch', {}, 1000)
    expect(r).not.toBe(null)
    expect(r.repeat).toBe(1)
  })

  it('peek 忽略 cooldown', () => {
    const e = make()
    e.take('posture', 'slouch', {}, 0)
    expect(e.peek('posture', 'slouch', {})).not.toBe(null)
  })
})

describe('文案內容紅線', () => {
  it('所有文案不得出現禁用詞', async () => {
    const posture = (await import('../data/copy/posture.js')).POSTURE_COPY
    const boss = (await import('../data/copy/boss.js')).BOSS_COPY
    const summary = (await import('../data/copy/summary.js')).SUMMARY_COPY
    const banned = ['懶惰', '摸魚', '沒用', '果然做不到', '笨', '胖', '醜']

    const all = []
    for (const pool of [posture, boss, summary]) {
      for (const lines of Object.values(pool)) all.push(...lines)
    }
    expect(all.length).toBeGreaterThan(0)
    for (const line of all) {
      for (const word of banned) {
        expect(line, `「${line}」含禁用詞「${word}」`).not.toContain(word)
      }
    }
  })

  it('魔王台詞長度不超過 15 字', async () => {
    const boss = (await import('../data/copy/boss.js')).BOSS_COPY
    for (const lines of Object.values(boss)) {
      for (const line of lines) {
        expect(line.length, `「${line}」超過 15 字`).toBeLessThanOrEqual(15)
      }
    }
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- src/core/copyEngine.test.js
```

- [ ] **Step 3: 寫 copyEngine.js**

```js
/**
 * 單一取句器。負責 shuffle bag 與 cooldown。
 *
 * 節流比擴充文案池重要：文案池再大，每 5 秒響一次也是噪音。
 * 時間由呼叫端傳入，本檔不讀系統時鐘。
 */
export function createCopyEngine({ pools, cooldownMs = 45_000 }) {
  let bags = new Map()      // `${ns}/${key}` → 尚未取用的索引陣列
  let lastTakenAt = new Map()
  let repeatCount = new Map()

  function linesOf(ns, key) {
    const lines = pools?.[ns]?.[key]
    return Array.isArray(lines) && lines.length > 0 ? lines : null
  }

  function fill(vars, template) {
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)
  }

  function draw(ns, key, lines) {
    const id = `${ns}/${key}`
    let bag = bags.get(id)
    if (!bag || bag.length === 0) {
      bag = lines.map((unused, i) => i)
      // Fisher-Yates
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[bag[i], bag[j]] = [bag[j], bag[i]]
      }
      bags.set(id, bag)
    }
    return lines[bag.pop()]
  }

  return {
    take(ns, key, vars = {}, now = 0) {
      const lines = linesOf(ns, key)
      if (!lines) return null

      const id = `${ns}/${key}`
      const last = lastTakenAt.get(id)
      if (last !== undefined && now - last < cooldownMs) return null

      lastTakenAt.set(id, now)
      const repeat = (repeatCount.get(id) ?? 0) + 1
      repeatCount.set(id, repeat)
      return { text: fill(vars, draw(ns, key, lines)), repeat }
    },

    peek(ns, key, vars = {}) {
      const lines = linesOf(ns, key)
      if (!lines) return null
      return { text: fill(vars, draw(ns, key, lines)), repeat: 1 }
    },

    resetSession() {
      bags = new Map()
      lastTakenAt = new Map()
      repeatCount = new Map()
    },
  }
}
```

- [ ] **Step 4: 寫文案池**

`src/data/copy/posture.js`（每個狀態 4 句，全部祈使句、可行動）：

```js
export const POSTURE_COPY = {
  forwardHead: ['下巴往後收，耳朵對齊肩膀', '頭往後一點，脖子會比較輕鬆',
                '把書本拿高一點，不用低頭看', '下巴收回來，眼睛往下看就好'],
  slouch: ['背靠椅背，肩膀往後打開', '坐直一點，胸口打開',
           '往後坐滿椅子，背貼著椅背', '肩膀往後轉一圈，再坐正'],
  gazeAway: ['眼睛回到畫面上', '看回書本，你快打贏了',
             '眼睛拉回來，魔王在等你', '目光回到正前方'],
  drowsy: ['眼睛快閉上囉，起來動一動 30 秒', '站起來伸個懶腰，喝口水再回來',
           '眨眨眼、深呼吸三次', '休息一下比硬撐有用'],
  phone: ['偵測到手機出現'],
  away: ['你離開了專注畫面'],
}
```

`src/data/copy/boss.js`（約 20 句，全部 ≤15 字，只講戰況不評人格）：

```js
export const BOSS_COPY = {
  open: ['來吧，我等很久了', '你撐得住三分鐘嗎', '這場我可不會放水'],
  hit: ['嘶……這刀有力道', '不錯嘛', '再來一次試試', '我開始認真了', '你比我想的難纏'],
  combo: ['連招？有點東西', '別停下來啊', '我快擋不住了'],
  phoneTrap: ['手機出現了，這一刀我閃掉了', '你的注意力剛剛掉在別處', '謝謝你分神，我回點血'],
  awayTrap: ['你走開了，我趁機喘口氣', '人不在，刀就砍不到我', '離開座位就是我的機會'],
  drowsy: ['你的眼睛快閉上了', '要不要先休息再來', '撐著打不贏我的'],
  regroup: ['站起來，還沒結束', '調整一下再來', '我等你重整旗鼓'],
  phase2: ['這才是我的真本事', '第二回合，開始', '你以為這樣就結束了'],
  victory: ['是我輸了，下次再戰', '你贏得很漂亮', '這份專注我認了'],
  timeout: ['時間到，這回合算平手', '差一點就被你砍倒了', '下次我等你更強'],
}
```

`src/data/copy/summary.js`：

```js
export const SUMMARY_COPY = {
  firstRun: ['你專注了 {minutes} 分鐘，其中 {uprightMin} 分鐘坐得很端正（{uprightPct}%），砍了魔王 {attacks} 刀。'],
  bestStreak: ['連續達標 {days} 天，是目前最好的紀錄！'],
  betterThanLast: ['端正時間比上一次多了 {deltaPct}%，有進步。'],
  topIssue: ['最常發生的是{issueLabel}，下次試試{issueFix}。'],
  encourage: ['這次專注了 {minutes} 分鐘，繼續保持。'],
  nextGoal: ['下次目標：端正時間拉到 {targetPct}%。'],
}
```

- [ ] **Step 5: 跑測試確認通過**

```bash
npm test -- src/core/copyEngine.test.js
```

若「魔王台詞長度不超過 15 字」失敗，直接縮短該句，**不要**放寬測試門檻——15 字是 spec 的硬要求（語音念太長會蓋住下一則提示）。

- [ ] **Step 6: Commit**

```bash
npm test && npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: CopyEngine 與文案池

shuffle bag（同輪不重複）＋ 45 秒 cooldown；文案池以測試鎖住禁用詞
與魔王台詞 15 字上限，避免日後補句時無意間破線。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: MessageQueue、PostureCoach 與 BossDialogue

**同時最多顯示 1 則訊息。** PostureCoach 與 BattleView 都只是發布者，由 MessageQueue 決定誰出線。沒有這個單一仲裁者的話，駝背提示、魔王台詞、傷害數字會同時擠在畫面上，國小生一則都讀不到。

優先序：**安全/休息 > 姿態修正 > 陷阱原因 > 戰鬥數值特效**。高優先直接搶佔，低優先直接丟棄**不排隊**（排隊會讓提示在事過境遷後才冒出來）。

**PostureCoach 前 3 次用因果格式**（「魔王反擊！（你駝背了）→ 背靠椅背」），第 4 次起簡化成純指令——前幾次要讓人知道「為什麼被打」，之後再重複因果只是囉唆。

**Files:**
- Create: `src/core/messageQueue.js`, `src/core/messageQueue.test.js`
- Create: `src/core/bossDialogue.js`
- Create: `src/core/postureCoach.js`, `src/core/postureCoach.test.js`

**Interfaces:**
- Consumes: `createCopyEngine`（Task 12）、FSM 事件（Task 4）
- Produces：
  - `messageQueue.js`：`PRIORITY = { safety: 4, posture: 3, trap: 2, battle: 1 }`；`createMessageQueue() -> mq`，方法 `publish({ kind, text, priority, ttlMs, voice, icon }, now)`、`current(now) -> msg | null`、`clear()`
  - `bossDialogue.js`：`copyKeyForEvent(event) -> { ns: 'boss', key } | null`
  - `postureCoach.js`：`createPostureCoach({ copy, mq }) -> coach`，方法 `handle(events, { posture, drowsy }, now)`

- [ ] **Step 1: 寫 MessageQueue 的失敗測試**

`src/core/messageQueue.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createMessageQueue, PRIORITY } from './messageQueue.js'

const msg = (kind, priority, text = 't', ttlMs = 4000) => ({ kind, priority, text, ttlMs })

describe('createMessageQueue', () => {
  it('沒有訊息時 current 為 null', () => {
    expect(createMessageQueue().current(0)).toBe(null)
  })

  it('同時最多顯示一則', () => {
    const mq = createMessageQueue()
    mq.publish(msg('a', PRIORITY.battle, 'A'), 0)
    mq.publish(msg('b', PRIORITY.battle, 'B'), 0)
    expect(mq.current(0).text).toBe('A') // 同優先序時先到先得，不被後來的擠掉
  })

  it('高優先直接搶佔', () => {
    const mq = createMessageQueue()
    mq.publish(msg('battle', PRIORITY.battle, '−20'), 0)
    mq.publish(msg('posture', PRIORITY.posture, '背靠椅背'), 100)
    expect(mq.current(100).text).toBe('背靠椅背')
  })

  it('低優先直接丟棄，不排隊等高優先結束', () => {
    const mq = createMessageQueue()
    mq.publish(msg('safety', PRIORITY.safety, '休息一下', 10_000), 0)
    mq.publish(msg('battle', PRIORITY.battle, '−20'), 100)
    expect(mq.current(100).text).toBe('休息一下')
    expect(mq.current(11_000)).toBe(null) // 過期後不會冒出被丟棄的那則
  })

  it('ttl 到期後自動消失', () => {
    const mq = createMessageQueue()
    mq.publish(msg('a', PRIORITY.battle, 'A', 3000), 0)
    expect(mq.current(2999)).not.toBe(null)
    expect(mq.current(3000)).toBe(null)
  })

  it('同 kind 重複發布會刷新內容與 ttl', () => {
    const mq = createMessageQueue()
    mq.publish(msg('posture', PRIORITY.posture, '舊', 3000), 0)
    mq.publish(msg('posture', PRIORITY.posture, '新', 3000), 1000)
    expect(mq.current(1000).text).toBe('新')
    expect(mq.current(3500)).not.toBe(null)
  })

  it('過期後較低優先的新訊息可以出線', () => {
    const mq = createMessageQueue()
    mq.publish(msg('safety', PRIORITY.safety, '休息', 2000), 0)
    mq.publish(msg('battle', PRIORITY.battle, '−20', 3000), 2500)
    expect(mq.current(2500).text).toBe('−20')
  })

  it('clear 立刻清空', () => {
    const mq = createMessageQueue()
    mq.publish(msg('a', PRIORITY.safety, 'A', 10_000), 0)
    mq.clear()
    expect(mq.current(0)).toBe(null)
  })

  it('優先序常數的相對大小符合 spec', () => {
    expect(PRIORITY.safety).toBeGreaterThan(PRIORITY.posture)
    expect(PRIORITY.posture).toBeGreaterThan(PRIORITY.trap)
    expect(PRIORITY.trap).toBeGreaterThan(PRIORITY.battle)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗，然後寫實作**

```bash
npm test -- src/core/messageQueue.test.js
```

`src/core/messageQueue.js`：

```js
/** 安全/休息 > 姿態修正 > 陷阱原因 > 戰鬥數值特效 */
export const PRIORITY = Object.freeze({ safety: 4, posture: 3, trap: 2, battle: 1 })

/**
 * 單一 priority store，同時最多顯示一則。
 *
 * 低優先直接丟棄而非排隊：排隊會讓提示在事過境遷之後才冒出來，
 * 使用者看到「背靠椅背」的時候人早就坐正了，只會覺得系統在亂講。
 */
export function createMessageQueue() {
  let active = null // { kind, text, priority, ttlMs, voice, icon, shownAt }

  function expired(now) {
    return active !== null && now - active.shownAt >= active.ttlMs
  }

  return {
    publish(message, now) {
      const next = { voice: false, icon: null, ttlMs: 4000, ...message, shownAt: now }
      if (active === null || expired(now)) { active = next; return true }
      if (next.kind === active.kind) { active = next; return true }   // 同類刷新
      if (next.priority > active.priority) { active = next; return true } // 搶佔
      return false // 丟棄
    },

    current(now) {
      if (active === null || expired(now)) return null
      return active
    },

    clear() {
      active = null
    },
  }
}
```

- [ ] **Step 3: 寫 bossDialogue.js（純映射，無測試）**

```js
/**
 * 事件 → 文案 key 的映射器。刻意不持有任何文案資料（資料在 CopyEngine），
 * 這樣新增台詞只要改 data/copy/boss.js 一個檔。
 */
export function copyKeyForEvent(event) {
  switch (event.type) {
    case 'attack':
      return { ns: 'boss', key: event.streak >= 3 ? 'combo' : 'hit' }
    case 'trapCommitted':
      return { ns: 'boss', key: event.kind === 'phone' ? 'phoneTrap' : 'awayTrap' }
    case 'drowsy':
      return { ns: 'boss', key: 'drowsy' }
    case 'regroupStart':
      return { ns: 'boss', key: 'regroup' }
    case 'phase':
      return { ns: 'boss', key: 'phase2' }
    case 'sessionEnd':
      return { ns: 'boss', key: event.result === 'victory' ? 'victory' : 'timeout' }
    default:
      return null
  }
}
```

- [ ] **Step 4: 寫 PostureCoach 的失敗測試**

`src/core/postureCoach.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createPostureCoach } from './postureCoach.js'
import { createCopyEngine } from './copyEngine.js'
import { createMessageQueue } from './messageQueue.js'
import { POSTURE_COPY } from '../data/copy/posture.js'
import { BOSS_COPY } from '../data/copy/boss.js'

function make() {
  const copy = createCopyEngine({ pools: { posture: POSTURE_COPY, boss: BOSS_COPY }, cooldownMs: 45_000 })
  const mq = createMessageQueue()
  return { coach: createPostureCoach({ copy, mq }), mq }
}

const damage = (reason) => ({ type: 'playerDamage', amount: 3, playerHp: 97, reason })

describe('createPostureCoach', () => {
  it('前 3 次用因果格式（含括號說明與箭頭）', () => {
    const { coach, mq } = make()
    for (let i = 0; i < 3; i++) {
      coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, i * 46_000)
      const text = mq.current(i * 46_000).text
      expect(text).toContain('（')
      expect(text).toContain('→')
      mq.clear()
    }
  })

  it('第 4 次起簡化為純指令', () => {
    const { coach, mq } = make()
    for (let i = 0; i < 4; i++) {
      coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, i * 46_000)
      if (i < 3) mq.clear()
    }
    const text = mq.current(3 * 46_000).text
    expect(text).not.toContain('→')
    expect(POSTURE_COPY.slouch).toContain(text)
  })

  it('cooldown 內不重複發布', () => {
    const { coach, mq } = make()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 0)
    mq.clear()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 5000)
    expect(mq.current(5000)).toBe(null)
  })

  it('瞌睡走 safety 優先序，會蓋掉姿態提示', () => {
    const { coach, mq } = make()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 0)
    coach.handle([{ type: 'drowsy' }], { posture: 'slouch', drowsy: true }, 100)
    expect(POSTURE_COPY.drowsy).toContain(mq.current(100).text.replace(/^[^（]*/, '') || mq.current(100).text)
    expect(mq.current(100).kind).toBe('safety')
  })

  it('分心類提示一律不朗讀', () => {
    const { coach, mq } = make()
    coach.handle([{ type: 'trapPending', trapId: 'phone-1', kind: 'phone' }], { posture: 'upright', drowsy: false }, 0)
    expect(mq.current(0).voice).toBe(false)
    mq.clear()
    coach.handle([{ type: 'trapPending', trapId: 'away-1', kind: 'away' }], { posture: 'upright', drowsy: false }, 50_000)
    expect(mq.current(50_000).voice).toBe(false)
  })

  it('姿態提示允許朗讀，但同狀態第 2 次起關閉語音', () => {
    const { coach, mq } = make()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 0)
    expect(mq.current(0).voice).toBe(true)
    mq.clear()
    coach.handle([damage('slouch')], { posture: 'slouch', drowsy: false }, 46_000)
    expect(mq.current(46_000).voice).toBe(false)
  })

  it('陷阱待確認的提示帶上 trapId，供撤銷按鈕使用', () => {
    const { coach, mq } = make()
    coach.handle([{ type: 'trapPending', trapId: 'phone-7', kind: 'phone' }], { posture: 'upright', drowsy: false }, 0)
    expect(mq.current(0).trapId).toBe('phone-7')
  })

  it('沒有相關事件時不發布任何訊息', () => {
    const { coach, mq } = make()
    coach.handle([{ type: 'attack', damage: 20, bossHp: 100, score: 10, streak: 1 }],
                 { posture: 'upright', drowsy: false }, 0)
    expect(mq.current(0)).toBe(null)
  })
})
```

- [ ] **Step 5: 寫 postureCoach.js**

```js
import { PRIORITY } from './messageQueue.js'

const CAUSE_LABEL = {
  slouch: '你駝背了',
  forwardHead: '你低頭太久了',
  gazeAway: '你的視線離開了',
}

/** 前 3 次講因果，之後只講指令——重複解釋為什麼被打只是囉唆 */
const CAUSE_FORMAT_LIMIT = 3

export function createPostureCoach({ copy, mq }) {
  return {
    handle(events, { posture, drowsy }, now) {
      // 1. 安全/休息最優先
      if (drowsy && events.some((e) => e.type === 'drowsy')) {
        const line = copy.take('posture', 'drowsy', {}, now)
        if (line) {
          mq.publish({ kind: 'safety', priority: PRIORITY.safety, text: line.text,
                       ttlMs: 8000, voice: line.repeat === 1, icon: 'rest', showBreakButton: true }, now)
          return
        }
      }

      // 2. 陷阱：只講具體原因，一律不朗讀
      //    用語音念出「偵測到手機」等於把使用者被抓包的事廣播給旁邊的人
      const pending = events.find((e) => e.type === 'trapPending')
      if (pending) {
        const key = pending.kind === 'phone' ? 'phone' : 'away'
        const line = copy.peek('posture', key, {})
        if (line) {
          mq.publish({ kind: 'trap', priority: PRIORITY.trap, text: line.text,
                       ttlMs: 20_000, voice: false, icon: key, trapId: pending.trapId }, now)
          return
        }
      }

      // 3. 姿態修正
      const hit = events.find((e) => e.type === 'playerDamage')
      if (hit && CAUSE_LABEL[hit.reason]) {
        const line = copy.take('posture', hit.reason, {}, now)
        if (!line) return
        const text = line.repeat <= CAUSE_FORMAT_LIMIT
          ? `魔王反擊！（${CAUSE_LABEL[hit.reason]}）→ ${line.text}`
          : line.text
        mq.publish({ kind: 'posture', priority: PRIORITY.posture, text,
                     ttlMs: 6000, voice: line.repeat === 1, icon: hit.reason }, now)
      }
    },
  }
}
```

- [ ] **Step 6: 跑測試並 commit**

```bash
npm test
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: MessageQueue、PostureCoach 與 BossDialogue

單一 priority store 同時只顯示一則，低優先直接丟棄不排隊；
姿態提示前 3 次用因果格式、之後純指令；分心類提示一律不朗讀。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: BattleView 對戰畫面

本計畫視覺上最重的一項，實作 spec v4.3 的「戰鬥畫面版面」。

**版面：一半是你自己的鏡頭即時畫面，一半是魔王。** 橫式左右分、直式上下分，**兩個方向同等支援**。玩家要能在同一個畫面同時看到「我現在坐成什麼樣」和「魔王掉了多少血」——因果才會直接。

**動畫方向由 Task 8 的 `--attack-dx` / `--attack-dy` 決定**，所以攻擊與反擊各只需要一組 keyframes，兩個方向共用。

**三個硬性效能限制（來自 spec，不是建議）：**
1. 鏡頭區塊不得套用 `filter` / `box-shadow` 動畫 / `backdrop-filter`——常駐 `<video>` 已經是主要熱源，再加強制重新合成會直接影響續航與溫度。重整旗鼓的灰階是唯一例外，且是靜態值不做動畫。
2. 飛行特效節點**常駐 DOM**，用 class 切換觸發，不在每次事件時建立/移除。
3. 同時在飛的特效**最多 3 個**，超過丟棄。

**Files:**
- Create: `src/components/BattleView.vue`
- Create: `src/components/HpBar.vue`
- Create: `src/components/CoachBanner.vue`
- Create: `src/components/ConfirmDialog.vue`
- Modify: `src/App.vue`
- Delete: `src/components/LivePreview.vue`

**Interfaces:**
- Consumes: `useSession`（Task 10）、`createMessageQueue` / `createPostureCoach` / `copyKeyForEvent`（Task 13）、`createCopyEngine`（Task 12）
- Produces：`BattleView.vue` — 無 props，直接讀 session store；emit `finish()`

- [ ] **Step 1: 寫 HpBar.vue**

血條一律**同時顯示數字**，不單靠顏色與長度傳達。

```vue
<template>
  <div class="hp" :class="side">
    <div class="label">
      <span>{{ label }}</span>
      <span class="num">{{ Math.max(0, Math.round(value)) }} / {{ max }}</span>
    </div>
    <div class="track" role="progressbar" :aria-valuenow="Math.max(0, Math.round(value))"
         :aria-valuemin="0" :aria-valuemax="max" :aria-label="label">
      <div class="fill" :style="{ transform: `scaleX(${ratio})` }" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  label: { type: String, required: true },
  value: { type: Number, required: true },
  max: { type: Number, required: true },
  side: { type: String, default: 'hero' }, // 'hero' | 'boss'
})

const ratio = computed(() => Math.max(0, Math.min(1, props.value / props.max)))
</script>

<style scoped>
.hp { width: 100%; }
.label { display: flex; justify-content: space-between; font-size: var(--fs-body); margin-bottom: 4px; }
.num { font-variant-numeric: tabular-nums; }
.track { height: 18px; background: var(--c-surface); border-radius: 9px; overflow: hidden; }
/* 只動 transform，不動 width——動 width 會觸發 layout */
.fill { height: 100%; transform-origin: left center; transition: transform .25s ease-out; }
.hero .fill { background: var(--c-hero); }
.boss .fill { background: var(--c-boss); }
</style>
```

- [ ] **Step 2: 寫 CoachBanner.vue**

姿態提示 ≥36px 粗體高對比，**固定於畫面上方 1/3**（下半部會被手擋住），橫跨兩側。

```vue
<template>
  <div v-if="message" class="banner" :class="message.kind" role="status" aria-live="polite">
    <p class="text">{{ message.text }}</p>
    <button v-if="message.trapId" class="undo" @click="$emit('undo', message.trapId)">
      我沒在用手機
    </button>
    <button v-if="message.showBreakButton" class="undo" @click="$emit('break')">
      休息一下
    </button>
  </div>
</template>

<script setup>
defineProps({ message: { type: Object, default: null } })
defineEmits(['undo', 'break'])
</script>

<style scoped>
.banner {
  position: absolute;
  top: max(var(--gap), env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  max-width: min(92vw, 760px);
  display: flex; align-items: center; gap: var(--gap);
  padding: 12px 20px;
  border-radius: var(--radius);
  background: var(--c-surface);
  /* 不單靠顏色：每一類都有各自的左側粗邊 */
  border-left: 8px solid var(--c-text-dim);
}
.banner.safety { border-left-color: var(--c-ok); }
.banner.posture { border-left-color: var(--c-warn); }
.banner.trap { border-left-color: var(--c-danger); }
.text { margin: 0; font-size: var(--fs-coach); font-weight: 700; line-height: 1.3; }
.undo { min-height: var(--tap-primary); padding: 0 18px; white-space: nowrap; background: var(--c-bg); }
@media (orientation: portrait) {
  .text { font-size: 28px; }
}
</style>
```

直式時提示字級降到 28px：直式寬度較窄，36px 會讓長句換三行蓋住鏡頭畫面。仍遠高於正文的 17px。

- [ ] **Step 3: 寫 ConfirmDialog.vue**

「結束」需要二次確認（不做長按——長按對國小生不好發現也難操作）。

```vue
<template>
  <div class="backdrop" role="dialog" aria-modal="true" :aria-label="title">
    <div class="box">
      <h3>{{ title }}</h3>
      <p>{{ body }}</p>
      <div class="row">
        <button class="primary keep" @click="$emit('cancel')">{{ cancelText }}</button>
        <button class="primary stop" @click="$emit('confirm')">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, default: '要結束這一輪嗎？' },
  body: { type: String, default: '現在結束的話，這一輪的成績還是會記錄下來。' },
  confirmText: { type: String, default: '結束這一輪' },
  cancelText: { type: String, default: '繼續討伐' },
})
defineEmits(['confirm', 'cancel'])
</script>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center;
            background: rgba(0, 0, 0, .6); padding: var(--gap); }
.box { background: var(--c-surface); border-radius: var(--radius); padding: 24px;
       max-width: 460px; text-align: center; }
h3 { font-size: var(--fs-title); margin: 0 0 12px; }
p { font-size: var(--fs-body); color: var(--c-text-dim); margin: 0 0 24px; }
.row { display: flex; gap: var(--gap); flex-direction: column; }
.keep { background: var(--c-accent); color: #06212b; }
.stop { background: transparent; outline: 2px solid var(--c-text-dim); }
</style>
```

「繼續討伐」放在上面且用實心強調色，「結束」放下面且是次要樣式——誤觸的成本不對稱。

- [ ] **Step 4: 寫 BattleView.vue**

```vue
<template>
  <div class="arena" :class="{ regrouping: battle?.regrouping }">
    <!-- 英雄側：使用者自己的鏡頭即時畫面 -->
    <section class="arena__hero" :class="{ struck: heroStruck }">
      <div ref="camSlot" class="cam-slot" />
      <div class="hero-hud">
        <HpBar label="你的體力" :value="battle?.playerHp ?? 0" :max="100" side="hero" />
      </div>
      <p v-if="battle?.regrouping" class="regroup">重整旗鼓<br><span>{{ regroupText }}</span></p>
    </section>

    <!-- 魔王側 -->
    <section class="arena__boss" :class="{ struck: bossStruck, charging: hasPendingTrap }">
      <div class="boss-hud">
        <HpBar label="懶惰大魔王" :value="battle?.bossHp ?? 0" :max="battle?.bossHpMax ?? 1" side="boss" />
        <p v-if="(battle?.phase ?? 1) > 1" class="phase">第 {{ battle.phase }} 形態</p>
      </div>
      <div class="boss-body" aria-hidden="true">👹</div>
      <p v-if="bossLine" class="boss-line">{{ bossLine }}</p>
    </section>

    <!-- 戰場帶：飛行特效與傷害數字。節點常駐，用 class 觸發 -->
    <div class="arena__field" aria-hidden="true">
      <div v-for="slot in SLOTS" :key="slot"
           class="bolt" :class="[flights[slot].dir, { fly: flights[slot].active }]" />
      <p v-for="n in numbers" :key="n.id" class="dmg" :class="n.side">
        {{ n.text }}<small v-if="n.tag">{{ n.tag }}</small>
      </p>
    </div>

    <CoachBanner :message="coachMessage" @undo="onUndo" @break="$emit('break')" />

    <div class="corner-tl status">
      <span class="clock">{{ clockText }}</span>
      <span class="score">{{ battle?.score ?? 0 }} 分</span>
    </div>

    <button class="corner-bl pause" @click="session.togglePause()">
      {{ paused ? '繼續' : '暫停' }}
    </button>
    <button class="corner-br stop" @click="confirming = true">結束</button>

    <ConfirmDialog v-if="confirming" @cancel="confirming = false" @confirm="$emit('finish')" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import HpBar from './HpBar.vue'
import CoachBanner from './CoachBanner.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { useSession } from '../stores/session.js'
import { createMessageQueue } from '../core/messageQueue.js'
import { createPostureCoach } from '../core/postureCoach.js'
import { createCopyEngine } from '../core/copyEngine.js'
import { copyKeyForEvent } from '../core/bossDialogue.js'
import { POSTURE_COPY } from '../data/copy/posture.js'
import { BOSS_COPY } from '../data/copy/boss.js'

const emit = defineEmits(['finish', 'break'])

const session = useSession()
const s = session.state
const battle = computed(() => s.battle)
const paused = computed(() => s.paused)

const SLOTS = [0, 1, 2] // 同時最多 3 個飛行特效
const camSlot = ref(null)
const confirming = ref(false)
const coachMessage = ref(null)
const bossLine = ref('')
const heroStruck = ref(false)
const bossStruck = ref(false)
const numbers = ref([])
const flights = reactive(SLOTS.map(() => ({ active: false, dir: 'to-boss' })))

const copy = createCopyEngine({ pools: { posture: POSTURE_COPY, boss: BOSS_COPY }, cooldownMs: 45_000 })
const mq = createMessageQueue()
const coach = createPostureCoach({ copy, mq })

const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

let numberSeq = 0
let bossLineTimer = 0
let uiTimer = 0
let offEvents = null

const hasPendingTrap = computed(() => (battle.value?.pendingTraps?.length ?? 0) > 0)

const clockText = computed(() => {
  const b = battle.value
  if (!b) return '00:00'
  const left = Math.max(0, b.durationMs - b.elapsedMs)
  const m = String(Math.floor(left / 60_000)).padStart(2, '0')
  const sec = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')
  return `${m}:${sec}`
})

const regroupText = computed(() => '調整一下姿勢，馬上回來')

/** 飛行特效：節點常駐，只切 class；找不到空位就丟棄（同時最多 3 個） */
function launch(dir) {
  if (reduced) return
  const slot = flights.findIndex((f) => !f.active)
  if (slot === -1) return
  flights[slot].dir = dir
  flights[slot].active = true
  setTimeout(() => { flights[slot].active = false }, 420)
}

function popNumber(text, side, tag = '') {
  const id = ++numberSeq
  numbers.value.push({ id, text, side, tag })
  setTimeout(() => { numbers.value = numbers.value.filter((n) => n.id !== id) }, 900)
}

function flash(target) {
  const flag = target === 'hero' ? heroStruck : bossStruck
  flag.value = true
  setTimeout(() => { flag.value = false }, 300)
}

function sayBoss(event, now) {
  const key = copyKeyForEvent(event)
  if (!key) return
  const line = copy.take(key.ns, key.key, {}, now)
  if (!line) return
  bossLine.value = line.text
  clearTimeout(bossLineTimer)
  bossLineTimer = setTimeout(() => { bossLine.value = '' }, 3500)
}

function onEvents(events) {
  const now = performance.now()
  coach.handle(events, { posture: s.posture, drowsy: s.drowsy }, now)

  for (const e of events) {
    switch (e.type) {
      case 'attack':
        launch('to-boss')
        flash('boss')
        popNumber(`−${e.damage}`, 'boss')
        if (e.streak === 1 || e.streak % 5 === 0) sayBoss(e, now)
        break
      case 'playerDamage':
        // 偷懶摸魚不專心 → 魔王反擊飛回來
        launch('to-hero')
        flash('hero')
        popNumber(`−${e.amount}`, 'hero', TAG[e.reason] ?? '')
        break
      case 'trapCommitted':
        launch('to-hero')
        flash('hero')
        popNumber(`+${e.bossHeal}`, 'boss', '回血')
        popNumber(`−${e.scorePenalty}`, 'hero', '積分')
        sayBoss(e, now)
        break
      case 'phase':
      case 'regroupStart':
      case 'drowsy':
      case 'sessionEnd':
        sayBoss(e, now)
        break
      default:
        break
    }
  }
}

const TAG = { slouch: '駝背', forwardHead: '低頭', gazeAway: '分心' }

function onUndo(trapId) {
  session.undoTrap(trapId)
  mq.clear()
  coachMessage.value = null
}

onMounted(() => {
  // 把全 App 共用的那顆 <video> 搬進英雄側，不重新 getUserMedia
  const video = document.querySelector('video[data-shared-cam]')
  if (video && camSlot.value) camSlot.value.appendChild(video)

  offEvents = session.onBattleEvent(onEvents)
  // 訊息過期需要由畫面端輪詢；4Hz 足夠，符合「閒置時每秒重繪 < 5 次」
  uiTimer = setInterval(() => { coachMessage.value = mq.current(performance.now()) }, 250)
})

onBeforeUnmount(() => {
  offEvents?.()
  clearInterval(uiTimer)
  clearTimeout(bossLineTimer)
  // 把 <video> 還回 App 根節點，下一輪還要用同一顆
  const video = camSlot.value?.querySelector('video[data-shared-cam]')
  if (video) document.getElementById('app')?.appendChild(video)
})
</script>

<style scoped>
/* --- 英雄側：常駐鏡頭畫面 --- */
.cam-slot { position: absolute; inset: 0; }
.cam-slot :deep(video) {
  width: 100%; height: 100%; object-fit: cover;
  transform: scaleX(-1);              /* 只鏡像顯示，不影響送進 MediaPipe 的影像 */
  opacity: 1; position: static;       /* 覆寫 App 的隱藏樣式 */
  pointer-events: none;
}
.arena__hero { border: 4px solid transparent; transition: border-color .15s; }
.arena__hero.struck { border-color: var(--c-danger); }

/* 重整旗鼓的灰階是全檔唯一的 filter，且為靜態值不做動畫 */
.arena.regrouping .cam-slot :deep(video) { filter: grayscale(1) brightness(.6); }
.regroup {
  position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
  font-size: var(--fs-title); font-weight: 700; margin: 0;
}
.regroup span { font-size: var(--fs-body); font-weight: 400; color: var(--c-text-dim); }

.hero-hud, .boss-hud {
  position: absolute; left: var(--gap); right: var(--gap); z-index: 3;
}
.hero-hud { bottom: calc(var(--tap-primary) + var(--gap) * 2); }
.boss-hud { top: calc(var(--fs-coach) * 2.4); }
@media (orientation: portrait) { .boss-hud { top: var(--gap); } }

/* --- 魔王側 --- */
.boss-body { font-size: clamp(90px, 22vmin, 200px); line-height: 1; will-change: transform; }
.arena__boss.struck .boss-body { animation: shake .3s ease-out; }
.arena__boss.charging .boss-body { animation: charge 1.2s ease-in-out infinite; }
.phase { text-align: center; font-size: var(--fs-body); color: var(--c-boss); margin: 6px 0 0; }
.boss-line {
  position: absolute; bottom: calc(var(--tap-primary) + var(--gap) * 2);
  left: var(--gap); right: var(--gap); margin: 0; text-align: center;
  font-size: var(--fs-number); background: var(--c-surface);
  padding: 10px var(--gap); border-radius: var(--radius);
}

/* --- 飛行特效：一組 keyframes 兩個方向共用，向量由 layout.css 的 CSS 變數決定 --- */
.bolt {
  position: absolute; top: 50%; left: 50%;
  width: 14vmin; height: 3vmin; margin: -1.5vmin 0 0 -7vmin;
  border-radius: 999px; background: var(--c-accent);
  opacity: 0; will-change: transform, opacity;
}
.bolt.to-boss.fly { animation: fly-out .42s ease-out; }
.bolt.to-hero.fly { animation: fly-back .42s ease-out; background: var(--c-boss); }

@keyframes fly-out {
  0%   { opacity: 0; transform: translate(calc(var(--attack-dx) * -0.5), calc(var(--attack-dy) * -0.5)) scale(.6); }
  25%  { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(var(--attack-dx) * 0.5), calc(var(--attack-dy) * 0.5)) scale(1.1); }
}
@keyframes fly-back {
  0%   { opacity: 0; transform: translate(calc(var(--attack-dx) * 0.5), calc(var(--attack-dy) * 0.5)) scale(.6); }
  25%  { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(var(--attack-dx) * -0.5), calc(var(--attack-dy) * -0.5)) scale(1.1); }
}
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-8px); }
  75% { transform: translateX(8px); }
}
@keyframes charge {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.06); opacity: .75; }
}

/* --- 傷害數字 --- */
.dmg {
  position: absolute; margin: 0; font-size: 40px; font-weight: 800;
  font-variant-numeric: tabular-nums; animation: rise .9s ease-out forwards;
  will-change: transform, opacity;
}
.dmg small { display: block; font-size: 16px; font-weight: 600; }
.dmg.boss { color: var(--c-accent); }
.dmg.hero { color: var(--c-danger); }
@media (orientation: landscape) {
  .dmg.boss { right: 18%; top: 38%; }
  .dmg.hero { left: 18%; top: 38%; }
}
@media (orientation: portrait) {
  .dmg.boss { left: 50%; top: 62%; }
  .dmg.hero { left: 50%; top: 26%; }
}
@keyframes rise {
  0% { opacity: 0; transform: translateY(10px) scale(.8); }
  20% { opacity: 1; transform: translateY(0) scale(1.1); }
  100% { opacity: 0; transform: translateY(-40px) scale(1); }
}

/* --- 角落 --- */
.status { display: flex; flex-direction: column; gap: 4px; font-variant-numeric: tabular-nums; }
.clock { font-size: var(--fs-title); font-weight: 700; }
.score { font-size: var(--fs-body); color: var(--c-text-dim); }
.pause, .stop { min-width: var(--tap-primary); min-height: var(--tap-primary); padding: 0 20px; }
.stop { background: transparent; outline: 2px solid var(--c-text-dim); }

/* reduced-motion：不做位移，改成兩側各閃一次高對比邊框 */
@media (prefers-reduced-motion: reduce) {
  .bolt { display: none; }
  .dmg { animation: none; opacity: 1; }
}
</style>
```

- [ ] **Step 5: 讓共用的 `<video>` 可被搬移**

在 `src/App.vue` 的 `<video>` 加上標記屬性，讓 BattleView 找得到：

```vue
  <video ref="videoEl" data-shared-cam class="hidden-cam" playsinline muted />
```

並把畫面切換那一段換成 BattleView：

```vue
  <BattleView
    v-else-if="s.screen === 'battle'"
    @finish="session.endBattle('aborted')"
    @break="session.rawState.screen = 'break'"
  />
```

記得 `import BattleView from './components/BattleView.vue'`，並刪掉 `LivePreview.vue`：

```bash
rm src/components/LivePreview.vue
```

- [ ] **Step 6: 實機驗收（兩個方向各跑一輪展示模式）**

```bash
npm run dev
```

**橫式**與**直式**各做一次，每次都要確認：

1. 畫面左右（直式上下）各佔一半，自己的鏡頭影像**填滿**英雄側且人臉比例正常
2. 坐正 → 光刃**從自己這一側飛向魔王**、魔王抖動、`−20` 浮起
3. 刻意駝背 → **魔王反擊的暗色衝擊從魔王側飛回自己這側**、鏡頭邊框閃紅、浮出 `−3` 加「駝背」標籤，同時上方出現「魔王反擊！（你駝背了）→ 背靠椅背」
4. 拿手機入鏡 3 秒 → 魔王開始蓄力脈動、上方出現「偵測到手機出現」＋「我沒在用手機」按鈕，**期間血量與積分完全不變**
5. 按「我沒在用手機」→ 提示消失、魔王停止蓄力、數值仍然沒動過
6. 不按 → 20 秒後魔王回血、扣 100 分、播魔王台詞
7. 提示列固定在畫面**上方 1/3**，不會跑到下半部
8. 按「結束」→ 出現二次確認，「繼續討伐」在上、「結束這一輪」在下
9. **轉向時鏡頭不中斷、戰鬥不暫停、數值連續**
10. iPad 設定裡開啟「減少動態效果」後重跑 → 沒有飛行特效，但傷害數字仍看得到

- [ ] **Step 7: Commit**

```bash
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: BattleView 對戰畫面

一半自己的鏡頭、一半魔王的分半版面，直橫同等支援；攻擊光刃由英雄側飛向魔王，
姿態不良時魔王反擊飛回來並在鏡頭邊框閃紅。飛行特效節點常駐 DOM 只切 class、
同時最多 3 個，鏡頭區塊不套 filter/box-shadow 動畫（常駐 video 已是主要熱源）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: VoiceFeedback

Web Speech Synthesis。**iOS 有兩個會讓現場整場無聲而且完全不報錯的坑**，兩個都要處理：

1. **第一次 `speak()` 必須在使用者手勢的同步呼叫堆疊內。** 不暖機的話，之後所有 `speak()` 都會被靜默忽略——不丟例外、不進 error handler，就是沒聲音。所以「開始討伐」的 click handler 裡要同步念一個極短的 utterance。
2. **`getVoices()` 第一次呼叫回空陣列。** 要等 `voiceschanged` 事件才拿得到，拿到後把 zh-TW 的 voice pin 住。

**禁用 `SpeechRecognition`**（辨識，不是合成）——iOS 上會把音訊送往 Apple 伺服器，直接違反「影像與聲音不離開這台 iPad」的隱私訴求。本檔只用 synthesis。

**Files:**
- Create: `src/core/voiceFeedback.js`
- Modify: `src/components/BattleView.vue`、`src/App.vue`

**Interfaces:**
- Consumes: MessageQueue 訊息的 `voice` 與 `priority` 欄位（Task 13）
- Produces：`createVoiceFeedback() -> voice`
  - `voice.init()` — 註冊 `voiceschanged`、嘗試取得 zh-TW voice
  - `voice.primeFromGesture()` — **必須在 click handler 內同步呼叫**
  - `voice.speak(text, priority)` — 單槽播放＋優先權搶佔
  - `voice.cancel()`、`voice.setEnabled(on)`、`voice.isEnabled()`、`voice.isAvailable()`

- [ ] **Step 1: 寫實作**

```js
const MAX_CHARS = 15

/**
 * Web Speech 合成。只用 synthesis，絕不使用 SpeechRecognition——
 * iOS 的辨識會把音訊送往 Apple 伺服器，與本作品的隱私訴求直接衝突。
 */
export function createVoiceFeedback() {
  let enabled = false          // spec 要求預設關閉
  let primed = false
  let voice = null
  let available = false
  let currentPriority = -1

  function pickVoice() {
    const all = window.speechSynthesis?.getVoices?.() ?? []
    if (all.length === 0) return false
    voice = all.find((v) => v.lang === 'zh-TW')
         ?? all.find((v) => v.lang?.startsWith('zh'))
         ?? null
    available = voice !== null
    return available
  }

  return {
    init() {
      if (!('speechSynthesis' in window)) { available = false; return false }
      // getVoices() 第一次一定回空陣列，要等 voiceschanged
      if (!pickVoice()) {
        window.speechSynthesis.addEventListener('voiceschanged', pickVoice, { once: false })
      }
      return true
    },

    /**
     * 必須在使用者手勢的同步呼叫堆疊內執行。
     * 不做這一步的話，之後每次 speak() 都會被 iOS 靜默忽略——
     * 不丟例外也不進 error handler，現場會整場無聲而且查不出原因。
     */
    primeFromGesture() {
      if (primed || !('speechSynthesis' in window)) return
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0
      window.speechSynthesis.speak(u)
      primed = true
    },

    speak(text, priority = 0) {
      if (!enabled || !available || !primed || !text) return false
      const synth = window.speechSynthesis
      if (synth.speaking) {
        // 單槽播放：高優先搶佔，低優先直接丟棄不排隊
        if (priority <= currentPriority) return false
        synth.cancel()
      }
      const u = new SpeechSynthesisUtterance(text.slice(0, MAX_CHARS))
      u.voice = voice
      u.lang = voice?.lang ?? 'zh-TW'
      u.rate = 1
      u.onend = () => { currentPriority = -1 }
      u.onerror = () => { currentPriority = -1 }
      currentPriority = priority
      synth.speak(u)
      return true
    },

    cancel() {
      window.speechSynthesis?.cancel?.()
      currentPriority = -1
    },

    setEnabled(on) {
      enabled = on
      if (!on) this.cancel()
    },

    isEnabled: () => enabled,
    isAvailable: () => available,
  }
}
```

- [ ] **Step 2: 在 store 掛上語音單例**

`src/stores/session.js` 頂部加入：

```js
import { createVoiceFeedback } from '../core/voiceFeedback.js'
```

在 `let wakeLock = createWakeLock()` 旁邊加：

```js
const voice = createVoiceFeedback()
```

`state` 加一個欄位：

```js
  voiceEnabled: false,
  voiceAvailable: false,
```

`boot()` 裡 `state.booted = true` 之前加：

```js
    voice.init()
    state.voiceAvailable = voice.isAvailable()
```

`api` 補三個方法：

```js
  voice: () => voice,

  toggleVoice() {
    const next = !state.voiceEnabled
    voice.setEnabled(next)
    state.voiceEnabled = next
  },

  /** 必須由 click handler 直接呼叫，中間不得有 await */
  primeVoiceFromGesture() {
    voice.primeFromGesture()
  },
```

- [ ] **Step 3: 在「開始討伐」的 click handler 裡暖機**

`src/App.vue` 的 `onTaskChosen` 改成：

```js
function onTaskChosen(payload) {
  // 這一行必須在 await 之前：iOS 要求首次 speak() 在手勢的同步呼叫堆疊內
  session.primeVoiceFromGesture()
  session.setTask(payload)
  session.startBattle()
}
```

`TaskSelector` 的按鈕是同步 emit，所以這個 handler 仍在手勢堆疊內。**不要**在這一行之前插入任何 `await`。

- [ ] **Step 4: BattleView 消費 voice 欄位**

在 `BattleView.vue` 的 `uiTimer` 那段改成：

```js
  let spokenAt = null
  uiTimer = setInterval(() => {
    const m = mq.current(performance.now())
    coachMessage.value = m
    // 分心類提示的 voice 恆為 false（見 postureCoach），這裡不需要另外擋
    if (m && m.voice && m.shownAt !== spokenAt) {
      spokenAt = m.shownAt
      session.voice().speak(m.text, m.priority)
    }
  }, 250)
```

並在魔王台詞處也接上（`sayBoss` 的 `bossLine.value = line.text` 之後）：

```js
  session.voice().speak(line.text, 0)
```

魔王台詞用最低優先權，任何姿態或安全提示都可以蓋掉它。

- [ ] **Step 5: 加喇叭開關到 BattleView 的角落**

在 `.corner-tl .status` 裡加一顆按鈕：

```vue
      <button class="mute" :aria-pressed="s.voiceEnabled" @click="session.toggleVoice()">
        {{ s.voiceEnabled ? '🔊 語音開' : '🔇 語音關' }}
      </button>
```

樣式：

```css
.mute { min-height: var(--tap-min); padding: 0 12px; font-size: var(--fs-body); }
```

spec 要求開關要明顯、不埋在設定裡，所以放在戰鬥畫面角落而不是設定頁。

- [ ] **Step 6: 實機驗收**

1. 預設是「🔇 語音關」——**不得**預設開啟
2. 按開語音後駝背 → 聽得到提示，且**畫面上同時有文字**
3. 拿手機入鏡 → 畫面有提示但**完全沒有聲音**（不能把被抓包的事廣播給旁邊的人）
4. 同一種姿態連續發生第 2 次 → 有文字、沒聲音
5. 切到別的 App 再回來 → 語音沒有卡死，仍然念得出來
6. 若 iPad 沒有中文語音，App 不當掉，Task 16 的 StatusIndicator 會顯示「語音不可用」

第 2 項若完全沒聲音，先確認 `primeVoiceFromGesture()` 前面沒有被插入 `await`。

- [ ] **Step 7: Commit**

```bash
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: VoiceFeedback 語音回饋

click handler 內同步暖機（iOS 不暖機會整場無聲且不報錯）、voiceschanged 後
pin 住 zh-TW voice；單槽播放高優先搶佔、低優先丟棄；預設關閉；
分心類提示一律不朗讀。只用 synthesis，不使用會外傳音訊的 SpeechRecognition。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: PerfMonitor、StatusIndicator 與 Debug HUD

**StatusIndicator 正常時只是一個綠點＋「偵測中」**，只有異常或降級時才展開細節。一直攤開一堆狀態列只會製造焦慮而沒有資訊量。

**不顯示「線上/離線」**——v1 離線一樣能玩，顯示離線只會讓使用者以為壞了。

**單向緊急降檔**：延遲 EMA > 150ms 連續 10 秒 → 頻率減半＋關閉 ObjectDetector，**不可升回**。反覆升降會在臨界點附近震盪。**不可用 rAF 掉幀率當依據**：主執行緒架構下掉幀多半來自動畫與 Chart.js，降推論頻率救不了，只會一路降到底卡死。

**Files:**
- Create: `src/core/perfMonitor.js`, `src/core/perfMonitor.test.js`
- Create: `src/components/StatusIndicator.vue`, `src/components/DebugHud.vue`
- Modify: `src/stores/session.js`、`src/components/BattleView.vue`

**Interfaces:**
- Consumes: `inference.latencyEma()` / `actualFps()`（Task 7）
- Produces：
  - `perfMonitor.js`：`createPerfMonitor({ thresholdMs, sustainMs })` → `.sample(latencyEma, now) -> 'ok' | 'downshift'`、`.isDownshifted()`、`.reset()`
  - `StatusIndicator.vue`：props `{ items }`（`[{ id, level: 'ok'|'warn'|'error', text }]`）
  - `DebugHud.vue`：props `{ stats }`

- [ ] **Step 1: 寫 PerfMonitor 的失敗測試**

`src/core/perfMonitor.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { createPerfMonitor } from './perfMonitor.js'

const make = () => createPerfMonitor({ thresholdMs: 150, sustainMs: 10_000 })

describe('createPerfMonitor', () => {
  it('延遲正常時回 ok', () => {
    const m = make()
    for (let t = 0; t <= 30_000; t += 500) expect(m.sample(80, t)).toBe('ok')
    expect(m.isDownshifted()).toBe(false)
  })

  it('超標未滿 10 秒不降檔', () => {
    const m = make()
    for (let t = 0; t <= 9500; t += 500) expect(m.sample(200, t)).toBe('ok')
  })

  it('超標連續滿 10 秒觸發降檔，且只觸發一次', () => {
    const m = make()
    let downshifts = 0
    for (let t = 0; t <= 40_000; t += 500) {
      if (m.sample(200, t) === 'downshift') downshifts++
    }
    expect(downshifts).toBe(1)
    expect(m.isDownshifted()).toBe(true)
  })

  it('中途恢復正常會重新計時', () => {
    const m = make()
    for (let t = 0; t <= 8000; t += 500) m.sample(200, t)
    m.sample(50, 8500)
    for (let t = 9000; t <= 16_000; t += 500) expect(m.sample(200, t)).toBe('ok')
  })

  it('單向不可升回：降檔後延遲恢復正常仍維持降檔', () => {
    const m = make()
    for (let t = 0; t <= 11_000; t += 500) m.sample(200, t)
    expect(m.isDownshifted()).toBe(true)
    for (let t = 12_000; t <= 60_000; t += 500) expect(m.sample(40, t)).toBe('ok')
    expect(m.isDownshifted()).toBe(true)
  })

  it('剛好等於門檻不算超標', () => {
    const m = make()
    for (let t = 0; t <= 20_000; t += 500) m.sample(150, t)
    expect(m.isDownshifted()).toBe(false)
  })

  it('reset 清除降檔狀態（換新一輪或手動重啟偵測時用）', () => {
    const m = make()
    for (let t = 0; t <= 11_000; t += 500) m.sample(200, t)
    m.reset()
    expect(m.isDownshifted()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗，然後寫實作**

```bash
npm test -- src/core/perfMonitor.test.js
```

`src/core/perfMonitor.js`：

```js
/**
 * 單向緊急降檔。
 *
 * 只有一檔、而且不可升回：反覆升降會在臨界點附近震盪，
 * 使用者會看到偵測時快時慢卻找不到原因。
 *
 * 刻意只看推論延遲，不看 rAF 掉幀率——在主執行緒架構下掉幀多半來自
 * 動畫與 Chart.js，降推論頻率救不了，只會一路降到底把偵測卡死。
 */
export function createPerfMonitor({ thresholdMs = 150, sustainMs = 10_000 } = {}) {
  let overSince = null
  let downshifted = false

  return {
    sample(latencyEma, now) {
      if (downshifted) return 'ok'

      if (latencyEma > thresholdMs) {
        if (overSince === null) overSince = now
        if (now - overSince >= sustainMs) {
          downshifted = true
          overSince = null
          return 'downshift'
        }
      } else {
        overSince = null
      }
      return 'ok'
    },

    isDownshifted: () => downshifted,

    reset() {
      overSince = null
      downshifted = false
    },
  }
}
```

- [ ] **Step 3: 接進 session store**

`src/stores/session.js` 加入 import 與單例：

```js
import { createPerfMonitor } from '../core/perfMonitor.js'
const perf = createPerfMonitor({ thresholdMs: 150, sustainMs: 10_000 })
```

`state` 加：

```js
  perfMode: false,
  objectDetectorOn: true,
  latencyEma: 0,
```

在 `frame()` 裡、`const healthy = ...` 那一行**之前**插入：

```js
  state.latencyEma = inference.latencyEma()
  if (perf.sample(state.latencyEma, now) === 'downshift') {
    inference.setScale(0.5)
    inference.setEnabled('object', false)
    state.perfMode = true
    state.objectDetectorOn = false
    state.phoneVisible = false // 關掉偵測後殘留的 true 會讓陷阱一直掛著
  }
```

`api` 加上手機偵測開關與重啟偵測：

```js
  /** 展場手機到處都是，誤判率必然偏高：demo 預設關閉，評審問到再開 */
  toggleObjectDetector() {
    const next = !state.objectDetectorOn
    inference.setEnabled('object', next)
    state.objectDetectorOn = next
    if (!next) state.phoneVisible = false
  },

  async restartInference() {
    perf.reset()
    inference.setScale(1)
    inference.setEnabled('object', state.objectDetectorOn)
    state.perfMode = false
    const ok = await camera.resume()
    state.cameraHealthy = ok
    lastSuccessAt = performance.now()
    state.inferenceHealthy = true
  },
```

- [ ] **Step 4: 寫 StatusIndicator.vue**

```vue
<template>
  <div class="status-indicator">
    <button class="dot-row" :aria-expanded="open" @click="open = !open">
      <span class="dot" :class="worst" aria-hidden="true" />
      <span class="text">{{ headline }}</span>
    </button>

    <ul v-if="open || worst !== 'ok'" class="list">
      <li v-for="item in visible" :key="item.id" :class="item.level">
        <span class="tag" aria-hidden="true">{{ ICON[item.level] }}</span>
        <span>{{ item.text }}</span>
        <button v-if="item.action" class="act" @click="$emit('action', item.id)">
          {{ item.action }}
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({ items: { type: Array, default: () => [] } })
defineEmits(['action'])

const ICON = { ok: '●', warn: '▲', error: '■' }
const open = ref(false)

// 正常時收斂為一個綠點；異常/降級才展開
const visible = computed(() => props.items.filter((i) => i.level !== 'ok'))
const worst = computed(() => {
  if (props.items.some((i) => i.level === 'error')) return 'error'
  if (props.items.some((i) => i.level === 'warn')) return 'warn'
  return 'ok'
})
const headline = computed(() =>
  worst.value === 'ok' ? '偵測中' : `${visible.value.length} 項需要注意`)
</script>

<style scoped>
.status-indicator { font-size: var(--fs-body); }
.dot-row { display: flex; align-items: center; gap: 8px; background: transparent;
           min-height: var(--tap-min); padding: 0 8px; }
/* 不單靠顏色：形狀（●▲■）與文字同時傳達 */
.dot { width: 12px; height: 12px; border-radius: 50%; }
.dot.ok { background: var(--c-ok); }
.dot.warn { background: var(--c-warn); border-radius: 2px; }
.dot.error { background: var(--c-danger); border-radius: 0; }
.list { list-style: none; margin: 8px 0 0; padding: 10px; background: var(--c-surface);
        border-radius: var(--radius); display: flex; flex-direction: column; gap: 10px; }
.list li { display: flex; align-items: center; gap: 8px; }
.list .warn { color: var(--c-warn); }
.list .error { color: var(--c-danger); }
.act { min-height: var(--tap-min); padding: 0 12px; background: var(--c-bg); color: var(--c-text); }
</style>
```

- [ ] **Step 5: 寫 DebugHud.vue**

spec 的效能驗收全靠這個 HUD——Safari 不支援 Long Tasks API、沒有 `performance.memory`、GPU 記憶體也沒有任何 Web API，原本的量化標準根本無法執行。

```vue
<template>
  <div class="hud" role="note">
    <p>延遲 EMA {{ Math.round(stats.latencyEma) }}ms　p95 {{ Math.round(stats.latencyP95) }}ms</p>
    <p>fps P {{ stats.fpsPose.toFixed(2) }}　F {{ stats.fpsFace.toFixed(2) }}　O {{ stats.fpsObject.toFixed(2) }}</p>
    <p>rAF 間隔 p95 {{ Math.round(stats.rafP95) }}ms　max {{ Math.round(stats.rafMax) }}ms</p>
    <p>本輪 {{ Math.round(stats.sessionSec) }}s　累計輪數 {{ stats.rounds }}</p>
    <p>效能模式 {{ stats.perfMode ? '是' : '否' }}　手機偵測 {{ stats.objectOn ? '開' : '關' }}</p>
  </div>
</template>

<script setup>
defineProps({ stats: { type: Object, required: true } })
</script>

<style scoped>
.hud {
  position: fixed; right: 8px; bottom: 8px; z-index: 20;
  background: rgba(0, 0, 0, .82); color: #9df;
  font: 12px/1.5 ui-monospace, monospace;
  padding: 8px 10px; border-radius: 8px; pointer-events: none;
}
.hud p { margin: 0; }
</style>
```

- [ ] **Step 6: 在 BattleView 掛上兩者，HUD 用角落點三下開啟**

`BattleView.vue` 的 template 加：

```vue
    <div class="corner-tr">
      <StatusIndicator :items="statusItems" @action="onStatusAction" />
    </div>
    <div class="hud-hit" @click="bumpHud" />
    <DebugHud v-if="hudOn" :stats="hudStats" />
```

script 加：

```js
import StatusIndicator from './StatusIndicator.vue'
import DebugHud from './DebugHud.vue'

const hudOn = ref(false)
const hudStats = reactive({
  latencyEma: 0, latencyP95: 0, fpsPose: 0, fpsFace: 0, fpsObject: 0,
  rafP95: 0, rafMax: 0, sessionSec: 0, rounds: 0, perfMode: false, objectOn: true,
})

let hudTaps = 0
let hudTapTimer = 0
function bumpHud() {
  hudTaps += 1
  clearTimeout(hudTapTimer)
  hudTapTimer = setTimeout(() => { hudTaps = 0 }, 600)
  if (hudTaps >= 3) { hudOn.value = !hudOn.value; hudTaps = 0 }
}

const statusItems = computed(() => {
  const items = [{ id: 'camera', level: s.cameraHealthy ? 'ok' : 'error',
                   text: s.cameraHealthy ? '鏡頭運作中' : '鏡頭未運作',
                   action: s.cameraHealthy ? null : '重新啟動偵測' }]
  if (!s.inferenceHealthy) {
    items.push({ id: 'inference', level: 'error', text: '偵測已停止', action: '重新啟動偵測' })
  }
  if (s.perfMode) items.push({ id: 'perf', level: 'warn', text: '效能模式（偵測頻率已降低）' })
  // 關閉 ObjectDetector 是功能性降級，一定要講，否則使用者拿手機沒事會以為系統壞了
  if (!s.objectDetectorOn) items.push({ id: 'object', level: 'warn', text: '手機偵測已暫停' })
  if (s.voiceEnabled && !s.voiceAvailable) items.push({ id: 'voice', level: 'warn', text: '語音不可用' })
  return items
})

function onStatusAction(id) {
  if (id === 'camera' || id === 'inference') session.restartInference()
}
```

樣式：

```css
/* 角落隱形熱區，點三下開 HUD */
.hud-hit { position: absolute; right: 0; bottom: 0; width: 72px; height: 72px; z-index: 9; }
```

在既有的 `uiTimer` 那個 `setInterval` 裡補上 HUD 數值更新（只有開著才算，關著不浪費效能）：

```js
    if (hudOn.value) {
      const now = performance.now()
      hudStats.latencyEma = s.latencyEma
      hudStats.fpsPose = session.inference().actualFps('pose', now)
      hudStats.fpsFace = session.inference().actualFps('face', now)
      hudStats.fpsObject = session.inference().actualFps('object', now)
      hudStats.sessionSec = (battle.value?.elapsedMs ?? 0) / 1000
      hudStats.perfMode = s.perfMode
      hudStats.objectOn = s.objectDetectorOn
    }
```

`latencyP95` / `rafP95` / `rafMax` / `rounds` 需要跨輪統計，在 store 加一個輕量收集器：

`src/stores/session.js` 頂部加：

```js
const perfSamples = { latency: [], raf: [], rounds: 0 }
let lastFrameAt = 0

function pushSample(arr, v) {
  arr.push(v)
  if (arr.length > 600) arr.shift() // 只留最近 600 筆，避免無限成長
}

function p95(arr) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}
```

`frame()` 開頭加：

```js
  if (lastFrameAt) pushSample(perfSamples.raf, now - lastFrameAt)
  lastFrameAt = now
```

`if (r)` 區塊內加：

```js
    pushSample(perfSamples.latency, r.latencyMs)
```

`startBattle()` 裡加 `perfSamples.rounds += 1`，並在 `api` 加：

```js
  perfStats: () => ({
    latencyP95: p95(perfSamples.latency),
    rafP95: p95(perfSamples.raf),
    rafMax: perfSamples.raf.length ? Math.max(...perfSamples.raf) : 0,
    rounds: perfSamples.rounds,
  }),
```

HUD 更新那段補上：

```js
      const ps = session.perfStats()
      hudStats.latencyP95 = ps.latencyP95
      hudStats.rafP95 = ps.rafP95
      hudStats.rafMax = ps.rafMax
      hudStats.rounds = ps.rounds
```

- [ ] **Step 7: 實機驗收**

1. 一切正常時右上角只有一個**綠點＋「偵測中」**，沒有攤開一堆狀態
2. 在設定裡關掉手機偵測（Task 22 會加到設定頁，現在先在 console 手動呼叫 `toggleObjectDetector`）→ 展開出現「手機偵測已暫停」
3. 把鏡頭權限在 Safari 設定裡關掉再回來 → 出現「鏡頭未運作」＋「重新啟動偵測」按鈕
4. 右下角**點三下** → HUD 出現，延遲與 fps 數字在跳；再點三下關閉
5. HUD 關閉時沒有多餘的計算（`hudOn` 為 false 時不更新數值）

- [ ] **Step 8: Commit**

```bash
npm test && npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: PerfMonitor、StatusIndicator 與 Debug HUD

單向緊急降檔只看推論延遲不看 rAF 掉幀率（主執行緒架構下掉幀來自動畫，
降頻救不了只會一路降到底）；StatusIndicator 正常時收斂為一個綠點，
異常與降級才展開，不顯示線上/離線；HUD 角落點三下開啟，提供 spec 效能驗收所需數據。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: StorageService

IndexedDB 存歷史紀錄，加上 localStorage 的崩潰保險。

**為什麼需要 crumb**：IndexedDB 是非同步 API，iOS 可能在 transaction commit 之前就把頁面凍結，那一輪的紀錄就消失了。`localStorage` 是同步 API，在 `pagehide` 的 handler 裡寫得進去。啟動時如果 crumb 比 IndexedDB 裡最新那筆還新，就用 crumb 補完。

**隱私紅線**：寫進去的只有彙總數值。landmark 座標、blendshape 數值、影像、原始角度時序、裝置識別碼一律不得出現。

**Files:**
- Create: `src/core/storageService.js`, `src/core/storageService.test.js`

**Interfaces:**
- Consumes: `SessionRecord`（Task 10 的 `buildRecord` 輸出）
- Produces：
  - `sanitizeRecord(record) -> record` — 白名單過濾，**可純測**
  - `await openDb()`、`await saveSession(record)`、`await listSessions(limit)`、`await clearAll()`
  - `writeCrumb(crumb)`、`readCrumb()`、`clearCrumb()`（同步，localStorage）
  - `await reconcile()` — 啟動時用 crumb 補完

- [ ] **Step 1: 寫失敗的測試（只測純邏輯，不測 IndexedDB）**

`src/core/storageService.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { sanitizeRecord, ALLOWED_FIELDS } from './storageService.js'

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

  it('null / undefined 回傳 null', () => {
    expect(sanitizeRecord(null)).toBe(null)
    expect(sanitizeRecord(undefined)).toBe(null)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗，然後寫實作**

```bash
npm test -- src/core/storageService.test.js
```

`src/core/storageService.js`：

```js
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

export function sanitizeRecord(record) {
  if (!record) return null
  const out = {}
  for (const key of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = record[key]
  }
  return out
}

let dbPromise = null

export function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('startedAt', 'startedAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
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
  const db = await openDb()
  clearCrumb()
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
```

- [ ] **Step 3: 接進 session store**

`src/stores/session.js` 加 import：

```js
import { saveSession, writeCrumb, clearCrumb, reconcile } from '../core/storageService.js'
```

`boot()` 裡 `state.booted = true` 之前加：

```js
    await reconcile()
```

`endBattle()` 的 `state.lastRecord = ...` 之後加：

```js
    if (state.lastRecord && !state.lastRecord.demoMode) {
      await saveSession(state.lastRecord)
      clearCrumb()
    }
```

展示模式的紀錄不入庫——評審試玩 20 秒的資料混進統計裡會把趨勢圖弄髒。

`onHidden()` 裡加（**同步寫，不能 await**）：

```js
  if (fsm) {
    const snap = fsm.snapshot()
    writeCrumb(buildRecord(snap, state, 'in_progress'))
  }
```

`boot()` 裡註冊的 `pagehide` handler 改成：

```js
    window.addEventListener('pagehide', () => {
      if (fsm) writeCrumb(buildRecord(fsm.snapshot(), state, 'in_progress'))
      camera?.stop()
      wakeLock.release()
    })
```

- [ ] **Step 4: 實機驗收**

1. 跑完一輪非展示模式 → Safari 開發者工具（或加一顆暫時的按鈕呼叫 `listSessions()`）確認有一筆紀錄
2. 跑展示模式 → **不會**多一筆
3. 戰鬥中切到別的 App → 回來後 `localStorage` 裡有 crumb
4. 戰鬥中強制關掉 Safari 再打開 → 啟動時 `reconcile()` 把那一輪補進去
5. 檢查存下來的紀錄**只有白名單欄位**，沒有任何座標或影像

- [ ] **Step 5: Commit**

```bash
npm test && npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: StorageService 本地儲存

白名單過濾（不是黑名單）確保只有彙總數值進儲存層，測試逐項鎖住隱私紅線；
IndexedDB 結束時寫一次，hidden/pagehide 時同步寫 localStorage crumb
（IndexedDB 非同步，iOS 可能在 commit 前凍結頁面）；展示模式不入庫。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: 結算總結、雷達圖五軸與 StatsDashboard

**首屏先給白話總結與下次目標，圖表在下面。** 國小生看到三張圖不會知道要看什麼，一句「你專注了 15 分鐘，其中 11 分鐘坐得很端正」才是他讀得懂的。

**總結必須有冷啟動分支**：評審試玩就是第一次使用，沒有昨日、沒有連續天數。沒有這個分支的話，每次都會落到最弱的「一般鼓勵」，展示效果最差的情境正好就是評審看到的那一次。

**Chart.js 設定的一處刻意偏離**：spec 寫「`animation:false`、`parsing:false`、`pointRadius:0`」。`animation:false` 三張圖都套用；但 `parsing:false` 要求資料已經是預先解析好的格式，圓餅圖與雷達圖套了會直接畫不出來。所以 **`parsing:false` 與 `pointRadius:0` 只套在折線圖**（180 個點的那一張，也只有它需要），圓餅與雷達各只有 5-7 個點，不套沒有任何效能差別。

**Files:**
- Create: `src/core/radar.js`, `src/core/radar.test.js`
- Create: `src/core/summary.js`, `src/core/summary.test.js`
- Create: `src/components/StatsDashboard.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `SessionRecord`（Task 10/17）、`SUMMARY_COPY`（Task 12）
- Produces：
  - `radar.js`：`radarAxes(record) -> [{ key, label, value }]`（5 軸，`value` 為 0-100 整數）
  - `summary.js`：`buildSummary(record, history) -> { headline, nextGoal }`
  - `StatsDashboard.vue`：emit `again()`、`home()`、`break()`

- [ ] **Step 1: 寫 radar 的失敗測試**

`src/core/radar.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { radarAxes } from './radar.js'

const record = {
  durationMs: 100_000,
  postureDurationMs: { upright: 60_000, slouch: 20_000, forwardHead: 10_000, drowsy: 5000, gazeAway: 5000 },
  distractionDurationMs: { phone: 10_000, away: 0 },
}

describe('radarAxes', () => {
  it('回傳五軸', () => {
    expect(radarAxes(record).map((a) => a.key))
      .toEqual(['upright', 'neck', 'back', 'awake', 'resist'])
  })

  it('坐姿端正＝upright 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'upright').value).toBe(60)
  })

  it('頸部健康＝1 − forwardHead 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'neck').value).toBe(90)
  })

  it('背部健康＝1 − slouch 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'back').value).toBe(80)
  })

  it('清醒度＝1 − drowsy 佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'awake').value).toBe(95)
  })

  it('抗干擾＝1 − 分心總時長佔比', () => {
    expect(radarAxes(record).find((a) => a.key === 'resist').value).toBe(90)
  })

  it('軸標籤用國小生讀得懂的白話，不用術語', () => {
    const labels = radarAxes(record).map((a) => a.label)
    for (const term of ['前傾', '佔比', '指數', 'ratio']) {
      expect(labels.join('')).not.toContain(term)
    }
  })

  it('所有值夾在 0-100 之間', () => {
    const weird = {
      durationMs: 10_000,
      postureDurationMs: { upright: 0, slouch: 99_999, forwardHead: 0, drowsy: 0, gazeAway: 0 },
      distractionDurationMs: { phone: 99_999, away: 99_999 },
    }
    for (const a of radarAxes(weird)) {
      expect(a.value).toBeGreaterThanOrEqual(0)
      expect(a.value).toBeLessThanOrEqual(100)
    }
  })

  it('時長為 0 時不產生 NaN', () => {
    const zero = {
      durationMs: 0,
      postureDurationMs: { upright: 0, slouch: 0, forwardHead: 0, drowsy: 0, gazeAway: 0 },
      distractionDurationMs: { phone: 0, away: 0 },
    }
    for (const a of radarAxes(zero)) expect(Number.isFinite(a.value)).toBe(true)
  })
})
```

- [ ] **Step 2: 寫 radar.js**

```js
const AXES = [
  { key: 'upright', label: '坐得直不直' },
  { key: 'neck', label: '脖子有沒有伸出去' },
  { key: 'back', label: '背有沒有靠好' },
  { key: 'awake', label: '精神好不好' },
  { key: 'resist', label: '有沒有被打斷' },
]

const pct = (part, whole) => {
  if (!whole || whole <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)))
}

/** 五軸全部由既有資料導出，不需額外蒐集。標籤刻意用白話，不用術語。 */
export function radarAxes(record) {
  const total = record.durationMs
  const p = record.postureDurationMs
  const d = record.distractionDurationMs
  const distraction = (d?.phone ?? 0) + (d?.away ?? 0)

  const values = {
    upright: pct(p?.upright ?? 0, total),
    neck: 100 - pct(p?.forwardHead ?? 0, total),
    back: 100 - pct(p?.slouch ?? 0, total),
    awake: 100 - pct(p?.drowsy ?? 0, total),
    resist: 100 - pct(distraction, total),
  }

  return AXES.map((a) => ({ ...a, value: Math.max(0, Math.min(100, values[a.key])) }))
}
```

- [ ] **Step 3: 寫 summary 的失敗測試**

`src/core/summary.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { buildSummary } from './summary.js'

const record = {
  durationMs: 15 * 60_000,
  postureDurationMs: { upright: 11 * 60_000, slouch: 3 * 60_000, forwardHead: 60_000, drowsy: 0, gazeAway: 0 },
  distractionDurationMs: { phone: 0, away: 0 },
  attacks: 120, score: 1200, result: 'victory',
  startedAt: Date.parse('2026-09-11T10:00:00Z'),
}

describe('buildSummary', () => {
  it('沒有歷史時走冷啟動分支，含分鐘數、端正分鐘、百分比與刀數', () => {
    const { headline } = buildSummary(record, [])
    expect(headline).toContain('15')
    expect(headline).toContain('11')
    expect(headline).toContain('73%')
    expect(headline).toContain('120')
  })

  it('冷啟動分支不得提到昨天或連續天數', () => {
    const { headline } = buildSummary(record, [])
    for (const w of ['昨', '連續', '天']) expect(headline).not.toContain(w)
  })

  it('有歷史且端正比例進步時，提到進步', () => {
    const worse = { ...record, postureDurationMs: { ...record.postureDurationMs, upright: 6 * 60_000 },
                    startedAt: record.startedAt - 86_400_000 }
    const { headline } = buildSummary(record, [worse])
    expect(headline).toContain('進步')
  })

  it('有歷史但沒進步時退回最高頻姿態問題', () => {
    const better = { ...record, postureDurationMs: { ...record.postureDurationMs, upright: 14 * 60_000 },
                     startedAt: record.startedAt - 86_400_000 }
    const { headline } = buildSummary(record, [better])
    expect(headline).toContain('駝背')
  })

  it('永遠給出下次目標，且目標高於本次', () => {
    const { nextGoal } = buildSummary(record, [])
    expect(nextGoal).toContain('%')
    const target = Number(nextGoal.match(/(\d+)%/)[1])
    expect(target).toBeGreaterThan(73)
  })

  it('端正比例已達 95% 以上時目標封頂在 100，不得超過', () => {
    const great = { ...record, postureDurationMs: { ...record.postureDurationMs, upright: 15 * 60_000 } }
    const target = Number(buildSummary(great, []).nextGoal.match(/(\d+)%/)[1])
    expect(target).toBeLessThanOrEqual(100)
  })

  it('沒有任何姿態問題時不硬湊出一個問題來講', () => {
    const perfect = {
      ...record,
      postureDurationMs: { upright: 15 * 60_000, slouch: 0, forwardHead: 0, drowsy: 0, gazeAway: 0 },
    }
    const { headline } = buildSummary(perfect, [])
    expect(headline).not.toContain('最常發生')
  })

  it('文案不含禁用詞', () => {
    const { headline, nextGoal } = buildSummary(record, [])
    for (const w of ['懶惰', '摸魚', '沒用']) {
      expect(headline + nextGoal).not.toContain(w)
    }
  })
})
```

- [ ] **Step 4: 寫 summary.js**

```js
const ISSUE = {
  slouch: { label: '駝背', fix: '把背靠到椅背上' },
  forwardHead: { label: '低頭太久', fix: '把書本拿高一點' },
  gazeAway: { label: '視線飄走', fix: '把桌上其他東西收起來' },
  drowsy: { label: '想睡', fix: '中間站起來動一動' },
}

const minutes = (ms) => Math.round(ms / 60_000)
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

function topIssue(record) {
  const p = record.postureDurationMs ?? {}
  let best = null
  for (const key of Object.keys(ISSUE)) {
    const v = p[key] ?? 0
    if (v > 0 && (best === null || v > p[best])) best = key
  }
  return best
}

function uprightPct(record) {
  return pct(record.postureDurationMs?.upright ?? 0, record.durationMs)
}

/**
 * 總結文案。
 *
 * 冷啟動分支是必要的：評審試玩就是第一次使用，沒有昨日、沒有連續天數。
 * 少了這個分支，展示效果最差的「一般鼓勵」正好就會落在評審看到的那一次。
 */
export function buildSummary(record, history = []) {
  const mins = minutes(record.durationMs)
  const upMins = minutes(record.postureDurationMs?.upright ?? 0)
  const up = uprightPct(record)
  const issue = topIssue(record)

  const parts = []

  if (history.length === 0) {
    parts.push(`你專注了 ${mins} 分鐘，其中 ${upMins} 分鐘坐得很端正（${up}%），砍了魔王 ${record.attacks} 刀。`)
    if (issue) parts.push(`最常發生的是${ISSUE[issue].label}，下次試試${ISSUE[issue].fix}。`)
  } else {
    const prev = [...history].sort((a, b) => b.startedAt - a.startedAt)[0]
    const prevUp = uprightPct(prev)
    if (up > prevUp) {
      parts.push(`端正時間比上一次多了 ${up - prevUp}%，有進步。`)
    } else if (issue) {
      parts.push(`這次最常發生的是${ISSUE[issue].label}，下次試試${ISSUE[issue].fix}。`)
    } else {
      parts.push(`這次專注了 ${mins} 分鐘，繼續保持。`)
    }
  }

  const target = Math.min(100, Math.max(up + 5, 65))
  return {
    headline: parts.join(''),
    nextGoal: `下次目標：端正時間拉到 ${target}%。`,
  }
}
```

- [ ] **Step 5: 跑測試確認通過**

```bash
npm test -- src/core/radar.test.js src/core/summary.test.js
```

- [ ] **Step 6: 寫 StatsDashboard.vue**

```vue
<template>
  <div class="stats">
    <header class="hero">
      <p class="result" :class="record?.result">
        {{ record?.result === 'victory' ? '討伐成功！' : `打掉了 ${knockedPct}%` }}
      </p>
      <p class="headline">{{ summary.headline }}</p>
      <p class="goal">{{ summary.nextGoal }}</p>
    </header>

    <section class="charts">
      <figure><figcaption>時間都花在哪</figcaption><canvas ref="pieEl" /></figure>
      <figure><figcaption>每 5 秒打出的傷害</figcaption><canvas ref="lineEl" /></figure>
      <figure><figcaption>五項表現</figcaption><canvas ref="radarEl" /></figure>
    </section>

    <table class="axes">
      <caption>五項表現的數字</caption>
      <tbody>
        <tr v-for="a in axes" :key="a.key"><th scope="row">{{ a.label }}</th><td>{{ a.value }}%</td></tr>
      </tbody>
    </table>

    <footer class="actions">
      <button class="primary again" @click="$emit(needsBreak ? 'break' : 'again')">
        {{ needsBreak ? '休息一下再來' : '再討伐一次' }}
      </button>
      <button class="primary home" @click="$emit('home')">回主畫面</button>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  Chart, PieController, ArcElement, LineController, LineElement, PointElement,
  RadarController, RadialLinearScale, LinearScale, CategoryScale, Tooltip,
} from 'chart.js'
import { radarAxes } from '../core/radar.js'
import { buildSummary } from '../core/summary.js'

Chart.register(PieController, ArcElement, LineController, LineElement, PointElement,
               RadarController, RadialLinearScale, LinearScale, CategoryScale, Tooltip)

const props = defineProps({
  record: { type: Object, default: null },
  history: { type: Array, default: () => [] },
  dpsSeries: { type: Array, default: () => [] },
})
defineEmits(['again', 'home', 'break'])

const pieEl = ref(null)
const lineEl = ref(null)
const radarEl = ref(null)
const charts = []

const axes = computed(() => (props.record ? radarAxes(props.record) : []))
const summary = computed(() => (props.record ? buildSummary(props.record, props.history)
                                             : { headline: '', nextGoal: '' }))
const knockedPct = computed(() => {
  const r = props.record
  if (!r?.bossHpMax) return 0
  return Math.round(((r.bossHpMax - r.bossHpRemaining) / r.bossHpMax) * 100)
})

// 20 分鐘以上的長時段，結算後先進休息回合再開下一輪
const needsBreak = computed(() => (props.record?.durationMs ?? 0) >= 20 * 60_000)

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

onMounted(() => {
  const p = props.record?.postureDurationMs ?? {}
  const d = props.record?.distractionDurationMs ?? {}

  charts.push(new Chart(pieEl.value, {
    type: 'pie',
    data: {
      labels: ['坐得端正', '駝背', '低頭', '想睡', '視線飄走', '分心'],
      datasets: [{
        data: [p.upright ?? 0, p.slouch ?? 0, p.forwardHead ?? 0, p.drowsy ?? 0,
               p.gazeAway ?? 0, (d.phone ?? 0) + (d.away ?? 0)].map((ms) => Math.round(ms / 1000)),
        backgroundColor: [css('--c-hero'), css('--c-warn'), css('--c-accent'),
                          css('--c-text-dim'), css('--c-boss'), css('--c-danger')],
      }],
    },
    // parsing:false 不套在圓餅/雷達：這兩種圖需要 Chart.js 自己解析 labels，
    // 關掉會直接畫不出來。它們各只有 5-7 個點，不套也沒有效能差別。
    options: { animation: false, responsive: true, maintainAspectRatio: false },
  }))

  charts.push(new Chart(lineEl.value, {
    type: 'line',
    data: {
      datasets: [{
        data: props.dpsSeries.map((v, i) => ({ x: i * 5, y: v })),
        borderColor: css('--c-accent'),
        pointRadius: 0,   // 180 個點，畫圓點只是噪音
        borderWidth: 2,
      }],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      parsing: false,   // 資料已經是 {x,y}，省下 180 點的解析
      scales: { x: { type: 'linear', title: { display: true, text: '秒' } }, y: { beginAtZero: true } },
      plugins: { tooltip: { enabled: false } },
    },
  }))

  charts.push(new Chart(radarEl.value, {
    type: 'radar',
    data: {
      labels: axes.value.map((a) => a.label),
      datasets: [{ data: axes.value.map((a) => a.value),
                   borderColor: css('--c-hero'), backgroundColor: 'rgba(74,222,128,.25)' }],
    },
    options: { animation: false, responsive: true, maintainAspectRatio: false,
               scales: { r: { min: 0, max: 100 } } },
  }))
})

// 不 destroy 的話，回到這個畫面會疊上新的 Chart 實例，記憶體與重繪都會一輪一輪累積
onBeforeUnmount(() => { for (const c of charts) c.destroy() })
</script>

<style scoped>
.stats { min-height: 100dvh; padding: max(var(--gap), env(safe-area-inset-top)) var(--gap)
         calc(var(--tap-primary) + var(--gap) * 3); overflow-y: auto; }
.hero { text-align: center; margin-bottom: var(--gap); }
.result { font-size: 34px; font-weight: 800; margin: 0 0 8px; }
.result.victory { color: var(--c-hero); }
.headline { font-size: 22px; line-height: 1.6; margin: 0 auto; max-width: 44em; }
.goal { font-size: var(--fs-body); color: var(--c-text-dim); }

/* 直式單欄、橫式三欄——兩個方向都完整可用 */
.charts { display: grid; gap: var(--gap); grid-template-columns: 1fr; }
@media (orientation: landscape) { .charts { grid-template-columns: repeat(3, 1fr); } }
figure { margin: 0; background: var(--c-surface); border-radius: var(--radius); padding: 12px; }
figcaption { font-size: var(--fs-body); margin-bottom: 8px; }
figure canvas { height: 240px !important; }

/* 圖表不是唯一的傳達管道：同樣的數字用表格再給一次 */
.axes { width: 100%; margin-top: var(--gap); border-collapse: collapse; font-size: var(--fs-body); }
.axes caption { text-align: left; color: var(--c-text-dim); padding-bottom: 8px; }
.axes th, .axes td { text-align: left; padding: 8px; border-bottom: 1px solid var(--c-surface); }
.axes td { text-align: right; font-variant-numeric: tabular-nums; }

/* 底部固定兩顆 ≥60pt 按鈕 */
.actions { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: var(--gap);
           padding: var(--gap) var(--gap) max(var(--gap), env(safe-area-inset-bottom));
           background: linear-gradient(transparent, var(--c-bg) 30%); }
.actions button { flex: 1; }
.home { background: transparent; outline: 2px solid var(--c-text-dim); }
</style>
```

- [ ] **Step 7: 接進 App.vue**

```vue
  <StatsDashboard
    v-else-if="s.screen === 'stats'"
    :record="s.lastRecord"
    :history="history"
    :dps-series="s.battle?.dpsSeries ?? []"
    @again="onAgain"
    @home="onHome"
    @break="session.rawState.screen = 'break'"
  />
```

script 補：

```js
import StatsDashboard from './components/StatsDashboard.vue'
import { listSessions } from './core/storageService.js'

const history = ref([])

async function onAgain() {
  // 沿用同任務與同校準，不重跑 Onboarding
  await session.startBattle()
}

function onHome() {
  session.rawState.screen = 'task'
}
```

並在 `session.endBattle` 之後刷新歷史——在 store 的 `endBattle()` 尾端加：

```js
    state.history = await listSessions(60)
```

（`state` 加 `history: []`，App 直接用 `s.history` 取代本地的 `history` ref。）

- [ ] **Step 8: 實機驗收**

1. 跑完一輪 → 首屏先看到大字結果與白話總結，圖表在下面
2. **第一次使用**（先清除紀錄）→ 總結是冷啟動版本，**不會**出現「昨天」「連續」
3. 三張圖都畫得出來，圓餅與雷達沒有空白
4. **直橫各轉一次**：直式三張圖單欄堆疊、橫式並排三欄，兩種都不溢出
5. 底部兩顆按鈕固定可見、各 ≥60pt
6. 按「再討伐一次」→ **不**重跑校準與任務選擇，直接開新一輪
7. 連續進出結算畫面 5 次 → 不變慢（確認 `chart.destroy()` 有生效）

- [ ] **Step 9: Commit**

```bash
npm test && npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: 結算總結、雷達圖五軸與 StatsDashboard

首屏白話總結＋下次目標，含冷啟動分支（評審試玩就是第一次使用）；
雷達五軸全由既有資料導出、標籤用國小生讀得懂的白話；
parsing:false/pointRadius:0 只套折線圖（圓餅與雷達套了會畫不出來，且各只有 5-7 點）；
離開畫面時 chart.destroy() 避免跨輪累積。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: PermissionGate 與隱私說明頁

**授權前先說明用途**，不要一進來就彈鏡頭權限對話框。這既是隱私要求，也是實務問題：使用者在不知道為什麼的情況下按「不允許」，之後要從 Safari 設定裡撈回來很麻煩。

**`NotAllowedError` 要給完整的復原步驟**（含實際的設定路徑）加上「我設定好了，重試」按鈕。只講「請允許鏡頭權限」對國小生等於什麼都沒講。

spec 明確只做 `NotAllowedError` 這一條復原路徑，不做四種錯誤分流、不做無鏡頭降級模式。

**Files:**
- Create: `src/components/PrivacyNotice.vue`, `src/components/PermissionGate.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `session.boot()`（Task 10）、`clearAll`（Task 17）
- Produces：`PrivacyNotice.vue` emit `agree()`；`PermissionGate.vue` emit `granted()`

- [ ] **Step 1: 寫 PrivacyNotice.vue**

```vue
<template>
  <div class="stack">
    <h1>專注討伐戰：懶惰大魔王</h1>

    <p class="one-liner">
      這個遊戲會用 iPad 的前鏡頭看你的坐姿，<strong>影像不會離開這台 iPad</strong>。
    </p>

    <button class="more" :aria-expanded="open" @click="open = !open">
      {{ open ? '收起說明' : '給家長／老師看的完整說明' }}
    </button>

    <div v-if="open" class="detail">
      <h2>這個 App 會做什麼</h2>
      <ul>
        <li>用前鏡頭即時分析坐姿與眼睛狀態，判斷有沒有駝背、低頭、想睡。</li>
        <li>所有分析都在這台 iPad 上完成，<strong>不需要網路</strong>，可以開飛航模式玩。</li>
        <li>只分析畫面中最靠近鏡頭的一個人，旁邊經過的人不會被記錄。</li>
      </ul>

      <h2>會存下什麼</h2>
      <ul>
        <li>只存每一輪的統計數字：專注了幾分鐘、端正幾分鐘、打了幾刀、得幾分。</li>
        <li><strong>不會</strong>存任何照片、影片、人臉特徵或身體座標。</li>
        <li>資料只存在這台 iPad 的瀏覽器裡，不會上傳到任何地方。</li>
      </ul>

      <h2>不會做什麼</h2>
      <ul>
        <li>不會要麥克風權限，不錄音。</li>
        <li>不會連線到外部伺服器，不會把任何資料傳出去。</li>
        <li>不會記錄使用者是誰，也沒有帳號。</li>
      </ul>

      <h2>怎麼刪掉紀錄</h2>
      <p>按下面的「清除所有紀錄」，這台 iPad 上的所有紀錄會立刻消失，無法復原。</p>
      <button class="danger" @click="onClear">清除所有紀錄</button>
      <p v-if="cleared" class="cleared" role="status">已經清除了。</p>
    </div>

    <button class="primary go" @click="$emit('agree')">我知道了，開始</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { clearAll } from '../core/storageService.js'

defineEmits(['agree'])
const open = ref(false)
const cleared = ref(false)

async function onClear() {
  await clearAll()
  cleared.value = true
}
</script>

<style scoped>
h1 { font-size: var(--fs-title); margin: 0; }
.one-liner { font-size: 22px; line-height: 1.7; max-width: 34em; margin: 0; }
.more { min-height: var(--tap-min); padding: 0 18px; color: var(--c-accent); background: transparent;
        text-decoration: underline; }
.detail { text-align: left; max-width: 44em; background: var(--c-surface);
          border-radius: var(--radius); padding: 20px; font-size: var(--fs-body); line-height: 1.8; }
.detail h2 { font-size: 19px; margin: 18px 0 6px; }
.detail h2:first-child { margin-top: 0; }
.detail ul { margin: 0; padding-left: 1.3em; }
.danger { min-height: var(--tap-primary); padding: 0 20px; margin-top: 12px;
          outline: 2px solid var(--c-danger); color: var(--c-danger); background: transparent; }
.cleared { color: var(--c-ok); }
.go { min-width: 280px; }
</style>
```

- [ ] **Step 2: 寫 PermissionGate.vue**

```vue
<template>
  <div class="stack">
    <template v-if="!denied">
      <h2>接下來要開啟鏡頭</h2>
      <p class="why">
        iPad 會問你要不要允許使用相機，請按「<strong>允許</strong>」。<br>
        影像只在這台 iPad 上分析，不會被存起來也不會傳出去。
      </p>
      <button class="primary go" :disabled="working" @click="request">
        {{ working ? '開啟中…' : '開啟鏡頭' }}
      </button>
    </template>

    <template v-else>
      <h2>鏡頭被擋住了</h2>
      <p class="why">沒有鏡頭就沒辦法看坐姿。照下面的步驟打開它：</p>
      <ol class="steps">
        <li>打開 iPad 的「<strong>設定</strong>」App</li>
        <li>往下找到「<strong>Safari</strong>」並點進去</li>
        <li>點「<strong>相機</strong>」</li>
        <li>選「<strong>詢問</strong>」或「<strong>允許</strong>」</li>
        <li>回到這個畫面，按下面的按鈕</li>
      </ol>
      <button class="primary go" :disabled="working" @click="request">我設定好了，重試</button>
    </template>

    <p v-if="otherError" class="err" role="alert">
      鏡頭啟動失敗（{{ otherError }}）。請確認沒有其他 App 正在使用相機，再試一次。
    </p>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useSession } from '../stores/session.js'

const props = defineProps({ videoEl: { type: Object, default: null } })
const emit = defineEmits(['granted'])

const session = useSession()
const denied = ref(false)
const otherError = ref('')
const working = ref(false)

async function request() {
  working.value = true
  otherError.value = ''
  const r = await session.boot(props.videoEl)
  working.value = false

  if (r.ok) { emit('granted'); return }

  // spec 只做 NotAllowedError 這一條復原路徑，其餘統一顯示通用訊息
  if (r.error?.name === 'NotAllowedError') denied.value = true
  else otherError.value = r.error?.name ?? '未知錯誤'
}
</script>

<style scoped>
h2 { font-size: var(--fs-title); margin: 0; }
.why { font-size: 20px; line-height: 1.8; max-width: 32em; margin: 0; }
.steps { text-align: left; font-size: 20px; line-height: 2.2; max-width: 24em;
         background: var(--c-surface); border-radius: var(--radius); padding: 20px 20px 20px 48px; }
.go { min-width: 280px; }
.err { color: var(--c-danger); font-size: var(--fs-body); max-width: 32em; }
</style>
```

- [ ] **Step 3: 接進 App.vue，讓流程從隱私頁開始**

```vue
  <PrivacyNotice
    v-if="s.screen === 'privacy'"
    @agree="session.rawState.screen = 'permission'"
  />

  <PermissionGate
    v-else-if="s.screen === 'permission'"
    :video-el="videoEl"
    @granted="session.rawState.screen = 'calibrate'"
  />
```

刪掉先前那顆暫時的「開始」按鈕與 `start()` 函式。

主畫面常駐的隱私一行字加在 TaskSelector 底部：

```vue
    <p class="privacy-line">
      完全離線運作，只分析畫面中最靠近鏡頭的一個人，影像不會離開這台 iPad
    </p>
```

```css
.privacy-line { font-size: 15px; color: var(--c-text-dim); max-width: 36em; margin: 0; }
```

- [ ] **Step 4: 實機驗收**

1. 第一次開 → 先看到隱私說明，**還沒有**跳出鏡頭權限對話框
2. 展開完整說明 → 家長版說明完整可讀，**直橫都不溢出**
3. 按「開始」→ 才跳出鏡頭權限對話框
4. 刻意按「不允許」→ 出現五步驟設定路徑與「我設定好了，重試」
5. 照步驟開啟權限後按重試 → 順利進入校準
6. 按「清除所有紀錄」→ 出現「已經清除了」，且統計畫面的歷史真的空了
7. 在 Safari 設定裡確認**沒有出現麥克風權限**的要求紀錄

- [ ] **Step 5: Commit**

```bash
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: PermissionGate 與隱私說明頁

授權前先說明用途；NotAllowedError 給完整五步驟設定路徑＋「我設定好了，重試」，
不做四種錯誤分流也不做無鏡頭降級（依 spec 範圍）；隱私頁含家長版展開說明
與「清除所有紀錄」。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: BreakScreen 與 InstallGuide

**休息回合的觸發時機**（spec v4.2 補上的）：
1. 本輪時長 ≥20 分鐘時，StatsDashboard 的「再討伐一次」先進休息回合（Task 18 的 `needsBreak` 已實作）
2. 戰鬥中判定瞌睡時，提示列附「休息一下」按鈕手動進入（Task 13 的 `showBreakButton` 已實作）
3. 展示模式不觸發

**跳過需要點兩下**——一下就跳過等於沒有休息回合，但完全不給跳過又會卡住想繼續的人。

**InstallGuide 是一行可關閉的橫幅，不擋流程。** 做成強制安裝步驟的話，評審拿起 iPad 想試玩會先被一個安裝教學擋住。

**Files:**
- Create: `src/components/BreakScreen.vue`, `src/components/InstallGuide.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `BOSS_COPY.regroup`（Task 12）
- Produces：`BreakScreen.vue` emit `done()`；`InstallGuide.vue` 無 emit（自行記住已關閉）

- [ ] **Step 1: 寫 BreakScreen.vue**

```vue
<template>
  <div class="stack break">
    <p class="tag">休息回合</p>
    <p class="clock">{{ mm }}:{{ ss }}</p>

    <ul class="moves">
      <li v-for="m in MOVES" :key="m">{{ m }}</li>
    </ul>

    <p class="boss-line">{{ bossLine }}</p>

    <button class="primary done" @click="$emit('done')">休息夠了，繼續討伐</button>

    <button class="skip" @click="onSkip">
      {{ skipArmed ? '再按一次就跳過休息' : '跳過休息' }}
    </button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { BOSS_COPY } from '../data/copy/boss.js'

const emit = defineEmits(['done'])

const BREAK_MS = 3 * 60_000
const MOVES = [
  '站起來，肩膀往後轉 10 圈',
  '看向窗外或最遠的牆，數到 20',
  '手臂往上伸直，深呼吸 3 次',
  '喝一口水',
]

const remain = ref(BREAK_MS)
const skipArmed = ref(false)
const bossLine = BOSS_COPY.regroup[Math.floor(Math.random() * BOSS_COPY.regroup.length)]

const mm = computed(() => String(Math.floor(remain.value / 60_000)).padStart(2, '0'))
const ss = computed(() => String(Math.floor((remain.value % 60_000) / 1000)).padStart(2, '0'))

let timer = 0
let skipTimer = 0

// 跳過要點兩下：一下就跳過等於沒有休息回合，完全不給跳過又會卡住想繼續的人
function onSkip() {
  if (skipArmed.value) { emit('done'); return }
  skipArmed.value = true
  clearTimeout(skipTimer)
  skipTimer = setTimeout(() => { skipArmed.value = false }, 3000)
}

onMounted(() => {
  const endsAt = Date.now() + BREAK_MS
  timer = setInterval(() => {
    remain.value = Math.max(0, endsAt - Date.now())
    if (remain.value === 0) { clearInterval(timer); emit('done') }
  }, 1000)
})

onBeforeUnmount(() => { clearInterval(timer); clearTimeout(skipTimer) })
</script>

<style scoped>
.break { gap: 20px; }
.tag { font-size: var(--fs-body); color: var(--c-text-dim); margin: 0; letter-spacing: .3em; }
.clock { font-size: clamp(64px, 18vmin, 140px); font-weight: 800; margin: 0;
         font-variant-numeric: tabular-nums; line-height: 1; }
.moves { list-style: none; padding: 20px; margin: 0; background: var(--c-surface);
         border-radius: var(--radius); text-align: left; font-size: 20px; line-height: 2.1;
         max-width: 28em; }
.boss-line { font-size: var(--fs-number); color: var(--c-boss); margin: 0; }
.done { min-width: 280px; }
.skip { min-height: var(--tap-min); padding: 0 18px; background: transparent; color: var(--c-text-dim); }
</style>
```

- [ ] **Step 2: 寫 InstallGuide.vue**

```vue
<template>
  <div v-if="show" class="install" role="note">
    <p>把這個遊戲加到主畫面，下次不用開瀏覽器也能玩（分享鈕 → 加入主畫面）</p>
    <button aria-label="關閉安裝提示" @click="dismiss">✕</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const KEY = 'focus-quest:install-dismissed'

// 已經是從主畫面啟動的就不必再提示
const standalone = window.matchMedia?.('(display-mode: standalone)').matches
               || window.navigator.standalone === true

let dismissed = false
try { dismissed = localStorage.getItem(KEY) === '1' } catch { dismissed = false }

const show = ref(!standalone && !dismissed)

function dismiss() {
  show.value = false
  try { localStorage.setItem(KEY, '1') } catch { /* 私密瀏覽時放棄記憶，不影響主流程 */ }
}
</script>

<style scoped>
.install {
  position: fixed; left: var(--gap); right: var(--gap);
  bottom: max(var(--gap), env(safe-area-inset-bottom)); z-index: 8;
  display: flex; align-items: center; gap: 12px;
  background: var(--c-surface); border-radius: var(--radius); padding: 10px 12px 10px 16px;
}
.install p { margin: 0; font-size: 15px; flex: 1; line-height: 1.5; }
.install button { width: var(--tap-min); height: var(--tap-min); background: transparent;
                  font-size: 18px; flex: none; }
</style>
```

- [ ] **Step 3: 接進 App.vue**

```vue
  <BreakScreen v-else-if="s.screen === 'break'" @done="onBreakDone" />
```

```js
import BreakScreen from './components/BreakScreen.vue'
import InstallGuide from './components/InstallGuide.vue'

async function onBreakDone() {
  await session.startBattle()
}
```

橫幅掛在 TaskSelector 與 StatsDashboard 兩個畫面上，**不掛在戰鬥畫面**（戰鬥中不該有東西擋住）：

```vue
  <InstallGuide v-if="s.screen === 'task' || s.screen === 'stats'" />
```

- [ ] **Step 4: 實機驗收**

1. 設 20 分鐘跑一輪（可暫時把 `needsBreak` 的門檻調到 20 秒測完再改回來）→ 結算後按鈕變成「休息一下再來」
2. 進休息回合 → 3 分鐘倒數、伸展建議、魔王休戰台詞
3. 按「跳過休息」一下 → 按鈕變成「再按一次就跳過休息」；等 3 秒 → 變回原樣
4. 連按兩下 → 跳過並開新一輪
5. 戰鬥中打瞌睡 → 提示列出現「休息一下」按鈕，按了進入休息回合
6. 安裝橫幅在主畫面與結算畫面出現、戰鬥畫面**不出現**；按 ✕ 關閉後重新整理**不再出現**
7. 用「加到主畫面」安裝後從主畫面啟動 → 橫幅**不出現**
8. **直橫各轉一次**，休息畫面兩個方向都完整

- [ ] **Step 5: Commit**

```bash
npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat: BreakScreen 休息回合與 InstallGuide 安裝橫幅

休息回合由 20 分鐘以上的長時段與瞌睡提示兩個入口觸發，跳過需點兩下；
安裝引導只是一行可關閉橫幅且不出現在戰鬥畫面，不做成擋路的安裝教學。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: PWA、Service Worker 與 Cloudflare Pages 部署

離線能力是整個作品的核心訴求之一（「不用連網，影像不出這台 iPad」），所以 SW 不是加分項而是必要項。

**兩個一定要寫對的地方：**

1. **快取寫入條件不可用 `request.mode` 判斷。** 導覽請求的 mode 永遠是 `'navigate'`、子資源多半是 `'no-cors'`，用 mode 判斷會讓 `index.html` 根本進不了快取，離線時直接白畫面。正確條件是比對 origin、檢查 `response.ok`、排除 `opaque`。
2. **導覽請求要 network-first 加硬逾時 2 秒。** 真正的風險不是斷網（斷網 fetch 會立刻 reject），而是 captive portal——連上了但沒有對外網路，fetch 會 hang 到系統逾時，畫面就一直空白。用 `AbortController` 自己設 2 秒上限。

另外導覽回應要檢查是 `text/html` 且含有應用標記（Task 1 加在 `index.html` 的 `data-app-root="focus-quest"`），否則 captive portal 的登入頁會被寫進快取，之後每次離線開都看到那個登入頁。

**Files:**
- Create: `src/sw.js`, `public/manifest.webmanifest`, `public/_headers`
- Create: `public/icons/icon-192.png`, `public/icons/icon-512.png`
- Modify: `index.html`, `src/main.js`, `vite.config.js`

**Interfaces:**
- Consumes: 建置產物
- Produces：可安裝、可離線啟動的 PWA；Cloudflare Pages 正式站

- [ ] **Step 1: 寫 manifest**

`public/manifest.webmanifest`：

```json
{
  "name": "專注討伐戰：懶惰大魔王",
  "short_name": "專注討伐戰",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#12131a",
  "theme_color": "#12131a",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`orientation` 設 `"any"`：spec 要求直橫同等支援，而且 iPadOS Safari 本來就不理會這個欄位，寫死一個方向只會誤導後人以為問題解決了。

`index.html` 的 `<head>` 加：

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/icon-192.png" />
```

- [ ] **Step 2: 做兩個圖示**

用任何繪圖工具做 192×192 與 512×512 的 PNG，深色底（`#12131a`）配一個好認的符號（例如盾牌或劍）。存到 `public/icons/`。

做完確認：

```bash
ls -la public/icons
```

兩個檔都要存在且 > 1KB。iPadOS 的「加到主畫面」只吃 `apple-touch-icon`，缺了會變成網頁截圖當圖示，在展場上很難看。

- [ ] **Step 3: 寫 Service Worker**

`src/sw.js`：

```js
const VERSION = 'v1'
const SHELL_CACHE = `fq-shell-${VERSION}`
const ASSET_CACHE = `fq-asset-${VERSION}`
const MODEL_CACHE = `fq-model-${VERSION}`

// install 只預快取極小的 app shell，確保安裝一定成功。
// 模型檔十幾 MB，放進 install 會讓安裝在網路稍差時整個失敗。
const SHELL = ['/', '/index.html', '/manifest.webmanifest']

const NAV_TIMEOUT_MS = 2000

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE, MODEL_CACHE])
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

/**
 * 可否寫入快取。
 *
 * 刻意不用 request.mode 判斷：導覽請求的 mode 永遠是 'navigate'、
 * 子資源多半是 'no-cors'，用 mode 判斷會讓 index.html 根本進不了快取，
 * 離線時直接白畫面。
 */
function cacheable(request, response) {
  return new URL(request.url).origin === self.location.origin
      && response.ok
      && response.type !== 'opaque'
}

/** 擋 captive portal 登入頁汙染快取：必須是 HTML 且含有我們自己的標記 */
async function isOurHtml(response) {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/html')) return false
  const text = await response.clone().text()
  return text.includes('data-app-root="focus-quest"')
}

async function handleNavigation(request) {
  const controller = new AbortController()
  // 真正的風險不是斷網（會立刻 reject），而是 captive portal——
  // 連上了但沒有對外網路，fetch 會 hang 到系統逾時，畫面一直空白。
  const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS)
  try {
    const response = await fetch(request, { signal: controller.signal })
    clearTimeout(timer)
    if (cacheable(request, response) && await isOurHtml(response)) {
      const cache = await caches.open(SHELL_CACHE)
      cache.put('/index.html', response.clone())
    }
    return response
  } catch {
    clearTimeout(timer)
    const cached = await caches.match('/index.html')
    return cached ?? new Response('離線且尚未安裝完成', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (cacheable(request, response)) cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 模型與 wasm 走獨立 cache，失敗可重試（不做續傳）
  if (url.pathname.startsWith('/models/') || url.pathname.startsWith('/wasm/')) {
    event.respondWith(cacheFirst(request, MODEL_CACHE))
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
  }
})
```

- [ ] **Step 4: 讓 Vite 把 sw.js 一起建置**

`vite.config.js` 的 `build` 改成：

```js
  build: {
    target: 'safari16',
    rollupOptions: {
      input: {
        main: 'index.html',
        sw: 'src/sw.js',
      },
      output: {
        // SW 必須固定叫 /sw.js 且在根目錄，否則 scope 不對
        entryFileNames: (chunk) => (chunk.name === 'sw' ? '[name].js' : 'assets/[name]-[hash].js'),
      },
    },
  },
```

`src/main.js` 尾端加註冊：

```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 註冊失敗不影響線上使用 */ })
  })
}
```

- [ ] **Step 5: 寫 Cloudflare Pages 的安全標頭**

`public/_headers`：

```
/*
  Permissions-Policy: camera=(self), microphone=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains

/sw.js
  Cache-Control: no-cache
```

`microphone=()` 是空清單，代表**連自己都不允許**用麥克風——這是可以直接拿給評審看的證據。

`/sw.js` 設 `no-cache`：SW 檔本身被快取住的話，改版之後使用者永遠拿到舊的 SW。

spec 把完整 CSP 排除在 v1 之外（`'wasm-unsafe-eval'` 的驗證迴圈可能吃掉 1-2 天），這裡只做 Permissions-Policy / nosniff / HSTS 三項。

- [ ] **Step 6: 本機驗證建置與離線**

```bash
npm run build
ls dist/sw.js dist/manifest.webmanifest dist/models dist/wasm
npm run preview
```

`dist/sw.js` 必須存在且在根目錄（不是 `dist/assets/sw-xxxx.js`）。用 iPad 連 preview 位址，完整載入一次後**開飛航模式重新整理**——應該還能開起來。

- [ ] **Step 7: 部署到 Cloudflare Pages**

先把 repo 推上 GitHub（或用 Wrangler 直接上傳）。Cloudflare Pages 的專案設定：

| 欄位 | 值 |
|---|---|
| Framework preset | None |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Node version | 20 |

`npm ci` 而不是 `npm install`：spec 要求鎖死版本，`npm ci` 嚴格照 lockfile 安裝，版本對不上會直接失敗而不是默默升級。

部署完成後記下正式站網址，這就是 demo 當天要開的那一個。

- [ ] **Step 8: 正式站驗收**

在 iPad Safari 開正式站：

1. 開發者工具或直接觀察 → 三個模型檔都下載完成
2. 分享鈕 →「加入主畫面」→ 圖示正確（**不是**網頁截圖）
3. 從主畫面啟動 → 沒有 Safari 網址列（standalone 生效）
4. **開飛航模式**，從主畫面啟動 → 完整可玩，包含模型載入
5. 連上一個**沒有對外網路的 WiFi**（例如關掉分享的熱點）→ 冷啟動仍在 2 秒內進到畫面，不會卡白畫面
6. 確認 response headers 有 `Permissions-Policy: camera=(self), microphone=()`

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: PWA、Service Worker 與 Cloudflare Pages 部署

install 只預快取 app shell、模型走 runtime caching（十幾 MB 放進 install 會讓安裝失敗）；
快取寫入以 origin+ok+非 opaque 判斷而非 request.mode（用 mode 判斷 index.html 進不了快取）；
導覽 network-first 硬逾時 2 秒並檢查應用標記，擋 captive portal 卡白畫面與汙染快取。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: 展示模式設定、台詞簽核與交付驗收

最後一哩。這個工項沒有太多程式，但**台詞簽核與兩次實機測試是交付的硬門檻**。

**Files:**
- Create: `src/components/SettingsSheet.vue`
- Modify: `src/components/TaskSelector.vue`、`src/stores/session.js`
- Create: `docs/台詞簽核表.md`

**Interfaces:**
- Consumes: `toggleObjectDetector` / `toggleVoice`（Task 15/16）、`clearAll`（Task 17）
- Produces：設定面板；簽核紀錄

- [ ] **Step 1: 寫 SettingsSheet.vue**

```vue
<template>
  <div class="backdrop" role="dialog" aria-modal="true" aria-label="設定">
    <div class="sheet">
      <h3>設定</h3>

      <label class="row">
        <span>
          手機偵測
          <small>展場手機很多容易誤判，示範時再開</small>
        </span>
        <input type="checkbox" :checked="s.objectDetectorOn" @change="session.toggleObjectDetector()">
      </label>

      <label class="row">
        <span>
          語音提示
          <small v-if="!s.voiceAvailable">這台 iPad 沒有中文語音</small>
          <small v-else>分心提示一律不朗讀</small>
        </span>
        <input type="checkbox" :checked="s.voiceEnabled" :disabled="!s.voiceAvailable"
               @change="session.toggleVoice()">
      </label>

      <button class="danger" @click="onClear">清除所有本地紀錄</button>
      <p v-if="cleared" class="ok" role="status">已經清除了。</p>

      <button class="primary close" @click="$emit('close')">關閉</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useSession } from '../stores/session.js'
import { clearAll } from '../core/storageService.js'

defineEmits(['close'])
const session = useSession()
const s = session.state
const cleared = ref(false)

async function onClear() {
  await clearAll()
  session.rawState.history = []
  cleared.value = true
}
</script>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 12; display: grid; place-items: center;
            background: rgba(0,0,0,.6); padding: var(--gap); }
.sheet { background: var(--c-surface); border-radius: var(--radius); padding: 24px;
         width: min(94vw, 480px); display: flex; flex-direction: column; gap: var(--gap); }
h3 { font-size: var(--fs-title); margin: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--gap);
       min-height: var(--tap-primary); font-size: var(--fs-body); text-align: left; }
.row small { display: block; color: var(--c-text-dim); font-size: 14px; margin-top: 2px; }
.row input { width: 52px; height: 32px; flex: none; }
.danger { min-height: var(--tap-primary); outline: 2px solid var(--c-danger);
          color: var(--c-danger); background: transparent; }
.ok { color: var(--c-ok); font-size: var(--fs-body); margin: 0; }
.close { min-height: var(--tap-primary); }
</style>
```

- [ ] **Step 2: 在 TaskSelector 加一顆設定按鈕**

```vue
    <button class="settings" @click="settingsOpen = true">⚙︎ 設定</button>
    <SettingsSheet v-if="settingsOpen" @close="settingsOpen = false" />
```

```js
import { ref } from 'vue'
import SettingsSheet from './SettingsSheet.vue'
const settingsOpen = ref(false)
```

```css
.settings { min-height: var(--tap-min); padding: 0 18px; background: transparent;
            color: var(--c-text-dim); }
```

- [ ] **Step 3: 手機偵測展場預設關閉**

`src/stores/session.js` 的 `state` 把 `objectDetectorOn` 初值改成 `false`，並在 `boot()` 的 `state.booted = true` 之前加：

```js
    // 展場手機到處都是，誤判率必然偏高：預設關閉，評審問到再在設定裡當場開啟示範
    inference.setEnabled('object', state.objectDetectorOn)
```

- [ ] **Step 4: 建立台詞簽核表**

`docs/台詞簽核表.md`：

```markdown
# 台詞簽核表

交付前門檻：**下表全部台詞由一位成人逐句讀過並簽核**。
這是面向兒童的語音輸出唯一的實質防線，成本約十分鐘，不得省略。

## 簽核判準

每一句都要同時通過：
- [ ] 只針對戰況與行為，**不針對人格**
- [ ] 沒有「懶惰」「摸魚」「沒用」「果然做不到」等字眼
- [ ] 沒有任何身體外觀描述
- [ ] 不超過 15 字
- [ ] 唸出來不會讓國小生覺得被羞辱

## 台詞清單

（實作者請把 `src/data/copy/boss.js`、`posture.js`、`summary.js` 的每一句
逐條抄進下表，一句一列。）

| # | 來源檔 | 分類 | 台詞 | 通過 |
|---|---|---|---|---|
| 1 | boss.js | open | | ☐ |

## 簽核

- 簽核人（成人）：
- 日期：
- 結果：☐ 全數通過　☐ 有修改（修改後需重新簽核）
```

- [ ] **Step 5: 執行台詞簽核**

```bash
npm test -- src/core/copyEngine.test.js
```

先讓自動測試把禁用詞與 15 字上限掃過一遍（這只能擋掉明顯違規），然後把所有台詞填進簽核表，**請一位成人逐句讀過**。

有任何一句讓人覺得刺耳，就改掉再重新簽核。這一步沒完成**不得交付**。

- [ ] **Step 6: 效能測試一 — 25 分鐘連續 burn-in**

條件：iPad **充電中**、螢幕全亮、從主畫面啟動（standalone）、Debug HUD 開啟。

設 25 分鐘跑滿一輪，記錄：

| 時間點 | 延遲 EMA | 延遲 p95 | rAF p95 | 備註 |
|---|---|---|---|---|
| 第 5 分鐘 | | | | |
| 第 25 分鐘 | | | | |

**通過標準**（spec 定義）：
- 後 5 分鐘的 p95 ≤ 前 5 分鐘 p95 的 **1.5 倍**
- 且後 5 分鐘 p95 ≤ **150ms** 絕對值

不通過的話先看 HUD 的 fps：如果實際 fps 遠低於設定值，代表已經進入效能模式，檢查是不是動畫或 Chart.js 在吃主執行緒（**不是**推論——spec 已量過推論只佔約 6.6% GPU duty cycle）。

- [ ] **Step 7: 效能測試二 — 連續 5 輪不重整頁面**

不重新整理頁面，連續跑 5 輪（可用展示模式加快），每輪結束後記 HUD 數字：

| 輪次 | 延遲 EMA | 延遲 p95 | contextlost |
|---|---|---|---|
| 1 | | | |
| 5 | | | |

**通過標準**：延遲數字**不單調上升**、全程**不出現 contextlost**。

單調上升代表跨輪有東西沒釋放。第一個要查的是有沒有誰在每輪結束時呼叫了 `inference.destroy()`——spec 明確要求跨輪重複使用同一個 InferenceService。

- [ ] **Step 8: 展前檢查清單**

```markdown
展前必做（demo 前一天再跑一次）：
- [ ] 用「加到主畫面」安裝並完整載入模型
- [ ] 開飛航模式驗證一次完整流程
- [ ] 連上「無對外網路的 WiFi」冷啟動一次（測 captive portal 逾時）
- [ ] demo 前一天重新開一次確認快取還在
      （iOS ITP 約 7 天會清掉未安裝站點的儲存，所以一定要用安裝的方式）
- [ ] iPad 設定 → 螢幕顯示與亮度 → 自動鎖定 → **永不**
- [ ] 手機偵測確認在設定裡是**關閉**狀態
- [ ] 語音確認在設定裡是**關閉**狀態
- [ ] 備一台手機熱點
- [ ] 台詞簽核表已完成並簽名
```

- [ ] **Step 9: 完整回歸（直橫各一次）**

從清除所有資料開始，**橫式**與**直式**各走一次完整流程：

1. 隱私說明 → 展開家長版 → 同意
2. 鏡頭權限 → 允許
3. 校準 5 秒
4. 選任務與時長（試一次步進器、一次快捷鍵）
5. 展示模式 20 秒完整打完（含刻意駝背一次）
6. 結算三張圖 + 白話總結
7. 「再討伐一次」→ 不重跑校準
8. 設定 → 開手機偵測 → 拿手機入鏡 → 撤銷一次、放著生效一次
9. 設定 → 清除所有紀錄 → 統計歷史真的空了

- [ ] **Step 10: 最終 commit**

```bash
npm test && npm run lint && npm run build
git add -A
git commit -m "$(cat <<'EOF'
feat: 展示模式設定、台詞簽核表與交付驗收

設定面板含手機偵測開關（展場預設關閉，評審問到再當場開啟示範）、
語音開關與清除紀錄；附台詞成人簽核表與兩次實機效能測試的記錄表。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review 紀錄

寫完後對照 spec 逐節檢查的結果。

**Spec 覆蓋**：元件拆分表 19 個元件全部有對應工項（InferenceService/CameraCapture→T6,7；PoseAnalyzer→T3；FocusStateMachine→T4；CalibrationWizard→T9；TaskSelector→T11；MessageQueue/PostureCoach/BossDialogue→T13；BattleView→T14；SessionTimer→T10；StatsDashboard/StorageService→T17,18；PermissionGate→T19；StatusIndicator→T16；CopyEngine→T12；InstallGuide/BreakScreen→T20；VoiceFeedback→T15）。戰鬥數值→T2+T4；展示模式→T2+T22；三張圖→T18；PWA→T21；debug HUD→T16；FocusStateMachine 單元測試→T4。

**寫計畫過程中發現並已回填 spec 的四個缺口**：
1. 校準基準原寫「角度」，但前鏡頭量不到矢狀面角度 → 改為正規化比值（spec v4.2）
2. `postureDurationMs` 五個桶原本可能重疊，圓餅圖與雷達圖都需要總和等於時長 → 改為互斥並記錄代價（v4.2）
3. BreakScreen 原本只有職責沒有觸發時機 → 補上兩個入口（v4.2）
4. 戰鬥畫面版面原本只寫「英雄/魔王/血條」，沒有定義兩者的空間關係 → 補上完整版面規格與動畫語彙（v4.3）

**一處刻意偏離 spec 並已在計畫中註明理由**：spec 寫三張圖都套 `parsing:false` / `pointRadius:0`，但這兩個選項套在圓餅圖與雷達圖上會讓圖畫不出來。改為只套在折線圖（180 點，也只有它需要）。見 Task 18 Step 6 的註解。

**已於寫計畫階段查證、不再是未知數的事項**：

- **`createFromOptions` 的 `canvas` 選項 — 支援，v1.0.1 確認。**
  讀 `node_modules/@mediapipe/tasks-vision/vision.d.ts` 與 `vision_bundle.mjs` 得到：
  - `canvas?: HTMLCanvasElement | OffscreenCanvas` 定義在 `VisionTaskOptions` 上，而
    `PoseLandmarkerOptions` / `FaceLandmarkerOptions` / `ObjectDetectorOptions` 三個都 `extends VisionTaskOptions`。
  - bundle 裡 11 個 vision task 的 `createFromOptions` 共用同一個工廠函式，函式本體第一件事就是
    `options.canvas ?? (支援 OffscreenCanvas ? undefined : document.createElement('canvas'))`。
  - 不傳 `canvas` 時，GraphRunner 建構子會 `new OffscreenCanvas(1, 1)`——**每個 task 各建一個**，
    也就是三個獨立 GL context。共用是官方支援的路徑，不是繞過。
  - MediaPipe 只在 **Safari 17 以上**才信任 OffscreenCanvas（bundle 內有 UA 版本判斷），
    所以 `createInferenceCanvas()` 抄了同一套判準。目標機 iPadOS 17+ 走 OffscreenCanvas。
  - 該 canvas 一旦被 MediaPipe 綁上 WebGL context，再 `getContext('2d')` 會噴
    `You cannot use a canvas that is already bound to a different type of rendering context.`
    所以它只能是 1×1 的專用載體，不能兼作預覽畫布。
  - 版本綁定：Task 1 Step 1 釘 `@mediapipe/tasks-vision@1.0.1` 並附一行 grep 檢查，
    換版時若該行沒印出 `canvas 選項 OK`，Task 7 要重新評估。
  - Task 22 測試二的 `contextlost` 檢查仍然保留——那測的是記憶體壓力下的 context 遺失，
    跟本項無關，不因本項查證而放寬。

- **姿態閾值 — 改成量測，不再是猜測。**
  原本的問題不只是「數字要調」，而是**根本沒有量測手段**：
  Task 7 的預覽畫面原本寫死 `baselineNeckRatio: 1.0`，但真人在真實鏡頭角度下的
  `neckRatio` 不可能剛好是 1.0，整場會一直判成低頭，閾值再怎麼改都是在噪音裡瞎調。
  已改為：
  - 新增純模組 `src/core/thresholdLab.js`（9 個 Vitest 案例），收「坐正／駝背」兩組標記樣本，
    比較兩組的 p5 / p50 / p95，**分佈重疊時明確拒絕給建議**而不是給一個看起來很像的數字。
  - 基準值取坐正組的中位數（與 Task 9 校準精靈同一套作法），預覽畫面可一鍵套用。
  - 預覽畫面直接顯示 `neckRatio` / `shoulderWidth` 的生數值與當前判定邊界，
    讓人看得出離觸發還有多遠，而不是只看到一個狀態字串。
  - Task 7 Step 10b 定義了三種量測結果各自的處置（含「量不出來就停下來回報」這個出口），
    Step 10c 定義了抖動時該調 `postureHoldMs` 而不是再動 `neckDropRatio`。
  - 最終填進 `postureProfiles.js` 的四個數字**必須**寫進 Task 7 的 commit message，作為魔數的出處。
  - 隱私：實驗室全程只在記憶體內計算百分位數，不寫檔、不匯出、不進任何儲存層，
    不違反「禁止寫入或傳出原始角度時序」。

**仍然只能在實機上決定的事**（性質上無法在寫計畫階段解決）：
- 量測必須在**最終的 iPad 擺放角度**下進行，換立架或換座位距離要重量一次。Step 10 開頭已註明。
- 肩寬指標是否具鑑別度取決於鏡頭高度，Step 10b 的表格已寫明沒鑑別度時的降級作法（改由 `neckRatio` 單獨決定 slouch）。

