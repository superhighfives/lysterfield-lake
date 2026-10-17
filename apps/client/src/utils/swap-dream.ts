import { MathUtils } from 'three'
import { useStore, SwapDirection } from '../store'
import { HistoryState, urlFor } from './use-history-sync'

// Swapping to another dream without going back to the choose screen.
// Every dream is one composite video (all seven panels plus the audio), so
// a swap really means loading another video and seeking it to where this
// one was — the same resume path a history restore takes (see Playhead).
// The polaroid's out/in animation (views/main.tsx, utils/swap-poses.ts)
// covers the load, and the audio fades out and back in around the gap.

// How long the audio takes to fade out (as the polaroid leaves) and back
// in (as the next one arrives). The out fade should finish before the
// out animation does, or the load cuts the tail of it off.
const FADE_OUT_MS = 300
const FADE_IN_MS = 600
// If the next video still hasn't started after this long, bring the
// polaroid back anyway and let the normal buffering UI take over.
const LOAD_TIMEOUT_MS = 10000

export function adjacentDream(direction: SwapDirection) {
  const { collection, dream } = useStore.getState()
  const index = collection.findIndex((item) => item.id === dream?.id)
  // A dev preview isn't in the collection; swap into it from the start.
  if (index === -1) return collection[0]
  return collection[(index + direction + collection.length) % collection.length]
}

// el.volume, faded by hand: there's no gain node in the way. iOS Safari
// treats volume as read-only (always 1), so there the audio just cuts —
// a GainNode via createMediaElementSource would be the fix if this ships.
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
    const t = MathUtils.clamp((now - start) / ms, 0, 1)
    el.volume = from + (to - from) * t
    if (t < 1) fadeFrame = requestAnimationFrame(step)
    else onDone?.()
  }

  fadeFrame = requestAnimationFrame(step)
}

export function fadeOutAudio(el: HTMLVideoElement) {
  restoreVolume ??= el.volume
  fadeVolume(el, 0, FADE_OUT_MS)
}

// The volume to come back to is only forgotten once the fade in is done,
// so a swap that starts mid-fade doesn't take the half-faded level for it.
function fadeInAudio(el: HTMLVideoElement) {
  fadeVolume(el, restoreVolume ?? 1, FADE_IN_MS, () => (restoreVolume = null))
}

/** Called once the polaroid's out animation has finished: loads the next
 *  dream at the current playback position, and moves the swap on to `in`
 *  once it's actually playing there. */
export function commitSwap(el: HTMLVideoElement) {
  const { swapDirection, setResume, setDream, setSwapPhase } =
    useStore.getState()
  const next = adjacentDream(swapDirection)
  if (!next) return setSwapPhase('idle')

  const time = el.currentTime

  // Replaced rather than pushed (use-history-sync only pushes when the URL
  // doesn't already match), so back still goes to the choose screen
  // instead of stepping through every polaroid swiped past.
  history.replaceState(
    { dream: next.id, t: time } satisfies HistoryState,
    '',
    urlFor(next.id)
  )

  // Until Playhead calls load() for the new source, every readiness check
  // below would pass on the old one — so nothing counts before `emptied`.
  let emptied = false
  const handleEmptied = () => (emptied = true)
  const check = () => {
    if (!emptied) return
    if (el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
    if (Math.abs(el.currentTime - time) > 0.5) return
    finish()
  }

  const finish = () => {
    clearTimeout(timeout)
    el.removeEventListener('emptied', handleEmptied)
    events.forEach((event) => el.removeEventListener(event, check))
    setSwapPhase('in')
    fadeInAudio(el)
  }

  const events = ['playing', 'canplay', 'seeked']
  el.addEventListener('emptied', handleEmptied)
  events.forEach((event) => el.addEventListener(event, check))
  const timeout = setTimeout(finish, LOAD_TIMEOUT_MS)

  setResume({ dreamId: next.id, time })
  setDream(next)
  setSwapPhase('loading')
}
