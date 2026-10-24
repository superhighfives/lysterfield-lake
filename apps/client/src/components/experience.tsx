import { RefObject, Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Preload } from '@react-three/drei'
import Loading from './loading'
import Scene from './scene'
import Playhead from './playhead'
import { useStore } from '../store'

// Everything after the title: the 3D scene, the loading pile and the
// player's controls. A separate chunk (routes/root.tsx loads it lazily), so
// the title doesn't wait on three.js, the scene or its assets; they load
// behind the pile's spinner once the start button's pressed
// (components/loading-shell.tsx until this chunk is in).
function Experience({
  video,
  dpr,
  isBuffering,
}: {
  video: RefObject<HTMLVideoElement | null>
  dpr: number
  isBuffering: boolean
}) {
  const pileLeaving = useStore((state) => state.pileLeaving)
  return (
    // data-swap-surface: drags that swap dreams start in here (see
    // utils/swap-gesture.ts), not on the page's own UI.
    <div
      data-swap-surface
      className={`${isBuffering ? 'grayscale' : ''} fixed inset-0`}
    >
      {/* Fades in as the loading pile falls away (components/loading.tsx). */}
      <div
        className={`absolute inset-0 transition-opacity duration-1000 ease-out ${
          pileLeaving ? 'opacity-100' : 'opacity-0'
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
  )
}

export default Experience
