// 事件註冊留在這裡；實際邏輯都在 src/swLogic.js（純函式，讓 src/sw.test.js
// 能夠 import 並鎖住行為——理由與 build 時如何被內聯成單一檔案，見該檔
// 開頭註解）。
import { SHELL_CACHE, MODEL_CACHE, ASSET_CACHE, SHELL, cacheShellEntry, staleCacheNames, handleNavigation, cacheFirst } from './swLogic.js'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cacheShellEntry(cache, url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(staleCacheNames(names).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 模型與 wasm 走獨立 cache，失敗可重試（不做續傳）
  if (url.pathname.startsWith('/models/') || url.pathname.startsWith('/wasm/')) {
    event.respondWith(cacheFirst(request, MODEL_CACHE))
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
  }
})
