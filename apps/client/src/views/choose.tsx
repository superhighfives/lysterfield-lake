 
import { useEffect, useRef, useState } from 'react'
import { ThreeElements, useFrame, useThree } from '@react-three/fiber'
import { MathUtils, Mesh, MeshBasicMaterial, Vector3 } from 'three'
import {
  useIntersect,
  useScroll,
  useTexture,
  useVideoTexture,
} from '@react-three/drei'
import { animated, useSpring, config } from '@react-spring/three'
import { useStore } from '../store'
import Stack, { stackHold } from '../components/carousels/stack'
import dreams from '../dreams.json'

// Warms suspend-react's cache (the mechanism behind every useTexture call in
// this file and in each stacked card) at module-evaluation time, before
// Choose ever renders. A cache hit inside a component's render body returns
// synchronously without calling TextureLoader.load(), so it never reaches
// THREE's LoadingManager.itemStart() — which is what synchronously updates
// drei's useProgress() store (Loading's data source) while Choose is still
// mid-render, tripping React 19's "Cannot update a component while
// rendering a different component" check.
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
// pile. Applied to the group around the stack, like the scale below.
const CAROUSEL_FORWARD = 0.25
// How far the pile sits up toward its heading ("Where are we going?"), in
// viewport heights, leaving room below for the top card's title and prompt.
// Much more and its back cards cover the heading once it's fully risen
// into place.
const CAROUSEL_LIFT = 0.04

// Frames between nudges while arriving at the player (see useFrame).
const NUDGE_EVERY = 4

const CAROUSEL_REFERENCE_HEIGHT = 900
const CAROUSEL_MIN_SCALE = 0.6
// And never above CAROUSEL_MAX_SCALE: at full size, on a laptop-height
// window, the top card grown on hover ran off the bottom, taking its
// title and prompt with it.
const CAROUSEL_MAX_SCALE = 0.85
// On a tall, narrow screen (a phone upright), the camera zooms out to fit
// the width but the pile still filled it and ran off the side, its lower
// cards squeezed out of sight. Below CAROUSEL_NARROW_ASPECT (width over
// height) it's shrunk with the aspect, down to CAROUSEL_NARROW_MIN.
const CAROUSEL_NARROW_ASPECT = 0.8
const CAROUSEL_NARROW_MIN = 0.7

function Choose(props: ThreeElements['group']) {
  const collection = useStore((state) => state.collection)
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

  // A random dream behind the title, picked once per load.
  const [titleDream] = useState(
    () => collection[Math.floor(Math.random() * collection.length)]
  )
  const titleImage = useVideoTexture(`/assets/${titleDream.id}/loop.mov`)

  // Choosing a card already leaves the page scrolled down to the player,
  // but a dream restored from the URL or browser history (see
  // utils/use-history-sync.ts) arrives with the page at the top — scroll
  // down to it. Done from useFrame once the scroll container has a real
  // height, since on a cold load the dream is set as the scene mounts.
  const scrollToPlayer = useRef(false)
  const nudgeFrame = useRef(0)
  // Whether the page has reached the player for the dream that's playing.
  const atPlayer = useRef(false)
  useEffect(() => {
    if (dream) scrollToPlayer.current = true
  }, [dream])

  // The title paints itself in once the loading pile starts falling away
  // and the scene fades in (components/loading.tsx). Started as the scene
  // mounted, it had finished behind the pile.
  const pileLeaving = useStore((state) => state.pileLeaving)
  useEffect(() => {
    if (pileLeaving) titleMask.source.data.play()
  }, [pileLeaving, titleMask])

  const { height: h } = useThree((state) => state.viewport)

  // The carousel is sized in world units, which makes it a fixed share of
  // the canvas height — as tall a share on a big external monitor as on a
  // laptop, where it reads as enormous. Past CAROUSEL_REFERENCE_HEIGHT CSS
  // pixels of canvas, it's scaled down to hold roughly that on-screen size
  // (and below it, held at CAROUSEL_MAX_SCALE).
  // Applied to the group around the stack, which lays its cards out in
  // its own local space.
  const canvasHeight = useThree((state) => state.size.height)
  const canvasWidth = useThree((state) => state.size.width)
  const carouselScale =
    MathUtils.clamp(
      CAROUSEL_REFERENCE_HEIGHT / canvasHeight,
      CAROUSEL_MIN_SCALE,
      CAROUSEL_MAX_SCALE
    ) *
    MathUtils.clamp(
      canvasWidth / canvasHeight / CAROUSEL_NARROW_ASPECT,
      CAROUSEL_NARROW_MIN,
      1
    )

  const data = useScroll()
  // These all used to be React state, recomputed every frame via useFrame —
  // Choose renders the whole stack (up to ~20 polaroid cards, each with
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

  const [{ opacity: actionScrollOpacity }, actionScrollApi] = useSpring(
    () => ({
      opacity: 1,
      config: { ...config.default, precision: 0.0000001 },
    })
  )

  const [{ position: polaroidPosition }, polaroidApi] = useSpring(() => ({
    position: [0, -h * (1.8 - CAROUSEL_LIFT), CAROUSEL_FORWARD],
    config: { ...config.molasses, precision: 0.0000001 },
  }))

  useFrame(() => {
    // Once a dream is playing and the page has arrived at the player,
    // scrolling is locked: scrolling back up mid-song used to drift the
    // player off-screen toward the choose screen. "Back" (or the
    // video ending) clears the dream, which unlocks it.
    // Held still too while a finger's on the stack's top card (see
    // stackHold).
    const lock =
      (!!dream && !scrollToPlayer.current && data.offset > 0.98) ||
      stackHold.active
    const overflow = lock ? 'hidden' : 'auto'
    if (data.el.style.overflowY !== overflow) data.el.style.overflowY = overflow

    // Arriving at the player. A dream restored from the URL starts with the
    // page at the top, so it's scrolled down — and ScrollControls only
    // takes a scroll position from a real scroll event: a synthetic
    // dispatched one never registered, and the first real one after it
    // starts listening is dropped. It also measures the scrollable length
    // only as it starts, so on a cold load the page could sit fully
    // scrolled down with the scene stuck partway, back at the choose
    // screen. So while a dream's set and the scene hasn't arrived, nudge
    // the real scroll position (up a couple of pixels, then back to the
    // bottom) every few frames until it does.
    if (!dream) atPlayer.current = false
    if (dream) {
      const max = data.el.scrollHeight - data.el.clientHeight
      const arrived = data.offset > 0.99
      if (arrived) scrollToPlayer.current = false
      // Once there, it stays there: a scroll that got in before the lock,
      // or Safari's toolbar resizing the page, could leave the player
      // partway off-screen with nothing to bring it back. (Not on the way
      // home, which scrolls up on purpose.)
      if (arrived) atPlayer.current = true
      if (
        atPlayer.current &&
        !useStore.getState().resetting &&
        max > 0 &&
        data.el.scrollTop < max - 1
      )
        data.el.scrollTop = max
      if (!arrived && max > 0 && (scrollToPlayer.current || data.el.scrollTop >= max - 1)) {
        nudgeFrame.current = (nudgeFrame.current + 1) % NUDGE_EVERY
        if (nudgeFrame.current === 0)
          data.el.scrollTop = data.el.scrollTop >= max - 1 ? max - 2 : max
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
        -h * (1.8 - CAROUSEL_LIFT + (1 - nextPolaroidVisibility) * 2),
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

      {/* Choose — the stack's cards draw over
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
        <Stack
          items={collection}
          onSelect={setDream}
          presence={polaroidVisibilityRef}
        />
      </animated.group>
    </group>
  )
}

export default Choose
