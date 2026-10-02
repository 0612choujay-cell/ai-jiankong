// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createApp, reactive, nextTick } from 'vue'
import bossSpriteSource from './BossSprite.vue?raw'
import battleViewSource from './BattleView.vue?raw'
import BossSprite from './BossSprite.vue'

/**
 * ── 這一組測試鎖得到什麼、鎖不到什麼（誠實聲明）────────────────────────
 *
 * 鎖得到（全部都是**結構性事實**，jsdom 量得到或原始碼掃得到）：
 *   - 四種狀態（待機／被打／蓄力／大招）的 class 在正確的 prop 下出現與消失
 *   - 魔王節點維持 aria-hidden="true"（純裝飾，語意由既有文字提示負責）
 *   - 造型是 inline SVG，沒有任何外部資產（離線展場裝置，CSP 會靜默擋掉）
 *   - 所有 @keyframes 只動 transform／opacity（擋的是日後有人順手加一個
 *     filter: blur() 就讓 MediaPipe 推論被 perfMonitor 永久降檔）
 *   - prefers-reduced-motion 的分支真的存在，而且真的關掉那四個動畫
 *
 * 鎖不到（只能靠人看、靠真機）：
 *   - **畫出來好不好看**。Q 版夠不夠可愛、會不會嚇到小孩、三種狀態一眼
 *     分不分得出來、場景會不會搶戲——jsdom 不排版、不繪圖，沒有任何
 *     自動化測試能回答這些問題。
 *   - 動畫的節奏與幅度是否舒服，以及它在 M1 iPad 上實際的合成成本。
 *   - 顏色在真實螢幕上的對比與觀感。
 * 這裡刻意不寫「看起來在測版面、其實永遠會綠」的測試——那比沒有測試更危險。
 */

function mount(props = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const state = reactive({ phase: 1, ...props })
  const Host = {
    components: { BossSprite },
    template:
      '<BossSprite :struck="state.struck" :charging="state.charging" :ultimate="state.ultimate" '
      + ':attacking="state.attacking" :phase="state.phase" />',
    setup() { return { state } },
  }
  const app = createApp(Host)
  app.mount(el)
  return { el, app, state }
}

// --- CSS 掃描小工具（跟 StatusIndicator.test.js／BattleView.test.js 既有的
//     原始碼掃描同一路做法：jsdom 不做 CSS 級聯，本專案的 vitest 也關掉了
//     CSS 處理，拿 getComputedStyle 斷言動畫屬性會是一條永遠讀到瀏覽器
//     預設值的假測試） ---

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function styleOf(source) {
  const m = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  expect(m, '找不到 <style> 區塊').not.toBeNull()
  return stripCssComments(m[1])
}

/** 逐個抓出 @keyframes 的完整內容（keyframes 裡面還有一層大括號，
 *  不能用單純的 /\{[^}]*\}/ ——那只會抓到第一格）。 */
function extractKeyframes(css) {
  const out = []
  const re = /@keyframes\s+([\w-]+)\s*\{/g
  let m = re.exec(css)
  while (m) {
    let depth = 1
    let i = re.lastIndex
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') depth -= 1
      i += 1
    }
    out.push({ name: m[1], body: css.slice(re.lastIndex, i - 1) })
    re.lastIndex = i
    m = re.exec(css)
  }
  return out
}

/** 取出一段 keyframes body 裡所有宣告過的屬性名 */
function declaredProps(body) {
  const props = new Set()
  for (const block of body.matchAll(/\{([^{}]*)\}/g)) {
    for (const decl of block[1].split(';')) {
      const name = decl.split(':')[0].trim().toLowerCase()
      if (name) props.add(name)
    }
  }
  return props
}

describe('BossSprite：四種狀態的 class（真相來源是 BattleView 的 bossStruck / hasPendingTrap / bossUltimate，這裡只接 prop）', () => {
  it('待機（prop 都 false）：只有基底 class，沒有 struck／charging／ultimate', async () => {
    const { el, app } = mount({ struck: false, charging: false })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite).not.toBeNull()
    expect([...sprite.classList].sort()).toEqual(['boss-sprite'])

    app.unmount()
    el.remove()
  })

  it('struck=true 加上 .struck；改回 false 會拿掉（不是一去不回的單向 class）', async () => {
    const { el, app, state } = mount({ struck: true, charging: false })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('struck')).toBe(true)
    expect(sprite.classList.contains('charging')).toBe(false)

    state.struck = false
    await nextTick()
    expect(sprite.classList.contains('struck')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('charging=true 加上 .charging；改回 false 會拿掉', async () => {
    const { el, app, state } = mount({ struck: false, charging: true })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('charging')).toBe(true)
    expect(sprite.classList.contains('struck')).toBe(false)

    state.charging = false
    await nextTick()
    expect(sprite.classList.contains('charging')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('ultimate=true 加上 .ultimate；改回 false 會拿掉', async () => {
    const { el, app, state } = mount({ struck: false, charging: false, ultimate: true })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('ultimate')).toBe(true)
    expect(sprite.classList.contains('charging')).toBe(false)
    expect(sprite.classList.contains('struck')).toBe(false)

    state.ultimate = false
    await nextTick()
    expect(sprite.classList.contains('ultimate')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('蓄力中被打（兩個同時 true）：兩個 class 並存，不互相取消', async () => {
    // 這不是邊界情況：陷阱倒數中小孩坐正、打中魔王，是這個遊戲最常見的
    // 一種瞬間。動畫分成 .stance／.hit 兩層就是為了讓這兩個狀態同時成立。
    const { el, app } = mount({ struck: true, charging: true })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('struck')).toBe(true)
    expect(sprite.classList.contains('charging')).toBe(true)

    app.unmount()
    el.remove()
  })

  it('attacking=true 加上 .attacking；改回 false 會拿掉', async () => {
    const { el, app, state } = mount({ struck: false, charging: false, attacking: true })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('attacking')).toBe(true)
    expect(sprite.classList.contains('struck')).toBe(false)

    state.attacking = false
    await nextTick()
    expect(sprite.classList.contains('attacking')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('蓄力中同時出手攻擊（物品判斷跟姿態判斷互不影響，兩者可能同時成立）：兩個 class 並存', async () => {
    const { el, app } = mount({ charging: true, attacking: true })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('charging')).toBe(true)
    expect(sprite.classList.contains('attacking')).toBe(true)

    app.unmount()
    el.remove()
  })

  it('魔王整棵子樹是 aria-hidden="true"（純裝飾，狀態語意由既有文字提示負責，不重複朗讀）', async () => {
    const { el, app } = mount({ struck: false, charging: false })
    await nextTick()

    expect(el.querySelector('.boss-sprite').getAttribute('aria-hidden')).toBe('true')

    app.unmount()
    el.remove()
  })

  it('造型是 inline SVG，而且是真的畫了東西（不是一個空的 <svg>）', async () => {
    const { el, app } = mount({ struck: false, charging: false })
    await nextTick()

    const svg = el.querySelector('.boss-sprite svg')
    expect(svg).not.toBeNull()
    expect(svg.querySelectorAll('circle, ellipse, path').length).toBeGreaterThan(10)

    app.unmount()
    el.remove()
  })
})

describe('BossSprite：全身四肢（手腳都要有，不是只有一顆頭）', () => {
  it('有兩隻手臂（含手掌）與兩條腿（含腳掌），每隻手臂是可獨立變形的 <g>', async () => {
    const { el, app } = mount()
    await nextTick()

    const svg = el.querySelector('.boss-sprite svg')
    expect(svg.querySelectorAll('.arm').length, '要有左右兩隻手臂').toBe(2)
    expect(svg.querySelectorAll('.leg').length, '要有左右兩條腿').toBe(2)
    expect(svg.querySelectorAll('.hand').length, '手臂末端要有手掌').toBe(2)
    expect(svg.querySelectorAll('.foot').length, '腿末端要有腳掌').toBe(2)
    expect(svg.querySelector('.arm-l').tagName.toLowerCase(), '手臂要是 <g>，線段跟手掌才能一起被動畫').toBe('g')
    expect(svg.querySelector('.arm-r').tagName.toLowerCase()).toBe('g')

    app.unmount()
    el.remove()
  })
})

describe('BossSprite：形態（phase，只換臉，不換整體外框）', () => {
  it('phase=1（預設）沒有 .phase2；phase=2 才加上，phase 改回 1 會拿掉', async () => {
    const { el, app, state } = mount({ phase: 1 })
    await nextTick()

    const sprite = el.querySelector('.boss-sprite')
    expect(sprite.classList.contains('phase2')).toBe(false)

    state.phase = 2
    await nextTick()
    expect(sprite.classList.contains('phase2')).toBe(true)

    state.phase = 1
    await nextTick()
    expect(sprite.classList.contains('phase2')).toBe(false)

    app.unmount()
    el.remove()
  })

  it('phase2 不影響 .boss-sprite 外層的固定尺寸規則（不疊加整體 scale，BattleView 的碰撞手算不必重算）', () => {
    // 這條鎖得到的是「原始碼裡沒有人在 .boss-sprite.phase2 這個選擇器本身
    // 加上會改變外框尺寸的規則」，鎖不到真機上到底有沒有跟角落按鈕重疊
    // ——那要靠 BattleView.vue 註解裡的手算與人眼驗收。
    const css = styleOf(bossSpriteSource)
    const re = /\.boss-sprite\.phase2\s*\{([^}]*)\}/
    const m = css.match(re)
    if (m) {
      expect(m[1]).not.toMatch(/transform|width|height|scale/)
    }
  })
})

describe('BossSprite：不得引入任何外部資產（離線展場裝置，CSP connect-src 只允許同源，外部資源是靜默失敗）', () => {
  it('原始碼裡沒有外部 URL、沒有 <img>、沒有 url() 參照，也沒有 v-html', () => {
    // 這條鎖得到「有人把魔王換成一張 CDN 上的圖」這種改法：它在開發機上
    // 看起來好好的，到了展場的離線 iPad 上就是一塊空白，而且不會有錯誤訊息。
    expect(bossSpriteSource).not.toMatch(/https?:\/\//)
    expect(bossSpriteSource).not.toMatch(/<img\b/)
    expect(bossSpriteSource).not.toMatch(/url\(/)
    expect(bossSpriteSource).not.toMatch(/v-html/)
    // 反向佐證：SVG 真的寫在 template 裡（不是這條斷言本身抓錯了對象）
    expect(bossSpriteSource).toMatch(/<svg\b/)
  })
})

// ---------------------------------------------------------------------------
// 效能紅線的原始碼護欄。
//
// 這個 App 在同一個主執行緒上跑 MediaPipe 推論，perfMonitor.js 在推論延遲
// 連續超標 10 秒後會單向降檔（pose 2→1fps、face 3→1.5fps、手機偵測關閉），
// 而且**不可升回**。一個貴的動畫（filter／box-shadow／blur／大面積重繪）
// 會讓這台 iPad 的偵測能力永久變差，現場只會看到「今天這台特別鈍」。
//
// 這條鎖得到：任何人在這兩個檔案的 @keyframes 裡加上 transform／opacity
//             以外的屬性（filter: blur() 是最典型的那一個）。
// 這條鎖不到：transform 本身也可能被寫得很貴（例如把 scale 做在一個
//             超大的 SVG 上、或同時動幾十個圖層），也鎖不到真實裝置上
//             的合成成本——那只能靠 DebugHud 的 rafP95／latencyEma 實測。
// ---------------------------------------------------------------------------

describe('效能紅線：BossSprite 與 BattleView 的動畫只准用 transform 與 opacity', () => {
  const ALLOWED = new Set(['transform', 'opacity'])
  const FILES = [
    // 下界＝目前實際有幾組，掃描器抓不到就代表它壞了（不是「至少有動畫」
    // 這種寬鬆宣告）。BossSprite：idle／charge／attack／attack-arm／hit／
    // hit-flash／ultimate。
    // BattleView：fly-out／fly-back／rise／ult-flash／ult-ring／ult-spike。
    { name: 'BossSprite.vue', source: bossSpriteSource, minKeyframes: 7 },
    { name: 'BattleView.vue', source: battleViewSource, minKeyframes: 6 },
  ]

  it('每一組 @keyframes 宣告的屬性都只在白名單內', () => {
    for (const { name, source, minKeyframes } of FILES) {
      const frames = extractKeyframes(styleOf(source))
      // 先確認掃描器真的抓到東西——不然這條測試是在對空氣斷言（Ruling CH）
      expect(frames.length, `${name} 掃不到 @keyframes，掃描器或檔案結構壞了`)
        .toBeGreaterThanOrEqual(minKeyframes)

      for (const frame of frames) {
        for (const prop of declaredProps(frame.body)) {
          expect(
            ALLOWED.has(prop),
            `${name} 的 @keyframes ${frame.name} 動到了「${prop}」。`
            + '只准 transform／opacity：其他屬性會逼出 layout 或 paint，'
            + '推論延遲超標 10 秒後 perfMonitor 會單向降檔且不可升回。',
          ).toBe(true)
        }
      }
    }
  })

  it('兩個檔案的 transition 都不得指名 filter／box-shadow／尺寸類屬性', () => {
    // transition 跟 keyframes 是同一個成本問題的兩個入口，只鎖一邊等於沒鎖。
    // 白名單式會誤傷既有且已核准的 border-color（.arena__hero.struck 的閃紅
    // 框，那是 reduced-motion 下唯一的被擊回饋），所以這裡用黑名單。
    const BANNED = ['filter', 'box-shadow', 'backdrop-filter', 'width', 'height', 'top', 'left', 'background']
    for (const { name, source } of FILES) {
      const css = styleOf(source)
      for (const m of css.matchAll(/transition:\s*([^;}]*)/g)) {
        for (const banned of BANNED) {
          expect(
            m[1].includes(banned),
            `${name} 的 transition 動到了「${banned}」：${m[1].trim()}`,
          ).toBe(false)
        }
      }
    }
  })
})

describe('BossSprite：prefers-reduced-motion 的分支真的存在，而且真的關掉那七個動畫', () => {
  // base.css 已經有一條全域規則把 animation-duration 壓成 .001ms，所以
  // 「不會動」本來就成立——這個區塊處理的是另一件事：duration 被壓掉之後
  // 動畫會停在 100% 那一格，而 boss-charge 的 100% 正好是 scale(1)，等於
  // 蓄力狀態在 reduced 模式下完全沒有視覺線索。所以這裡要有自己的分支。
  //
  // 這條鎖得到：區塊存在、七個會動的選擇器都被 animation: none 關掉、
  //             而且蓄力有一個靜態替代回饋（不是「完全沒有回饋」）。
  // 這條鎖不到：真實裝置開了「減少動態效果」之後畫面到底好不好懂。
  it('有 @media (prefers-reduced-motion: reduce) 區塊，七個動畫層都被關掉，蓄力仍有靜態回饋', () => {
    const css = styleOf(bossSpriteSource)
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)
    expect(block, 'BossSprite 必須自己處理 prefers-reduced-motion').not.toBeNull()

    const body = block[1]
    expect(body).toMatch(/animation:\s*none/)
    // 七個會動的選擇器都要被涵蓋到
    expect(body).toMatch(/\.stance/)
    expect(body).toMatch(/\.boss-sprite\.charging\s+\.stance/)
    expect(body).toMatch(/\.boss-sprite\.attacking\s+\.stance/)
    expect(body).toMatch(/\.boss-sprite\.charging\.attacking\s+\.stance/)
    expect(body).toMatch(/\.boss-sprite\.ultimate\s+\.stance/)
    expect(body).toMatch(/\.boss-sprite\.struck\s+\.hit\b/)
    expect(body).toMatch(/\.boss-sprite\.attacking\s+\.arm-l/)
    expect(body).toMatch(/\.boss-sprite\.attacking\s+\.arm-r/)
    expect(body).toMatch(/\.boss-sprite\.struck\s+\.hit-flash/)
    // 不得「完全沒有回饋」：蓄力（陷阱即將成立，小孩最需要看懂的那一格）
    // 必須留一個靜態的替代線索。
    expect(
      body,
      'reduced 模式下蓄力狀態必須留一個靜態回饋（既有作法是不得完全沒有回饋）',
    ).toMatch(/\.boss-sprite\.charging\s+\.stance\s*\{[^}]*transform:/)
  })

  it('七個動畫本身真的存在（反向佐證：上面關掉的不是本來就不存在的東西）', () => {
    const css = styleOf(bossSpriteSource)
    const names = extractKeyframes(css).map((f) => f.name).sort()
    expect(names).toEqual([
      'boss-attack', 'boss-attack-arm', 'boss-charge', 'boss-hit',
      'boss-hit-flash', 'boss-idle', 'boss-ultimate',
    ])
    expect(css).toMatch(/\.stance\s*\{[^}]*animation:\s*boss-idle/)
    expect(css).toMatch(/\.boss-sprite\.charging\s+\.stance\s*\{[^}]*animation:\s*boss-charge/)
    expect(css).toMatch(/\.boss-sprite\.attacking\s+\.stance\s*\{[^}]*animation:\s*boss-attack\s/)
    expect(css).toMatch(/\.boss-sprite\.ultimate\s+\.stance\s*\{[^}]*animation:\s*boss-ultimate/)
    expect(css).toMatch(/\.boss-sprite\.struck\s+\.hit\s*\{[^}]*animation:\s*boss-hit\s/)
    expect(css).toMatch(/\.boss-sprite\.attacking\s+\.arm-l,?\s*\n?\s*\.boss-sprite\.attacking\s+\.arm-r\s*\{[^}]*animation:\s*boss-attack-arm/)
    expect(css).toMatch(/\.boss-sprite\.struck\s+\.hit-flash\s*\{[^}]*animation:\s*boss-hit-flash/)
    // 蓄力中同時出手攻擊：身體要維持蓄力那一版動畫，不能被攻擊動畫蓋掉
    // （兩者可能同時成立，見上面「蓄力中同時出手攻擊」那條 class 並存測試）。
    expect(css).toMatch(/\.boss-sprite\.charging\.attacking\s+\.stance\s*\{[^}]*animation:\s*boss-charge/)
  })
})

describe('BossSprite：phase2 的臉部／裝飾變化真的寫在原始碼裡（不是只有 class 切換、CSS 規則其實沒接上）', () => {
  it('角變大（scale，錨點對齊角的接點）、眉毛常駐、腮紅變濃這三條規則都存在', () => {
    const css = styleOf(bossSpriteSource)
    expect(css).toMatch(/\.boss-sprite\.phase2\s+\.horn\s+path:first-child\s*\{[^}]*transform:\s*scale/)
    expect(css).toMatch(/\.boss-sprite\.phase2\s+\.horn\s+path:last-child\s*\{[^}]*transform:\s*scale/)
    expect(css).toMatch(/\.boss-sprite\.phase2\s+\.brows\s*\{[^}]*opacity:\s*1/)
    expect(css).toMatch(/\.boss-sprite\.phase2\s+\.blush\s*\{[^}]*opacity:/)
  })
})
