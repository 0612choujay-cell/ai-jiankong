---
name: spec-review
description: 對寫好的 spec 派 4 個維度的 reviewer agent 平行審查（security、performance、conventions、UX）並整合回饋。當使用者說「review spec」、「審 spec」、「expert review」、「找專家看」或直接打 /spec-review 時觸發。也適用於 plan v1 寫完要進迭代的時機。
---

# Spec Expert Review

對 spec / plan 文件平行派 4 個 reviewer subagent，整合回饋產出下一版。

## 觸發時機

- spec v1 / v2 / v3 寫完，準備迭代到下一版
- plan 寫完要進實作前
- 大型 refactor 提案要找盲點
- 使用者明確要求「找 4 個專家看」

## 輸入

使用者提供 spec / plan 路徑（通常在 `docs/superpowers/specs/<topic>-design.md`）。

## 流程

### 1. 確認 spec 路徑與目前版本

讀檔頭確認版本號 / 上次 review 紀錄。如果已經是 v4+ 且每輪都收到 0 個 critical，回報已收斂，問使用者要不要進實作。

### 2. 平行派 4 個 reviewer subagent

用 Agent tool **同一個 message 內** 一次發 4 個（順序不分先後）：

#### Reviewer A — Security

```
你是 security reviewer，獨立審查不參考其他 reviewer 的視角。

讀 <spec 路徑>，從以下角度找問題：
- 鏡頭/麥克風權限：是否明確引導使用者授權、拒絕時的降級處理
- 本地資料隱私：IndexedDB / localStorage 是否存了不該存的敏感資料（人臉影像、姿態原始座標）、有無不當外洩管道
- PWA / Service Worker：快取策略是否可能快取到過期或不該快取的內容、CSP 設定是否足夠
- 若涉及任何雲端同步（Cloudflare Workers/D1）：API 是否有認證授權、輸入是否驗證
- 第三方腳本／CDN 依賴是否釘死版本、來源可信

輸出 markdown：每個 finding 標 Critical / Major / Minor，附行號 + 建議修法。
```

#### Reviewer B — Performance

```
你是 performance reviewer，獨立審查不參考其他 reviewer 的視角。

讀 <spec 路徑>，從以下角度找問題：
- MediaPipe 推論頻率／解析度是否會導致 iPad 過熱降頻或掉幀
- 主執行緒是否被推論或渲染阻塞，是否該用 Web Worker
- IndexedDB 寫入頻率／單筆資料量是否合理
- Service Worker 快取的模型檔案大小是否影響首次載入體驗
- Chart.js 渲染大量歷史資料時是否有效能疑慮
- 電池消耗：鏡頭常駐 + Wake Lock 是否有對應的省電策略

輸出 markdown：每個 finding 標 Critical / Major / Minor，附行號 + 建議修法。
```

#### Reviewer C — Project Conventions

```
你是 project conventions reviewer，獨立審查不參考其他 reviewer 的視角。

讀 <spec 路徑> + 對齊以下文件後找違規：
- `docs/superpowers/specs/` 下其他既有 spec（若有前後版本，检查是否前後矛盾）
- 本專案根目錄 `CLAUDE.md`（若存在）
- 已核准的架構決策（純前端 PWA、iPad Pro M1 單一裝置、Cloudflare Pages 託管、v1 不做雲端多人）是否被違反或悄悄擴大範圍

輸出 markdown：每個 finding 標 Critical / Major / Minor，附來源章節 + 建議修法。
```

#### Reviewer D — UX 一致性

```
你是 UX consistency reviewer，獨立審查不參考其他 reviewer 的視角。

讀 <spec 路徑>，從以下角度找問題：
- iPad 觸控互動：按鈕尺寸、手勢是否符合觸控裝置慣例（非滑鼠介面）
- PWA 安裝與離線體驗：首次加到主畫面的引導、離線時的降級提示是否清楚
- 訊息／提示文字具體度：例如姿態不良提示是否明確可行動，而非籠統警告
- 無障礙：色彩對比、是否只靠顏色傳達警示、字級是否適合平板閱讀距離
- 兒童/青少年使用情境（本作品面向國小組）：文字用語、互動節奏是否合齡

輸出 markdown：每個 finding 標 Critical / Major / Minor，附行號 + 建議修法。
```

### 3. 整合回饋

收到 4 份 review 後，建立整合表：

```markdown
## v<N> → v<N+1> 整合 review

| # | Severity | 維度 | Finding | 修正方向 |
|---|----------|------|---------|---------|
| 1 | Critical | Security | ... | ... |
| 2 | Major | Performance | ... | ... |
```

去重複（多個 reviewer 重複指出的同一點合併）、排優先序（Critical → Major → Minor）。

### 4. 產出 v(N+1)

把整合表附在 spec 末尾的 Amendment 章節，或直接改 spec 本體並更新版本號/修訂紀錄行（依整合結果決定，內容變動大時優先直接改本體，避免 spec 被 amendment 堆得零散）。

### 5. 報告

跟使用者說：

- 4 reviewer 各回多少 Critical / Major / Minor
- 已整合到 v(N+1) 的條目數
- 還有哪些待釐清（reviewer 之間矛盾、需要使用者裁決）
- 下一步建議（再 review 一輪、進實作、撤回 spec 重寫）
