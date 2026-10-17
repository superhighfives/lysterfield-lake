/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ThreeElements, useFrame, useThree } from '@react-three/fiber'
import { Euler, MathUtils, Mesh, MeshBasicMaterial, Vector3 } from 'three'
import type { Dream } from '../utils/types'
import Polaroid from '../models/polaroid'
import { PolaroidMaterial } from '../materials/polaroid-material'
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
import dreams from '../dreams.json'

// Warms suspend-react's cache (the mechanism behind every useTexture call in
// this file and in Slider's per-card render prop below) at module-evaluation
// time, before Choose ever renders. A cache hit inside a component's render
// body returns synchronously without calling TextureLoader.load(), so it
// never reaches THREE's LoadingManager.itemStart() — which is what
// synchronously updates drei's useProgress() store (Loading's data source)
// while Choose/Slider are still mid-render, tripping React 19's "Cannot
// update a component while rendering a different component" check. Same
// family of render-phase-side-effect bug as this file's `doubledCollection`
// memoization and slider.tsx's `runSprings`/state-in-useFrame comments —
// just the one instance those passes didn't catch, since useTexture itself
// (not a state update built on top of it) is the actual culprit here.
useTexture.preload('images/welcome.png')
useTexture.preload('images/action-scroll.png')
useTexture.preload('images/choose.png')
dreams.forEach((dream) => useTexture.preload(`/assets/${dream.id}/hero.jpg`))

// The welcome/choose/scroll-hint artwork is black ink on transparent —
// inverted to white ink in dark mode so it still reads against the page.
const invertInk = (shader: { fragmentShader: string }) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    '#include <map_fragment>\n  diffuseColor.rgb = 1.0 - diffuseColor.rgb;'
  )
}

// How far the whole carousel sits toward the camera, in world units —
// making the cards bigger on screen without changing their spacing or
// fan. Applied to the group around Slider, like the scale below, so
// drei's <Center> inside it is unaffected.
const CAROUSEL_FORWARD = 0.25

const CAROUSEL_REFERENCE_HEIGHT = 900
const CAROUSEL_MIN_SCALE = 0.6

function Choose(props: ThreeElements['group']) {
  const collection = useStore((state) => state.collection)
  const isMobile = useStore((state) => state.isMobile)
  const dream = useStore((state) => state.dream)
  const setDream = useStore((state) => state.setDream)
  const colorScheme = useStore((state) => state.colorScheme)
  const dark = colorScheme === 'dark'
  // A fresh material per scheme (via `key`) rather than toggling
  // onBeforeCompile on the existing one, which wouldn't recompile.
  const inkProps = { onBeforeCompile: dark ? invertInk : undefined }
  const setPolaroidVisible = useStore((state) => state.setPolaroidVisible)
  const setPolaroidPillVisible = useStore(
    (state) => state.setPolaroidPillVisible
  )

  const titleVisible = useRef(false)
  const titleRef = useIntersect<Mesh>(
    (isVisible) => (titleVisible.current = isVisible)
  )

  const titleMask = useVideoTexture(`/video/title.mov`, {
    loop: false,
    start: false,
  })

  const titleImage = useVideoTexture(`/assets/${collection[0].id}/loop.mov`)

  // `[...collection, ...collection]` created a brand-new array every render
  // — Slider's internal useCallback chain (idx -> getPos -> runSprings) all
  // depend on `items`, so a fresh reference every render meant `runSprings`
  // never stabilized, its consuming effect kept re-firing, and combined
  // with drei's useTexture render-phase side effect (see the per-item
  // texture load below) that cascaded into a real "Maximum update depth
  // exceeded" loop under React 19. Memoized so the reference only changes
  // when `collection` itself actually does.
  const doubledCollection = useMemo(
    () => [...collection, ...collection],
    [collection]
  )

  // Choosing a card already leaves the page scrolled down to the player,
  // but a dream restored from the URL or browser history (see
  // utils/use-history-sync.ts) arrives with the page at the top — scroll
  // down to it. Done from useFrame once the scroll container has a real
  // height, since on a cold load the dream is set as the scene mounts.
  const scrollToPlayer = useRef(false)
  useEffect(() => {
    if (dream) scrollToPlayer.current = true
  }, [dream])

  useEffect(() => {
    if (titleVisible) {
      titleMask.source.data.play()
    }
  }, [titleVisible])

  const { height: h } = useThree((state) => state.viewport)

  // The carousel is sized in world units, which makes it a fixed share of
  // the canvas height — as tall a share on a big external monitor as on a
  // laptop, where it reads as enormous. Past CAROUSEL_REFERENCE_HEIGHT CSS
  // pixels of canvas, it's scaled down to hold roughly that on-screen size.
  // Applied to the group *around* Slider, not inside it: drei's <Center>
  // in Slider measures in its own local space, so an ancestor's scale
  // doesn't disturb the offset it bakes in at mount.
  const canvasHeight = useThree((state) => state.size.height)
  const carouselScale = MathUtils.clamp(
    CAROUSEL_REFERENCE_HEIGHT / canvasHeight,
    CAROUSEL_MIN_SCALE,
    1
  )

  const data = useScroll()
  // These all used to be React state, recomputed every frame via useFrame —
  // Choose renders the whole Slider (up to ~20 polaroid cards, each with
  // its own useTexture call) underneath it, so a state update here 60x/sec
  // was re-rendering all of that every frame. None of these values are
  // read reactively in a way that needs a React re-render: the two opacity
  // values are set directly on their material refs below, and the two
  // spring-driven values move to react-spring's imperative .start() api —
  // see plans/in-progress panel-3 doc's sibling investigation, and
  // main.tsx's equivalent fix, for the fuller writeup of this pattern.
  const welcomeVisibilityRef = useRef(0)
  const whichVisibilityRef = useRef(1)
  const polaroidVisibilityRef = useRef(0)
  const welcomeMaterial = useRef<MeshBasicMaterial>(null)
  const whichMaterial = useRef<MeshBasicMaterial>(null)

  const POLAROID_WIDTH = 0.3

  const [{ opacity: actionScrollOpacity }, actionScrollApi] = useSpring(
    () => ({
      opacity: 1,
      config: { ...config.default, precision: 0.0000001 },
    })
  )

  const [{ position: polaroidPosition }, polaroidApi] = useSpring(() => ({
    position: [0, -h * 1.8, CAROUSEL_FORWARD],
    config: { ...config.molasses, precision: 0.0000001 },
  }))

  useFrame(() => {
    // Once a dream is playing and the page has arrived at the player,
    // scrolling is locked: scrolling back up mid-song used to drift the
    // player off-screen toward the choose screen. "Return to home" (or the
    // video ending) clears the dream, which unlocks it.
    const lock = !!dream && !scrollToPlayer.current && data.offset > 0.98
    const overflow = lock ? 'hidden' : 'auto'
    if (data.el.style.overflowY !== overflow) data.el.style.overflowY = overflow

    if (scrollToPlayer.current) {
      // ScrollControls ignores scroll events until a frame after it starts
      // listening, so a jump made in that window is silently dropped — keep
      // re-announcing it until its offset actually starts moving.
      const max = data.el.scrollHeight - data.el.clientHeight
      if (data.offset > 0.01) {
        scrollToPlayer.current = false
      } else if (max > 0) {
        if (data.el.scrollTop < max) data.el.scrollTop = max
        else data.el.dispatchEvent(new Event('scroll'))
      }
    }

    const nextPolaroidVisibility = !dream
      ? MathUtils.lerp(
          polaroidVisibilityRef.current,
          data.range(-0.01, 5 / 10),
          0.1
        )
      : MathUtils.lerp(polaroidVisibilityRef.current, 0, 0.1)
    polaroidVisibilityRef.current = nextPolaroidVisibility
    polaroidApi.start({
      position: [
        0,
        -h * (1.8 + (1 - nextPolaroidVisibility) * 2),
        CAROUSEL_FORWARD,
      ],
    })

    const nextWelcomeVisibility = MathUtils.lerp(
      welcomeVisibilityRef.current,
      data.curve(1 / 10, 9 / 10),
      0.1
    )
    welcomeVisibilityRef.current = nextWelcomeVisibility
    if (welcomeMaterial.current) {
      welcomeMaterial.current.opacity = nextWelcomeVisibility
    }

    actionScrollApi.start({ opacity: 1.0 - data.range(0, 1 / 100) })

    const nextWhichVisibility = MathUtils.lerp(
      whichVisibilityRef.current,
      dream ? 0 : data.range(2 / 3, 1 / 3),
      0.1
    )
    whichVisibilityRef.current = nextWhichVisibility
    if (whichMaterial.current) {
      whichMaterial.current.opacity = nextWhichVisibility
    }

    // `polaroidVisible` itself is read non-reactively (via `getState()`
    // inside another component's own `useFrame`) — same family of fix as
    // `globalPointer`/`px` above, this field just wasn't caught at the
    // time. The two things that DO need a reactive update (Playhead's
    // JSX, gating pointer-events/opacity on crossing the 0.3 threshold)
    // only care about the boolean, which is written here only when it
    // actually flips, not every frame.
    const visibility = data.range(4 / 5, 0.3)
    setPolaroidVisible(visibility)
    const pillVisible = visibility > 0.3
    if (useStore.getState().polaroidPillVisible !== pillVisible) {
      setPolaroidPillVisible(pillVisible)
    }
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
          key={colorScheme}
          {...inkProps}
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
          key={colorScheme}
          {...inkProps}
          ref={welcomeMaterial}
          transparent
          map={welcome}
        />
      </mesh>

      {/* Choose — the carousel's card layers (see slider.tsx) draw over
          this where they overlap it, which is intended. */}
      <mesh position={[0, -h * 1.4, 0]}>
        <planeGeometry args={[1, which.image.height / which.image.width, 1]} />
        <meshBasicMaterial
          key={colorScheme}
          {...inkProps}
          ref={whichMaterial}
          transparent
          map={which}
        />
      </mesh>
      <animated.group
        position={polaroidPosition as unknown as Vector3}
        scale={carouselScale}
      >
        <Slider
          items={doubledCollection}
          isDragging={isDragging}
          width={POLAROID_WIDTH}
          visible={collection.length * 2 - 1}
        >
          {(dream: Dream) => {
            const textureImage = useTexture(`/assets/${dream.id}/hero.jpg`)
            const [hover, setHover] = useState(false)
            useCursor(hover)

            // Was React state polled every frame via useFrame — size only
            // actually changes on window resize, and this whole block runs
            // once per visible card (up to ~20), so that was up to 20
            // useFrame subscriptions each calling two setStates 60x/sec.
            // useThree's selector already only re-renders on a real resize.
            const { width: canvasWidth, height: canvasHeight } = useThree(
              (state) => state.size
            )
            const size = [canvasWidth, canvasHeight]
            const aspect =
              canvasWidth > canvasHeight
                ? [1, canvasWidth / canvasHeight]
                : [canvasHeight / canvasWidth, 1]

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

            return (
              <animated.group
                key={dream.id}
                rotation={rotationAmount as unknown as Euler}
                scale={scaleAmount}
              >
                <Polaroid
                  layered
                  onPointerOver={(e) => {
                    e.stopPropagation()
                    setHover(true)
                  }}
                  onPointerOut={(e) => {
                    e.stopPropagation()
                    setHover(false)
                  }}
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
                    color={dark ? 'white' : 'black'}
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
                    color={dark ? '#78716c' : '#bbb'}
                    anchorX="left"
                    anchorY="middle"
                  >
                    {`"${dream.prompt}"`}
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
