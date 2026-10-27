import { describe, it, expect, vi } from 'vitest'
import { playGong, PHONE_ALERT_REPEAT_MS, PHONE_ALERT_TEXT } from './phoneAlert.js'
import { firstBannedWord } from './copyGuardrail.js'

describe('phoneAlert', () => {
  it('重複間隔要比一次鑼聲加語音（約 3 秒）長，才不會疊在一起', () => {
    expect(PHONE_ALERT_REPEAT_MS).toBeGreaterThanOrEqual(5000)
  })
  it('playGong 對 null 安全，有 AudioContext 時建立泛音振盪器', () => {
    expect(playGong(null)).toBe(false)
    const osc = () => ({ type: '', frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() })
    const gain = () => ({ gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() })
    const ctx = { state: 'running', currentTime: 0, destination: {}, createOscillator: vi.fn(osc), createGain: vi.fn(gain) }
    expect(playGong(ctx)).toBe(true)
    expect(ctx.createOscillator).toHaveBeenCalledTimes(5)
  })
  it('台詞不含禁用詞且 ≤15 字', () => {
    expect(firstBannedWord(PHONE_ALERT_TEXT)).toBeNull()
    expect(PHONE_ALERT_TEXT.length).toBeLessThanOrEqual(15)
  })
})

describe('playRoar', () => {
  it('returns false without a context and true with a working one', async () => {
    const { playRoar } = await import('./phoneAlert.js')
    expect(playRoar(null)).toBe(false)
    const node = () => ({ connect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, detune: {}, getChannelData: () => new Float32Array(4) })
    const ctx = {
      currentTime: 0, sampleRate: 4, state: 'running',
      createGain: node, createOscillator: node, createBiquadFilter: node,
      createBuffer: () => node(), createBufferSource: node, destination: {},
    }
    expect(playRoar(ctx)).toBe(true)
  })
})
