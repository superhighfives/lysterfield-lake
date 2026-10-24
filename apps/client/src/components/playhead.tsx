import {
  CSSProperties,
  forwardRef,
  HTMLProps,
  MutableRefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useStore } from '../store'
import {
  Play,
  Pause,
  SpeakerSimpleX,
  SpeakerSimpleNone,
  SpeakerSimpleLow,
  SpeakerSimpleHigh,
  Crosshair,
} from '@phosphor-icons/react'
import Tooltip from '../views/tooltip'
import { dreamFromLocation , HistoryState, urlFor } from '../utils/use-history-sync'

import {
  MediaController,
  MediaPlayButton,
  MediaMuteButton,
  MediaTimeDisplay,
  MediaTimeRange,
} from 'media-chrome/react'
import Footer from '../views/footer'
import { connectAudio } from '../utils/audio'
import {
  followMain,
  isSplit,
  mainVideoBase,
  shownDream,
  startDream,
  stopDreams,
  switchDream,
  warmDream,
} from '../utils/dream-video'
import { adjacentDream, fadeInAudio, fadeOutAudio } from '../utils/swap-dream'

// If the dream video still isn't ready this long after asking — the first
// one, or a switch — carry on anyway: play the main video (the polaroid
// shows its last frame, or nothing, until the dream catches up), or bring
// a swapped polaroid back.
const DREAM_READY_TIMEOUT_MS = 8000
// The song fades out going back to the choose screen (over about as long as
// the scene takes to close), and back in as a dream starts.
const AUDIO_HOME_FADE_MS = 900
const AUDIO_START_FADE_MS = 400
// How long a new dream's name and prompt show without hovering.
const ANNOUNCE_MS = 3000

const Playhead = forwardRef<HTMLVideoElement, HTMLProps<HTMLVideoElement>>(
  (_props, ref) => {
    const dream = useStore((state) => state.dream)
    const showPlayhead = useStore((state) => state.showPlayhead)
    const swapping = useStore(
      (state) => state.swapPhase === 'out' || state.swapPhase === 'loading'
    )
    const videoPlaying = useStore((state) => state.videoPlaying)
    const isMobile = useStore((state) => state.isMobile)
    const isTouch = useStore((state) => state.isTouch)
    const [recalibrateMobile, setRecalibrateMobile] = useState(false)
    // The dream's name and prompt show while the pointer's over the
    // controls, and for a moment (ANNOUNCE_MS) whenever the dream changes
    // — on touch too, where showing it throughout covered the lyrics.
    const [pillHovered, setPillHovered] = useState(false)
    const [announcing, setAnnouncing] = useState(false)
    // The controls and the name wait for the loading pile to leave
    // (components/loading.tsx), rather than showing over it.
    const pileLeaving = useStore((state) => state.pileLeaving)
    // Where the name comes in from (px, sideways): after a swap, the side
    // the polaroid was dragged away from, following the new one in
    // (dragging left is direction 1, so it comes in from the right); a
    // dream chosen any other way, nowhere (it just fades in). Read as the
    // dream changes, mid-swap, and used when it's announced (below), which
    // restarts the entrance (announceKey) so it's seen, not over while
    // the name was still hidden.
    const swapEntrance = useRef(0)
    useEffect(() => {
      const { swapPhase, swapDirection } = useStore.getState()
      swapEntrance.current = swapPhase === 'idle' ? 0 : swapDirection * 24
    }, [dream])
    const [enterFrom, setEnterFrom] = useState(0)
    const [announceKey, setAnnounceKey] = useState(0)
    // Arriving straight at a dream (its URL), its name isn't announced:
    // the title screen and the loading polaroid have already shown it.
    const arrivedAt = useRef(dreamFromLocation()?.id ?? null)
    // Counted from when the swap's done, since it's hidden until then.
    useEffect(() => {
      if (!dream || swapping || !pileLeaving) return
      if (dream.id === arrivedAt.current) {
        arrivedAt.current = null
        return
      }

      arrivedAt.current = null
      setEnterFrom(swapEntrance.current)
      setAnnounceKey((key) => key + 1)
      setAnnouncing(true)
      const timeout = setTimeout(() => setAnnouncing(false), ANNOUNCE_MS)
      return () => clearTimeout(timeout)
    }, [dream, swapping, pileLeaving])
    // For the mute button's label.
    const [muted, setMuted] = useState(false)

    const setResetInitialRotation = useStore(
      (state) => state.setResetInitialRotation
    )
    const polaroidPillVisible = useStore(
      (state) => state.polaroidPillVisible && state.pileLeaving
    )
    const setResetting = useStore((state) => state.setResetting)
    const setSeeking = useStore((state) => state.setSeeking)
    const setVideoPlaying = useStore((state) => state.setVideoPlaying)
    const setVideoState = useStore((state) => state.setVideoState)
    const setResume = useStore((state) => state.setResume)

    // The main video's source. Split (utils/dream-video.ts), it's the same
    // shared video for every dream, so it's loaded once on the way into the
    // player and a dream change mid-song doesn't touch it (see the switch
    // effect below); otherwise it's each dream's own 7-panel video.
    const mainBase = mainVideoBase(dream, isMobile || isTouch)
    const loadedDream = useRef<string | null>(null)

    // load() and play() live in this one effect, in that order. They used to
    // be two separate `[dream]` effects in two components (this one and
    // views/main.tsx) with nothing ordering them — when load() landed after
    // play(), it aborted the pending play, the rejection went unobserved,
    // and the video sat paused on its first frame.
    useEffect(() => {
      const el = (ref as MutableRefObject<HTMLVideoElement>).current
      el.load()
      loadedDream.current = dream?.id ?? null
      if (!dream) {
        stopDreams()
        return
      }

      connectAudio(el)
      // Back up, after the fade out going back to the choose screen (below).
      // Not mid-swap: a swap that reloads the video (one that isn't split)
      // fades back in itself, once the new dream's playing (commitSwap).
      if (useStore.getState().swapPhase === 'idle')
        fadeInAudio(el, AUDIO_START_FADE_MS)

      let cancelled = false

      // Set when restoring from browser history — seek there as soon as
      // the new source's duration is known. Only cleared once the seek
      // actually happens, so StrictMode's double-run doesn't drop it.
      const resume = useStore.getState().resume
      const resumeTime = resume?.dreamId === dream.id ? resume.time : null
      // Split, the dream video loads alongside, from the same time, and the
      // main video waits for it — so the polaroid doesn't come in blank.
      // If its video won't load, there's no dream to fall back to: back
      // to the choose screen, as the home button does.
      let failed = false
      const dreamReady = isSplit(dream)
        ? Promise.race([
            // Then the next one warms behind it (the card peeking out).
            startDream(dream, resumeTime ?? 0).then((ok) => {
              if (ok) return warmDream(adjacentDream(1))
              failed = true
              if (!cancelled) useStore.getState().setResetting(true)
            }),
            new Promise((resolve) => setTimeout(resolve, DREAM_READY_TIMEOUT_MS)),
          ])
        : Promise.resolve()
      const seek = () => {
        if (resumeTime !== null && resumeTime < el.duration) {
          el.currentTime = resumeTime
        }

        setResume(null)
      }

      if (resumeTime !== null) {
        el.addEventListener('loadedmetadata', seek, { once: true })
      }

      const play = (retry: boolean) =>
        el.play().catch((error: DOMException) => {
          if (cancelled) return
          // An AbortError means something reset the element mid-load; try
          // once more when it's next ready rather than leaving it stuck.
          // Anything else (e.g. the browser's autoplay policy refusing
          // unmuted playback) won't change on a retry — the play button is
          // still there.
          if (retry && error.name === 'AbortError') {
            el.addEventListener('canplay', () => !cancelled && play(false), {
              once: true,
            })
          } else {
            console.warn(`Playback didn't start: ${error.name}`)
          }
        })
      // Arriving straight at a dream (its URL), the song waits for the
      // loading pile to start leaving, rather than starting under it.
      let stopWaiting = () => {}

      const pileLeft = new Promise<void>((resolve) => {
        if (useStore.getState().pileLeaving) return resolve()
        stopWaiting = useStore.subscribe((state) => {
          if (!state.pileLeaving) return
          stopWaiting()
          resolve()
        })
      })
      Promise.all([dreamReady, pileLeft]).then(() => {
        if (!cancelled && !failed) play(true)
      })

      return () => {
        cancelled = true
        stopWaiting()
        el.removeEventListener('loadedmetadata', seek)
      }
      // Reloads only for a new main source; a dream change on the same one
      // is the switch below.
    }, [mainBase])

    // A dream change on the same main video (split): a swap, or back/forward
    // to another dream. Only the dream video changes: the next one loads at
    // the song's time — or, from history, at its saved time, which the main
    // video seeks to — and the polaroid crossfades to it. A swap waiting on
    // it moves on once it's there.
    useEffect(() => {
      const el = (ref as MutableRefObject<HTMLVideoElement>).current
      if (!dream || !isSplit(dream) || loadedDream.current === dream.id) return
      // The main video's own load (above) handles a fresh one.
      if (loadedDream.current === null) return
      loadedDream.current = dream.id
      // What to fall back on if this one won't load: the dream actually on
      // the polaroid (not one swapped past while it loaded), if any.
      const shown = shownDream()

      const { resume, setResume } = useStore.getState()
      let time = el.currentTime
      if (resume?.dreamId === dream.id) {
        time = resume.time
        if (time < el.duration) el.currentTime = time
        setResume(null)
      }

      let done = false
      const finish = () => {
        if (done) return
        done = true
        const { swapPhase, setSwapPhase } = useStore.getState()
        if (swapPhase === 'loading') setSwapPhase('in')
      }

      switchDream(dream, time).then((result) => {
        if (result === 'superseded') return
        // Its video wouldn't load: the polaroid never left the last dream
        // (still playing in sync), so the swap lands back on it.
        if (result === 'failed') {
          const { collection, setDream, setResetting, setSwapPhase } =
            useStore.getState()
          const fallback = collection.find((item) => item.id === shown)
          // Nothing's shown yet (the first dream was swapped past): there's
          // nothing to go back to, so back to the choose screen.
          if (!fallback) {
            setSwapPhase('idle')
            return setResetting(true)
          }

          loadedDream.current = fallback.id
          history.replaceState(
            { dream: fallback.id, t: el.currentTime } satisfies HistoryState,
            '',
            urlFor(fallback.id)
          )
          setDream(fallback)
          return finish()
        }

        finish()
        // The next one along, the way this swap went, warms behind.
        warmDream(adjacentDream(useStore.getState().swapDirection))
      })
      const timeout = setTimeout(finish, DREAM_READY_TIMEOUT_MS)
      return () => clearTimeout(timeout)
    }, [dream, ref])

    useEffect(() => {
      const el = (ref as MutableRefObject<HTMLVideoElement>).current
      const handleVolume = () => setMuted(el.muted)
      handleVolume()
      el.addEventListener('volumechange', handleVolume)
      return () => el.removeEventListener('volumechange', handleVolume)
    }, [ref])

    const resetting = useStore((state) => state.resetting)
    useEffect(() => {
      if (!resetting) return
      fadeOutAudio(
        (ref as MutableRefObject<HTMLVideoElement>).current,
        AUDIO_HOME_FADE_MS
      )
    }, [resetting, ref])

    // The dream videos follow the main video's clock.
    useEffect(() => {
      const el = (ref as MutableRefObject<HTMLVideoElement>).current
      return followMain(el)
    }, [ref])

    // Syncs native <video> playback state into the store directly, rather
    // than through whichever library renders the visible controls — this
    // logic used to depend on @react-av's hooks; the native events it wraps
    // are the same ones every browser already fires, so reading them
    // directly means a future controls-library swap won't touch this again.
    useEffect(() => {
      const el = (ref as MutableRefObject<HTMLVideoElement>).current
      if (!el) return

      const updateReadyState = () => setVideoState(el.readyState)
      const handlePlaying = () => setVideoPlaying(true)
      const handlePause = () => setVideoPlaying(false)
      const handleEnded = () => setResetting(true)
      const handleSeeking = () => setSeeking(true)
      const handleSeeked = () => setSeeking(false)

      const readyStateEvents = [
        'loadedmetadata',
        'loadeddata',
        'canplay',
        'canplaythrough',
        'waiting',
        'stalled',
        'emptied',
      ]
      readyStateEvents.forEach((event) =>
        el.addEventListener(event, updateReadyState)
      )
      el.addEventListener('playing', handlePlaying)
      el.addEventListener('pause', handlePause)
      el.addEventListener('ended', handleEnded)
      el.addEventListener('seeking', handleSeeking)
      el.addEventListener('seeked', handleSeeked)

      updateReadyState()

      return () => {
        readyStateEvents.forEach((event) =>
          el.removeEventListener(event, updateReadyState)
        )
        el.removeEventListener('playing', handlePlaying)
        el.removeEventListener('pause', handlePause)
        el.removeEventListener('ended', handleEnded)
        el.removeEventListener('seeking', handleSeeking)
        el.removeEventListener('seeked', handleSeeked)
      }
    }, [])

    const recalibrateTimeout = useRef<ReturnType<typeof setTimeout> | null>(
      null
    )

    // Watches only `globalPointer` via a direct store subscription instead
    // of `useStore((state) => state.globalPointer)` — that field updates
    // every animation frame (see main.tsx), and a reactive subscription to
    // it re-rendered this entire control bar 60x/sec for a check that only
    // ever changes outcome a few times per session.
    useEffect(() => {
      const unsubscribe = useStore.subscribe((state, prevState) => {
        if (state.globalPointer === prevState.globalPointer) return
        const globalPointer = state.globalPointer

        const offCenter =
          globalPointer.x <= 0.33 ||
          globalPointer.x >= 1.67 ||
          globalPointer.y <= 0.33 ||
          globalPointer.y >= 1.67

        if (offCenter && isMobile) {
          if (!recalibrateMobile && !recalibrateTimeout.current) {
            recalibrateTimeout.current = setTimeout(
              () => setRecalibrateMobile(true),
              3000
            )
          }
        } else {
          if (recalibrateTimeout.current) {
            clearTimeout(recalibrateTimeout.current)
            recalibrateTimeout.current = null
          }

          if (recalibrateMobile) {
            setRecalibrateMobile(false)
          }
        }
      })
      return unsubscribe
    }, [isMobile, recalibrateMobile])

    return (
      <>
        <div
          className={`fixed z-10 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`}
        >
          <button
            className={`whitespace-nowrap fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-1 rounded-md px-4 py-2 bg-yellow-400 text-stone-900 active:bg-black active:text-white flex items-center gap-2 shadow-xl transition-opacity duration-500 ${
              showPlayhead && recalibrateMobile && polaroidPillVisible
                ? ''
                : 'pointer-events-none opacity-0'
            }`}
            onClick={() => setResetInitialRotation(true)}
          >
            <Crosshair className="inline" />
            <span className="font-serif text-lg">Recentre the view</span>
          </button>
        </div>
        {/* The dream's name and prompt, while the controls are hovered or
            for a moment when the dream changes: at the top, under the
            header and clear of a phone's status bar, where it isn't over
            the lyrics (scene.tsx's PLAYER_HEADER keeps the polaroid below
            it). Fades out as a swap starts, and in again (keyed on the
            dream) with the new one. */}
        <div
          aria-live="polite"
          className={`fixed z-10 left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+3rem)] w-[calc(100vw-2rem)] flex flex-col items-center text-center pointer-events-none transition-opacity duration-300 ${
            showPlayhead &&
            polaroidPillVisible &&
            dream &&
            !swapping &&
            (pillHovered || announcing)
              ? 'opacity-100'
              : 'opacity-0'
          }`}
        >
          {dream ? (
            <div
              key={`${dream.id}-${announceKey}`}
              className="animate-slide-in flex flex-col items-center"
              style={{ '--from': `${enterFrom}px` } as CSSProperties}
            >
              <span className="font-serif italic text-xl text-stone-900 dark:text-stone-100">
                {dream.title}
              </span>
              {dream.prompt ? (
                <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                  &ldquo;{dream.prompt}&rdquo;
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          data-playhead
          className={`fixed z-10 ${
            isTouch
              ? 'bottom-[max(0.75rem,env(safe-area-inset-bottom))]'
              : 'bottom-10'
          } left-1/2 -translate-x-1/2 w-[calc(100vw-4rem)] max-w-[400px] h-[104px] xs:h-[34px] bg-white text-stone-900 dark:bg-stone-900 dark:text-stone-100 border border-yellow-400 rounded-lg xs:rounded-full shadow-xl transition-opacity xs:[--media-control-padding:4px] ${
            showPlayhead && polaroidPillVisible
              ? ''
              : 'pointer-events-none opacity-0'
          }`}
          onPointerEnter={() => setPillHovered(true)}
          onPointerLeave={() => setPillHovered(false)}
          // media-chrome renders our unslotted controls div (see below)
          // inside an internal `part="vertical-layer"` span that it makes
          // `position: absolute; inset: 0` by default — built for
          // overlaying controls on a visible video. Since MediaController
          // is `display: contents` here, that span's containing block is
          // this pill, and being out of flow it contributed nothing to a
          // shrink-to-fit size — the pill collapsed to its 2px border with
          // the real controls floating outside it. Giving the pill this
          // explicit size (rather than fighting the internal layer's own
          // positioning via ::part(), which got the sizing right but broke
          // the icons' actual paint) gives that absolutely-positioned layer
          // a real box to fill, matching the two-row (stacked, below the
          // `xs` breakpoint) vs one-row content heights.
          // Unlike @react-av, media-chrome isn't headless — every control
          // ships its own dark, semi-opaque default skin (rgb(20 20 30 /
          // .7) background, near-white text/icon color) baked into its
          // shadow DOM via --media-control-background/--media-text-color
          // etc. Our Tailwind classes on these elements only style the
          // light-DOM host (e.g. hover:bg-yellow-200), so without this the
          // default skin's resting-state background/color still show
          // through as a scattered row of dark boxes instead of this pill's
          // white/yellow design. These custom properties are media-chrome's
          // documented styling hook and inherit through the shadow
          // boundary into every descendant control in one place.
          style={
            {
              '--media-control-background': 'transparent',
              '--media-control-hover-background': 'transparent',
              '--media-text-color': 'currentColor',
              '--media-primary-color': 'currentColor',
              // media-chrome-button's shadow CSS sets icon width from this
              // variable with no fallback (unlike icon-height, which falls
              // back to 24px) — left unset, the icons rendered a real
              // height but a 0 width, making them invisible.
              '--media-button-icon-width': '24px',
            } as CSSProperties
          }
        >
          <MediaController className="contents" autohide="-1">
            {/* media-chrome auto-hides every non-media/poster slotted
                control after `autohide` seconds (default 2) of pointer
                inactivity during playback — built for overlaying
                controls on top of the video itself. Ours is a persistent
                control bar below the video, not an overlay, so it should
                never fade out on its own. This is what caused the pill
                to render fully blank (all its controls at opacity 0) a
                couple of seconds into playback whenever the pointer
                stopped moving.
                `autohide={-1}` (not `noAutohide`) is the real fix:
                `noAutohide` is a CSS-only opt-out matched via
                `::slotted(...):not([noautohide])` against each
                INDIVIDUAL slotted control's own attribute — setting it
                on MediaController itself matches nothing and does
                nothing. `autohide` is the actual JS-level switch
                (`#scheduleInactive`/`#setInactive` both bail out when
                it's negative), so it's the one that stops the
                `userinactive` host attribute from ever being set, which
                every opacity-hiding CSS rule is gated on anyway. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- generated video has no dialogue/caption track to provide */}
            <video
              slot="media"
              ref={ref}
              muted={
                location.hostname === 'localhost' ||
                location.hostname === '127.0.0.1'
              }
              className="hidden"
              preload="auto"
              playsInline
              crossOrigin="anonymous"
            >
              <source
                src={`${mainBase}.webm`}
                type="video/webm"
                key={`${mainBase}-webm`}
              />
              {/* H.264 for browsers without VP9 (Safari): `.mp4` for the
                  split layout's shared main video, which Cloudflare's edge
                  caches (it doesn't cache `.mov`); the 7-panel files only
                  have `.mov`. */}
              <source
                src={`${mainBase}.${isSplit(dream) ? 'mp4' : 'mov'}`}
                type="video/mp4"
                key={`${mainBase}-h264`}
              />
            </video>
            {/* `noautohide` on this, the one slotted control element: even
                with autohide="-1", media-chrome sets `userinactive` on the
                controller when it connects and only clears it on the first
                pointer move — so the pill rendered empty until the mouse
                moved, which a URL/history restore (land on the player,
                having only clicked the welcome button) made likely. Its
                hiding CSS skips slotted controls carrying `noautohide`. Set
                via ref: it's not a React-known DOM attribute. */}
            <div
              ref={(el) => el?.setAttribute('noautohide', '')}
              className="flex flex-col xs:flex-row w-full h-full xs:space-x-3 items-center"
            >
              <div className="flex flex-1 xs:flex-none self-stretch items-stretch justify-evenly xs:justify-center border-b xs:border-r xs:border-b-0 border-yellow-500">
                <Footer />
                <div className="group flex relative">
                  <MediaMuteButton className="transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1">
                    {/*
                      media-chrome-button's shadow CSS sizes slotted icons
                      via `width: var(--media-button-icon-width)` plus
                      `min-width/max-width: 100%` against the icon's real
                      (post-`display:contents`-unwrapping) flex container —
                      a percentage constraint that resolves to 0 for
                      whichever icon is actually the visible one, even
                      though --media-button-icon-width itself is set.
                      `!important` on width alone doesn't help: min/max-width
                      still clamp whatever width value it's applied to, so
                      those need overriding too, not just width itself.
                    */}
                    <SpeakerSimpleX
                      slot="off"
                      className="!w-5 !h-5 xs:!w-4 xs:!h-4 !max-w-none !min-w-0"
                    />
                    <SpeakerSimpleLow
                      slot="low"
                      className="!w-5 !h-5 xs:!w-4 xs:!h-4 !max-w-none !min-w-0"
                    />
                    <SpeakerSimpleNone
                      slot="medium"
                      className="!w-5 !h-5 xs:!w-4 xs:!h-4 !max-w-none !min-w-0"
                    />
                    <SpeakerSimpleHigh
                      slot="high"
                      className="!w-5 !h-5 xs:!w-4 xs:!h-4 !max-w-none !min-w-0"
                    />
                  </MediaMuteButton>
                  <Tooltip text={muted ? 'Unmute' : 'Mute'} />
                </div>
                <div className="group flex relative">
                  <MediaPlayButton className="transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:pr-3 xs:py-1">
                    <Play
                      slot="play"
                      className="!w-5 !h-5 xs:!w-4 xs:!h-4 !max-w-none !min-w-0"
                    />
                    <Pause
                      slot="pause"
                      className="!w-5 !h-5 xs:!w-4 xs:!h-4 !max-w-none !min-w-0"
                    />
                  </MediaPlayButton>
                  <Tooltip text={videoPlaying ? 'Pause' : 'Play'} />
                </div>
              </div>
              <div className="flex flex-1 w-full xs:w-auto min-w-0 gap-2 items-center pl-3.5 xs:pl-0 pr-2 xs:pr-4 py-0 xs:py-1">
                <MediaTimeDisplay className="font-mono text-xs [--media-control-padding:4px]" />
                <MediaTimeRange
                  className="grow min-w-0 h-4
                    [&::part(track)]:bg-slate-300/40 dark:[&::part(track)]:bg-stone-600/40 [&::part(track)]:rounded-full [&::part(track)]:h-2
                    [&::part(buffered)]:bg-slate-300/60 dark:[&::part(buffered)]:bg-stone-500/60 [&::part(buffered)]:rounded-full
                    [&::part(progress)]:bg-yellow-400 [&::part(progress)]:rounded-full
                    [&::part(thumb)]:bg-slate-50 dark:[&::part(thumb)]:bg-stone-900 [&::part(thumb)]:border [&::part(thumb)]:border-solid [&::part(thumb)]:border-yellow-500 [&::part(thumb)]:w-4 [&::part(thumb)]:h-4 [&::part(thumb)]:rounded-full"
                  // The time under the pointer shows in the cursor's label
                  // (components/cursor.tsx), as every control's name does,
                  // so media-chrome's own preview box is hidden.
                  style={{ '--media-preview-box-display': 'none' } as CSSProperties}
                />
              </div>
            </div>
          </MediaController>
        </div>
      </>
    )
  }
)

Playhead.displayName = 'Playhead'

export default Playhead
