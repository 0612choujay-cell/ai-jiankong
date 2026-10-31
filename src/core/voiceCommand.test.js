import { describe, it, expect, vi } from 'vitest'
import { classifyAnswer, listenForYesNo } from './voiceCommand.js'

describe('classifyAnswer', () => {
  it('maps yes-like and no-like answers', () => {
    for (const t of ['好', '好啊', 'ok', 'OK', 'Okay', '可以', '好我休息', '休息', 'rest', 'Rest', 'take a rest', 'break']) expect(classifyAnswer(t), t).toBe('yes')
    for (const t of ['不要', '不用了', 'no', 'No', '我不要', '不好', '不休息', 'no rest', "don't rest"]) expect(classifyAnswer(t), t).toBe('no')
  })
  it('returns null for empty or unrelated speech', () => {
    expect(classifyAnswer('')).toBeNull()
    expect(classifyAnswer(null)).toBeNull()
    expect(classifyAnswer('今天天氣')).toBeNull()
  })
})

describe('listenForYesNo', () => {
  it('reports unsupported browsers as null, once', () => {
    vi.stubGlobal('window', {})
    const cb = vi.fn()
    listenForYesNo(cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(null, 'unsupported')
    vi.unstubAllGlobals()
  })
  it('ignores interim (non-final) results', () => {
    let rec
    class Fake { constructor() { rec = this } start() {} abort() {} }
    vi.stubGlobal('window', { SpeechRecognition: Fake })
    const cb = vi.fn()
    listenForYesNo(cb)
    const r = [{ transcript: '不' }]
    r.isFinal = false
    rec.onresult({ resultIndex: 0, results: [r] })
    expect(cb).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('reports the first recognised answer once and ignores later events', () => {
    let rec
    class Fake {
      constructor() { rec = this }
      start() {}
      abort() {}
    }
    vi.stubGlobal('window', { SpeechRecognition: Fake })
    const cb = vi.fn()
    listenForYesNo(cb)
    rec.onresult({ resultIndex: 0, results: [[{ transcript: '好' }]] })
    rec.onend()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('yes', null)
    vi.unstubAllGlobals()
  })
  it('passes the error code through (e.g. mic denied)', () => {
    let rec
    class Fake { constructor() { rec = this } start() {} abort() {} }
    vi.stubGlobal('window', { SpeechRecognition: Fake })
    const cb = vi.fn()
    listenForYesNo(cb)
    rec.onerror({ error: 'not-allowed' })
    expect(cb).toHaveBeenCalledWith(null, 'not-allowed')
    vi.unstubAllGlobals()
  })
  it('restarts when the browser ends early with no result, until the deadline', () => {
    vi.useFakeTimers()
    const made = []
    class Fake { constructor() { made.push(this) } start() {} abort() {} }
    vi.stubGlobal('window', { SpeechRecognition: Fake })
    const cb = vi.fn()
    listenForYesNo(cb, { timeoutMs: 5000 })
    made[0].onend() // iOS 很快就自己結束
    vi.advanceTimersByTime(200)
    expect(made).toHaveLength(2)
    expect(cb).not.toHaveBeenCalled()
    made[1].onresult({ resultIndex: 0, results: [[{ transcript: 'ok' }]] })
    expect(cb).toHaveBeenCalledWith('yes', null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('times out with null', () => {
    vi.useFakeTimers()
    class Fake { start() {} abort() {} }
    vi.stubGlobal('window', { webkitSpeechRecognition: Fake })
    const cb = vi.fn()
    listenForYesNo(cb, { timeoutMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(cb).toHaveBeenCalledWith(null, 'timeout')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
