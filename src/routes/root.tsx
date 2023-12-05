import { useStore } from '../store'
import { MediaReadyState } from '@react-av/core'
import { Canvas } from '@react-three/fiber'
import { Preload } from '@react-three/drei'
import { Suspense, useEffect, useRef, useState } from 'react'
import Loading from '../components/loading'
import Fallback from '../components/fallback'
import Scene from '../components/scene'
import Playhead from '../components/playhead'
import Viewport from '../components/viewport'
import { handleDeviceOrientationPermissions, isTouchDevice } from '../utils'
import shuffle from 'lodash/shuffle'
import dreams from '../dreams.json'
import { Play, FileText, CircleNotch } from '@phosphor-icons/react'

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
  const seeking = useStore((state) => state.seeking)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const showPlayhead = useStore((state) => state.showPlayhead)

  useEffect(() => {
    console.log('Loaded!')
    setCollection(shuffle(dreams))
    setHasLoaded(true)
  }, [])

  useEffect(() => {
    console.log(`Video state: ${videoState}`)
    if (dream) {
      setIsBuffering(videoState < MediaReadyState.HAVE_FUTURE_DATA)
    } else {
      setIsBuffering(false)
    }
  }, [videoState, dream])

  const handleReady = async () => {
    const isMobile = (await handleDeviceOrientationPermissions()) as boolean
    const isTouch = isTouchDevice() as boolean
    setIsMobile(isMobile)
    setIsTouch(isTouch)
    console.log(`Accelerometer: ${isMobile} | Touch: ${isTouch}`)
    setReady(true)
  }

  return (
    <>
      <div className="fixed z-10 top-1 right-1 flex gap-1 font-sans text-sm">
        <a
          href="/about"
          className="px-2 py-1 flex gap-2 items-center hover:bg-yellow-400 hover:text-yellow-800 rounded hover:shadow-sm"
        >
          <FileText />
          About
        </a>
        <a
          href="https://wearebrightly.com"
          className="px-2 py-1 flex gap-2 items-center hover:bg-yellow-400 hover:text-yellow-800 rounded hover:shadow-sm"
        >
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
                className={`bg-white shadow-xl pl-2 pr-3 py-2 rounded-full flex items-center self-center text-stone-700 gap-2 text-sm mb-2`}
              >
                <CircleNotch className="animate-spin" size={20} />
                {seeking ? 'Loading video...' : 'Buffering...'}
              </div>

              <a
                href={dream?.link}
                className={`bg-yellow-400 shadow-xl px-4 py-1 rounded-full flex items-center text-stone-700 gap-2 text-xs hover:bg-black hover:text-white transition-opacity  ${
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
              className="mix-blend-multiply"
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
              className={`whitespace-nowrap fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-1 rounded-md px-4 py-2 bg-yellow-400 hover:bg-black hover:text-white flex items-center gap-2 shadow`}
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
