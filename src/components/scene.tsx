import { RefObject, useEffect, useMemo, useRef, useState } from 'react'
import {
  MathUtils,
  PerspectiveCamera as PerspectiveCameraType,
  SpotLight,
  Vector2,
} from 'three'
import {
  OrbitControls,
  DeviceOrientationControls,
  PerspectiveCamera,
  ScrollControls,
  Scroll,
} from '@react-three/drei'
import Choose from '../views/choose'
import Main from '../views/main'
import { useFrame, useThree } from '@react-three/fiber'
import { getRotation } from '../utils'
import { useStore } from '../store'
import { MediaReadyState } from '@react-av/core'

function Scene({ video }: { video: RefObject<HTMLVideoElement> }) {
  const camera = useRef<PerspectiveCameraType>()
  const { viewport } = useThree((state) => state)
  const { width: w, height: h } = viewport
  const CAMERA_Z = 1.5
  const isMobile = useStore((state) => state.isMobile)
  const isTouch = useStore((state) => state.isTouch)

  const dream = useStore((state) => state.dream)
  const [globalPointer, setGlobalPointer] = useState(new Vector2(0, 0))
  const setShowPlayhead = useStore((state) => state.setShowPlayhead)
  const initialRotation = useStore((state) => state.initialRotation)
  const polaroidVisible = useStore((state) => state.polaroidVisible)
  const resetting = useStore((state) => state.resetting)
  const isTooSlow = useStore((state) => state.isTooSlow)
  const setIsTooSlow = useStore((state) => state.setIsTooSlow)
  const videoState = useStore((state) => state.videoState)

  const [bufferingDelay, setBufferingDelay] = useState(0)
  const [dotOpacity, setDotOpacity] = useState(0)

  const setInitialRotation = useStore((state) => state.setInitialRotation)
  const resetInitialRotation = useStore((state) => state.resetInitialRotation)
  const setResetInitialRotation = useStore(
    (state) => state.setResetInitialRotation
  )
  useEffect(() => {
    setShowPlayhead(dream !== null && !resetting)
  }, [dream, resetting])

  useFrame((state, delta) => {
    const cameraRef = camera.current

    if (videoState < MediaReadyState.HAVE_FUTURE_DATA) {
      setBufferingDelay(bufferingDelay + delta)
      console.log(bufferingDelay)

      if (bufferingDelay >= 8 && !isTooSlow) {
        console.log('Okay, maybe YouTube')
        setIsTooSlow(true)
      }
    }

    if (isMobile || isTouch) {
      setDotOpacity(polaroidVisible)
    }

    const pointer = useStore.getState().globalPointer
    setGlobalPointer(pointer)

    if (cameraRef && !isMobile && !isTouch) {
      cameraRef.position.x = MathUtils.lerp(
        cameraRef.position.x,
        -state.pointer.x / 8,
        0.05
      )
      cameraRef.position.y = MathUtils.lerp(
        cameraRef.position.y,
        -state.pointer.y / 8,
        0.05
      )

      cameraRef.position.z = MathUtils.lerp(
        cameraRef.position.z,
        CAMERA_Z - state.pointer.y / 4,
        0.01
      )
    }
  })

  const fakeCamera = new PerspectiveCameraType()

  const [rotation, setRotation] = useState([0, 0, 0])

  const onOrientationChange = (e?: THREE.Event) => {
    if (resetInitialRotation) {
      const r = getRotation(e, [0, 0, 0])
      setInitialRotation(r as [number, number, number])
      setResetInitialRotation(false)
      setRotation(r as number[])
    } else {
      const r = getRotation(e, initialRotation)
      setRotation(r as number[])
    }
  }

  const spotlight = useMemo(() => new SpotLight('#fff'), [])

  return (
    <>
      <PerspectiveCamera
        ref={camera}
        makeDefault
        position={[0, 0, CAMERA_Z]}
        fov={50}
        zoom={w >= 1 ? 1 : w}
      />
      {isMobile ? (
        <DeviceOrientationControls
          camera={fakeCamera}
          onChange={onOrientationChange}
        />
      ) : null}
      {!isMobile && !isTouch ? (
        <OrbitControls enableRotate={false} enableZoom={false} />
      ) : null}
      <ambientLight intensity={0.5} />
      <group>
        <primitive
          object={spotlight}
          position={[5, 0, 30]}
          intensity={1}
          castShadow
          shadow-bias={-0.01}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <primitive object={spotlight.target} position={[0, 0, 0]} />
      </group>

      <ScrollControls pages={2.7} damping={0.1}>
        <Scroll>
          <Choose position={[0, 0, 0]} />
          <Main video={video} position={[0, -h * 1.6, 0]} tilt={rotation} />
        </Scroll>
      </ScrollControls>

      {isMobile || isTouch ? (
        <>
          <mesh
            visible={dream !== null && !resetting}
            position={[globalPointer.x - 1.0, globalPointer.y - 1.0, -0.5]}
            scale={0.025}
          >
            <circleGeometry args={[1, 16]} />
            <meshStandardMaterial
              color="#666"
              transparent
              opacity={dotOpacity}
            />
          </mesh>
        </>
      ) : null}
    </>
  )
}

export default Scene
