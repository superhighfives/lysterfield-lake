import { ThreeElements, useFrame, useThree } from '@react-three/fiber'
import { RefObject, useEffect, useRef, useState } from 'react'
import { VideoMaterial } from '../materials/video-material'
import Polaroid from '../models/polaroid'
import { isVideoPlaying } from '../utils'
import {
  LinearSRGBColorSpace,
  MathUtils,
  Vector2,
  VideoTexture,
  Group,
  Mesh,
  Vector3,
} from 'three'
import { suspend } from 'suspend-react'
import { useIntersect } from '@react-three/drei'
import { useStore } from '../store'
import { animated, config, useSpring } from '@react-spring/three'
import { useIdle } from '@uidotdev/usehooks'

function Main(
  props: ThreeElements['group'] & {
    video: RefObject<HTMLVideoElement>
    tilt: number[]
  }
) {
  const { video, tilt } = props
  const videoElement = video.current!

  const main = useRef<Group>(null)
  const polaroidVisible = useRef(false)
  const polaroidIntersect = useIntersect(
    (isVisible) => (polaroidVisible.current = isVisible)
  )

  const ready = useStore((state) => state.ready)
  const dream = useStore((state) => state.dream)
  const resetting = useStore((state) => state.resetting)
  const isMobile = useStore((state) => state.isMobile)
  const isTouch = useStore((state) => state.isTouch)
  const setGlobalPointer = useStore((state) => state.setGlobalPointer)

  useEffect(() => {
    console.log(`Starting playback: ${ready}`)
    if (dream?.id) {
      videoElement.play()
    }
  }, [dream])

  const [pointerPos, setPointerPos] = useState(new Vector2(0, 0))
  const [pointerRel, setPointerRel] = useState(new Vector2(0, 0))

  const gl = useThree((state) => state.gl)

  const texture = suspend(
    () =>
      new Promise((res) => {
        const texture = new VideoTexture(videoElement)
        texture.colorSpace = gl.outputColorSpace

        if (videoElement.readyState === 4) {
          res(texture)
        } else {
          videoElement.addEventListener('loadedmetadata', () => res(texture))
        }
      }),
    [videoElement]
  ) as THREE.VideoTexture

  // Update colorspace
  texture.colorSpace = LinearSRGBColorSpace

  const [time, setTime] = useState(0)
  const idle = useIdle(5000)

  const [scaleProgress, setScaleProgress] = useState(0)
  const [idleOpacity, setIdleOpacity] = useState(0)
  const [polaroidVisibility, setPolaroidVisibility] = useState(0)

  useFrame((state, delta) => {
    const video = texture.source.data
    const isPlaying = isVideoPlaying(video)

    setTime(
      isPlaying && Math.abs(time - video.currentTime) < 1
        ? time + delta
        : video.currentTime
    )

    let pointerX = 0
    let pointerY = 0

    if (isMobile) {
      pointerX = MathUtils.clamp(-tilt[1] * 2 + 1.0, 0, 2)
      pointerY = MathUtils.clamp((tilt[0] / 2) * 2 + 1.0, 0, 2)
    } else if (!isMobile && !isTouch) {
      pointerX = MathUtils.lerp(pointerX, state.pointer.x + 1.0, 1.0)
      pointerY = MathUtils.lerp(pointerY, state.pointer.y + 1.0, 1.0)
    } else if (!isMobile && isTouch) {
      pointerX = MathUtils.lerp(1 - Math.sin(time / 4) / 4, pointerX + 1.0, 4.0)
      pointerY = MathUtils.lerp(1 - Math.sin(time / 2) / 8, pointerY + 1.0, 4.0)
    }

    const pointerPosition = new Vector2(
      pointerX * state.size.width,
      pointerY * state.size.height
    )
    const pointerRelative = new Vector2(pointerX, pointerY)
    setPointerPos(pointerPosition)
    setPointerRel(pointerRelative)
    setGlobalPointer(pointerRelative)

    const polaroidRef = main.current?.getObjectByName('polaroid')
    if (polaroidRef) {
      polaroidRef.rotation.y = MathUtils.lerp(
        polaroidRef.rotation.y,
        (pointerX - 1.0) / 4,
        0.05
      )
      polaroidRef.rotation.x = MathUtils.lerp(
        polaroidRef.rotation.x,
        -(pointerY - 1.0) / 4,
        0.05
      )
    }

    const avatarRef = main.current?.getObjectByName('avatar')
    if (avatarRef) {
      avatarRef.rotation.y = MathUtils.lerp(
        avatarRef.rotation.y,
        (pointerX - 1.0) / 4,
        0.05
      )
      avatarRef.rotation.x = MathUtils.lerp(
        avatarRef.rotation.x,
        -(pointerY - 1.0) / 4,
        0.05
      )
    }

    setPolaroidVisibility(
      MathUtils.lerp(polaroidVisibility, !dream || resetting ? 2 : 0, 0.1)
    )

    setScaleProgress(MathUtils.clamp(time / 8.0, 1.05, 1.125))

    if (!isMobile && !isTouch) {
      setIdleOpacity(
        MathUtils.lerp(
          idleOpacity,
          idle && video.currentTime > 15 ? 1.0 : 0.0,
          0.05
        )
      )
    }
  })

  const { height: h } = useThree((state) => state.viewport)

  const { position: polaroidPosition } = useSpring({
    from: { position: [0, -h * 1.6, 0] },
    to: {
      position: [0, polaroidVisibility * -h * 1.6, 0],
    },
    config: { precision: 0.0001, ...config.molasses },
  })

  const { scale } = useSpring({ scale: scaleProgress, config: config.molasses })
  const { position } = useSpring({
    position: [0, 0.04, -0.85],
  })

  return (
    <group ref={main} {...props}>
      <animated.group
        scale={1.1}
        position={polaroidPosition as unknown as Vector3}
      >
        {/* Dreaming */}
        <Polaroid
          intersectRef={polaroidIntersect as RefObject<Mesh>}
          name="polaroid"
          position={[0, 0, -1.0]}
          scale={0.35}
          passthroughMaterial={
            <videoMaterial
              key={VideoMaterial.key}
              uTexture={texture}
              uFrameSelected={7}
              uFrameTotal={7}
              uFrameMask={3}
              uOpacity={1}
              uFrameOverlay={3}
              uPointerPos={pointerPos}
              uPointerRelative={pointerRel}
              uTime={time}
            />
          }
        />

        {/* Avatar */}
        <animated.mesh
          position={position as unknown as Vector3}
          scale={scale}
          name="avatar"
        >
          <planeGeometry args={[1, 1, 500, 500]} />
          <videoMaterial
            key={VideoMaterial.key}
            uTexture={texture}
            uFrameSelected={2}
            uFrameSketch={6}
            uFrameMask={4}
            uFrameDepth={5}
            uFrameTotal={7}
            uAvatar={1}
            uOpacity={1}
            uMaskIntensity={1}
            uPointerPos={pointerPos}
            uPointerRelative={pointerRel}
            uTime={time}
            uIdle={idleOpacity}
          />
        </animated.mesh>

        {/* Lyrics */}
        <mesh position={[0, -0.4, 0.1]}>
          <planeGeometry args={[1, 1, 1]} />
          <videoMaterial
            key={VideoMaterial.key}
            uTexture={texture}
            uFrameSelected={7}
            uFrameMask={1}
            uMaskIntensity={1}
            uFrameTotal={7}
            uInvert={1}
            uOpacity={1}
            uTime={time}
          />
        </mesh>
      </animated.group>
    </group>
  )
}

export default Main
