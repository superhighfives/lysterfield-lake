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
const FLICK_VELOCITY = 0.6 // px/ms
const FLICK_MIN_PX = 30

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
    state.showPlayhead &&
    state.polaroidPillVisible &&
    (state.swapPhase === 'idle' || (split && state.swapPhase === 'loading')) &&
    (split || !playback.waiting)
  )
}

export function commitDistance() {
  const width = polaroidRect.right - polaroidRect.left
  return Math.max(COMMIT_MIN_PX, width * COMMIT_SHARE_OF_WIDTH)
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
    // The last two pointer samples, for the release velocity.
    let last = { x: 0, time: 0 }
    let velocity = 0

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      // Only over the scene, and not from the control pill inside it, where
      // dragging the time range is a seek.
      const target = event.target as Element
      if (!target.closest('[data-swap-surface]')) return
      if (target.closest('button, a, input, media-controller')) return
      if (!canSwap()) return
      start = {
        x: event.clientX,
        y: event.clientY,
        onPolaroid: nearPolaroid(event.clientX, event.clientY, 0),
      }
      last = { x: event.clientX, time: event.timeStamp }
      velocity = 0
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!start) return
      // A mouse released outside the window never sends pointerup here —
      // a move with no button held means the press is long over.
      if (event.pointerType === 'mouse' && event.buttons === 0) {
        handlePointerCancel()
        return
      }

      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      // Only a mostly-sideways move becomes a drag, so a vertical swipe
      // isn't taken for one.
      if (!swapDrag.active) {
        if (Math.abs(dx) < TAP_DISTANCE || Math.abs(dx) < Math.abs(dy)) return
        swapDrag.active = true
      }

      swapDrag.dx = dx
      const elapsed = event.timeStamp - last.time
      if (elapsed > 0) velocity = (event.clientX - last.x) / elapsed
      last = { x: event.clientX, time: event.timeStamp }
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!start) return
      const { onPolaroid } = start
      start = null

      if (!swapDrag.active) {
        const moved = Math.abs(event.clientX - last.x)
        if (onPolaroid && moved < TAP_DISTANCE && canSwap()) {
          useStore.getState().requestSwap(1)
        }

        return
      }

      swapDrag.active = false
      const dx = swapDrag.dx
      // A stale velocity (the pointer held still before letting go)
      // shouldn't count as a flick.
      const fresh = event.timeStamp - last.time < 100
      const flicked =
        fresh &&
        Math.abs(velocity) >= FLICK_VELOCITY &&
        Math.abs(dx) >= FLICK_MIN_PX &&
        Math.sign(velocity) === Math.sign(dx)
      if ((Math.abs(dx) >= commitDistance() || flicked) && canSwap()) {
        useStore.getState().requestSwap(directionOf(dx))
      }
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
    }
  }, [])
}
