import { PRIORITY } from './messageQueue.js'

/**
 * 複審 B-2：這份對照表跟下面的 formatPostureMessage() 合成出來的句子，
 * 才是使用者實際會看到／聽到的文字——原本的三個 label（'你駝背了' 4 字、
 * '你低頭太久了' 6 字、'你的視線離開了' 7 字）各自看起來都很短，但跟
 * POSTURE_COPY 的姿態指令合成之後最長觸及 24 字，而且帶 voice:true，
 * 會被 TTS 唸出來——只掃 posture.js 字面量的護欄完全看不到這個，因為
 * 每個字串片段各自都合規，超標是「合成」這個動作造成的。
 * 縮短成統一 3 字，讓合成後的最壞情況仍 ≤15 字（見 posture.js 的
 * forwardHead/slouch 調整說明，與 copyGuardrail.test.js 對
 * formatPostureMessage() 的窮舉測試）。
 */
export const CAUSE_LABEL = {
  slouch: '駝背了',
  forwardHead: '低頭了',
  handProp: '撐頭了',
  headTilt: '歪頭了',
  gazeAway: '分心了',
}

/** 前 3 次講因果，之後只講指令——重複解釋為什麼被打只是囉唆 */
export const CAUSE_FORMAT_LIMIT = 3

/**
 * 把「因果標籤」與「姿態指令」合成成一句要顯示／可能被朗讀的訊息。
 * 抽成不依賴 copy/mq 的純函式，是複審 B-2 的直接要求：護欄要能拿這個
 * 函式窮舉所有輸入組合（每個 reason × POSTURE_COPY 該 reason 底下的
 * 每一句 × repeat），對「合成後的輸出」斷言長度，而不是只看 posture.js
 * 裡個別字串字面量的長度——字面量各自合規不代表合成後仍然合規。
 */
export function formatPostureMessage({ reason, lineText, repeat }) {
  if (repeat <= CAUSE_FORMAT_LIMIT && CAUSE_LABEL[reason]) {
    return `${CAUSE_LABEL[reason]}，${lineText}`
  }
  return lineText
}

export function createPostureCoach({ copy, mq }) {
  return {
    handle(events, { drowsy }, now) {
      // 1. 安全/休息最優先
      if (drowsy && events.some((e) => e.type === 'drowsy')) {
        const line = copy.take('posture', 'drowsy', {}, now)
        if (line) {
          mq.publish({ kind: 'safety', priority: PRIORITY.safety, text: line.text,
                       ttlMs: 8000, voice: line.repeat === 1, icon: 'rest', showBreakButton: true,
                       ns: 'posture', key: 'drowsy' }, now)
          return
        }
      }

      // 2. 姿態修正——優先序高於陷阱原因（PRIORITY.posture > PRIORITY.trap），
      //    所以要先判斷這裡，命中就 return。順序反過來的話，同一次 events
      //    裡若 trapPending 跟 playerDamage 同時出現，trap 會搶先 return，
      //    姿態提示就永遠發不出去，跟宣告的優先序正好相反。
      const hit = events.find((e) => e.type === 'playerDamage')
      if (hit && CAUSE_LABEL[hit.reason]) {
        const line = copy.take('posture', hit.reason, {}, now)
        if (line) {
          const text = formatPostureMessage({ reason: hit.reason, lineText: line.text, repeat: line.repeat })
          mq.publish({ kind: 'posture', priority: PRIORITY.posture, text,
                       ttlMs: 6000, voice: line.repeat === 1, icon: hit.reason,
                       ns: 'posture', key: hit.reason }, now)
          return
        }
      }

      // 3. 陷阱：只講具體原因，一律不朗讀
      //    用語音念出「偵測到手機」等於把使用者被抓包的事廣播給旁邊的人
      const pending = events.find((e) => e.type === 'trapPending')
      if (pending) {
        const key = pending.kind === 'phone' ? 'phone' : 'away'
        const line = copy.peek('posture', key, {})
        if (line) {
          mq.publish({ kind: 'trap', priority: PRIORITY.trap, text: line.text,
                       ttlMs: 20_000, voice: false, icon: key, trapId: pending.trapId,
                       ns: 'posture', key }, now)
        }
      }
    },
  }
}
