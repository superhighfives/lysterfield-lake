import { useStore } from '../store'
import { Canvas } from '@react-three/fiber'
import { Preload } from '@react-three/drei'
import { Suspense, useEffect, useRef, useState } from 'react'
import Loading from '../components/loading'
import Tooltip from '../views/tooltip'
import { youtubeLink } from '../utils/youtube'
import Fallback from '../components/fallback'
import Scene from '../components/scene'
import Playhead from '../components/playhead'
import Viewport from '../components/viewport'
import ThemeToggle from '../components/theme-toggle'
import KeyWhiteFilter from '../components/key-white-filter'
import { handleDeviceOrientationPermissions, isTouchDevice, shuffle } from '../utils'
import dreams from '../dreams.json'
import { Info, MusicNotes, CircleNotch } from '@phosphor-icons/react'
import { useHistorySync } from '../utils/use-history-sync'
import { useSwapInput } from '../utils/swap-gesture'
import { startAudio } from '../utils/audio'
import WaterVideo, { DIVE_MS, useWater } from '../components/water-video'
import Cursor from '../components/cursor'
import DebugOverlay from '../components/debug-overlay'

// How long buffering has to last before offering the YouTube escape hatch.
const TOO_SLOW_DELAY = 8000

// The header's links: icons like the theme toggle's, named by the cursor
// (views/tooltip.tsx).
const linkClassName = 'p-1.5 rounded transition-colors hover:bg-yellow-400/30'
const divider = <span aria-hidden className="w-px h-4 bg-current opacity-20" />

function Root() {
  const dream = useStore((state) => state.dream)
  const ready = useStore((state) => state.ready)
  const sceneLoaded = useStore((state) => state.sceneLoaded)
  const colorScheme = useStore((state) => state.colorScheme)
  const touchDevice = useStore((state) => state.isMobile || state.isTouch)
  const setCollection = useStore((state) => state.setCollection)
  const video = useRef<HTMLVideoElement>(null)
  const videoState = useStore((state) => state.videoState)
  const setIsMobile = useStore((state) => state.setIsMobile)
  const setIsTouch = useStore((state) => state.setIsTouch)
  const setReady = useStore((state) => state.setReady)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const isTooSlow = useStore((state) => state.isTooSlow)
  const setIsTooSlow = useStore((state) => state.setIsTooSlow)
  const seeking = useStore((state) => state.seeking)
  const showPlayhead = useStore((state) => state.showPlayhead)
  // The canvas's pixel ratio: the device's, capped (dprCap), and stepped
  // down further by the performance monitor on a machine that can't keep up.
  const dpr = useStore((state) =>
    Math.min(
      window.devicePixelRatio || 1,
      state.dprCap ?? 2,
      state.autoDpr ? state.dprAuto : Infinity
    )
  )
  const water = useWater()
  const [diving, setDiving] = useState(false)
  // Set on the first click, before the permission await, so a second click
  // (or Enter) during that await or the dive can't start it twice.
  const started = useRef(false)
  // A swap's load is covered by the polaroid's own animation (see
  // utils/swap-dream.ts), so it doesn't count as buffering.
  const swapLoading = useStore((state) => state.swapPhase === 'loading')

  useEffect(() => {
    console.log('Loaded!')
    // The newest dream is first in dreams.json and stays first (on top of
    // the stack); the rest are shuffled.
    const [newest, ...rest] = dreams
    setCollection([newest, ...shuffle(rest)])
    setHasLoaded(true)
  }, [])

  useEffect(() => {
    console.log(`Video state: ${videoState}`)
    if (dream && !swapLoading) {
      setIsBuffering(videoState < HTMLMediaElement.HAVE_FUTURE_DATA)
    } else {
      setIsBuffering(false)
    }
  }, [videoState, dream, swapLoading])

  // Each stretch of buffering gets its own timer, and isTooSlow clears as
  // soon as playback recovers — this used to be a counter in Scene's
  // useFrame that only ever counted up, so once a session had buffered for
  // 8s in total (across any number of short stalls) the YouTube link stayed
  // armed for every stall after, and before that the very first long stall
  // could be cut short by time already spent buffering earlier.
  useEffect(() => {
    if (!isBuffering) {
      setIsTooSlow(false)
      return
    }

    const timeout = setTimeout(() => setIsTooSlow(true), TOO_SLOW_DELAY)
    return () => clearTimeout(timeout)
  }, [isBuffering])

  useHistorySync(video)
  useSwapInput()

  const handleReady = async () => {
    if (started.current) return
    started.current = true
    // Inside the click, so Safari lets the audio context start.
    startAudio()
    const orientationGranted = (await handleDeviceOrientationPermissions()) as boolean
    const isTouch = isTouchDevice() as boolean
    // macOS Safari also implements DeviceOrientationEvent.requestPermission
    // (and auto-resolves it 'granted', with no real sensor or prompt behind
    // it) even though Macs have no orientation hardware — so the permission
    // signal alone can't tell a MacBook from an iPhone. Requiring isTouch
    // too rules that out, since a real touch-and-tilt phone satisfies both.
    const isMobile = orientationGranted && isTouch
    setIsMobile(isMobile)
    setIsTouch(isTouch)
    console.log(`Accelerometer: ${isMobile} | Touch: ${isTouch}`)
    // Dive into the lake first (see components/water-video.tsx): the
    // permission request and audio above had to happen inside the click,
    // but the scene can wait for the splash.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setReady(true)
      return
    }

    setDiving(true)
    water.current?.dive()
    window.setTimeout(() => setReady(true), DIVE_MS)
  }

  return (
    <>
      <KeyWhiteFilter />
      <Cursor />
      <DebugOverlay />
      {/* Three | one | one: the colour scheme, about, and the song. */}
      <div className="fixed z-10 top-[max(0.25rem,env(safe-area-inset-top))] right-[max(0.25rem,env(safe-area-inset-right))] flex items-center gap-1.5">
        <ThemeToggle />
        {divider}
        <a href="/about" className={linkClassName}>
          <Info />
          <Tooltip text="About" />
        </a>
        {divider}
        <a href="https://wearebrightly.com" className={linkClassName}>
          <MusicNotes />
          <Tooltip text="Song" />
        </a>
      </div>
      <Suspense fallback={<Fallback />}>
        {ready ? (
          <Viewport>
            <div
              className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 group flex flex-col transition-opacity ${
                isBuffering && showPlayhead
                  ? 'opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <div
                className={`bg-white dark:bg-stone-800 shadow-xl pl-2 pr-3 py-2 rounded-full flex items-center self-center text-stone-700 dark:text-stone-200 gap-2 text-sm mb-2`}
              >
                <CircleNotch className="animate-spin" size={20} />
                {seeking ? 'Loading video...' : 'Buffering...'}
              </div>

              <a
                href={youtubeLink(touchDevice)}
                className={`bg-yellow-400 shadow-xl px-4 py-1 rounded-full flex items-center text-stone-700 gap-2 text-xs hover:bg-black hover:text-white dark:hover:bg-white dark:hover:text-black transition-opacity  ${
                  isTooSlow && !seeking
                    ? 'opacity-100'
                    : 'opacity-0 pointer-events-none'
                }`}
              >
                Watch on YouTube?
              </a>
            </div>
            {/* data-swap-surface: drags that swap dreams start in here
                (see utils/swap-gesture.ts), not on the page's own UI. */}
            <div
              data-swap-surface
              className={`${isBuffering ? 'grayscale' : ''} fixed inset-0`}
            >
              {/* Fades in as the loading pile falls away
                  (components/loading.tsx). */}
              <div
                className={`absolute inset-0 transition-opacity duration-1000 ease-out ${
                  sceneLoaded ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <Canvas shadows dpr={dpr}>
                  <Suspense fallback={null}>
                    <Preload all />
                    <Scene video={video} />
                  </Suspense>
                </Canvas>
              </div>
              <Loading />
              <Playhead ref={video} />
            </div>
          </Viewport>
        ) : hasLoaded ? (
          <div className="relative h-screen grid place-content-center space-y-2 text-center p-4">
            {/* multiply drops the loop's white background against the
                light page, but against a dark page it'd take the letters
                down with it — so dark mode keys the white out to
                transparency instead — in the water's shader (iOS Safari
                ignores SVG filters on a canvas), or with
                components/key-white-filter.tsx on the plain video without
                WebGL2. Drawn through WebGL so the pointer ripples it like
                water. */}
            <WaterVideo
              className="mix-blend-multiply dark:mix-blend-normal"
              mediaClassName="dark:[filter:url(#key-white)]"
              keyWhite={colorScheme === 'dark'}
              size={512}
              handle={water}
              sources={[
                { src: 'video/loop.webm', type: 'video/webm' },
                { src: 'video/loop.mov', type: 'video/mp4' },
              ]}
            />
            <button
              // Lifts on hover, and drops into the water with the title
              // when pressed.
              className={`whitespace-nowrap fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-1 rounded-md px-4 py-2 bg-yellow-400 text-stone-900 hover:bg-black hover:text-white dark:hover:bg-white dark:hover:text-black flex items-center gap-2 shadow hover:shadow-xl transition-[transform,opacity,box-shadow,background-color,color] duration-300 hover:scale-105 motion-reduce:transition-none ${
                diving ? 'scale-90 opacity-0 pointer-events-none' : ''
              }`}
              style={diving ? { transitionDuration: `${DIVE_MS / 2}ms` } : undefined}
              onClick={handleReady}
              onPointerEnter={() => water.current?.hover(true)}
              onPointerLeave={() => water.current?.hover(false)}
            >
              <span className="uppercase">Brightly</span>
              <span className="font-serif italic text-2xl sm:text-3xl">
                Lysterfield Lake
              </span>
            </button>
          </div>
        ) : (
          <Fallback />
        )}
      </Suspense>
    </>
  )
}

export default Root
