import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

/**
 * src/sw.js 本身只做事件註冊，實際邏輯都在 src/swLogic.js——這裡直接測
 * swLogic.js 的具名 export，鎖住這一輪修正的四條防線：
 *
 *   1. cacheFirst() 的逾時保護：fetch 永不 resolve 時，ASSET_TIMEOUT_MS
 *      後要明確 abort/reject，不能永遠掛著。
 *   2. 命中快取時完全不打網路。
 *   3. staleCacheNames()（activate() 清舊快取的邏輯）：VERSION 換了
 *      不會把 MODEL_CACHE 一起清掉。
 *   4. isOurHtml() / handleNavigation()：captive portal 的假頁面
 *      （200 + text/html，但沒有 data-app-root 標記）不會被寫進快取。
 *
 * vitest 環境是 node，沒有真的 ServiceWorkerGlobalScope，所以用
 * vi.stubGlobal 模擬 self / caches / fetch——跟 inferenceService.test.js、
 * offlineAssets.test.js 同一套慣例。
 */

const {
  cacheFirst, handleNavigation, isOurHtml, staleCacheNames,
  SHELL_CACHE, ASSET_CACHE, MODEL_CACHE, ASSET_TIMEOUT_MS,
} = await import('./swLogic.js')

function makeResponse({ ok = true, status = 200, type = 'basic', contentType = 'text/plain', body = '' } = {}) {
  return {
    ok, status, type,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    clone() { return makeResponse({ ok, status, type, contentType, body }) },
    async text() { return body },
  }
}

function makeCache(initial = new Map()) {
  return {
    put: vi.fn(async (req, res) => {
      const key = typeof req === 'string' ? req : req.url
      initial.set(key, res)
    }),
    match: vi.fn(async (req) => {
      const key = typeof req === 'string' ? req : req.url
      return initial.get(key)
    }),
  }
}

function makeCachesStub(cache) {
  return { open: vi.fn().mockResolvedValue(cache), match: cache.match, keys: vi.fn(), delete: vi.fn() }
}

beforeEach(() => {
  vi.stubGlobal('self', { location: { origin: 'https://focus-quest.example' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('cacheFirst 逾時保護', () => {
  it('fetch 永不 resolve 時，ASSET_TIMEOUT_MS 後 abort 並明確 reject（不是永遠掛著）', async () => {
    vi.useFakeTimers()
    const cache = makeCache()
    vi.stubGlobal('caches', makeCachesStub(cache))
    const fetchMock = vi.fn((_req, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const request = { url: 'https://focus-quest.example/models/pose_landmarker_lite.task' }
    const promise = cacheFirst(request, MODEL_CACHE)
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(ASSET_TIMEOUT_MS)
    await assertion
  })

  it('提前 resolve 時不會被逾時誤傷（逾時前正常回傳）', async () => {
    vi.useFakeTimers()
    const cache = makeCache()
    vi.stubGlobal('caches', makeCachesStub(cache))
    const okRes = makeResponse({ ok: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okRes))

    const request = { url: 'https://focus-quest.example/models/pose_landmarker_lite.task' }
    const result = await cacheFirst(request, MODEL_CACHE)
    expect(result).toBe(okRes)
  })
})

describe('cacheFirst 命中快取', () => {
  it('MODEL_CACHE 裡已有該 URL 時，fetch 一次都不該被呼叫', async () => {
    const url = 'https://focus-quest.example/models/pose_landmarker_lite.task'
    const cachedResponse = makeResponse({ ok: true })
    const cache = makeCache(new Map([[url, cachedResponse]]))
    vi.stubGlobal('caches', makeCachesStub(cache))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await cacheFirst({ url }, MODEL_CACHE)
    expect(result).toBe(cachedResponse)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('cache.put 寫入失敗是最佳努力，不該讓已下載成功的回應變成失敗', () => {
  it('cacheFirst: cache.put reject 時依然回傳下載成功的 response', async () => {
    const okRes = makeResponse({ ok: true })
    const cache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn().mockRejectedValue(new Error('QuotaExceededError')) }
    vi.stubGlobal('caches', makeCachesStub(cache))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okRes))

    const result = await cacheFirst({ url: 'https://focus-quest.example/models/x.task' }, MODEL_CACHE)
    expect(result).toBe(okRes)
  })

  it('handleNavigation: cache.put reject 時依然回傳下載成功的 response', async () => {
    const ourHtml = makeResponse({ ok: true, contentType: 'text/html', body: '<div id="app" data-app-root="focus-quest"></div>' })
    const cache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn().mockRejectedValue(new Error('QuotaExceededError')) }
    vi.stubGlobal('caches', makeCachesStub(cache))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ourHtml))

    const result = await handleNavigation({ url: 'https://focus-quest.example/' })
    expect(result).toBe(ourHtml)
  })
})

describe('staleCacheNames（activate 清舊快取邏輯）', () => {
  it('MODEL_CACHE 是固定字串，不是隨 VERSION 算出來的', () => {
    // 刻意寫死字面值，不是拿 import 進來的 MODEL_CACHE 自己比對自己——
    // 那樣不管它有沒有退回 `fq-model-${VERSION}` 都會自我一致地通過，
    // 測不出「VERSION 一改，模型快取名稱就跟著變」這個真正的回歸。
    expect(MODEL_CACHE).toBe('fq-model-assets')
  })

  it('VERSION 換了不會把模型快取一起清掉，只清舊版 shell/asset', () => {
    // 模擬「上一版已經暖機過、這一版剛 activate」的情境：
    // 舊版 shell/asset（含版本號）該被清；模型快取用固定字串，
    // 不管 VERSION 換成什麼都要留著。
    const names = ['fq-shell-v0', 'fq-asset-v0', 'fq-model-assets', SHELL_CACHE, ASSET_CACHE]
    const stale = staleCacheNames(names)
    expect(stale).toEqual(expect.arrayContaining(['fq-shell-v0', 'fq-asset-v0']))
    expect(stale).not.toContain('fq-model-assets')
    expect(stale).not.toContain(SHELL_CACHE)
    expect(stale).not.toContain(ASSET_CACHE)
  })
})

describe('captive portal 不汙染快取', () => {
  it('isOurHtml: 200 + text/html 但沒有 data-app-root 標記時回 false', async () => {
    const res = makeResponse({ ok: true, contentType: 'text/html', body: '<html><body>請登入本館 Wi-Fi</body></html>' })
    await expect(isOurHtml(res)).resolves.toBe(false)
  })

  it('isOurHtml: 200 + text/html 且含 data-app-root 標記時回 true', async () => {
    const res = makeResponse({ ok: true, contentType: 'text/html', body: '<div id="app" data-app-root="focus-quest"></div>' })
    await expect(isOurHtml(res)).resolves.toBe(true)
  })

  it('handleNavigation: captive portal 假頁面不會被寫進 SHELL_CACHE', async () => {
    const cache = makeCache()
    vi.stubGlobal('caches', makeCachesStub(cache))
    const captivePortalHtml = makeResponse({ ok: true, contentType: 'text/html', body: '<html>請登入本館 Wi-Fi</html>' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(captivePortalHtml))

    await handleNavigation({ url: 'https://focus-quest.example/' })
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('handleNavigation: 我們自己的頁面會被寫進 SHELL_CACHE', async () => {
    const cache = makeCache()
    vi.stubGlobal('caches', makeCachesStub(cache))
    const ourHtml = makeResponse({ ok: true, contentType: 'text/html', body: '<div id="app" data-app-root="focus-quest"></div>' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ourHtml))

    await handleNavigation({ url: 'https://focus-quest.example/' })
    expect(cache.put).toHaveBeenCalledTimes(1)
  })
})
