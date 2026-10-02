/**
 * iPadOS 會在頁面隱藏時自動釋放 Wake Lock，且不會自己還回來。
 * 回前景時一定要重新 request()，否則第二段專注時間螢幕會自己暗掉。
 * Wake Lock 只是第一層，spec 另外要求引導使用者把「自動鎖定」設為永不。
 */
export function createWakeLock() {
  let sentinel = null

  return {
    async request() {
      if (!('wakeLock' in navigator)) return false
      if (sentinel) return true
      try {
        sentinel = await navigator.wakeLock.request('screen')
        sentinel.addEventListener('release', () => { sentinel = null })
        return true
      } catch {
        sentinel = null
        return false
      }
    },

    release() {
      sentinel?.release?.()
      sentinel = null
    },

    isActive() {
      return sentinel !== null
    },
  }
}
