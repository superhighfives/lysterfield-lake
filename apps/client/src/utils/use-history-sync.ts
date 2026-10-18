import { RefObject, useEffect } from 'react'
import { useStore } from '../store'
import dreams from '../dreams.json'
import type { Dream } from './types'

// Browser back/forward support. There's no router — the selected dream is
// plain store state — so this mirrors it into the URL (`?dream=<id>`) and
// a history entry's state (`{ dream, t }`, `t` being the playback position),
// and restores from them on popstate and on a cold load. A cold load
// happens every time someone comes back from a same-tab link that left the
// app (/about, "Get the song", YouTube), so without this, back always
// landed on the welcome screen with the dream and position forgotten.

const PARAM = 'dream'
// How often (ms) the current playback position is written into the
// history entry. Safari throws if replaceState is called more than ~100
// times per 30s, so this is kept well under that.
const SAVE_INTERVAL = 1000

export type HistoryState = { dream: string; t: number } | null

export function dreamIdFromLocation() {
  return new URLSearchParams(location.search).get(PARAM)
}

export function urlFor(dreamId: string | null) {
  const url = new URL(location.href)
  if (dreamId) url.searchParams.set(PARAM, dreamId)
  else url.searchParams.delete(PARAM)
  return url.pathname + url.search + url.hash
}

function findDream(id: string | null) {
  const preview = previewDream()
  if (preview) return preview
  return id ? (dreams as Dream[]).find((dream) => dream.id === id) : undefined
}

/**
 * Dev only: `?preview=<job>/<take>` plays a take's 15s test clip from the
 * admin dev server (see vite-plugin-admin.ts) in the real player, without
 * it being in dreams.json.
 */
function previewDream(): Dream | undefined {
  if (!import.meta.env.DEV) return undefined
  const preview = new URLSearchParams(location.search).get('preview')
  const match = preview?.match(/^([\w-]+)\/([\w-]+)$/)
  if (!match) return undefined
  const [, job, take] = match
  return { id: `preview-${take}`, title: `Preview: ${take}`, link: '', prompt: '', src: `/__admin/files/${job}/7-dreams/${take}/preview` }
}

function savedTime(dreamId: string) {
  const state = history.state as HistoryState
  return state?.dream === dreamId ? state.t : null
}

/** Selects whichever dream the current URL names (resuming its saved
 *  playback position, if this history entry has one), or goes back to the
 *  choose screen if it names none. */
export function restoreFromLocation() {
  const { dream, resetting, setDream, setResetting, setResume } =
    useStore.getState()
  const id = dreamIdFromLocation()
  const target = findDream(id)

  if (id && !target) {
    // A stale or mistyped link — drop the param rather than leave a URL
    // that doesn't match what's showing.
    history.replaceState(null, '', urlFor(null))
  }

  if (!target) {
    if (dream && !resetting) setResetting(true)
    return
  }

  if (target.id === dream?.id) return
  const time = savedTime(target.id)
  setResume(time ? { dreamId: target.id, time } : null)
  setDream(target)
}

export function useHistorySync(video: RefObject<HTMLVideoElement | null>) {
  const ready = useStore((state) => state.ready)

  useEffect(() => {
    if (!ready) return

    // The URL is restored from once the player is up (it needs the
    // welcome screen's click first, for audio and orientation permission).
    restoreFromLocation()

    // Any dream change the URL doesn't already reflect is a fresh
    // navigation (choosing a card, "return to home", the video ending) and
    // gets its own history entry. Changes made by restoreFromLocation
    // already match the URL, so they don't push a duplicate.
    const unsubscribe = useStore.subscribe((state, prevState) => {
      if (state.dream === prevState.dream) return
      const id = state.dream?.id ?? null
      if (dreamIdFromLocation() === id) return
      history.pushState(id ? { dream: id, t: 0 } : null, '', urlFor(id))
    })

    window.addEventListener('popstate', restoreFromLocation)
    return () => {
      unsubscribe()
      window.removeEventListener('popstate', restoreFromLocation)
    }
  }, [ready])

  useEffect(() => {
    const el = video.current
    if (!ready || !el) return

    let lastSave = 0
    const savePosition = (force = false) => {
      const dream = useStore.getState().dream
      if (!dream || dreamIdFromLocation() !== dream.id) return
      const now = performance.now()
      if (!force && now - lastSave < SAVE_INTERVAL) return
      lastSave = now
      history.replaceState(
        { dream: dream.id, t: el.currentTime } satisfies HistoryState,
        '',
        location.href
      )
    }

    const handleTimeUpdate = () => savePosition()

    // A page restored from the back/forward cache comes back exactly as it
    // was left, except that browsers (Safari especially) pause media on the
    // way out — so resume, but only if it was actually playing.
    let wasPlaying = false
    const handlePageHide = () => {
      wasPlaying = !el.paused
      savePosition(true)
    }

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted && wasPlaying && el.paused) {
        el.play().catch((error: DOMException) => {
          console.warn(`Playback didn't resume: ${error.name}`)
        })
      }
    }

    el.addEventListener('timeupdate', handleTimeUpdate)
    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      el.removeEventListener('timeupdate', handleTimeUpdate)
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [ready])
}
