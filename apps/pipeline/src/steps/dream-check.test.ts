import { describe, expect, test } from 'bun:test'
import { flaggedStretches, isFlagged, scoredFrames } from './dream-check.ts'

const thresholds = { threshold: 0.18, faceThreshold: 0.5 }

describe('isFlagged', () => {
  test('flags a frame over either threshold', () => {
    expect(isFlagged({ score: 0.2, face: 0 }, thresholds)).toBe(true)
    expect(isFlagged({ score: 0.1, face: 0.9 }, thresholds)).toBe(true)
    expect(isFlagged({ score: 0.1, face: 0.4 }, thresholds)).toBe(false)
  })

  test('reads a check from before the face check by its person score alone', () => {
    expect(isFlagged({ score: 0.1 }, { threshold: 0.35 })).toBe(false)
    expect(isFlagged({ score: 0.4 }, { threshold: 0.35 })).toBe(true)
  })
})

describe('flaggedStretches', () => {
  test('joins neighbouring frames flagged by either score, keeping both peaks', () => {
    const scored = [
      { frame: 1, score: 0.01, face: 0 },
      { frame: 3, score: 0.3, face: 0.1 },
      { frame: 5, score: 0.05, face: 0.8 },
      { frame: 7, score: 0.01, face: 0.2 },
      { frame: 9, score: 0.01, face: 0.6 },
    ]
    expect(flaggedStretches(scored, thresholds)).toEqual([
      { start: 3, end: 5, frames: 2, peak: 0.3, facePeak: 0.8 },
      { start: 9, end: 9, frames: 1, peak: 0.01, facePeak: 0.6 },
    ])
  })
})

describe('scoredFrames', () => {
  test('pairs each frame with its face score, in frame order', () => {
    expect(scoredFrames({ scores: { '0003': 0.2, '0001': 0.1 }, faces: { '0001': 0.7 } })).toEqual([
      { frame: 1, score: 0.1, face: 0.7 },
      { frame: 3, score: 0.2, face: undefined },
    ])
  })
})
