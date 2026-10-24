import { useEffect } from 'react'
import { SwapDirection, useStore } from '../store'
import { isSplit, playback } from './dream-video'
import { adjacentDream } from './swap-dream'

// Dragging the player's polaroid sideways to swap dreams (see
// utils/swap-dream.ts). While a drag is held the polaroid follows it
// (views/main.tsx) and the cursor previews where letting go will land
// (components/cursor.tsx); let go far enough, or flick, and it springs
// back as the next dream develops in. A tap on the polaroid, and the arrow
// keys, swap too.
//
// These two objects are mutated in place and read every frame by the scene
// and the cursor, never through React — same reasoning as the per-frame
// refs in main.tsx.

/** The polaroid's photo on screen, in CSS pixels, written each frame by
 *  views/main.tsx. */
export const polaroidRect = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  visible: false,
}

/** The drag in progress, in CSS pixels. Let go, and the polaroid springs
 *  back to rest, swapping or not. */
export const swapDrag = {
  active: false,
  dx: 0,
  /** Where (CSS px) the drag began. */
  startX: 0,
}

// How close (CSS pixels) the pointer has to be for the cursor to offer a
// drag, and for a tap to count as on the polaroid.
export const NEAR_MARGIN = 60
// Below this much movement it's a tap, not a drag.
const TAP_DISTANCE = 6
// Letting go past this (the larger of the two) swaps; short of it the
// polaroid springs back. A quick enough flick swaps from a shorter drag.
const COMMIT_MIN_PX = 90
const COMMIT_SHARE_OF_WIDTH = 0.3
// Started near an edge, there may not be that far to go toward it: then
// it's EDGE_SHARE of the room that's left that way (at least EDGE_MIN_PX).
const EDGE_SHARE = 0.7
const EDGE_MIN_PX = 24
// A flick: at least FLICK_VELOCITY (px/ms) over the last VELOCITY_WINDOW_MS
// of the drag, and FLICK_MIN_PX long. Measured over a window, not the
// last two samples: a finger slows as it lifts, and that last sample
// undersold a hard flick.
const FLICK_VELOCITY = 0.4
const FLICK_MIN_PX = 20
const VELOCITY_WINDOW_MS = 80
// A swap asked for while the last is still fading out or in (a quick
// second flick) waits up to SWAP_QUEUE_MS for it, rather than being lost.
const SWAP_QUEUE_MS = 450

export function nearPolaroid(x: number, y: number, margin = NEAR_MARGIN) {
  const r = polaroidRect
  return (
    r.visible &&
    x >= r.left - margin &&
    x <= r.right + margin &&
    y >= r.top - margin &&
    y <= r.bottom + margin
  )
}

// Not while the photo fades out or develops in, but while it's a blank
// print waiting on video — the first dream, or a swap's — a swap can skip
// past it (split: the 7-panel layout reloads the whole video, so it
// waits).
export function canSwap() {
  const state = useStore.getState()
  const split = isSplit(state.dream)
  return (
    // Not while the loading pile is still up (components/loading.tsx).
    state.pileLeaving &&
    state.showPlayhead &&
    state.polaroidPillVisible &&
    (state.swapPhase === 'idle' || (split && state.swapPhase === 'loading')) &&
    (split || !playback.waiting)
  )
}

export function commitDistance() {
  const width = polaroidRect.right - polaroidRect.left
  const distance = Math.max(COMMIT_MIN_PX, width * COMMIT_SHARE_OF_WIDTH)
  if (!swapDrag.active || swapDrag.dx === 0) return distance
  const room =
    swapDrag.dx < 0 ? swapDrag.startX : window.innerWidth - swapDrag.startX
  return Math.min(distance, Math.max(EDGE_MIN_PX, room * EDGE_SHARE))
}

/** Dragging left tosses this one left and brings in the next. */
export const directionOf = (dx: number): SwapDirection => (dx < 0 ? 1 : -1)

/** Where letting go of the current drag would land, and how close to the
 *  commit point it is (0-1). */
export function dragPreview() {
  const direction = directionOf(swapDrag.dx)
  return {
    direction,
    dream: adjacentDream(direction),
    progress: Math.min(1, Math.abs(swapDrag.dx) / commitDistance()),
  }
}

export function useSwapInput() {
  useEffect(() => {
    let start: { x: number; y: number; onPolaroid: boolean } | null = null
    // The drag's recent pointer samples, for the release velocity.
    let samples: { x: number; time: number }[] = []
    const sample = (x: number, time: number) => {
      samples.push({ x, time })
      while (samples.length > 2 && time - samples[1].time > VELOCITY_WINDOW_MS)
        samples.shift()
    }

    const velocity = () => {
      if (samples.length < 2) return 0
      const first = samples[0]
      const last = samples[samples.length - 1]
      const elapsed = last.time - first.time
      return elapsed > 0 ? (last.x - first.x) / elapsed : 0
    }


    // A swap waiting for the last to finish (see SWAP_QUEUE_MS).
    let queued: { direction: SwapDirection; until: number } | null = null
    let queueFrame = 0
    const tryQueued = () => {
      queueFrame = 0
      if (!queued) return
      if (performance.now() > queued.until) {
        queued = null
        return
      }

      if (canSwap()) {
        useStore.getState().requestSwap(queued.direction)
        queued = null
        return
      }

      queueFrame = requestAnimationFrame(tryQueued)
    }

    const swap = (direction: SwapDirection) => {
      if (canSwap()) {
        useStore.getState().requestSwap(direction)
        return
      }

      queued = { direction, until: performance.now() + SWAP_QUEUE_MS }
      if (!queueFrame) queueFrame = requestAnimationFrame(tryQueued)
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      // Only over the scene, and not from the control pill inside it, where
      // dragging the time range is a seek.
      const target = event.target as Element
      if (!target.closest('[data-swap-surface]')) return
      if (target.closest('button, a, input, media-controller')) return
      // Taken even when a swap isn't on yet (the polaroid fading or
      // developing): the drag picks up as soon as it is (see move).
      start = {
        x: event.clientX,
        y: event.clientY,
        onPolaroid: nearPolaroid(event.clientX, event.clientY, 0),
      }
      samples = [{ x: event.clientX, time: event.timeStamp }]
    }

    // A pointer position in the drag: from a move, or the release itself
    // (a hard flick can come with no move between press and release).
    const track = (event: PointerEvent) => {
      if (!start) return
      // Not swappable yet: the drag's start follows the finger, so it
      // takes up from here, without a jump, the moment it is.
      if (!swapDrag.active && !canSwap()) {
        start.x = event.clientX
        start.y = event.clientY
        samples = [{ x: event.clientX, time: event.timeStamp }]
        return
      }

      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      // Only a mostly-sideways move becomes a drag, so a vertical swipe
      // isn't taken for one.
      if (!swapDrag.active) {
        if (Math.abs(dx) < TAP_DISTANCE || Math.abs(dx) < Math.abs(dy)) return
        swapDrag.active = true
        swapDrag.startX = start.x
      }

      swapDrag.dx = dx
      sample(event.clientX, event.timeStamp)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!start) return
      // A mouse released outside the window never sends pointerup here —
      // a move with no button held means the press is long over.
      if (event.pointerType === 'mouse' && event.buttons === 0) {
        handlePointerCancel()
        return
      }

      track(event)
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!start) return
      // The release counts as the drag's last move.
      const pressedAt = samples[0]
      track(event)
      const { onPolaroid } = start
      start = null

      if (!swapDrag.active) {
        const moved = Math.abs(event.clientX - (pressedAt?.x ?? event.clientX))
        if (onPolaroid && moved < TAP_DISTANCE && canSwap()) {
          useStore.getState().requestSwap(1)
        }

        return
      }

      // Measured before the drag's over (it allows for the room to the
      // edge only while one's on).
      const needed = commitDistance()
      swapDrag.active = false
      const dx = swapDrag.dx
      // Over the window up to the release, so a pointer held still before
      // letting go reads as no speed, not a flick.
      const speed = velocity()
      const flicked =
        Math.abs(speed) >= FLICK_VELOCITY &&
        Math.abs(dx) >= FLICK_MIN_PX &&
        Math.sign(speed) === Math.sign(dx)
      if (Math.abs(dx) >= needed || flicked) swap(directionOf(dx))
    }

    const handlePointerCancel = () => {
      start = null
      swapDrag.active = false
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Leave arrow keys alone while a control (the time range) has focus.
      if (document.activeElement && document.activeElement !== document.body)
        return
      if (!canSwap()) return
      if (event.key === 'ArrowRight') useStore.getState().requestSwap(1)
      if (event.key === 'ArrowLeft') useStore.getState().requestSwap(-1)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('keydown', handleKeyDown)
      cancelAnimationFrame(queueFrame)
    }
  }, [])
}
