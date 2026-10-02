// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { createApp, reactive, nextTick } from 'vue'
import battleViewSource from './BattleView.vue?raw'
import { BATTLE } from '../core/battleConfig.js'
// 這個年齡層的產品文案紅線：單句 ≤15 字、不得出現對人格／外觀的負面描述。
// Task 22a：這份清單原本在四個測試檔裡各自獨立宣告（且互相不同步——這裡
// 原本只有 4 個詞，copyEngine.test.js 有 7 個），現在收斂成一份匯出常數，
// 全部改成 import 同一份，見 src/core/copyGuardrail.js。
import { BANNED_WORDS, blankPureCommentLines, stripHtmlCommentSpans } from '../core/copyGuardrail.js'

function makeBattle(overrides = {}) {
  return {
    elapsedMs: 0,
    durationMs: 900_000,
    bossHp: 200,
    bossHpMax: 500, // 刻意跟 bossHpPhaseMax 不同，用來驗證元件真的讀 phaseMax
    bossHpPhaseMax: 200,
    playerHp: 100,
    score: 0,
    attacks: 0,
    streak: 0,
    phase: 1,
    phase2Damage: 0,
    regrouping: false,
    ended: false,
    result: null,
    pendingTraps: [],
    postureDurationMs: {},
    distractionDurationMs: {},
    trapCount: {},
    dpsSeries: [],
    ...overrides,
  }
}

const fakeState = reactive({
  screen: 'battle',
  battle: makeBattle(),
  posture: 'upright',
  drowsy: false,
  paused: false,
  // Task 16：預設值必須跟 session.js 的初始 state 一致（perfMode:false，
  // objectDetectorOn:true）——不然這裡的 fixture 少了欄位會讓 `!undefined`
  // 恆真，把每一條既有測試都平白多套一個「手機偵測已暫停」的假警示。
  perfMode: false,
  objectDetectorOn: true,
  // Task 22c：展場預設關閉手機偵測，所以 session.js 的初始值是 false；這裡
  // 跟著一致（理由同上一段：fixture 少了欄位會讓判斷式讀到 undefined，把
  // 每一條既有測試都平白多套／少套一則警示）。
  phoneDetectEnabled: false,
  latencyEma: 0,
  voiceEnabled: false,
  // F5：voiceAvailable 反映裝置找不找得到中文語音，跟 voiceEnabled（使用者
  // 開關）是正交的兩件事，預設值跟 session.js 的初始 state 一致（false）。
  voiceAvailable: false,
  // Important 1：BattleView 現在直接讀這四個欄位算 deviceIssueShown（跟
  // App.vue 的 health-overlay 判準同一份 session.state）。預設值必須是
  // 「健康」，不然這裡的 fixture 少了欄位會讓 `!undefined` 恆為真，把
  // 每一條既有測試都平白多套一個「CoachBanner 被裝置異常隱藏」的假狀態
  // ——這正是這個檔案已經吃過的虧（`perfMode`/`objectDetectorOn` 那兩條
  // 註解講的是同一類問題）。
  cameraHealthy: true,
  inferenceStuck: false,
  inferenceHealthy: true,
  loopError: null,
})

// 假的 CopyEngine：不模擬 cooldown/shuffle，每次都回傳可預期的固定文字，
// 方便斷言「哪個 ns/key 被拿去 take()／peek()」，不必依賴真正的文案池內容。
function createFakeCopy() {
  return {
    take: (ns, key) => ({ text: `${ns}:${key}`, repeat: 1 }),
    peek: (ns, key) => ({ text: `${ns}:${key}`, repeat: 1 }),
    resetSession: () => {},
  }
}

const defaultHealth = () => ({
  pose: { consecutiveFailures: 0, lastErrorName: null },
  face: { consecutiveFailures: 0, lastErrorName: null },
  object: { consecutiveFailures: 0, lastErrorName: null },
})

// 假的 InferenceService：刻意只提供 BattleView 的 DebugHud 真正需要的兩個
// 純讀取方法（actualFps／health），不提供 setEnabled/setScale/destroy/init
// 這些會改變生命週期或啟用狀態的方法——BattleView 若意外呼叫其中任何一個
// （尤其是在 onBeforeUnmount 裡），測試會直接因為「不是函式」而炸掉。這是
// 「onBeforeUnmount 不得碰 inference/camera」這條紅線的結構性防線，
// 比原本整個不提供 inference() 更精準：現在連「元件讀了不該讀的方法」
// 都會被structurally 擋下來，不只是「呼叫了 inference()」這件事本身。
// 骨架線疊加層（PoseSkeletonOverlay）的訂閱通道。它加進這份替身**不是**對
// 上面那條紅線的放寬：`onPoseFrame` 既不改變推論的生命週期、也不改變任何
// track 的啟用狀態，它只是登記一個「下一幀畫這個」的回呼並回傳解除函式。
// setEnabled／setScale／destroy／init 仍然一個都不給。
const poseObservers = []
const onPoseFrameSpy = vi.fn((fn) => {
  poseObservers.push(fn)
  return () => {
    const i = poseObservers.indexOf(fn)
    if (i !== -1) poseObservers.splice(i, 1)
  }
})
const fakeInference = {
  actualFps: vi.fn(() => 0),
  health: vi.fn(() => defaultHealth()),
  onPoseFrame: onPoseFrameSpy,
}
const perfStatsSpy = vi.fn(() => ({
  latencyP95: 0, rafP95: 0, rafMax: 0, rounds: 0,
}))

let fakeCopy
let registeredHandler = null
const unregisterSpy = vi.fn()
const undoTrapSpy = vi.fn()
const togglePauseSpy = vi.fn(() => { fakeState.paused = !fakeState.paused })
// Task 20：休息回合的轉場。故意不讓它改 fakeState.screen——BattleView 不該
// 依賴轉場的結果做任何事，它只負責把「使用者按了休息」交給 store。
const enterBreakSpy = vi.fn(async () => {})
const toggleVoiceSpy = vi.fn(() => { fakeState.voiceEnabled = !fakeState.voiceEnabled })
const copySpy = vi.fn()

// 預設的假 voice：speak 是個什麼都不做、回 true 的 stub。大多數測試根本不關心
// 語音，只需要 session.voice() 是個「呼叫了不會炸」的函式——真正驗證
// 「哪些事件會/不會觸發語音」的測試在下面兩個獨立的 describe 區塊裡，
// 會把 voiceImpl 換成別的假物件或真正的 createVoiceFeedback()。
let voiceImpl
function makeDefaultFakeVoice() {
  return {
    speak: vi.fn(() => true),
    cancel: vi.fn(),
    primeFromGesture: vi.fn(),
    setEnabled: vi.fn(),
    isEnabled: () => false,
    isAvailable: () => false,
  }
}

// 刻意不提供 camera()：BattleView 若意外呼叫它，測試會直接因為「不是函式」
// 而炸掉——這是「onBeforeUnmount 不得碰 inference/camera」這條紅線的結構性
// 防線之一，不是靠人工複查。
//
// inference() 本身必須提供（DebugHud 要讀它），但「一碰就炸」的保證沒有因此
// 消失，只是換了位置：上面那個 fakeInference 只給 actualFps／health 兩個純讀取
// 方法，會改變生命週期或啟用狀態的 setEnabled／setScale／destroy／init 一律不給。
const fakeSession = {
  state: fakeState,
  copy: () => { copySpy(); return fakeCopy },
  inference: () => fakeInference,
  perfStats: perfStatsSpy,
  wakeLockActive: vi.fn(() => true),
  voice: () => voiceImpl,
  onBattleEvent: (handler) => {
    registeredHandler = handler
    return unregisterSpy
  },
  undoTrap: undoTrapSpy,
  togglePause: togglePauseSpy,
  enterBreak: enterBreakSpy,
  toggleVoice: toggleVoiceSpy,
}

vi.mock('../stores/session.js', () => ({ useSession: () => fakeSession }))

import BattleView from './BattleView.vue'

function mount(props = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  let finishCount = 0
  const Host = {
    components: { BattleView },
    template: '<BattleView v-bind="hostProps" @finish="onFinish" />',
    setup() {
      return { hostProps: props, onFinish: () => { finishCount += 1 } }
    },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app, finishCount: () => finishCount }
}

function fireEvents(events) {
  registeredHandler(events)
}

beforeEach(() => {
  fakeCopy = createFakeCopy()
  registeredHandler = null
  unregisterSpy.mockClear()
  undoTrapSpy.mockClear()
  togglePauseSpy.mockClear()
  enterBreakSpy.mockClear()
  toggleVoiceSpy.mockClear()
  copySpy.mockClear()
  fakeInference.actualFps.mockClear()
  fakeInference.health.mockClear()
  onPoseFrameSpy.mockClear()
  poseObservers.length = 0 // Ruling CH (b)：上一條測試的訂閱不得流到下一條
  fakeInference.health.mockImplementation(() => defaultHealth())
  perfStatsSpy.mockClear()
  voiceImpl = makeDefaultFakeVoice() // 每個測試都拿到全新的 spy，不共用殘留的呼叫次數
  fakeState.screen = 'battle'
  fakeState.battle = makeBattle()
  fakeState.posture = 'upright'
  fakeState.drowsy = false
  fakeState.paused = false
  fakeState.perfMode = false
  fakeState.objectDetectorOn = true
  fakeState.phoneDetectEnabled = false
  fakeState.latencyEma = 0
  fakeState.voiceEnabled = false
  fakeState.voiceAvailable = false
  fakeState.cameraHealthy = true
  fakeState.inferenceStuck = false
  fakeState.inferenceHealthy = true
  fakeState.loopError = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BattleView：血條與版面基礎渲染', () => {
  it('英雄血條用 BATTLE.playerHpMax 當上限，魔王血條用 bossHpPhaseMax（不是 bossHpMax）', async () => {
    const { el, app } = mount()
    await nextTick()

    const bars = [...el.querySelectorAll('[role="progressbar"]')]
    const hero = bars.find((b) => b.getAttribute('aria-label') === '你的體力')
    const boss = bars.find((b) => b.getAttribute('aria-label') === '魔王')

    expect(hero.getAttribute('aria-valuemax')).toBe(String(BATTLE.playerHpMax))
    expect(boss.getAttribute('aria-valuemax')).toBe('200') // bossHpPhaseMax，不是 500
    expect(boss.getAttribute('aria-valuenow')).toBe('200') // bossHp

    app.unmount()
    el.remove()
  })

  it('時鐘顯示 mm:ss（剩餘時間），分數顯示 battle.score', async () => {
    fakeState.battle = makeBattle({ elapsedMs: 61_000, durationMs: 900_000, score: 40 })
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.clock').textContent).toBe('13:59')
    expect(el.querySelector('.score').textContent).toContain('40')

    app.unmount()
    el.remove()
  })

  it('battle 為 null 時不噴例外，時鐘顯示 00:00', async () => {
    fakeState.battle = null
    expect(() => mount()).not.toThrow()
    await nextTick()
  })

  it('第二形態（phase > 1）才顯示「第 N 形態」字樣', async () => {
    const { el, app } = mount()
    await nextTick()
    expect(el.textContent).not.toContain('形態')

    fakeState.battle = makeBattle({ phase: 2 })
    await nextTick()
    expect(el.textContent).toContain('第 2 形態')

    app.unmount()
    el.remove()
  })

  it('battle.phase 會傳給 BossSprite（魔王本體換臉）與 .arena__scene（場景換色），兩處都跟著形態走', async () => {
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.boss-sprite').classList.contains('phase2')).toBe(false)
    expect(el.querySelector('.arena__scene').classList.contains('phase2')).toBe(false)

    fakeState.battle = makeBattle({ phase: 2 })
    await nextTick()
    expect(el.querySelector('.boss-sprite').classList.contains('phase2')).toBe(true)
    expect(el.querySelector('.arena__scene').classList.contains('phase2')).toBe(true)

    app.unmount()
    el.remove()
  })

  it('三個以上形態同時顯示血條區段（實機回報：應該同時看到每個形態的血量，不是一條反覆補血的血條）', async () => {
    fakeState.battle = makeBattle({ phase: 3, bossHp: 50, bossHpPhaseMax: 200 })
    const { el, app } = mount()
    await nextTick()

    const segs = el.querySelectorAll('.seg')
    expect(segs.length, '形態 3：前兩個形態已破＋目前這個形態，共 3 段').toBe(3)
    expect(segs[0].classList.contains('cleared'), '第一形態已經打贏過').toBe(true)
    expect(segs[1].classList.contains('cleared'), '第二形態已經打贏過').toBe(true)
    expect(segs[2].classList.contains('cleared'), '第三形態是正在打的，不是 cleared').toBe(false)
    expect(segs[0].querySelector('.fill').style.transform).toBe('scaleX(1)')
    expect(segs[1].querySelector('.fill').style.transform).toBe('scaleX(1)')
    expect(segs[2].querySelector('.fill').style.transform).toBe('scaleX(0.25)') // 50/200

    // 就算血條分段了，畫面上的數字仍然是當前形態的即時血量，不是分段資料
    // 算出來的東西——這是給玩家核對的依據，不能被分段顯示蓋掉。
    expect(el.textContent).toContain('50 / 200')

    app.unmount()
    el.remove()
  })

  it('形態 1（預設）不分段，血條維持原本單一長條——分段顯示不改變第一形態的既有外觀', async () => {
    const { el, app } = mount() // makeBattle() 預設 phase: 1
    await nextTick()

    expect(el.querySelectorAll('.seg').length).toBe(0)
    const bossTrack = [...el.querySelectorAll('.hp.boss .track')][0]
    expect(bossTrack.classList.contains('segmented')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('regrouping 為 true 時顯示重整旗鼓提示、.arena 套用 regrouping class', async () => {
    fakeState.battle = makeBattle({ regrouping: true })
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.arena').classList.contains('regrouping')).toBe(true)
    expect(el.textContent).toContain('重整旗鼓')

    app.unmount()
    el.remove()
  })

  it('畫面上所有靜態文字都不含禁用詞', async () => {
    const { el, app } = mount()
    await nextTick()
    for (const word of BANNED_WORDS) expect(el.textContent).not.toContain(word)
    app.unmount()
    el.remove()
  })
})

describe('BattleView：使用 store 的單例 CopyEngine，不自建第二個', () => {
  it('掛載時呼叫過 session.copy()，取得的是 store 那個單例', async () => {
    const { app, el } = mount()
    await nextTick()
    expect(copySpy).toHaveBeenCalled()
    app.unmount()
    el.remove()
  })
})

describe('BattleView：事件 → 視覺特效與魔王台詞', () => {
  it('attack 事件：往魔王側飛一發光刃、魔王閃紅、浮出 −傷害數字，且魔王台詞透過 messageQueue 顯示', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'attack', damage: 20, bossHp: 180, score: 10, streak: 1 }])
    await nextTick()

    expect(el.querySelectorAll('.bolt.to-boss.fly').length).toBe(1)
    expect(el.querySelector('.arena__boss').classList.contains('struck')).toBe(true)
    const dmg = [...el.querySelectorAll('.dmg.boss')]
    expect(dmg.some((p) => p.textContent.includes('−20'))).toBe(true)

    const banner = el.querySelector('.banner')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('boss:hit')

    app.unmount()
    el.remove()
  })

  it('playerDamage 事件：往英雄側飛一發反擊、英雄閃紅、浮出 −扣血數字＋姿態標籤，且姿態修正訊息優先於魔王台詞', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'playerDamage', amount: 3, playerHp: 97, reason: 'slouch' }])
    await nextTick()

    expect(el.querySelectorAll('.bolt.to-hero.fly').length).toBe(1)
    expect(el.querySelector('.arena__hero').classList.contains('struck')).toBe(true)
    const dmg = [...el.querySelectorAll('.dmg.hero')]
    expect(dmg.some((p) => p.textContent.includes('−3') && p.textContent.includes('駝背'))).toBe(true)

    // postureCoach 發布的 posture 訊息優先序高於魔王台詞，應該是畫面上顯示的那則
    const banner = el.querySelector('.banner')
    expect(banner.classList.contains('posture')).toBe(true)
    expect(banner.textContent).toContain('posture:slouch')

    app.unmount()
    el.remove()
  })

  it('playerDamage 事件：.boss-sprite 加上 attacking（魔王主動出手，不是英雄單方面挨打），FLIGHT_MS(420ms) 後自己收掉', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('attacking')).toBe(false)

    fireEvents([{ type: 'playerDamage', amount: 3, playerHp: 97, reason: 'slouch' }])
    await nextTick()
    expect(sprite.classList.contains('attacking')).toBe(true)

    await vi.advanceTimersByTimeAsync(470)
    await nextTick()
    expect(sprite.classList.contains('attacking'), '出手攻擊是一次性動作，不能卡住不放').toBe(false)

    app.unmount()
    el.remove()
  })

  it('trapCommitted 事件：浮出回血與扣分兩個數字、往英雄側反擊，且魔王台詞正常發布不 throw（ns/key 一定有帶）', async () => {
    const { el, app } = mount()
    await nextTick()

    expect(() => fireEvents([{
      type: 'trapCommitted', trapId: 'phone-1', kind: 'phone', bossHeal: 10, scorePenalty: 100,
    }])).not.toThrow()
    await nextTick()

    expect(el.querySelectorAll('.bolt.to-hero.fly').length).toBe(1)
    const bossNums = [...el.querySelectorAll('.dmg.boss')]
    const heroNums = [...el.querySelectorAll('.dmg.hero')]
    expect(bossNums.some((p) => p.textContent.includes('+10') && p.textContent.includes('回血'))).toBe(true)
    expect(heroNums.some((p) => p.textContent.includes('−100') && p.textContent.includes('積分'))).toBe(true)

    app.unmount()
    el.remove()
  })

  it('trapPending 事件：顯示撤銷按鈕與倒數秒數（從 battle.pendingTraps 對應那筆算出來，不是另一套時間）', async () => {
    fakeState.battle = makeBattle({
      elapsedMs: 5000,
      pendingTraps: [{ trapId: 'phone-1', kind: 'phone', deadlineAtElapsed: 25_000 }],
    })
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'trapPending', trapId: 'phone-1', kind: 'phone' }])
    await nextTick()

    const undoBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('我沒有在玩那個'))
    expect(undoBtn).not.toBeUndefined()
    const countdown = el.querySelector('.countdown')
    expect(countdown).not.toBeNull()
    expect(countdown.textContent).toContain('20') // (25000-5000)/1000 = 20 秒

    app.unmount()
    el.remove()
  })

  it('點擊撤銷按鈕會呼叫 session.undoTrap(trapId) 並立刻清空訊息（不用等 ttl 到期）', async () => {
    fakeState.battle = makeBattle({
      elapsedMs: 0,
      pendingTraps: [{ trapId: 'away-1', kind: 'away', deadlineAtElapsed: 20_000 }],
    })
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'trapPending', trapId: 'away-1', kind: 'away' }])
    await nextTick()

    // away 陷阱的撤銷鈕文字跟 phone 不一樣（見 CoachBanner.vue），這裡找的
    // 是「我沒有離開」，不是「我沒有在玩那個」。
    const undoBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('我沒有離開'))
    undoBtn.click()
    await nextTick()

    expect(undoTrapSpy).toHaveBeenCalledWith('away-1')
    expect(el.querySelector('.banner')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('同時最多 3 個飛行特效，第 4 個直接丟棄，不會噴例外', async () => {
    const { el, app } = mount()
    await nextTick()

    expect(() => fireEvents([
      { type: 'attack', damage: 20, streak: 1 },
      { type: 'attack', damage: 20, streak: 1 },
      { type: 'attack', damage: 20, streak: 1 },
      { type: 'attack', damage: 20, streak: 1 },
    ])).not.toThrow()
    await nextTick()

    expect(el.querySelectorAll('.bolt.to-boss.fly').length).toBe(3)

    app.unmount()
    el.remove()
  })

  it('reduced-motion 時不觸發飛行特效，但傷害數字仍然顯示', async () => {
    const original = window.matchMedia
    window.matchMedia = () => ({ matches: true })

    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'attack', damage: 20, streak: 1 }])
    await nextTick()

    expect(el.querySelectorAll('.bolt.fly').length).toBe(0)
    expect(el.querySelectorAll('.dmg.boss').length).toBeGreaterThan(0)

    app.unmount()
    el.remove()
    window.matchMedia = original
  })

  it('drowsy 事件：安全提示（含休息按鈕）優先序最高，蓋過魔王台詞', async () => {
    fakeState.drowsy = true
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'drowsy' }])
    await nextTick()

    const banner = el.querySelector('.banner')
    expect(banner.classList.contains('safety')).toBe(true)
    const breakBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('休息一下'))
    expect(breakBtn).not.toBeUndefined()

    app.unmount()
    el.remove()
  })

  // Task 20 更正 4：這裡原本斷言的是「呼叫 session.togglePause()」——那是還沒有
  // 獨立休息畫面時「借用暫停機制」的權宜做法。休息畫面做出來之後，這個呼叫點
  // 必須改走 enterBreak()，否則就是兩條路做同一件事而且做得不一樣（一條只是
  // 暫停在戰鬥畫面上，一條有倒數與伸展建議）。護欄裝在**會違規的那一行**上：
  // BattleView 的 onBreak() 自己，不是 store 那一層。
  it('點擊「休息一下」呼叫 session.enterBreak()，不是借用 togglePause()，也不直接改 state.screen', async () => {
    fakeState.drowsy = true
    const { el, app } = mount()
    await nextTick()
    fireEvents([{ type: 'drowsy' }])
    await nextTick()

    const breakBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('休息一下'))
    breakBtn.click()

    expect(enterBreakSpy).toHaveBeenCalledTimes(1)
    expect(togglePauseSpy, '暫停與否由 enterBreak() 內部決定，這裡不得自己按一次暫停').not.toHaveBeenCalled()
    expect(fakeState.screen).toBe('battle') // 沒有人偷改 screen

    app.unmount()
    el.remove()
  })

  it('已經暫停中時點擊「休息一下」照樣進休息回合（而且仍然不自己呼叫 togglePause）', async () => {
    fakeState.drowsy = true
    fakeState.paused = true
    const { el, app } = mount()
    await nextTick()
    fireEvents([{ type: 'drowsy' }])
    await nextTick()

    const breakBtn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('休息一下'))
    breakBtn.click()

    // 舊行為是「暫停中按休息＝什麼都不會發生」，小孩會以為按壞了。現在一樣
    // 進得去休息回合；「已經暫停中就不要再 toggle 一次」那條判斷搬進了
    // enterBreak()（session.break.test.js 有對應的測試），不留在這裡重複一份。
    expect(enterBreakSpy).toHaveBeenCalledTimes(1)
    expect(togglePauseSpy).not.toHaveBeenCalled()

    app.unmount()
    el.remove()
  })
})

describe('BattleView：輪詢（uiTimer）', () => {
  it('訊息 ttl 到期後，就算沒有新事件，畫面上的 banner 也會在下一次輪詢時消失', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'attack', damage: 20, streak: 1 }])
    await nextTick()
    expect(el.querySelector('.banner')).not.toBeNull()

    // sayBoss 發布的訊息 ttlMs 是 3500；推進超過這個時間，輪詢（250ms 一次）
    // 應該會把過期的訊息收掉，不必等下一個事件進來。
    await vi.advanceTimersByTimeAsync(4000)
    await nextTick()
    expect(el.querySelector('.banner')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('鏡頭 stream 在掛載之後才就緒時，輪詢會在下一拍把它鏡射過去', async () => {
    vi.useFakeTimers()
    const videoEl = document.createElement('video') // 掛載當下還沒有 srcObject
    const { el, app } = mount({ videoEl })
    await nextTick()

    expect(el.querySelector('video.cam').srcObject).toBeNull()

    videoEl.srcObject = { fake: 'stream' } // 模擬 camera.resume() 稍晚才把 stream 接上
    await vi.advanceTimersByTimeAsync(300)
    await nextTick()

    expect(el.querySelector('video.cam').srcObject).toBe(videoEl.srcObject)

    app.unmount()
    el.remove()
  })
})

describe('BattleView：暫停與結束', () => {
  it('暫停按鈕文字依 state.paused 切換，點擊呼叫 session.togglePause()', async () => {
    const { el, app } = mount()
    await nextTick()

    const pauseBtn = el.querySelector('.pause')
    expect(pauseBtn.textContent).toBe('暫停')
    pauseBtn.click()
    await nextTick()

    expect(togglePauseSpy).toHaveBeenCalledTimes(1)
    expect(pauseBtn.textContent).toBe('繼續')

    app.unmount()
    el.remove()
  })

  it('點「結束」出現二次確認；「繼續討伐」在上、「結束這一輪」在下；取消不 emit finish', async () => {
    const { el, app, finishCount } = mount()
    await nextTick()

    el.querySelector('.stop').click()
    await nextTick()

    const dialogButtons = [...el.querySelectorAll('[role="dialog"] button')]
    expect(dialogButtons[0].textContent).toBe('繼續討伐')
    expect(dialogButtons[1].textContent).toBe('結束這一輪')

    dialogButtons[0].click()
    await nextTick()
    expect(el.querySelector('[role="dialog"]')).toBeNull()
    expect(finishCount()).toBe(0)

    app.unmount()
    el.remove()
  })

  it('確認結束會 emit finish', async () => {
    const { el, app, finishCount } = mount()
    await nextTick()

    el.querySelector('.stop').click()
    await nextTick()
    const dialogButtons = [...el.querySelectorAll('[role="dialog"] button')]
    dialogButtons[1].click()
    await nextTick()

    expect(finishCount()).toBe(1)

    app.unmount()
    el.remove()
  })
})

describe('BattleView：鏡頭鏡射（不新增 getUserMedia，不搬動共用節點）', () => {
  it('本地預覽 video 的 srcObject 會鏡射 props.videoEl 的 srcObject', async () => {
    const videoEl = document.createElement('video')
    videoEl.srcObject = { fake: 'stream' }

    const { el, app } = mount({ videoEl })
    await nextTick()

    const localVideo = el.querySelector('video.cam')
    expect(localVideo).not.toBeNull()
    expect(localVideo.srcObject).toBe(videoEl.srcObject)

    app.unmount()
    el.remove()
  })

  it('videoEl 為 null 時不噴例外', async () => {
    expect(() => mount({ videoEl: null })).not.toThrow()
    await nextTick()
  })
})

describe('BattleView：卸載時不得觸碰 inference/camera 生命週期', () => {
  it('卸載會取消事件訂閱與輪詢，但不會呼叫任何 camera/inference 方法（fakeSession 根本沒提供，呼叫就會炸）', async () => {
    const { app, el } = mount()
    await nextTick()

    expect(() => app.unmount()).not.toThrow()
    expect(unregisterSpy).toHaveBeenCalledTimes(1)

    el.remove()
  })

  it('卸載會清掉輪詢用的 setInterval（不是只做到「不會噴例外」這種弱斷言——曾經在這裡踩過移掉 clearInterval 但測試照樣綠燈的假陽性）', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const { app, el } = mount()
    await nextTick()

    app.unmount()

    expect(clearIntervalSpy).toHaveBeenCalled()

    clearIntervalSpy.mockRestore()
    el.remove()
  })

  it('掛載期間 HUD 關著時完全不呼叫 inference 的讀取方法，unmount 前後呼叫次數都維持 0', async () => {
    const { app, el } = mount()
    await nextTick()
    expect(fakeInference.actualFps).not.toHaveBeenCalled()
    expect(fakeInference.health).not.toHaveBeenCalled()

    app.unmount()
    expect(fakeInference.actualFps).not.toHaveBeenCalled()
    expect(fakeInference.health).not.toHaveBeenCalled()

    el.remove()
  })
})

describe('BattleView：StatusIndicator——效能降級與手機偵測狀態（Task 16）', () => {
  it('perfMode=false 且 objectDetectorOn=true（正常狀態）時，只有綠點與「偵測中」，不展開清單', async () => {
    const { el, app } = mount()
    await nextTick()

    const dot = el.querySelector('.status-indicator .dot')
    expect(dot.classList.contains('ok')).toBe(true)
    expect(el.querySelector('.status-indicator').textContent).toContain('偵測中')
    expect(el.querySelector('.status-indicator .list')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('perfMode=true 時展開顯示效能降級文字', async () => {
    fakeState.perfMode = true
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.status-indicator .list')).not.toBeNull()
    expect(el.textContent).toContain('偵測速度變慢了')

    app.unmount()
    el.remove()
  })

  // Task 22c（controller 裁決 2）：手機偵測那一則改成跟語音同一條判準——
  // 只有「使用者要它開著、它卻沒在跑」才是降級。工作人員刻意關掉的不是降級，
  // 而且展場預設就是關的：舊條件會讓那則提示在每一場戰鬥全程常駐，把所有人
  // 訓練成忽略這個指示器，真正的降級（效能降檔）出現時反而沒有人看得到。
  it('phoneDetectEnabled=false（工作人員自己關掉、也是展場預設）：不顯示手機偵測警示', async () => {
    fakeState.phoneDetectEnabled = false
    fakeState.objectDetectorOn = false
    const { el, app } = mount()
    await nextTick()

    expect(el.textContent).not.toContain('手機偵測已暫停')
    expect(el.querySelector('.status-indicator .list')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('phoneDetectEnabled=true 且 objectDetectorOn=true（正常運作）：不顯示手機偵測警示', async () => {
    fakeState.phoneDetectEnabled = true
    fakeState.objectDetectorOn = true
    const { el, app } = mount()
    await nextTick()

    expect(el.textContent).not.toContain('手機偵測已暫停')
    expect(el.querySelector('.status-indicator .list')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('phoneDetectEnabled=true 但 objectDetectorOn=false（工作人員要它開著、卻被自動降檔關掉）：這才是降級，展開顯示', async () => {
    fakeState.phoneDetectEnabled = true
    fakeState.objectDetectorOn = false
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.status-indicator .list')).not.toBeNull()
    expect(el.textContent).toContain('手機偵測已暫停')

    app.unmount()
    el.remove()
  })

  it('展開的每一則狀態文字都不含禁用詞，且單句不超過 15 字（給小孩看的文案紅線一樣適用）', async () => {
    fakeState.perfMode = true
    fakeState.phoneDetectEnabled = true
    fakeState.objectDetectorOn = false
    const { el, app } = mount()
    await nextTick()

    const items = [...el.querySelectorAll('.status-indicator .list li')]
    expect(items.length).toBe(2)
    for (const li of items) {
      const msg = li.querySelectorAll('span')[1]?.textContent ?? ''
      expect(msg.length).toBeLessThanOrEqual(15)
      for (const word of BANNED_WORDS) expect(msg).not.toContain(word)
    }

    app.unmount()
    el.remove()
  })
})

describe('BattleView：StatusIndicator——語音降級（F5，Task 22b-3：只在使用者已開啟卻裝置不可用時才算降級）', () => {
  it('voiceEnabled=false（使用者自己關掉），就算 voiceAvailable=false，也不顯示語音警示——那是他自己按的，不是降級', async () => {
    fakeState.voiceEnabled = false
    fakeState.voiceAvailable = false
    const { el, app } = mount()
    await nextTick()

    expect(el.textContent).not.toContain('語音功能無法使用')
    expect(el.querySelector('.status-indicator .list')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('voiceEnabled=true 且 voiceAvailable=true（裝置正常支援），不顯示語音警示', async () => {
    fakeState.voiceEnabled = true
    fakeState.voiceAvailable = true
    const { el, app } = mount()
    await nextTick()

    expect(el.textContent).not.toContain('語音功能無法使用')
    expect(el.querySelector('.status-indicator .list')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('voiceEnabled=true 但 voiceAvailable=false（使用者開了、裝置卻找不到語音）：展開顯示語音無法使用', async () => {
    fakeState.voiceEnabled = true
    fakeState.voiceAvailable = false
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.status-indicator .list')).not.toBeNull()
    expect(el.textContent).toContain('語音功能無法使用')

    app.unmount()
    el.remove()
  })
})

describe('BattleView：Debug HUD 隱藏手勢——角落連續點 5 下、600ms 內（Task 16，不得被小孩誤觸打開）', () => {
  it('預設不顯示 DebugHud', async () => {
    const { el, app } = mount()
    await nextTick()
    expect(el.querySelector('.hud')).toBeNull()
    app.unmount()
    el.remove()
  })

  it('在時鐘／分數區塊（corner-tl）連續點 5 下會打開 DebugHud；再連點 5 下會關閉', async () => {
    const { el, app } = mount()
    await nextTick()

    const hotspot = el.querySelector('.corner-tl.status')
    for (let i = 0; i < 5; i++) hotspot.click()
    await nextTick()
    expect(el.querySelector('.hud')).not.toBeNull()

    for (let i = 0; i < 5; i++) hotspot.click()
    await nextTick()
    expect(el.querySelector('.hud')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('點擊次數不足 5 下且超過 600ms 沒有繼續點，計數會重置，不會累積跨視窗觸發', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    const hotspot = el.querySelector('.corner-tl.status')
    for (let i = 0; i < 3; i++) hotspot.click()
    await vi.advanceTimersByTimeAsync(700) // 超過 600ms 視窗，計數應該歸零
    for (let i = 0; i < 3; i++) hotspot.click() // 3+3=6 下，但中間重置過，不該觸發
    await nextTick()

    expect(el.querySelector('.hud')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('HUD 打開後，輪詢會呼叫 inference.actualFps／health 與 session.perfStats()，並把結果（含白名單允許的 error.name）顯示在畫面上', async () => {
    vi.useFakeTimers()
    fakeInference.actualFps.mockImplementation((key) => (key === 'pose' ? 1.5 : 0))
    fakeInference.health.mockImplementation(() => ({
      pose: { consecutiveFailures: 2, lastErrorName: 'TypeError' },
      face: { consecutiveFailures: 0, lastErrorName: null },
      object: { consecutiveFailures: 0, lastErrorName: null },
    }))
    perfStatsSpy.mockImplementation(() => ({
      latencyP95: 77, rafP95: 16, rafMax: 30, rounds: 2,
    }))
    fakeSession.wakeLockActive.mockReturnValue(true)

    const { el, app } = mount()
    await nextTick()
    const hotspot = el.querySelector('.corner-tl.status')
    for (let i = 0; i < 5; i++) hotspot.click()
    await nextTick()
    expect(el.querySelector('.hud')).not.toBeNull()

    await vi.advanceTimersByTimeAsync(300) // 讓 250ms 的 uiTimer 跑一次
    await nextTick()

    expect(fakeInference.actualFps).toHaveBeenCalled()
    expect(fakeInference.health).toHaveBeenCalled()
    expect(perfStatsSpy).toHaveBeenCalled()
    // 全 repo 掃過一輪才發現的缺口：wakeLock.isActive() 從一開始就存在，
    // 卻沒有任何畫面讀過它——展場最怕的「螢幕自己暗掉」在那之前完全沒有
    // 任何前兆。這裡鎖住它真的有被輪詢、真的被顯示，不是只加了存在但沒被
    // 呼叫的裝飾函式（copyGuardrail.js 那次死碼／幽靈護欄是同一種錯，
    // 不要在這裡重蹈）。
    expect(fakeSession.wakeLockActive).toHaveBeenCalled()
    expect(el.textContent).toContain('TypeError')
    expect(el.textContent).toContain('77')
    expect(el.textContent).toContain('螢幕喚醒鎖 開')

    app.unmount()
    el.remove()
  })

  it('喚醒鎖顯示「關」的情境（真的失敗過，不是永遠成功的樂觀預設）', async () => {
    vi.useFakeTimers()
    fakeSession.wakeLockActive.mockReturnValue(false)

    const { el, app } = mount()
    await nextTick()
    const hotspot = el.querySelector('.corner-tl.status')
    for (let i = 0; i < 5; i++) hotspot.click()
    await nextTick()

    await vi.advanceTimersByTimeAsync(300)
    await nextTick()

    expect(el.textContent).toContain('螢幕喚醒鎖 關')

    app.unmount()
    el.remove()
  })

  it('HUD 關著時，即使輪詢照常執行多次，也完全不呼叫 inference.actualFps／health／session.perfStats／wakeLockActive（量測本身不能變成效能問題）', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    await vi.advanceTimersByTimeAsync(1000) // 讓 uiTimer 跑好幾輪
    await nextTick()

    expect(fakeInference.actualFps).not.toHaveBeenCalled()
    expect(fakeInference.health).not.toHaveBeenCalled()
    expect(perfStatsSpy).not.toHaveBeenCalled()
    expect(fakeSession.wakeLockActive).not.toHaveBeenCalled()

    app.unmount()
    el.remove()
  })
})

describe('BattleView：語音開關按鈕', () => {
  it('預設顯示「🔇 語音關」、aria-pressed 為 false；點擊呼叫 session.toggleVoice()', async () => {
    const { el, app } = mount()
    await nextTick()

    const muteBtn = el.querySelector('.mute')
    expect(muteBtn.textContent).toContain('🔇 語音關')
    expect(muteBtn.getAttribute('aria-pressed')).toBe('false')

    muteBtn.click()
    await nextTick()

    expect(toggleVoiceSpy).toHaveBeenCalledTimes(1)
    expect(muteBtn.textContent).toContain('🔊 語音開')
    expect(muteBtn.getAttribute('aria-pressed')).toBe('true')

    app.unmount()
    el.remove()
  })

  // Important 5（版面／可及性複審）：.mute 是 corner-tl 這個 div 的子節點，
  // corner-tl 自己掛了 @click="bumpHud"（5 連點開 Debug HUD 的隱藏手勢）。
  // 原生 click 會冒泡，沒有 .stop 的話，反覆切換語音（小孩很常見的操作）
  // 5 次之內就會意外打開只給工作人員看的 Debug HUD——這裡鎖住「點靜音鈕
  // 不會觸發 bumpHud」這件事：連點 5 下純靜音鈕，HUD 不該打開。
  it('連續點擊靜音鈕 5 次不會冒泡觸發 corner-tl 的 5 連點手勢、不會打開 Debug HUD（Important 5）', async () => {
    const { el, app } = mount()
    await nextTick()

    const muteBtn = el.querySelector('.mute')
    for (let i = 0; i < 5; i++) muteBtn.click()
    await nextTick()

    expect(el.querySelector('.hud'), '點靜音鈕不該冒泡打開 Debug HUD').toBeNull()
    // 反向佐證：同樣的手勢掛在 corner-tl 上依然有效（不是整個 bumpHud 機制
    // 被拆掉了，只是 mute 這顆按鈕不再把事件冒上去）。
    const hotspot = el.querySelector('.corner-tl.status')
    for (let i = 0; i < 5; i++) hotspot.click()
    await nextTick()
    expect(el.querySelector('.hud')).not.toBeNull()

    app.unmount()
    el.remove()
  })
})

describe('BattleView：訊息 → 語音（唯一檢查點只讀 m.voice，不重新判斷）', () => {
  it('一般魔王台詞（voice:true）：refreshCoachMessage 呼叫 session.voice().speak(text, priority)，且只念一次（用 shownAt 判斷,不因輪詢重複觸發）', async () => {
    // 用 regroupStart 不用 attack：attack 對應的 'hit' 現在被
    // NO_VOICE_PRAISE_BOSS_KEYS 關掉語音了（太吵，見 data/copy/boss.js），
    // 這條要驗證的是「一般會念的魔王台詞」，換一個真的還會念的事件。
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'regroupStart' }])
    await nextTick()

    expect(voiceImpl.speak).toHaveBeenCalledTimes(1)
    expect(voiceImpl.speak).toHaveBeenCalledWith('boss:regroup', 1) // PRIORITY.battle === 1

    // uiTimer 下一拍（250ms）：同一則訊息還沒過期（ttlMs 3500），不該被重念一次
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    expect(voiceImpl.speak).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
  })

  it('trapCommitted（分心類）事件：mq 把 voice 強制覆寫為 false，session.voice().speak 完全不會被呼叫', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{
      type: 'trapCommitted', trapId: 'phone-1', kind: 'phone', bossHeal: 10, scorePenalty: 100,
    }])
    await nextTick()

    // 反向檢查：訊息確實有發布出來、畫面上看得到（不是「事件根本沒被處理」
    // 這種假陽性），只是不准念。
    expect(el.querySelector('.banner')).not.toBeNull()
    expect(voiceImpl.speak).not.toHaveBeenCalled()

    app.unmount()
    el.remove()
  })

  it('playerDamage（posture）事件：voice 資格由 CopyEngine 的 repeat 決定（fakeCopy 固定回 repeat:1 → voice:true），一樣經過同一個檢查點觸發語音', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'playerDamage', amount: 3, playerHp: 97, reason: 'slouch' }])
    await nextTick()

    expect(voiceImpl.speak).toHaveBeenCalledTimes(1)
    const [text, priority] = voiceImpl.speak.mock.calls[0]
    expect(text).toContain('posture:slouch')
    expect(priority).toBe(3) // PRIORITY.posture

    app.unmount()
    el.remove()
  })
})

/**
 * 端到端：從 trapCommitted 事件出發，走真正的 copyKeyForEvent（bossDialogue.js）
 * → 真正的 messageQueue.publish()（NO_VOICE 表在這裡把 voice 強制覆寫成 false）
 * → BattleView 唯一的 speakIfNeeded 檢查點 → 真正的 voiceFeedback，只在
 * 「瀏覽器 TTS」這個真正的裝置邊界上 mock（jsdom 沒有 speechSynthesis）。
 *
 * 這條測試存在的理由：只驗證 voiceFeedback 自己（丟一個 voice:false 的假訊息
 * 進去）測不到「整條管線合起來真的不會念」——例如哪天有人在 sayBoss() 或
 * refreshCoachMessage() 裡加了一行繞過 m.voice、直接對文字內容做 if 判斷，
 * 前面那種窄測試依然會綠燈，只有跨元件的這條會抓到。
 */
describe('BattleView：端到端——trapCommitted 全程真實管線下，瀏覽器 TTS 從頭到尾沒有被呼叫', () => {
  let synth

  function installSpeechSynthesis() {
    synth = {
      speaking: false,
      speak: vi.fn(),
      cancel: vi.fn(),
      getVoices: vi.fn(() => [{ lang: 'zh-TW', name: 'Test' }]), // 一開始就找得到中文語音，省去等 voiceschanged
      addEventListener: vi.fn(),
    }
    window.speechSynthesis = synth
    globalThis.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text
        this.volume = 1
        this.rate = 1
        this.voice = null
        this.lang = null
        this.onend = null
        this.onerror = null
      }
    }
  }

  function uninstallSpeechSynthesis() {
    delete window.speechSynthesis
    delete globalThis.SpeechSynthesisUtterance
  }

  beforeEach(async () => {
    installSpeechSynthesis()
    const { createVoiceFeedback } = await import('../core/voiceFeedback.js')
    const realVoice = createVoiceFeedback()
    realVoice.init()
    realVoice.setEnabled(true)
    realVoice.primeFromGesture() // iOS 暖機；這裡同步呼叫沒有手勢限制的問題（測試環境）
    synth.speak.mockClear() // 排除暖機那一次呼叫，只看訊息觸發的
    voiceImpl = realVoice // 讓 fakeSession.voice() 這次回傳真正的 voiceFeedback 實例，不是 stub
  })

  afterEach(() => {
    uninstallSpeechSynthesis()
  })

  it('trapCommitted（手機）：真實管線下瀏覽器 TTS 完全沒被呼叫', async () => {
    const { el, app } = mount()
    await nextTick()

    expect(() => fireEvents([{
      type: 'trapCommitted', trapId: 'phone-1', kind: 'phone', bossHeal: 10, scorePenalty: 100,
    }])).not.toThrow()
    await nextTick()

    expect(el.querySelector('.banner')).not.toBeNull() // 訊息確實顯示了
    expect(synth.speak).not.toHaveBeenCalled() // 但瀏覽器 TTS 從頭到尾沒被呼叫

    app.unmount()
    el.remove()
  })

  it('trapCommitted（離開座位）：同上，awayTrap 一樣全程不觸發 TTS', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{
      type: 'trapCommitted', trapId: 'away-1', kind: 'away', bossHeal: 10, scorePenalty: 100,
    }])
    await nextTick()

    expect(el.querySelector('.banner')).not.toBeNull()
    expect(synth.speak).not.toHaveBeenCalled()

    app.unmount()
    el.remove()
  })

  it('反向測試：同一條真實管線，一般事件真的會呼叫瀏覽器 TTS——證明上面兩則「沒呼叫」不是因為整條路徑本來就是啞的', async () => {
    // 同上，attack/'hit' 現在被 NO_VOICE_PRAISE_BOSS_KEYS 關掉了，換
    // regroupStart 當「一般會念」的反向例子。
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'regroupStart' }])
    await nextTick()

    expect(synth.speak).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// Important 1（版面／可及性複審）：health-overlay 顯示時，CoachBanner 必須
// 整個不渲染——兩者是完全相同的錨點公式，同時出現時 health-overlay 會蓋住
// CoachBanner 的撤銷鈕與倒數（陷阱唯一的撤銷出口，文字依 kind 是
// 「我沒有在玩那個」或「我沒有離開」，見 CoachBanner.vue）。
// ---------------------------------------------------------------------------

describe('Important 1（版面／可及性複審）：裝置異常時 CoachBanner 整個讓路，不被 health-overlay 蓋住', () => {
  it('cameraHealthy=false 時，就算有 coachMessage（含 trap 的撤銷鈕與倒數），CoachBanner 也不渲染', async () => {
    fakeState.battle = makeBattle({
      elapsedMs: 5000,
      pendingTraps: [{ trapId: 'phone-1', kind: 'phone', deadlineAtElapsed: 25_000 }],
    })
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'trapPending', trapId: 'phone-1', kind: 'phone' }])
    await nextTick()
    // 先確認訊息真的發布出來了（不是「事件根本沒處理」這種假陽性）。
    expect(el.querySelector('.banner')).not.toBeNull()

    fakeState.cameraHealthy = false
    await nextTick()

    // 裝置異常一出現，CoachBanner（含撤銷鈕、倒數）必須整個消失——不是
    // 被蓋住看不到，是真的不渲染，這樣才不會有兩個不透明疊層互相干擾。
    expect(el.querySelector('.banner'), 'health-overlay 顯示時 CoachBanner 不該渲染').toBeNull()
    expect([...el.querySelectorAll('button')].some((b) => b.textContent.includes('我沒有在玩那個'))).toBe(false)

    // 裝置恢復健康：CoachBanner 應該重新出現（訊息 TTL 還沒過期的話）。
    fakeState.cameraHealthy = true
    await nextTick()
    expect(el.querySelector('.banner'), '裝置恢復健康後 CoachBanner 要讓回來').not.toBeNull()

    app.unmount()
    el.remove()
  })

  it('inferenceStuck／!inferenceHealthy／loopError 任一為真時，同樣隱藏 CoachBanner', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'attack', damage: 20, streak: 1 }])
    await nextTick()
    expect(el.querySelector('.banner')).not.toBeNull()

    fakeState.inferenceStuck = true
    await nextTick()
    expect(el.querySelector('.banner')).toBeNull()
    fakeState.inferenceStuck = false

    fakeState.inferenceHealthy = false
    await nextTick()
    expect(el.querySelector('.banner')).toBeNull()
    fakeState.inferenceHealthy = true

    fakeState.loopError = 'TypeError'
    await nextTick()
    expect(el.querySelector('.banner')).toBeNull()
    fakeState.loopError = null

    await nextTick()
    expect(el.querySelector('.banner'), '四個旗標都健康時 CoachBanner 要能正常顯示').not.toBeNull()

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// Important 2（版面／可及性複審）：橫向下 .boss-hud 不得被 StatusIndicator
// 展開清單（.corner-tr）蓋住
// ---------------------------------------------------------------------------

describe('Important 2（版面／可及性複審）：boss-hud 的 z-index 明確高於 corner-tr，不依賴 DOM 順序決定疊放', () => {
  // jsdom 不算版面、也不套用元件 <style> 的級聯（本專案的 vitest 設定關掉了
  // CSS 處理，InstallGuide.test.js 已經記錄過這件事）——拿 getComputedStyle
  // 斷言 z-index 數值會是一條永遠讀到瀏覽器預設值（auto）的假測試。這裡改成
  // 鎖原始碼文字本身：.boss-hud 的 CSS 規則必須明確宣告比 .corner-tr（定義
  // 在 layout.css，共用給四個角落）更高的 z-index，這樣魔王血量永遠畫在
  // 最上層，不必依賴 DOM 順序（DOM 順序在下一次重排模板時可能翻盤，z-index
  // 打平手時瀏覽器就是照 DOM 順序決定疊放，這正是這個 bug 的成因）。
  //
  // 這條鎖得到：z-index 的數值大小關係（原始碼文字），以及「不小心把
  // boss-hud 的 z-index 改回 3 或更低」這種回歸。
  // 這條鎖不到：boss-hud 與 corner-tr 在真機上到底還會不會有其他方式重疊
  // （例如未來改版面讓 boss-hud 整個位移），也鎖不到「z-index 4 這個數字
  // 有沒有跟其他未來新增的圖層打架」——這些只能靠人工複查新增圖層時對照
  // 這份 z-index 表（App.vue／BattleView.vue 現有的堆疊註解）。
  it('.boss-hud 的 z-index 明確高於 layout.css 裡 corner 系列共用的 z-index', () => {
    // 先取出 <style scoped> 區塊、挖掉 /* ... */ 註解，再找規則邊界：
    // BattleView.vue 在 .boss-hud 這條規則正上方有一大段說明性 CSS 註解
    // （手算 corner-tr 展開清單的高度那段），註解結尾是 `*/` 不是 `}`，
    // 不挖掉註解的話「前面必須是 } 或字串開頭」這個邊界判斷會找不到匹配
    // ——這是這條測試第一版突變測試時自己先踩到的假陰性，不是刻意設計。
    const styleMatch = battleViewSource.match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)
    expect(styleMatch, '找不到 BattleView.vue 的 <style scoped>').not.toBeNull()
    const styleText = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '')

    // 只在「前面是 } 或字串開頭」時才算一條新規則的開頭，排除掉
    // ".hero-hud, .boss-hud { ... }" 這種共用選擇器裡的 .boss-hud（它是
    // 逗號分隔選擇器清單的一部分，不是獨立規則，z-index 是共用的 3，
    // 拿它來比較的話這條測試永遠不會紅）。
    const bossHudRuleMatch = styleText.match(/(?:^|\})\s*\.boss-hud\s*\{([^}]*)\}/)
    expect(bossHudRuleMatch, '找不到 .boss-hud 自己的（非共用）CSS 規則').not.toBeNull()
    const bossHudZIndexMatch = bossHudRuleMatch[1].match(/z-index:\s*(\d+)/)
    expect(bossHudZIndexMatch, '.boss-hud 必須明確宣告自己的 z-index').not.toBeNull()
    const bossHudZIndex = Number(bossHudZIndexMatch[1])

    // corner-tr 的 z-index 定義在 layout.css（.corner-tl/.corner-tr/
    // .corner-bl/.corner-br 共用一條規則）。直接讀檔案本身、不寫死數字：
    // 現況是 3，但這裡的比較基準跟著檔案內容走，不是跟著記憶裡的舊數字走。
    const layoutCss = readFileSync('src/styles/layout.css', 'utf8')
    const cornerRuleMatch = layoutCss.match(/\.corner-tl,\s*\.corner-tr,\s*\.corner-bl,\s*\.corner-br\s*\{([^}]*)\}/)
    expect(cornerRuleMatch, '找不到 corner 系列的共用 z-index 規則').not.toBeNull()
    const cornerZIndexMatch = cornerRuleMatch[1].match(/z-index:\s*(\d+)/)
    expect(cornerZIndexMatch).not.toBeNull()
    const cornerZIndex = Number(cornerZIndexMatch[1])

    expect(bossHudZIndex).toBeGreaterThan(cornerZIndex)
  })
})

// ---------------------------------------------------------------------------
// 魔王造型（BossSprite）與戰鬥場景層。
//
// 這一組鎖得到：三種狀態的 class 在正確的 state 下接到 BossSprite、場景層
// 不吃觸控也不搶圖層、魔王維持純裝飾。
// 這一組鎖不到：**畫出來好不好看**。Q 版夠不夠可愛、三種狀態一眼分不分得
// 出來、場景會不會搶戲、在 834×1194／1024×1366 兩個方向上實際的視覺平衡
// ——jsdom 不排版也不繪圖，這些永遠只能靠人看真機。
// 更多「鎖得到／鎖不到」的聲明見 BossSprite.test.js 檔頭。
// ---------------------------------------------------------------------------

describe('BattleView：魔王造型接線（沿用既有的 bossStruck / hasPendingTrap，不另起一套狀態機）', () => {
  it('魔王已經是 BossSprite（inline SVG），不再是那個 emoji，而且維持 aria-hidden', async () => {
    const { el, app } = mount()
    await nextTick()

    const sprite = el.querySelector('.arena__boss .boss-sprite')
    expect(sprite, '魔王側必須有 BossSprite').not.toBeNull()
    expect(sprite.getAttribute('aria-hidden')).toBe('true')
    expect(sprite.querySelector('svg'), '造型必須是 inline SVG').not.toBeNull()
    expect(el.textContent, '不該再有 emoji 版魔王').not.toContain('👹')

    app.unmount()
    el.remove()
  })

  it('attack 事件：.boss-sprite 加上 struck，STRUCK_MS(300ms) 之後自己收掉', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('struck')).toBe(false)

    fireEvents([{ type: 'attack', damage: 20, streak: 1 }])
    await nextTick()
    expect(sprite.classList.contains('struck')).toBe(true)

    await vi.advanceTimersByTimeAsync(350)
    await nextTick()
    expect(sprite.classList.contains('struck'), '被打是一次性的短動畫，不能卡住不放').toBe(false)

    app.unmount()
    el.remove()
  })

  it('pendingTraps 非空（陷阱即將成立）：.boss-sprite 加上 charging；陷阱解除後拿掉', async () => {
    const { el, app } = mount()
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('charging')).toBe(false)

    // 蓄力＝「該把手機收起來／坐回去了」的視覺預告，判準只有一個：
    // battle.pendingTraps 非空（跟 hasPendingTrap 是同一個既有 computed）。
    fakeState.battle = makeBattle({
      pendingTraps: [{ trapId: 'phone-1', kind: 'phone', deadlineAtElapsed: 20_000 }],
    })
    await nextTick()
    expect(sprite.classList.contains('charging')).toBe(true)

    fakeState.battle = makeBattle({ pendingTraps: [] })
    await nextTick()
    expect(sprite.classList.contains('charging')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('.arena__boss 既有的 struck／charging class 仍然是同一組 state 驅動（兩個出口、一份真相）', async () => {
    const { el, app } = mount()
    await nextTick()

    fakeState.battle = makeBattle({
      pendingTraps: [{ trapId: 'phone-1', kind: 'phone', deadlineAtElapsed: 20_000 }],
    })
    await nextTick()

    const section = el.querySelector('.arena__boss')
    const sprite = el.querySelector('.boss-sprite')
    expect(section.classList.contains('charging')).toBe(true)
    expect(sprite.classList.contains('charging')).toBe(section.classList.contains('charging'))

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// 魔王大招（spec 第 280 行：「陷阱生效 → 魔王大招：較大範圍的特效」）。
//
// 實作原本只有「回血數字＋積分 −100」，飛行特效與閃紅框跟「姿態不良被反擊」
// 共用同一組——也就是說魔王放大招在畫面上跟普通反擊長得一模一樣。而陷阱有
// 20 秒待確認期（期間不扣分、不回血、不中斷連擊、也不發聲），那段緊張感
// 累積到最後沒有視覺出口。
//
// 這一組鎖得到：大招只在 trapCommitted 出現、不會在普通反擊出現（「一眼看
// 得出不一樣」這件事的結構性下限）、播完會自己收掉、掛在非互動的戰場帶上、
// reduced-motion 下不會變成什麼都沒發生。
// 這一組鎖不到：它**看起來夠不夠有份量**、對不對得起前面 20 秒的鋪陳。
// ---------------------------------------------------------------------------

describe('BattleView：魔王大招（陷阱生效）必須跟普通反擊明顯不同', () => {
  it('trapCommitted 事件：出現大招特效節點（底色＋3 個衝擊環＋6 根尖刺），ULTIMATE_MS 後自己收掉', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    expect(el.querySelector('.ult')).toBeNull()

    fireEvents([{
      type: 'trapCommitted', trapId: 'phone-1', kind: 'phone', bossHeal: 10, scorePenalty: 100,
    }])
    await nextTick()

    const ult = el.querySelector('.ult')
    expect(ult, '陷阱生效必須有大招特效').not.toBeNull()
    expect(ult.querySelector('.ult-flash')).not.toBeNull()
    expect(ult.querySelectorAll('.ult-ring').length).toBe(3)
    expect(ult.querySelectorAll('.ult-spike').length).toBe(6)

    await vi.advanceTimersByTimeAsync(900)
    await nextTick()
    expect(el.querySelector('.ult'), '大招播完要自己收掉，不能常駐').toBeNull()

    app.unmount()
    el.remove()
  })

  it('playerDamage（姿態不良被普通反擊）不會放大招——這是「一眼看得出不一樣」的結構性下限', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'playerDamage', amount: 3, playerHp: 97, reason: 'slouch' }])
    await nextTick()

    // 反向佐證：普通反擊該有的東西確實都有（不是「事件根本沒被處理」這種假陽性）
    expect(el.querySelectorAll('.bolt.to-hero.fly').length).toBe(1)
    expect(el.querySelector('.arena__hero').classList.contains('struck')).toBe(true)
    // 但大招不該出現
    expect(el.querySelector('.ult'), '普通反擊不得放大招，否則兩者又長一樣了').toBeNull()

    app.unmount()
    el.remove()
  })

  it('連續兩次 trapCommitted：兩個大招節點各自有唯一 key，不是重用同一個節點（重用的話第二發不會從頭播）', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    fireEvents([{ type: 'trapCommitted', trapId: 'a', kind: 'phone', bossHeal: 10, scorePenalty: 100 }])
    await nextTick()
    const first = el.querySelector('.ult')

    await vi.advanceTimersByTimeAsync(200) // 第一發還在播
    fireEvents([{ type: 'trapCommitted', trapId: 'b', kind: 'away', bossHeal: 10, scorePenalty: 100 }])
    await nextTick()

    const all = [...el.querySelectorAll('.ult')]
    expect(all.length, '第二發要掛一個全新節點，才會從 0% 重新播').toBe(2)
    expect(all[0]).toBe(first)

    app.unmount()
    el.remove()
  })

  it('大招期間 BossSprite 掛上 ultimate（魔王本體與爆發特效共用同一份真相，不是兩個計時器）', async () => {
    vi.useFakeTimers()
    const { el, app } = mount()
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('ultimate')).toBe(false)

    fireEvents([{
      type: 'trapCommitted', trapId: 'phone-1', kind: 'phone', bossHeal: 10, scorePenalty: 100,
    }])
    await nextTick()
    expect(sprite.classList.contains('ultimate')).toBe(true)

    await vi.advanceTimersByTimeAsync(900)
    await nextTick()
    expect(sprite.classList.contains('ultimate')).toBe(false)
    expect(el.querySelector('.ult')).toBeNull() // 兩者同進同出

    app.unmount()
    el.remove()
  })

  it('大招掛在 .arena__field（pointer-events:none、z-index 低於角落按鈕與血條），不會擋到暫停／結束', async () => {
    const { el, app } = mount()
    await nextTick()

    fireEvents([{
      type: 'trapCommitted', trapId: 'phone-1', kind: 'phone', bossHeal: 10, scorePenalty: 100,
    }])
    await nextTick()

    // 結構性保證：戰場帶本身就是不吃觸控、z-index 2 的圖層（layout.css），
    // 所以大招不可能蓋住 z-index 3 的角落按鈕與 z-index 4 的魔王血條。
    expect(el.querySelector('.arena__field .ult'), '大招必須待在戰場帶那一層').not.toBeNull()
    const layoutCss = readFileSync('src/styles/layout.css', 'utf8')
    const fieldRule = layoutCss.match(/\.arena__field\s*\{([^}]*)\}/)[1]
    expect(fieldRule).toMatch(/pointer-events:\s*none/)

    // 反向佐證：兩顆角落按鈕在大招期間依然點得到
    const pauseBtn = el.querySelector('.pause')
    pauseBtn.click()
    expect(togglePauseSpy).toHaveBeenCalledTimes(1)

    app.unmount()
    el.remove()
  })

  it('reduced-motion 下大招不會變成什麼都沒發生：節點照樣出現，且有靜態呈現的 CSS 分支', async () => {
    // 這一刻使用者剛被扣 100 積分，畫面必須說清楚發生了什麼。
    // launch()（飛行特效）在 reduced 下是直接 return 的，大招刻意不比照——
    // 它改成靜態呈現，不是消失。
    const original = window.matchMedia
    window.matchMedia = () => ({ matches: true })

    const { el, app } = mount()
    await nextTick()

    fireEvents([{
      type: 'trapCommitted', trapId: 'phone-1', kind: 'phone', bossHeal: 10, scorePenalty: 100,
    }])
    await nextTick()

    expect(el.querySelectorAll('.bolt.fly').length).toBe(0) // 飛行特效照既有作法關掉
    expect(el.querySelector('.ult'), 'reduced 下大招節點仍要掛出來').not.toBeNull()
    expect(el.querySelectorAll('.dmg').length).toBeGreaterThan(0) // 數字仍看得到

    // CSS 分支真的存在（jsdom 不做級聯，只能掃原始碼——同 Important 2 的作法）
    const styleText = battleViewSource
      .match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const reduceBlock = styleText.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)
    expect(reduceBlock).not.toBeNull()
    expect(reduceBlock[1], '.ult-flash 在 reduced 下要停成靜態的底色').toMatch(/\.ult-flash\s*\{[^}]*animation:\s*none/)
    expect(reduceBlock[1], '.ult-ring 在 reduced 下要停住不擴張').toMatch(/\.ult-ring\s*\{[^}]*animation:\s*none/)
    expect(reduceBlock[1], '.ult-spike 在 reduced 下要停在原位').toMatch(/\.ult-spike\s*\{[^}]*animation:\s*none/)

    app.unmount()
    el.remove()
    window.matchMedia = original
  })
})

describe('BattleView：場景層是背景，不得攔截觸控、也不得蓋過任何既有 UI', () => {
  // 這個專案出過「安裝橫幅蓋住結算頁唯一兩顆按鈕」的事故。場景層 inset:0
  // 鋪滿整個 .arena__boss，幾何上**確實**會跟 .boss-hud、橫式的 corner-tr/br、
  // 直式的 corner-bl/br 重疊（手算在 BattleView.vue 的 .arena__scene 註解裡）。
  // 它不構成遮擋的理由不是幾何，是結構：pointer-events:none ＋ 全畫面最低的
  // z-index。這兩件事就是這裡要鎖住的東西——它們不隨文案長度、項目數、
  // 螢幕尺寸改變，比手算的間距穩固。
  //
  // 鎖得到：pointer-events 與 z-index 的原始碼事實（含與 corner 系列的大小關係）。
  // 鎖不到：場景的顏色在真機上會不會讓角落按鈕變得難讀——那要人看。
  function scopedStyle() {
    const styleMatch = battleViewSource.match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)
    expect(styleMatch).not.toBeNull()
    return styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('場景節點存在、是純裝飾（aria-hidden），而且只鋪在魔王側（不疊在鏡頭畫面上）', async () => {
    const { el, app } = mount()
    await nextTick()

    const scene = el.querySelector('.arena__scene')
    expect(scene).not.toBeNull()
    expect(scene.getAttribute('aria-hidden')).toBe('true')
    // 只在魔王側：英雄側整片是即時鏡頭影像，任何圖案疊上去都只會讓畫面變雜亂
    expect(el.querySelector('.arena__boss .arena__scene')).not.toBeNull()
    expect(el.querySelector('.arena__hero .arena__scene')).toBeNull()

    app.unmount()
    el.remove()
  })

  it('.arena__scene 宣告 pointer-events: none', () => {
    const rule = scopedStyle().match(/(?:^|\})\s*\.arena__scene\s*\{([^}]*)\}/)
    expect(rule, '找不到 .arena__scene 自己的 CSS 規則').not.toBeNull()
    expect(
      rule[1],
      '場景是背景不是內容：少了 pointer-events:none，它會吃掉魔王側的所有觸控',
    ).toMatch(/pointer-events:\s*none/)
  })

  it('.arena__scene 的 z-index 低於四個角落按鈕（layout.css）與戰場帶（.arena__field）', () => {
    const style = scopedStyle()
    const sceneRule = style.match(/(?:^|\})\s*\.arena__scene\s*\{([^}]*)\}/)
    const sceneZ = Number(sceneRule[1].match(/z-index:\s*(\d+)/)?.[1])
    expect(Number.isFinite(sceneZ), '.arena__scene 必須明確宣告自己的 z-index').toBe(true)

    // 跟既有 Important 2 那條測試同一路做法：比較基準讀檔案本身，不寫死數字。
    const layoutCss = readFileSync('src/styles/layout.css', 'utf8')
    const cornerZ = Number(
      layoutCss.match(/\.corner-tl,\s*\.corner-tr,\s*\.corner-bl,\s*\.corner-br\s*\{([^}]*)\}/)[1]
        .match(/z-index:\s*(\d+)/)[1],
    )
    const fieldZ = Number(
      layoutCss.match(/\.arena__field\s*\{([^}]*)\}/)[1].match(/z-index:\s*(\d+)/)[1],
    )
    const bossHudZ = Number(
      style.match(/(?:^|\})\s*\.boss-hud\s*\{([^}]*)\}/)[1].match(/z-index:\s*(\d+)/)[1],
    )

    expect(sceneZ).toBeLessThan(cornerZ)
    expect(sceneZ).toBeLessThan(fieldZ)
    expect(sceneZ).toBeLessThan(bossHudZ)
  })
})

// ---------------------------------------------------------------------------
// 重大違規 debuff 的畫面顯示（機制在 focusStateMachine.js，這裡只驗「說出來」）
// ---------------------------------------------------------------------------
describe('BattleView：debuff 倒數', () => {
  it('中 debuff 時顯示「再專心 N 秒」，秒數無條件進位', () => {
    fakeState.battle = makeBattle({ debuffed: true, debuffFocusRemainMs: 12_300 })
    const { el, app } = mount({ videoEl: null })

    const p = el.querySelector('.debuff')
    expect(p, '中 debuff 就必須說出來——不說的話體感只會是「怎麼今天打得特別慢」').not.toBeNull()
    // 12300ms 進位成 13 秒：顯示 12 會讓人在還沒解除時就看到倒數歸零
    expect(p.textContent).toContain('13')
    expect(p.textContent.trim().length).toBeLessThanOrEqual(15)
    for (const w of BANNED_WORDS) expect(p.textContent).not.toContain(w)

    app.unmount()
    el.remove()
  })

  it('顯示的是「還要再專心多久」，不是「還剩多久過期」', () => {
    // 兩者差別很大：前者指向一個他做得到的動作，後者只是叫他等。
    // 這條測試用兩個差很多的數字把「讀錯欄位」逼出來。
    fakeState.battle = makeBattle({
      debuffed: true, debuffFocusRemainMs: 5_000, debuffRemainMs: 88_000,
    })
    const { el, app } = mount({ videoEl: null })

    const text = el.querySelector('.debuff').textContent
    expect(text).toContain('5')
    expect(text, '不得顯示保險絲的剩餘秒數（那個數字對使用者沒有意義）').not.toContain('88')

    app.unmount()
    el.remove()
  })

  it('沒中 debuff 就不顯示', () => {
    fakeState.battle = makeBattle({ debuffed: false, debuffFocusRemainMs: 0 })
    const { el, app } = mount({ videoEl: null })
    expect(el.querySelector('.debuff')).toBeNull()
    app.unmount()
    el.remove()
  })

  it('重整旗鼓期間不顯示——那時兩個計時器都凍結，放一個不會動的倒數只會讓人以為卡住', () => {
    fakeState.battle = makeBattle({
      debuffed: true, debuffFocusRemainMs: 20_000, regrouping: true,
    })
    const { el, app } = mount({ videoEl: null })
    expect(el.querySelector('.debuff')).toBeNull()
    // 重整旗鼓本身的提示還是要在
    expect(el.textContent).toContain('重整旗鼓')
    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// Blocking B2／B3：攻擊被「畫面上有東西」封鎖時，畫面上必須有一句話
//
// 上一版的時間軸（複審逐格走過一次）：
//   t=0    東西被偵測到 → 魔王從此不掉血，**畫面上什麼都沒有**
//   t=3s   CoachBanner「畫面裡有別的東西」＋撤銷鈕＋20 秒倒數
//   t=23s  卡片 TTL 過期消失。**魔王仍然不掉血，畫面上再也沒有任何字**
//   之後   坐姿完美、體力滿格、時鐘在跑、分數不動、魔王血條不動、沒有訊息
//
// 這一格沒有 TTL，跟封鎖同生共死。它同時是撤銷鈕「看得出來有用」的另一半：
// 按下去的那一刻 objectBlocking 轉 false，這句話當場消失。
// ---------------------------------------------------------------------------
describe('BattleView：攻擊被封鎖時的常駐提示（Blocking B2／B3）', () => {
  it('objectBlocking 時顯示「把東西移開就能打」——指向動作，不描述這個人', () => {
    fakeState.battle = makeBattle({ objectBlocking: true })
    const { el, app } = mount({ videoEl: null })

    const p = el.querySelector('.debuff')
    expect(p, '攻擊被封鎖卻一個字都沒有，正是這次要修掉的靜默失效').not.toBeNull()
    expect(p.textContent).toContain('把東西移開')
    expect(p.textContent.trim().length).toBeLessThanOrEqual(15)
    for (const w of BANNED_WORDS) expect(p.textContent).not.toContain(w)

    app.unmount()
    el.remove()
  })

  it('封鎖解除（例如按了撤銷）就當場消失——那是小孩看得到的「有用」', () => {
    fakeState.battle = makeBattle({ objectBlocking: false })
    const { el, app } = mount({ videoEl: null })
    expect(el.querySelector('.debuff')).toBeNull()
    app.unmount()
    el.remove()
  })

  it('同時被封鎖又中 debuff 時，優先講障礙，不講那個不會動的倒數', () => {
    // 被封鎖時 debuff 的專注累積器本來就不會前進（解除條件含 !objectBlocking），
    // 所以「再專心 N 秒」在那個當下是一句做不到的話——那個數字一秒都不會動，
    // 而小孩明明正坐得筆直。這正是複審 I-1 指出的那種「文案承諾做不到的事」。
    fakeState.battle = makeBattle({
      objectBlocking: true, debuffed: true, debuffFocusRemainMs: 30_000,
    })
    const { el, app } = mount({ videoEl: null })

    const text = el.querySelector('.debuff').textContent
    expect(text).toContain('把東西移開')
    expect(text, '不得顯示一個一秒都不會動的倒數').not.toContain('再專心')

    app.unmount()
    el.remove()
  })

  it('重整旗鼓期間不顯示——那時本來就不能攻擊，講「把東西移開就能打」是假話', () => {
    fakeState.battle = makeBattle({ objectBlocking: true, regrouping: true })
    const { el, app } = mount({ videoEl: null })
    expect(el.querySelector('.debuff')).toBeNull()
    expect(el.textContent).toContain('重整旗鼓')
    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// 骨架線疊加層（PoseSkeletonOverlay）
//
// 這是全專案唯一一條把**原始 landmark 座標**送進畫面元件的路徑。BattleView
// 在這條路徑上只做一件事：把 `session.inference()` 交給疊加層。它自己**不**
// 碰座標、不存座標、不轉送座標——這裡的測試要證明的就是這一點，而且要證明
// 座標沒有因為多了這條路徑而流進戰鬥畫面的 DOM。
// ---------------------------------------------------------------------------
describe('BattleView：骨架線疊加層的接線與隱私', () => {
  // jsdom 沒有 canvas 實作；不給假的 2D context，疊加層會安靜地不畫，
  // 那樣下面那條 DOM canary 就會變成「綠得沒有理由」（Ruling CH (a)）。
  const drawn = { strokes: 0 }
  function stubCanvas() {
    drawn.strokes = 0
    window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      lineWidth: 0, lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '',
      clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
      stroke() { drawn.strokes += 1 },
    }))
  }

  function landmarksWithCanary() {
    const pts = []
    for (let i = 0; i < 33; i += 1) pts.push({ x: 0.5, y: 0.5, visibility: 0.9 })
    pts[7] = { x: 0.123456, y: 0.222222, visibility: 0.9 }
    pts[8] = { x: 0.654321, y: 0.222222, visibility: 0.9 }
    pts[11] = { x: 0.111111, y: 0.777777, visibility: 0.9 }
    pts[12] = { x: 0.888888, y: 0.777777, visibility: 0.9 }
    return pts
  }

  it('掛載時向 inference.onPoseFrame() 訂閱一次，卸載時解除', async () => {
    stubCanvas()
    const { el, app } = mount({ videoEl: null })
    await nextTick()

    expect(onPoseFrameSpy).toHaveBeenCalledTimes(1)
    expect(poseObservers.length).toBe(1)

    app.unmount()
    // 卸載後還留著訂閱＝推論每一幀都在呼叫一個已經不存在的畫面。
    expect(poseObservers.length).toBe(0)
    el.remove()
  })

  it('推一幀帶哨兵座標的 landmarks 之後，戰鬥畫面的 DOM 不得出現任何座標值', async () => {
    stubCanvas()
    const { el, app } = mount({ videoEl: null })
    await nextTick()

    poseObservers[0](landmarksWithCanary())
    await nextTick()

    expect(drawn.strokes, '這一幀應該真的畫了線（否則這條測試綠得沒有理由）').toBe(1)
    for (const canary of ['0.123456', '0.654321', '0.222222', '0.777777', '0.888888', '0.111111']) {
      expect(el.innerHTML, `隱私紅線：DOM（含屬性值）不得出現座標 ${canary}`).not.toContain(canary)
    }

    app.unmount()
    el.remove()
  })

  it('疊加層的 <canvas> 不吃觸控，暫停／結束兩顆按鈕照樣在它上面', async () => {
    stubCanvas()
    const { el, app } = mount({ videoEl: null })
    await nextTick()

    const canvas = el.querySelector('canvas.skeleton')
    expect(canvas, '戰鬥畫面應該有骨架線畫布').not.toBeNull()
    // 版面的證明在 PoseSkeletonOverlay 的 scoped style（pointer-events:none、
    // z-index 0）與它自己的護欄；這裡鎖的是「它確實在英雄側、而且在鏡像
    // <video> 後面」這個結構關係——反過來（疊在角落按鈕那一層）會讓復原
    // 路徑構不著，那是這個專案吃過虧的失敗形狀。
    const hero = el.querySelector('.arena__hero')
    expect(hero.contains(canvas)).toBe(true)
    const video = hero.querySelector('video.cam')
    expect(video.compareDocumentPosition(canvas) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    app.unmount()
    el.remove()
  })

  it('BattleView 自己不得碰座標：它只把 inference 交出去，沒有任何 pose 回呼', () => {
    // Ruling DK：護欄裝在違規會發生的地方。座標流進 BattleView 的唯一可能
    // 寫法，就是它自己去 onPoseFrame() 登記一個回呼然後把拿到的東西存起來。
    // 兩層都要挖：這個檔案大量使用「多行 HTML 註解、延續行沒有逐行前綴」
    // 的寫法（見 collectVueLengthCandidates 那段同樣的教訓），只挖整行的
    // JS 註解會漏掉模板裡那段解釋骨架線的說明，讓這條護欄永遠是紅的。
    const code = blankPureCommentLines(stripHtmlCommentSpans(battleViewSource))
    expect(code, 'BattleView 不得自己訂閱 pose 影格').not.toContain('onPoseFrame')
    expect(code, 'BattleView 不得出現 landmark 字樣').not.toMatch(/landmark/i)
  })

  it('把 session.state.posture 原樣傳給疊加層的 :posture（安全彙總字串，不是座標）', async () => {
    // 骨架線本身「哪個姿態該畫什麼顏色」的邏輯已經在
    // PoseSkeletonOverlay.test.js 測過；這裡只驗證 BattleView 這一端真的把
    // s.posture 接了出去，不是接了別的東西（例如整包 s、或漏接變成校準畫面
    // 那種 null）。:posture 不是會落在 DOM 上的屬性（傳進 canvas 元件的
    // prop），所以用「畫出來的顏色」反推——這需要一個會記錄 strokeStyle 的
    // 假 context，比上面 stubCanvas() 的精簡版多記一個欄位。
    const tokensCss = readFileSync('src/styles/tokens.css', 'utf8')
    const danger = tokensCss.match(/--c-danger:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
    const warn = tokensCss.match(/--c-warn:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
    expect(danger).not.toBe(undefined)
    expect(warn).not.toBe(undefined)

    let seenStroke = ''
    const recordingCtx = {
      lineWidth: 0, lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '',
      clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
      stroke() { seenStroke = recordingCtx.strokeStyle },
    }
    window.HTMLCanvasElement.prototype.getContext = vi.fn(() => recordingCtx)

    fakeState.posture = 'slouch'
    const { el, app } = mount({ videoEl: null })
    await nextTick()
    poseObservers[0](landmarksWithCanary())
    await nextTick()
    expect(seenStroke, `posture=slouch 應該畫成 --c-danger（${danger}）`).toBe(danger)

    fakeState.posture = 'upright'
    await nextTick()
    poseObservers[0](landmarksWithCanary())
    await nextTick()
    expect(seenStroke, `posture=upright 應該畫成 --c-warn（${warn}）`).toBe(warn)

    app.unmount()
    el.remove()
  })
})

// ---------------------------------------------------------------------------
// 姿態邊緣提示（使用者要求：「異常就在人像那直接顯示、畫面邊緣閃漸層紅色」）
// ---------------------------------------------------------------------------
describe('BattleView：姿態邊緣提示', () => {
  it('posture=upright 時不顯示（沒有 show class）', async () => {
    fakeState.posture = 'upright'
    const { el, app } = mount({ videoEl: null })
    await nextTick()

    const vignette = el.querySelector('.posture-vignette')
    expect(vignette, '找不到姿態邊緣提示的節點').not.toBeNull()
    expect(vignette.classList.contains('show')).toBe(false)

    app.unmount()
    el.remove()
  })

  it.each(['slouch', 'forwardHead', 'gazeAway'])(
    'posture=%s（異常）時顯示（有 show class）——不列舉異常字串，只認「不是 upright」',
    async (posture) => {
      fakeState.posture = posture
      const { el, app } = mount({ videoEl: null })
      await nextTick()

      expect(el.querySelector('.posture-vignette').classList.contains('show')).toBe(true)

      app.unmount()
      el.remove()
    },
  )

  it('姿態中途從 upright 變成 slouch，同一顆節點跟著切換 class（不需要重新掛載）', async () => {
    fakeState.posture = 'upright'
    const { el, app } = mount({ videoEl: null })
    await nextTick()
    expect(el.querySelector('.posture-vignette').classList.contains('show')).toBe(false)

    fakeState.posture = 'slouch'
    await nextTick()
    expect(el.querySelector('.posture-vignette').classList.contains('show')).toBe(true)

    app.unmount()
    el.remove()
  })

  it('drowsy 不觸發姿態邊緣提示（嗜睡是另一個維度，遊戲已有自己的溫和處理方式）', async () => {
    fakeState.posture = 'upright'
    fakeState.drowsy = true
    const { el, app } = mount({ videoEl: null })
    await nextTick()

    expect(el.querySelector('.posture-vignette').classList.contains('show')).toBe(false)

    app.unmount()
    el.remove()
    fakeState.drowsy = false
  })

  // 下面三條是原始碼層的 CSS 護欄，共用同一份「挖掉註解的 <style scoped>」：
  // 這個 CSS 規則正上方的說明文字逐字寫著「pointer-events: none」與
  // 「radial-gradient(...transparent...)」——不挖掉註解，這幾條護欄會因為
  // 註解本身就含有那些字樣而綠得沒有理由（同一個教訓 PoseSkeletonOverlay.
  // test.js 的 OVERLAY_STYLE 已經踩過一次）。
  const pureStyle = battleViewSource
    .match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')

  it('pointer-events:none——邊緣提示不吃觸控，暫停／結束兩顆按鈕在它之上照樣按得到', async () => {
    fakeState.posture = 'slouch'
    const { el, app } = mount({ videoEl: null })
    await nextTick()

    // 版面的證明（z-index 2 低於角落按鈕的 3、boss-hud 的 4）寫在 CSS 註解裡，
    // 這裡鎖的是結構事實：pointer-events:none 這個宣告真的在原始碼裡，
    // 而且節點確實在 .arena 底下、跟角落按鈕是手足關係，不是疊在它們上面
    // 的子節點（子節點才會真的擋住點擊，手足關係只是視覺層疊，由 z-index
    // 決定誰在上面）。
    expect(pureStyle).toMatch(/\.posture-vignette\s*\{[^}]*pointer-events:\s*none/)
    const vignette = el.querySelector('.posture-vignette')
    const pauseBtn = el.querySelector('.corner-tl, .corner-bl, .corner-br')
    expect(vignette.contains(pauseBtn ?? document.createElement('div'))).toBe(false)

    app.unmount()
    el.remove()
  })

  it('中心留白：radial-gradient 從 transparent 開始，不是整片實色', () => {
    expect(pureStyle).toMatch(/\.posture-vignette\s*\{[^}]*radial-gradient\([^)]*transparent/)
  })

  it('reduced-motion 下不做淡入淡出（跟這個檔案既有的 reduced-motion 區塊同一個原則）', () => {
    const reduceBlock = pureStyle
      .match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(reduceBlock, '找不到 reduced-motion 區塊').not.toBe('')
    expect(reduceBlock).toMatch(/\.posture-vignette\s*\{[^}]*transition:\s*none/)
  })
})

describe('BattleView：第二形態場景換色（血月）的 CSS 規則真的接上了，不是只有 class 切換', () => {
  const pureStyle = battleViewSource
    .match(/<style[^>]*scoped[^>]*>([\s\S]*?)<\/style>/)[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')

  it('月亮換成 --c-danger（血月），沒有發明新色碼', () => {
    expect(pureStyle).toMatch(/\.arena__scene\.phase2\s+\.scene-moon\s*\{[^}]*fill:\s*var\(--c-danger\)/)
  })

  it('山稜線在 phase2 加深（opacity 提高），這是靜態換色不是動畫，不必進 reduced-motion 分支', () => {
    expect(pureStyle).toMatch(/\.arena__scene\.phase2\s+\.scene-ridge-near\s*\{[^}]*opacity:/)
    expect(pureStyle).toMatch(/\.arena__scene\.phase2\s+\.scene-ridge-far\s*\{[^}]*opacity:/)
  })
})
