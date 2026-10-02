import { BATTLE, attackIntervalFor, bossHpFor } from './battleConfig.js'

const DPS_BUCKET_MS = 5000
const DAMAGING_POSTURES = new Set(['slouch', 'forwardHead', 'handProp', 'headTilt', 'gazeAway'])

/**
 * 戰鬥判定核心。
 *
 * 時間一律由呼叫端傳入，本檔不讀系統時鐘——所有時間相關行為才能在測試裡瞬間跑完。
 * `t` 的意義是「距離該輪開始的毫秒數」（session-relative），不是 epoch 時間戳；
 * 內部時鐘從 0 起算，這樣第一個 tick 傳進來的 t 才會被完整計入 elapsed，
 * 不會平白遺失第一格 tick 的時間量（這曾經導致精確邊界測試少算一次攻擊／扣血）。
 * 呼叫端只在「頁面可見且推論正常」時呼叫 tick()；背景與暫停走各自的通知方法。
 */
export function createFocusStateMachine({ durationMs, demoMode = false }) {
  const attackIntervalMs = attackIntervalFor(demoMode)
  const bossHpMax = bossHpFor(durationMs, demoMode)

  let elapsedMs = 0
  let lastTickAt = 0
  let paused = false
  let hidden = false
  let hiddenSince = null

  let bossHp = bossHpMax
  // 當前形態的血量上限——第一形態就是 bossHpMax，之後每次補血進下一形態都會更新，
  // 純粹給 UI 畫血條用（讓血條能從滿血畫起，不會每次重生都卡在 40%），不影響戰鬥判定。
  let bossHpPhaseMax = bossHpMax
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
  // 「我沒有在玩那個」按下之後的豁免期（Blocking B3，見 battleConfig 的
  // phoneUndoGraceMs）。用場內時間倒數，暫停／背景時自動凍結。
  let phoneGraceRemainMs = 0
  // 最後一次**真的推進過**的 tick 算出來的 objectBlocking，給 snapshot 用。
  // 暫停／背景／dt=0 的那幾次 tick 會提早 return，此時這個值刻意維持不變——
  // 畫面本來就是凍結的，讓那句提示在暫停中閃掉再閃回來只會更難懂。
  let lastObjectBlocking = false
  let regroupRemainMs = 0
  // 重大違規 debuff（見 battleConfig.js 的 debuff* 三個常數）。
  // 兩個計時器刻意分開：debuffRemainMs 是「保險絲」（無論如何會過期），
  // debuffFocusMs 是「解法」（連續端正才累積，一不端正就歸零）。
  let debuffRemainMs = 0
  let debuffFocusMs = 0
  let wasDrowsy = false

  let trapSeq = 0
  const pendingTraps = [] // { trapId, kind, openedAtElapsed }
  // tick() 是唯一有「回傳事件流」這條路的方法——notifyVisible／undoTrap 都是外部
  // 事件觸發的方法，沒有機會回傳事件給呼叫端，所以先塞進這個通用 sink，改由下一次
  // tick() 開頭送出。任何「不是從 tick() 內部直接產生」的事件都走這裡。
  const pendingEvents = []

  const postureDurationMs = {
    upright: 0, slouch: 0, forwardHead: 0, handProp: 0, headTilt: 0, drowsy: 0, gazeAway: 0,
  }
  // 注意兩個欄位的時間基底不同：.phone 只在 tick() 實際推進時累加（場內時間，跟
  // elapsedMs 同基底，暫停/背景時凍結）；.away 是 notifyVisible 用原始 t（牆鐘時間）
  // 算出來的，暫停/背景本身就是它要量的東西，兩者不能直接相加或拿來算佔比分母。
  const distractionDurationMs = { phone: 0, away: 0 }
  const trapCount = { phone: 0, phoneUndone: 0, away: 0, awayUndone: 0 }
  const dpsSeries = []

  function recordDamage(amount) {
    // elapsedMs 已在本次 tick 累加過，攻擊發生在「剛結束的那 5 秒視窗」——
    // 用 elapsedMs - 1 讓落在整數秒邊界上的攻擊歸到「已完成」的那一格，而不是下一格。
    const bucket = Math.floor((elapsedMs - 1) / DPS_BUCKET_MS)
    while (dpsSeries.length <= bucket) dpsSeries.push(0)
    dpsSeries[bucket] += amount
  }

  function openTrap(kind, events) {
    trapSeq += 1
    const trapId = `${kind}-${trapSeq}`
    // 撤銷視窗用「場內時間」（elapsedMs）記帳，不是呼叫端傳來的原始 t：暫停或切到
    // 背景時 elapsedMs 本來就凍結，視窗自然跟著凍結，不會把小孩看通知、暫停的那段
    // 時間也算進 20 秒倒數，害他連按撤銷的機會都沒有就被判定生效。
    pendingTraps.push({ trapId, kind, openedAtElapsed: elapsedMs })
    events.push({ type: 'trapPending', trapId, kind })
  }

  function settleTraps(events) {
    for (let i = pendingTraps.length - 1; i >= 0; i--) {
      const trap = pendingTraps[i]
      if (elapsedMs - trap.openedAtElapsed < BATTLE.trapUndoWindowMs) continue
      pendingTraps.splice(i, 1)

      // 回血量本身還是用整體 bossHpMax 的 5% 算（brief 明文「Boss 回血 5% 上限」），
      // 但封頂用 bossHpPhaseMax，不是 bossHpMax：bossHpPhaseMax 就是「這個形態
      // 的魔王有多少血」的定義，用整體上限封頂會讓後期形態的血條顯示超過
      // 100%（實測：5 分鐘輪、陷阱正好在補血後 commit，bossHp 可以到 276 而
      // bossHpPhaseMax 只有 245，112.7%）。副作用是後期形態的陷阱懲罰會被
      // 截短——可以接受，能打到第三形態的小孩已經贏得很輕鬆了。
      const bossHeal = Math.round(bossHpMax * BATTLE.trapBossHealRatio)
      bossHp = Math.min(bossHpPhaseMax, bossHp + bossHeal)
      score = Math.max(0, score - BATTLE.trapScorePenalty)
      trapCount[trap.kind] += 1
      // 重大違規 → 上 debuff。第二次違規時刷新（保險絲重新計時、專注累積歸零）
      // 而不是疊加：疊加會讓連續兩次失誤變成一個幾乎解不掉的狀態，
      // 而這個機制的目的是給一條走得出去的路，不是把人釘在地上。
      const debuffWasActive = debuffRemainMs > 0
      debuffRemainMs = BATTLE.debuffMaxMs
      debuffFocusMs = 0
      if (!debuffWasActive) events.push({ type: 'debuffStart' })
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
    // 規則一：陷阱延後生效，沒有正式 commit 就等於沒發生。該輪結束時還懸在
    // 20 秒待確認期的陷阱直接清空，不留下「結束後還能被 undoTrap 竄改統計」
    // 的懸空狀態（undoTrap 本身也會擋掉已結束的呼叫，見下方）。
    pendingTraps.length = 0
    events.push({ type: 'sessionEnd', result })
  }

  return {
    tick({ t, posture, drowsy, phoneVisible }) {
      const events = []
      if (ended) return events

      // notifyVisible／undoTrap 無法直接回傳事件，改由下一次 tick 送出
      if (pendingEvents.length) {
        events.push(...pendingEvents.splice(0))
      }

      // dt 上限保護：主執行緒偶爾卡住時不該一次補發十幾次攻擊
      const dt = Math.max(0, Math.min(t - lastTickAt, 2000))
      lastTickAt = t
      if (paused || hidden || dt === 0) return events

      elapsedMs = Math.min(elapsedMs + dt, durationMs)

      // --- 撤銷豁免期（Blocking B3）---
      //
      // `objectBlocking` 取代這個函式裡原本每一處的 `phoneVisible`：偵測本身
      // 沒變（`distractionDurationMs` 以外的每一個消費者要問的都不是「有沒有
      // 偵測到」，而是「這個偵測現在算不算數」）。小孩明確說過「那不是我的」
      // 之後的這 60 秒，答案是不算數——攻擊、debuff 解除、下一次陷阱累積
      // **三者一起**恢復，而不是只恢復其中一項。
      //
      // 只恢復一部分是上一版的錯誤形狀：卡片消失（看起來被接受了）但攻擊仍然
      // 被封鎖。撤銷要嘛整段撤銷，要嘛按鈕就不該那樣寫。
      if (phoneGraceRemainMs > 0) phoneGraceRemainMs = Math.max(0, phoneGraceRemainMs - dt)
      const objectBlocking = phoneVisible && phoneGraceRemainMs <= 0
      lastObjectBlocking = objectBlocking

      // --- 統計（七個桶互斥，總和等於 elapsedMs）---
      if (drowsy) postureDurationMs.drowsy += dt
      else postureDurationMs[posture] += dt
      // 豁免期內不計入分心時間：結算頁用這個數字對小孩說「手機出現 N 分鐘」，
      // 而這 60 秒正是他已經明確否認過的那一段。把它算進去等於當著他的面
      // 把撤銷收回來。
      if (objectBlocking) distractionDurationMs.phone += dt

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
        // `!phoneVisible`：實機驗收的要求——「只要拿手機就不會攻擊」。
        // 這一條讓規則變得容易理解：東西在畫面上 = 你沒有在做事 = 魔王不掉血。
        //
        // 它是**軟後果**，跟陷阱那條**硬後果**刻意分成兩層：
        //   軟：東西一出現，立刻停止攻擊。東西一離開畫面，立刻恢復。
        //       誤判的代價只是這幾秒沒打到，而且會自己復原，不需要任何補救動作。
        //   硬：持續 3 秒才開陷阱，再給 20 秒撤銷期，沒撤銷才扣分／回血／上 debuff。
        // 分兩層的理由是誤判：路人的手機進到畫面時，小孩付得起軟後果，
        // 付不起硬後果。那 20 秒撤銷視窗存在的全部意義就在這裡。
        //
        // attackAccumMs 刻意**不歸零**（只是停止累加）：那是這個檔案一路遵守的
        // 「先前累積的進度不該被沒收」原則，同 regroup 那段註解。
        if (posture === 'upright' && !objectBlocking) {
          attackAccumMs += dt
          while (attackAccumMs >= attackIntervalMs) {
            attackAccumMs -= attackIntervalMs
            // debuff 中傷害減半。用 Math.round 而不是 Math.floor：floor 在
            // damagePerAttack 是奇數時會多吃掉半點傷害，而這個數字日後可能被調。
            const damage = debuffRemainMs > 0
              ? Math.round(BATTLE.damagePerAttack * BATTLE.debuffDamageRatio)
              : BATTLE.damagePerAttack
            bossHp -= damage
            if (phase > 1) phase2Damage += damage
            score += BATTLE.scorePerHit
            attacks += 1
            // debuff 中不累積連擊：連擊是「持續做對」的獎勵，重大違規之後
            // 要先把 debuff 解掉才重新取得那個獎勵。
            if (debuffRemainMs <= 0) streak += 1
            recordDamage(damage)
            events.push({ type: 'attack', damage, bossHp: Math.max(0, bossHp), score, streak })

            // 提早擊倒不結束該輪：補血進下一形態，否則等於獎勵提早結束讀書。
            // 形態可以一直往上加（brief「第二（含以上）形態」），每次都補原始
            // 上限的 40%，不是遞減也不是遞增——專注率高的小孩應該一直有東西可打。
            if (bossHp <= 0) {
              phase += 1
              bossHp = Math.round(bossHpMax * BATTLE.phase2RefillRatio)
              bossHpPhaseMax = bossHp
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
            // 攻擊累加器不歸零：規則二講的「暫停不歸零」同樣適用於重整旗鼓這種
            // 較嚴重的中斷——玩家先前姿態端正時已經累積的進度不該因為後面
            // 姿態不良導致倒地而被沒收，否則等於變相懲罰之前的專注。
            regroupRemainMs = BATTLE.regroupMs
            postureDamageAccumMs = 0
            events.push({ type: 'regroupStart' })
          }
        }
      }

      // --- 重大違規 debuff 的兩個計時器 ---
      //
      // 刻意放在 regroup 的 if/else **之外**、但只在非 regroup 時推進：
      // 重整旗鼓期間玩家對 debuff 完全沒有主導權（不能攻擊、姿態也不計分），
      // 讓保險絲在那段時間空轉等於「躺著就能等它過去」，讓專注累積器在那段
      // 時間歸零又等於沒收他之前的進度——兩邊都不對，所以兩個計時器一起凍結。
      // 這跟上面 regroup 註解寫的「先前累積的進度不該被沒收」是同一條原則。
      if (debuffRemainMs > 0 && regroupRemainMs <= 0) {
        debuffRemainMs -= dt
        if (debuffRemainMs <= 0) {
          // 保險絲燒斷：不是因為他做到了，是因為時間到。理由見 battleConfig.js
          // 的 debuffMaxMs——在真實閾值量出來之前，這條路必須存在。
          debuffRemainMs = 0
          debuffFocusMs = 0
          events.push({ type: 'debuffEnd', reason: 'expired' })
        } else if (posture === 'upright' && !objectBlocking) {
          // `!objectBlocking` 這個條件是測試逼出來的，不是一開始就想到的：
          // 少了它，小孩可以一手拿著手機、一邊坐得筆直，把手機造成的 debuff
          // 解掉——而陷阱是邊緣觸發、整場只罰一次（見下方註解），所以他可以
          // 就這樣一直拿著。解除條件必須包含「造成違規的那件事已經停止」，
          // 否則這個機制等於在獎勵「被抓到之後坐正一點就好」。
          //
          // ── 這裡原本還有一個 `!drowsy`，已經拿掉（複審 M3／I-1）──
          //
          // battleConfig.js 的 debuff 註解自己寫著：「駝背與打瞌睡**不算**
          // （重大違規）：那些是姿勢問題不是違規，而打瞌睡常常來自沒睡飽或
          // 身體不舒服，**懲罰它不對**。」那條原則在「會不會中 debuff」這一側
          // 被遵守了，卻在「解不解得掉」這一側被推翻——打瞌睡不會讓你中招，
          // 但會讓你**出不去**。對一個真的很累的 12 歲小孩，兩者的效果一樣。
          //
          // 更直接的理由是紅線：畫面上寫著「再專心 30 秒」，而他明明正坐得
          // 筆直，那個數字一秒都不會動。90 秒保險絲夠讓它終止，**但不夠讓
          // 文案誠實**——那 90 秒裡畫面每一秒都在對他說一句做不到的話。
          //
          // 反向風險（明文評估過）：這會讓「一邊打瞌睡一邊坐得筆直」也能解
          // debuff。那個組合在真機上幾乎不存在（drowsy 來自閉眼／低頭，而
          // `posture === 'upright'` 要求耳肩高度正常），而且就算發生，代價
          // 也只是一個很累的小孩提早脫離懲罰——那正是我們想要的方向。
          //
          // `!objectBlocking` 留著的理由跟 drowsy 完全相反：拿著手機是**他
          // 做得到、也做得出來**的選擇，而打瞌睡不是。
          debuffFocusMs += dt
          if (debuffFocusMs >= BATTLE.debuffClearFocusMs) {
            debuffRemainMs = 0
            debuffFocusMs = 0
            events.push({ type: 'debuffEnd', reason: 'cleared' })
          }
        } else {
          // 「連續」是這個機制的全部重量。中斷就歸零，不是扣一點。
          debuffFocusMs = 0
        }
      }

      // --- 手機陷阱 ---
      // v1 決定：手機只要一直留在畫面上，只在第一次連續 3 秒時觸發一次陷阱，之後
      // 不會週期性重觸發（見下方 before<phoneTrapHoldMs 的邊緣觸發寫法）。這是刻意
      // 的選擇，不是漏做——週期性重罰需要一個新的冷卻常數，但沒有依據能決定它該
      // 是多少；每隔幾十秒扣 100 分對這個年齡層是懲罰迴圈，不是教育。「整場把手機
      // 擺著只罰一次」用既有資料誠實反映：distractionDurationMs.phone 本來就會持續
      // 累加（不受這個陷阱是否已觸發影響），結算畫面用這個數字做回饋（例如「手機
      // 出現 12 分鐘」），教育回饋放在結算而不是放在懲罰迴圈裡。
      if (objectBlocking) {
        const before = phoneHoldMs
        phoneHoldMs += dt
        if (!phoneWarned && phoneHoldMs >= BATTLE.phoneWarnAtMs) {
          phoneWarned = true
          events.push({ type: 'trapWarning', kind: 'phone', remainMs: BATTLE.phoneTrapHoldMs - phoneHoldMs })
        }
        if (before < BATTLE.phoneTrapHoldMs && phoneHoldMs >= BATTLE.phoneTrapHoldMs) {
          openTrap('phone', events)
        }
      } else {
        phoneHoldMs = 0
        phoneWarned = false
      }

      settleTraps(events)
      if (elapsedMs >= durationMs) finish(events)
      return events
    },

    setPaused(t, next) {
      paused = next
      lastTickAt = t
    },

    notifyHidden(t) {
      // 重入防呆：iPad Safari PWA 的 visibilitychange／pagehide／freeze／blur 很容易
      // 對同一次「離開」連續觸發好幾個事件。若沒有這個 guard，晚到的第二次呼叫會
      // 用它自己的 t 覆寫 hiddenSince，把「已經離開」的那段時間平白吃掉——後面
      // notifyVisible 算出來的 awayMs 會比真正離開的時間短，5 秒門檻附近的 away
      // 陷阱就可能該觸發卻沒觸發。已經是 hidden 狀態時，後續的 notifyHidden 呼叫
      // 直接忽略，只認第一次。
      if (hidden) return
      hidden = true
      hiddenSince = t
      lastTickAt = t
    },

    notifyVisible(t) {
      if (!hidden) return
      hidden = false
      // awayMs 刻意用呼叫端傳來的原始 t（牆鐘時間），不是場內的 elapsedMs——
      // 暫停/背景期間 elapsedMs 本來就不會前進，這裡要量的正是那段牆鐘上真正
      // 流逝的時間，兩者不能混用。
      const awayMs = Math.max(0, t - (hiddenSince ?? t))
      hiddenSince = null
      lastTickAt = t
      distractionDurationMs.away += awayMs
      if (awayMs > BATTLE.awayTrapMs && !ended) {
        openTrap('away', pendingEvents)
      }
    },

    undoTrap(trapId) {
      // 這行防禦目前其實打不到：finish() 已經把 pendingTraps 清空（見上面），
      // 所以 ended 之後 findIndex 一定是 −1，下面那行本來就會回傳 false。
      // 留著是縱深防禦——萬一 finish() 清空 pendingTraps 那行以後被改掉，這裡
      // 還能單獨擋住「結束後改動統計」這件事，不用同時看兩處程式碼才能確認
      // 這個不變式成立。
      if (ended) return false
      const i = pendingTraps.findIndex((p) => p.trapId === trapId)
      if (i === -1) return false
      const [trap] = pendingTraps.splice(i, 1)
      trapCount[`${trap.kind}Undone`] += 1
      // Blocking B3：撤銷要有**立刻可觀察的效果**。
      //
      // 上一版只做到這裡的上一行——陷阱被移走（不扣分、不回血、不上 debuff），
      // 卡片消失，看起來像被接受了，但 `phoneVisible` 沒變、攻擊仍然被封鎖。
      // 小孩明確地對系統說「那不是我的」，系統把訊息收掉了，然後魔王繼續
      // 一滴血都不掉，而且再也沒有任何文字。
      //
      // 現在撤銷 phone 陷阱＝對這一段「東西在畫面上」的判定**整體**撤銷：
      //   - 給一段豁免期（60 秒，理由見 battleConfig 的 phoneUndoGraceMs），
      //     期間攻擊恢復、debuff 解得掉、分心時間不累計；
      //   - `phoneHoldMs` / `phoneWarned` 歸零，豁免期結束後一切從頭來過
      //     （所以不會變成「按一次就整場免疫」）。
      // 小孩按完的下一秒就會看到魔王重新開始掉血——那是這顆鈕的承諾。
      if (trap.kind === 'phone') {
        phoneGraceRemainMs = BATTLE.phoneUndoGraceMs
        phoneHoldMs = 0
        phoneWarned = false
      }
      // undoTrap 不是從 tick() 內部呼叫的，沒有機會回傳事件——跟 notifyVisible
      // 一樣塞進 pendingEvents，下一次 tick() 開頭送出。
      pendingEvents.push({ type: 'trapUndone', trapId: trap.trapId, kind: trap.kind })
      return true
    },

    snapshot() {
      const dpsBucketsNeeded = Math.ceil(elapsedMs / DPS_BUCKET_MS)
      const paddedDpsSeries = [...dpsSeries]
      while (paddedDpsSeries.length < dpsBucketsNeeded) paddedDpsSeries.push(0)

      return {
        elapsedMs, durationMs, bossHp: Math.max(0, bossHp), bossHpMax, bossHpPhaseMax,
        playerHp, score, attacks, streak, phase, phase2Damage,
        regrouping: regroupRemainMs > 0, ended, result,
        /**
         * 「畫面上有東西，而且那個判定現在算數」——也就是攻擊正在被它封鎖。
         *
         * 這個欄位存在的理由是 Blocking B2／B3 共同的那個症狀：軟後果
         * （東西在畫面上 ⇒ 魔王不掉血）**完全沒有視覺語言**。硬後果有蓄力
         * 動畫、大招、傷害數字、CoachBanner、撤銷鈕、倒數；軟後果什麼都沒有，
         * 而它會讓核心機制整個停擺。t=23s 卡片 TTL 過期之後，畫面上再也沒有
         * 任何字，小孩只會以為是自己坐得不夠好。
         *
         * 它跟封鎖**同生共死**（沒有 TTL）：只要攻擊被封鎖，畫面上就必須有
         * 一句話說得出為什麼。這也是撤銷之後「看得出來有用」的另一半——
         * 那句話會當場消失。
         *
         * 注意它不等於 `phoneVisible`：撤銷豁免期內偵測仍然是 true，但判定
         * 不算數、攻擊沒有被封鎖，所以這個欄位是 false，畫面上不該再有那句話。
         */
        objectBlocking: lastObjectBlocking,
        // debuff 的兩個對外欄位。UI 要顯示的是 debuffFocusRemainMs
        // （「再專心 N 秒」）——它本身就是說明書，比任何圖示都清楚，
        // 而且它指向動作而不是指向「你有問題」。
        debuffed: debuffRemainMs > 0,
        debuffRemainMs: Math.max(0, Math.round(debuffRemainMs)),
        debuffFocusRemainMs: debuffRemainMs > 0
          ? Math.max(0, Math.round(BATTLE.debuffClearFocusMs - debuffFocusMs))
          : 0,
        // 欄位叫 deadlineAtElapsed 不是 deadlineAt：值是「場內時間」（elapsedMs）
        // 單位，不是原始 t／牆鐘時間，跟撤銷視窗的記帳基準（見 openTrap）一致，
        // 暫停/背景時會自動跟著凍結。取名把單位寫進名字裡，不然接 UI 的人如果
        // 拿 performance.now() 去減這個值，倒數會整個算錯，而且不會報錯、
        // 只會顯示鬼數字——沒有踩到的人不會發現。
        pendingTraps: pendingTraps.map((p) => ({
          trapId: p.trapId, kind: p.kind, deadlineAtElapsed: p.openedAtElapsed + BATTLE.trapUndoWindowMs,
        })),
        postureDurationMs: { ...postureDurationMs },
        distractionDurationMs: { ...distractionDurationMs },
        trapCount: { ...trapCount },
        dpsSeries: paddedDpsSeries,
      }
    },
  }
}
