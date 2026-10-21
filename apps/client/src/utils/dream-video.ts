import { useStore } from '../store'
import type { Dream } from './types'

// The split video (plans/in-progress/split-dream-video-client.md): one shared
// main video — panels 1-6 and the song, the same for every dream — and a
// small, silent video of the dream itself (panel 7). The main video is
// Playhead's <video>; it plays, keeps the audio and drives everything. The
// dream video only follows it. Switching dreams swaps only the dream
// video, so the song, the avatar and the lyrics never stop.
//
// There are two dream videos: the front one, on the polaroid, and the back
// one, kept warm with the dream a swap would bring next — playing along in
// sync, on the polaroid peeking out from behind (views/main.tsx). A swap
// brings that card forward, and since its video's already there, the
// switch is instant. Then the back slot warms the next neighbour. A
// switch to a dream that isn't warm (back/forward) loads it into the back
// slot first, and the polaroid crossfades to it (`mix`).

/** The split layout, unless `?split=0` asks for the 7-panel one — the
 *  fallback while it's checked on real devices. Dev previews of a take
 *  (`dream.src`) only have 7-panel files. */
const SPLIT_ENABLED = new URLSearchParams(location.search).get('split') !== '0'
export const isSplit = (dream: Dream | null) =>
  SPLIT_ENABLED && !!dream && !dream.src

const dreamsUrl = import.meta.env.VITE_APP_DREAMS
const small = () => {
  const { isMobile, isTouch } = useStore.getState()
  return isMobile || isTouch ? '-small' : ''
}

/** The main video's URL, without its extension: the shared main video in
 *  the split layout, or the dream's own 7-panel video — half size on
 *  `smallVideo` devices (mobile and touch). */
export function mainVideoBase(dream: Dream | null, smallVideo: boolean) {
  if (!dream) return 'video/title'
  const suffix = smallVideo ? '-small' : ''
  if (isSplit(dream)) return `${dreamsUrl}/main/main${suffix}`
  return `${dream.src ?? `${dreamsUrl}/${dream.id}`}/video${suffix}`
}

// Drift between the two clocks (s): under IN_SYNC it's left alone; up to
// NUDGE_LIMIT the dream video's playback rate is nudged by NUDGE until
// it's back (seeking is slow, on iOS especially); beyond it, it's seeked.
// A seek aims ahead by however long the video's last seek took (at least
// SEEK_LEAD, at most SEEK_LEAD_MAX), so a slow one doesn't land behind and
// seek again, and again.
const IN_SYNC = 1 / 24
const NUDGE_LIMIT = 0.25
const NUDGE = 0.05
const SEEK_LEAD = 0.1
const SEEK_LEAD_MAX = 2
// The crossfade from one dream to the next, in seconds.
const CROSSFADE_SECONDS = 0.4
// A dream video still seeking after this long is reloaded and sought
// again, once: a seek can wedge (seeking, its network idle) when it's
// interrupted before the video has any frames.
const STUCK_SEEK_MS = 4000
// How long before a dream video that errored is tried once more.
const ERROR_RETRY_MS = 600

function createDreamElement() {
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.crossOrigin = 'anonymous'
  el.preload = 'auto'
  el.setAttribute('playsinline', '')
  el.setAttribute('aria-hidden', 'true')
  // In the document, though unseen: some browsers (iOS) won't decode a
  // detached video's frames.
  Object.assign(el.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    left: '0',
    top: '0',
  })
  document.body.appendChild(el)
  return el
}

const webm = document.createElement('video').canPlayType('video/webm; codecs="vp9"')
const extension = webm ? 'webm' : 'mov'

type Slot = {
  el: HTMLVideoElement
  /** The dream this slot holds, or null when it's empty. */
  id: string | null
  ready: Promise<void> | null
  /** Loaded, sought and playing along — or failed. */
  settled: boolean
  /** Its video wouldn't load (missing, say). */
  failed: boolean
  /** Resolves the pending `ready`: called when another dream takes the
   *  slot before this one's ready, so nothing waits on it for good. */
  release: (() => void) | null
  /** How far ahead (s) a seek aims: the last seek's duration. */
  lead: number
}

/** Seeks a slot to just ahead of `time` (by its measured lead), learning
 *  how long this seek takes for the next. */
function seekSlot(slot: Slot, time: number) {
  const el = slot.el
  const started = performance.now()
  el.addEventListener(
    'seeked',
    () => {
      const took = (performance.now() - started) / 1000
      slot.lead = Math.min(Math.max(took * 1.1, SEEK_LEAD), SEEK_LEAD_MAX)
    },
    { once: true }
  )
  // Paused (scrubbing), it can land exactly; playing, it aims ahead.
  const playing = !!dreamVideo.main && !dreamVideo.main.paused
  el.currentTime = Math.min(time + (playing ? slot.lead : 0), el.duration || Infinity)
}

export const dreamVideo = {
  slots: [] as Slot[],
  /** Which slot is showing: 0 or 1. */
  front: 0,
  /** The shown blend, 0 (slot 0) to 1 (slot 1), eased toward `front`. */
  mix: 0,
  main: null as HTMLVideoElement | null,
}

function slots() {
  if (!dreamVideo.slots.length)
    dreamVideo.slots = [0, 1].map(() => ({
      el: createDreamElement(),
      id: null,
      ready: null,
      settled: false,
      failed: false,
      release: null,
      lead: SEEK_LEAD,
    }))
  return dreamVideo.slots
}

/** The two dream elements, for their textures. */
export const dreamElements = () => slots().map((slot) => slot.el)

function empty(slot: Slot) {
  slot.release?.()
  slot.release = null
  slot.el.pause()
  slot.el.removeAttribute('src')
  slot.el.load()
  slot.id = null
  slot.ready = null
  slot.settled = false
  slot.failed = false
}

/** Loads a dream into a slot and brings it to `time` (or wherever the main
 *  video is by then); resolves once it's there and can play. */
function load(slot: Slot, dream: Dream, time: number) {
  // A failed one loads afresh: whatever stopped it may have passed.
  if (slot.id === dream.id && slot.ready && !slot.failed) return slot.ready
  // Whatever was loading here is dropped (a new src cancels its download).
  slot.release?.()
  slot.id = dream.id
  slot.settled = false
  slot.failed = false
  const el = slot.el
  el.src = `${dreamsUrl}/${dream.id}/dream${small()}.${extension}`
  el.load()
  slot.ready = new Promise<void>((done) => {
    const resolve = () => {
      if (slot.release === resolve) slot.release = null
      done()
    }

    slot.release = resolve
    let retried = false
    const watchdog = () =>
      window.setTimeout(() => {
        if (slot.id !== dream.id || !el.seeking || retried) return
        retried = true
        el.load()
        el.addEventListener('loadedmetadata', settle, { once: true })
      }, STUCK_SEEK_MS)
    const settle = () => {
      watchdog()
      const main = dreamVideo.main
      if (main && !main.paused) seekSlot(slot, main.currentTime)
      else el.currentTime = Math.min(main ? main.currentTime : time, el.duration || Infinity)
      el.addEventListener(
        'seeked',
        () => {
          if (slot.id !== dream.id) return
          // Rejections here are autoplay/abort ones, expected while the
          // dream switches; `sync` calls play() again each frame.
          if (dreamVideo.main && !dreamVideo.main.paused)
            el.play().catch(() => {})
          slot.settled = true
          resolve()
        },
        { once: true }
      )
    }

    // A dream that won't load (missing, say) mustn't leave the player
    // waiting on it for good: it settles as failed, and whoever asked for
    // it decides what to show instead.
    // A decode error can be passing (a phone's decoders all in use for a
    // moment), so the first gets one more go after ERROR_RETRY_MS; a
    // second is final.
    let erred = false
    const handleError = () => {
      if (slot.id !== dream.id) return
      if (!erred) {
        erred = true
        console.warn(`Dream video for ${dream.id} failed; trying again`, el.error)
        window.setTimeout(() => {
          if (slot.id !== dream.id) return
          el.addEventListener('error', handleError, { once: true })
          el.addEventListener('loadedmetadata', settle, { once: true })
          el.load()
        }, ERROR_RETRY_MS)
        return
      }

      console.warn(`Dream video for ${dream.id} failed to load`, el.error)
      slot.failed = true
      slot.settled = true
      resolve()
    }

    el.addEventListener('error', handleError, { once: true })

    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) settle()
    else el.addEventListener('loadedmetadata', settle, { once: true })
  })
  return slot.ready
}

/** The first dream after the choose screen (or a resume): loaded straight
 *  into the front slot, at `time`. Resolves once it's ready to play: true,
 *  or false if its video wouldn't load. */
export async function startDream(dream: Dream, time: number) {
  const [first, second] = slots()
  empty(second)
  dreamVideo.front = 0
  dreamVideo.mix = 0
  // Swapped away from while it loaded (see switchDream), it waits on
  // whichever dream took its place.
  let ready = load(first, dream, time)
  await ready
  while (first.ready && first.ready !== ready) {
    ready = first.ready
    await ready
  }

  return !first.failed
}

/** Switches to another dream mid-song: the back slot loads it at the main
 *  video's time (if it isn't already warm there), then it becomes the
 *  front. Resolves once it's showing ('shown'); if its video wouldn't
 *  load, the front's left as it was, still playing the last dream
 *  ('failed'); or a later switch took over while it loaded ('superseded'). */
export async function switchDream(dream: Dream, time: number) {
  const all = slots()
  const front = all[dreamVideo.front]
  if (front.id === dream.id) return 'shown'
  // The first dream still loading (swapped away from before it showed):
  // this one loads in its place.
  if (front.id && !front.settled) {
    // Not twice: the swap may have warmed it behind already.
    const back = all[1 - dreamVideo.front]
    if (back.id === dream.id) empty(back)
    await load(front, dream, time)
    if (front.id !== dream.id) return 'superseded'
    return front.failed ? 'failed' : 'shown'
  }

  const back = 1 - dreamVideo.front
  await load(all[back], dream, time)
  if (all[back].id !== dream.id) return 'superseded'
  if (all[back].failed) {
    empty(all[back])
    return 'failed'
  }

  dreamVideo.front = back
  return 'shown'
}

/** Warms a dream in the back slot — the one a swap would bring next —
 *  playing along in sync, ready to come to the front. */
export function warmDream(dream: Dream | undefined) {
  if (!dream) return
  const all = slots()
  if (all[dreamVideo.front].id === dream.id) return
  const back = all[1 - dreamVideo.front]
  const main = dreamVideo.main
  load(back, dream, main ? main.currentTime : 0)
}

/** The dream actually on the polaroid: the front slot's, once it's
 *  loaded and playing along (not one still loading, or one that failed). */
export function shownDream() {
  const front = slots()[dreamVideo.front]
  return front.settled && !front.failed ? front.id : null
}

/** Whether the dream on show is ready: loaded, sought and playing along. */
export const frontReady = () => {
  const front = slots()[dreamVideo.front]
  return !!front.id && front.settled
}

/** Whether the player's waiting on video — the first dream's still
 *  loading, or a swap is under way. Written each frame by views/main.tsx,
 *  read by the cursor (components/cursor.tsx). */
export const playback = { waiting: false }

/** The dream warm in the back slot, and whether it's ready to show. */
export function backSlot() {
  const back = slots()[1 - dreamVideo.front]
  return { id: back.id, settled: back.settled }
}

/** Stops and empties both dream videos (back to the choose screen). */
export function stopDreams() {
  slots().forEach(empty)
  dreamVideo.front = 0
  dreamVideo.mix = 0
}

/** Eases the crossfade toward the front slot. Call every frame. */
export function stepCrossfade(delta: number) {
  const target = dreamVideo.front
  const step = delta / CROSSFADE_SECONDS
  dreamVideo.mix =
    target > dreamVideo.mix
      ? Math.min(target, dreamVideo.mix + step)
      : Math.max(target, dreamVideo.mix - step)
}

/** Jumps the crossfade straight to the front slot — mid-swap the card
 *  coming forward already shows the new dream, so there's nothing to fade
 *  between. */
export function snapCrossfade() {
  dreamVideo.mix = dreamVideo.front
}

/** Keeps the dream videos on the main video's clock: mirrors play, pause,
 *  seeks and rate, and nudges or seeks back any drift. Returns a cleanup. */
export function followMain(main: HTMLVideoElement) {
  dreamVideo.main = main
  const active = () => slots().filter((slot) => slot.id)

  // Autoplay/abort rejections are expected; `sync` retries each frame.
  const handlePlay = () =>
    active().forEach((slot) => slot.el.play().catch(() => {}))
  const handlePause = () => active().forEach((slot) => slot.el.pause())
  // Only slots already playing along: one still loading seeks to wherever
  // the main video is once it's ready, and seeking it again mid-load can
  // wedge it.
  const handleSeek = () =>
    active()
      .filter((slot) => !slot.el.seeking && slot.el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
      .forEach((slot) => seekSlot(slot, main.currentTime))

  main.addEventListener('play', handlePlay)
  main.addEventListener('pause', handlePause)
  main.addEventListener('seeked', handleSeek)

  let frame = 0
  const sync = () => {
    frame = requestAnimationFrame(sync)
    for (const slot of active()) {
      const el = slot.el
      // Still loading or seeking: leave it be.
      if (el.readyState < HTMLMediaElement.HAVE_METADATA || el.seeking) continue
      if (main.paused) {
        if (!el.paused) el.pause()
        continue
      }

      // A stall (`waiting`) on the dream video leaves the main video
      // playing; the polaroid holds its last frame until this catches up.
      // (A rejected play() is retried next frame, so it's ignored here.)
      if (el.paused && el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA)
        el.play().catch(() => {})
      const drift = el.currentTime - main.currentTime
      const rate = main.playbackRate
      if (Math.abs(drift) > NUDGE_LIMIT) {
        seekSlot(slot, main.currentTime)
        el.playbackRate = rate
      } else if (Math.abs(drift) > IN_SYNC) {
        el.playbackRate = rate * (drift > 0 ? 1 - NUDGE : 1 + NUDGE)
      } else if (el.playbackRate !== rate) {
        el.playbackRate = rate
      }
    }
  }

  frame = requestAnimationFrame(sync)
  return () => {
    cancelAnimationFrame(frame)
    main.removeEventListener('play', handlePlay)
    main.removeEventListener('pause', handlePause)
    main.removeEventListener('seeked', handleSeek)
    if (dreamVideo.main === main) dreamVideo.main = null
  }
}
