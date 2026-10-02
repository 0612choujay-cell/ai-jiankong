import { describe, it, expect } from 'vitest'
import { copyKeyForEvent } from './bossDialogue.js'

describe('copyKeyForEvent', () => {
  it('attack 依連擊數分流 hit / combo', () => {
    expect(copyKeyForEvent({ type: 'attack', streak: 1 })).toEqual({ ns: 'boss', key: 'hit' })
    expect(copyKeyForEvent({ type: 'attack', streak: 3 })).toEqual({ ns: 'boss', key: 'combo' })
  })

  it('trapCommitted 依 kind 分流 phoneTrap / awayTrap', () => {
    expect(copyKeyForEvent({ type: 'trapCommitted', kind: 'phone' }).key).toBe('phoneTrap')
    expect(copyKeyForEvent({ type: 'trapCommitted', kind: 'away' }).key).toBe('awayTrap')
  })

  it('drowsy / regroupStart / phase / sessionEnd 各自對應正確 key', () => {
    expect(copyKeyForEvent({ type: 'drowsy' }).key).toBe('drowsy')
    expect(copyKeyForEvent({ type: 'regroupStart' }).key).toBe('regroup')
    expect(copyKeyForEvent({ type: 'phase' }).key).toBe('phase2')
    expect(copyKeyForEvent({ type: 'sessionEnd', result: 'victory' }).key).toBe('victory')
    expect(copyKeyForEvent({ type: 'sessionEnd', result: 'timeout' }).key).toBe('timeout')
  })

  it('未知事件型別回傳 null', () => {
    expect(copyKeyForEvent({ type: 'unknown' })).toBe(null)
  })

  /**
   * Task 22d：`BOSS_COPY.open`（src/data/copy/boss.js 的三句開場台詞）是死
   * 文案，決定與追查過程見 bossDialogue.js 裡 keyFor() 上方的註解——這裡
   * 窮舉 focusStateMachine.js 目前會產生的**全部** event.type（不是只測
   * 上面幾條測試已經涵蓋的那幾種），加一個明確的未知型別，鎖住「沒有任何
   * 一種事件會映射到 'open'」這個結論。資料池本身尚未清理（那需要編輯
   * src/data/copy/boss.js，不在本工項的檔案界線內），所以只斷言「不會被
   * 觸發」，不斷言「資料已經被刪除」。
   */
  it('open 這個 BOSS_COPY key 目前沒有任何事件會映射到它（死文案，決定見 bossDialogue.js 註解）', async () => {
    const { BOSS_COPY } = await import('../data/copy/boss.js')

    const allKnownEventTypes = [
      { type: 'attack', streak: 1 },
      { type: 'attack', streak: 3 },
      { type: 'trapCommitted', kind: 'phone' },
      { type: 'trapCommitted', kind: 'away' },
      { type: 'trapPending', trapId: 't1', kind: 'phone' },
      { type: 'trapWarning', kind: 'phone', remainMs: 1000 },
      { type: 'trapUndone', trapId: 't1', kind: 'phone' },
      { type: 'phase' },
      { type: 'regroupStart' },
      { type: 'regroupEnd', playerHp: 1 },
      { type: 'drowsy' },
      { type: 'playerDamage', amount: 1, playerHp: 1, reason: 'slouch' },
      { type: 'sessionEnd', result: 'victory' },
      { type: 'sessionEnd', result: 'timeout' },
      { type: 'unknown' },
    ]
    for (const event of allKnownEventTypes) {
      expect(copyKeyForEvent(event)?.key, `event.type=${event.type} 不該映射到 open`).not.toBe('open')
    }

    // `open` 已於 Task 22d 後續實際從 BOSS_COPY 刪除，所以原本那條
    // 「自我檢查：資料池還留著 open」的斷言不再成立，換成一條更強的不變式。
    //
    // 為什麼換成這個而不是直接斷言 `BOSS_COPY.open` 是 undefined：
    // 後者只鎖住一個已經處理完的個案，日後不會再紅。下面這條鎖的是通則——
    // **`copyKeyForEvent()` 回得出來的每一個 key，都必須真的存在於資料池**。
    // 它同時涵蓋兩個方向的迴歸：有人把 `open` 加回資料池卻沒有觸發事件
    // （上面的窮舉會抓到），以及有人新增一個映射到不存在 key 的事件
    // （這裡會抓到，症狀是戰鬥中該說話的時候整個靜音、畫面上什麼都沒有）。
    expect(BOSS_COPY.open).toBeUndefined()
    for (const event of allKnownEventTypes) {
      const key = copyKeyForEvent(event)?.key
      if (!key) continue
      expect(
        Object.prototype.hasOwnProperty.call(BOSS_COPY, key),
        `event.type=${event.type} 映射到的 '${key}' 不存在於 BOSS_COPY`,
      ).toBe(true)
    }
  })

  /**
   * Task 15 複審第 1 輪（Important）：這裡原本有兩條測試鎖住
   * 「copyKeyForEvent 自己算出 voice:false／true」——那正是複審要拿掉的東西。
   * `bossDialogue.js` 跟 `messageQueue.js` 都是從同一份
   * `NO_VOICE_BOSS_KEYS`（data/copy/boss.js）匯入，資料不會漂移，但「同一份
   * 資料被算兩次」本身就是問題：多算的那一次唯一的實際後果，是讓端到端測試
   * 對 messageQueue 這個唯一仲裁者失去鑑別力（複審驗過：就算把這裡的 voice
   * 改成永遠 true，經過 messageQueue 之後的端到端測試依然全線綠燈）。
   *
   * 所以這裡改成鎖住新的不變量：`copyKeyForEvent()` 的回傳值**結構上就不帶
   * `voice` 這個欄位**——不是「算出來剛好是 undefined」，是「這裡從頭到尾
   * 沒有算過這件事」。分心類提示不朗讀的保證，完整測試在
   * messageQueue.test.js（NO_VOICE 表覆寫）與
   * voiceArbitration.integration.test.js（接上真正的 voiceFeedback，證明
   * messageQueue 那層單獨就足夠）。
   */
  it('回傳值不帶 voice 欄位——是否朗讀全權交給 messageQueue 的 NO_VOICE 表決定，這裡不重複算', () => {
    const events = [
      { type: 'attack', streak: 1 },
      { type: 'trapCommitted', kind: 'phone' },
      { type: 'trapCommitted', kind: 'away' },
      { type: 'drowsy' },
    ]
    for (const event of events) {
      const result = copyKeyForEvent(event)
      expect(result).not.toBe(null)
      expect(Object.hasOwn(result, 'voice')).toBe(false)
      expect(Object.keys(result).sort()).toEqual(['key', 'ns'])
    }
  })
})
