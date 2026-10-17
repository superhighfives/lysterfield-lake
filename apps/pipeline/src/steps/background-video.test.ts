import { describe, expect, test } from 'bun:test'
import { planChunks } from './background-video.ts'

/** Every frame covered, no chunk over 5s or across a cut, neighbours overlapping by at least 1s. */
function checkPlan(frameCount: number, fps: number, cuts: number[]) {
  const chunks = planChunks(frameCount, fps, cuts)
  for (let f = 1; f <= frameCount; f++) expect(chunks.some((c) => c.start <= f && f <= c.end)).toBe(true)
  for (const c of chunks) {
    expect(c.end - c.start + 1).toBeLessThanOrEqual(5 * fps)
    expect(c.start).toBeGreaterThanOrEqual(c.segment[0])
    expect(c.end).toBeLessThanOrEqual(c.segment[1])
    expect(cuts.some((cut) => c.start < cut && cut <= c.end)).toBe(false)
  }
  chunks.slice(1).forEach((c, i) => {
    if (c.segment[0] === chunks[i].segment[0]) expect(chunks[i].end - c.start + 1).toBeGreaterThanOrEqual(fps)
  })
  return chunks
}

describe('planChunks', () => {
  test('a clip of 5s or less is one chunk', () => {
    expect(planChunks(120, 24, [])).toEqual([{ id: 'c000', start: 1, end: 120, segment: [1, 120] }])
    expect(planChunks(100, 24, [])).toEqual([{ id: 'c000', start: 1, end: 100, segment: [1, 100] }])
  })

  test("full-video: the spike's 55 chunks, split at the cut", () => {
    const chunks = checkPlan(5156, 24, [3770])
    expect(chunks).toHaveLength(55)
    expect(chunks.slice(0, 3).map(({ start, end }) => [start, end])).toEqual([[1, 120], [95, 214], [188, 307]])
    const atCut = chunks.findIndex((c) => c.start === 3770)
    expect(chunks[atCut - 1].end).toBe(3769)
    expect(chunks.at(-1)!.end).toBe(5156)
  })

  test('a shot shorter than 5s after a cut is its own chunk', () => {
    const chunks = checkPlan(300, 24, [250])
    expect(chunks.at(-1)).toEqual({ id: `c${String(chunks.length - 1).padStart(3, '0')}`, start: 250, end: 300, segment: [250, 300] })
  })

  test('other frame rates and lengths', () => {
    checkPlan(900, 60, [])
    checkPlan(221, 24, [])
    checkPlan(1000, 30, [400, 401, 700])
  })
})
