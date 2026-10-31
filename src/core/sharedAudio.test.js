import { describe, it, expect, vi } from 'vitest'

describe('sharedAudio', () => {
  it('creates one shared context, resumes it inside the gesture,', async () => {
    const made = []
    class FakeCtx {
      constructor() { this.state = 'suspended'; this.destination = {}; made.push(this) }
      resume = vi.fn()
      createBuffer = vi.fn((ch, n) => ({ length: n, copyToChannel: vi.fn() }))
      createBufferSource = vi.fn(() => ({ connect: vi.fn(), start: vi.fn() }))
      decodeAudioData = vi.fn((d, ok) => ok({ fake: true }))
    }
    vi.stubGlobal('window', { AudioContext: FakeCtx, atob: globalThis.atob })
    const m = await import('./sharedAudio.js')
    expect(m.unlockAudioFromGesture()).toBe(true)
    expect(m.getSharedCtx()).toBe(made[0])
    expect(made).toHaveLength(1)
    expect(made[0].resume).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
