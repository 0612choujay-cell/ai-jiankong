// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWakeLock } from './wakeLock.js'

function stubSentinel() {
  const listeners = new Map()
  return {
    released: false,
    addEventListener(type, fn) { listeners.set(type, fn) },
    release() {
      this.released = true
      listeners.get('release')?.()
    },
  }
}

describe('createWakeLock', () => {
  afterEach(() => {
    delete navigator.wakeLock
  })

  it('navigator 沒有 wakeLock 時 request() 回傳 false，不丟例外', async () => {
    const wl = createWakeLock()
    expect(await wl.request()).toBe(false)
    expect(wl.isActive()).toBe(false)
  })

  it('request() 成功後 isActive() 為 true，release() 後為 false', async () => {
    const sentinel = stubSentinel()
    navigator.wakeLock = { request: vi.fn(async () => sentinel) }

    const wl = createWakeLock()
    expect(await wl.request()).toBe(true)
    expect(wl.isActive()).toBe(true)

    wl.release()
    expect(sentinel.released).toBe(true)
    expect(wl.isActive()).toBe(false)
  })

  it('重複 request() 不會重新取得（已持有時直接回傳 true）', async () => {
    const requestFn = vi.fn(async () => stubSentinel())
    navigator.wakeLock = { request: requestFn }

    const wl = createWakeLock()
    await wl.request()
    await wl.request()
    expect(requestFn).toHaveBeenCalledTimes(1)
  })

  it('系統自動釋放（觸發 release 事件）後 isActive() 變回 false，下次 request() 會重新取得', async () => {
    let sentinel = stubSentinel()
    const requestFn = vi.fn(async () => sentinel)
    navigator.wakeLock = { request: requestFn }

    const wl = createWakeLock()
    await wl.request()
    expect(wl.isActive()).toBe(true)

    // iPadOS 隱藏頁面時系統自己觸發 release 事件，不是呼叫端呼叫 release()
    sentinel.release()
    expect(wl.isActive()).toBe(false)

    sentinel = stubSentinel()
    await wl.request()
    expect(requestFn).toHaveBeenCalledTimes(2)
  })

  it('request() 失敗（例如被使用者拒絕）時回傳 false，不丟例外', async () => {
    navigator.wakeLock = { request: vi.fn(async () => { throw new Error('denied') }) }

    const wl = createWakeLock()
    expect(await wl.request()).toBe(false)
    expect(wl.isActive()).toBe(false)
  })
})
