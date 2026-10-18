import { CanvasTexture, LinearFilter, Vector4 } from 'three'

// The cursor's wake, as if it were dragged through water: a small
// screen-shaped map of which way the pointer has been moving, fading as it
// settles. The scene's final pass (components/wake-pass.tsx) pulls the
// whole rendered image along it, so everything the pointer passes over —
// photos, frames, text — is dragged a little with it, centred on its path.
//
// Encoded around a neutral mid-grey: red and green are the flow's x and y
// (128 = still, in canvas space, so y is down), blue is how much wake
// there is. Strokes are painted over it with ordinary blending, so each
// pulls the flow toward its own direction, and a wash of neutral each
// frame lets it all settle back.

// Trail resolution (its long side, in texels), how fast it settles (alpha
// of the neutral wash per frame), and a stroke's radius as a share of the
// canvas width, at rest and at full speed.
const TRAIL_SIZE = 160
const SETTLE = 0.012
const RADIUS = 0.05
const RADIUS_FAST = 0.1
// Pointer speed (CSS px per frame) that counts as full speed. The wake
// follows speed on a curve (SPEED_CURVE > 1), so a slow drift barely
// stirs it and a fast flick drags hard. A stroke's opacity runs from
// STROKE_ALPHA_SLOW to STROKE_ALPHA_FAST along the same curve.
const FULL_SPEED = 60
const SPEED_CURVE = 1.6
const STROKE_ALPHA_SLOW = 0.2
const STROKE_ALPHA_FAST = 0.65
const NEUTRAL = 'rgb(128, 128, 0)'
// Frames for a full-strength stroke to wash out to (8-bit) nothing at
// SETTLE per frame, plus a margin; the trail counts as active that long
// after its last stroke.
const ACTIVE_FRAMES = Math.ceil(Math.log(1 / 255) / Math.log(1 - SETTLE)) + 30
let activeFrames = 0

// Ripple drops: the pointer drops a ring every DROP_SPACING CSS px it
// travels, which the wake pass spreads out behind the scene as a soft
// swell. At most MAX_DROPS at once, each gone after DROP_SECONDS (the
// wake pass's shader fades it over the same time). When they're all in
// use, a new drop waits for the oldest to have nearly faded
// (REPLACE_AFTER of its life) rather than cutting it off mid-ripple —
// which a long stroke used to do, ending earlier rings abruptly.
export const MAX_DROPS = 16
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

const canvas = document.createElement('canvas')
const context = canvas.getContext('2d')!
export const trailTexture = new CanvasTexture(canvas)
trailTexture.minFilter = LinearFilter
trailTexture.magFilter = LinearFilter

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

function resize(width: number, height: number) {
  const aspect = width / height
  const w = aspect >= 1 ? TRAIL_SIZE : Math.round(TRAIL_SIZE * aspect)
  const h = aspect >= 1 ? Math.round(TRAIL_SIZE / aspect) : TRAIL_SIZE
  if (canvas.width === w && canvas.height === h) return
  canvas.width = w
  canvas.height = h
  context.fillStyle = NEUTRAL
  context.fillRect(0, 0, w, h)
}

/** Advances the trail one frame, for a canvas of this CSS size. */
export function updateTrail(width: number, height: number) {
  // The canvas is 0x0 for its first frames; nothing to size the trail by.
  if (!width || !height) return
  resize(width, height)
  const scale = canvas.width / width

  context.globalAlpha = SETTLE
  context.fillStyle = NEUTRAL
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.globalAlpha = 1

  if (pointer.x >= 0 && last.x >= 0) {
    const dx = pointer.x - last.x
    const dy = pointer.y - last.y
    const distance = Math.hypot(dx, dy)
    const speed = Math.min(distance / FULL_SPEED, 1) ** SPEED_CURVE
    if (speed > 0.005) {
      activeFrames = ACTIVE_FRAMES
      const radius = canvas.width * (RADIUS + (RADIUS_FAST - RADIUS) * speed)
      const r = Math.round(128 + 127 * (dx / distance) * speed)
      const g = Math.round(128 + 127 * (dy / distance) * speed)
      const b = Math.round(255 * speed)
      const alpha =
        STROKE_ALPHA_SLOW + (STROKE_ALPHA_FAST - STROKE_ALPHA_SLOW) * speed
      // Stamped along the path since last frame, so a fast stroke is a
      // continuous wake rather than a dotted line.
      const steps = Math.max(1, Math.ceil((distance * scale) / (radius / 2)))
      for (let i = 1; i <= steps; i++) {
        const x = (last.x + (dx * i) / steps) * scale
        const y = (last.y + (dy * i) / steps) * scale
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius)
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`)
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
        context.fillStyle = gradient
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
      }
    }
  }

  last.x = pointer.x
  last.y = pointer.y
  if (activeFrames > 0) {
    activeFrames--
    trailTexture.needsUpdate = true
  }
}
