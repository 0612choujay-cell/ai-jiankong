import { NO_VOICE_BOSS_KEYS, NO_VOICE_PRAISE_BOSS_KEYS } from '../data/copy/boss.js'
import { NO_VOICE_POSTURE_KEYS } from '../data/copy/posture.js'

/** 安全/休息 > 姿態修正 > 陷阱原因 > 戰鬥數值特效 */
export const PRIORITY = Object.freeze({ safety: 4, posture: 3, trap: 2, battle: 1 })

/**
 * 每個 namespace 底下永遠不得朗讀的 key。查表而非寫成一條條 if——
 * 以後多一個 namespace（例如未來新增別的分心來源）只要在這裡加一列，
 * 不會有人在 publish() 裡漏加第二個 if。
 */
const NO_VOICE = { boss: NO_VOICE_BOSS_KEYS, posture: NO_VOICE_POSTURE_KEYS }

/**
 * 第二張表，跟 NO_VOICE 分開放：那張是尊嚴保護（分心類），這張是純粹嫌吵
 * （戰況旁白）。兩者都會讓 voice 變 false，但語意不同，混在同一張表裡會讓
 * messageQueue.test.js 那條「NO_VOICE 恰好等於分心語意」的測試失去鑑別力
 * ——理由見 data/copy/boss.js 的 NO_VOICE_PRAISE_BOSS_KEYS 檔頭註解。
 */
const QUIET = { boss: NO_VOICE_PRAISE_BOSS_KEYS }

/**
 * 單一 priority store，同時最多顯示一則。
 *
 * 低優先直接丟棄而非排隊：排隊會讓提示在事過境遷之後才冒出來，
 * 使用者看到「背靠椅背」的時候人早就坐正了，只會覺得系統在亂講。
 *
 * MessageQueue 是所有要顯示／朗讀的訊息唯一必經的仲裁者，所以「分心類提示
 * 不得朗讀」這條紅線放在這裡才是結構上擋死的——不能指望每個發布訊息的
 * 呼叫端（現在的 postureCoach、未來的 BattleView…）都自己記得查
 * NO_VOICE_BOSS_KEYS／NO_VOICE_POSTURE_KEYS，也不能指望未來的語音播放端
 * 自己再判斷一次能不能念。
 */
export function createMessageQueue() {
  let active = null // { kind, text, priority, ttlMs, voice, icon, shownAt }

  function expired(now) {
    return active !== null && now - active.shownAt >= active.ttlMs
  }

  return {
    publish(message, now) {
      const next = { voice: false, icon: null, ttlMs: 4000, ns: null, key: null, ...message, shownAt: now }

      // 要念出聲的句子一定要能追溯到文案表的哪一條 key；不能追溯就不准念。
      // 這樣未來有人忘了帶 ns/key 會當場炸掉，而不是靜悄悄地念出去。
      if (next.voice === true) {
        if (!next.ns) {
          throw new TypeError(
            `messageQueue.publish: voice:true 的訊息缺少 ns（kind="${next.kind}"）`)
        }
        if (!next.key) {
          throw new TypeError(
            `messageQueue.publish: voice:true 的訊息缺少 key（kind="${next.kind}"）`)
        }
      }

      // 分心類台詞一律不朗讀：無條件覆寫，不管呼叫端傳了什麼。
      // 不是報錯、不是拒絕發布——訊息照樣顯示，只是不准念出聲。
      if (NO_VOICE[next.ns]?.includes(next.key)) {
        next.voice = false
      }
      // 戰況旁白太吵：同樣無條件覆寫、同樣只關語音不關畫面，但跟上面那條
      // 是兩個不同的判斷（見 QUIET 常數註解）。
      if (QUIET[next.ns]?.includes(next.key)) {
        next.voice = false
      }

      if (active === null || expired(now)) { active = next; return true }
      if (next.kind === active.kind) { active = next; return true }   // 同類刷新
      if (next.priority > active.priority) { active = next; return true } // 搶佔
      return false // 丟棄
    },

    current(now) {
      if (active === null || expired(now)) return null
      return active
    },

    clear() {
      active = null
    },
  }
}
