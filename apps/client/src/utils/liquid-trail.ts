import { CanvasTexture, LinearFilter, Vector2 } from 'three'

// The cursor's wake, as if it were dragged through water: a small
// screen-shaped height map where the pointer has been, fading as it
// settles. The video shaders (materials/video-material.tsx) bend their
// images along its slope, so the dream, avatar and lyrics ripple as the
// pointer passes over them. Drawn on a 2D canvas rather than in a
// post-processing pass: it's cheap, and only the imagery moves, not the UI.

// Trail resolution (its long side, in texels), how fast it settles (alpha
// of the clearing wash per frame), and a stroke's radius as a share of the
// canvas width, at rest and at full speed.
const TRAIL_SIZE = 160
const SETTLE = 0.05
const RADIUS = 0.08
const RADIUS_FAST = 0.16
// Pointer speed (CSS px per frame) that counts as full speed.
const FULL_SPEED = 40

const canvas = document.createElement('canvas')
const context = canvas.getContext('2d')!
export const trailTexture = new CanvasTexture(canvas)
/** The canvas's size in device pixels, for the shaders to look the trail
 *  up by gl_FragCoord (see materials/wake.ts). */
export const trailResolution = new Vector2(1, 1)
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
  context.fillStyle = 'black'
  context.fillRect(0, 0, w, h)
}

/** Advances the trail one frame, for a canvas of this CSS size. */
export function updateTrail(width: number, height: number, dpr: number) {
  // The canvas is 0x0 for its first frames; nothing to size the trail by.
  if (!width || !height) return
  resize(width, height)
  trailResolution.set(width * dpr, height * dpr)
  const scale = canvas.width / width

  context.globalCompositeOperation = 'source-over'
  context.fillStyle = `rgba(0, 0, 0, ${SETTLE})`
  context.fillRect(0, 0, canvas.width, canvas.height)

  if (pointer.x >= 0 && last.x >= 0) {
    const dx = pointer.x - last.x
    const dy = pointer.y - last.y
    const speed = Math.min(Math.hypot(dx, dy) / FULL_SPEED, 1)
    if (speed > 0.01) {
      const radius =
        canvas.width * (RADIUS + (RADIUS_FAST - RADIUS) * speed)
      // Stamped along the path since last frame, so a fast stroke is a
      // continuous wake rather than a dotted line.
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * scale / (radius / 2)))
      context.globalCompositeOperation = 'lighter'
      for (let i = 1; i <= steps; i++) {
        const x = (last.x + (dx * i) / steps) * scale
        const y = (last.y + (dy * i) / steps) * scale
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius)
        gradient.addColorStop(0, `rgba(255, 255, 255, ${0.3 * speed})`)
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
        context.fillStyle = gradient
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
      }
    }
  }

  last.x = pointer.x
  last.y = pointer.y
  trailTexture.needsUpdate = true
}
