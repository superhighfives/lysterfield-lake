import type { SwapDirection, SwapStyle } from '../store'

// The player polaroid's swap animations (see utils/swap-dream.ts). Each
// style is a pair of pure functions from progress to a pose, applied to a
// group around the polaroid, so the pointer tilt on the polaroid itself
// carries on underneath. `p` runs 0 -> 1 as the old polaroid leaves, and
// 1 -> 0 as the new one arrives: `exit(1)` is held while the next video
// loads, and `enter(0)` (like `exit(0)`) is the resting pose.
//
// `w` and `h` are the visible width and height at the polaroid's own
// depth, with a margin (see OFFSCREEN_MARGIN in main.tsx) — so a pose at
// `h` is fully off-screen, not just a viewport-at-z=0 away.

export type Pose = {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
}

type PoseFn = (p: number, dir: SwapDirection, w: number, h: number) => Pose

export type SwapAnimation = {
  /** Seconds for each half. */
  outDuration: number
  inDuration: number
  exit: PoseFn
  enter: PoseFn
  /** Optional rocking while waiting on the load: radians added to
   *  `exit(1)`'s y rotation. */
  hold?: (time: number, dir: SwapDirection) => { ry: number }
}

const rest: Pose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }

const easeInCubic = (t: number) => t * t * t
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
// For `enter`, where p counts down: eases out as the polaroid settles.
const settle = (p: number) => 1 - easeOutCubic(1 - p)
// Overshoots rest by a little and comes back, like landing on a pile. For
// `enter` too: 1 -> 0, briefly dipping below 0.
const LAND_OVERSHOOT = 1.4
const land = (p: number) => {
  const t = 1 - p
  return -(
    LAND_OVERSHOOT * (t - 1) ** 2 +
    (LAND_OVERSHOOT + 1) * (t - 1) ** 3
  )
}

export const SWAP_ANIMATIONS: Record<SwapStyle, SwapAnimation> = {
  // Slides off one side with a slight tilt; the next slides in from the
  // other, like dealing a card. The lyrics and avatar stay put.
  slide: {
    outDuration: 0.45,
    inDuration: 0.7,
    exit: (p, dir, w) => {
      const e = easeInCubic(p)
      return { ...rest, x: -dir * e * w, rz: dir * e * 0.25 }
    },
    enter: (p, dir, w) => {
      const e = settle(p)
      return { ...rest, x: dir * e * w, rz: -dir * e * 0.25 }
    },
  },

  // Flips over to its back, lifting toward the camera mid-turn, and waits
  // face-down — rocking gently — until the next dream is ready, then
  // carries on round to show it.
  flip: {
    outDuration: 0.5,
    inDuration: 0.6,
    exit: (p, dir) => {
      const e = easeInOutCubic(p)
      return { ...rest, ry: dir * e * Math.PI, z: Math.sin(e * Math.PI) * 0.3 }
    },
    enter: (p, dir) => {
      const e = 1 - easeInOutCubic(1 - p)
      return {
        ...rest,
        ry: dir * (2 - e) * Math.PI,
        z: Math.sin(e * Math.PI) * 0.3,
      }
    },
    hold: (time, dir) => ({ ry: dir * Math.sin(time * 4) * 0.08 }),
  },

  // Tossed away down and to the side, spinning; the next drops in from
  // above and lands — like a stack of photos being flicked through.
  drop: {
    outDuration: 0.5,
    inDuration: 0.75,
    exit: (p, dir, w, h) => {
      const e = easeInCubic(p)
      return {
        ...rest,
        x: -dir * e * w * 0.3,
        y: -e * h,
        rz: dir * e * 0.8,
        rx: e * 0.4,
      }
    },
    enter: (p, dir, w, h) => {
      const e = settle(p)
      return {
        ...rest,
        x: dir * e * w * 0.15,
        y: land(p) * h,
        rz: -dir * e * 0.4,
      }
    },
  },
}
