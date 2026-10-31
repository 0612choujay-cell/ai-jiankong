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
    expect(cb).toHaveBeenCalledWith(null)
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
    expect(cb).toHaveBeenCalledWith('yes')
    vi.unstubAllGlobals()
  })
  it('times out with null', () => {
    vi.useFakeTimers()
    class Fake { start() {} abort() {} }
    vi.stubGlobal('window', { webkitSpeechRecognition: Fake })
    const cb = vi.fn()
    listenForYesNo(cb, { timeoutMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(cb).toHaveBeenCalledWith(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
