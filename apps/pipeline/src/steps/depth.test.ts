import { describe, expect, test } from 'bun:test'
import { parseFrameRanges } from './depth.ts'

describe('parseFrameRanges', () => {
  test('reads single frames and ranges', () => {
    expect(parseFrameRanges('736-738,2900')).toEqual([736, 737, 738, 2900])
    expect(parseFrameRanges('5')).toEqual([5])
  })

  test('rejects empty parts, frame 0, and backwards or open ranges', () => {
    for (const bad of ['', '1,', '-5', '0-3', '0', '9-3', '3-', 'a', '1.5']) expect(() => parseFrameRanges(bad)).toThrow()
  })
})
