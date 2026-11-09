import { describe, expect, test } from 'vitest'
import { polaroidAt } from './grid.ts'

describe('polaroidAt', () => {
  test('lays every polaroid out once in each repeat of the block', () => {
    const count = 7
    const seen = new Set<number>()
    // 7 polaroids make a 3 × 3 block; its last two places repeat the first two.
    for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) seen.add(polaroidAt(cx, cy, count))
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test('wraps the same way in every direction, negative positions included', () => {
    for (const [cx, cy] of [[0, 0], [2, 1], [-1, -4], [5, -2]]) {
      expect(polaroidAt(cx + 3, cy, 9)).toBe(polaroidAt(cx, cy, 9))
      expect(polaroidAt(cx, cy - 3, 9)).toBe(polaroidAt(cx, cy, 9))
      expect(polaroidAt(cx, cy, 9)).toBeGreaterThanOrEqual(0)
    }
  })

  test('one polaroid fills the whole grid', () => {
    expect(polaroidAt(-3, 8, 1)).toBe(0)
  })
})
