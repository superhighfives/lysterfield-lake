import { CanvasTexture, LinearFilter } from 'three'

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

/** Whether the trail has anything in it worth drawing — if not, the wake
 *  pass can skip itself and the scene draw straight to the screen. */
export const trailActive = () => activeFrames > 0

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
})

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
