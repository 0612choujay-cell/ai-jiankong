import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 「鏡像預覽的 <video> 必須真的會播放」的家族護欄。
 *
 * ── 為什麼有這個檔案 ──────────────────────────────────────────
 *
 * 這個 App 只有一個真正持有鏡頭串流的 <video>（App.vue 的 .hidden-cam，
 * 由 cameraCapture.js 綁定並 play()）。需要讓使用者看到自己的畫面時，
 * 元件會把**同一個 MediaStream** 再掛一份到自己本地的 <video> 上做鏡像。
 *
 * 陷阱是：**指派 srcObject 不會讓 <video> 開始播放。**
 * 少了 autoplay 屬性、又沒有人呼叫 play()，那個節點在 iOS Safari 上會一直
 * 停在 paused，畫面整片空白——而且不會有任何錯誤訊息。
 *
 * 這件事真的發生過。BattleView.vue（Task 14）兩者都有；
 * CalibrationWizard.vue（Task 9，更早寫的）兩者都沒有。
 * 兩個元件做同一件事，一個對一個錯，而**732 條測試全綠**——
 * 因為 jsdom 根本不渲染 video，播不播放在測試環境裡沒有任何可觀測差異。
 * 它是在整個專案第一次上真機時，由使用者看到「校準畫面左邊沒畫面」才發現的，
 * 而那個畫面正在要求小孩「照著畫面坐好」。
 *
 * ── 這條護欄鎖得到什麼、鎖不到什麼（誠實聲明）──────────────────
 *
 * 鎖得到：任何新增或既有的鏡像預覽元件，如果忘了 autoplay 或忘了 play()，
 *         會在這裡當場紅。這是**原始碼層**的結構性檢查。
 * 鎖不到：畫面上到底有沒有影像。jsdom 不渲染 video，沒有任何自動化測試
 *         能回答這個問題——它永遠只能靠實機驗收。
 *         所以這條護欄擋的是「同一個錯誤再犯一次」，不是「這次真的會顯示」。
 */

const COMPONENT_DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function vueFiles() {
  return readdirSync(COMPONENT_DIR)
    .filter((f) => f.endsWith('.vue'))
    .map((f) => ({ name: f, source: readFileSync(join(COMPONENT_DIR, f), 'utf8') }))
}

/**
 * 「鏡像預覽元件」的判準：它有一個 <video>，而且它從 props 的 videoEl 讀
 * srcObject 掛到自己的節點上。刻意用行為特徵判定，不是維護一份檔名清單——
 * 清單會漏掉下一個新增的元件，而那正是這條護欄存在的理由。
 */
function isMirrorComponent(source) {
  return /<video[^>]*ref="localVideo"/.test(source)
    && /props\.videoEl\?\.srcObject/.test(source)
}

describe('鏡像預覽的 <video> 必須真的會播放（實機驗收抓到的家族缺陷）', () => {
  it('至少找得到一個鏡像預覽元件——否則這條護欄是在對空氣斷言', () => {
    const mirrors = vueFiles().filter((f) => isMirrorComponent(f.source))
    expect(
      mirrors.map((m) => m.name).sort(),
      '判準抓不到任何元件，代表判準本身壞了（例如 ref 名稱被改過）',
    ).toEqual(['BattleView.vue', 'CalibrationWizard.vue'])
  })

  it('每一個鏡像預覽的 <video> 都有 autoplay 屬性', () => {
    for (const { name, source } of vueFiles().filter((f) => isMirrorComponent(f.source))) {
      const tag = source.match(/<video[^>]*ref="localVideo"[^>]*>/)?.[0] ?? ''
      expect(
        tag,
        `${name} 的鏡像 <video> 少了 autoplay：指派 srcObject 不會讓它開始播放，`
        + 'iOS Safari 上會是一片空白，而且沒有任何錯誤訊息',
      ).toMatch(/\bautoplay\b/)
    }
  })

  it('每一個鏡像預覽元件在指派 srcObject 之後都會呼叫 play()', () => {
    for (const { name, source } of vueFiles().filter((f) => isMirrorComponent(f.source))) {
      // autoplay 屬性在使用者尚未與頁面互動過的情況下可能被瀏覽器策略擋下，
      // 所以兩者都要有——這也是 BattleView 既有的作法。
      expect(
        source,
        `${name} 沒有呼叫 localVideo.play()：只靠 autoplay 屬性不夠，`
        + '瀏覽器的自動播放策略可能擋下它',
      ).toMatch(/localVideo\.value\.play\?\.\(\)/)
      // play() 回傳的 Promise 被中斷（例如立刻換畫面）是正常的，不得讓它變成
      // unhandled rejection——正式 bundle 拔掉 console 之後那會完全無聲。
      expect(
        source,
        `${name} 的 play() 沒有 catch：被中斷的 play() 會變成 unhandled rejection`,
      ).toMatch(/Promise\.resolve\(localVideo\.value\.play\?\.\(\)\)\.catch\(/)
    }
  })
})
