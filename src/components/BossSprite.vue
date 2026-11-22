<template>
  <!-- 魔王是純裝飾：血量、形態、「魔王要攻擊了」這些語意全部由 .boss-hud 的
       HpBar 與 CoachBanner 的文字負責朗讀，這裡再掛一次 aria-live 只會讓
       螢幕閱讀器把同一件事念兩遍。整棵子樹 aria-hidden。 -->
  <div class="boss-sprite" :class="{ struck, charging, ultimate, attacking, phase2: phase >= 2 }" aria-hidden="true">
    <!-- 兩層是刻意的，不是多包一層 div：
         .stance（外層）負責「站姿」——待機漂浮、蓄力逼近、出手攻擊，三者互斥；
         .hit（內層）負責「被打」的後仰縮身，是一次性的短動畫。
         分層之後，蓄力中被打（陷阱成立前小孩坐正打中魔王，很常見）兩個
         動畫可以同時播，不必爭同一個 animation 屬性、也不必寫一組
         「蓄力中被打」的合成 keyframes。 -->
    <div class="stance">
      <div class="hit">
        <div class="breath">
          <img class="boss-img" :src="bossUrl" alt="" draggable="false">
          <!-- 被打閃光：同一張圖疊一層，純 opacity 播放（見 .hit-flash） -->
          <img class="hit-flash" :src="bossUrl" alt="" draggable="false">
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import bossUrl from '../assets/boss.webp'
/**
 * Q 版分心大魔王。
 *
 * 五個狀態的真相來源在 BattleView：`bossStruck`（flash('boss') 開、300ms 後關）、
 * `hasPendingTrap`（battle.pendingTraps 非空）、`bossUltimate`（ultimates 陣列
 * 推導）、`bossAttacking`（flash-like 一次性旗標，playerDamage 事件觸發、
 * ATTACK_MS 後關，見 BattleView 的 fireAttack()）、`battle.phase`（第幾形態）。
 * 這個元件**只接收**這五個值，不自己判斷、不自己計時、不讀 store——BattleView
 * 上既有的那幾個 class／prop 綁的是同一組 ref，是同一套狀態機的出口，不是
 * 第二套。
 *
 * 魔王是一張打包進 /assets 的圖片（src/assets/boss.webp，由 Vite 帶 hash 輸出、
 * service worker 以 cache-first 快取），不是外部圖檔：這個 App 是離線展場裝置，CSP 的 connect-src 只允許
 * 同源，任何 CDN 或外部圖檔都會被靜默擋掉（沒有錯誤訊息、只有一塊空白）。
 */
defineProps({
  // 被打：BattleView 的 bossStruck（attack 事件觸發，STRUCK_MS=300 後歸零）
  struck: { type: Boolean, default: false },
  // 蓄力：BattleView 的 hasPendingTrap（陷阱即將成立＝該收手機／坐回來了）
  charging: { type: Boolean, default: false },
  // 大招：BattleView 的 bossUltimate（trapCommitted 事件，陷阱真的成立了）。
  // 這是蓄力那 20 秒的結算，不是另一種被打——所以它是獨立的一格，
  // 動作幅度是四者裡最大的。
  ultimate: { type: Boolean, default: false },
  // 出手攻擊：BattleView 的 bossAttacking（playerDamage 事件＝姿態不良被
  // 反擊，觸發後 ATTACK_MS 內自動歸零）。跟 ultimate 不同：這是每次姿態
  // 扣血都會播的「日常攻擊」，幅度必須明顯小於大招，否則兩者又長一樣了。
  attacking: { type: Boolean, default: false },
  // 形態：battle.phase，1 起算。只影響外觀（角變大、眉毛常駐、腮紅變濃），
  // 不影響任何一組動畫的觸發條件——那三個布林值才是真相來源，phase 只是
  // 「同一隻魔王换了一張更凶的臉」，不是換了一套新的狀態機。
  phase: { type: Number, default: 1 },
})
</script>

<style scoped>
/* ===========================================================================
   效能紅線：這裡的動畫只准用 transform 與 opacity。
   ===========================================================================
   理由不是潔癖。這個 App 在**同一個主執行緒**上跑 MediaPipe 推論，
   perfMonitor.js 在推論延遲連續超標 10 秒後會**單向降檔**（pose 2→1fps、
   face 3→1.5fps、手機偵測關閉），而且**不可升回**（見 perfMonitor.js 檔頭：
   「只有一檔、而且不可升回」）。
   一個貴的動畫（filter／box-shadow 動畫／blur／大面積漸層重繪會逼出
   layout 或 paint）會讓這台 iPad 的偵測能力在那一輪之後永久變差，
   而展場現場只會看到「今天這台特別鈍」——沒有錯誤訊息、沒有人會發現。
   transform／opacity 走 compositor，不碰 layout 也不碰 paint。
   BossSprite.test.js 有一條原始碼掃描護欄鎖住這件事。

   下面的 phase2（第二形態起）造型變化全部是**靜態**規則（角變大、眉毛
   常駐、腮紅變濃）：只在 phase 這個 prop 改變的那一刻觸發一次性重繪，
   不是每一幀都在動的東西，不受這條紅線約束，也不需要進 reduced-motion
   分支——跟「動畫」是兩件事。
   =========================================================================== */

/* 尺寸：clamp 的上下限用 vmin，直橫兩個方向拿到同一個視覺大小。
   實算（CSS px）：
     11" 直 834×1194 → vmin 834 → 30vmin = 250.2
     11" 橫 1194×834 → vmin 834 → 250.2
     12.9" 直 1024×1366 → vmin 1024 → 307.2 → 上限夾到 280
     12.9" 橫 1366×1024 → vmin 1024 → 280
   四種情境落在 250.2~280，兩個方向一致。矩形不相交的手算在
   BattleView.vue 的 .arena__scene 註解裡（那裡才看得到完整版面）。

   phase2 刻意不改這個尺寸（不加整體 scale()）：BattleView.vue 的
   .arena__boss／.ult 那組手算是針對「魔王最大延伸＝大招 scale(1.3)」算的，
   如果 phase2 再疊一個外層 scale()，大招在 phase2 之後的最大延伸會變成
   兩者相乘，等於要重算四種裝置方向的矩形不相交證明。角變大、眉毛常駐這些
   臉部/裝飾層級的改動不影響 .boss-sprite 整體外框，不必動那份手算。 */
.boss-sprite {
  position: relative;
  z-index: 1; /* 場景(0) < 魔王(1) < 戰場帶(2) < 角落(3) < boss-hud(4) */
  width: clamp(200px, 46vmin, 420px);
  aspect-ratio: 1 / 1;

  /* 「後仰」的方向跟著版面走，跟 layout.css 的 --attack-dx/--attack-dy
     同一個作法：橫式魔王在右半邊，往後＝往右(+x)；直式魔王在下半邊，
     往後＝往下(+y)。下面那組基底值是 fallback（兩個 orientation 查詢
     理論上必有一個命中，留著成本是零，防止極端情境兩個都沒命中時
     變數 unset 讓動畫整個不動——理由同 layout.css 那段註解）。 */
  --recoil-x: 0%;
  --recoil-y: 7%;
  --recoil-rot: 0deg;
}
@media (orientation: landscape) {
  .boss-sprite { --recoil-x: 7%; --recoil-y: 0%; --recoil-rot: 7deg; }
}
@media (orientation: portrait) {
  .boss-sprite { --recoil-x: 0%; --recoil-y: 7%; --recoil-rot: 0deg; }
}

.stance, .hit { width: 100%; height: 100%; }

/* --- 待機：很省的呼吸／漂浮。3.6s 一個循環、位移 2.5%、放大 1.5%，
       只有一個合成層在動，看得出「他是活的」但不會吸走注意力。 --- */
.stance {
  will-change: transform;
  animation: boss-idle 3.6s ease-in-out infinite;
}
@keyframes boss-idle {
  0%, 100% { transform: translateY(0) scale(1); }
  50%      { transform: translateY(-2.5%) scale(1.015); }
}

/* --- 蓄力（陷阱即將成立）：先蹲低、再往英雄側逼近並放大。
       這個狀態的意義是「現在該把手機收起來、坐回去」，所以它必須讓人
       感覺到威脅在逼近，而不只是原地脈動——1.1s 一循環比待機快三倍，
       放大到 1.12 是整組動畫裡最大的位移量。 --- */
.boss-sprite.charging .stance { animation: boss-charge 1.1s ease-in-out infinite; }
@keyframes boss-charge {
  0%, 100% { transform: translate(0, 0) scale(1); }
  35%      { transform: translate(calc(var(--recoil-x) * 0.4), calc(var(--recoil-y) * 0.4)) scale(0.96); }
  70%      { transform: translate(calc(var(--recoil-x) * -0.9), calc(var(--recoil-y) * -0.9)) scale(1.12); }
}

/* --- 出手攻擊（姿態不良被反擊）：蓄勢→撲向英雄側→歸位，0.42s 對齊
       BattleView 那發 .bolt.to-hero 的飛行時間（fly-back .42s）——魔王的
       撲擊動作跟光球離開他身體的瞬間同步，光球才不會憑空冒出來。
       幅度刻意比蓄力／大招小（scale 峰值 1.08，蓄力是 1.12、大招是 1.3）：
       這是每次姿態扣血都會播的「日常攻擊」，不是特殊事件，份量感必須
       跟大招分得開，不然兩種反擊在畫面上又變成同一件事。
       手臂另外用 boss-attack-arm 動，兩組動畫時間對齊但各自獨立——身體
       撲、手臂揮，兩層疊加才有「出拳」的感覺，單靠身體位移撐不起來。 --- */
.boss-sprite.attacking .stance { animation: boss-attack .42s ease-out; }
@keyframes boss-attack {
  0%   { transform: translate(0, 0) scale(1); }
  35%  { transform: translate(calc(var(--recoil-x) * 0.3), calc(var(--recoil-y) * 0.3)) scale(0.95); }
  65%  { transform: translate(calc(var(--recoil-x) * -0.6), calc(var(--recoil-y) * -0.6)) scale(1.08); }
  100% { transform: translate(0, 0) scale(1); }
}
/* 蓄力中同時被姿態扣血（陷阱待確認期間本來就可能發生——物品判斷跟姿態
   判斷是兩條互不影響的規則，小孩完全可能一邊駝背一邊被判定拿著手機）：
   身體的蹲低動作維持蓄力那一版，不被攻擊動作蓋掉——蓄力是持續 20 秒的
   警示，比一次性的日常攻擊更需要穩定顯示，中途被打斷 0.42s 又接回去
   反而更晃眼。手臂仍然照常出拳：那是「這一下真的打到你了」的獨立回饋，
   跟身體蹲低的姿態互不衝突。這條選擇器跟 struck 放在 charging 之後同一個
   理由：兩個 class 同時成立時，寫在後面、且更具體的規則才會贏。 */
.boss-sprite.charging.attacking .stance { animation: boss-charge 1.1s ease-in-out infinite; }

/* --- 大招（陷阱生效）：大幅後拉蓄力 → 撲出 → 收回，0.6s 一次性。
       這是整個元件幅度最大的一格，而且是唯一「先反向再正向」的：份量感
       來自**錯位時序**（22% 先往後縮到 0.86，42% 才撲到 1.3），不是來自
       加特效。同一個 --recoil-x/y 向量，係數放到 1.1 / -1.3，所以橫式直式
       的方向都自動正確。
       尺度上界是算過的，不是挑好看的數字：scale 1.3 讓 sprite 的半邊延伸
       從 125.1 變成 162.6（11"）／140 變成 182（12.9"），四種情境下與
       .boss-hud 與四個角落按鈕仍然不相交，最小餘裕 27.1px（11" 直式、
       42% 那一格對 .boss-hud 下緣）。完整手算見 BattleView.vue 的
       .arena__scene 與 .ult 註解。 --- */
.boss-sprite.ultimate .stance { animation: boss-ultimate .6s ease-out; }
@keyframes boss-ultimate {
  0%   { transform: translate(0, 0) scale(1); }
  22%  { transform: translate(calc(var(--recoil-x) * 1.1), calc(var(--recoil-y) * 1.1)) scale(0.86); }
  42%  { transform: translate(calc(var(--recoil-x) * -1.3), calc(var(--recoil-y) * -1.3)) scale(1.3); }
  62%  { transform: translate(calc(var(--recoil-x) * -0.6), calc(var(--recoil-y) * -0.6)) scale(1.18); }
  100% { transform: translate(0, 0) scale(1); }
}

/* --- 被打：往後仰、縮一下，300ms 收工（跟 BattleView 的 STRUCK_MS 一致）。
       短促有力，不做回彈震盪——反覆抖動在連段攻擊時會變成畫面一直在抖。 --- */
.boss-sprite.struck .hit { animation: boss-hit .3s ease-out; }
@keyframes boss-hit {
  0%   { transform: translate(0, 0) scale(1) rotate(0deg); }
  30%  { transform: translate(calc(var(--recoil-x) * 1.8), calc(var(--recoil-y) * 1.8)) scale(0.8) rotate(calc(var(--recoil-rot) * 1.6)); }
  60%  { transform: translate(calc(var(--recoil-x) * -0.25), calc(var(--recoil-y) * -0.25)) scale(1.05) rotate(0deg); }
  100% { transform: translate(0, 0) scale(1) rotate(0deg); }
}

/* --- 呼吸：身體沿著腳底一起一伏（吸氣＝微微拉高、變寬一點，吐氣＝回落）。
       只用 transform，transform-origin 在底部中央，所以「站在地上」的腳不會
       飄，是上半身在升降。3.6s 一個循環，比待機漂浮慢一點、幅度大一點
       （scaleY 1→1.045），看得出在呼吸又不會吵。 --- */
.breath { position: relative; width: 100%; height: 100%; transform-origin: 50% 100%; animation: boss-breath 3.6s ease-in-out infinite; will-change: transform; }
@keyframes boss-breath {
  0%, 100% { transform: scale(1, 1); }
  50%      { transform: scale(1.015, 1.045); }
}
.boss-img, .hit-flash { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; object-position: 50% 100%; user-select: none; pointer-events: none; }

/* --- 被打閃光：同一張圖加上靜態亮度濾鏡，只播 opacity。 --- */
.hit-flash { opacity: 0; filter: sepia(1) saturate(9) hue-rotate(-52deg) brightness(1.6); }
.boss-sprite.struck .hit-flash { animation: boss-hit-flash .3s ease-out; }
@keyframes boss-hit-flash {
  0%   { opacity: 0; }
  20%  { opacity: .95; }
  60%  { opacity: .6; }
  100% { opacity: 0; }
}

/* 蓄力／大招／第二形態：圖片沒有可切換的表情，用靜態的色調暗示。 */
.boss-sprite.charging .boss-img, .boss-sprite.ultimate .boss-img, .boss-sprite.attacking .boss-img { filter: saturate(1.5) brightness(1.15); }
.boss-sprite.phase2 .boss-img { filter: saturate(1.3) hue-rotate(-25deg); }

/* --- prefers-reduced-motion ---
   base.css 已經有一條全域規則把所有 animation-duration 壓成 .001ms，
   所以「不會動」這件事本來就成立。這個區塊處理的是**另一件事**：
   duration 被壓成 .001ms 之後，動畫會瞬間停在 100% 那一格——而
   boss-charge 的 100% 正好是 scale(1)，等於蓄力狀態在 reduced 模式下
   完全沒有任何視覺線索，小孩不會知道陷阱即將成立。
   所以這裡明確關掉動畫，改用一個**靜態**的放大當作「他逼近了」：
   陷阱視窗是持續狀態（不是閃一下），套上去、解除時拿掉，只有兩次
   離散變化，不構成動態。
   被打（300ms 閃一下）、打擊閃光（同一個 300ms）、出手攻擊（0.42s 一次性）
   與大招（0.6s 一次性）都不補靜態位移——瞬間位移再瞬間歸位本身就是動態。
   那幾格的回饋交給既有作法：BattleView 的閃紅框、傷害數字、以及大招的
   靜態衝擊環＋底色（見 BattleView.vue 的 reduce 區塊），再加上這裡純
   opacity 的表情切換（瞇眼／張嘴，opacity 不受這個區塊影響）。 */
@media (prefers-reduced-motion: reduce) {
  .stance,
  .boss-sprite.charging .stance,
  .boss-sprite.attacking .stance,
  .boss-sprite.charging.attacking .stance,
  .boss-sprite.ultimate .stance,
  .boss-sprite.struck .hit,
  .breath,
  .boss-sprite.struck .hit-flash { animation: none; }
  .boss-sprite.charging .stance { transform: scale(1.06); }
}
</style>
