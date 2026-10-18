import type { Dream } from './types'

// Lets something other than the player's polaroid drive the custom cursor's
// drag states (components/cursor.tsx) — the stack carousel, so its swipe is
// taught with the same ring and preview as swapping dreams in the player.
// Mutated in place and read every frame, never through React.
export const cursorHint = {
  /** Something's using the hint; otherwise the cursor ignores it. */
  active: false,
  /** Over something that can be dragged: the cursor offers a drag. */
  near: false,
  /** Mid-drag: the cursor shows the ring filling and the preview. */
  dragging: false,
  /** 0-1, toward the point where letting go does it. */
  progress: 0,
  /** What letting go reveals, and which side to show it on. */
  dream: null as Dream | null,
  side: 'right' as 'left' | 'right',
}
