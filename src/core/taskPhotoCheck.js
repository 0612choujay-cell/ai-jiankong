/**
 * 結算頁作業照片 → /api/check（Cloudflare Pages Function）→ Claude 判斷有沒有寫完。
 * 這是整個 App 唯一會把影像送出這台 iPad 的地方（使用者明確要求），
 * 只送使用者自己按「拍照」選的那一張、縮小後的 JPEG；不存、不重送。
 */
const MAX_SIDE = 1280

export function shrinkToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = document.createElement('img')
    img.onload = () => {
      try {
        const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
        const c = document.createElement('canvas')
        c.width = Math.round(img.naturalWidth * k)
        c.height = Math.round(img.naturalHeight * k)
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/jpeg', 0.7))
      } catch (e) { reject(e) } finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')) }
    img.src = url
  })
}

/** @returns {Promise<{finished:boolean, reason:string}>}；失敗時 throw */
export async function checkTaskPhoto(file, task) {
  const image = await shrinkToJpeg(file)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const res = await fetch('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, task }),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(String(res.status))
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}
