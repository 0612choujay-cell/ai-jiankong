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
        <svg class="boss-svg" viewBox="0 0 200 200">
          <!-- 影子：靜態，不隨漂浮變形（會動的影子要多一組動畫，不值得） -->
          <ellipse class="ink" cx="100" cy="186" rx="50" ry="8" />

          <!-- 先畫會被身體蓋住的部件（角、手臂、腿），再畫身體，肩／髖點
               刻意落在身體圓形內側，讓四肢視覺上「從身體裡長出來」，末端
               （手、腳）落在身體圓外，這樣才看得出這是一個有四肢的全身，
               不是一顆掛了裝飾的頭。手臂／腿用 stroke 畫（粗圓頭線段），
               不用一堆填色多邊形拼——形狀好調、粗細好調，而且跟 .hit-flash
               共用同一組座標時只需要複製 <path> 的 d，不必再對齊填色範圍。 -->
          <g class="horn">
            <path d="M64 60C56 40 58 28 72 22C76 38 82 50 90 58Z" />
            <path d="M136 60C144 40 142 28 128 22C124 38 118 50 110 58Z" />
          </g>
          <g class="limbs">
            <!-- 手臂：transform-origin 對齊肩點（身體圓內側），出手攻擊時
                 整個 <g>（線段＋手掌）繞著肩點旋轉，手掌才不會脫離手臂。 -->
            <g class="arm arm-l">
              <path d="M48 108Q22 122 18 148" />
              <circle class="hand" cx="18" cy="148" r="13" />
            </g>
            <g class="arm arm-r">
              <path d="M152 108Q178 122 182 148" />
              <circle class="hand" cx="182" cy="148" r="13" />
            </g>
            <!-- 腿：目前不參與任何動畫（待機／蓄力／攻擊都只動 .stance／
                 手臂），純造型用途——但一樣拆成 <g> 而不是散落的 ellipse，
                 保留未來要單獨動它的餘地，不必回頭重畫。 -->
            <g class="leg leg-l">
              <path d="M82 158Q70 176 66 192" />
              <ellipse class="foot" cx="64" cy="194" rx="16" ry="9" />
            </g>
            <g class="leg leg-r">
              <path d="M118 158Q130 176 134 192" />
              <ellipse class="foot" cx="136" cy="194" rx="16" ry="9" />
            </g>
          </g>
          <g class="skin">
            <circle cx="100" cy="112" r="62" />
          </g>

          <!-- 肚子與腮紅：用 --c-text／--c-danger 加低不透明度做出深淺，
               不自己發明第二組色碼（tokens.css 沒有「魔王亮部／暗部」色）。 -->
          <ellipse class="belly" cx="100" cy="132" rx="38" ry="30" />
          <ellipse class="blush" cx="54" cy="128" rx="10" ry="6" />
          <ellipse class="blush" cx="146" cy="128" rx="10" ry="6" />

          <!-- 眼睛：睜眼（待機／蓄力／攻擊）與瞇眼（被打）兩組，用 opacity 互換。
               大眼睛、高光在上方＝Q 版，不是恐怖。 -->
          <g class="eyes-open">
            <ellipse class="sclera" cx="78" cy="100" rx="18" ry="20" />
            <ellipse class="sclera" cx="122" cy="100" rx="18" ry="20" />
            <circle class="pupil" cx="80" cy="104" r="8.5" />
            <circle class="pupil" cx="124" cy="104" r="8.5" />
            <circle class="glint" cx="75" cy="97" r="3.6" />
            <circle class="glint" cx="119" cy="97" r="3.6" />
          </g>
          <g class="eyes-shut">
            <path d="M66 104Q78 90 90 104" />
            <path d="M110 104Q122 90 134 104" />
          </g>

          <!-- 眉毛：蓄力／攻擊／大招／第二形態才出現，把「他認真了」畫在臉上。
               是「認真起來」的眉，不是兇惡的眉——線很短、角度很淺。 -->
          <g class="brows">
            <path d="M62 76L88 84" />
            <path d="M138 76L112 84" />
          </g>

          <!-- 三種嘴形，一次只有一個 opacity:1 -->
          <path class="mouth-idle" d="M84 140Q100 154 116 140" />
          <ellipse class="mouth-ouch" cx="100" cy="144" rx="9" ry="7" />
          <g class="mouth-roar">
            <path class="maw" d="M78 136Q100 130 122 136Q118 162 100 162Q82 162 78 136Z" />
            <path class="tooth" d="M87 135L93 135L90 142Z" />
            <path class="tooth" d="M107 135L113 135L110 142Z" />
            <ellipse class="tongue" cx="100" cy="156" rx="9" ry="6" />
          </g>

          <!-- 打擊閃光：被打瞬間整輪廓（角＋身體＋四肢）疊一層淡色，0→0.7→0，
               純 opacity，不是重畫一次「白色版魔王」的 filter。座標直接複製
               上面 horn／skin／limbs 的 d／cx／cy——同一份幾何，兩種畫法
               （填色 vs 描邊），這樣才會跟本體完全對齊，不必另外量一次。
               眼睛／嘴巴刻意不複製進來：閃光只蓋輪廓，臉部表情（瞇眼、
               張嘴）本來就已經在做「被打」的表情切換，兩者疊加才看得出
               「這一下真的很痛」而不是全身變成一塊色板。 -->
          <g class="hit-flash">
            <g class="hit-flash-fill">
              <path d="M64 60C56 40 58 28 72 22C76 38 82 50 90 58Z" />
              <path d="M136 60C144 40 142 28 128 22C124 38 118 50 110 58Z" />
              <circle cx="100" cy="112" r="62" />
            </g>
            <g class="hit-flash-stroke">
              <path d="M48 108Q22 122 18 148" />
              <path d="M152 108Q178 122 182 148" />
              <path d="M82 158Q70 176 66 192" />
              <path d="M118 158Q130 176 134 192" />
            </g>
          </g>
        </svg>
      </div>
    </div>
  </div>
</template>

<script setup>
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
 * 整張圖是 inline SVG：這個 App 是離線展場裝置，CSP 的 connect-src 只允許
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
  width: clamp(140px, 30vmin, 280px);
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
.boss-svg { display: block; width: 100%; height: 100%; }

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
/* 手臂出拳：跟 boss-attack 同時間、同長度播，但獨立一組 keyframes——身體
   撲、手臂揮是兩層疊加的動作，不是同一組 transform 拆開寫。兩隻手臂同方向
   旋轉（不分英雄在左在右）：這是「雙手前撲」的日常小動作，不是必須指向
   英雄方向的大招衝刺，用同一組角度更省事、也更好認。 */
.boss-sprite.attacking .arm-l,
.boss-sprite.attacking .arm-r { animation: boss-attack-arm .42s ease-out; }
@keyframes boss-attack-arm {
  0%   { transform: rotate(0deg); }
  35%  { transform: rotate(-18deg); }
  65%  { transform: rotate(28deg); }
  100% { transform: rotate(0deg); }
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
  30%  { transform: translate(var(--recoil-x), var(--recoil-y)) scale(0.88) rotate(var(--recoil-rot)); }
  60%  { transform: translate(calc(var(--recoil-x) * -0.25), calc(var(--recoil-y) * -0.25)) scale(1.05) rotate(0deg); }
  100% { transform: translate(0, 0) scale(1) rotate(0deg); }
}

/* --- 打擊閃光：跟 boss-hit 同時播、同樣 0.3s，純 opacity，見 template
       裡 .hit-flash 那段註解為什麼複製座標而不是共用 <use>（jsdom 測不到
       <use> 的 shadow tree，真機上 class 選擇器還會穿透進去蓋掉這裡想要
       的顏色，兩個理由都指向「直接複製幾何」比較穩）。 --- */
.boss-sprite.struck .hit-flash { animation: boss-hit-flash .3s ease-out; }
@keyframes boss-hit-flash {
  0%   { opacity: 0; }
  25%  { opacity: .7; }
  100% { opacity: 0; }
}

/* --- 造型（顏色全部來自 tokens.css，沒有任何自己發明的色碼） --- */
.skin circle { fill: var(--c-boss); }
.horn path { fill: var(--c-warn); }
.ink { fill: var(--c-bg); opacity: .45; }
.belly { fill: var(--c-text); opacity: .16; }
.blush { fill: var(--c-danger); opacity: .45; }
.sclera { fill: var(--c-text); }
.pupil { fill: var(--c-bg); }
.glint { fill: var(--c-text); }
.eyes-shut path, .brows path {
  fill: none; stroke: var(--c-bg); stroke-width: 6; stroke-linecap: round;
}
.mouth-idle { fill: none; stroke: var(--c-bg); stroke-width: 6; stroke-linecap: round; }
.mouth-ouch, .maw { fill: var(--c-bg); }
.tooth { fill: var(--c-text); }
.tongue { fill: var(--c-danger); }

/* 四肢：stroke 畫的粗圓頭線段，手掌／腳掌是實心圓／橢圓蓋在線段末端。
   transform-origin 對齊肩點（跟 template 裡的路徑起點座標一致），出手
   攻擊時整個 <g> 繞著這個點轉，線段與手掌才會一起動、不脫節。
   顯式寫 transform-box: view-box：不同瀏覽器對 SVG 子元素沒設它時的預設
   參考框歷史上不一致（fill-box vs view-box），這裡不賭預設值，直接指定
   成跟 viewBox 座標系一致，數字才會跟上面的座標算式對得上。 */
.arm path, .leg path { fill: none; stroke: var(--c-boss); stroke-width: 20; stroke-linecap: round; }
.leg path { stroke-width: 24; }
.hand, .foot { fill: var(--c-boss); }
.arm-l { transform-box: view-box; transform-origin: 48px 108px; }
.arm-r { transform-box: view-box; transform-origin: 152px 108px; }

/* --- 表情切換：純 opacity，不是動畫。
       這是「狀態一眼分得出來」真正的主力——位移看得到但記不住，
       臉才記得住。也因為是 opacity 不是 animation，reduced-motion 下
       完全照常生效（見下面的 reduce 區塊）。 --- */
.eyes-open { opacity: 1; }
.eyes-shut, .brows, .mouth-ouch, .mouth-roar { opacity: 0; }
.mouth-idle { opacity: 1; }
.hit-flash { opacity: 0; }
.hit-flash-fill { fill: var(--c-text); }
.hit-flash-stroke { fill: none; stroke: var(--c-text); stroke-width: 22; stroke-linecap: round; }

/* --- 第二（含以上）形態：只換臉／角，不換身形（理由見上面尺寸那段
       註解）。角變大用 transform: scale() 而不是重畫路徑，transform-origin
       對齊每隻角自己在身體上的接點，往外變大、不平移整隻角的位置。
       這個區塊必須放在 charging／attacking／ultimate／struck 的表情規則
       **之前**：那幾個狀態各自對 .brows 有自己的 opacity 規則，同一個
       選擇器特異度下靠原始碼順序決定誰贏，被打瞬間必須恢復成瞇眼、
       眉毛收起，不能被 phase2 的「眉毛常駐」蓋過去。 --- */
.boss-sprite.phase2 .horn path:first-child { transform: scale(1.18); transform-origin: 70px 58px; }
.boss-sprite.phase2 .horn path:last-child { transform: scale(1.18); transform-origin: 130px 58px; }
.boss-sprite.phase2 .brows { opacity: 1; }
.boss-sprite.phase2 .blush { opacity: .75; }

.boss-sprite.charging .brows { opacity: 1; }
.boss-sprite.charging .mouth-idle { opacity: 0; }
.boss-sprite.charging .mouth-roar { opacity: 1; }

.boss-sprite.attacking .brows { opacity: 1; }
.boss-sprite.attacking .mouth-idle { opacity: 0; }
.boss-sprite.attacking .mouth-roar { opacity: 1; }

/* 大招沿用蓄力那張臉（眉＋張嘴）：造型不必再多一種，動作幅度已經把
   「這次不一樣」講完了。臉是 opacity 切的，reduced 模式下照常生效——
   那正是 reduced 下大招唯一來自魔王本體的回饋。 */
.boss-sprite.ultimate .brows { opacity: 1; }
.boss-sprite.ultimate .mouth-idle { opacity: 0; }
.boss-sprite.ultimate .mouth-roar { opacity: 1; }

/* struck 的規則放在 charging／attacking／ultimate／phase2 之後：這幾個都
   可能同時成立（例如蓄力中被打中、或第二形態被打中），這時要顯示的是
   「被打」那張臉，後面的規則勝出。 */
.boss-sprite.struck .eyes-open { opacity: 0; }
.boss-sprite.struck .eyes-shut { opacity: 1; }
.boss-sprite.struck .brows { opacity: 0; }
.boss-sprite.struck .mouth-idle,
.boss-sprite.struck .mouth-roar { opacity: 0; }
.boss-sprite.struck .mouth-ouch { opacity: 1; }

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
  .boss-sprite.attacking .arm-l,
  .boss-sprite.attacking .arm-r,
  .boss-sprite.struck .hit-flash { animation: none; }
  .boss-sprite.charging .stance { transform: scale(1.06); }
}
</style>
