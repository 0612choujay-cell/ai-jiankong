import { describe, it, expect, vi } from 'vitest'

vi.mock('onnxruntime-web/wasm', () => ({ env: { wasm: {} }, InferenceSession: {}, Tensor: class {} }))

const { decodeYolo } = await import('./yoloDetector.js')

const N = 4
function tensor(anchors) {
  const d = new Float32Array(84 * N)
  anchors.forEach((a, i) => {
    d[i] = a.cx; d[N + i] = a.cy; d[2 * N + i] = a.w; d[3 * N + i] = a.h
    d[(4 + a.id) * N + i] = a.score
  })
  return d
}
const T = { scale: 1, padX: 0, padY: 80, srcW: 640, srcH: 480 }

describe('decodeYolo', () => {
  it('maps a cell phone box back to source pixels', () => {
    const out = decodeYolo(tensor([{ cx: 320, cy: 320, w: 100, h: 200, id: 67, score: 0.8 }]), N, T)
    expect(out).toHaveLength(1)
    expect(out[0].categories[0]).toEqual({ categoryName: 'cell phone', score: expect.closeTo(0.8, 5) })
    expect(out[0].boundingBox).toEqual({ originX: 270, originY: 140, width: 100, height: 200 })
  })
  it('ignores classes we do not use and low scores', () => {
    const out = decodeYolo(tensor([
      { cx: 100, cy: 200, w: 50, h: 50, id: 0, score: 0.9 }, // person
      { cx: 300, cy: 300, w: 50, h: 50, id: 67, score: 0.1 },
    ]), N, T)
    expect(out).toEqual([])
  })
  it('suppresses overlapping duplicates of the same class', () => {
    const out = decodeYolo(tensor([
      { cx: 300, cy: 300, w: 100, h: 100, id: 67, score: 0.9 },
      { cx: 305, cy: 302, w: 100, h: 100, id: 67, score: 0.6 },
    ]), N, T)
    expect(out).toHaveLength(1)
  })
})
