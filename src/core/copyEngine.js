/**
 * 樣板變數代換：`{name}` → `vars.name`，找不到對應變數就原樣保留（不炸、不吃字）。
 *
 * 獨立匯出（Task 18）：`src/core/summary.js` 也需要用 `SUMMARY_COPY` 的樣板
 * 代換出結算頁文案，跟這裡是同一套規則——不要各自重寫一份代換邏輯，否則兩邊
 * 的佔位符語法（`{xxx}`）哪天不一致了也看不出來。
 */
export function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)
}

/**
 * 單一取句器。負責 shuffle bag 與 cooldown。
 *
 * 節流比擴充文案池重要：文案池再大，每 5 秒響一次也是噪音。
 * 時間由呼叫端傳入，本檔不讀系統時鐘。
 */
export function createCopyEngine({ pools, cooldownMs = 45_000 }) {
  let bags = new Map()      // `${ns}/${key}` → 尚未取用的索引陣列
  let lastTakenAt = new Map()
  let repeatCount = new Map()

  function linesOf(ns, key) {
    const lines = pools?.[ns]?.[key]
    return Array.isArray(lines) && lines.length > 0 ? lines : null
  }

  function draw(ns, key, lines) {
    const id = `${ns}/${key}`
    let bag = bags.get(id)
    if (!bag || bag.length === 0) {
      bag = lines.map((unused, i) => i)
      // Fisher-Yates
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[bag[i], bag[j]] = [bag[j], bag[i]]
      }
      bags.set(id, bag)
    }
    return lines[bag.pop()]
  }

  return {
    take(ns, key, vars = {}, now) {
      // now 沒有預設值：呼叫端忘記傳入時若靜默當作 0，會讓 `now - last`
      // 永遠小於 cooldownMs，該 key 從此被 cooldown 卡死且沒有任何錯誤訊息。
      // 寧可當場拋錯，也不要算出一個看似合理、實際永遠卡住的結果。
      if (typeof now !== 'number' || !Number.isFinite(now)) {
        throw new TypeError(`createCopyEngine.take: now 必須是有限數字，收到 ${String(now)}`)
      }

      const lines = linesOf(ns, key)
      if (!lines) return null

      const id = `${ns}/${key}`
      const last = lastTakenAt.get(id)
      if (last !== undefined && now - last < cooldownMs) return null

      lastTakenAt.set(id, now)
      const repeat = (repeatCount.get(id) ?? 0) + 1
      repeatCount.set(id, repeat)
      return { text: fillTemplate(draw(ns, key, lines), vars), repeat }
    },

    // peek 刻意不呼叫 draw()：draw() 會就地變異 shuffle bag（pop），
    // 若 peek 沿用它，結算畫面多看幾眼就會偷偷吃光/打亂遊戲進行中
    // take() 的供句順序。peek 只讀 pools，不碰 bags／lastTakenAt／repeatCount。
    peek(ns, key, vars = {}) {
      const lines = linesOf(ns, key)
      if (!lines) return null
      const idx = Math.floor(Math.random() * lines.length)
      return { text: fillTemplate(lines[idx], vars), repeat: 1 }
    },

    resetSession() {
      bags = new Map()
      lastTakenAt = new Map()
      repeatCount = new Map()
    },
  }
}
