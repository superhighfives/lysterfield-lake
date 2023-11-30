/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
import { ThreeElements, useFrame, useThree } from '@react-three/fiber'
import { Euler, MathUtils, Mesh, Vector3 } from 'three'
import type { Dream } from '../utils/types'
import Polaroid from '../models/polaroid'
import { PolaroidMaterial } from '../materials/polaroid-material'
import { format, parse } from 'date-fns'
import {
  useCursor,
  useIntersect,
  useScroll,
  useTexture,
  useVideoTexture,
  Text,
} from '@react-three/drei'
import { animated, useSpring, config, a } from '@react-spring/three'
import { useStore } from '../store'
import Slider from '../components/slider'

function Choose(props: ThreeElements['group']) {
  const collection = useStore((state) => state.collection)
  const isMobile = useStore((state) => state.isMobile)
  const dream = useStore((state) => state.dream)
  const setDream = useStore((state) => state.setDream)
  const setPolaroidVisible = useStore((state) => state.setPolaroidVisible)

  const titleVisible = useRef(false)
  const titleRef = useIntersect<Mesh>(
    (isVisible) => (titleVisible.current = isVisible)
  )

  const titleMask = useVideoTexture(`/video/title.mov`, {
    loop: false,
    start: false,
  })

  const titleImage = useVideoTexture(`/assets/${collection[0].id}/loop.mov`)

  useEffect(() => {
    if (titleVisible) {
      titleMask.source.data.play()
    }
  }, [titleVisible])

  const { height: h } = useThree((state) => state.viewport)

  const data = useScroll()
  const [welcomeVisibility, setWelcomeVisibility] = useState(0)
  const [scrollVisibility, setScrollVisibility] = useState(0)
  const [whichVisibility, setWhichVisibility] = useState(1)
  const [polaroidVisibility, setPolaroidVisibility] = useState(0)
  const [dotVisibility, setDotVisibility] = useState(0)

  const POLAROID_WIDTH = 0.3

  useFrame(() => {
    if (!dream) {
      setPolaroidVisibility(
        MathUtils.lerp(polaroidVisibility, data.range(-0.01, 5 / 10), 0.1)
      )
    } else {
      setPolaroidVisibility(MathUtils.lerp(polaroidVisibility, 0, 0.1))
    }

    setWelcomeVisibility(
      MathUtils.lerp(welcomeVisibility, data.curve(1 / 10, 9 / 10), 0.1)
    )
    setScrollVisibility(data.range(0, 1 / 100))
    setWhichVisibility(
      MathUtils.lerp(whichVisibility, dream ? 0 : data.range(2 / 3, 1 / 3), 0.1)
    )
    setDotVisibility(data.range(4 / 5, 0.3))
  })

  useEffect(() => {
    setPolaroidVisible(dotVisibility)
  }, [dotVisibility])

  const { opacity: actionScrollOpacity } = useSpring({
    opacity: 1.0 - scrollVisibility,
    config: { ...config.default, precision: 0.0000001 },
  })

  const { position: polaroidPosition } = useSpring({
    position: [0, -h * (1.8 + (1 - polaroidVisibility) * 2), 0],
    config: { ...config.molasses, precision: 0.0000001 },
  })

  const welcome = useTexture('images/welcome.png')
  const actionScroll = useTexture('images/action-scroll.png')
  const which = useTexture('images/choose.png')

  const isDragging = useRef(false)
  const isDoubleClicked = useRef(false)
  const previousClickTimestamp = useRef(performance.now())
  const DOUBLE_CLICK_TIME_THRESHOLD = 250

  function handleClick(e: Event, dream: Dream) {
    e.stopPropagation()

    if (!isMobile) {
      if (isDragging.current) return
      const now = performance.now()
      const clickDeltaTime = now - previousClickTimestamp.current
      if (
        isDoubleClicked.current ||
        clickDeltaTime >= DOUBLE_CLICK_TIME_THRESHOLD
      ) {
        setDream(dream)
        isDoubleClicked.current = false
      } else {
        isDoubleClicked.current = true
      }

      previousClickTimestamp.current = now
    } else {
      setDream(dream)
    }
  }

  const PolaroidShaderWrapper = a(({ ...props }) => (
    <polaroidMaterial {...props} />
  ))

  return (
    <group {...props}>
      {/* Title */}
      <mesh ref={titleRef} position={[0, 0, -0.75]} scale={1.5}>
        <planeGeometry />
        <meshBasicMaterial transparent alphaMap={titleMask} map={titleImage} />
      </mesh>

      {/* Action Scroll */}
      <mesh position={[0, -0.7, -0.25]} scale={0.1}>
        <planeGeometry
          args={[1, actionScroll.image.height / actionScroll.image.width, 1]}
        />
        {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
        {/* @ts-ignore: https://github.com/pmndrs/react-spring/issues/1515 */}
        <animated.meshBasicMaterial
          opacity={actionScrollOpacity}
          transparent
          map={actionScroll}
        />
      </mesh>

      {/* Welcome */}
      <mesh position={[0, -1.2, 0]}>
        <planeGeometry
          args={[1, welcome.image.height / welcome.image.width, 1]}
        />
        <meshBasicMaterial
          opacity={welcomeVisibility}
          transparent
          map={welcome}
        />
      </mesh>

      {/* Choose */}
      <mesh position={[0, -h * 1.4, 0]}>
        <planeGeometry args={[1, which.image.height / which.image.width, 1]} />
        <meshBasicMaterial opacity={whichVisibility} transparent map={which} />
      </mesh>
      <animated.group position={polaroidPosition as unknown as Vector3}>
        <Slider
          items={[...collection, ...collection]}
          isDragging={isDragging}
          width={POLAROID_WIDTH}
          visible={collection.length * 2 - 1}
        >
          {(dream: Dream) => {
            const textureImage = useTexture(`/assets/${dream.id}/hero.jpg`)
            const [hover, setHover] = useState(false)
            useCursor(hover)

            const [size, setSize] = useState([0, 0])
            const [aspect, setAspect] = useState([0, 0])

            const { uHover: hoverAmount } = useSpring({
              uHover: hover ? 1.0 : 0.0,
              config: { ...config.molasses, precision: 0.0000001 },
            })

            const { scale: scaleAmount } = useSpring({
              scale: hover ? 0.12 : 0.1,
              config: { ...config.molasses, precision: 0.0000001 },
            })

            const { rotation: rotationAmount } = useSpring({
              rotation: hover ? [-0.25, 0, 0] : [0, 0, 0],
              config: { ...config.molasses, precision: 0.0000001 },
            })

            useFrame((state) => {
              const { width, height } = state.size
              setSize([width, height])
              setAspect(
                width > height ? [1, width / height] : [height / width, 1]
              )
            })

            return (
              <animated.group
                key={dream.id}
                rotation={rotationAmount as unknown as Euler}
                scale={scaleAmount}
              >
                <Polaroid
                  onPointerOver={(e) => {
                    e.stopPropagation()
                    setHover(true)
                  }}
                  onPointerOut={(e) => {
                    e.stopPropagation()
                    setHover(false)
                  }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onClick={(e) => handleClick(e as any, dream)}
                  passthroughMaterial={
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    //@ts-ignore: https://github.com/pmndrs/react-spring/issues/1515 */}
                    <PolaroidShaderWrapper
                      key={PolaroidMaterial.key}
                      uTexture={textureImage}
                      uSize={size}
                      uAspect={aspect}
                      uHover={hoverAmount}
                    />
                  }
                />
                <group position={[-1.55, -1.75, 0.1]}>
                  <Text
                    scale={0.25}
                    font="/fonts/redaction/Redaction_35-Italic.ttf"
                    color="black"
                    fillOpacity={0.8}
                    anchorX="left"
                    anchorY="middle"
                  >
                    {dream.title}
                  </Text>
                  <Text
                    scale={0.115}
                    position={[0, -0.25, 0]}
                    font="/fonts/space-mono/SpaceMono-Regular.ttf"
                    color="#bbb"
                    anchorX="left"
                    anchorY="middle"
                  >
                    {dream.prompt}
                  </Text>
                </group>
              </animated.group>
            )
          }}
        </Slider>
      </animated.group>
    </group>
  )
}

export default Choose
