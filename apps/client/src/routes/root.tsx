import { useStore } from '../store'
import { Canvas } from '@react-three/fiber'
import { Preload } from '@react-three/drei'
import { Suspense, useEffect, useRef, useState } from 'react'
import Loading from '../components/loading'
import Fallback from '../components/fallback'
import Scene from '../components/scene'
import Playhead from '../components/playhead'
import Viewport from '../components/viewport'
import ThemeToggle from '../components/theme-toggle'
import KeyWhiteFilter from '../components/key-white-filter'
import { handleDeviceOrientationPermissions, isTouchDevice, shuffle } from '../utils'
import dreams from '../dreams.json'
import { Play, FileText, CircleNotch } from '@phosphor-icons/react'
import { useHistorySync } from '../utils/use-history-sync'
import { useSwapInput } from '../utils/swap-dream'
import SwapStylePicker from '../components/swap-style-picker'

// How long buffering has to last before offering the YouTube escape hatch.
const TOO_SLOW_DELAY = 8000

const linkClassName =
  'px-2 py-1 flex gap-2 items-center hover:bg-yellow-400 hover:text-yellow-800 rounded hover:shadow-sm'

function Root() {
  const dream = useStore((state) => state.dream)
  const ready = useStore((state) => state.ready)
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
  // A swap's load is covered by the polaroid's own animation (see
  // utils/swap-dream.ts), so it doesn't count as buffering.
  const swapLoading = useStore((state) => state.swapPhase === 'loading')

  useEffect(() => {
    console.log('Loaded!')
    setCollection(shuffle(dreams))
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
    setReady(true)
  }

  return (
    <>
      <KeyWhiteFilter />
      <SwapStylePicker />
      <div className="fixed z-10 top-1 right-1 flex items-center gap-1 font-sans text-sm">
        <ThemeToggle />
        <a href="/about" className={linkClassName}>
          <FileText />
          About
        </a>
        <a href="https://wearebrightly.com" className={linkClassName}>
          <Play />
          Get the song
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
                href={dream?.link}
                className={`bg-yellow-400 shadow-xl px-4 py-1 rounded-full flex items-center text-stone-700 gap-2 text-xs hover:bg-black hover:text-white dark:hover:bg-white dark:hover:text-black transition-opacity  ${
                  isTooSlow && !seeking
                    ? 'opacity-100'
                    : 'opacity-0 pointer-events-none'
                }`}
              >
                Watch on YouTube?
              </a>
            </div>
            <div className={`${isBuffering ? 'grayscale' : ''} fixed inset-0`}>
              <Canvas shadows>
                <Suspense fallback={<Loading />}>
                  <Preload all />
                  <Scene video={video} />
                </Suspense>
              </Canvas>
              <Playhead ref={video} />
            </div>
          </Viewport>
        ) : hasLoaded ? (
          <div className="relative h-screen grid place-content-center space-y-2 text-center p-4">
            <video
              // multiply drops the loop's white background against the
              // light page, but against a dark page it'd take the letters
              // down with it — so dark mode keys the white out to
              // transparency instead (see components/key-white-filter.tsx).
              className="mix-blend-multiply dark:mix-blend-normal dark:[filter:url(#key-white)]"
              width={512}
              height={512}
              autoPlay
              playsInline
              loop
              muted
            >
              <source src="video/loop.webm" type="video/webm" />
              <source src="video/loop.mov" type="video/mp4" />
            </video>
            <button
              className={`whitespace-nowrap fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-1 rounded-md px-4 py-2 bg-yellow-400 text-stone-900 hover:bg-black hover:text-white dark:hover:bg-white dark:hover:text-black flex items-center gap-2 shadow`}
              onClick={handleReady}
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
