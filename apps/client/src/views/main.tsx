import { ThreeElements, useFrame, useThree } from '@react-three/fiber'
import { RefObject, useEffect, useMemo, useRef } from 'react'
import { VideoMaterial, VideoMaterialProps } from '../materials/video-material'
import Polaroid, { polaroidBend } from '../models/polaroid'
import { isVideoPlaying } from '../utils'
import {
  LinearSRGBColorSpace,
  MathUtils,
  Vector2,
  VideoTexture,
  Group,
  Mesh,
  Vector3,
  Box3,
} from 'three'
import { suspend } from 'suspend-react'
import { useIntersect } from '@react-three/drei'
import { SwapPhase, useStore } from '../store'
import { adjacentDream, commitSwap, fadeOutAudio } from '../utils/swap-dream'
import { readPulse } from '../utils/audio'
import DreamGlow from '../components/dream-glow'
import { createWaterSim } from '../utils/water-sim'
import {
  dreamElements,
  dreamVideo,
  backSlot,
  frontReady,
  isSplit,
  playback,
  shownDream,
  snapCrossfade,
  stepCrossfade,
  warmDream,
} from '../utils/dream-video'
import {
  commitDistance,
  directionOf,
  polaroidRect,
  swapDrag,
} from '../utils/swap-gesture'
import { animated, config, useSpring } from '@react-spring/three'
// eslint-disable-next-line import/named -- useIdle is a real export (confirmed at runtime); eslint-plugin-import's static resolver doesn't handle this package's minimal `exports` map correctly
import { useIdle } from '@uidotdev/usehooks'

// Avatar depth, see video-material.tsx's vertex shader. Tuned by eye on
// watercolour (was 20230808103741), comparing side-on renders: the depth panel is too coarse
// to push forward as-is (a head comes through as a flat plateau, which
// extruded into a block on a pinched neck), so it's blurred across
// DEPTH_SHAPE_RADIUS of the panel into rounded forms first, with a thin
// DEPTH_EDGE_RADIUS roll-off at the matte's edge. Smaller blur radii
// (0.05) brought the block-head back; 0.12 at strength 0.3 gave the most
// depth while still reading as a head on shoulders. Checked across four
// more dreams (they share source footage, so the depth panels match) and
// several poses: the edge radius was widened 0.02 -> 0.04 with a smoother
// roll-off (see the vertex shader) after the head's outline smeared at
// realistic tilt angles.
const DEPTH_STRENGTH = 0.3
// How quickly the tilt-driven pointer eases toward the phone's tilt (per
// second): high enough to feel attached, low enough to smooth the
// sensor's noise.
const TILT_EASE = 8
// An angle (radians) wrapped to ±π.
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
const DEPTH_SHAPE_RADIUS = 0.12
const DEPTH_EDGE_RADIUS = 0.04
// Unsharp-mask amount for the portrait panel. The softness is mostly at
// source, so this firms up edges (hair, necklace) rather than adding
// detail; 1.5 showed no halos, 1.2 leaves some margin.
const AVATAR_SHARPEN = 1.2
// The polaroid sits behind the avatar. Set on the swap group around it,
// so swap rotations (a flip) turn it about its own centre.
const POLAROID_Z = -1.0
// Scale of the group the polaroid, avatar and lyrics sit in.
const MAIN_SCALE = 1.1
// A swap (utils/swap-dream.ts): the polaroid springs back to rest as its
// photo fades to a blank print over SWAP_OUT_SECONDS, holds there while the
// next dream loads, and the next develops in (DEVELOP_SECONDS) as the swap
// settles over SWAP_IN_SECONDS.
const SWAP_OUT_SECONDS = 0.45
const SWAP_IN_SECONDS = 0.6
// While dragged, the polaroid follows the pointer 1:1 sideways, tilting
// into the drag (radians per world unit) and dipping a little, like a
// photo held by one corner. Let go short of a swap and it eases back.
const DRAG_TILT = 0.25
const DRAG_DIP = 0.06
const DRAG_RETURN = 0.15
// The avatar dissolves as a drag goes — gone by this share of
// the way to the release point — stays gone through the swap, and comes
// back as the new polaroid lands. All the way to the release point, so
// the avatar can be seen trailing the drag (AVATAR_FOLLOW) as it goes.
// FADE_EASE smooths the target per frame.
const FADE_BY_DRAG = 1
const FADE_EASE = 0.12
// Motion smear on the polaroid photo: its per-frame movement (local
// units, normalised to 60fps) over this width is the smear in photo UV,
// eased per frame by VELOCITY_EASE and capped at VELOCITY_MAX.
const PHOTO_WIDTH = 1.05
const VELOCITY_EASE = 0.3
const VELOCITY_MAX = 0.035
// After a swap the new polaroid develops (see uDevelop) over this long,
// and a ripple rings out through it when it lands — this far through its
// arrival (swap progress counts 1 -> 0).
const DEVELOP_SECONDS = 2.5
const LANDING_AT = 0.5
// The polaroid flexes like card (model z units of curl at its edges): back
// against the air as it moves, per unit of photo-UV velocity, and while
// it's held mid-drag, up to BEND_HELD at the release point. Capped at
// BEND_MAX and eased by BEND_EASE per frame.
const BEND_PER_VELOCITY = 20
const BEND_HELD = 0.7
const BEND_MAX = 1
const BEND_EASE = 0.2
// While the polaroid's dragged, the avatar trails it: AVATAR_FOLLOW of the
// way, eased by AVATAR_FOLLOW_EASE per frame so it lags behind, tilting
// with it by AVATAR_FOLLOW_TILT radians per world unit.
const AVATAR_FOLLOW = 0.35
const AVATAR_FOLLOW_EASE = 0.08
const AVATAR_FOLLOW_TILT = 0.15
// The polaroid swells this much (scale) on each beat.
const PULSE_SCALE = 0.012
// How much of the avatar's pointer fade breaks into stipple (uHash).
const AVATAR_HASH = 0.6
// After a swap the avatar arrives at full strength, wherever the pointer
// is, for REVEAL_HOLD seconds from the landing, then eases back to its
// pointer fade over REVEAL_RELEASE seconds.
const REVEAL_HOLD = 2
const REVEAL_RELEASE = 1
// The blank print's water (utils/water-sim.ts): pointer speed (CSS px per
// frame) for a full-strength stroke.
const EMULSION_FULL_SPEED = 30
// The same water runs over the playing photo, stirred by the mouse or a
// phone's tilt (a finger's for swapping): the tilt's pointer moves less
// than a mouse, so its full strength comes at TILT_FULL_SPEED px per
// frame. The water eases in and out
// (WATER_PLAY_EASE per second) with the dream.
const TILT_FULL_SPEED = 6
const WATER_PLAY_EASE = 4
// How quickly, on a phone, the avatar fades for a finger and comes back.
const TOUCH_REVEAL_EASE = 6
// How quickly the avatar greys while a dream loads, and colours back.
const DESATURATE_EASE = 5
// How much of each wave survives a step on the playing photo: lower than
// the blank print's (water-sim.ts's DAMPING), so it's as strong but
// settles in a second or so rather than lingering.
const WATER_PLAY_DAMPING = 0.97

function Main(
  props: ThreeElements['group'] & {
    video: RefObject<HTMLVideoElement | null>
    tilt: number[]
  }
) {
  const { video, tilt } = props
  const videoElement = video.current!

  const main = useRef<Group>(null)
  const swapGroup = useRef<Group>(null)
  const polaroidVisible = useRef(false)
  const polaroidIntersect = useIntersect(
    (isVisible) => (polaroidVisible.current = isVisible)
  )

  const dream = useStore((state) => state.dream)
  const resetting = useStore((state) => state.resetting)
  const isMobile = useStore((state) => state.isMobile)
  const isTouch = useStore((state) => state.isTouch)
  const setGlobalPointer = useStore((state) => state.setGlobalPointer)
  const colorScheme = useStore((state) => state.colorScheme)
  const dark = colorScheme === 'dark' ? 1 : 0

  const gl = useThree((state) => state.gl)

  const texture = suspend(
    () =>
      new Promise((res) => {
        const texture = new VideoTexture(videoElement)
        texture.colorSpace = gl.outputColorSpace

        // Checks for the same state the listener below waits for. This used
        // to check for HAVE_ENOUGH_DATA (4) instead, so landing here after
        // `loadedmetadata` had already fired but before the element reached
        // 4 waited on an event that never comes — the scene sat on the
        // loading screen forever.
        if (videoElement.readyState >= HTMLMediaElement.HAVE_METADATA) {
          res(texture)
        } else {
          videoElement.addEventListener('loadedmetadata', () => res(texture), {
            once: true,
          })
        }
      }),
    [videoElement]
  ) as VideoTexture

  // Update colorspace
  texture.colorSpace = LinearSRGBColorSpace

  // The split layout (utils/dream-video.ts): `texture` is the shared main
  // video, panels 1-6, and the dream (panel 7) comes from its own two
  // videos, crossfaded as dreams switch. Otherwise `texture` is the dream's
  // own 7-panel video, as before.
  // The last dream's layout holds while the player leaves (the dream's
  // cleared first): falling back to 7 panels mid-exit read a panel 7 off
  // the 6-panel main video, and flashed its outline panel up full-screen.
  const lastDream = useRef(dream)
  if (dream) lastDream.current = dream
  const split = isSplit(dream ?? lastDream.current)
  const frameTotal = split ? 6 : 7
  const dreamTextures = useMemo(
    () =>
      dreamElements().map((el) => {
        const dreamTexture = new VideoTexture(el)
        dreamTexture.colorSpace = LinearSRGBColorSpace
        return dreamTexture
      }),
    []
  )
  useEffect(
    () => () => dreamTextures.forEach((dreamTexture) => dreamTexture.dispose()),
    [dreamTextures]
  )

  const idle = useIdle(5000)

  const polaroidMaterial = useRef<VideoMaterialProps>(null)
  const avatarMaterial = useRef<VideoMaterialProps>(null)
  const lyricsMaterial = useRef<VideoMaterialProps>(null)

  // time/pointer/scale/idle/polaroid-visibility all used to be React state
  // set every frame from useFrame — since every consumer is either a shader
  // uniform (settable directly on the material ref below) or a react-spring
  // target (settable via its imperative `.start()` api), driving them
  // through React state was re-rendering this whole component (Polaroid,
  // the 500x500-subdivision Avatar plane, the lyrics mesh, three useSpring
  // calls) 60x/sec for no reason. Plain refs carry the same values across
  // frames without triggering React at all.
  const timeRef = useRef(0)
  const idleOpacityRef = useRef(0)
  const polaroidVisibilityRef = useRef(0)
  // Reused (mutated via `.set()`) rather than reallocated every frame —
  // same reasoning as the refs above, just for the Vector2 this frame
  // loop hands off to the shader uniforms. `pointerRelative` below can't
  // get the same treatment: playhead.tsx's recalibration watcher detects
  // movement via `state.globalPointer === prevState.globalPointer`
  // reference-identity, which a mutated-in-place object would always
  // satisfy, silently breaking it — that one needs a fresh Vector2.
  const pointerPositionRef = useRef(new Vector2())

  // Swap progress (see SWAP_OUT_SECONDS): 0 at rest, 1 fully out. Read from the store non-reactively, like everything else here.
  const swapProgressRef = useRef(0)
  const swapPhaseRef = useRef<SwapPhase>('idle')
  // The drag offset actually applied, in CSS pixels (see swapDrag).
  const dragOffsetRef = useRef(0)
  const fadeRef = useRef(1)
  const lastSwapPosition = useRef(new Vector3(0, 0, POLAROID_Z))
  const velocityRef = useRef(new Vector2())
  const velocityTarget = useRef(new Vector2())
  const bendTarget = useRef(new Vector2())
  const developRef = useRef(1)
  // Whether the dream on show has started playing yet (it shows a blank,
  // living print until then, as a swap does), and the blank print's water, with the pointer where it was last frame
  // (CSS px, and on the photo in UV).
  const startedRef = useRef(false)
  // Seconds since the last swap's arrival started (Infinity = none).
  const revealRef = useRef(Infinity)
  // The phone's tilt as a pointer (0-2 each way): eased toward the tilt's
  // own reading.
  const tiltPointer = useRef(new Vector2(1, 1))
  const tiltTarget = useRef(new Vector2(1, 1))
  const water = useMemo(() => createWaterSim(), [])
  useEffect(() => () => water.dispose(), [water])
  const lastPointerPx = useRef(new Vector2(-1, -1))
  const lastPointerUv = useRef(new Vector2(-1, -1))
  // How much the water's over the playing photo (see WATER_PLAY_EASE).
  const waterPlay = useRef(0)
  // The avatar's hold against a finger (see TOUCH_REVEAL_EASE), and the
  // finger as a pointer (0-2 each way).
  const touchReveal = useRef(1)
  const fingerRelative = useRef(new Vector2(1, 1))
  // How grey the avatar is (see DESATURATE_EASE).
  const desaturateRef = useRef(0)
  // A finger on the screen: on a phone, the tilt only stirs the water
  // while one's down (pressing or dragging), so it isn't always moving,
  // and the avatar fades only for it, not the tilt.
  const touching = useRef(false)
  useEffect(() => {
    const handleDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') touching.current = true
    }

    const handleUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch') touching.current = false
    }

    window.addEventListener('pointerdown', handleDown)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointerdown', handleDown)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [])
  const pointerUv = useRef(new Vector2())
  const avatarFollow = useRef<Group>(null)
  const avatarOffsetRef = useRef(0)
  const rippleRef = useRef(-1)
  // The polaroid's own, not the material's default: shaderMaterial shares
  // default uniform objects between instances, so .set() on the default
  // would ripple the avatar and lyrics too.
  const rippleUniform = useRef(new Vector3(0.5, 0.5, -1))
  // Scratch objects for projecting the photo's bounds to the screen.
  const photoBox = useRef(new Box3())
  const corner = useRef(new Vector3())

  const [{ scale }, scaleApi] = useSpring(() => ({
    scale: 0,
    config: config.molasses,
  }))
  const { position } = useSpring({
    position: [0, 0.04, -0.85],
  })

  const { width: w, height: h } = useThree((state) => state.viewport)

  const [{ position: polaroidPosition }, polaroidApi] = useSpring(() => ({
    position: [0, -h * 1.6, 0],
    config: { precision: 0.0001, ...config.molasses },
  }))

  useFrame((state, delta) => {
    const video = texture.source.data
    const isPlaying = isVideoPlaying(video)

    const time =
      isPlaying && Math.abs(timeRef.current - video.currentTime) < 1
        ? timeRef.current + delta
        : video.currentTime
    timeRef.current = time

    let pointerX = 0
    let pointerY = 0

    if (isMobile) {
      // The phone's tilt stands in for the pointer. Wrapped to ±π first (an
      // angle passing ±180° otherwise flipped the pointer from one edge to
      // the other), then eased (TILT_EASE per second) — the raw readings
      // are noisy, and jittered the polaroid and everything keyed off the
      // pointer.
      const target = tiltTarget.current.set(
        MathUtils.clamp(-wrapAngle(tilt[1]) * 2 + 1.0, 0, 2),
        MathUtils.clamp(wrapAngle(tilt[0]) + 1.0, 0, 2)
      )
      tiltPointer.current.lerp(target, 1 - Math.exp(-TILT_EASE * delta))
      pointerX = tiltPointer.current.x
      pointerY = tiltPointer.current.y
    } else if (!isMobile && !isTouch) {
      pointerX = MathUtils.lerp(pointerX, state.pointer.x + 1.0, 1.0)
      pointerY = MathUtils.lerp(pointerY, state.pointer.y + 1.0, 1.0)
    } else if (!isMobile && isTouch) {
      pointerX = MathUtils.lerp(1 - Math.sin(time / 4) / 4, pointerX + 1.0, 4.0)
      pointerY = MathUtils.lerp(1 - Math.sin(time / 2) / 8, pointerY + 1.0, 4.0)
    }

    const pointerPosition = pointerPositionRef.current.set(
      pointerX * state.size.width,
      pointerY * state.size.height
    )
    const pointerRelative = new Vector2(pointerX, pointerY)
    setGlobalPointer(pointerRelative)

    for (const material of [
      polaroidMaterial.current,
      avatarMaterial.current,
      lyricsMaterial.current,
    ]) {
      if (!material) continue
      material.uTime = time
      material.uPointerPos = pointerPosition
      material.uPointerRelative = pointerRelative
    }

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

    polaroidVisibilityRef.current = MathUtils.lerp(
      polaroidVisibilityRef.current,
      !dream || resetting ? 2 : 0,
      0.1
    )
    polaroidApi.start({
      position: [0, polaroidVisibilityRef.current * -h * 1.6, 0],
    })

    scaleApi.start({ scale: MathUtils.clamp(time / 8.0, 1.05, 1.125) })

    const { swapPhase, swapDirection, setSwapPhase } = useStore.getState()
    // Split, a swap only changes the dream video: the song plays on, and
    // the new dream crossfades in rather than developing from blank.
    const splitNow = isSplit(useStore.getState().dream ?? lastDream.current)
    // Waiting on video: the first dream until it can play (a blank print,
    // developing once it's ready), or a swap.
    const currentDream = useStore.getState().dream
    if (!currentDream) startedRef.current = false
    else if (
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
      (!splitNow || frontReady())
    )
      startedRef.current = true
    const starting = !!currentDream && !startedRef.current
    playback.waiting = starting || (!!currentDream && swapPhase !== 'idle')
    // The avatar drains to grey while the next dream's loading — a swap's
    // wait, or after one that came back before its video arrived (the
    // polaroid still showing the last dream) — and colours back once it's
    // there (DESATURATE_EASE per second).
    const loadingDream =
      playback.waiting ||
      (splitNow && !!currentDream && shownDream() !== currentDream.id)
    desaturateRef.current = MathUtils.damp(
      desaturateRef.current,
      loadingDream ? 1 : 0,
      DESATURATE_EASE,
      delta
    )
    if (avatarMaterial.current)
      avatarMaterial.current.uDesaturate = desaturateRef.current
    if (starting) developRef.current = 0
    // Mid-swap the photo's a blank print (uDevelop below), so the next
    // dream can just be there when it develops.
    if (splitNow && swapPhase !== 'idle') snapCrossfade()
    else stepCrossfade(delta)
    for (const material of [polaroidMaterial.current, lyricsMaterial.current])
      if (material) material.uDreamMix = dreamVideo.mix
    if (swapPhase !== swapPhaseRef.current) {
      if (swapPhase === 'out' && !splitNow) fadeOutAudio(video)
      // The dream this swap brings, warm behind already if it's the one
      // the last swap's direction pointed to; otherwise it starts now.
      if (swapPhase === 'out' && splitNow) warmDream(adjacentDream(swapDirection))

      if (swapPhase === 'in') {
        developRef.current = 0
        revealRef.current = 0
        rippleRef.current = -1
      }


      swapPhaseRef.current = swapPhase
    }

    if (swapDrag.active) dragOffsetRef.current = swapDrag.dx
    else
      dragOffsetRef.current = MathUtils.lerp(
        dragOffsetRef.current,
        0,
        DRAG_RETURN
      )

    // The visible world per unit of `w`/`h` at the polaroid's depth, inside
    // its group. `w` and `h` are the viewport at z = 0; the polaroid sits
    // further back (and inside the 1.1x scaled group below), where more is
    // in view, and the camera zooms out on narrow screens. Used to keep the
    // drag 1:1 with the pointer.
    const cameraZ = state.camera.position.z
    const depth = (cameraZ - POLAROID_Z * MAIN_SCALE) / cameraZ
    const view = depth / MAIN_SCALE / (state.camera.zoom || 1)

    if (swapPhase === 'out') {
      swapProgressRef.current = Math.min(
        1,
        swapProgressRef.current + delta / SWAP_OUT_SECONDS
      )
      if (swapProgressRef.current === 1) commitSwap(video)
    } else if (swapPhase === 'in') {
      swapProgressRef.current = Math.max(
        0,
        swapProgressRef.current - delta / SWAP_IN_SECONDS
      )
      if (swapProgressRef.current === 0) setSwapPhase('idle')
    }

    if (swapGroup.current) {
      // Drag offset in CSS px, to world units at the polaroid (see `view`).
      const drag = (dragOffsetRef.current * w * view) / state.size.width

      // The avatar trails the drag, a little and a little behind.
      avatarOffsetRef.current = MathUtils.lerp(
        avatarOffsetRef.current,
        drag * AVATAR_FOLLOW,
        AVATAR_FOLLOW_EASE
      )
      if (avatarFollow.current) {
        avatarFollow.current.position.x = avatarOffsetRef.current
        avatarFollow.current.rotation.z =
          -avatarOffsetRef.current * AVATAR_FOLLOW_TILT
      }

      swapGroup.current.position.set(
        drag,
        -Math.abs(drag) * DRAG_DIP,
        POLAROID_Z
      )
      swapGroup.current.rotation.set(0, 0, -drag * DRAG_TILT)

      const step = (1 / 60 / Math.max(delta, 1e-3)) / PHOTO_WIDTH
      const target = velocityTarget.current
        .set(
          (swapGroup.current.position.x - lastSwapPosition.current.x) * step,
          (swapGroup.current.position.y - lastSwapPosition.current.y) * step
        )
        .clampLength(0, VELOCITY_MAX)
      lastSwapPosition.current.copy(swapGroup.current.position)
      velocityRef.current.lerp(target, VELOCITY_EASE)
      if (velocityRef.current.lengthSq() < 1e-7) velocityRef.current.set(0, 0)
      if (polaroidMaterial.current)
        polaroidMaterial.current.uVelocity = velocityRef.current

      const v = velocityRef.current
      const held =
        (Math.abs(dragOffsetRef.current) / commitDistance()) * BEND_HELD
      const bendX = Math.min(Math.abs(v.x) * BEND_PER_VELOCITY + held, BEND_MAX)
      const bendY = Math.min(Math.abs(v.y) * BEND_PER_VELOCITY, BEND_MAX)
      polaroidBend.value.lerp(bendTarget.current.set(-bendX, -bendY), BEND_EASE)
      if (polaroidMaterial.current)
        polaroidMaterial.current.uBend = polaroidBend.value
    }

    // Developing and the landing ripple, after a swap.
    developRef.current = Math.min(1, developRef.current + delta / DEVELOP_SECONDS)
    if (
      swapPhase === 'in' &&
      rippleRef.current < 0 &&
      swapProgressRef.current <= LANDING_AT
    )
      rippleRef.current = 0
    else if (rippleRef.current >= 0) rippleRef.current += delta
    if (polaroidMaterial.current) {
      // Staying put, the photo fades to a blank print on the way out, and
      // stays blank until the next develops.
      polaroidMaterial.current.uDevelop =
        swapPhase === 'in' || swapPhase === 'idle'
          ? developRef.current
          : swapPhase === 'out'
            ? 1 - swapProgressRef.current
            : 0
      rippleUniform.current.z = rippleRef.current
      polaroidMaterial.current.uRipple = rippleUniform.current
    }

    // The lyrics lose the last dream's colour with it, and take on the
    // next's as it develops.
    if (lyricsMaterial.current)
      lyricsMaterial.current.uFillDevelop =
        polaroidMaterial.current?.uDevelop ?? 1

    // Dragging toward the previous dream warms it instead of the next, so
    // either way the swap has it ready.
    if (splitNow && swapDrag.active && Math.abs(swapDrag.dx) > 24 && swapPhase === 'idle') {
      const target = adjacentDream(directionOf(swapDrag.dx))
      if (target && backSlot().id !== target.id) warmDream(target)
    }

    // The music's pulse. (The cursor's liquid wake is drawn over the whole
    // scene by components/wake-pass.tsx.)
    const pulse = readPulse()
    for (const material of [
      polaroidMaterial.current,
      avatarMaterial.current,
      lyricsMaterial.current,
    ]) {
      if (material) material.uPulse = pulse
    }

    if (swapGroup.current) {
      swapGroup.current.scale.setScalar(1 + pulse * PULSE_SCALE)
    }

    let fadeTarget = 1
    if (swapPhase === 'out' || swapPhase === 'loading') fadeTarget = 0
    else if (swapPhase === 'in') fadeTarget = 1 - swapProgressRef.current
    else if (swapDrag.active)
      fadeTarget = MathUtils.clamp(
        1 - Math.abs(swapDrag.dx) / (commitDistance() * FADE_BY_DRAG),
        0,
        1
      )
    fadeRef.current = MathUtils.lerp(
      fadeRef.current,
      fadeTarget,
      swapPhase === 'out' ? FADE_EASE * 2 : FADE_EASE
    )
    if (fadeRef.current > 0.999) fadeRef.current = 1
    // Gone, not nearly: a last trace of the dissolve read as a ghost of
    // the avatar over the polaroid while the next dream loaded.
    if (swapPhase === 'loading') fadeRef.current = 0
    const avatarFade = fadeRef.current
    if (avatarFollow.current) avatarFollow.current.visible = avatarFade > 0.01
    // Only the avatar: the song plays on through a swap, so its words do
    // too.
    if (avatarMaterial.current) avatarMaterial.current.uFade = avatarFade

    // Full strength for a while after a swap, then back to the pointer.
    // With the phone's tilt as the pointer it holds whole whatever the
    // tilt, and fades only while a finger's on the screen, as the finger
    // nears it (TOUCH_REVEAL_EASE per second, in and back).
    revealRef.current += delta
    touchReveal.current = MathUtils.damp(
      touchReveal.current,
      touching.current ? 0 : 1,
      TOUCH_REVEAL_EASE,
      delta
    )
    if (avatarMaterial.current) {
      const afterSwap = MathUtils.clamp(
        1 - (revealRef.current - REVEAL_HOLD) / REVEAL_RELEASE,
        0,
        1
      )
      avatarMaterial.current.uReveal = isMobile
        ? Math.max(afterSwap, touchReveal.current)
        : afterSwap
      if (isMobile && touching.current)
        avatarMaterial.current.uPointerRelative = fingerRelative.current.set(
          state.pointer.x + 1,
          state.pointer.y + 1
        )
    }

    // The photo's bounds on screen, for the cursor and tap detection.
    const photo = polaroidVisible.current
      ? (polaroidIntersect as RefObject<Mesh>).current
      : null
    polaroidRect.visible = !!photo && !!dream && !resetting
    if (photo && polaroidRect.visible) {
      const box = photoBox.current.setFromObject(photo)
      polaroidRect.left = polaroidRect.top = Infinity
      polaroidRect.right = polaroidRect.bottom = -Infinity
      for (let i = 0; i < 8; i++) {
        corner.current
          .set(
            i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z
          )
          .project(state.camera)
        const sx = ((corner.current.x + 1) / 2) * state.size.width
        const sy = ((1 - corner.current.y) / 2) * state.size.height
        polaroidRect.left = Math.min(polaroidRect.left, sx)
        polaroidRect.right = Math.max(polaroidRect.right, sx)
        polaroidRect.top = Math.min(polaroidRect.top, sy)
        polaroidRect.bottom = Math.max(polaroidRect.bottom, sy)
      }
    }

    // The blank print's water: stirred where the pointer moves over it,
    // run only while the print's blank (and stilled once it isn't).
    if (polaroidMaterial.current) {
      // The tilt's pointer on a phone; the real one otherwise.
      const px = isMobile
        ? (tiltPointer.current.x / 2) * state.size.width
        : ((state.pointer.x + 1) / 2) * state.size.width
      const py = isMobile
        ? (1 - tiltPointer.current.y / 2) * state.size.height
        : ((1 - state.pointer.y) / 2) * state.size.height
      const uv = pointerUv.current.set(
        (px - polaroidRect.left) / (polaroidRect.right - polaroidRect.left),
        (polaroidRect.bottom - py) / (polaroidRect.bottom - polaroidRect.top)
      )
      const over =
        polaroidRect.visible && uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1
      const speed =
        lastPointerPx.current.x < 0
          ? 0
          : Math.hypot(px - lastPointerPx.current.x, py - lastPointerPx.current.y)
      lastPointerPx.current.set(px, py)
      const blank = (polaroidMaterial.current.uDevelop ?? 1) < 0.3
      // It runs over the playing photo too, stirred by the mouse or a
      // phone's tilt — on a phone only while a finger's down, pressing or
      // dragging (see touching).
      const playing = (isMobile || !isTouch) && !!dream && !resetting
      waterPlay.current = MathUtils.damp(
        waterPlay.current,
        playing && !blank ? 1 : 0,
        WATER_PLAY_EASE,
        delta
      )
      polaroidMaterial.current.uWaterPlay = blank ? 0 : waterPlay.current
      if (blank || waterPlay.current > 0.001) {
        const from = lastPointerUv.current.x < 0 ? uv : lastPointerUv.current
        const fullSpeed = isMobile ? TILT_FULL_SPEED : EMULSION_FULL_SPEED
        water.step(
          state.gl,
          from,
          uv,
          over && (!isMobile || touching.current)
            ? Math.min(speed / fullSpeed, 1)
            : 0,
          blank ? undefined : WATER_PLAY_DAMPING
        )
      } else water.clear(state.gl)
      if (over) lastPointerUv.current.copy(uv)
      else lastPointerUv.current.set(-1, -1)
      polaroidMaterial.current.uWater = water.texture
    }

    if (!isMobile && !isTouch) {
      idleOpacityRef.current = MathUtils.lerp(
        idleOpacityRef.current,
        idle && video.currentTime > 15 ? 1.0 : 0.0,
        0.05
      )
      if (avatarMaterial.current) {
        avatarMaterial.current.uIdle = idleOpacityRef.current
      }
    }
  })

  return (
    <group ref={main} {...props}>
      <animated.group
        scale={MAIN_SCALE}
        position={polaroidPosition as unknown as Vector3}
      >
        {/* Dreaming — dragging or tapping it swaps dreams (see
            utils/swap-gesture.ts). The swap
            animation moves this outer group; the pointer tilt (above)
            turns the polaroid inside it. */}
        {/* The dream, filling the screen behind everything */}
        <DreamGlow
          video={videoElement}
          texture={texture}
          dreamTextures={split ? dreamTextures : null}
          fade={fadeRef}
          develop={developRef}
        />

        <group ref={swapGroup} position={[0, 0, POLAROID_Z]}>
          <Polaroid
            intersectRef={polaroidIntersect as RefObject<Mesh>}
            name="polaroid"
            scale={0.35}
            passthroughMaterial={
              <videoMaterial
                ref={polaroidMaterial}
                key={VideoMaterial.key}
                uTexture={texture}
                uDream={dreamTextures[0]}
                uDreamNext={dreamTextures[1]}
                uSplit={split ? 1 : 0}
                uFrameSelected={7}
                uFrameTotal={frameTotal}
                uFrameMask={3}
                uOpacity={1}
                uFrameOverlay={3}
                uDark={dark}
              />
            }
          />
        </group>

        {/* Avatar — in a group that trails the polaroid's drag (its own
            position is the spring's) */}
        <group ref={avatarFollow}>
          <animated.mesh
            position={position as unknown as Vector3}
            scale={scale}
            name="avatar"
          >
            <planeGeometry args={[1, 1, 256, 256]} />
            <videoMaterial
              ref={avatarMaterial}
              key={VideoMaterial.key}
              uTexture={texture}
              uFrameSelected={2}
              uFrameSketch={6}
              uFrameMask={4}
              uFrameDepth={5}
              uFrameTotal={frameTotal}
              uAvatar={1}
              uOpacity={1}
              uMaskIntensity={1}
              uDepthStrength={DEPTH_STRENGTH}
              uShapeRadius={DEPTH_SHAPE_RADIUS}
              uEdgeRadius={DEPTH_EDGE_RADIUS}
              uSharpen={AVATAR_SHARPEN}
              uHash={AVATAR_HASH}
              uDark={dark}
            />
          </animated.mesh>
        </group>

        {/* Lyrics */}
        <mesh position={[0, -0.4, 0.1]}>
          <planeGeometry args={[1, 1, 1]} />
          <videoMaterial
            ref={lyricsMaterial}
            key={VideoMaterial.key}
            uTexture={texture}
            uDream={dreamTextures[0]}
            uDreamNext={dreamTextures[1]}
            uSplit={split ? 1 : 0}
            uFrameSelected={7}
            uFrameMask={1}
            uMaskIntensity={1}
            uFrameTotal={frameTotal}
            uInvert={1}
            uOpacity={1}
            uBackgroundMix={0.5}
            uDark={dark}
          />
        </mesh>
      </animated.group>
    </group>
  )
}

export default Main
