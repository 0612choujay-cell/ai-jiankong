<template>
  <div class="arena" :class="{ regrouping: battle?.regrouping }">
    <!-- 英雄側：使用者自己的鏡頭即時畫面（鏡射同一條 MediaStream 的第二個
         <video>，不搬動 App.vue 那顆真正接了 getUserMedia 的節點——跟
         CalibrationWizard 是同一個既有模式）。 -->
    <section class="arena__hero" :class="{ struck: heroStruck }">
      <video ref="localVideo" class="cam" playsinline muted autoplay />
      <!-- 骨架線疊加層：讓小孩看得到系統「看到」他的哪幾個點（兩肩＋頸線）。
           它只吃 inference 的 onPoseFrame() 推送，畫完即丟——完整的隱私推導
           在 PoseSkeletonOverlay.vue 的檔頭。fit 必須跟下面 .cam 的
           object-fit 一致（cover），那是兩套真相的典型形狀，有護欄鎖住。

           :posture 傳的是 session.state.posture——字串列舉（'upright' /
           'slouch' / 'forwardHead' / 'gazeAway'），早就被壓縮成安全彙總值，
           跟骨架線本身走的原始座標通道完全獨立（見該元件檔頭的資料流圖）。
           校準畫面不傳這個 prop，維持它原本的固定色，理由寫在 prop 定義。 -->
      <PoseSkeletonOverlay :inference="inferenceSvc" :video="localVideo" fit="cover" :posture="s.posture" />
      <div class="hero-hud">
        <HpBar label="你的體力" :value="battle?.playerHp ?? BATTLE.playerHpMax" :max="BATTLE.playerHpMax" side="hero" />
      </div>
      <p v-if="battle?.regrouping" class="regroup">重整旗鼓<br><span>{{ regroupText }}</span></p>
      <!--
        重大違規 debuff 的畫面顯示。機制在 focusStateMachine.js，這裡只是把它
        說出來——而「說出來」正是這個機制能不能成立的關鍵：
        中了 debuff 卻不知道自己中了什麼、也不知道怎麼解，體感只會是
        「怎麼今天打得特別慢」，那是最差的一種懲罰。

        顯示的是**還要再專心幾秒**（debuffFocusRemainMs），不是還剩幾秒過期
        （debuffRemainMs）。兩者差別很大：前者指向一個他做得到的動作，
        後者只是叫他等。這個機制的設計原則是「像一個可以打掉的東西，
        不像一個被貼上的標籤」，文案要撐住那個原則。

        刻意不畫圖示（骷髏、鎖鏈那類）：使用者是 12 歲，而 12 歲正是同儕眼光
        最敏感的年紀。在別人看得到的螢幕上掛一個「你被詛咒了」的符號，
        跟這個專案一路在避免的公開難堪是同一件事。倒數數字本身就是說明書。

        `regrouping` 時不顯示：那時候兩個計時器都凍結（見 focusStateMachine.js），
        畫面上再放一個不會動的倒數只會讓人以為卡住了。

        ── 這一格現在有兩句話，互斥，優先序寫在 heroHint（Blocking B2／B3）──

        「東西在畫面上 ⇒ 完全不攻擊」這條規則原本**完全沒有視覺語言**：
        t=0 東西被偵測到，魔王從此不掉血，畫面上什麼都沒有；t=3s 提示卡片出現，
        帶撤銷鈕與 20 秒倒數；t=23s 卡片 TTL 過期消失，**魔王仍然不掉血，
        而畫面上再也沒有任何字**。之後小孩坐姿完美、體力滿格、時鐘在跑、
        分數不動、魔王血條不動、沒有任何訊息——他只會以為是自己坐得不夠好。

        所以這一格在被封鎖時改成指向**真正的障礙**：「把東西移開就能打」。
        它跟封鎖同生共死（沒有 TTL），而且按下撤銷的那一刻會當場消失——
        那就是撤銷鈕「看得出來有用」的另一半。

        為什麼可以跟 debuff 倒數共用同一格而不打架：被封鎖時 debuff 的專注
        累積器**本來就不會前進**（解除條件含 !objectBlocking），也就是說
        「再專心 N 秒」在那個當下是一句做不到的話——那個數字一秒都不會動，
        而小孩明明正坐得筆直。同一格、優先顯示障礙，比並排兩句話誠實。
      -->
      <p
        v-if="heroHint && !battle?.regrouping"
        class="debuff"
        role="status"
        aria-live="polite"
      >
        {{ heroHint }}
      </p>
    </section>

    <!-- 魔王側 -->
    <section class="arena__boss" :class="{ struck: bossStruck, charging: hasPendingTrap }">
      <!-- 場景層：純背景，只鋪在魔王側。刻意**不**鋪到英雄側——那半邊整片
           是即時鏡頭影像（.cam），任何圖案疊上去都只會讓小孩自己的畫面
           變雜亂。這一層 pointer-events:none、z-index 0（全畫面最底），
           矩形關係的手算見下方 .arena__scene 的註解。 -->
      <div class="arena__scene" :class="{ phase2: (battle?.phase ?? 1) > 1 }" aria-hidden="true">
        <svg class="scene-svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMax slice">
          <circle class="scene-moon" cx="322" cy="58" r="30" />
          <circle class="scene-spark" cx="58" cy="46" r="3" />
          <circle class="scene-spark" cx="122" cy="88" r="2" />
          <circle class="scene-spark" cx="248" cy="40" r="2.5" />
          <circle class="scene-spark" cx="356" cy="120" r="2" />
          <circle class="scene-spark" cx="188" cy="132" r="2" />
          <ellipse class="scene-ridge-far" cx="92" cy="252" rx="150" ry="78" />
          <ellipse class="scene-ridge-far" cx="320" cy="258" rx="132" ry="66" />
          <ellipse class="scene-ridge-near" cx="200" cy="306" rx="250" ry="88" />
        </svg>
      </div>

      <div class="boss-hud">
        <!-- 血量上限用 bossHpPhaseMax，不是 bossHpMax：進入第二（含以上）形態後
             血量會補血、換了新的分母，用整體 bossHpMax 當分母會讓後期形態的血條
             顯示超過 100%（或看起來「還沒補滿」）。
             形態 > 1 時多傳 :segments——實機回報「應該同時顯示三個階段的血量，
             不要只有一條會一直補血的血條」。bossPhaseSegments 見下方註解。 -->
        <HpBar
          label="魔王" :value="battle?.bossHp ?? 0" :max="battle?.bossHpPhaseMax ?? 1" side="boss"
          :segments="bossPhaseSegments"
        />
        <p v-if="(battle?.phase ?? 1) > 1" class="phase">第 {{ battle.phase }} 形態</p>
      </div>
      <!-- 五個狀態的真相來源只有這四個既有的值（bossStruck / hasPendingTrap
           / bossUltimate，後者由 ultimates 陣列推導 / bossAttacking）加上
           battle.phase。上面 .arena__boss 的 class 與這裡的 prop 綁的是
           同一組，不是第二套狀態機。BossSprite 自己不讀 store、不計時。 -->
      <BossSprite
        :struck="bossStruck"
        :charging="hasPendingTrap"
        :ultimate="bossUltimate"
        :attacking="bossAttacking"
        :phase="battle?.phase ?? 1"
      />
    </section>

    <!-- 姿態邊緣提示：使用者要求「異常就在人像那直接顯示、畫面邊緣閃漸層
         紅色」。骨架線本身已經變紅（PoseSkeletonOverlay 的 :posture），這裡
         是第二層、範圍更大的提示——邊緣一圈，中心（遊戲內容集中的地方）
         保持透明，不影響任何文字或按鈕的可讀性。

         驅動來源是 `s.posture`（安全彙總字串），跟骨架線同一個真相，不是
         第二套判準。'upright' 以外一律算異常，理由跟骨架線變色一致
         （這個年齡層一眼判讀，三種異常姿態處理方式相同，不需要分開的
         視覺語言）。

         刻意不含 `s.drowsy`：嗜睡是另一個維度，遊戲裡已經有自己的溫和
         處理方式（安全提示，不計分），跟「你在滑手機／駝背」這種紅色警示
         混在一起，會讓一個可能只是沒睡飽的孩子，被當成他在搗蛋。

         效能：只有 opacity 一個屬性在變化（漸層本身是靜態背景圖，不重繪），
         而且是 CSS transition 不是 JS 每幀畫——不會被算進 perfMonitor 的
         降檔判準（那個判準只看 inference.step() 的延遲，不看 CSS 合成器
         的工作）。z-index 2，跟 .ult 同一層、明確低於四個角落按鈕(3)與
         .boss-hud(4)——結構上不可能蓋住任何可互動元素或關鍵讀數。 -->
    <div class="posture-vignette" :class="{ show: s.posture && s.posture !== 'upright' }" aria-hidden="true" />

    <!-- 戰場帶：飛行特效與傷害數字。節點常駐，用 class 觸發；同時最多 3 個 -->
    <div class="arena__field" aria-hidden="true">
      <div
        v-for="slot in SLOTS" :key="slot"
        class="bolt" :class="[flights[slot].dir, { fly: flights[slot].active }]"
      />
      <p v-for="n in numbers" :key="n.id" class="dmg" :class="n.side">
        {{ n.text }}<small v-if="n.tag">{{ n.tag }}</small>
      </p>

      <!-- 魔王大招：陷阱生效那一刻的視覺爆發（spec 第 280 行）。
           節點用 v-for + 唯一 key 掛上去、ULTIMATE_MS 後移除，跟 .dmg 同一
           個既有模式，不用 .bolt 那種常駐切 class 的模式——常駐節點在「上一
           發還沒播完又來一發」時不會從頭重播（CSS 動畫不會因為 class 沒變
           而重新觸發），而大招正是那種「連續兩個陷阱在幾秒內成立」會發生的
           東西。重新掛載的節點一定從 0% 開始。 -->
      <div v-for="u in ultimates" :key="u.id" class="ult">
        <div class="ult-flash" />
        <div class="ult-core">
          <span class="ult-ring r1" />
          <span class="ult-ring r2" />
          <span class="ult-ring r3" />
          <span class="ult-spike s1" />
          <span class="ult-spike s2" />
          <span class="ult-spike s3" />
          <span class="ult-spike s4" />
          <span class="ult-spike s5" />
          <span class="ult-spike s6" />
        </div>
      </div>
    </div>

    <!-- Important 1：health-overlay 顯示時不渲染 CoachBanner——兩者是完全
         相同的錨點公式，同時出現時 health-overlay（z-index 較高、不透明）
         會整片蓋住撤銷鈕與倒數。理由與取捨見上面 deviceIssueShown 的註解。 -->
    <CoachBanner
      v-if="!deviceIssueShown"
      :message="coachMessage" :undo-remain-sec="undoRemainSec" @undo="onUndo" @break="onBreak"
    />

    <!-- @click="bumpHud"：見下方 bumpHud() 的說明，這是刻意藏起來、
         不帶任何視覺提示的 Debug HUD 開關手勢，掛在這塊純顯示用的時鐘／
         分數區塊上（不是掛在任何按鈕上），不會跟暫停/結束搶點擊。 -->
    <div class="corner-tl status" @click="bumpHud">
      <span class="clock">{{ clockText }}</span>
      <span class="score">{{ battle?.score ?? 0 }} 分</span>
      <!-- Important 5：這顆按鈕是 corner-tl 這個 div 的子節點，而 corner-tl
           自己掛了 @click="bumpHud"（見下面 bumpHud() 的說明）。原生 click
           事件會冒泡，沒有 .stop 的話，每次點靜音鈕 bumpHud() 也會被觸發
           一次——小孩反覆切換語音（很常見的操作），5 次之內就會意外打開
           只給工作人員看的 Debug HUD，在展場評審面前跳出效能診斷面板。
           .stop 讓這顆按鈕自己的點擊不再往上冒，兩個手勢互不干擾。 -->
      <button class="mute" :aria-pressed="s.voiceEnabled" @click.stop="session.toggleVoice()">
        {{ s.voiceEnabled ? '🔊 語音開' : '🔇 語音關' }}
      </button>
    </div>

    <div class="corner-tr">
      <StatusIndicator :items="statusItems" />
    </div>

    <button class="corner-bl pause" @click="session.togglePause()">
      {{ paused ? '繼續' : '暫停' }}
    </button>
    <button class="corner-br stop" @click="confirming = true">結束</button>

    <ConfirmDialog v-if="confirming" @cancel="confirming = false" @confirm="$emit('finish')" />

    <DebugHud v-if="hudOn" :stats="hudStats" />
  </div>
</template>

<script setup>
import {
  ref, reactive, computed, onMounted, onBeforeUnmount,
} from 'vue'
import HpBar from './HpBar.vue'
import BossSprite from './BossSprite.vue'
import CoachBanner from './CoachBanner.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import StatusIndicator from './StatusIndicator.vue'
import DebugHud from './DebugHud.vue'
import PoseSkeletonOverlay from './PoseSkeletonOverlay.vue'
import { useSession } from '../stores/session.js'
import { createMessageQueue, PRIORITY } from '../core/messageQueue.js'
import { createPostureCoach } from '../core/postureCoach.js'
import { copyKeyForEvent } from '../core/bossDialogue.js'
import { BATTLE } from '../core/battleConfig.js'

const props = defineProps({
  // App.vue 唯一那顆真正接了 getUserMedia 的 <video>（跟 CalibrationWizard
  // 拿到的是同一顆）。這裡只讀它的 srcObject 鏡射到本地預覽用的 <video>，
  // 不持有、不搬動、不會多開一次 getUserMedia。
  videoEl: { type: Object, default: null },
})
defineEmits(['finish'])

const session = useSession()
const s = session.state
const battle = computed(() => s.battle)
const paused = computed(() => s.paused)

// Important 1（版面／可及性複審）：CoachBanner 與 App.vue 的 .health-overlay
// 用完全相同的錨點公式（top: max(gap, safe-top) + left:50% +
// translateX(-50%) + 相近的 max-width），兩者同時可見時，z-index 較高
// （6 > 4）、背景不透明的 health-overlay 會整片蓋住 CoachBanner——包括
// 陷阱撤銷鈕與倒數秒數，那是小孩對「你在滑手機」判定提出異議的唯一出口
// （見 CoachBanner.vue 的 undoRemainSec 註解）。
//
// 沒有選「重新計算兩者矩形讓它們恰好不相交」：CoachBanner 的高度隨文案
// 長度與是否有按鈕變動（flex-wrap，不是固定行數），任何手算出來的安全
// 間距都可能被下一次改文案打破，變成一個容易再度漂移的死數字（跟
// SettingsSheet.vue 拿掉的那個對不上的 max-height 死算式同一類風險——
// 「算錯的數字比沒有數字更危險」）。
//
// 改成結構性互斥：health-overlay 的顯示判準（!cameraHealthy ||
// inferenceStuck || !inferenceHealthy || loopError）跟 App.vue 用的是
// 同一個 session.state，這裡直接算一份一模一樣的條件，health-overlay
// 顯示時就不渲染 CoachBanner。兩者從此不可能同時出現在畫面上——不管螢幕
// 多大、方向是直是橫，都不會有「同時出現、誰蓋過誰」這個問題，這比證明
// 兩個矩形在四種尺寸下都不相交更穩固（那個證明只在寫的當下成立，文案或
// 按鈕數一變高度就得重算；這裡不管高度多少，兩者永遠不會同框）。
//
// 代價（誠實記錄）：陷阱撤銷倒數在裝置異常期間會被整個藏起來，不只是
// 「被蓋住看不到」。倒數本身走的是場內時間（battle.elapsedMs），不會因為
// 隱藏而暫停，所以裝置異常如果撐過整個撤銷視窗，小孩一樣救不回來——但這件
// 事在修之前也是事實（health-overlay 是 pointer-events:none，按鈕理論上
// 點得到，但看不到形同摸黑，對這個年齡層等於做不到）。這裡沒有讓情況變得
// 更差，只是把「看得到但點不到」換成「看不到也點不到」，誠實反映現況，
// 不再假裝有一條看不見的路。裝置異常本身多半只持續數秒（見
// inferenceStuck 的 30 秒判定與 F2 的自動復原路徑），跟 4 秒的訊息 TTL
// 相比仍有機會共存不撞在一起，但這是產品層級的取捨，不是版面能解決的問題。
const deviceIssueShown = computed(() => (
  !s.cameraHealthy || s.inferenceStuck || !s.inferenceHealthy || Boolean(s.loopError)
))

/**
 * 骨架線疊加層要用的推論服務。
 *
 * 用 computed 而不是在 setup 當場取一次：`session.inference()` 在 `boot()`
 * 之前是 null，而這個元件雖然今天只在 booted 之後才掛載，把「取到 null 就
 * 永遠是 null」這個靜默失敗留在這裡沒有好處（`ThresholdLab` 的 `s.booted`
 * 條件那段註解講的是同一類問題）。
 *
 * 這個元件只把它交給疊加層讀 `onPoseFrame()`，仍然不呼叫任何會改變推論
 * 生命週期或啟用狀態的方法——`BattleView.test.js` 的假 inference 只給
 * 純讀取的方法，那條結構性防線沒有因為這個功能被放寬。
 */
const inferenceSvc = computed(() => session.inference())

const SLOTS = [0, 1, 2] // 同時最多 3 個飛行特效，超過丟棄
const FLIGHT_MS = 420 // 跟 .bolt.fly 的 keyframes 動畫時長一致
const NUMBER_MS = 900 // 跟 .dmg 的 rise 動畫時長一致
const STRUCK_MS = 300 // 跟 BossSprite 的 boss-hit 動畫時長一致
// 大招最長的一條是 .ult-ring.r3（delay .18s + .6s = .78s），820 是它的上界。
// 這個常數同時決定 BossSprite 的 ultimate class 掛多久——魔王本體的
// boss-ultimate 只有 .6s，先結束沒關係（動畫結束後 class 還在不會有殘影，
// 因為那組 keyframes 的 100% 就是原狀）。
const ULTIMATE_MS = 820

const localVideo = ref(null)
const confirming = ref(false)
const coachMessage = ref(null)
const heroStruck = ref(false)
const bossStruck = ref(false)
// 魔王「出手攻擊」的一次性旗標，playerDamage 事件（姿態不良被反擊）觸發、
// FLIGHT_MS 後自動歸零——跟 flash() 是同一種「開了自己會關」的模式，但這個
// 只給魔王用，不像 heroStruck/bossStruck 兩邊共用一個 flash()，所以獨立寫，
// 不硬塞進 flash() 的 target 參數多分一個 case。
const bossAttacking = ref(false)
const numbers = ref([])
const ultimates = ref([])
const flights = reactive(SLOTS.map(() => ({ active: false, dir: 'to-boss' })))

// 魔王本體的大招姿勢跟畫面上的爆發特效是同一件事的兩個部位，所以共用同一份
// 真相（ultimates 陣列），不另外開一個 ref 自己計時——兩個計時器遲早會不同步。
const bossUltimate = computed(() => ultimates.value.length > 0)

/**
 * 分形態血條的區段資料，餵給 HpBar 的 :segments。
 *
 * 形態數量沒有上限（focusStateMachine.js 打倒一次形態就 +1、補血 40%，
 * 專注率高的小孩可以一直打下去，不是固定 3 個就結束）——所以這裡不是
 * 「畫死 3 格」，是**依 battle.phase 動態算出幾格**：已經打贏的形態
 * （1 .. phase-1）固定顯示滿格、綠色（cleared:true，那個形態的血早就見底
 * 過，用滿格＋--c-ok 標記「這格已經贏了」，比顯示成空格更看得懂——空格
 * 在畫面上很容易被誤讀成「還沒打」而不是「打贏了」），正在打的當前形態
 * （phase）即時顯示真正的比例。phase===1 時只有一段，HpBar 內部
 * `segments.length > 1` 才會切換成分段版面，退化成原本的單一血條，
 * 外觀一個像素都不變。
 *
 * 只在這裡算、不進 focusStateMachine.js：這是純視覺呈現，血量計算與
 * phase 判定邏輯完全不動（使用者原話確認的範圍）。算錯了畫面上的
 * 「80 / 100」數字仍然誠實——HpBar 的 value/max 不受這個 prop 影響，
 * 見 HpBar.vue 的 segments 檔頭註解。
 */
const bossPhaseSegments = computed(() => {
  const phase = battle.value?.phase ?? 1
  if (phase <= 1) return null
  const liveRatio = (battle.value?.bossHp ?? 0) / (battle.value?.bossHpPhaseMax ?? 1)
  const segs = []
  for (let p = 1; p < phase; p++) segs.push({ ratio: 1, cleared: true })
  segs.push({ ratio: liveRatio, cleared: false })
  return segs
})

// 這個年齡層每一種姿態異常對應的短標籤，貼在傷害數字旁邊；不是身體外觀描述，
// 是姿態行為的簡稱，跟 postureCoach.js 的 CAUSE_LABEL 講同一件事。
const TAG = { slouch: '駝背', forwardHead: '低頭', handProp: '撐頭', headTilt: '歪頭', gazeAway: '分心' }

// CopyEngine 是掛在 store 層的單例（跟 camera/inference 同一個理由）：
// resetSession() 一定要打在「將要被實際拿去 take() 的那個實例」上——如果這裡
// 自己另外 createCopyEngine()，session.js 的 copy.resetSession() 就是對空氣
// 開槍，跨場次的 shuffle bag／cooldown 不會被重置。
const copy = session.copy()
const mq = createMessageQueue()
const coach = createPostureCoach({ copy, mq })

const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

// StatusIndicator 正常時只是一個綠點＋「偵測中」，只有異常或降級才展開細節。
// 刻意只放「目前完全沒有其他 UI 反映、但小孩會直接感受到的**降級**」：效能降檔
// （perfMode）、手機偵測**被自動降檔關掉**（見下段）、語音講不出話（見下下段）。
// camera/inference 的健康度（鏡頭不見了、推論卡住）不放進來——那兩件事已經
// 有 App.vue 自己的 health-overlay（歷經好幾輪審查、有明確的「先按暫停再按
// 繼續」復原指引），這裡重複顯示只會變成兩套並存的復原路徑，對這個年齡層
// 是更混亂的畫面，不是更清楚。
//
// 語音狀態（F5，Task 22b-3 收尾）：voiceEnabled/voiceAvailable 是
// session.js 實際存在的欄位（Task 15 早就併進來了，這裡不再是待補分支）。
// 「沒有聲音」有兩種成因，但只有一種值得放進這份清單：
// - voiceEnabled === false（使用者自己按了角落的 🔇 關掉）：不算降級，是
//   他自己按的、他知道——而且這件事本來就有其他 UI 反映（那顆按鈕自己的
//   文字與 aria-pressed），不符合這份清單「目前完全沒有其他 UI 反映」的
//   收錄標準，所以不重複顯示。
// - voiceEnabled === true 但 voiceAvailable === false（裝置找不到中文
//   語音，或初始化失敗）：這才是真降級——小孩自己開了語音、預期會有聲音，
//   卻找不到任何線索知道「為什麼都沒有聲音」。這種情況才推入一項。
// 手機偵測（Task 22c，controller 裁決 2）：條件從 `!s.objectDetectorOn` 改成
// 「使用者要它開著（phoneDetectEnabled）、它卻沒在跑（!objectDetectorOn）」。
// 跟上面語音那一條是**同一條判準**，只是換了一個功能：
// - phoneDetectEnabled === false（工作人員在設定面板刻意關掉的，而且這是展場
//   的預設值）：不算降級，是他自己按的、他知道——而且那件事本來就有其他 UI
//   反映（設定面板裡那顆開關自己的文字與 aria-checked），不符合這份清單
//   「目前完全沒有其他 UI 反映」的收錄標準。
// - phoneDetectEnabled === true 但 objectDetectorOn === false：這才是真降級
//   ——工作人員要它開著，系統（自動效能降檔）把它關掉了，而這件事在畫面上
//   沒有任何其他線索。
//
// 不改的話後果不是「多一行字」：展場預設關閉手機偵測，那則提示會在**每一場
// 戰鬥全程常駐**，於是所有人都被訓練成忽略這個指示器——然後真正的降級
// （效能降檔）出現時沒有人看得到。一個永遠亮著的警示等於沒有警示。
const statusItems = computed(() => {
  const items = []
  if (s.perfMode) items.push({ id: 'perf', level: 'warn', text: '偵測速度變慢了' })
  if (s.phoneDetectEnabled && !s.objectDetectorOn) items.push({ id: 'object', level: 'warn', text: '手機偵測已暫停' })
  if (s.voiceEnabled && !s.voiceAvailable) items.push({ id: 'voice', level: 'warn', text: '語音功能無法使用' })
  return items
})

// --- Debug HUD：給工作人員／開發者看的效能面板，正式展場不該被小孩看到 ---
//
// 開啟方式選「在角落純顯示區塊（時鐘／分數，見上面 template 的 corner-tl）
// 連續點 5 下、600ms 內」，不是掛在任何按鈕上：
// - 不能是查詢參數（PWA 安裝後是獨立視窗，沒有網址列可以改；?debug=1 只在
//   本機用瀏覽器分頁開發時方便，正式展場用不到，這裡不加，避免多一個
//   「跟正式行為不一致」的隱藏分支）。
// - 5 下（不是 3 下）、視窗縮短到 600ms：小孩正常玩遊戲不會短時間內連續
//   點同一個純文字顯示區塊 5 次，暫停/結束兩顆按鈕也不在這個角落，不會
//   跟功能性操作搶點擊、也不會被誤觸打開。
// - hudOn 是元件內部的 ref，不寫進 session state：離開戰鬥畫面（BattleView
//   卸載）就自動歸零，下一輪要看還是得重新點，不會不小心整個展場的每一輪
//   都開著。
const HUD_TAP_COUNT = 5
const HUD_TAP_WINDOW_MS = 600
const hudOn = ref(false)
let hudTaps = 0
let hudTapTimer = 0
function bumpHud() {
  hudTaps += 1
  clearTimeout(hudTapTimer)
  hudTapTimer = setTimeout(() => { hudTaps = 0 }, HUD_TAP_WINDOW_MS)
  if (hudTaps >= HUD_TAP_COUNT) {
    hudOn.value = !hudOn.value
    hudTaps = 0
  }
}

// 只有 fps／health／perfStats() 需要主動輪詢（見下面 uiTimer）；perfMode／
// objectDetectorOn／posture／drowsy／latencyEma 本來就是 session.state 上的
// reactive 欄位，直接讀，不必另外輪詢一次。
const hudPolled = reactive({
  latencyP95: 0, fpsPose: 0, fpsFace: 0, fpsObject: 0, rafP95: 0, rafMax: 0, sessionSec: 0, rounds: 0,
  poseFailures: 0, poseErrorName: null, faceFailures: 0, faceErrorName: null, objectFailures: 0, objectErrorName: null,
  // 初始值 true：戰鬥一開始 startBattle() 早就 await 過 wakeLock.request()，
  // 掛載時就已經是穩定狀態，不像 fps 那樣需要暖機——寫 false 只是一句還沒被
  // 驗證過的悲觀宣告，第一次 pollHud() 之前的畫面會誤報「螢幕鎖定中」。
  wakeLockActive: true,
})
// 明確列舉每一個欄位，不用 `...hudPolled` 展開——跟 DebugHud.vue／
// inferenceService.js 的 health() 同一條紅線：這裡是組裝 DebugHud 的
// stats prop 的唯一地方，展開的話，日後有人在 hudPolled 上多塞一個
// 除錯欄位，會在這裡被無條件轉送出去而不會有人注意到。
const hudStats = computed(() => ({
  latencyEma: s.latencyEma,
  latencyP95: hudPolled.latencyP95,
  fpsPose: hudPolled.fpsPose,
  fpsFace: hudPolled.fpsFace,
  fpsObject: hudPolled.fpsObject,
  rafP95: hudPolled.rafP95,
  rafMax: hudPolled.rafMax,
  sessionSec: hudPolled.sessionSec,
  rounds: hudPolled.rounds,
  perfMode: s.perfMode,
  objectOn: s.objectDetectorOn,
  poseFailures: hudPolled.poseFailures,
  poseErrorName: hudPolled.poseErrorName,
  faceFailures: hudPolled.faceFailures,
  faceErrorName: hudPolled.faceErrorName,
  objectFailures: hudPolled.objectFailures,
  objectErrorName: hudPolled.objectErrorName,
  wakeLockActive: hudPolled.wakeLockActive,
  posture: s.posture,
  drowsy: s.drowsy,
}))

let numberSeq = 0
let ultimateSeq = 0
let uiTimer = 0
let offEvents = null

const hasPendingTrap = computed(() => (battle.value?.pendingTraps?.length ?? 0) > 0)

// 撤銷是「我沒有在摸魚」的唯一出口，不能藏起來——要讓人看得到還剩多久。
// 用「這個訊息本來就是哪個 trapId 觸發的」對回 pendingTraps 裡對應那筆的
// deadlineAtElapsed，不是自己另外起一個計時器（跟撤銷視窗本身用場內時間
// 記帳、暫停會自動凍結是同一個時間基底，不會有第二套算法飄掉）。
const undoRemainSec = computed(() => {
  const msg = coachMessage.value
  if (!msg?.trapId || !battle.value) return null
  const trap = battle.value.pendingTraps.find((t) => t.trapId === msg.trapId)
  if (!trap) return null
  return Math.max(0, Math.ceil((trap.deadlineAtElapsed - battle.value.elapsedMs) / 1000))
})

const clockText = computed(() => {
  const b = battle.value
  if (!b) return '00:00'
  const left = Math.max(0, b.durationMs - b.elapsedMs)
  const m = String(Math.floor(left / 60_000)).padStart(2, '0')
  const sec = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')
  return `${m}:${sec}`
})

// 無條件進位：顯示 0 秒卻還沒解除會讓人以為壞了。跟 regroupText 同一個作法。
const debuffFocusRemainSec = computed(() => Math.ceil((battle.value?.debuffFocusRemainMs ?? 0) / 1000))
const regroupText = computed(() => '調整一下姿勢，馬上回來')

/**
 * 英雄側那一格常駐提示：兩句互斥的話，優先序在這裡定案（Blocking B2／B3）。
 *
 * 1. **攻擊被「畫面上有東西」封鎖**時，一律優先講這件事。
 *    理由是誠實：被封鎖的那段時間裡，debuff 的專注累積器根本不會前進
 *    （解除條件含 `!objectBlocking`），所以「再專心 N 秒」那個數字一秒都
 *    不會動，而小孩明明正坐得筆直——那是一句做不到的承諾。這一句改成指向
 *    真正的障礙，而且是他做得到的動作。
 * 2. 否則，中了 debuff 就顯示「再專心 N 秒」（原本的行為）。
 * 3. 都沒有就不顯示。
 *
 * 這一格沒有 TTL，跟狀態同生共死——它要修的正是「t=23s 卡片過期之後，
 * 魔王仍然不掉血而畫面上再也沒有任何字」那個靜默失效。
 *
 * 兩句話都 ≤15 字、都指向動作、都不描述這個人（copyGuardrail 的規則 A）。
 */
const heroHint = computed(() => {
  const b = battle.value
  if (!b) return ''
  if (b.objectBlocking) return '把東西移開就能打'
  if (b.debuffed) return `再專心 ${debuffFocusRemainSec.value} 秒`
  return ''
})

/** 飛行特效：節點常駐，只切 class；找不到空位就丟棄（同時最多 3 個） */
function launch(dir) {
  if (reduced) return
  const slot = flights.findIndex((f) => !f.active)
  if (slot === -1) return
  flights[slot].dir = dir
  flights[slot].active = true
  setTimeout(() => { flights[slot].active = false }, FLIGHT_MS)
}

function popNumber(text, side, tag = '') {
  const id = ++numberSeq
  numbers.value.push({ id, text, side, tag })
  setTimeout(() => { numbers.value = numbers.value.filter((n) => n.id !== id) }, NUMBER_MS)
}

/**
 * 魔王大招（陷阱生效）。
 *
 * 為什麼需要它：陷阱有 20 秒待確認期，期間刻意不扣分、不回血、不中斷連擊、
 * 也不發聲（spec 第 180 行），畫面上只有 BossSprite 的 .charging 在跑。
 * 20 秒的鋪陳如果只換來跟「姿態不良被反擊」一模一樣的一發 .bolt 加兩個
 * 數字，那段緊張感是沒有出口的。
 *
 * 跟 launch()／flash() 不同，這裡**不**在 reduced-motion 時直接 return：
 * 這一刻使用者剛被扣 100 積分，畫面必須說清楚發生了什麼。reduced 模式下
 * 同一組節點會改成靜態呈現（見 <style> 裡的 reduce 區塊），不是消失。
 */
function fireUltimate() {
  const id = ++ultimateSeq
  ultimates.value.push({ id })
  setTimeout(() => { ultimates.value = ultimates.value.filter((u) => u.id !== id) }, ULTIMATE_MS)
}

function flash(target) {
  const flag = target === 'hero' ? heroStruck : bossStruck
  flag.value = true
  setTimeout(() => { flag.value = false }, STRUCK_MS)
}

/**
 * 魔王出手攻擊（playerDamage 事件＝姿態不良被反擊）的魔王本體動畫。
 *
 * 時長直接沿用 FLIGHT_MS（跟 .bolt.to-hero 的飛行時間同一個常數），不另外
 * 訂一個「剛好差不多」的數字：魔王的撲擊動作要跟光球離開他身體的瞬間對上，
 * 兩個時間各自漂移遲早會看起來像兩個不相關的特效疊在一起。
 */
function fireAttack() {
  bossAttacking.value = true
  setTimeout(() => { bossAttacking.value = false }, FLIGHT_MS)
}

// 同一則訊息（用 shownAt 識別，見 messageQueue.js）只念一次：refreshCoachMessage
// 同時被 uiTimer（每 250ms）跟 onEvents()（每次事件進來）呼叫，沒有這個記號
// 同一句話會被念好幾遍。
let spokenAt = null

/**
 * 這是全 BattleView 唯一一處決定「要不要念」的地方，而且判斷只看
 * `m.voice`——那個布林值已經是 messageQueue.publish() 仲裁過的最終結果
 * （分心類提示會被無條件覆寫成 false，見 messageQueue.js 檔頭註解）。
 * 這裡不看 m.kind、m.ns、m.text 內容或任何其他欄位重新判斷一次：boss 台詞
 * （sayBoss → mq.publish）跟姿態/安全提示（postureCoach → mq.publish）共用
 * 同一個 mq 實例，兩者的 voice 資格早就在各自發布時由同一顆仲裁者算好，
 * 這裡只負責原樣轉交給 voiceFeedback，不能有第二套「該不該念」的邏輯。
 */
function speakIfNeeded(m) {
  if (!m || !m.voice || m.shownAt === spokenAt) return
  spokenAt = m.shownAt
  session.voice().speak(m.text, m.priority)
}

function refreshCoachMessage(now) {
  const m = mq.current(now)
  coachMessage.value = m
  speakIfNeeded(m)
}

/**
 * 魔王台詞一定要走 messageQueue.publish()，帶 ns/key：
 * publish() 對 voice:true 卻沒帶 ns/key 的訊息會直接 throw（見 messageQueue.js），
 * 這是刻意的——語音播報必須可被靜音清單（NO_VOICE_BOSS_KEYS）攔截，而攔截
 * 的判斷只能發生在唯一的仲裁者身上，不能讓這裡自己另外判斷一次要不要念
 * （那會變成第二套真相）。
 *
 * 這裡一律傳 `voice: true`（Task 15 複審第 1 輪拿掉了 copyKeyForEvent 自己
 * 算的那份「方便值」）：是不是真的能朗讀，全權交給 messageQueue 內部的
 * NO_VOICE 表決定，這裡不重複判斷、也不能靠這裡的判斷結果繞過仲裁者。
 */
function sayBoss(event, now) {
  const key = copyKeyForEvent(event)
  if (!key) return
  const line = copy.take(key.ns, key.key, {}, now)
  if (!line) return
  mq.publish({
    kind: 'battle', priority: PRIORITY.battle, text: line.text,
    ttlMs: 3500, voice: true, ns: key.ns, key: key.key,
  }, now)
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
        sayBoss(e, now)
        break
      case 'playerDamage':
        // 姿態不良 → 魔王反擊飛回來
        launch('to-hero')
        flash('hero')
        fireAttack()
        popNumber(`−${e.amount}`, 'hero', TAG[e.reason] ?? '')
        break
      case 'trapCommitted':
        // 大招先於飛行特效與閃紅框：三者是同一發攻擊的三個部位（爆發、
        // 飛過來的那一發、打到你），不是三種不同的回饋。.bolt 與閃紅框
        // 保留，它們負責「打到的是你」這件事；新增的 fireUltimate() 才是
        // 「這次不一樣」——沒有它的話，陷阱生效跟姿態不良被反擊在畫面上
        // 完全一樣，只多兩個數字。
        fireUltimate()
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

  refreshCoachMessage(now)
}

function onUndo(trapId) {
  session.undoTrap(trapId)
  mq.clear()
  coachMessage.value = null
}

/**
 * 「休息一下」：進到獨立的休息回合畫面（Task 20 的 BreakScreen）。
 *
 * 這裡原本是「借用既有的暫停機制（session.togglePause()）」，理由寫的是
 * 「這個 App 沒有獨立的休息畫面」——那個前提在 Task 20 之後不成立了，所以
 * 那段註解與那行程式一起改掉：留著會變成兩條路做同一件事，而且做得不一樣
 * （一條只是暫停在戰鬥畫面上，一條有倒數、有伸展建議）。
 *
 * 仍然不直接寫 state.screen（那條線只准 setScreen() 動，session.js 的
 * enterBreak() 會走它），也**不再**在這裡判斷 s.paused：enterBreak() 內部
 * 自己決定要不要先暫停這一場（已經暫停中就不再 toggle，那會變成「按休息
 * 反而繼續」）。在這裡重複判斷一次就是下一個「兩套真相」。
 */
function onBreak() {
  session.enterBreak()
}

/** 把共用 <video> 目前的 stream 鏡射到本地預覽節點；重複指派同一個物件會讓
 *  瀏覽器重跑一次 media load algorithm、畫面閃一下，所以先比較再指派。 */
function attachPreview() {
  const stream = props.videoEl?.srcObject ?? null
  if (localVideo.value && localVideo.value.srcObject !== stream) {
    localVideo.value.srcObject = stream
    // Promise.resolve() 包一層：jsdom 的 play() 回傳 undefined（不是 Promise），
    // 真實瀏覽器才回傳 Promise——兩種情況都要安全吞掉「被中斷的 play()」。
    Promise.resolve(localVideo.value.play?.()).catch(() => { /* 被中斷的 play() 不算失敗 */ })
  }
}

/**
 * HUD 關著時完全不做這些查詢——量測本身不能變成效能問題（Task 16 要求）。
 * `actualFps()`/`health()` 都是純讀取（不影響 track 的排程或狀態），跟
 * onBeforeUnmount 那條「不可以碰 inference/camera」的紅線是不同的問題：
 * 那條紅線防的是「元件去改變 inference 的生命週期或啟用狀態」，這裡只是
 * 讀幾個已經算好的數字，跟 App.vue 讀 session.inference() 傳給
 * CalibrationWizard 顯示鏡子畫面是同一類、既有的用法。
 */
function pollHud() {
  if (!hudOn.value) return
  const now = performance.now()
  const inf = session.inference()
  hudPolled.fpsPose = inf.actualFps('pose', now)
  hudPolled.fpsFace = inf.actualFps('face', now)
  hudPolled.fpsObject = inf.actualFps('object', now)
  const health = inf.health()
  hudPolled.poseFailures = health.pose.consecutiveFailures
  hudPolled.poseErrorName = health.pose.lastErrorName
  hudPolled.faceFailures = health.face.consecutiveFailures
  hudPolled.faceErrorName = health.face.lastErrorName
  hudPolled.objectFailures = health.object.consecutiveFailures
  hudPolled.objectErrorName = health.object.lastErrorName
  // 純讀取，跟上面幾行同一類。理由見 session.js 的 wakeLockActive() 說明——
  // 這個 App 唯一會讀它的地方。
  hudPolled.wakeLockActive = session.wakeLockActive()
  const ps = session.perfStats()
  hudPolled.latencyP95 = ps.latencyP95
  hudPolled.rafP95 = ps.rafP95
  hudPolled.rafMax = ps.rafMax
  hudPolled.rounds = ps.rounds
  hudPolled.sessionSec = (battle.value?.elapsedMs ?? 0) / 1000
}

onMounted(() => {
  attachPreview()
  offEvents = session.onBattleEvent(onEvents)
  // 訊息過期／鏡頭 stream 是否已就緒都需要輪詢；4Hz 符合「閒置時每秒重繪 < 5 次」。
  uiTimer = setInterval(() => {
    attachPreview()
    refreshCoachMessage(performance.now())
    pollHud()
  }, 250)
})

onBeforeUnmount(() => {
  offEvents?.()
  clearInterval(uiTimer)
  clearTimeout(hudTapTimer)
  // 注意：這裡刻意不碰 inference／camera——它們的生命週期掛在 App／store 層，
  // 跨輪重複使用，離開戰鬥畫面不代表這一輪的裝置資源該被收回。
})
</script>

<style scoped>
/* --- 英雄側：常駐鏡頭畫面 --- */
.cam {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  transform: scaleX(-1); /* 只鏡像顯示，不影響送進 MediaPipe 的原始影像（那條走 App.vue 的隱藏 video） */
  pointer-events: none;
}
.arena__hero { border: 4px solid transparent; transition: border-color .15s; }
.arena__hero.struck { border-color: var(--c-danger); }

/* 重整旗鼓的灰階是全檔唯一的 filter，且是靜態值切換（class 開關），不做 transition/動畫 */
.arena.regrouping .cam { filter: grayscale(1) brightness(.6); }
.regroup {
  position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
  font-size: var(--fs-title); font-weight: 700; margin: 0; z-index: 1;
  /* Minor（版面／可及性複審）：這段文字疊在即時鏡頭畫面上（雖然套了
     grayscale+brightness(.6) 讓畫面變暗變灰），背景是小孩的衣服、皮膚、
     房間背景，色值不可預測，對比度結構上無法用 token 數學驗證。加一圈
     深色陰影當底襯，成本很低，能在任意背景下維持基本可讀性——這不是
     「證明過對比度達標」，只是不讓可讀性完全交給運氣，真正的驗證仍在
     文末「必須真機確認」清單裡。 */
  text-shadow: 0 1px 3px rgba(0, 0, 0, .85), 0 0 6px rgba(0, 0, 0, .6);
}
.regroup span { font-size: var(--fs-body); font-weight: 400; color: var(--c-text-dim); }

/* 放在 .hero-hud 上方、與 .regroup 同一區，兩者互斥（見 template 的 v-if）。
   用 --c-warn 而不是危險色：它是一個待辦事項，不是一個警報。 */
.debuff {
  position: absolute; left: var(--gap); right: var(--gap); z-index: 3;
  bottom: calc(var(--tap-primary) + var(--gap) * 2 + var(--fs-title) + var(--gap));
  margin: 0; text-align: center;
  font-size: var(--fs-body); color: var(--c-warn);
}
.hero-hud, .boss-hud {
  position: absolute; left: var(--gap); right: var(--gap); z-index: 3;
}
.hero-hud { bottom: calc(var(--tap-primary) + var(--gap) * 2); }
/* Important 2（版面／可及性複審）：橫向時 .corner-tr（StatusIndicator 展開
   清單）跟 .boss-hud 過去都是 z-index 3，DOM 順序讓 corner-tr 疊在上面。
   固定 px 運算得出的結論，不隨裝置尺寸改變：

   boss-hud 的 top（橫向）= var(--fs-coach) * 2.4 = 36 * 2.4 = 86.4px
   （橫向時 arena__boss 佔滿全高，這個值換算到全螢幕座標也是 y≈86.4）。
   corner-tr 展開列表（worst !== 'ok' 時自動展開，不需要手動點開）高度
   估算：dot-row(44) + margin-top(8) + list padding(20) + 最多 3 個項目
   × 24px + 間距(10×2) ≈ 164px，從 y=16 延伸到 y≈180——涵蓋了 boss-hud
   的 y=86.4 起點；水平方向 boss-hud 的 left/right:gap 幾乎橫跨整個
   arena__boss（含 corner-tr 所在的右上角），兩者矩形必然相交。
   觸發條件（效能降檔／手機偵測被自動關掉／語音不可用任一為真）是展場
   最常見的降級情境本身就會觸發，不是邊界情況。

   魔王血量是這個遊戲的核心回饋，不能被蓋——修法是讓 .boss-hud 的
   z-index 明確高於 .corner-tr（4 > 3，corner-tr 的 3 定義在
   src/styles/layout.css），不再依賴 DOM 順序這種下一次重排模板就可能
   翻盤的隱性規則。不管 corner-tr 展開列表多長、視窗多寬多高，boss-hud
   永遠畫在最上層——這比重新計算兩者矩形更穩固（那個證明只在寫的當下
   成立，項目數一多文案一長就要重算）。
   只影響 boss-hud 與同層級的 hero-hud／corner-tl/tr/bl/br 之間的疊放：
   查過这份 z-index 堆疊表，boss-hud 跟其餘四個角落當中只有 corner-tr
   會空間重疊（hero-hud/corner-tl/bl/br 在兩個方向下都跟 boss-hud 的
   矩形不相交），所以拉高這一個選擇器的 z-index 不會意外蓋住其他東西。 */
.boss-hud { top: calc(var(--fs-coach) * 2.4); z-index: 4; }
@media (orientation: portrait) { .boss-hud { top: var(--gap); } }

/* --- 魔王側：場景層 ---
   場景是背景，不是內容：pointer-events:none、z-index 0（畫面最底），
   全部靜態（零動畫成本，主執行緒還要跑 MediaPipe 推論，見 BossSprite.vue
   檔頭那段效能紅線）。顏色只用既有 token 加低不透明度，不發明色碼。

   ── 手算的矩形關係（這個專案所有版面判斷都是算出來的）──────────────
   單位 CSS px。四種目標情境：
     A 11" 直 834×1194   B 11" 橫 1194×834
     C 12.9" 直 1024×1366 D 12.9" 橫 1366×1024
   角落偏移取 max(--gap, safe-area) 的最壞值 24（iPad standalone 的
   home indicator inset 實測 ~20~21，取 24 當上界；偏移愈大愈往畫面中央
   壓，所以最壞值才是要驗的那個）。

   魔王 sprite 的矩形（BossSprite 的 width = clamp(140px, 30vmin, 280px)，
   aspect-ratio 1:1，在 .arena__boss 的 flex 置中）：
     A 邊長 250.2，boss 區 y∈[597,1194] x∈[0,834]   → x∈[291.9,542.1] y∈[770.4,1020.6]
     B 邊長 250.2，boss 區 x∈[597,1194] y∈[0,834]   → x∈[770.4,1020.6] y∈[291.9,542.1]
     C 邊長 280，  boss 區 y∈[683,1366] x∈[0,1024]  → x∈[372,652]     y∈[884.5,1164.5]
     D 邊長 280，  boss 區 x∈[683,1366] y∈[0,1024]  → x∈[884.5,1164.5] y∈[372,652]

   要證明不相交的五個既有可互動／關鍵元素（高度取上界，寧可算大）：
   1) CoachBanner（含撤銷鈕，小孩對誤判提出異議的唯一出口）
      y∈[24, 184]（top 24 + 高度上界 160：36px 文字 1.3 行高 + 12/20 padding
      + wrap 之後多一列 60px 的按鈕）。
      四種情境 sprite 的 y 下緣最小值是 291.9（B）→ y 軸分離，餘裕 107.9。
   2) .corner-tr（StatusIndicator 展開清單）
      y∈[24, 188]（高度 164 沿用本檔 Important 2 那段已經算過的值）。
      同樣對 sprite 的 y 下緣 291.9 → y 軸分離，餘裕 103.9。**這是所有
      「只靠單一軸分離」的配對裡最小的一個餘裕。**
   3) .corner-tl（時鐘/分數/靜音鈕）y∈[24,154]、x∈[24,184]
      → A/C 靠 x 分離（291.9−184=107.9、372−184=188），B/D 靠 x 分離
      （770.4−184、884.5−184），y 也同時分離。兩軸皆分離。
   4) .corner-bl（暫停）y∈[H−84, H−24]、x∈[24,144]
      A y∈[1110,1170] vs sprite y 上界 1020.6 → 89.4；x 也差 147.9
      B y∈[750,810]  vs 542.1 → 207.9；x 差 626.4
      C y∈[1282,1342] vs 1164.5 → 117.5   D y∈[940,1000] vs 652 → 288
      四種都兩軸皆分離。
   5) .corner-br（結束）y 同上、x∈[W−144, W−24]
      A x∈[690,810] vs sprite x 上界 542.1 → 147.9（y 也差 89.4）
      B x∈[1050,1170] vs 1020.6 → 29.4（y 差 207.9，兩軸皆分離）
      C x∈[880,1000] vs 652 → 228   D x∈[1222,1342] vs 1164.5 → 57.5
   6) .boss-hud（魔王血條，遊戲核心回饋）
      橫式 top = --fs-coach*2.4 = 86.4，直式 top = boss 區頂 + --gap。
      高度上界 70（HpBar：17px label 行高 ~20.4 + margin 4 + track 18 ≈ 42.4，
      再加「第 N 形態」那一行 6+20.4 ≈ 26.4，合計 68.8 → 取 70）。
      B/D y∈[86.4,156.4] vs sprite y 下緣 291.9 / 372 → 135.5 / 215.6
      A   y∈[613,683]   vs 770.4 → 87.4
      C   y∈[699,769]   vs 884.5 → 115.5
      四種都 y 軸分離。
   結論：魔王本體在四種情境下與上述六個矩形全部不相交，最小餘裕 29.4px
   （B 的結束鈕，而且那一組另外還有 207.9px 的 y 軸分離），只靠單軸分離的
   配對最小餘裕 103.9px。

   場景層（.arena__scene）就不是這樣了，誠實寫明：它 inset:0 鋪滿整個
   .arena__boss，**確實**會跟 .boss-hud、橫式的 corner-tr/br、直式的
   corner-bl/br 在幾何上重疊。它不構成遮擋的理由不是幾何，是結構：
   z-index 0 低於戰場帶(2)、四個角落(3)、boss-hud(4)，且 pointer-events:none
   ——不吃任何觸控、永遠畫在最底層。這個保證比手算穩固（不隨文案長度、
   項目數、螢幕尺寸改變），BattleView.test.js 有一條護欄鎖住它。
   代價是視覺對比：所以場景的填色一律是既有 token 的低不透明度疊色，
   維持在接近 --c-bg 的亮度，不讓角落按鈕的文字失去底襯。 */
.arena__scene {
  position: absolute; inset: 0; z-index: 0;
  pointer-events: none;
}
.scene-svg { display: block; width: 100%; height: 100%; }
.scene-ridge-near { fill: var(--c-surface); opacity: .85; }
.scene-ridge-far { fill: var(--c-surface); opacity: .45; }
.scene-moon { fill: var(--c-text); opacity: .07; }
.scene-spark { fill: var(--c-text); opacity: .18; }

/* 第二（含以上）形態：場景跟著換，不是只有魔王自己換臉——月亮從既有的
   淡白（--c-text，.07）換成 --c-danger（血月），山稜線加深，都是靜態的
   一次性換色（phase 改變時才觸發一次重繪），不是動畫，不受效能紅線約束、
   也不需要 reduced-motion 分支。沒有新色碼：血月用的還是既有的
   --c-danger token。 */
.arena__scene.phase2 .scene-moon { fill: var(--c-danger); opacity: .22; }
.arena__scene.phase2 .scene-ridge-near { opacity: .95; }
.arena__scene.phase2 .scene-ridge-far { opacity: .6; }

.phase { text-align: center; font-size: var(--fs-body); color: var(--c-boss); margin: 6px 0 0; }

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
/* 原本魔王是一個 emoji，被打是 shake、蓄力是 charge 兩組 keyframes 掛在
   .boss-body 上。造型改成 BossSprite.vue 之後這兩組沒有任何選擇器再用到，
   一併刪掉——留著的死 keyframes 會讓下一個人以為魔王還有兩套動畫。 */

/* --- 魔王大招（陷阱生效）---------------------------------------------------

   ── 份量感從哪裡來（只有 transform 與 opacity 可用）────────────────────
   不能用 blur、光暈、陰影動畫、大面積漸層重繪——那些是最貴的東西，會推高
   推論延遲，觸發 perfMonitor 那個**單向且不可升回**的降檔。三個替代手法：

   1) **尺度變化**：衝擊環從 16vmin 撐到 2.75 倍（44vmin 直徑），是全畫面
      所有動畫裡最大的位移量級。大 = 有份量，而 scale 在合成器上是免費的。
   2) **錯位時序**：三個環的 delay 差 90ms、尖刺再差 50ms、魔王本體先往後
      縮 0.86 再撲到 1.3。同一個瞬間看起來「層層疊上來」，靠的是時間錯開，
      不是同時間畫更多東西。這是最有效、也最便宜的一招。
   3) **少量高對比元素**：只有 10 個節點（1 片底色 + 3 個環 + 6 根尖刺），
      全部是實色的既有 token（--c-boss / --c-warn），沒有一個是半透明漸層。
      少而清楚，比多而糊更有衝擊力，也剛好是最省的畫法。

   成本自我檢查：同時最多 10 個合成層、每層只動 transform/opacity、
   最長 0.78 秒、一場戰鬥最多發生幾次（陷阱本身就很稀有）。沒有任何一格
   會觸發 layout 或 paint——BossSprite.test.js 的 @keyframes 白名單護欄
   對這個檔案一起生效，掃得到這裡新增的三組 keyframes。

   ── 手算的矩形關係 ────────────────────────────────────────────────
   .ult 掛在 .arena__field 裡（inset:0、pointer-events:none、z-index 2）。
   z-index 2 低於四個角落(3)與 .boss-hud(4)，所以暫停／結束兩顆按鈕與兩條
   血條**結構上**不可能被蓋住——它們畫在大招上面。這比幾何論證穩固。

   幾何上仍要算，因為「沒被蓋住」跟「不會擋到視線」是兩件事。爆發中心
   固定在魔王側的正中心（橫式 left:75% top:50%，直式 left:50% top:75%），
   最大半徑 = 8vmin × 2.75 = 22vmin（環）與 15 + 3.5×1.5 = 20.25vmin（尖刺），
   取 22vmin。四種情境（角落偏移一律取最壞值 24）：
     A 11" 直 834×1194：中心(417, 895.5)，22vmin = 183.5
       → 上緣 712.0 vs .boss-hud 下緣 683 → 餘裕 29.0
       → 下緣 1079.0 vs corner-bl/br 上緣 1110 → 餘裕 31.0
     B 11" 橫 1194×834：中心(895.5, 417)，183.5
       → 上緣 233.5 vs corner-tr 下緣 188 → 餘裕 45.5
       → 下緣 600.5 vs corner-br 上緣 750 → 餘裕 149.5
     C 12.9" 直 1024×1366：中心(512, 1024.5)，22vmin = 225.3
       → 上緣 799.2 vs .boss-hud 下緣 769 → 餘裕 30.2
       → 下緣 1249.8 vs corner 上緣 1282 → 餘裕 32.2
     D 12.9" 橫 1366×1024：中心(1024.5, 512)，225.3
       → 上緣 286.7 vs corner-tr 下緣 188 → 餘裕 98.7
       → 下緣 737.3 vs corner-br 上緣 940 → 餘裕 202.7
   四種情境全部不相交，最小餘裕 29.0px。22vmin 這個上界就是這樣反推出來的
   （12.9" 直式最緊：中心到 .boss-hud 下緣只有 255.5px = 24.95vmin，
   所以環的最大半徑不能超過 24.95vmin，取 22vmin 留 3vmin 安全邊界）。

   .ult-flash 是唯一鋪滿全螢幕的一層，但它只動 opacity（峰值 .42 的實色
   --c-boss），在 z-index 2、pointer-events:none 的層裡，蓋不住任何東西，
   也吃不到任何觸控。 */
.ult { position: absolute; inset: 0; }

/* 姿態邊緣提示（使用者要求，模板裡的完整推導見 .posture-vignette 上方的
   HTML 註解）。跟 .ult-flash 是同一類「鋪滿全螢幕、只動 opacity」的層，
   z-index 也刻意選一樣的 2——理由完全相同：低於四個角落(3)與 .boss-hud(4)，
   結構上不可能蓋住任何可互動元素或關鍵讀數，不需要重算一次矩形，套用
   .ult-flash 已經證明過的那個結論。

   跟 .ult-flash 不同的地方：這裡用**靜態**的 radial-gradient 當背景圖
   （只算一次、不隨時間變化的圖案），只切換 `show` 這個 class 來過渡
   opacity。這比 .ult-flash 的 keyframe 動畫更便宜——沒有動畫執行緒持續
   跑計時器，合成器只在 class 真的切換的那一刻才需要工作，姿態沒有變化的
   99% 時間裡這一層完全不耗費任何資源。

   中心留白（55% 內完全透明）：邊緣提示要看得到、又不能擋住畫面中央的
   即時鏡頭、傷害數字、大招——這個矩形關係不需要算，因為中央本來就是
   完全透明的，數學上不可能遮蔽任何東西，只有畫面四周會被染色。 */
.posture-vignette {
  position: absolute; inset: 0; z-index: 2; pointer-events: none;
  background: radial-gradient(ellipse at center, transparent 55%, var(--c-danger) 145%);
  opacity: 0;
  transition: opacity .4s ease;
}
.posture-vignette.show { opacity: .38; }
.ult-flash {
  position: absolute; inset: 0; background: var(--c-boss);
  opacity: 0; will-change: opacity;
  animation: ult-flash .42s ease-out forwards;
}
@keyframes ult-flash {
  0%   { opacity: 0; }
  8%   { opacity: .42; }
  100% { opacity: 0; }
}

/* 爆發中心＝魔王側的正中心。方向由 orientation 決定，跟 layout.css 的
   --attack-dx/--attack-dy 同一個作法；下面那組基底值是 fallback。 */
.ult-core { position: absolute; left: 75%; top: 50%; }
@media (orientation: landscape) { .ult-core { left: 75%; top: 50%; } }
@media (orientation: portrait) { .ult-core { left: 50%; top: 75%; } }

.ult-ring {
  position: absolute; left: 0; top: 0;
  width: 16vmin; height: 16vmin; margin: -8vmin 0 0 -8vmin;
  border-radius: 50%; border: .9vmin solid var(--c-boss);
  opacity: 0; will-change: transform, opacity;
  animation: ult-ring .55s ease-out forwards;
}
.ult-ring.r2 { border-color: var(--c-warn); animation-delay: .09s; }
.ult-ring.r3 { animation-duration: .6s; animation-delay: .18s; }
@keyframes ult-ring {
  0%   { opacity: 0; transform: scale(.25); }
  12%  { opacity: .95; }
  100% { opacity: 0; transform: scale(2.75); }
}

/* 六根尖刺：先 rotate 到自己的角度，再沿著轉過的軸往外 translate，
   所以是放射狀的。角度用 CSS 變數，六條規則只差一個數字。 */
.ult-spike {
  position: absolute; left: 0; top: 0;
  width: 1.6vmin; height: 7vmin; margin: -3.5vmin 0 0 -.8vmin;
  border-radius: 999px; background: var(--c-warn);
  opacity: 0; will-change: transform, opacity;
  animation: ult-spike .52s ease-out .05s forwards;
  --ang: 0deg;
}
.ult-spike.s2 { --ang: 60deg; }
.ult-spike.s3 { --ang: 120deg; }
.ult-spike.s4 { --ang: 180deg; }
.ult-spike.s5 { --ang: 240deg; }
.ult-spike.s6 { --ang: 300deg; }
@keyframes ult-spike {
  0%   { opacity: 0; transform: rotate(var(--ang)) translateY(-2vmin) scaleY(.4); }
  18%  { opacity: 1; }
  100% { opacity: 0; transform: rotate(var(--ang)) translateY(-15vmin) scaleY(1.5); }
}

/* --- 傷害數字 --- */
.dmg {
  position: absolute; margin: 0; font-size: 40px; font-weight: 800;
  font-variant-numeric: tabular-nums; animation: rise .9s ease-out forwards;
  will-change: transform, opacity;
  /* Minor（版面／可及性複審）：跟 .regroup 同一個理由——這是唯一沒有實色
     背景襯底的關鍵戰況文字（HpBar 的數字有 .track 的 --c-surface 當底，
     這裡直接疊在使用者自己的鏡頭畫面上，背景色不可預測）。加陰影是結構上
     能做到的最低成本改善，不是對比度已驗證的宣告。 */
  text-shadow: 0 1px 3px rgba(0, 0, 0, .85), 0 0 6px rgba(0, 0, 0, .6);
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
.mute { min-height: var(--tap-min); padding: 0 12px; font-size: var(--fs-body); }
.pause, .stop {
  min-width: var(--tap-primary); min-height: var(--tap-primary); padding: 0 20px;
  touch-action: manipulation;
}
.stop { background: transparent; outline: 2px solid var(--c-text-dim); }

/* reduced-motion：不做位移，改用已經在做的 struck 閃紅框，傷害數字仍看得到。
   大招不能整個消失（那一刻使用者剛被扣 100 積分，畫面必須說清楚發生了什麼）
   ——改成**靜態**呈現：底色停在一個固定的淡色、衝擊環停在原始尺寸不擴張、
   尖刺停在原位。節點在 ULTIMATE_MS 內出現再消失，只有兩次離散變化，
   沒有任何持續運動。 */
@media (prefers-reduced-motion: reduce) {
  .bolt { display: none; }
  .dmg { animation: none; opacity: 1; }
  .ult-flash { animation: none; opacity: .28; }
  .ult-ring { animation: none; opacity: .9; }
  .ult-spike { animation: none; opacity: .9; transform: rotate(var(--ang)) translateY(-9vmin); }
  /* 姿態邊緣提示：不做淡入淡出，直接切換到終值——同一個原則，拿掉「動」、
     保留「看得到結果」。opacity 從 0 到 .38 瞬間跳過去仍是一次離散變化，
     不是持續運動。 */
  .posture-vignette { transition: none; }
}
</style>
