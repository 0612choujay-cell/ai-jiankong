<template>
  <video ref="videoEl" class="hidden-cam" playsinline muted />

  <PrivacyNotice
    v-if="s.screen === 'privacy'"
    @agree="session.enterPermission()"
  />

  <PermissionGate
    v-else-if="s.screen === 'permission'"
    :video-el="videoEl"
    @granted="onGranted"
  />

  <!-- 這裡曾經有一個 `:restore-scale="s.perfMode ? 0.5 : 1"`，連同一段說明
       「就算這裡傳錯，下一次轉場就會修正」的註解。**兩者都已經拿掉。**

       複審用探針實測證明那段「自癒」推理在流程反轉之後不成立了：
       `CalibrationWizard` 的卸載被排進 `startBattle()` 的 await 之中，所以
       元件的 `restore()` 是開打前**最後一個**寫推論倍率的人，它後面沒有
       下一次轉場——下一件事就是 rAF 迴圈開始讀 `inference.step()`。
       一段宣稱有安全網、而安全網已經不在的註解，比沒有註解更危險。

       現在校準期間的提頻是 `inferenceService` 的一個**疊加層**
       （`setCalibrationBoost()`），元件不再持有任何值，也就沒有「傳錯」這件事，
       `DOWNSHIFT_SCALE` 那個 0.5 也不再需要在這裡多一份。完整推導寫在
       `inferenceService.setCalibrationBoost()` 與 `CalibrationWizard.restore()`。 -->
  <!-- task-type（【分任務校準】）：校準量的是耳朵相對於肩膀的高度，而抬頭看
       螢幕、低頭寫作業、書攤在桌上、單字卡拿在手上，這個數字每一種都不一樣。
       流程改成「選任務 → 校準」之後，這個畫面才第一次知道等一下要做什麼，
       指示也才能是「那個任務真實會有的姿勢」。

       傳 prop 而不是讓元件自己讀 store：這個元件目前是純 props
       （camera／inference／videoEl），保持那個性質才測得動——
       它的測試是 createApp(CalibrationWizard, props) 直接掛載，沒有 store，
       一旦元件裡出現 useSession() 就得在每個測試檔補一份 mock。 -->
  <CalibrationWizard
    v-else-if="s.screen === 'calibrate' && s.booted"
    :camera="session.camera()"
    :inference="session.inference()"
    :video-el="videoEl"
    :task-type="s.taskType"
    @done="onCalibrated"
  />

  <TaskSelector
    v-else-if="s.screen === 'task'"
    @start="onTaskChosen"
  />

  <StatsDashboard
    v-else-if="s.screen === 'stats'"
    :record="s.lastRecord"
    :history="s.history"
    :dps-series="s.battle?.dpsSeries ?? []"
    :storage-error="s.storageError"
    :history-error="s.historyError"
    @again="onAgain"
    @home="onHome"
  />

  <BreakScreen v-else-if="s.screen === 'break'" @done="onBreakDone" />

  <!-- 姿態閾值量測畫面（Task 22c B）。`s.booted` 這個條件跟 CalibrationWizard
       那條是同一個理由：ThresholdLab 的 camera／inference 兩個 prop 都是
       required，boot() 之前 session.camera()／session.inference() 都還是 null。
       今天不可達（入口只長在設定面板裡，而設定面板只長在任務畫面上，走到那裡
       一定 booted 過了），留著是因為 required prop 傳 null 的失敗模式是元件
       內部的 TypeError，展場上看起來就是整個畫面消失。 -->
  <ThresholdLab
    v-else-if="s.screen === 'lab' && s.booted"
    :camera="session.camera()"
    :inference="session.inference()"
    :video-el="videoEl"
    @close="session.leaveLab()"
  />

  <div v-else-if="s.screen === 'battle'">
    <!-- Task 14 fix round 1（Important）：這個容器一定要 position:fixed（脫離
         normal flow），不能讓它以一般 block 元素疊在 <BattleView> 上方——
         <BattleView> 的根節點 .arena 是 min-height:100dvh，一旦這個容器佔掉
         flow 高度，.arena 就會被往下推出視窗，而暫停/結束兩顆角落按鈕是
         position:absolute 相對 .arena 定位，會跟著被推出可視範圍。觸發時機
         正好是鏡頭壞掉／推論卡住、使用者最需要按到這兩顆按鈕的時候，
         復原路徑因此構不著——這正是 T10 第 3 輪處理過的同一類問題
         （文案指向的操作必須是做得到的操作），不能在這裡重蹈覆轍。
         position 直接寫成 inline style（不是丟給下面 <style scoped> 裡的
         class）：這樣測試不必依賴 jsdom 是否完整套用 CSS 級聯，直接讀
         el.style.position 就能鎖住「這個容器脫離 flow」這件事。
         外層 v-if 只在真的有東西要顯示時才渲染這個容器，避免三個條件都
         健康時螢幕上留一個空的圓角方塊。 -->
    <div
      v-if="!s.cameraHealthy || s.inferenceStuck || !s.inferenceHealthy || s.loopError"
      class="health-overlay" style="position: fixed"
    >
      <!-- 三種異常訊息互斥、依嚴重程度排序（F3）：cameraHealthy=false 代表鏡頭
         本身不見了（被系統收走／被別的 App 搶走），比推論不穩定更嚴重、更明確，
         優先顯示。inferenceStuck（持續不健康 ≥30 秒）比 inferenceHealthy=false
         更嚴重：前者才剛開始不穩定，可能自己就恢復了；後者已經確定是壞的，
         給使用者一個明確的出路（結束這一場）比繼續講「暫時」更誠實。

         N3（審查第 3 輪）：這裡原本寫「請按『結束』回到開始畫面重新啟動」，
         但那條路走不通——endBattle() 後按「開始」會呼叫 boot()，而 boot() 一看
         state.booted 已經是 true 就直接早退（session.js 的 `if (state.booted)
         return`），鏡頭完全不會被重新啟動；CalibrationWizard 也沒有任何
         camera.start()/resume()，只會鏡像一個定格畫面，小孩會卡在校準畫面
         出不去，只能重開 PWA。改成指向「暫停→繼續」：togglePause() 的恢復
         分支本來就走 camera.resume()（F2 剛修好的那條路），track 已死時會
         整個 start() 重來，成功後也會把 cameraHealthy 寫回 true——這是唯一
         一條「不必切背景」就能重新拿到 stream 的既有路徑，不必新增任何
         boot()/CalibrationWizard 的邏輯，風險最低。

         第 4 輪：每則提示拆成兩行短句，每行都 ≤15 字（單句上限的原始理由是
         語音播報會蓋掉下一則提示；照 Task 9 審查的前例拆行），且兩行各自都
         能獨立讀懂——第一行講「發生什麼事」，第二行講「你可以做什麼」。
         第一則指向的「暫停→繼續」這條復原路徑在第 4 輪改了收斂判準之後仍然
         成立：改到的只有「舊呼叫落地」那條分支，正常按一次暫停、按一次繼續
         走的是世代相符的主線，camera.resume() 照樣重開 stream 並把
         cameraHealthy 寫回 true。 -->
      <template v-if="!s.cameraHealthy">
        <p class="hint warn">鏡頭好像不見了</p>
        <p class="hint warn">先按「暫停」再按「繼續」</p>
      </template>
      <template v-else-if="s.inferenceStuck">
        <p class="hint warn">攝影機好像看不清楚了</p>
        <p class="hint warn">先按「結束」休息一下吧</p>
      </template>
      <p v-else-if="!s.inferenceHealthy" class="hint warn">推論暫時不穩定，計分已暫停</p>
      <!-- Task 22c G：state.loopError 從 task-17 起就被記在 store 裡，但至今
           沒有任何畫面顯示它。症狀是這四則裡最沉默的一種——戰鬥畫面還在、
           血量不動、時間不走、一個字都沒有，而正式 bundle 用
           `esbuild: { drop: ['console'] }` 把 console 全部拔掉之後，連
           unhandled rejection 都看不到。

           **為什麼排在最後一級**（這一串是互斥、依嚴重程度排序的）：
           前三則每一幀都重新計算，講的是「現在」；loopError 是**黏著的**
           ——只有 startBattle() 會把它清回 null，所以它回答的是「這一場裡
           曾經發生過至少一次未預期例外」，對「現在還成不成立」的確定性最低。
           把它排在前面，會讓一則可能已經過期的訊息蓋住正在發生、而且有明確
           復原路徑的鏡頭／推論提示（第 3 輪 N3 修的就是「文案指向走不通的路」
           這類問題，別再回去）。

           排最後也剛好對準它真正要解決的情境：迴圈壞到連健康度都不再更新時
           （例外發生在 computeInferenceHealthy() 之前就 throw 了），
           cameraHealthy／inferenceStuck／inferenceHealthy 三個旗標全部凍結在
           「健康」，前三則都不會出現——那正是 G 描述的那個「什麼訊息都沒有」
           的畫面，而這一則是唯一會出現的東西。

           代價（誠實記錄）：偶發一次的例外之後自己恢復了，這則提示仍會留到
           這一場結束。它指向的操作（按「結束」）永遠是做得到、而且沒有破壞性
           的一步（成績照常結算），所以這個誤報的代價可以接受；反過來讓它靜音
           才是這一項要修的東西。

           隱私紅線：只顯示 error.name，不得有 message/stack（跟 OfflineWarmup
           的「技術細節」同一條線）——name 是給工作人員在沒有 devtools 的展場
           現場唯一的線索。 -->
      <template v-else-if="s.loopError">
        <p class="hint warn">遊戲好像卡住了</p>
        <p class="hint warn">先按「結束」休息一下吧</p>
        <!-- controller 追加（第四個「組合字串」缺陷）：這裡原本是
             `技術細節：{{ s.loopError }}` 併成同一句，`s.loopError` 存的是
             `error.name`，真實會出現的名稱像 NotReadableError（16 字）、
             ReferenceError（14 字），組出來 21 字／19 字，破 15 字上限——跟
             同一個覆蓋層裡上面那兩行（各自都乖乖 ≤15 字）不一致。跟
             OfflineWarmup.vue 修過的同一種病（固定前綴＋執行期變數併成
             一句）同一個修法：拆成兩個獨立的文字節點，固定前綴自己一句
             （4 字，靜態、可窮舉、鎖死 ≤15 字），error.name 自己一句
             （定義域是瀏覽器/JS 平台給的技術識別字，不是本專案審過的封閉
             集合，沒辦法窮舉「這一行本身會不會超過 15 字」——這裡只保證
             「不會再跟固定前綴湊成同一句」，見 App.mount.test.js 對應護欄
             的說明）。兩個 <p> 沿用同一個 .detail class（跟 OfflineWarmup
             用兩個不同 class 只是命名習慣不同，視覺樣式本來就一樣，這裡不
             另外造一個同義的 class）。 -->
        <p class="detail"><small>技術細節</small></p>
        <p class="detail"><small>{{ s.loopError }}</small></p>
      </template>
    </div>

    <BattleView :video-el="videoEl" @finish="session.endBattle('aborted')" />
  </div>

  <div v-else class="stack">
    <!-- 複審第 1 輪 B1：這裡原本寫「畫面狀態異常，請重新整理頁面」——但這個
         App 是 standalone PWA，沒有網址列、沒有重新整理按鈕，那句話指向一個
         做不到的操作（跟戰鬥畫面異常提示同一條紅線：文案指向的操作必須是
         使用者做得到的操作）。

         Task 22c 更新（原註解已經不成立，改成反映現況）：`stats` 與 `break`
         兩個分支現在都在上面了（分別是本檔案第 28 行與 39 行起），`lab` 也
         接上了。所以它現在是真正的 catch-all：`state.screen` 變成一個沒有人
         認得的值（未來新增畫面卻忘了加分支、或某次重構打錯字）時的最後一道網。

         但它**不是**完全不可達（複審 M-3 更正）——還有兩條路會掉進來：
         `calibrate × !booted` 與 `lab × !booted`。那兩個分支都帶 `&& s.booted`，
         因為兩個元件的 `camera`／`inference` 都是 required prop，boot 之前是
         `null`。掉進這裡是**刻意選的**失敗模式：required prop 傳 null 的後果
         是元件內部的 TypeError，展場上看起來就是整個畫面消失、什麼都沒有；
         掉到一個寫著「畫面好像卡住了」又給得出一條路的畫面誠實得多。
         正因為如此，它必須永遠是一條走得通的路。

         文案也跟著改（原本是「這一輪結束囉！」）：那句話是它當初真的在接
         「戰鬥結束」時寫的，現在它接的是**未知狀態**——對一個掉進未知狀態的
         小孩說「這一輪結束囉」是假話，而且會讓他以為成績已經結算好了。
         改成誠實描述他看得到的事實（畫面卡住了），再給一條走得通的路。

         按鈕仍然呼叫 `session.enterPermission()`：這是這個 App 唯一保證從
         任何狀態都走得通的路（權限頁 → 開鏡頭 → 選任務 → 校準 → 戰鬥）。注意
         `boot()` 在 `state.booted` 已經是 true 時會早退，所以這條路對第二次
         之後的訪客也不會重跑 MediaPipe 初始化，只是把畫面接回既有流程。
         刻意不用「重新整理」「重開 App」那類指示：安裝後是 standalone PWA，
         沒有網址列、沒有重新整理按鈕，那些是使用者做不到的操作。 -->
    <p class="hint">畫面好像卡住了</p>
    <button class="primary" @click="session.enterPermission()">重新開始</button>
  </div>

  <!-- 安裝引導只是一行可關閉的橫幅，不擋流程：做成強制安裝步驟的話，評審
       拿起 iPad 想試玩會先被一個安裝教學擋住。只掛在主畫面與結算畫面，
       **不掛在戰鬥畫面**（戰鬥中不該有東西擋住），也不掛在休息回合
       （休息畫面的重點是那份伸展清單，不該在旁邊放一個要人分心去按的東西）。
       它跟結算頁底部那兩顆主按鈕不相交，算式與護欄見 InstallGuide.vue。 -->
  <InstallGuide v-if="s.screen === 'task' || s.screen === 'stats'" />

  <!-- 展場離線暖機（offlineAssets.js 的第一個 UI 呼叫點）。已經暖機過的裝置
       完全不渲染（元件自己讀 isOfflineReady()）。

       Ruling DR（Task 22c F）：掛載點從任務設定畫面搬到**權限畫面**。原因是
       時序——`boot()` 裡就包含 MediaPipe 模型下載，而 `PermissionGate.request()`
       正是呼叫 `boot()` 的地方；走到任務設定畫面時模型早就下載完了，暖機面板
       在那裡對第一位訪客只是事後補一個旗標，進度條永遠瞬間滿格。要真的先把
       資產灌進 Cache Storage，唯一有意義的時間點是**按下「開啟鏡頭」之前**。

       條件收斂成很輕的呈現（同一條 Ruling 的後半段）：
       - 只掛 `'permission'`，**不掛 `'privacy'`**。隱私說明頁是每位訪客的第一
         個畫面，那一頁要人認真讀完，旁邊擺一個維運性質的下載面板有反效果。
       - 加上 `!s.booted`：boot() 成功之後（第二位訪客起，或從兜底畫面走
         `enterPermission()` 回來時）這台裝置該下載的東西早就下載過了，暖機
         面板再出現一次只是雜訊。

       版面（手算，兩個方向都要成立）：暖機面板是 position:fixed 錨在**上緣**，
       高度約 padding(20) + 內容 44 ≈ 64px，下緣落在 y≈80。PermissionGate 用的
       是 `.stack`（垂直置中）：未授權狀態內容高約 192px、被拒狀態（含五步驟
       設定路徑）約 456px，在最矮的橫向視窗（iPad Pro M1 橫向 834px）置中後
       上緣分別落在 y≈321 與 y≈189，兩者都在 80 以下方，不相交。它跟
       InstallGuide（錨在下緣）也刻意分開兩端，理由見 OfflineWarmup.vue。 -->
  <OfflineWarmup v-if="s.screen === 'permission' && !s.booted" />

  <!-- 工作人員設定入口（Ruling DU）：任務畫面角落一個**看得見**的小齒輪，
       600ms 內連續點 5 下才打開設定面板。
       - 不是查詢參數：安裝後是 standalone PWA，沒有網址列可以改（完整推導見
         BattleView.vue 的 DebugHud 那段註解）。
       - 不是普通按鈕：面板裡有「清除所有本地紀錄」這個不可逆操作，展場上
         小孩會亂按。
       - 不是隱形高 z-index 圖層：Task 16 的審查明確禁止（隱形圖層會吃掉它
         下面那些按鈕的點擊，而且沒有人查得出來）。做成低對比但確實存在的
         元素，並給 aria-label。
       - 5 下 ＋ 600ms 視窗的實作照 BattleView.vue 既有的 DebugHud 開關，
         不另外發明一套。

       版面（手算）：齒輪是 44×44（--tap-min）的 fixed 元素，錨在右上角
       x ∈ [W-16-44, W-16]。TaskSelector 用 `.stack`（水平置中、垂直置中），
       最寬的一列是 `.privacy-line`（max-width 36em @15px ≈ 540px），也就是
       內容左右各距中心最多 270px：直向 834px 時內容右緣 x≈687、齒輪左緣
       x=774，間隙 87px；橫向 1194px 時間隙 267px。垂直方向：TaskSelector 的
       內容高約 576px，置中後上緣在直向 y≈309、橫向 y≈129，都在齒輪下緣
       （y=60）以下。InstallGuide 錨在下緣，不相交。 -->
  <button
    v-if="s.screen === 'task'"
    class="staff-gear" type="button" aria-label="工作人員設定"
    @click="bumpStaffTap"
  >
    ⚙
  </button>

  <template v-if="settingsOpen">
    <SettingsSheet
      :voice-enabled="s.voiceEnabled"
      :phone-detect-enabled="s.phoneDetectEnabled"
      :perf-mode="s.perfMode"
      :clear-state="s.clearState"
      @toggle-voice="session.toggleVoice()"
      @toggle-phone-detect="session.setPhoneDetectEnabled(!s.phoneDetectEnabled)"
      @reset-perf-mode="session.resetPerfMode()"
      @clear-all="session.clearAllLocalData()"
      @close="settingsOpen = false"
    />

    <!-- ThresholdLab 與「換人玩」的入口為什麼長在這裡，而不是在 SettingsSheet
         裡面：SettingsSheet.vue 不是本工項的檔案（不能改），而它**沒有預設
         插槽**——所以「用插槽塞進去」這個選項今天根本不存在，只剩下「在
         App.vue 這一層、跟設定面板同時渲染」這一種。

         錨在**上緣**而不是下緣：SettingsSheet 自己的「關閉設定」按鈕在面板
         最底下，把這兩顆貼在它下面容易被誤按成關閉。

         版面（手算）：這一列是 fixed、上緣 y=16、高度 = 8*2 padding + 44
         （--tap-min）= 60，下緣 y=76。設定面板是 `place-items:center` 置中、
         高度受內容決定約 500px（h2 + 三列開關 + 兩顆按鈕 + 關閉鈕），
         上緣 = (視窗高 - 500) / 2：橫向 834px 時 y≈167、直向 1194px 時
         y≈347，都在 76 以下，不相交（最小餘裕 91px）。
         這個算式成立的條件是「面板高度 + 2×76 ≤ 視窗高」，也就是視窗高
         ≥ 652px——iPad Pro M1 兩個方向（834／1194）都遠超過。若哪天有人往
         SettingsSheet 裡再加好幾列、讓它撞到 max-height:90vh 的上限，這一列
         會開始蓋住面板標題（面板自己的 .scroll 仍可捲動，關閉鈕也還在），
         屆時要把這一列改成錨在下緣或改用插槽。

         z-index 11（面板的 backdrop 是 10）：這一列必須在 backdrop 之上才點
         得到。代價是它也蓋在**確認對話框**之上，所以：

         `!confirmNewVisitor`（複審 I-2）：換人玩的確認框一開，這一列就整個
         收掉。少了這個條件，確認框開著時還能按進量測畫面，而那個 inset:0 的
         遮罩會整片蓋在 brief 稱為「交付門檻本身」的畫面上（還救得回來——按
         「先不要」——但那是一個沒有理由存在的狀態）。原則寫成一句話：
         **確認框開著的時候，不該還有東西在它上面可以點。**

         仍然存在、而且 App.vue 這一層修不掉的一格（誠實記錄，上一版的報告
         把這格寫錯了）：SettingsSheet **內部**那個「清除所有紀錄」的確認框是
         元件自己的 state，這裡看不到，所以它開著時這一列仍然點得到。後果是
         兩個確認框疊在一起（都可取消、按下去也不會卡住），要真的修掉需要
         SettingsSheet 把那個狀態暴露出來或提供插槽——那不是本工項的檔案。 -->
    <div v-if="!confirmNewVisitor" class="staff-extra">
      <button class="staff-btn" type="button" @click="openLab">姿態量測工具</button>
      <button class="staff-btn" type="button" @click="askNewVisitor">換人玩</button>
    </div>
  </template>

  <!-- 「換人玩」的第二個入口（Ruling DY）：結算畫面的角落。
       結算畫面是上一位訪客的最後一個畫面，也正是工作人員把 iPad 交給下一位
       的時機。這顆按鈕當初存在的理由是：在它出現之前，全 App 只有第一位訪客
       會走到校準，之後每一位都跑在第一位的校準基準上——症狀是「整場一直說他
       駝背」或「整場都不反應」，而且沒有任何錯誤訊息。
       StatsDashboard.vue 不是本工項的檔案，所以入口做在 App.vue 這一層。

       【分任務校準】之後它帶去的是**選任務**畫面（不是直接進校準）：新訪客
       要自己選任務，而校準的姿勢指示依賴任務類型。重新校準的保證沒有變弱
       ——任務畫面唯一的出口就是「準備開始」，而那條路一定經過校準。

       二次確認：這顆按鈕小孩碰得到，按下去會離開他正在看的成績。確認對話框
       用既有的 ConfirmDialog（跟 SettingsSheet 清除紀錄同一個元件、同一種
       語氣），不新發明一種。

       版面（手算）：按鈕是 fixed 右上角，寬 = 3 個字 ×17px + 左右各 16px
       padding ≈ 83px，高 44（--tap-min），佔 x ∈ [W-99, W-16]、y ∈ [16, 60]。
       StatsDashboard 的 `.hero` 第一行 `.result` 是 34px 置中文字（最長 8 字
       ≈ 272px），右緣 x ≈ W/2 + 136；兩者不相交的條件是 W ≥ 470px，iPad Pro
       直向 834／橫向 1194 都成立（餘裕分別 115px、295px）。第二行 `.headline`
       起於 y ≈ 16 + 41 + 8 = 65，在按鈕下緣 60 之下，也不相交。
       已知邊界：視窗寬度小於 470px（iPad 的 Slide Over）時會和 `.result`
       重疊——展場是 standalone 全螢幕，不在支援範圍內，這裡記錄而不假裝。 -->
  <button
    v-if="s.screen === 'stats'"
    class="corner-exit" type="button" @click="askNewVisitor"
  >
    換人玩
  </button>

  <ConfirmDialog
    v-if="confirmNewVisitor"
    title="要換下一位嗎？"
    body="會重新選任務、重新校準"
    confirm-text="好，換下一位"
    cancel-text="先不要"
    @confirm="onNewVisitorConfirmed"
    @cancel="confirmNewVisitor = false"
  />
</template>

<script setup>
import { ref, onBeforeUnmount } from 'vue'
import PrivacyNotice from './components/PrivacyNotice.vue'
import PermissionGate from './components/PermissionGate.vue'
import CalibrationWizard from './components/CalibrationWizard.vue'
import TaskSelector from './components/TaskSelector.vue'
import BattleView from './components/BattleView.vue'
import StatsDashboard from './components/StatsDashboard.vue'
import BreakScreen from './components/BreakScreen.vue'
import InstallGuide from './components/InstallGuide.vue'
import OfflineWarmup from './components/OfflineWarmup.vue'
import SettingsSheet from './components/SettingsSheet.vue'
import ThresholdLab from './components/ThresholdLab.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { needsBreakAfter } from './core/battleConfig.js'
import { useSession } from './stores/session.js'

const session = useSession()
const s = session.state
const videoEl = ref(null)

// Task 19：PermissionGate 的 request() 已經呼叫過 session.boot()，這裡只負責
// 「boot 成功之後」的下一步。不直接寫 session.rawState.screen：畫面轉換一律
// 走 store 的方法，才會經過「鏡頭現在該不該開」那個唯一判準（session.js 的
// setScreen()）。
//
// 【分任務校準】：下一站從校準改成**選任務**。校準量的是耳朵相對於肩膀的
// 高度，而寫作業／看書／背單字的頭部角度各不相同——校準要先知道等一下要做
// 什麼，才給得出正確的姿勢指示（完整推導見 session.js 的 enterTaskSelect()）。
// 這裡因此也不再需要 await：enterTaskSelect() 是純同步的畫面轉換，任務畫面
// 不用鏡頭，沒有任何非同步的 stream 收斂要等（那件事搬到了 enterCalibration()，
// 也就是真的要用鏡頭的那一刻）。
function onGranted() {
  session.enterTaskSelect()
}

// 校準完成 → 直接開打（【分任務校準】：任務在進校準之前就選好了，沒有「回到
// 選任務」這一步了）。
//
// 兩個呼叫、順序不能反：setCalibration() 先把基準寫進 state.profile，
// startBattle() 才拿它去建 poseAnalyzer（session.js 的 `baseline: state.profile`）。
// 反過來的話這一場會跑在**上一位訪客**的基準上——正是「展場輪流玩」家族那幾個
// bug 的形狀，而且一樣沒有任何錯誤訊息。中間刻意沒有 await，兩行在同一個
// 同步堆疊內跑完，順序由語言本身保證。
//
// 為什麼是兩個呼叫而不是讓 setCalibration() 自己開打：見 session.js 的
// setCalibration() 上方（把它變成「設一個欄位、順便開一整場戰鬥」的方法，會讓
// 七個測試檔裡那些只想鋪設 profile 的地方安靜地多開一場戰鬥）。這一條線的
// 護欄因此裝在**這個呼叫點**上（App.taskSelector.test.js 的 spy 斷言），
// 不是裝在 store 方法裡——Ruling DK。
async function onCalibrated(profile) {
  session.setCalibration(profile)
  // await：startBattle() 從第 6 輪起有 await（重開鏡頭可能要一次完整的
  // getUserMedia），不 await 等於把它的錯誤丟掉。注意光是 await 不能消除
  // 那段空窗——setScreen() 是同步的，戰鬥畫面（含「結束」按鈕）在 await
  // 期間就已經渲染出來了——真正擋住空窗操作的是 startBattle() 內部的世代
  // 比對（見 session.js 的 myFrameGen／myCamGen）。
  await session.startBattle()
}

async function onTaskChosen(payload) {
  // 這一行必須在任何 await 之前：TaskSelector 的按鈕是同步 emit，onTaskChosen
  // 的同步部分（await 之前）仍在那次點擊的手勢呼叫堆疊內，是全 App 唯一一個
  // 「準備開始」等同於使用者手勢的時機。iOS 只認「第一次 speak() 是不是在
  // 手勢的同步呼叫堆疊內」——錯過這裡，之後每一次 speak() 都會被靜默忽略，
  // 不丟例外、不進 onerror，整場無聲且查不出原因（見 voiceFeedback.js）。
  //
  // 【分任務校準】重新確認過這條推理在新流程下仍然成立：這顆按鈕、這個
  // handler、這一行的位置都沒有變，變的只是它**後面**去哪裡（以前直接開打，
  // 現在先去校準）。解鎖在 primeVoiceFromGesture() 當場就完成（它自己就
  // speak 了一次空字串），跟「第一句真正的台詞多久以後才出現」無關——中間
  // 多出來的那 5 秒校準不會讓解鎖失效。完整推導見 session.js 的
  // primeVoiceFromGesture()。
  session.primeVoiceFromGesture()
  session.setTask(payload)
  // 順序：setTask() 一定要在 enterCalibration() 之前——校準畫面要讀
  // state.taskType 決定顯示哪一組姿勢指示，反了就是拿上一位訪客的任務去
  // 指示這一位（而畫面上看起來一切正常）。
  //
  // await：enterCalibration() 的非同步層在 stream 已經被 pagehide 停掉時會
  // 重新 getUserMedia，不 await 的話畫面會先切過去、鏡頭晚幾百毫秒才接上
  // （而且錯誤結果會被丟掉）。
  await session.enterCalibration()
}

async function onAgain() {
  // 沿用同一份校準與任務設定，不重跑 Onboarding／TaskSelector——「再討伐
  // 一次」對這個年齡層要越快回到戰鬥越好，重跑校準只會讓人失去耐性。
  //
  // Task 20：但這一輪已經坐了 20 分鐘以上的話，先進休息回合再開新的一場。
  // 判斷讀的是 needsBreakAfter()——跟 StatsDashboard 那顆按鈕的**文字**同一個
  // 函式，所以不可能出現「按鈕寫著休息一下再來、按下去卻直接開打」。
  if (needsBreakAfter(s.lastRecord)) {
    await session.enterBreak()
    return
  }
  await session.startBattle()
}

// 休息回合有**兩個入口**，出口也必須是兩個（完整推導見 session.js 的
// leaveBreak()）：戰鬥中打瞌睡進來的，這一場還在跑，要回到**同一場**並恢復
// 暫停（leaveBreak() 自己做完，回傳 true）；結算頁進來的沒有進行中的戰鬥，
// 回傳 false，這裡才開新的一場。兩條路都無條件 startBattle() 的話，去伸展
// 三分鐘回來會發現剛剛那一場的進度整個不見了。
async function onBreakDone() {
  const resumed = await session.leaveBreak()
  if (!resumed) await session.startBattle()
}

// 更正 1：不直接寫 session.rawState.screen = 'task'。setScreen() 是
// state.screen 的唯一寫入者，也是「鏡頭現在該不該開」那個唯一判準的收斂點
// ——直寫會繞過它，這正是本專案吃過的真實 bug（第二位訪客進來永遠黑畫面）
// 的同一類根因。backToTaskSelect() 內部呼叫 setScreen('task')，鏡頭由判準
// 自己收斂，這裡不再另外補一行 setEnabled(false)（那會變成兩套真相）。
function onHome() {
  session.backToTaskSelect()
}

// --- 工作人員設定面板（Ruling DU）：5 連點開啟 ---------------------------
//
// 實作照 BattleView.vue 既有的 DebugHud 開關（同一個專案裡已經驗證過的作法，
// 不另外發明一套）：每點一下就把 600ms 的視窗重新計時，累積到 5 下才開。
// 5 下（不是 3 下）＋ 短視窗的理由也一樣：小孩正常玩不會在 0.6 秒內連點同一個
// 角落 5 次，而任務畫面上的功能性按鈕都不在那個角落，不會誤觸。
//
// settingsOpen 是 App.vue 內部的 ref，不寫進 session state：這是 UI 狀態，
// 不是「這個 App 現在處於哪個世界」的事實（畫面狀態只有 setScreen() 能寫）。
const STAFF_TAP_COUNT = 5
const STAFF_TAP_WINDOW_MS = 600
const settingsOpen = ref(false)
const confirmNewVisitor = ref(false)
let staffTaps = 0
let staffTapTimer = 0

function bumpStaffTap() {
  staffTaps += 1
  clearTimeout(staffTapTimer)
  staffTapTimer = setTimeout(() => { staffTaps = 0 }, STAFF_TAP_WINDOW_MS)
  if (staffTaps < STAFF_TAP_COUNT) return
  staffTaps = 0
  // 每次打開都先把上一次「清除所有本地紀錄」的結果字樣收回 idle，
  // 否則面板一打開就顯示「清除失敗，請再試」／「已清除本地紀錄」，
  // 而這一次根本什麼都還沒做（見 session.js 的 resetClearState()）。
  session.resetClearState()
  settingsOpen.value = true
}

// 進量測畫面前先把設定面板收掉：面板的 backdrop 是 inset:0 的全螢幕遮罩，
// 留著會把整個 ThresholdLab 蓋住。轉場本身走 store 的 enterLab()——它會
// setScreen('lab')（鏡頭由判準自己收斂）、重新打開推論 track、再補一次
// 非同步的 stream 收斂。
async function openLab() {
  settingsOpen.value = false
  // 縱深防禦（複審 I-2）：模板已經讓那一列在確認框開著時整個收掉，所以今天
  // 走不到「確認框開著卻按到量測工具」這條路；但這個函式是「離開設定情境」
  // 的收斂點，把屬於那個情境的 UI 狀態一次清乾淨，才不會在下一次有人改掉
  // 模板條件時留下一個開著的對話框蓋在量測畫面上。
  confirmNewVisitor.value = false
  await session.enterLab()
}

function askNewVisitor() {
  confirmNewVisitor.value = true
}

// 「換人玩」（Ruling DY）：兩個入口（結算畫面角落、設定面板）共用這一個
// 收斂點，確認之後一律走 store 的 startNewVisitor()——它清掉上一位訪客的
// history／lastRecord，再走既有的 enterTaskSelect()（【分任務校準】：終點
// 從校準改成選任務，因為新訪客要自己選任務、而校準現在依賴任務類型；
// 「那還算不算重新校準」的完整推導寫在 session.js 的 startNewVisitor() 上方
// ——任務畫面唯一的出口就是 onTaskChosen() → enterCalibration()）。
function onNewVisitorConfirmed() {
  confirmNewVisitor.value = false
  settingsOpen.value = false
  session.startNewVisitor()
}

onBeforeUnmount(() => {
  clearTimeout(staffTapTimer)
  session.teardown()
})
</script>

<style scoped>
/* 唯一的 <video>：由各畫面共用，避免重新掛載造成鏡頭中斷 */
.hidden-cam { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

/* position 本身寫在 template 的 inline style（見上方註解），這裡只補視覺樣式。
   z-index 高於 CoachBanner（4），確保裝置層級的異常提示優先於戰鬥內的姿態提示。 */
.health-overlay {
  top: max(var(--gap), env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  /* 這個覆蓋層只有文字，沒有任何可互動元素，所以一律讓點擊穿透。
     現在它錨在上緣、寬度又是內容撐出來的，跟錨在下緣的暫停／結束按鈕
     （.corner-bl / .corner-br）矩形不相交，所以「擋住按鈕」今天不會發生。
     但它的 z-index 是 6、按鈕是 3——哪天文案多一行、字級調大、或有人給它
     加上 width/right，它就會蓋住按鈕，而且是在鏡頭壞掉、推論卡住的時候
     蓋住——正是這段文字叫使用者去按那兩顆按鈕的時刻。
     這一行讓那種情況最多只是擋到視線，不會連點擊都吃掉。 */
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  max-width: min(92vw, 760px);
  padding: 10px 20px;
  border-radius: var(--radius);
  background: var(--c-surface);
  text-align: center;
}
/* loopError 的技術細節行（只有 error.name，見 template 的隱私說明）：刻意比
   上面兩行小且暗——那兩行是講給小孩聽的，這一行是留給工作人員的線索。

   它讓覆蓋層從最多 2 行變成 3 行。高度重算（複審 M-1：上一版寫「約 95px」，
   漏了 <p> 的 UA 預設 margin——`base.css` **沒有** p 的 margin reset，而
   `.health-overlay` 是 flex column，flex item 的 margin 不合併，所以每一個
   <p> 上下各多 1em=17px）：

     10          padding-top
   + 17+20+17    第一行 p（margin-top + 行高 + margin-bottom）
   + 4           gap
   + 17+20+17    第二行 p
   + 4           gap
   + 17          .detail（這一個 margin:0，裡面的 <small> 約 14px 行高）
   + 10          padding-bottom
   = 153px       → 下緣 y ≈ 24(inset-top) + 153 = 177

   結論不變：BattleView 的暫停／結束兩顆角落按鈕錨在下緣，上緣在橫向
   834px 時是 y=754、直向 1194px 時是 y=1114，餘裕 ≥ 577px，不相交；而且
   這個覆蓋層是 pointer-events:none，就算哪天真的長到那裡也吃不到點擊。
   （算錯的數字比沒有數字更危險——這條標準是 SettingsSheet.vue 立的。） */
.health-overlay .detail { margin: 0; color: var(--c-text-dim); }

/* Blocking（版面／可及性複審）：template 用到 .hint／.warn（health-overlay
   四則裝置異常警告與底下兜底畫面那句「畫面好像卡住了」），但 App.vue 自己
   從來沒有為它們寫過對應規則。CalibrationWizard/StatsDashboard/ThresholdLab/
   SettingsSheet/StatusIndicator 的 <style scoped> 裡都各自定義了一份同名的
   .hint/.warn——但 Vue 的 scoped style 是靠編譯期加上的 data-v-xxx 屬性選擇器
   隔離的，那些規則只會套用到各自元件自己渲染出來的節點，**不會**套用到
   App.vue 的節點。結果就是全 App 唯一一處「警示文字沒有警示樣式」，而且剛好
   是裝置壞掉時最關鍵的復原提示——這是可以直接從原始碼讀出來的既成事實。

   放在這裡（App.vue 的 scoped style）而不是全域 src/styles/：這兩個 class
   目前只有 App.vue 自己的 template 在用，全域檔案是給「真的跨元件共用」的
   東西（例如 .stack／.corner-tl 這種佈局骨架），這兩個字面上叫 .hint/.warn
   的 class 在不同元件裡代表的視覺語意其實不完全一樣（SettingsSheet 的
   .hint 是 14px 灰階說明文字；這裡的 .warn 要跟裝置異常這件事的嚴重程度
   相稱）——硬塞進全域檔案只會製造「這個規則到底管到哪個元件」的混淆，這個
   專案已經在「兩套真相」這件事上吃過虧（見 final-review-context.md）。

   .warn 沿用其餘元件的既有慣例（StatusIndicator.vue／ThresholdLab.vue 的
   .warn 都是 color: var(--c-warn)），加粗讓它在深色背景上更醒目，這是這裡
   唯一新增的視覺語言，不是另外發明一種。
   .hint 只明確宣告 font-size（數值上跟 body 的繼承值相同，不改變任何既有
   渲染結果）——刻意不去動 margin／padding／line-height 這些會影響 box 尺寸
   的屬性：上面 .health-overlay 高度的手算（153px）依賴 <p> 的 UA 預設
   margin（1em），這裡如果改了 margin，那個算式就得整個重算，得不償失。

   已知局限（誠實記錄，見下方 App.mount.test.js 的護欄說明）：font-weight
   加粗理論上不影響同一字級的行高（系統字型的 regular/bold 通常共用字型
   度量），但這個假設沒有在真機上驗證過，跟這份報告其餘所有「手算」項目
   一樣，最終要靠真機確認 153px 這個數字有沒有漂移。 */
.hint { font-size: var(--fs-body); }
.warn { color: var(--c-warn); font-weight: 700; }

/* 工作人員設定的小齒輪（Ruling DU）：低對比但**確實看得見**（不是隱形圖層，
   Task 16 審查明確禁止）。矩形算式見 template 上方的註解。
   z-index 7 夾在 InstallGuide／OfflineWarmup（8）與 CoachBanner（4）之間：
   它只出現在任務畫面，而那個畫面上另外兩個 fixed 元素都錨在相反的邊，
   這個值今天不會決定任何一次遮擋，寫出來只是不讓它落在預設堆疊裡。 */
.staff-gear {
  position: fixed;
  top: max(var(--gap), env(safe-area-inset-top));
  right: max(var(--gap), env(safe-area-inset-right));
  z-index: 7;
  width: var(--tap-min);
  height: var(--tap-min);
  background: transparent;
  color: var(--c-text-dim);
  opacity: .55;
  font-size: 20px;
  line-height: 1;
}

/* 設定面板旁邊的兩顆入口（量測工具／換人玩）。z-index 11 才在面板的 backdrop
   （10）之上，矩形算式與已知邊界見 template 上方的註解。 */
.staff-extra {
  position: fixed;
  top: max(var(--gap), env(safe-area-inset-top));
  left: max(var(--gap), env(safe-area-inset-left));
  right: max(var(--gap), env(safe-area-inset-right));
  z-index: 11;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--gap);
  padding: 8px;
  border-radius: var(--radius);
  background: var(--c-surface);
}
.staff-btn {
  min-height: var(--tap-min);
  padding: 0 16px;
  background: transparent;
  outline: 2px solid var(--c-accent);
  color: var(--c-text);
}

/* 結算畫面角落的「換人玩」：次要樣式（不是實心強調色）——底部那兩顆
   「再討伐一次／回主畫面」才是這個畫面的主動作，這一顆是交接用的出口。 */
.corner-exit {
  position: fixed;
  top: max(var(--gap), env(safe-area-inset-top));
  right: max(var(--gap), env(safe-area-inset-right));
  z-index: 7;
  min-height: var(--tap-min);
  padding: 0 16px;
  background: transparent;
  outline: 2px solid var(--c-text-dim);
  color: var(--c-text-dim);
}
</style>
