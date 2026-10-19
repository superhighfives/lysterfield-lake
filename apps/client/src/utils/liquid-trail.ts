import { Vector4 } from 'three'

// The cursor's wake, as if it were dragged through water: a small
// screen-shaped map of which way the pointer has been moving, fading as it
// settles. The scene's final pass (components/wake-pass.tsx) keeps that
// map on the GPU — in floats, so it fades exactly to nothing (an 8-bit
// canvas, as this used to be, can't fade the last few levels at a slow
// rate, and left blotches of stuck flow that frayed every edge into
// steps) — and pulls the rendered image along it. This module measures
// the pointer: each frame's stroke, and the ripple drops.
//
// The map holds the flow's x and y (y up, -1 to 1) and how much wake
// there is. Each frame's stroke is painted over it, pulling the flow
// toward its own direction, and the whole map fades by SETTLE.

// Trail resolution (its long side, in texels), how fast it settles (the
// share lost per frame), and a stroke's radius as a share of the screen
// width, at rest and at full speed.
export const TRAIL_SIZE = 160
export const SETTLE = 0.015
const RADIUS = 0.05
const RADIUS_FAST = 0.1
// Pointer speed (CSS px per frame) that counts as full speed. The wake
// follows speed on a curve (SPEED_CURVE > 1), so a slow drift barely
// stirs it and a fast flick drags hard. A stroke's strength runs from
// STROKE_ALPHA_SLOW to STROKE_ALPHA_FAST along the same curve.
const FULL_SPEED = 60
const SPEED_CURVE = 1.6
const STROKE_ALPHA_SLOW = 0.3
const STROKE_ALPHA_FAST = 0.8
// Frames for a full-strength stroke to fade below a visible trace at
// SETTLE per frame, plus a margin; the trail counts as active that long
// after its last stroke.
const ACTIVE_FRAMES = Math.ceil(Math.log(1 / 500) / Math.log(1 - SETTLE)) + 30
let activeFrames = 0

// Ripple drops: the pointer drops a ring every DROP_SPACING CSS px it
// travels, which the wake pass spreads out behind the scene as a soft
// swell. At most MAX_DROPS at once, each gone after DROP_SECONDS (the
// wake pass's shader fades it over the same time). When they're all in
// use, a new drop waits for the oldest to have nearly faded
// (REPLACE_AFTER of its life) rather than cutting it off mid-ripple —
// which a long stroke used to do, ending earlier rings abruptly.
export const MAX_DROPS = 16
/** The camera layer polaroids join, so the wake pass can tell them from
 *  everything else. */
export const WAKE_MASK_LAYER = 5
const DROP_SPACING = 110
export const DROP_SECONDS = 3.2
const REPLACE_AFTER = 0.8
const drops: { x: number; y: number; born: number; strength: number }[] = []
let lastDrop: { x: number; y: number } | null = null
let lastDropBorn = -Infinity

/** The drops as the wake pass takes them: xy = CSS px from the canvas's
 *  bottom-left, z = age (s), w = strength (0 = none). One shared array. */
export const dropUniform = Array.from({ length: MAX_DROPS }, () => new Vector4())

/** Whether there's anything worth drawing — trail or rings. If not, the
 *  wake pass skips itself and the scene draws straight to the screen. */
export const trailActive = () =>
  activeFrames > 0 || performance.now() - lastDropBorn < DROP_SECONDS * 1000

const pointer = { x: -1, y: -1 }
const last = { x: -1, y: -1 }
window.addEventListener('pointermove', (event) => {
  pointer.x = event.clientX
  pointer.y = event.clientY
  const distance = lastDrop
    ? Math.hypot(event.clientX - lastDrop.x, event.clientY - lastDrop.y)
    : Infinity
  if (distance < DROP_SPACING) return
  const now = performance.now()
  // Drop the dead; when full, only make room once the oldest has nearly
  // faded.
  while (drops.length && now - drops[0].born > DROP_SECONDS * 1000) drops.shift()
  if (drops.length >= MAX_DROPS) {
    if (now - drops[0].born < DROP_SECONDS * 1000 * REPLACE_AFTER) return
    drops.shift()
  }

  // Faster strokes make stronger swells (a first drop, mid-strength).
  const strength =
    distance === Infinity ? 0.6 : Math.min(1, 0.4 + distance / 300)
  lastDrop = { x: event.clientX, y: event.clientY }
  lastDropBorn = now
  drops.push({ x: event.clientX, y: event.clientY, born: now, strength })
})

/** Writes the drops into dropUniform, for a canvas this many CSS px tall. */
export function writeDrops(height: number) {
  const now = performance.now()
  dropUniform.forEach((drop, i) => {
    const source = drops[i]
    if (!source) return drop.set(0, 0, 0, 0)
    drop.set(source.x, height - source.y, (now - source.born) / 1000, source.strength)
  })
}

/** One frame's stroke, in screen UV (0-1, y up): the segment the pointer
 *  covered, its radius (a share of the screen width), its flow (unit
 *  direction times speed, y up), and how strongly it paints. */
export type Stroke = {
  from: [number, number]
  to: [number, number]
  radius: number
  flow: [number, number]
  presence: number
  alpha: number
}

/** Measures this frame's stroke for a canvas this many CSS px across, or
 *  null if the pointer's barely moved; and counts down the trail's
 *  activity. Call once per frame. */
export function takeStroke(width: number, height: number): Stroke | null {
  let stroke: Stroke | null = null
  if (width && height && pointer.x >= 0 && last.x >= 0) {
    const dx = pointer.x - last.x
    const dy = pointer.y - last.y
    const distance = Math.hypot(dx, dy)
    const speed = Math.min(distance / FULL_SPEED, 1) ** SPEED_CURVE
    if (speed > 0.005) {
      activeFrames = ACTIVE_FRAMES
      stroke = {
        from: [last.x / width, 1 - last.y / height],
        to: [pointer.x / width, 1 - pointer.y / height],
        radius: RADIUS + (RADIUS_FAST - RADIUS) * speed,
        flow: [(dx / distance) * speed, (-dy / distance) * speed],
        presence: speed,
        alpha:
          STROKE_ALPHA_SLOW + (STROKE_ALPHA_FAST - STROKE_ALPHA_SLOW) * speed,
      }
    }
  }

  last.x = pointer.x
  last.y = pointer.y
  if (activeFrames > 0) activeFrames--
  return stroke
}
