import { describe, it, expect, vi } from 'vitest'
import { classifyAnswer, listenForYesNo, listenContinuously } from './voiceCommand.js'

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

describe('listenContinuously', () => {
  it('reports every final yes/no answer, ignores interim and unrelated speech, restarts on end, stops on stop()', () => {
    vi.useFakeTimers()
    const made = []
    class Fake { constructor() { made.push(this) } start() {} abort() {} }
    vi.stubGlobal('window', { SpeechRecognition: Fake })
    const cb = vi.fn()
    const h = listenContinuously(cb)
    const fin = (t) => { const r = [{ transcript: t }]; r.isFinal = true; return { resultIndex: 0, results: [r] } }
    made[0].onresult(fin('今天天氣'))
    expect(cb).not.toHaveBeenCalled()
    made[0].onresult(fin('好'))
    made[0].onresult(fin('不要'))
    expect(cb.mock.calls.map((c) => c[0])).toEqual(['yes', 'no'])
    made[0].onend()
    vi.advanceTimersByTime(400)
    expect(made).toHaveLength(2)
    h.stop()
    made[1].onend()
    vi.advanceTimersByTime(1000)
    expect(made).toHaveLength(2)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('gives up with an error on a fatal error or when unsupported', () => {
    class Fake { constructor() { this.s = this } start() {} abort() {} }
    let rec
    vi.stubGlobal('window', { SpeechRecognition: class extends Fake { constructor() { super(); rec = this } } })
    const onError = vi.fn()
    listenContinuously(vi.fn(), { onError })
    rec.onerror({ error: 'not-allowed' })
    expect(onError).toHaveBeenCalledWith('not-allowed')
    vi.stubGlobal('window', {})
    const e2 = vi.fn()
    expect(listenContinuously(vi.fn(), { onError: e2 }).supported).toBe(false)
    expect(e2).toHaveBeenCalledWith('unsupported')
    vi.unstubAllGlobals()
  })
})
