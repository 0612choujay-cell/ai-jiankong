# 專注討伐戰：懶惰大魔王（iPad Pro M1 單機版）設計文件

版本：v4.4
狀態：已完成 writing-plans，計畫見 `docs/superpowers/plans/2026-09-11-focus-quest-implementation.md`

## 修訂紀錄

| 版本 | 日期 | 變更摘要 |
|---|---|---|
| v1 | 2026-09-11 | 初版設計 |
| v2 | 2026-09-11 | 整合第一輪四維度 spec-review：修正架構矛盾、補安全/效能/UX 規範 |
| v3 | 2026-09-11 | 確立「v1 全本地零網路依賴」；新增本地文案引擎、台詞庫、TTS、任務選單 |
| v4 | 2026-09-11 | 整合第二輪 spec-review：**補戰鬥數值與勝負條件**（v1-v3 完全缺席）、修機制斷點、依「不到 1 個月」時程大幅瘦身（砍 Worker/三檔自適應/不可量測驗收等） |
| v4.1 | 2026-09-11 | A/B 分期合併為一次交付；元件表「級」改「序」；補雷達圖五軸定義 |
| v4.2 | 2026-09-11 | writing-plans 過程發現的三處補正：校準基準改用正規化比值、姿態統計桶改為互斥、補 BreakScreen 觸發時機 |
| v4.3 | 2026-09-11 | 新增戰鬥畫面版面規格：直/橫式皆為「一半自己鏡頭、一半魔王」的對戰式版面；攻擊由自己這側飛向魔王，分心時魔王反擊飛回來 |
| v4.4 | 2026-09-11 | 新增「姿態閾值必須用量測決定」：兩組標記樣本比對分佈，重疊時禁止硬填數值；補記最終數值須寫入 commit message 的出處要求 |

## 核心原則

1. **全本地、零網路依賴**：除首次下載模型檔外，所有功能在飛航模式下可完整運作。理由：展場 WiFi 不可靠；隱私訴求純粹（可直接回答評審「不用連網，影像不出這台 iPad」）；MediaPipe 本身即端側 AI，AI 含量不受影響。
2. **範圍紀律**：交件期不到 1 個月。**做不完就是失敗**。v1 一次交付（不分期），範圍即「v1 範圍」一節所列；末尾「這次不做」一節的項目一律不碰。

## 背景

IEYI 世界青少年創客發明展臺灣選拔賽「國小組」參賽作品（來源：`01_作品摘要說明_專注討伐戰_懶惰大魔王.pdf`，未入 repo）。原案為 AI 專注與坐姿偵測遊戲化系統，把專注/坐姿轉化為 RPG 戰鬥，結束後產出統計圖表。

原案技術棧為桌機（Electron + 獨立鏡頭 + 雲端多人），本設計改為**只用 iPad Pro M1 一台**。作品名稱為報名表登記名稱不可更動，但遊戲內文案採中性語氣（見「文案規範」）。

## 已核准決策記錄

| 決策 | 內容 | 理由 |
|---|---|---|
| 執行形式 | Safari PWA，非原生 App | iPad 無法跑 Electron；PWA 開發最快 |
| 鏡頭 | iPad 前鏡頭自拍偵測 | 只有一台裝置 |
| 分心偵測 | 離開偵測（Page Visibility）＋ 鏡頭內手機物件偵測 | iPadOS Safari 不開放擷取其他 App 畫面（沙盒限制），改以鏡頭內實體物件偵測逼近原案精神 |
| 雲端 | v1 不做。Cloudflare Pages 僅託管靜態站 | 範圍收斂；v2 再做多人連線與 LLM |
| 推論執行位置 | **主執行緒**，封裝為 `InferenceService`（`async analyze()`） | v2 曾核准 Worker+OffscreenCanvas，但 WebGL-in-Worker 需 iPadOS 17（我們基準是 16.4），且 ImageBitmap 生命週期有洩漏風險。推論僅佔主執行緒 10-15%，而動畫只用 transform/opacity 跑在合成執行緒不受阻塞。介面封裝保留日後搬進 Worker 的可逆性（只需改一個檔） |
| 支援基準 | iPad Pro M1 / iPadOS ≥ 16.4 / Safari | 16.4 為 Screen Wake Lock 下限。不支援其他機型，不做相容矩陣 |

## 戰鬥數值與勝負條件

**設計原則：達成 60% 專注率 ＝ 剛好在時限內打倒魔王。** Boss HP 由時長反推，任何時長都保持此不變式。

門檻訂在 60% 而非 80%，因為國小生要在 15 分鐘裡有 80% 時間維持端正坐姿是過高的要求——70% 已經表現不錯，卻會每次都打不倒，變成「怎麼努力都輸」。

| 項目 | 數值 | 說明 |
|---|---|---|
| 單輪時長 | 預設 15 分鐘，可調 5-40 分鐘 | −/+ 步進器 ＋ 快捷鍵（10/15/20/25），不用純文字輸入框（國小生打字慢易錯） |
| **Boss HP** | **144 × 時長(分鐘)** | 15 分 → 2160；12 次/分 × 60% × 20 傷害 = 144/分 |
| 攻擊間隔 | 端正且專注時每 5 秒 1 次 | |
| 每次傷害 | 20 | |
| 玩家 HP | 100 | |
| 姿態不良扣血 | 每 5 秒 −3 HP | 約 2.8 分鐘持續不良才歸零 |
| 玩家 HP 歸零 | **不是失敗**：進入「重整旗鼓」10 秒（無法攻擊），HP 回復至 30 | 對國小生不設 game over，避免挫折 |
| 陷阱（手機／離開） | Boss 回血 +5% 上限、積分 −100 | |
| 瞌睡 | 不影響戰鬥數值，只觸發休息建議 | 疲倦不該被懲罰 |
| 積分 | 每次攻擊命中 +10 | |

**第二形態（提早擊倒時觸發）**：專注率高於 60% 者會提前打倒魔王（100% 專注約在 60% 時點擊倒）。此時魔王進入第二形態、補一段血繼續戰鬥，額外傷害換額外積分，**該輪仍跑滿設定時長**。

這條規則是必要的，否則「打倒魔王就結束該輪」等於在**獎勵提早結束讀書**——遊戲目標會和教育目標相反。

**結算狀態只有兩種**（無「失敗」）：
- **勝利**：時限內 Boss HP 歸零（含第二形態進度）
- **時間到未擊倒**：顯示「打掉了 X%」，仍給積分與統計

### 展示模式（評審試玩）

| 項目 | 數值 |
|---|---|
| 時長 | **20 秒** |
| 攻擊間隔 | **1 秒**（不可沿用 5 秒——20 秒只會有 4 次攻擊，看起來不像在戰鬥） |
| Boss HP | **240**（20 次機會 × 60% × 20 傷害） |
| 校準 | **排在 20 秒之外**，否則 5 秒校準會吃掉四分之一展示時間 |
| 姿態判定閾值 | **不縮放**（駝背需持續 N 秒是生理時間）。故 20 秒內只來得及示範 1-2 次姿態事件，展示時需刻意駝背一次 |

所有數值標註為初始值，需實機調整。

### 姿態閾值必須用量測決定

`neckDropRatio` / `shoulderGrowRatio` 這類姿態閾值**不得靠「改一個數字、重載、再試一次」的方式收斂**。
前鏡頭量到的比值受鏡頭高度、坐姿距離、體型影響極大，憑感覺調出來的值換一個人或換一次立架角度就失效，
而且過程中無法分辨「閾值不對」和「這個指標根本分不出差別」。

交付流程強制包含一個量測步驟：

- 在**最終的 iPad 擺放角度**下，分別收集「坐正」與「刻意駝背」兩組有標記的樣本（各 ≥ 5 秒）。
- 比較兩組的 p5 / p50 / p95。判定邊界取兩組之間的中點，基準值取坐正組的中位數。
- **兩組分佈重疊時不得填入任何閾值**——這代表該指標在此擺法下沒有鑑別度，
  必須先調整鏡頭角度或坐姿距離重新量測；重量三次仍分不開則視為設計前提不成立，需回頭修 spec。
- 肩寬指標若無鑑別度，允許降級為「slouch 單獨由 neckRatio 決定」，但須在程式碼中註明此為實測結果。
- 狀態在邊界附近來回抖動時，調整 `postureHoldMs`（持有時間），不得再動閾值本身。
- 最終採用的數值必須連同量測條件記錄在版本控制的 commit message 中，作為這些魔數的唯一出處。

量測過程只在記憶體內計算百分位數，不寫檔、不匯出、不進任何儲存層，符合本文件的隱私紅線。

## 架構總覽

- **框架**：Vue3 + Vite
- **部署**：Cloudflare Pages（純靜態託管）
- **AI 偵測**：MediaPipe Tasks Vision（`PoseLandmarker` + `FaceLandmarker` + `ObjectDetector`，lite 模型，WASM + GPU delegate），主執行緒執行，完全本地
  - `PoseLandmarker` 33 點（含耳 7/8、肩 11/12）→ 頭頸前傾角度、肩頸對齊
  - `FaceLandmarker` blendshapes（`eyeBlink*`、`eyeLook*`）→ 閉眼、視線大方向
  - `ObjectDetector`（EfficientDet-Lite0，COCO 含 `cell phone`）→ 手機偵測
  - **三個 task 共用同一個 canvas / GL context**（避免多 context 觸發 Safari 回收）
  - **`numPoses: 1` / `numFaces: 1`，多人入鏡時只取 bounding box 最大者**（展場必然有旁人入鏡；同時是第三人隱私保護）
- **相依**：npm 精確版本釘選 + lockfile 入庫 + `npm ci`（理由是 demo 穩定性）；wasm fileset 與模型檔自我託管於同源
- **本地儲存**：IndexedDB（歷史紀錄）＋ localStorage（崩潰保險，見「資料流」）
- **圖表**：Chart.js（`animation:false`、`parsing:false`、`pointRadius:0`）
- **語音**：Web Speech Synthesis（系統語音，本地合成）
- **文案**：本地規則式引擎，無雲端 LLM
- **螢幕喚醒**：Screen Wake Lock（並要求手動把「自動鎖定」設為永不，兩層都做）

記憶體估算：Face+Pose ≈ 60MB、ObjectDetector ≈ 20-30MB、WASM heap ≈ 30-50MB、相機 buffer ≈ 10MB → **約 120-150MB，上限 250MB**。

## 元件拆分

全部元件都在 v1 範圍內（不分期交付）。**[序]** 欄標示建議實作順序——即使一次交付，仍應先讓核心迴圈跑通再加周邊，萬一時程吃緊時才不會變成「每個功能都做一半」。

| 元件 | 序 | 職責 |
|---|---|---|
| InferenceService | 1 | 封裝三個 MediaPipe task，對外 `async analyze()`。固定頻率：Pose 2fps / Face 3fps / Object 0.33fps，**EDF 排程**（每模型維護 `nextDueTime`，選最早到期者；被丟棄時不重置，避免低頻模型餓死）。單一 in-flight 保護，前次未完成則丟棄新幀 |
| PoseAnalyzer | 2 | 對照校準基準輸出姿態狀態：端正／駝背／頭部前傾／瞌睡／視線偏移。**判定用零階保持＋時間積分**（每個取樣結果持有到下一取樣點，滑動窗口累加秒數），且窗口內至少 2 個取樣點才可觸發 |
| CameraCapture | 1 | `getUserMedia({audio:false, video:{facingMode:'user', width:{ideal:640}, height:{ideal:480}, frameRate:{max:15}}})`。**直接把 `<video>` 元素交給 `detectForVideo()`，不做手動縮圖**（MediaPipe 內部會 letterbox；手動縮成正方形會壓扁人臉、扭曲校準基準）。暫停/結束/`pagehide` 時 `track.stop()` 並清空 `srcObject` |
| CalibrationWizard | 3 | 引導 5 秒端正坐姿（含示範圖＋即時預覽＋對齊框），取樣**中位數**為基準、捨棄離群值（不做晃動重來迴圈）。校準期間 Pose 提頻至 5-8fps、關閉 Face/Object。**主畫面常駐「換人／重新校準」按鈕（≥60pt）** |
| TaskSelector | 4 | 選任務類型（寫作業／看書／背單字／自己選）＋ 設定時長。**任務類型決定姿態閾值 profile**：看書/寫作業類頭頸前傾容許角度 +15°，且需「前傾且肩線塌陷」同時成立才判駝背。預設值已選，可直接開始 |
| FocusStateMachine | 2 | 整合姿態狀態＋手機信號＋Page Visibility＋計時器，依「戰鬥數值」表輸出事件 |
| MessageQueue | 5 | 單一 priority store。PostureCoach 與 BattleView 都只是發布者，由它決定同時顯示哪一則（優先序：安全/休息 > 姿態修正 > 陷阱原因 > 戰鬥數值特效，同時最多 1 則） |
| PostureCoach | 5 | 依狀態發布可行動提示（祈使句）。**前 3 次用因果格式**（「魔王反擊！（你駝背了）→ 背靠椅背」），第 4 次起簡化為純指令 |
| BattleView | 4 | **對戰式分半版面**（見「戰鬥畫面版面」）：一半是使用者自己的鏡頭即時畫面（英雄側），一半是魔王。血條**同時顯示數字**，傷害數字**附 2-3 字原因標籤**。動畫只用 `transform`/`opacity`，事件驅動非持續 60fps，尊重 `prefers-reduced-motion` |
| SessionTimer | 3 | 開始/暫停/結束；開始時請求 Wake Lock 並啟動鏡頭，暫停/結束時同時釋放與停止鏡頭 |
| StatsDashboard | 6 | 首屏白話總結＋下次目標，其後圓餅圖與折線圖。**底部固定兩顆 ≥60pt 按鈕：「再討伐一次」（沿用同任務與校準，不重跑 Onboarding）／「回主畫面」** |
| StorageService | 6 | IndexedDB 讀寫；「清除所有紀錄」按鈕 |
| PermissionGate | 7 | 授權前顯示用途說明；`NotAllowedError` 給完整復原步驟（設定路徑）＋「我設定好了，重試」按鈕 |
| StatusIndicator | 8 | 正常時收斂為一個綠點＋「偵測中」；**異常/降級才展開**：鏡頭未運作、手機偵測未啟用、離開偵測未啟用、語音不可用、效能模式。**不顯示「線上/離線」**（v1 離線一樣能玩，顯示離線只會製造焦慮） |
| CopyEngine | 5 | 單一持有所有文案池（姿態/魔王/總結三個 namespace）。取句器：輸入分類 key ＋ slot，輸出填好的句子，負責 shuffle bag 與 cooldown |
| InstallGuide | 9 | 開始後的一行可關閉橫幅，**不擋流程** |
| VoiceFeedback | 8 | Web Speech TTS，見「語音規範」 |
| BossDialogue | 7 | 事件 → 情境分類的映射器（不持有資料，資料在 CopyEngine） |
| BreakScreen | 9 | 休息回合：3 分鐘倒數＋伸展建議＋魔王休戰台詞；可提前結束，可跳過（需點兩下）。**觸發時機**：(a) 本輪時長 ≥20 分鐘時，StatsDashboard 的「再討伐一次」先進休息回合；(b) 戰鬥中判定瞌睡時，提示列附「休息一下」按鈕手動進入。展示模式不觸發 |

## 資料流

```
[Onboarding] 隱私說明 → 鏡頭權限 → 模型下載（背景，與校準並行）
             → 校準（CalibrationWizard，Pose 提頻）→ TaskSelector（預設已選）→ 開始

[戰鬥迴圈] <video> → InferenceService.analyze()（EDF 排程，單一 in-flight）
  → PoseAnalyzer（零階保持＋時間積分，對照校準基準與任務 profile）
  → 狀態：端正／駝背／頭部前傾／瞌睡／視線偏移（往旁往上）／手機出現
  → FocusStateMachine（＋visibilitychange ＋計時器）依「戰鬥數值」表判定：
      端正＋專注 → 每 5 秒攻擊（展示模式 1 秒），−20 Boss HP、+10 積分
                   Boss HP 歸零且時間未到 → 進入第二形態繼續戰鬥
      駝背/前傾/視線往旁往上 → 每 5 秒 −3 玩家 HP（附因果提示）
      視線往下 → 正常閱讀，不判分心
      瞌睡（閉眼 >2 秒）→ 休息建議，不影響數值
      手機連續 3 秒（2-3 秒倒數預警後）→ 陷阱（可撤銷，見下）
      離開 >5 秒 → 陷阱（回前景時提供撤銷）
  → MessageQueue → PostureCoach/BattleView（＋VoiceFeedback）

[持久化] 結束時寫 IndexedDB 一次
         visibilitychange→hidden / pagehide 時同步寫 localStorage crumb
           { sessionId, elapsedMs, score, bossHp, updatedAt }
           （IndexedDB 非同步，iOS 可能在 commit 前凍結頁面；localStorage 是同步 API）
         啟動時 crumb 比 IndexedDB 新 → 以 crumb 補完

[背景/前景] hidden：暫停推論、track.enabled=false、釋放 Wake Lock、speechSynthesis.cancel()
            visible：檢查 track.readyState
                     'live' → 恢復並暖機 1-2 幀
                     'ended' → 重新 getUserMedia（沿用既有權限，不再跳對話框）
                     失敗 → StatusIndicator 顯示並暫停計分
            另監聽 track.onended，不只靠 visibilitychange

[結束] 停止推論排程 → track.stop() 全部 → 寫入 IndexedDB → 釋放 Wake Lock
       → chart.destroy() 舊圖表 → 渲染 StatsDashboard
       **不 close task、不重建 InferenceService**（跨輪重複使用；每輪重建會累積 GPU 記憶體並拖慢第二輪）
```

**陷阱撤銷採「延後生效」而非事後回滾**：觸發後進入 20 秒待確認（顯示警告＋「我沒在用手機」按鈕），期間**不扣分、不回血、不中斷連擊、不發聲**；20 秒未撤銷才正式生效。此設計消除回滾語意與「語音收不回」的問題，且撤銷視窗結束前不寫入持久層。

## 資料模型

**禁止寫入**：landmark 座標、blendshape 數值、影像/快照、原始角度時序、裝置識別碼。影格用後即 `close()`，永不序列化。`vite.config` 設 `esbuild: { drop: ['console','debugger'] }`（比「規範禁止 console.log」可靠）。

```
SessionRecord {
  id, startedAt, endedAt, durationMs, status: 'in_progress' | 'completed',
  taskType: 'homework' | 'reading' | 'vocab' | 'custom',
  postureDurationMs: { upright, slouch, forwardHead, drowsy, gazeAway },
  distractionDurationMs: { phone, away },     // 時長，圓餅圖需要（只有次數算不出佔比）
  trapCount: { phone, phoneUndone, away, awayUndone },
  attacks, score, bossHpRemaining, bossHpMax, phase2Damage, result: 'victory' | 'timeout'
}
CalibrationProfile { id: 'default', baselineNeckRatio, baselineShoulderWidth, calibratedAt }
```

**校準基準用正規化比值，不用角度**：前鏡頭是正面視角，量不到矢狀面（側面）的頭頸前傾角度。改用兩個對距離不敏感的比值——
`neckRatio = (肩中點 y − 耳中點 y) ÷ 肩寬`（頭前傾/低頭時變小）、`shoulderWidth`（身體靠近桌面時變大）。
本文件其他地方提到的「角度容許 +15°」一律換算為「容許值放寬 50%」。

**`postureDurationMs` 五個桶互斥**，優先序 `drowsy > slouch > forwardHead > gazeAway > upright`，使五桶總和等於本輪時長（圓餅圖與雷達圖都需要此性質）。
代價是瞌睡與駝背同時發生時只記瞌睡，背部健康軸會略為樂觀；此誤差可接受。戰鬥判定不受影響——FocusStateMachine 另外收到獨立的 `drowsy` 布林值。

`dpsSeries` 以 5 秒為 bucket 聚合（15 分鐘 → 180 點）。

## 效能規範

- **固定單檔**：Pose 2fps / Face 3fps / Object 0.33fps（合計約 5.3 次/秒）。相機固定 640×480，**不做解析度階梯**（`applyConstraints` 在 iOS 會重新協商 capture session 造成黑畫面，且影格反正會被 letterbox，收益為零）
- **唯一的自適應（單向緊急降檔，不可升回）**：推論延遲 EMA(α=0.2) > 150ms 連續 10 秒 → 頻率減半＋關閉 ObjectDetector → StatusIndicator 顯示「效能模式」。**不可用主執行緒 rAF 掉幀率當降檔依據**（在主執行緒架構下掉幀多半來自動畫/Chart.js，降推論頻率無法改善，只會一路降到底卡死）
- **關閉 ObjectDetector 屬功能性降級**，必須連動 StatusIndicator 顯示「手機偵測已暫停」（否則使用者拿手機沒事會以為系統壞了）
- **推論健康 watchdog**：監聽 `webglcontextlost`（`preventDefault()` 允許 restore）；連續 10 秒無成功推論 → 暫停計分、StatusIndicator 顯示「偵測已停止」、提供「重新啟動偵測」按鈕
- 推論負擔實測參考：Pose ≈ 5-10ms、Face ≈ 8-12ms、Object ≈ 15-25ms → 約 6.6% GPU duty cycle。**熱源不是推論**，而是相機 ISP、`<video>` 合成、Wake Lock 全亮螢幕；故戰鬥動畫必須事件驅動，閒置時每秒重繪 < 5 次

**驗收改為 debug HUD ＋ 兩次實機測試**（Safari 不支援 Long Tasks API、無 `performance.memory`、GPU 記憶體無任何 Web API，原本的量化標準無法執行）：

- Debug HUD（角落點三下開啟）：推論延遲 EMA/p95、各模型實際 fps、rAF 間隔 p95 與最大值、本輪秒數、累計輪數、ImageBitmap 建立/關閉計數
- 測試一：25 分鐘連續 burn-in（充電中、螢幕全亮）→ 後 5 分鐘 p95 ≤ 前 5 分鐘 1.5 倍，且 p95 ≤ 150ms 絕對值
- 測試二：連續 5 輪不重整頁面 → HUD 延遲數字不單調上升、不出現 contextlost

## 語音規範

- **暖機（必做，否則現場可能整場無聲且不報錯）**：在「開始專注」的 click handler 內同步 `speak()` 一個極短 utterance，完成 iOS user-gesture 解鎖並預載語音資產
- 啟動時經 `voiceschanged` 取得並 pin 住 zh-TW voice（`getVoices()` 首次回空陣列）；不存在則停用語音並於 StatusIndicator 顯示「語音不可用」，不擋流程
- `visible` 時無條件 `speechSynthesis.cancel()` 一次（清除 iOS 背景返回後卡死的佇列）
- **單槽播放＋優先權搶佔**：同時最多 1 條；高優先直接 cancel 後搶播，低優先直接丟棄不排隊。台詞長度上限 15 字
- **預設關閉**，主畫面提供明顯的喇叭開關（非埋在設定）
- **分心類提示（手機/離開）一律不朗讀**，只走畫面——用語音念出「偵測到手機」等於把使用者被抓包的事廣播給旁人
- 所有語音內容必須同時有畫面文字

## 文案規範

- 作品名稱不變；**遊戲內提示改中性語氣**：不用「懶惰」「摸魚」，陷阱直接講具體原因（「偵測到手機出現」「你離開了專注畫面」）
- **魔王台詞語氣界線**：只針對戰況與行為，不針對人格。✅「手機出現了，這一刀我閃掉了！」✅「才這樣就想打敗我？」❌「懶惰」「沒用」「果然做不到」❌ 任何身體外觀描述
- **交付前門檻：全部台詞由一位成人逐句讀過並簽核**（成本十分鐘；這是面向兒童的語音輸出唯一的實質防線）
- 提示節流（比擴充文案池重要）：同狀態 cooldown ≥ 45 秒，連續同狀態時第 2 次起改為無語音、僅小圖示閃爍；取句用 shuffle bag（同輪內不重複）
- 文案池規模：姿態每狀態 4 句；台詞庫總計約 20 句（開場 3／連擊 5／陷阱各 3／瞌睡 3／結算各 3）

| 狀態 | 提示文字 |
|---|---|
| 頭部前傾 | 下巴往後收，耳朵對齊肩膀 |
| 駝背 | 背靠椅背，肩膀往後打開 |
| 視線往旁/往上 | 眼睛回到畫面上 |
| 瞌睡 | 眼睛快閉上囉，起來動一動 30 秒 |
| 手機出現 | 偵測到手機出現 |
| 離開畫面 | 你離開了專注畫面 |

**StatsDashboard 總結需有冷啟動分支**（評審試玩就是第一次使用，沒有昨日、沒有連續天數，否則只會落到最弱的「一般鼓勵」）：
```
首輪（無歷史）優先：「你專注了 X 分鐘，其中 Y 分鐘坐得很端正（Z%），砍了魔王 N 刀。
                    最常發生的是 <姿態問題>，下次試試 <對應動作>。」
有歷史：連續達標創新高 > 比昨日進步 > 最高頻姿態問題 > 一般鼓勵
```

## 戰鬥畫面版面

**核心視覺概念：這是一場「你 vs 魔王」的對打，畫面一半是你、一半是魔王。** 使用者的鏡頭即時影像**常駐顯示**在英雄側，不是縮在角落的監看小窗——玩家要能在同一個畫面裡同時看到「我現在坐成什麼樣」和「魔王掉了多少血」，因果才會直接。

**直式與橫式同等支援**，兩者都是完整可玩的版面，不是其中一個降級遷就另一個。iPad 放桌上立架通常是橫式，手持或靠書架時常是直式，展場上兩種都會發生。

| 方向 | 版面 | 攻擊方向 |
|---|---|---|
| **橫式** | 左半＝自己的鏡頭（英雄側），右半＝魔王 | 由左向右飛 |
| **直式** | 上半＝自己的鏡頭，下半＝魔王 | 由上向下飛 |

- 兩側各佔約 50%，中間是分隔的戰場帶（傷害數字與飛行特效在這裡）。
- 姿態提示（≥36px 粗體）為覆蓋層，**固定於整個畫面上方 1/3**，橫跨兩側，不隨方向改變位置。
- 玩家血條貼在英雄側、魔王血條貼在魔王側，各自帶數字。
- 「暫停」與「結束」分置畫面**兩個相對的角落**（同時滿足「不相鄰同尺寸」的要求）。
- 方向切換以 CSS（`@media (orientation: portrait)`）處理，**不重新掛載元件、不中斷鏡頭、不重新校準**。

**動畫語彙（全部只用 `transform` / `opacity`）：**

| 事件 | 表現 |
|---|---|
| 攻擊命中 | 從英雄側邊緣彈出一道光刃，飛越戰場帶擊中魔王；魔王受擊抖動；傷害數字 `−20` 在魔王側浮起 |
| 連擊 | 第 3 次起光刃變大、附連擊數字；不加快動畫速度（避免累積視覺疲勞） |
| **姿態不良（偷懶摸魚）** | **魔王反擊**：從魔王側飛回一道暗色衝擊撞上英雄側，鏡頭畫面邊緣閃紅框，浮出 `−3 HP` ＋ 2-3 字原因標籤（「駝背」「低頭」「分心」） |
| 陷阱待確認 | 魔王側顯示蓄力光暈＋倒數；**不播放任何攻擊動畫、不發聲**（延後生效期間不得表現得像已經被扣分） |
| 陷阱生效 | 魔王大招：較大範圍的特效＋魔王回血數字＋積分 `−100` |
| 重整旗鼓 | 英雄側轉為灰階（`filter` 僅此一處例外，且為靜態值不做動畫），中央顯示 10 秒倒數 |
| 第二形態 | 魔王換色＋一次放大回彈，血條重新填滿 |

**效能限制（這些是硬要求，不是建議）：**
- 常駐 `<video>` 會增加合成負擔，而 spec 已認定合成是主要熱源之一。因此鏡頭區塊**不得**套用會強制重新合成的效果：不加 `filter`（重整旗鼓的灰階除外，且為靜態）、不加 `box-shadow` 動畫、不加 `backdrop-filter`。
- 飛行特效元素**常駐於 DOM**，用 class 切換觸發，不在每次事件時建立/移除節點（避免 layout thrash）。
- 同時在飛的特效**最多 3 個**，超過就丟棄新的。
- `prefers-reduced-motion` 時：不做飛行位移，改為兩側同時閃一次高對比邊框＋直接顯示傷害數字。
- 閒置（無事件）時畫面每秒重繪 < 5 次——血條與計時器用 CSS transition，不用 rAF 逐幀更新。

## 觸控與無障礙（寫 CSS 時順手做，不另排工項）

觸控目標 ≥44×44pt、主要按鈕 ≥60pt；不依賴 hover；「暫停」與「結束」不相鄰同尺寸，結束需二次確認對話框（不做長按）；對比 ≥4.5:1（先定色票 token，美術不得在 token 外取色）；不單靠顏色（血條帶數字、狀態圖示＋文字）；正文 ≥17px、**即時姿態提示 ≥36px 粗體高對比、固定於畫面上方 1/3**（下半部會被手擋住）；`prefers-reduced-motion`。

**直式與橫式同等支援**（見「戰鬥畫面版面」），每一個畫面在兩個方向都必須完整可用，不得有任一方向被當成次要或降級版；方向改變不暫停、不中斷鏡頭、不強制重新校準，只顯示可忽略的提示＋一鍵校準（`manifest.json` 的 `orientation` 在 iPadOS Safari 實質不生效，不能當作已解決）。

**每個畫面交付前都要在實機上直橫各轉一次驗收**，檢查：無橫向捲動、無元素被切掉、觸控目標尺寸不變、鏡頭畫面不變形（`object-fit: cover`）。

## 安全與隱私

- `getUserMedia` 明確 `audio:false`；`Permissions-Policy: camera=(self), microphone=()`；**禁用 `SpeechRecognition`**（iOS 上會把音訊送往 Apple 伺服器）
- 授權前的隱私說明頁（首屏一句話＋「給家長／老師看」可展開全文），主畫面常駐一行：「完全離線運作，只分析畫面中最靠近鏡頭的一個人，影像不會離開這台 iPad」
- 「清除所有本地紀錄」按鈕
- 禁止 `v-html`（ESLint `vue/no-v-html`）；`manifest.json` 的 `scope`/`start_url` 限縮
- **Service Worker**：`install` 只預快取 app shell（<1MB，確保一定安裝成功）；模型走 runtime caching（獨立 cache name、內容雜湊命名、失敗可重試但**不做續傳**）；快取名稱帶版本號、`activate` 清除舊版
  - 導覽請求 network-first **硬逾時 2 秒**後回退快取（`AbortController`）——真正的風險不是斷網而是 captive portal，fetch 會 hang 到系統逾時
  - 寫入條件：`new URL(request.url).origin === self.location.origin && response.ok && response.type !== 'opaque'`（**不可用 `request.mode` 判斷**：導覽請求 mode 永遠是 `'navigate'`、子資源多為 `'no-cors'`，用 mode 判斷會導致 index.html 根本進不了快取、離線直接白畫面）
  - 導覽回應須為 `text/html` 且含應用標記，否則不寫入（擋 captive portal 登入頁汙染快取）

## 測試方式

- 實機 iPad Pro M1 Safari 手動測試；開發期用 `vite --https` 或通道服務取得 HTTPS（`getUserMedia` 需 secure context）
- **FocusStateMachine 用 Vitest 單元測試**（純邏輯不依賴鏡頭，約 20 個 case，半天）：覆蓋各判定分支、視線往下不判分心、瞌睡不影響數值、陷阱撤銷、玩家 HP 歸零進入重整旗鼓、Boss HP 公式（144×時長）、第二形態觸發、展示模式參數
- 效能：見「效能規範」的 debug HUD ＋ 兩次實機測試
- **展前必做**：用「加到主畫面」方式安裝並完整載入模型，然後**開飛航模式驗證一次**；另測「連上無對外網路的 WiFi」冷啟動一次；demo 前一天重新開一次確認快取還在（iOS ITP 約 7 天會清掉未安裝站點的儲存）；備手機熱點

## v1 範圍

**一次交付，全部納入**：元件拆分表所有元件、戰鬥數值與勝負條件（含第二形態）、三張統計圖（圓餅／折線／雷達）、PWA＋Cloudflare Pages、隱私說明頁、FocusStateMachine 單元測試、debug HUD、**展示模式**（20 秒輪次、攻擊間隔 1 秒、校準排在計時外，跳過安裝引導與隱私長文，供評審試玩）、語音回饋、魔王台詞庫、手機物件偵測、休息回合。

**手機物件偵測須做成設定中可一鍵關閉的開關**：展場手機到處都是，誤判率必然偏高；demo 時預設關閉，評審問到再當場開啟示範。

**雷達圖五軸定義**（全部由既有資料導出，不需額外蒐集）：

| 軸 | 算法 |
|---|---|
| 坐姿端正 | `upright` 時長佔比 |
| 頸部健康 | 1 − `forwardHead` 佔比 |
| 背部健康 | 1 − `slouch` 佔比 |
| 清醒度 | 1 − `drowsy` 佔比 |
| 抗干擾 | 1 − (`distractionDurationMs` 總和 ÷ 本輪時長) |

各軸 0-100%。軸標籤對國小生需用白話（例如「坐得直不直」「脖子有沒有伸出去」），不用上表的術語。

**建議實作順序**（一次交付，但仍先讓核心迴圈跑通再加周邊，避免時程吃緊時變成每個功能都做一半）：依元件表「序」欄 1→9，即 推論與鏡頭 → 判定與狀態機 → 校準與計時 → 任務選擇與戰鬥畫面 → 文案與提示 → 統計與儲存 → 權限與台詞 → 狀態指示與語音 → 安裝引導與休息回合。

## [C] 這次不做

InferenceWorker / OffscreenCanvas（改主執行緒，介面保留可逆性）· AdaptiveScheduler 三檔自適應（改單向緊急降檔）· 相機解析度階梯 · 推論前手動縮圖 · 無鏡頭降級模式（只做 `NotAllowedError` 復原路徑）· 四種 `getUserMedia` 錯誤分流 · 模型 SHA-256 CI 比對與 `npm audit` CI（**本 repo 連 CI 都沒有**）· Dependabot · 完整 11 指令 CSP（保留 Permissions-Policy / nosniff / HSTS；CSP 待功能完成有餘裕再加，因 `'wasm-unsafe-eval'` 的驗證迴圈可能吃掉 1-2 天）· 15-30 秒 checkpoint 與 `in_progress` 恢復詢問（改結束時寫一次＋hidden 時 localStorage crumb）· 90 天 TTL 與單筆刪除（保留「清除全部」）· SW 新版本提示 UI · 模型下載續傳 · 動態字級 · VoiceOver 完整支援 · 圖表形狀/線型 · 監護人告知獨立流程（併入隱私頁展開區）

## v2 範圍

雲端多人連線（Cloudflare Workers + Durable Objects）· 共享 Boss 血條與戰隊房間 · 雲端排行榜（D1）· 動態時間權重 · 雲端 LLM（Gemini）加值層。

**安全前提**（開工前必達，詳見 `docs/superpowers/specs/v2-cloud-security-notes.md`）：token 驗證＋伺服器端分數上限檢查；D1 一律參數化查詢；只同步彙總數值（影像/landmark 永不離開裝置）；**蒐集未成年人資料前須有監護人同意與刪除管道**；LLM 輸出須經過濾且不用於對兒童的開放式對話。
