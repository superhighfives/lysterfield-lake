import animation from './animation'
import { describe, it, expect } from 'vitest'

describe('animation', () => {
  it('should work for a single frame', () => {
    const scene = animation([
      {
        timestamp: 1,
        x: 5,
      },
    ])
    expect(scene(-1000)).toEqual({ x: 5 })
    expect(scene(-0.1)).toEqual({ x: 5 })
    expect(scene(0.5)).toEqual({ x: 5 })
    expect(scene(1.0)).toEqual({ x: 5 })
    expect(scene(1.1)).toEqual({ x: 5 })
    expect(scene(900)).toEqual({ x: 5 })
  })

  it('should work for a two frames', () => {
    const scene = animation([
      {
        timestamp: 1,
        x: 5,
      },
      {
        timestamp: 2,
        x: 10,
      },
    ])
    expect(scene(-1000)).toEqual({ x: 5 })
    expect(scene(-0.1)).toEqual({ x: 5 })
    expect(scene(0.5)).toEqual({ x: 5 })
    expect(scene(1.0)).toEqual({ x: 5 })
    expect(scene(1.2)).toEqual({ x: 6 })
    expect(scene(1.4)).toEqual({ x: 7 })
    expect(scene(1.5)).toEqual({ x: 7.5 })
    expect(scene(1.6)).toEqual({ x: 8 })
    expect(scene(1.8)).toEqual({ x: 9 })
    expect(scene(2.0)).toEqual({ x: 10 })
    expect(scene(2.1)).toEqual({ x: 10 })
    expect(scene(2000)).toEqual({ x: 10 })
  })

  it('should work for three frames', () => {
    const scene = animation([
      {
        timestamp: 1,
        x: 5,
      },
      {
        timestamp: 2,
        x: 10,
      },
      {
        timestamp: 3,
        x: 0,
      },
    ])
    expect(scene(-1000)).toEqual({ x: 5 })
    expect(scene(-0.1)).toEqual({ x: 5 })
    expect(scene(0.5)).toEqual({ x: 5 })
    expect(scene(1.0)).toEqual({ x: 5 })
    expect(scene(1.2)).toEqual({ x: 6 })
    expect(scene(1.4)).toEqual({ x: 7 })
    expect(scene(1.5)).toEqual({ x: 7.5 })
    expect(scene(1.6)).toEqual({ x: 8 })
    expect(scene(1.8)).toEqual({ x: 9 })
    expect(scene(2.0)).toEqual({ x: 10 })
    expect(scene(2.1)).toEqual({ x: 9 })
    expect(scene(2.2).x).toBeCloseTo(8)
    expect(scene(2.3).x).toBeCloseTo(7)
    expect(scene(2.4).x).toBeCloseTo(6)
    expect(scene(2.5).x).toBeCloseTo(5)
    expect(scene(2.8).x).toBeCloseTo(2)
    expect(scene(2.9).x).toBeCloseTo(1)
    expect(scene(3.0).x).toBeCloseTo(0)
    expect(scene(2000)).toEqual({ x: 0 })
  })

  it('should work for incomplete frames', () => {
    const scene = animation([
      {
        timestamp: 0,
        a: 1,
        b: 2,
      },
      {
        timestamp: 1,
        a: 2,
        c: 3
      },
      {
        timestamp: 2,
        b: 4,
        c: 5,
        d: 6
      },
    ])
    expect(scene(-1)).toEqual({ a: 1, b: 2, c: 3, d: 6 })
    expect(scene(0)).toEqual({ a: 1, b: 2, c: 3, d: 6 })
    expect(scene(0.5)).toEqual({ a: 1.5, b: 2, c: 3, d: 6 })
    expect(scene(1.0)).toEqual({ a: 2, b: 2, c: 3, d: 6 })
    expect(scene(1.5)).toEqual({ a: 2, b: 3, c: 4, d: 6 })
    expect(scene(2)).toEqual({ a: 2, b: 4, c: 5, d: 6 })
    expect(scene(3)).toEqual({ a: 2, b: 4, c: 5, d: 6 })
  })
})
