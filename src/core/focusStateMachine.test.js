import { describe, it, expect } from 'vitest'
import { createFocusStateMachine } from './focusStateMachine.js'
import { BATTLE, DEMO, bossHpFor } from './battleConfig.js'
import { POSTURE_COPY } from '../data/copy/posture.js'

const MIN = 60_000
const TICK = 250
// makeFsm() 預設 15 分鐘的魔王血量上限——bossHpFor 套用了 BATTLE.regroupMarginRatio
// 的安全邊際（裁決 A），所以不是零邊際名目值 144×15=2160，而是再打九折。算出來用，
// 不要在下面各條測試裡重複寫死這個數字，數值一改這裡就會自動跟著對。
const BOSS_HP_15MIN = bossHpFor(15 * MIN, false)

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
    expect(s.bossHpMax).toBe(BOSS_HP_15MIN)
    expect(s.bossHp).toBe(BOSS_HP_15MIN)
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
    expect(s.bossHp).toBe(BOSS_HP_15MIN - 60)
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
    // 每 10 秒中前 6 秒端正、後 4 秒駝背 → 專注率精確 60%。
    // 用 (t - TICK) % 10_000 < 6000，不是 t % 10_000 <= 6000：後者在每個週期起點
    // t % 10000 === 0 那個 tick 也會算進端正（<=0 恆成立），15 分鐘、TICK=250 下
    // 會把 40 個 tick 裡的 25 個算成端正，實際專注率變成 62.5% 而不是 60%，
    // 餘裕會被高估將近一倍。這裡的寫法讓每個 tick 對應到週期內唯一一個位置，
    // 不會重複計算週期邊界。
    for (let t = TICK; t <= 15 * MIN; t += TICK) {
      const pos = (t - TICK) % 10_000
      fsm.tick({ t, posture: pos < 6000 ? 'upright' : 'slouch', drowsy: false, phoneVisible: false })
    }
    const s = fsm.snapshot()
    expect(s.result).toBe('victory')
  })

  /**
   * 最壞分布：重整旗鼓彈出的那 10 秒，小孩的自然反應是坐直（遊戲自己教出來的
   * 行為）——這段時間滿滿的可攻擊時間被浪費掉，而且完全不消耗壞姿態預算。
   * 用「重整旗鼓期間一律端正」建構最壞情境，再從外部注入剛好 0.4×時長的壞姿態
   * 時間（只在非重整旗鼓的時候扣）：可以證明整場的端正比例會精確等於 60%
   * （不用試湊、不用二分逼近），且這是所有能維持整體 60% 專注率的分布中，
   * 對魔王血量公式最不利的一種（active_bad = 0.4T − R(1−f)，f=1 時 R 完全
   * 抵消、active_bad 取到上界 0.4T，f<1 時 active_bad 反而更小、餘裕更寬）。
   */
  function runWorstCase(minutes) {
    const durationMs = minutes * MIN
    const fsm = createFocusStateMachine({ durationMs, demoMode: false })
    let activeBadRemainingMs = 0.4 * durationMs
    for (let t = TICK; t <= durationMs; t += TICK) {
      const regrouping = fsm.snapshot().regrouping
      let posture
      if (regrouping) {
        posture = 'upright' // 重整旗鼓彈出，小孩坐直
      } else if (activeBadRemainingMs > 0) {
        posture = 'slouch'
        activeBadRemainingMs -= TICK
      } else {
        posture = 'upright'
      }
      fsm.tick({ t, posture, drowsy: false, phoneVisible: false })
    }
    return fsm.snapshot()
  }

  it('60% 專注率在最壞分布下仍能打倒魔王（重整旗鼓的安全邊際驗證）', () => {
    // 哨兵要站在最窄的那個口，不是端點：5–40 分鐘逐分鐘全掃後，能承受的最大
    // ratio 在 39 分鐘最緊（0.8833），37／28／40 分鐘次之，不是直覺以為的
    // 40 分鐘端點最緊。只測 40 分鐘的話，日後有人把 regroupMarginRatio 調到
    // 例如 0.885（40 分鐘餘裕還有 +1、這條測試會綠燈放行），但 39 分鐘餘裕已經
    // 是 −1——一個真的做到 60% 專注率的小孩在 39 分鐘那一輪會打不倒魔王，
    // CI 卻一聲不吭。5 分鐘也留著：那是絕對餘裕次數最小的一端（+5 次攻擊），
    // 跟長時段的「相對餘裕最緊」是兩種不同的緊，都要守住。
    // 這條測試沒有被加進來之前，日後有人調 regroupMs 或 postureDamage，CI 不會
    // 有任何東西叫。
    for (const minutes of [5, 24, 28, 37, 39, 40]) {
      const s = runWorstCase(minutes)
      expect(s.result, `${minutes} 分鐘應該 victory`).toBe('victory')
    }
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
    expect(fsm.snapshot().playerHp).toBe(BATTLE.playerHpMax - 3 * BATTLE.postureDamage)
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
    // 持續駝背直到倒地：100 HP ÷ 3 每 5 秒 → 第 170 秒（170_000ms）
    run(fsm, 175_000, { posture: 'slouch' })
    expect(fsm.snapshot().regrouping).toBe(true)

    // 重整旗鼓精確持續 BATTLE.regroupMs(10_000)ms，170_000 + 10_000 = 180_000
    // 剛好整除 TICK(250)，regroupEnd 這個事件本身就精確落在 t=180_000 那個 tick
    // 上。與其用「切分點避開 180_000」這種容易被下一個人改壞的間接手法，這裡
    // 直接把 t=180_000 拆成單獨一次 tick() 呼叫，直接比對「regroupEnd 那個
    // tick 自己的回傳值」——這樣才抓得到「regroupEnd 那個 tick 本身混進了
    // attack」這種違規；用事件陣列裡的索引順序（regroupEnd 是否排在 attack
    // 前面）測不出這個，因為只要 regroupEnd 還是先被 push，索引順序照樣成立，
    // 就算同一個 tick 裡緊接著又 push 了一個 attack 也一樣。
    const almostEnd = run(fsm, 179_750, {}, 175_000) // 端正也不能攻擊
    expect(typesOf(almostEnd, 'attack').length).toBe(0)

    const regroupEndTick = fsm.tick({ t: 180_000, posture: 'upright', drowsy: false, phoneVisible: false })
    expect(typesOf(regroupEndTick, 'regroupEnd').length).toBe(1)
    expect(typesOf(regroupEndTick, 'attack').length).toBe(0)
    expect(fsm.snapshot().playerHp).toBe(BATTLE.regroupHp)

    const after = run(fsm, 190_000, {}, 180_000)
    expect(typesOf(after, 'attack').length).toBeGreaterThan(0)
  })

  it('攻擊累加器在重整旗鼓後仍保留先前累積的進度（偏離 3 的行為鎖定）', () => {
    // 這條測試名字看起來只跟累加器有關，但下面 during 的 attack===0 斷言同時
    // 鎖住另一件事：regroupEnd 那一個 tick 本身不可以攻擊。複審發現真正扛住
    // 這件事的其實是這裡，不是上面那條「重整旗鼓 10 秒內無法攻擊」測試裡的
    // 事件順序斷言（那條已經改成隔離單一 tick）。如果之後有人覺得這條測試
    // 「跟 regroup 邊界無關」而把它改壞或刪掉，這個覆蓋會一起消失，所以在
    // 這裡把這件事明講出來。
    const fsm = makeFsm()
    // 先端正累到只差 250ms 就滿 5 秒（4750ms），確保這筆進度真的「存在銀行裡」，
    // 不是巧合對齊到 0。
    run(fsm, 4_750)
    // 接著轉壞姿態一路駝背到倒地：100÷3=34 次扣血，需要 34×5000=170000ms 的
    // 壞姿態時間，從 4750ms 開始算，倒地落在 4750+170000=174750ms。
    run(fsm, 174_750, { posture: 'slouch' }, 4_750)
    expect(fsm.snapshot().regrouping).toBe(true)
    // 重整旗鼓精確 10 秒：174750+10000=184750ms 結束。
    const during = run(fsm, 184_750, {}, 174_750)
    expect(typesOf(during, 'regroupEnd').length).toBe(1)
    expect(typesOf(during, 'attack').length).toBe(0)
    // 如果 attackAccumMs 在 regroupStart 時被錯誤歸零（回到 brief 樣板、違反規則
    // 二），端正要滿整整 5 秒（20 個 tick）才會有下一次攻擊；因為保留了先前的
    // 4750ms，regroupEnd 後的下一個 tick（只需要再 250ms）就該立刻攻擊。
    const nextTick = fsm.tick({ t: 185_000, posture: 'upright', drowsy: false, phoneVisible: false })
    expect(typesOf(nextTick, 'attack').length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// fix round（測試鑑別力 FG-4／B-4）：DAMAGING_POSTURES 三個成員的覆蓋不對稱。
//
// 總審實測：`slouch` 拿掉紅 4 條、`forwardHead` 拿掉紅 1 條，但 `gazeAway`
// 拿掉 **666 條全綠**——也就是「小孩整場看著旁邊也不扣血、streak 不中斷、
// 不會進重整旗鼓」這個計分錯誤，沒有任何測試會叫。
// 上面那條「視線偏移時不攻擊」只斷言 gazeAway **不攻擊**，而那對任何非
// upright 姿態都自動成立，測不到它到底扣不扣血。
//
// ## 窮舉來源刻意不取自 focusStateMachine.js 自己的 DAMAGING_POSTURES
//
// 那份清單就是要驗的東西，拿它當迴圈來源就會重演 messageQueue 那條套套邏輯
// （拿掉一個成員，迴圈跟著變短，測試照樣綠）。這裡改用兩個獨立來源的交集：
//
//   1. `snapshot().postureDurationMs` 的桶名 —— 這個模組對「posture 這個輸入
//      有哪些合法的值」的獨立宣告（`tick()` 用 `postureDurationMs[posture]`
//      記帳，值不在桶裡就會寫進 undefined）。
//   2. `POSTURE_COPY` 的 key —— 文案層對「哪些姿態需要被糾正」的獨立宣告。
//      `upright` 沒有糾正台詞，所以交集天生就把獎勵格排除掉。
//
// 交集再扣掉 `drowsy`：它不是 posture 的值，是 tick() 另外一個正交的布林
// 參數（poseAnalyzer.evaluate() 的註解寫得很明白：「瞌睡不影響戰鬥數值」），
// 而「疲倦不該被懲罰」本身已經有一條專屬測試。
//
// 鎖得到什麼：任何一個「有糾正台詞、而且是合法 posture 值」的姿態被從
// DAMAGING_POSTURES 移除。鎖不到什麼：如果有人新增一個會扣血的姿態卻
// **同時**不給它糾正台詞、也不加進 postureDurationMs 的桶——那個姿態在
// 畫面上本來就沒有任何提示可講，會先被別的護欄（統計五桶互斥那條）擋下來。
// ---------------------------------------------------------------------------
const POSTURE_BUCKETS = createFocusStateMachine({ durationMs: MIN, demoMode: false })
  .snapshot().postureDurationMs
const DAMAGING_POSTURES_DERIVED = Object.keys(POSTURE_COPY)
  .filter((k) => k in POSTURE_BUCKETS && k !== 'drowsy')

describe('姿態扣血的成員覆蓋（三個成員對稱，窮舉來源獨立於被測清單）', () => {
  it('自我檢查：推導出來的清單非空、不含 upright、也不含正交的 drowsy', () => {
    expect(DAMAGING_POSTURES_DERIVED.length,
      '推導不出任何會扣血的姿態，下面的迴圈會變成恆真').toBeGreaterThan(0)
    expect(DAMAGING_POSTURES_DERIVED).not.toContain('upright')
    expect(DAMAGING_POSTURES_DERIVED).not.toContain('drowsy')
  })

  for (const posture of DAMAGING_POSTURES_DERIVED) {
    it(`${posture}：扣血、事件帶上原因、不攻擊、streak 歸零`, () => {
      const fsm = makeFsm()
      run(fsm, 10_000) // 先端正 10 秒：累出 streak=2，且 attackAccumMs 剛好歸零在邊界上
      expect(fsm.snapshot().streak).toBe(2)
      const hpBefore = fsm.snapshot().playerHp

      const events = run(fsm, 25_000, { posture }, 10_000) // 壞姿態 15 秒
      const dmg = typesOf(events, 'playerDamage')
      expect(dmg.length, '每 5 秒扣一次，15 秒應該扣 3 次').toBe(3)
      for (const e of dmg) {
        expect(e.reason).toBe(posture)
        expect(e.amount).toBe(BATTLE.postureDamage)
      }
      expect(typesOf(events, 'attack').length, '壞姿態期間不得攻擊').toBe(0)

      const s = fsm.snapshot()
      expect(s.playerHp).toBe(hpBefore - 3 * BATTLE.postureDamage)
      expect(s.streak, '壞姿態要中斷連擊').toBe(0)
      expect(s.postureDurationMs[posture], '統計桶也要記到這個姿態上').toBeGreaterThan(0)
    })
  }

  it('對照組：upright 不扣血、不中斷 streak（證明上面的紅燈來自姿態本身，不是任何非 upright 都會扣）', () => {
    const fsm = makeFsm()
    const events = run(fsm, 25_000)
    expect(typesOf(events, 'playerDamage').length).toBe(0)
    expect(fsm.snapshot().playerHp).toBe(BATTLE.playerHpMax)
    expect(fsm.snapshot().streak).toBe(5)
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

  it('phase 可以無限往上加，每次都補原始上限的 40%，bossHpPhaseMax 跟著更新給血條用', () => {
    // brief「第二（含以上）形態」：多形態是預期行為，專注率高的小孩應該一直有
    // 東西可打。這條測試把「決定」釘住，不是意外——沒有它，下次有人把補血比例
    // 改成遞減，或把 bossHpPhaseMax 漏更新讓血條卡在 40%，CI 不會有任何東西叫。
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    const max = fsm.snapshot().bossHpMax
    const events = run(fsm, 5 * MIN)
    const phases = typesOf(events, 'phase')
    expect(phases.length).toBeGreaterThanOrEqual(2) // 至少進到第三形態
    for (const p of phases) {
      expect(p.bossHp).toBe(Math.round(max * BATTLE.phase2RefillRatio))
    }
    const s = fsm.snapshot()
    expect(s.phase).toBeGreaterThanOrEqual(3)
    expect(s.bossHpPhaseMax).toBe(Math.round(max * BATTLE.phase2RefillRatio))
  })

  it('補血量為 Boss HP 上限的 40%', () => {
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    const max = fsm.snapshot().bossHpMax
    const events = run(fsm, 5 * MIN)
    expect(typesOf(events, 'phase')[0].bossHp).toBe(Math.round(max * BATTLE.phase2RefillRatio))
  })

  it('陷阱回血封頂在 bossHpPhaseMax，不是整體 bossHpMax（血條不會超過 100%，F4 裁決）', () => {
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    const max = fsm.snapshot().bossHpMax
    // 打滿第一形態，進入第二形態那一刻 bossHp 正好等於 bossHpPhaseMax（剛補滿）。
    const attacksToKillPhase1 = Math.ceil(max / BATTLE.damagePerAttack)
    const t0 = attacksToKillPhase1 * BATTLE.attackIntervalMs
    const events1 = run(fsm, t0)
    expect(typesOf(events1, 'phase').length).toBe(1)
    const afterPhase = fsm.snapshot()
    expect(afterPhase.bossHp).toBe(afterPhase.bossHpPhaseMax) // 剛進場，滿血

    // 用壞姿態凍結 bossHp（不再攻擊，排除干擾），同時觸發手機陷阱、等它 20 秒
    // 後正式生效。
    const events2 = run(fsm, t0 + 23_000, { posture: 'slouch', phoneVisible: true }, t0)
    const committed = typesOf(events2, 'trapCommitted')
    expect(committed.length).toBe(1)
    const bossHeal = committed[0].bossHeal

    // 先證明這不是巧合卡在邊界：heal 加上去真的會超過 bossHpPhaseMax，但沒有
    // 超過整體 bossHpMax——如果封頂用的是 bossHpMax（F4 之前的行為），這個
    // heal 完全不會被打折，bossHp 會變成 276、超過 phaseMax(245) 的 112.7%。
    expect(afterPhase.bossHp + bossHeal).toBeGreaterThan(afterPhase.bossHpPhaseMax)
    expect(afterPhase.bossHp + bossHeal).toBeLessThanOrEqual(afterPhase.bossHpMax)

    const s = fsm.snapshot()
    expect(s.bossHp).toBe(afterPhase.bossHpPhaseMax) // 精確卡在這個形態的滿血，不會溢出
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

  it('待確認期間不扣分、不回血（延後生效的核心保證）', () => {
    // ── 實機驗收後改寫（原標題是「…不中斷攻擊」）─────────────────────
    // 使用者要求「只要拿手機就不會攻擊」，所以「待確認期間攻擊照常」這一半
    // 不再成立，是**刻意偏離 spec 第 180 行**的一項，理由見 focusStateMachine.js
    // 攻擊那段註解（軟後果／硬後果分兩層）。
    //
    // 但這條測試真正在守的東西沒有變、而且更重要：**待確認期間不得扣分、
    // 不得回血**。那是「延後生效」的全部意義——20 秒撤銷視窗內，一個可能是
    // 誤判的判定不准動到任何數值。
    //
    // 先跑 50 秒讓 score／bossHp 離開 clamp 邊界再放手機：不這樣做的話，
    // 「陷阱當場生效」會被 clamp 吃掉證據（score 扣成負再 clamp 回 0、
    // bossHp 加回血再 clamp 回滿血），最終數字跟延後生效一模一樣。
    // 完整推導見下一條測試的註解。
    const fsm = makeFsm()
    run(fsm, 50_000)
    const before = fsm.snapshot()
    expect(before.score).toBeGreaterThan(0)
    expect(before.bossHp).toBeLessThan(before.bossHpMax)

    const events = run(fsm, 63_000, { phoneVisible: true }, 50_000)
    const after = fsm.snapshot()

    expect(typesOf(events, 'trapCommitted').length).toBe(0)
    expect(after.score, '待確認期間不得扣分').toBe(before.score)
    expect(after.bossHp, '待確認期間魔王不得回血').toBe(before.bossHp)
    // 新規則：東西在畫面上，姿勢再端正也打不到魔王
    expect(typesOf(events, 'attack'), '東西在畫面上就不該有攻擊').toHaveLength(0)
  })

  it('陷阱開啟那一刻本身不扣分不回血（跟前一條互補：隔離掉 clamp 會吃掉證據的情況）', () => {
    // 上一條測試在賽局一開始（score=0、bossHp=滿血）就觸發陷阱——如果 openTrap
    // 被改成當場扣分＋回血（直接違反規則一），score 會被扣成 0 再 clamp 回到 0、
    // bossHp 會先加回血再被 clamp 回滿血，兩個 clamp 剛好都把證據吃光，最終數字
    // 跟延後生效完全一樣，>0／<max 或就算比對精確值都測不出來（已用突變測試
    // 實際驗證過）。這裡刻意讓 score／bossHp 先離開 clamp 邊界（跑到不是 0 分、
    // 不是滿血的狀態）再觸發陷阱，讓「當場生效」的違規無所遁形。
    const fsm = makeFsm()
    run(fsm, 50_000) // 端正 50 秒 → 剛好 10 次攻擊、attackAccumMs 歸零在邊界上，
                      // 之後 3 秒端正不會再觸發下一次攻擊，可以乾淨隔離陷阱開啟本身的效果
    const before = fsm.snapshot()
    expect(before.score).toBeGreaterThan(0)
    expect(before.bossHp).toBeLessThan(before.bossHpMax)

    const events = run(fsm, 53_000, { phoneVisible: true }, 50_000) // 3 秒觸發 trapPending
    expect(typesOf(events, 'trapPending').length).toBe(1)
    expect(typesOf(events, 'attack').length).toBe(0) // 這 3 秒內不該有攻擊，排除干擾

    const after = fsm.snapshot()
    expect(after.score).toBe(before.score)
    expect(after.bossHp).toBe(before.bossHp)
  })

  it('待確認期間 streak 不中斷（brief 明文：不中斷連擊）', () => {
    const fsm = makeFsm()
    run(fsm, 10_000) // 端正 10 秒 → 2 次攻擊，streak 應該是 2
    const before = fsm.snapshot().streak
    expect(before).toBe(2)
    // 手機陷阱進入待確認期間，不該打斷 streak（跟姿態不良不同，那個才會歸零 streak）。
    //
    // 實機驗收後的新規則讓「拿著手機時不會攻擊」，所以這裡不再有新的 attack
    // 事件可以檢查 streak 欄位——改成直接讀 snapshot：**streak 必須維持原值，
    // 不得歸零**。spec 第 180 行明文「不中斷連擊」，那一半沒有被新規則推翻：
    // 新規則讓他「暫時打不到」，不是「把他之前做對的事一筆勾銷」。
    // （中斷連擊一度也被加進來過，但那是實作者自己多做的，不在使用者的要求裡，
    // 而且直接違反 spec，已撤回。）
    const events = run(fsm, 15_000, { phoneVisible: true }, 10_000)
    expect(typesOf(events, 'attack'), '東西在畫面上就不該有攻擊').toHaveLength(0)
    expect(fsm.snapshot().streak, 'streak 不得因為待確認期間而歸零').toBe(before)

    // 東西移開之後，連擊從原本的值繼續往上，不是從 0 重來
    const after = run(fsm, 15_000 + BATTLE.attackIntervalMs + TICK, {}, 15_000)
    const resumed = typesOf(after, 'attack')
    expect(resumed.length).toBeGreaterThanOrEqual(1)
    expect(resumed[0].streak).toBe(before + 1)
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
  })

  it('撤銷成功會送出 trapUndone 事件（brief 第 35 行的事件契約）', () => {
    const fsm = makeFsm()
    const events = run(fsm, 3000, { phoneVisible: true })
    const trapId = typesOf(events, 'trapPending')[0].trapId
    expect(fsm.undoTrap(trapId)).toBe(true)
    // undoTrap() 呼叫當下不會有事件，語音層／戰鬥日誌這些消費者只認 tick() 的回傳值，
    // 所以下一次 tick() 必須把 trapUndone 補送出來。
    const nextTick = fsm.tick({ t: 3250, posture: 'upright', drowsy: false, phoneVisible: false })
    const undone = typesOf(nextTick, 'trapUndone')
    expect(undone.length).toBe(1)
    expect(undone[0].trapId).toBe(trapId)
    expect(undone[0].kind).toBe('phone')
  })

  it('撤銷視窗用場內時間（elapsedMs）記帳，暫停／背景不會把視窗吃光', () => {
    const fsm = makeFsm()
    const events = run(fsm, 3000, { phoneVisible: true }) // 開陷阱時 elapsedMs=3000
    const trapId = typesOf(events, 'trapPending')[0].trapId

    // 小孩切出去看了很久的背景通知——如果撤銷視窗是用呼叫端的原始 t 記帳，
    // 這段牆鐘時間會被整段吃掉，回前景時陷阱早就（用原始時間算）過了 20 秒
    // 而直接生效，小孩連按撤銷的機會都沒有就被冤枉。
    fsm.notifyHidden(3000)
    fsm.notifyVisible(33_000) // 背景待了 30 秒（大於原始 20 秒撤銷視窗）
    const backEvents = fsm.tick({ t: 33_250, posture: 'upright', drowsy: false, phoneVisible: false })

    // 場內時間只從 3000 走到 3250，離 20 秒視窗還遠得很，陷阱不該生效。
    expect(typesOf(backEvents, 'trapCommitted').length).toBe(0)
    expect(fsm.snapshot().trapCount.phone).toBe(0)
    // 而且陷阱真的還能撤銷——不是「沒觸發 commit 但其實已經來不及」的假象。
    expect(fsm.undoTrap(trapId)).toBe(true)
  })

  it('20 秒未撤銷才正式生效：Boss 回血 5% 上限、積分 −100', () => {
    const fsm = makeFsm()
    run(fsm, 3000, { phoneVisible: true })
    const bossBefore = fsm.snapshot().bossHp
    const later = run(fsm, 25_000, {}, 3000)
    const committed = typesOf(later, 'trapCommitted')
    expect(committed.length).toBe(1)
    expect(committed[0].bossHeal).toBe(Math.round(BOSS_HP_15MIN * 0.05))
    expect(committed[0].scorePenalty).toBe(100)
    const s = fsm.snapshot()
    expect(s.trapCount.phone).toBe(1)
    expect(s.bossHp).toBeGreaterThan(bossBefore - BOSS_HP_15MIN * 0.05)
  })

  it('Boss 回血不得超過 HP 上限', () => {
    const fsm = makeFsm()
    run(fsm, 3000, { phoneVisible: true })
    run(fsm, 25_000, {}, 3000)
    expect(fsm.snapshot().bossHp).toBeLessThanOrEqual(BOSS_HP_15MIN)
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

  it('notifyHidden 重入不會覆寫 hiddenSince、漏算離開時間', () => {
    // iPad Safari PWA 的 visibilitychange／pagehide／freeze／blur 很容易對同一次
    // 「離開」連續觸發好幾個事件。如果 notifyHidden 沒有防重入，晚到的第二次呼叫
    // 會用它自己的 t 覆寫 hiddenSince，把「已經離開」的那段時間平白吃掉。
    const fsm = makeFsm()
    run(fsm, 5000)
    fsm.notifyHidden(5000)
    fsm.notifyHidden(9000) // 重複觸發，應該被忽略
    fsm.notifyVisible(12_000)
    // 真正離開的時間是 5000→12000＝7000ms，不是被重入覆寫後的 9000→12000＝3000ms。
    expect(fsm.snapshot().distractionDurationMs.away).toBe(7000)
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
    expect(s.playerHp).toBe(BATTLE.playerHpMax)
  })

  it('該輪結束時還懸空的陷阱視為沒發生，不留下懸空狀態（規則一）', () => {
    const fsm = createFocusStateMachine({ durationMs: 5 * MIN, demoMode: false })
    // 在快結束時才觸發陷阱，20 秒撤銷視窗根本來不及在該輪時限內跑完。
    run(fsm, 296_000)
    const events = run(fsm, 5 * MIN, { phoneVisible: true }, 296_000)
    const trapId = typesOf(events, 'trapPending')[0].trapId
    expect(trapId).toBeDefined()
    expect(typesOf(events, 'trapCommitted').length).toBe(0)
    expect(typesOf(events, 'sessionEnd').length).toBe(1)

    const s = fsm.snapshot()
    expect(s.pendingTraps.length).toBe(0) // 沒 commit 就是沒發生，不會懸空留著
    expect(s.trapCount.phone).toBe(0)

    // 該輪已結束，事後也不能再靠 undoTrap 竄改統計——存檔數字不該取決於小孩
    // 有沒有在結算畫面亂按還留在畫面上的撤銷鈕。
    expect(fsm.undoTrap(trapId)).toBe(false)
    expect(fsm.snapshot().trapCount.phoneUndone).toBe(0)
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
  it('姿態時長七個桶互斥且總和等於已過時間', () => {
    const fsm = makeFsm()
    run(fsm, 10_000)
    run(fsm, 20_000, { posture: 'slouch' }, 10_000)
    run(fsm, 26_000, { posture: 'upright', drowsy: true }, 20_000)
    const d = fsm.snapshot().postureDurationMs
    const sum = d.upright + d.slouch + d.forwardHead + d.handProp + d.headTilt + d.drowsy + d.gazeAway
    expect(sum).toBeCloseTo(fsm.snapshot().elapsedMs, -2)
    expect(d.drowsy).toBeGreaterThan(0)
  })

  it('drowsy 蓋過 posture 桶（統計互斥的代價，戰鬥判定不受影響）', () => {
    const fsm = makeFsm()
    run(fsm, 10_000, { posture: 'slouch', drowsy: true })
    const d = fsm.snapshot().postureDurationMs
    expect(d.drowsy).toBeGreaterThan(0)
    expect(d.slouch).toBe(0)
    expect(fsm.snapshot().playerHp).toBeLessThan(BATTLE.playerHpMax) // 但血還是照扣
  })

  it('dpsSeries 以 5 秒為一格聚合，每格精確對應該 5 秒內的傷害', () => {
    const fsm = createFocusStateMachine({ durationMs: 15 * MIN, demoMode: false })
    run(fsm, 60_000)
    const series = fsm.snapshot().dpsSeries
    // 精確比對每一格的值，不是只比總和：attackIntervalMs 剛好等於 DPS_BUCKET_MS，
    // 60 秒內端正攻擊會精確落在 12 個 5 秒格子邊界上，每格剛好一次攻擊、20 點傷害。
    // 只比總和（reduce(sum) === attacks×damage）由 recordDamage 的寫法本身保證，
    // 就算分桶分錯（例如全部落到同一格），總和還是對得上，抓不到這種錯誤。
    expect(series).toEqual(Array(12).fill(BATTLE.damagePerAttack))
  })

  it('dpsSeries 補零到目前經過的格數，不會少給畫圖用的尾端', () => {
    const fsm = createFocusStateMachine({ durationMs: 15 * MIN, demoMode: false })
    run(fsm, 62_000) // 62 秒：走到第 13 格中途，但最後一次攻擊在第 12 格（60_000ms）
    const series = fsm.snapshot().dpsSeries
    expect(series.length).toBe(Math.ceil(fsm.snapshot().elapsedMs / 5000))
    expect(series.length).toBe(13)
    expect(series[12]).toBe(0) // 第 13 格還沒有任何攻擊，但要補零，不能讓陣列停在 12 格
  })

  it('drowsy 進入時只發一次事件，不重複洗版', () => {
    const fsm = makeFsm()
    const events = run(fsm, 20_000, { drowsy: true })
    expect(typesOf(events, 'drowsy').length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 重大違規 debuff（實機驗收後新增；使用者：「重大違規就要中 debuff，
// 要專心多久才能解除」。目標使用者 12 歲，參數推導見 battleConfig.js）
// ---------------------------------------------------------------------------

/** 讓手機持續出現到陷阱正式生效，回傳期間所有事件與 fsm。 */
function runUntilTrapCommitted() {
  const fsm = makeFsm()
  const events = []
  // 手機連續 phoneTrapHoldMs 觸發陷阱，再等過 trapUndoWindowMs 才正式生效。
  const until = BATTLE.phoneTrapHoldMs + BATTLE.trapUndoWindowMs + TICK * 4
  for (let t = TICK; t <= until; t += TICK) {
    events.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: true }))
  }
  return { fsm, events, endedAt: until }
}

describe('重大違規 debuff', () => {
  it('陷阱正式生效才上 debuff——駝背與打瞌睡都不算重大違規', () => {
    const fsm = makeFsm()
    // 駝背整整一分鐘：會扣血、會進重整旗鼓，但不該有 debuff
    const events = run(fsm, 60_000, { posture: 'slouch' })
    expect(typesOf(events, 'debuffStart')).toHaveLength(0)
    expect(fsm.snapshot().debuffed).toBe(false)

    // 打瞌睡同理（而且打瞌睡常來自沒睡飽或身體不適，懲罰它不對）
    const fsm2 = makeFsm()
    const events2 = run(fsm2, 60_000, { drowsy: true })
    expect(typesOf(events2, 'debuffStart')).toHaveLength(0)
    expect(fsm2.snapshot().debuffed).toBe(false)
  })

  it('陷阱正式生效 → 上 debuff，snapshot 同時給出「還要再專心多久」', () => {
    const { fsm, events } = runUntilTrapCommitted()
    expect(typesOf(events, 'trapCommitted')).toHaveLength(1)
    expect(typesOf(events, 'debuffStart')).toHaveLength(1)

    const s = fsm.snapshot()
    expect(s.debuffed).toBe(true)
    expect(s.debuffRemainMs).toBeGreaterThan(0)
    expect(s.debuffRemainMs).toBeLessThanOrEqual(BATTLE.debuffMaxMs)
    // 剛上身、還沒累積任何專注，所以要求的秒數就是完整門檻
    expect(s.debuffFocusRemainMs).toBe(BATTLE.debuffClearFocusMs)
  })

  it('debuff 中傷害減半、且不累積連擊', () => {
    const { fsm, endedAt } = runUntilTrapCommitted()
    const before = fsm.snapshot()
    // 手機收起來、坐正，打一次攻擊
    const evts = []
    for (let t = endedAt + TICK; t <= endedAt + BATTLE.attackIntervalMs + TICK; t += TICK) {
      evts.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: false }))
    }
    const atk = typesOf(evts, 'attack')
    expect(atk.length).toBeGreaterThanOrEqual(1)
    // 期望值寫死，**不重算一次實作的算式**（複審 M1／I-4）。
    //
    // 這一行原本是 `toBe(Math.round(BATTLE.damagePerAttack * BATTLE.debuffDamageRatio))`
    // ——斷言鏡射實作，所以它結構上不可能抓到「進位方式改變」：複審把實作的
    // `Math.round` 改成 `Math.floor`，792 全綠。今天 damagePerAttack=20，
    // 兩者都是 10，沒有任何測試分得出來。
    //
    // 寫死成 10 之後，這條斷言鎖得到的是「debuff 中的一擊到底打幾點」這個
    // **事實**。`damagePerAttack`（或 `debuffDamageRatio`）被調動時這裡一定
    // 會紅，那正是我們要的：那一刻必須有人回來重新想一次進位方向。
    //
    // 為什麼實作用 Math.round 而不是 Math.floor：damagePerAttack 改成奇數
    // （例如 21）時，round(10.5)=11——debuff 中的一擊會**超過**滿額傷害的
    // 一半，而註解說的是「減半」；floor 會是 10。這個選擇是刻意的：
    // battleConfig 的 debuffDamageRatio 註解寫著「被 debuff 的人必須還看得到
    // 自己在前進」，兩者取其一時偏向玩家那一側。
    expect(atk[0].damage, 'damagePerAttack=20 × debuffDamageRatio=0.5 → 10').toBe(10)
    // 連擊不前進：debuff 期間打再多下，streak 都停在中陷阱當下的值
    expect(atk[0].streak).toBe(before.streak)
  })

  it('連續專心滿 debuffClearFocusMs 就解除（reason: cleared）', () => {
    const { fsm, endedAt } = runUntilTrapCommitted()
    const evts = []
    const until = endedAt + BATTLE.debuffClearFocusMs + TICK * 4
    for (let t = endedAt + TICK; t <= until; t += TICK) {
      evts.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: false }))
    }
    const ends = typesOf(evts, 'debuffEnd')
    expect(ends).toHaveLength(1)
    expect(ends[0].reason).toBe('cleared')
    expect(fsm.snapshot().debuffed).toBe(false)
  })

  it('「連續」是字面意思：中途不端正就把累積歸零，不是扣一點', () => {
    const { fsm, endedAt } = runUntilTrapCommitted()
    let t = endedAt
    // 先專心到差一點就解除
    const almost = BATTLE.debuffClearFocusMs - TICK * 8
    for (let i = TICK; i <= almost; i += TICK) {
      t += TICK
      fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: false })
    }
    expect(fsm.snapshot().debuffFocusRemainMs).toBeLessThan(BATTLE.debuffClearFocusMs)

    // 駝背一下下
    for (let i = 0; i < 4; i += 1) {
      t += TICK
      fsm.tick({ t, posture: 'slouch', drowsy: false, phoneVisible: false })
    }
    // 累積歸零：要求的秒數回到完整門檻
    expect(fsm.snapshot().debuffFocusRemainMs).toBe(BATTLE.debuffClearFocusMs)
    expect(fsm.snapshot().debuffed).toBe(true)
  })

  it('保險絲：整場都不端正，debuffMaxMs 到了也一定會自動解除（reason: expired）', () => {
    // 這條測的不是遊戲設計，是安全網。姿態閾值目前仍是沒人量過的佔位值，
    // 若閾值偏嚴導致「連續端正 30 秒」根本達不到，debuff 會永遠掛著——
    // 一個孩子被機器判定有問題、而且怎麼做都解不掉。這條測試鎖住那扇後門。
    const { fsm, endedAt } = runUntilTrapCommitted()
    const evts = []
    const until = endedAt + BATTLE.debuffMaxMs + TICK * 4
    for (let t = endedAt + TICK; t <= until; t += TICK) {
      // 全程駝背：永遠不可能靠專心解除
      evts.push(...fsm.tick({ t, posture: 'slouch', drowsy: false, phoneVisible: false }))
    }
    const ends = typesOf(evts, 'debuffEnd')
    expect(ends).toHaveLength(1)
    expect(ends[0].reason).toBe('expired')
    expect(fsm.snapshot().debuffed).toBe(false)
  })
})

describe('不該出現的東西在畫面上 → 立刻停止攻擊（軟後果）', () => {
  it('姿勢再端正，只要東西在畫面上就打不到魔王', () => {
    const fsm = makeFsm()
    // 整整一分鐘、姿勢完美、但手機一直在畫面上
    const events = run(fsm, 60_000, { posture: 'upright', phoneVisible: true })
    expect(typesOf(events, 'attack')).toHaveLength(0)
    expect(fsm.snapshot().bossHp).toBe(BOSS_HP_15MIN) // 魔王一滴血都沒掉
  })

  it('東西離開畫面就立刻恢復攻擊——軟後果會自己復原，不需要任何補救動作', () => {
    const fsm = makeFsm()
    run(fsm, 10_000, { posture: 'upright', phoneVisible: true })
    const after = []
    for (let t = 10_000 + TICK; t <= 10_000 + BATTLE.attackIntervalMs + TICK; t += TICK) {
      after.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: false }))
    }
    expect(typesOf(after, 'attack').length).toBeGreaterThanOrEqual(1)
  })

  it('攻擊累加器不被沒收：東西出現前累積的進度，移開後仍然算數', () => {
    // 這條鎖的是這個檔案一路遵守的「先前累積的進度不該被沒收」原則。
    // 若改成歸零，下面這次攻擊會晚一個 attackIntervalMs 才發生。
    const fsm = makeFsm()
    const nearlyOneAttack = BATTLE.attackIntervalMs - TICK * 2
    run(fsm, nearlyOneAttack, { posture: 'upright', phoneVisible: false })
    // 東西出現一下子（期間不該攻擊）
    const during = []
    let t = nearlyOneAttack
    for (let i = 0; i < 8; i += 1) {
      t += TICK
      during.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: true }))
    }
    expect(typesOf(during, 'attack')).toHaveLength(0)
    // 移開之後，剩下的那一點點就足以觸發攻擊
    const after = []
    for (let i = 0; i < 3; i += 1) {
      t += TICK
      after.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: false }))
    }
    expect(typesOf(after, 'attack')).toHaveLength(1)
  })

})

describe('重大違規 debuff：第二次違規是刷新，不是疊加', () => {
  it('再中一次陷阱 → 保險絲重新計時、專注累積歸零，但不重複發 debuffStart', () => {
    // 這個行為原本只寫在註解裡沒有測試（突變驗證時才發現）。刷新而非疊加的
    // 理由：疊加會讓連續兩次失誤變成一個幾乎解不掉的狀態，而這個機制的目的
    // 是給一條走得出去的路，不是把人釘在地上。
    const { fsm, endedAt } = runUntilTrapCommitted()
    let t = endedAt

    // 先好好專心一段（但不到解除門檻），累積起來
    const partial = BATTLE.debuffClearFocusMs / 2
    for (let i = TICK; i <= partial; i += TICK) {
      t += TICK
      fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: false })
    }
    const mid = fsm.snapshot()
    expect(mid.debuffed).toBe(true)
    expect(mid.debuffFocusRemainMs).toBeLessThan(BATTLE.debuffClearFocusMs)
    const remainBefore = mid.debuffRemainMs

    // 第二次違規：東西再出現，撐過 3 秒開陷阱 ＋ 20 秒撤銷期
    const evts = []
    const until = t + BATTLE.phoneTrapHoldMs + BATTLE.trapUndoWindowMs + TICK * 4
    for (; t <= until; t += TICK) {
      evts.push(...fsm.tick({ t, posture: 'upright', drowsy: false, phoneVisible: true }))
    }
    expect(typesOf(evts, 'trapCommitted')).toHaveLength(1)
    // 已經在 debuff 中，不該再發一次 debuffStart（UI 會重複播一次特效／提示）
    expect(typesOf(evts, 'debuffStart'), '已在 debuff 中不得重複發 debuffStart').toHaveLength(0)

    const after = fsm.snapshot()
    expect(after.debuffFocusRemainMs, '專注累積歸零').toBe(BATTLE.debuffClearFocusMs)
    expect(after.debuffRemainMs, '保險絲重新計時').toBeGreaterThan(remainBefore)
    expect(after.debuffRemainMs).toBeLessThanOrEqual(BATTLE.debuffMaxMs)
  })
})

// ---------------------------------------------------------------------------
// Blocking B3：「我沒有在玩那個」按下去之後，承諾的事必須真的發生
//
// 上一版按下撤銷只做到三分之一：陷阱被移走（不扣分、不回血、不上 debuff），
// 提示卡片消失——**看起來像被接受了**——但 phoneVisible 沒變、phoneHoldMs
// 沒歸零、**攻擊仍然被封鎖**。魔王繼續一滴血都不掉，20 秒後卡片過期，畫面上
// 再也沒有任何字。這顆鈕是「小孩對誤判提出異議的唯一出口」，出口存在但走不通，
// 比沒有出口更糟：它讓小孩以為自己已經處理完了。
// ---------------------------------------------------------------------------

describe('Blocking B3：撤銷之後攻擊要恢復（唯一的出口必須走得通）', () => {
  /** 讓東西出現到陷阱開啟，回傳 fsm 與那個 trapId。東西**留在畫面上**不移開。 */
  function openPhoneTrap() {
    const fsm = makeFsm()
    const events = run(fsm, BATTLE.phoneTrapHoldMs, { phoneVisible: true })
    const trapId = typesOf(events, 'trapPending')[0].trapId
    return { fsm, trapId, at: BATTLE.phoneTrapHoldMs }
  }

  it('東西還在畫面上時按撤銷：魔王重新開始掉血（這是小孩唯一看得到的證據）', () => {
    const { fsm, trapId, at } = openPhoneTrap()

    // 先證明前提成立：撤銷之前，坐得再正也打不到。
    const blocked = run(fsm, at + BATTLE.attackIntervalMs * 2, { phoneVisible: true }, at)
    expect(typesOf(blocked, 'attack'), '撤銷之前本來就該打不到').toHaveLength(0)

    const before = fsm.snapshot().bossHp
    expect(fsm.undoTrap(trapId)).toBe(true)

    // 撤銷之後，東西**仍然在畫面上**（誤判的東西不會因為按了鈕就消失）
    const at2 = at + BATTLE.attackIntervalMs * 2
    const after = run(fsm, at2 + BATTLE.attackIntervalMs * 2, { phoneVisible: true }, at2)
    expect(typesOf(after, 'attack').length, '撤銷之後必須真的打得到').toBeGreaterThanOrEqual(1)
    expect(fsm.snapshot().bossHp).toBeLessThan(before)
  })

  it('撤銷之後那句「把東西移開就能打」要消失（snapshot.objectBlocking 轉 false）', () => {
    const { fsm, trapId, at } = openPhoneTrap()
    expect(fsm.snapshot().objectBlocking, '封鎖中就要有一句話說得出為什麼').toBe(true)

    fsm.undoTrap(trapId)
    run(fsm, at + TICK * 2, { phoneVisible: true }, at)
    expect(fsm.snapshot().objectBlocking, '撤銷之後封鎖解除，那句話就不該還掛著').toBe(false)
  })

  it('豁免期內偵測到的時間不計入分心統計——那正是他已經否認過的那一段', () => {
    const { fsm, trapId, at } = openPhoneTrap()
    fsm.undoTrap(trapId)
    const before = fsm.snapshot().distractionDurationMs.phone

    const at2 = at + 20_000
    run(fsm, at2, { phoneVisible: true }, at)
    expect(
      fsm.snapshot().distractionDurationMs.phone,
      '結算頁會拿這個數字對小孩說「手機出現 N 分鐘」，不能把他否認過的那段算進去',
    ).toBe(before)
  })

  it('豁免期內可以解掉 debuff——被誤判的人不該被關在裡面', () => {
    // 先用一次真的生效的陷阱上 debuff，再讓東西留在畫面上、按撤銷。
    const { fsm, endedAt } = runUntilTrapCommitted()
    expect(fsm.snapshot().debuffed).toBe(true)

    // 陷阱是**邊緣觸發**（見 focusStateMachine 的 before < phoneTrapHoldMs），
    // 東西一直留著只會開一次。讓它離開一下再回來，才有第二個陷阱可以撤銷。
    run(fsm, endedAt + TICK, { phoneVisible: false }, endedAt)
    const back = endedAt + TICK
    const evts = run(fsm, back + BATTLE.phoneTrapHoldMs + TICK, { phoneVisible: true }, back)
    const trapId = typesOf(evts, 'trapPending')[0].trapId
    expect(fsm.undoTrap(trapId)).toBe(true)

    const from = back + BATTLE.phoneTrapHoldMs + TICK
    const cleared = run(fsm, from + BATTLE.debuffClearFocusMs + TICK * 4, { phoneVisible: true }, from)
    const end = typesOf(cleared, 'debuffEnd')
    expect(end.length, '撤銷之後坐得筆直就該解得掉').toBe(1)
    expect(end[0].reason, '是他做到了，不是保險絲燒斷').toBe('cleared')
  })

  it('豁免期是有界的：過期之後同一個東西會重新開陷阱（不是按一次就整場免疫）', () => {
    const { fsm, trapId, at } = openPhoneTrap()
    fsm.undoTrap(trapId)

    // 跑完整段豁免期，東西全程留在畫面上
    const graceEnd = at + BATTLE.phoneUndoGraceMs + TICK * 2
    const during = run(fsm, graceEnd, { phoneVisible: true }, at)
    expect(typesOf(during, 'trapPending'), '豁免期內不得重新開陷阱').toHaveLength(0)
    expect(typesOf(during, 'attack').length, '豁免期內打得到魔王').toBeGreaterThan(0)

    // 豁免期過了，一切從頭來過：連續 phoneTrapHoldMs → 再開一個陷阱
    const after = run(fsm, graceEnd + BATTLE.phoneTrapHoldMs + TICK * 2, { phoneVisible: true }, graceEnd)
    expect(
      typesOf(after, 'trapPending').length,
      '真的在玩手機的人每分鐘會被抓一次——這個機制不得因為按過一次撤銷就失效',
    ).toBe(1)
    expect(fsm.snapshot().objectBlocking, '豁免期結束，封鎖與那句提示都要回來').toBe(true)
  })

  it('豁免期用場內時間記帳：暫停／切背景不會把它吃掉', () => {
    const { fsm, trapId, at } = openPhoneTrap()
    fsm.undoTrap(trapId)

    // 小孩切出去很久（遠超過豁免期的牆鐘時間）
    fsm.notifyHidden(at)
    fsm.notifyVisible(at + BATTLE.phoneUndoGraceMs * 2)
    const t0 = at + BATTLE.phoneUndoGraceMs * 2
    const back = run(fsm, t0 + BATTLE.attackIntervalMs * 2, { phoneVisible: true }, t0)

    expect(typesOf(back, 'attack').length, '背景時間不該被算進豁免期').toBeGreaterThanOrEqual(1)
  })

  it('撤銷「離座」陷阱不會順帶給出東西的豁免期（兩種違規互不相干）', () => {
    const fsm = makeFsm()
    // 先離座超過門檻，開一個 away 陷阱
    run(fsm, 1000)
    fsm.notifyHidden(1000)
    fsm.notifyVisible(1000 + BATTLE.awayTrapMs + 1000)
    const t0 = 1000 + BATTLE.awayTrapMs + 1000
    const evts = run(fsm, t0 + TICK, {}, t0)
    const away = typesOf(evts, 'trapPending').find((e) => e.kind === 'away')
    expect(away, 'away 陷阱要真的開起來，否則下面是假綠').toBeTruthy()
    expect(fsm.undoTrap(away.trapId)).toBe(true)

    // 撤銷 away 之後把東西放到畫面上：封鎖照常成立
    const t1 = t0 + TICK
    const blocked = run(fsm, t1 + BATTLE.attackIntervalMs * 2, { phoneVisible: true }, t1)
    expect(typesOf(blocked, 'attack'), 'away 的撤銷不該給出東西的豁免期').toHaveLength(0)
  })

  it('沒有按過撤銷時，objectBlocking 就是「畫面上有東西」本身', () => {
    // 反方向：修法不得把封鎖整個弱化掉。
    const fsm = makeFsm()
    run(fsm, 2000, { phoneVisible: true })
    expect(fsm.snapshot().objectBlocking).toBe(true)
    run(fsm, 4000, { phoneVisible: false }, 2000)
    expect(fsm.snapshot().objectBlocking).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 複審 M3／I-1：debuff 解除條件裡的 drowsy
// ---------------------------------------------------------------------------

describe('debuff 解除條件（複審 M3：這兩個方向以前都沒有測試）', () => {
  it('打瞌睡不會讓人解不掉 debuff——battleConfig 說「懲罰它不對」，兩側都要遵守', () => {
    // 這個條件以前是 `posture === 'upright' && !drowsy && !phoneVisible`。
    // 複審把 `!drowsy` 拿掉跑全套 → 792 全綠，兩個方向都沒有人守。
    //
    // 為什麼拿掉是對的：battleConfig.js 自己寫著「打瞌睡常常來自沒睡飽或
    // 身體不舒服，懲罰它不對」。那條原則在「會不會中 debuff」這一側被遵守了，
    // 卻在「解不解得掉」這一側被推翻——一個真的很累的小孩被關在裡面，
    // 而畫面上寫著「再專心 30 秒」，那個數字一秒都不會動。
    const { fsm, endedAt } = runUntilTrapCommitted()
    expect(fsm.snapshot().debuffed).toBe(true)

    const until = endedAt + BATTLE.debuffClearFocusMs + TICK * 4
    const evts = run(fsm, until, { posture: 'upright', drowsy: true }, endedAt)
    const end = typesOf(evts, 'debuffEnd')
    expect(end.length, '坐得筆直就該解得掉，即使他很累').toBe(1)
    expect(end[0].reason, '要是他做到了（cleared），不是保險絲燒斷（expired）').toBe('cleared')
    // 保險絲是 90 秒、解除門檻是 30 秒——reason 分得出這兩者，所以這條測試
    // 不會因為「反正最後都會解開」而變成假綠。
    expect(until - endedAt).toBeLessThan(BATTLE.debuffMaxMs)
  })

  it('但姿態不端正仍然解不掉——拿掉 drowsy 不等於把解除條件放寬', () => {
    const { fsm, endedAt } = runUntilTrapCommitted()
    const until = endedAt + BATTLE.debuffClearFocusMs + TICK * 4
    const evts = run(fsm, until, { posture: 'slouch' }, endedAt)
    expect(typesOf(evts, 'debuffEnd'), '駝背時 debuff 不該自己解掉').toHaveLength(0)
    expect(fsm.snapshot().debuffed).toBe(true)
  })

  it('東西還在畫面上（且沒撤銷）時解不掉——不得獎勵「被抓到之後坐正一點就好」', () => {
    const { fsm, endedAt } = runUntilTrapCommitted()
    const until = endedAt + BATTLE.debuffClearFocusMs + TICK * 4
    const evts = run(fsm, until, { posture: 'upright', phoneVisible: true }, endedAt)
    expect(typesOf(evts, 'debuffEnd')).toHaveLength(0)
    expect(fsm.snapshot().debuffed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 複審 M5／I-3：debuff 兩個計時器在 regroup 期間凍結
//
// 這個條件上面有 6 行註解論證為什麼要凍結，但一條測試都沒有——複審把
// `&& regroupRemainMs <= 0` 拿掉跑全套 → 792 全綠。
// ---------------------------------------------------------------------------

describe('debuff 計時器在重整旗鼓期間凍結（複審 M5：6 行註解、0 條測試）', () => {
  /**
   * 同時處於 debuff ＋ regroup 的狀態。
   *
   * 順序很重要，而且只有這一種順序做得到：從滿血開始駝背到倒地要 165 秒
   * （100 HP ÷ 每 5 秒 3 點），而 debuff 的保險絲只有 90 秒——**先中 debuff
   * 再去倒地，debuff 一定先燒完**，那樣測出來的「凍結」會是 0 === 0 的假綠。
   * 所以先把體力磨到剩最後一下，再讓陷阱生效上 debuff，最後補一下駝背。
   */
  function debuffedAndRegrouping() {
    const fsm = makeFsm()
    let t = 0
    // 一：先把體力磨到只剩一次扣血的量（此時還沒有 debuff）
    while (fsm.snapshot().playerHp > BATTLE.postureDamage && t < 10 * MIN) {
      t += TICK
      fsm.tick({ t, posture: 'slouch', drowsy: false, phoneVisible: false })
    }
    expect(fsm.snapshot().regrouping, '還不能倒地').toBe(false)

    // 二：東西出現、陷阱正式生效 → 上 debuff（姿態端正，這段不再扣血）
    const until = t + BATTLE.phoneTrapHoldMs + BATTLE.trapUndoWindowMs + TICK * 4
    run(fsm, until, { posture: 'upright', phoneVisible: true }, t)
    expect(fsm.snapshot().debuffed).toBe(true)
    t = until

    // 三：最後一下駝背把體力打到 0 → regroupStart
    while (!fsm.snapshot().regrouping && t < until + 2 * MIN) {
      t += TICK
      fsm.tick({ t, posture: 'slouch', drowsy: false, phoneVisible: false })
    }
    expect(fsm.snapshot().regrouping, '前提沒成立的話下面全是假綠').toBe(true)
    expect(fsm.snapshot().debuffed, 'debuff 必須還掛著，否則測的是 0 === 0').toBe(true)
    return { fsm, t }
  }

  it('保險絲（debuffRemainMs）在 regroup 期間不前進——躺著不該能等它過去', () => {
    const { fsm, t } = debuffedAndRegrouping()
    const before = fsm.snapshot().debuffRemainMs

    // regroup 期間坐得筆直（最自然的反應），跑掉一大段時間
    const during = Math.min(BATTLE.regroupMs - TICK * 2, 8000)
    run(fsm, t + during, { posture: 'upright' }, t)

    expect(fsm.snapshot().regrouping, '這段時間要還在 regroup 裡，否則測的不是凍結').toBe(true)
    expect(
      fsm.snapshot().debuffRemainMs,
      'regroup 期間玩家對 debuff 沒有主導權，讓保險絲空轉等於「躺著就能等它過去」',
    ).toBe(before)
  })

  it('專注累積器（debuffFocusRemainMs）在 regroup 期間也不前進——那 10 秒不算他做到了', () => {
    const { fsm, t } = debuffedAndRegrouping()
    const atRegroup = fsm.snapshot().debuffFocusRemainMs
    // 倒地那一下是駝背，累積器剛被歸零 → 剩餘秒數是完整門檻。先確認這個前提，
    // 否則下面「沒有變」可能只是因為它本來就卡在某個值。
    expect(atRegroup).toBe(BATTLE.debuffClearFocusMs)

    // regroup 期間坐得筆直（畫面跳出「重整旗鼓！」時最自然的反應）
    run(fsm, t + Math.min(BATTLE.regroupMs - TICK * 2, 8000), { posture: 'upright' }, t)
    expect(fsm.snapshot().regrouping).toBe(true)
    expect(
      fsm.snapshot().debuffFocusRemainMs,
      'regroup 期間不能攻擊、姿態也不計分，讓累積器前進等於白送 10 秒進度',
    ).toBe(atRegroup)
  })

  it('regroup 結束之後兩個計時器都恢復正常前進', () => {
    // 反方向：凍結不得變成「永遠凍結」。
    const { fsm, t } = debuffedAndRegrouping()
    const before = fsm.snapshot().debuffRemainMs

    // 跑完整段 regroup 再多跑一點
    const after = t + BATTLE.regroupMs + TICK * 8
    run(fsm, after, { posture: 'upright' }, t)

    expect(fsm.snapshot().regrouping).toBe(false)
    expect(fsm.snapshot().debuffRemainMs, 'regroup 結束後保險絲要繼續燒').toBeLessThan(before)
  })
})
