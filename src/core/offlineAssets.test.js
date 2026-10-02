import { vi, describe, it, expect, beforeEach } from 'vitest'

/**
 * 鎖住 offlineAssets.js 對外的關鍵契約：
 *
 *   1. 不維護第二份 wasm 檔名清單——路徑一律問
 *      FilesetResolver.forVisionTasks('/wasm')，且絕不呼叫
 *      createFromOptions()（不建 GL context）。
 *   2. 任何一項下載失敗（fetch reject 或 response.ok 為 false）就整個
 *      回報失敗、不寫入就緒旗標，且不繼續跑後面的項目。
 *   3. 全部成功才寫入就緒旗標，isOfflineReady() 才會回 true。
 *   4. localStorage 不可用時（私密瀏覽等）不炸掉呼叫端。
 */

const filesetMock = vi.hoisted(() => ({
  forVisionTasks: vi.fn(),
}))

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: filesetMock,
}))

const { ensureOfflineAssets, isOfflineReady } = await import('./offlineAssets.js')

function okResponse() {
  return { ok: true, status: 200 }
}

function failResponse(status = 500) {
  return { ok: false, status }
}

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  }
}

beforeEach(() => {
  filesetMock.forVisionTasks.mockReset()
  filesetMock.forVisionTasks.mockResolvedValue({
    wasmLoaderPath: '/wasm/vision_wasm_internal.js',
    wasmBinaryPath: '/wasm/vision_wasm_internal.wasm',
  })
  vi.stubGlobal('localStorage', makeLocalStorage())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()))
})

describe('isOfflineReady', () => {
  it('回 false，直到 ensureOfflineAssets 成功跑完一輪', async () => {
    expect(isOfflineReady()).toBe(false)
    const result = await ensureOfflineAssets()
    expect(result.ok).toBe(true)
    expect(isOfflineReady()).toBe(true)
  })

  it('localStorage 丟例外時不炸掉，當成尚未就緒', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    })
    expect(() => isOfflineReady()).not.toThrow()
    expect(isOfflineReady()).toBe(false)
  })
})

describe('ensureOfflineAssets', () => {
  it('依序抓 wasm 兩個檔 + 三個模型，全程不呼叫 createFromOptions', async () => {
    await ensureOfflineAssets()
    expect(filesetMock.forVisionTasks).toHaveBeenCalledWith('/wasm')
    const fetchedUrls = fetch.mock.calls.map((c) => c[0])
    expect(fetchedUrls).toEqual(expect.arrayContaining([
      '/wasm/vision_wasm_internal.js',
      '/wasm/vision_wasm_internal.wasm',
      '/models/pose_landmarker_lite.task',
      '/models/face_landmarker.task',
      '/models/efficientdet_lite0.tflite',
    ]))
  })

  it('回報進度：done 遞增到 total，最後一筆 label 是 object 模型', async () => {
    const events = []
    await ensureOfflineAssets({ onProgress: (p) => events.push(p) })
    expect(events[0]).toEqual({ done: 0, total: 4, label: null })
    expect(events.at(-1)).toEqual({ done: 4, total: 4, label: '物件偵測模型' })
    expect(events.map((e) => e.done)).toEqual([0, 1, 2, 3, 4])
  })

  it('任何一項 response.ok 為 false 就整個失敗，不寫入就緒旗標', async () => {
    fetch.mockResolvedValueOnce(okResponse()) // wasm loader js
    fetch.mockResolvedValueOnce(okResponse()) // wasm binary
    fetch.mockResolvedValueOnce(failResponse(404)) // pose 模型失敗

    const result = await ensureOfflineAssets()
    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
    expect(isOfflineReady()).toBe(false)
  })

  it('fetch 直接 reject（例如逾時被 sw.js 的 AbortController 中止）也算失敗', async () => {
    fetch.mockRejectedValueOnce(new Error('aborted'))
    const result = await ensureOfflineAssets()
    expect(result.ok).toBe(false)
    expect(isOfflineReady()).toBe(false)
  })

  it('失敗的項目之後不會繼續跑後面的項目', async () => {
    filesetMock.forVisionTasks.mockRejectedValueOnce(new Error('wasm path resolve failed'))
    await ensureOfflineAssets()
    // wasm 是第一項就失敗，後面三個模型完全不該被 fetch
    expect(fetch).not.toHaveBeenCalled()
  })

  it('可重覆呼叫；已經成功一次之後再呼叫一次照樣成功（重試用途）', async () => {
    const first = await ensureOfflineAssets()
    const second = await ensureOfflineAssets()
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })
})
