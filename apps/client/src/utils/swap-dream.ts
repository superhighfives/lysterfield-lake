import { useStore, SwapDirection } from '../store'
import { HistoryState, urlFor } from './use-history-sync'
import { fadeGain } from './audio'

// Swapping to another dream without going back to the choose screen.
//
// Only the dream's own small video changes (utils/dream-video.ts):
// Playhead loads it at the song's current time and crossfades to it, and
// moves the swap on to `in` once it's there. The song never stops.

// How long the audio takes to fade out (going back to the choose screen)
// and back in (as a dream starts).
const FADE_OUT_MS = 300
const FADE_IN_MS = 600

export function adjacentDream(direction: SwapDirection) {
  const { collection, dream } = useStore.getState()
  const index = collection.findIndex((item) => item.id === dream?.id)
  // A dev preview isn't in the collection; swap into it from the start.
  if (index === -1) return collection[0]
  return collection[(index + direction + collection.length) % collection.length]
}

// Faded on the Web Audio gain node when there is one (utils/audio.ts),
// which works on iOS too. Otherwise el.volume, faded by hand — read-only
// on iOS, where the audio then just cuts.
let fadeFrame = 0
let restoreVolume: number | null = null

function fadeVolume(
  el: HTMLVideoElement,
  to: number,
  ms: number,
  onDone?: () => void
) {
  cancelAnimationFrame(fadeFrame)
  const from = el.volume
  const start = performance.now()
  const step = (now: number) => {
    // rAF's timestamp is the frame's start, which can be a little before
    // `start`; a negative t pushes volume out of [0, 1], and that throws.
    const t = Math.min(Math.max((now - start) / ms, 0), 1)
    el.volume = from + (to - from) * t
    if (t < 1) fadeFrame = requestAnimationFrame(step)
    else onDone?.()
  }

  fadeFrame = requestAnimationFrame(step)
}

export function fadeOutAudio(el: HTMLVideoElement, ms = FADE_OUT_MS) {
  if (fadeGain(0, ms)) return
  restoreVolume ??= el.volume
  fadeVolume(el, 0, ms)
}

// The volume to come back to is only forgotten once the fade in is done,
// so a swap that starts mid-fade doesn't take the half-faded level for it.
// Also called as a dream starts (components/playhead.tsx), after the fade
// out going back to the choose screen.
export function fadeInAudio(el: HTMLVideoElement, ms = FADE_IN_MS) {
  if (fadeGain(1, ms)) return
  fadeVolume(el, restoreVolume ?? 1, ms, () => (restoreVolume = null))
}

/** Called once the polaroid's photo has faded to blank: switches to the
 *  next dream, which Playhead loads at the current playback position and
 *  moves the swap on to `in` once it's there. */
export function commitSwap(el: HTMLVideoElement) {
  const { swapDirection, setDream, setSwapPhase } = useStore.getState()
  const next = adjacentDream(swapDirection)
  if (!next) return setSwapPhase('idle')

  // Replaced rather than pushed (use-history-sync only pushes when the URL
  // doesn't already match), so back still goes to the choose screen
  // instead of stepping through every polaroid swiped past.
  history.replaceState(
    { dream: next.id, t: el.currentTime } satisfies HistoryState,
    '',
    urlFor(next.id)
  )
  setDream(next)
  setSwapPhase('loading')
}
