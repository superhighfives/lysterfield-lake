import { ThreeElements, useFrame, useThree } from '@react-three/fiber'
import { RefObject, useRef } from 'react'
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
import { commitSwap, fadeOutAudio } from '../utils/swap-dream'
import { SWAP_ANIMATIONS } from '../utils/swap-poses'
import { readPulse } from '../utils/audio'
import DreamGlow from '../components/dream-glow'
import {
  commitDistance,
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
// Swap poses push the polaroid off-screen by the visible width or height
// at its depth, times this. Measured, the tossed polaroid's tilt and
// perspective cost about a third of that distance on screen, and its
// frame reaches well past the photo, so 1.2 still let a corner peek in
// while the next dream loaded.
const OFFSCREEN_MARGIN = 1.8
const SWAP_REST = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }
// While dragged, the polaroid follows the pointer 1:1 sideways, tilting
// into the drag (radians per world unit) and dipping a little, like a
// photo held by one corner. Let go short of a swap and it eases back.
const DRAG_TILT = 0.25
const DRAG_DIP = 0.06
const DRAG_RETURN = 0.15
// The avatar and lyrics dissolve as a drag goes — gone by this share of
// the way to the release point — stay gone through the swap, and come
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
const VELOCITY_MAX = 0.06
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
// How much of the avatar's pointer fade breaks into stipple (uHash).
const AVATAR_HASH = 0.6
// After a swap the avatar arrives at full strength, wherever the pointer
// is, for REVEAL_HOLD seconds from the landing, then eases back to its
// pointer fade over REVEAL_RELEASE seconds.
const REVEAL_HOLD = 2
const REVEAL_RELEASE = 1
// While the polaroid's dragged, the avatar trails it: AVATAR_FOLLOW of the
// way, eased by AVATAR_FOLLOW_EASE per frame so it lags behind, tilting
// with it by AVATAR_FOLLOW_TILT radians per world unit.
const AVATAR_FOLLOW = 0.35
const AVATAR_FOLLOW_EASE = 0.08
const AVATAR_FOLLOW_TILT = 0.15
// The polaroid swells this much (scale) on each beat.
const PULSE_SCALE = 0.012

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

  // Swap animation progress (see utils/swap-poses.ts): 0 at rest, 1 fully
  // out. Read from the store non-reactively, like everything else here.
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
  // Seconds since the last swap's arrival started (Infinity = none).
  const revealRef = useRef(Infinity)
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
      pointerX = MathUtils.clamp(-tilt[1] * 2 + 1.0, 0, 2)
      pointerY = MathUtils.clamp((tilt[0] / 2) * 2 + 1.0, 0, 2)
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

    const { swapPhase, swapDirection, swapStyle, setSwapPhase } =
      useStore.getState()
    const animation = SWAP_ANIMATIONS[swapStyle]
    if (swapPhase !== swapPhaseRef.current) {
      if (swapPhase === 'out') fadeOutAudio(video)
      if (swapPhase === 'in') {
        developRef.current = 0
        revealRef.current = 0
        rippleRef.current = -1
      }

      if (swapPhase === 'loading') {
        // Off-screen now; the next one comes in from rest.
        swapDrag.committed = false
        dragOffsetRef.current = 0
      }

      swapPhaseRef.current = swapPhase
    }

    if (swapDrag.active) dragOffsetRef.current = swapDrag.dx
    else if (!swapDrag.committed)
      dragOffsetRef.current = MathUtils.lerp(
        dragOffsetRef.current,
        0,
        DRAG_RETURN
      )

    // The visible world per unit of `w`/`h` at the polaroid's depth, inside
    // its group. `w` and `h` are the viewport at z = 0; the polaroid sits
    // further back (and inside the 1.1x scaled group below), where more is
    // in view, and the camera zooms out on narrow screens. Used to keep the
    // drag 1:1 with the pointer and to push swap poses truly off-screen.
    const cameraZ = state.camera.position.z
    const depth = (cameraZ - POLAROID_Z * MAIN_SCALE) / cameraZ
    const view = depth / MAIN_SCALE / (state.camera.zoom || 1)
    const poseW = w * view * OFFSCREEN_MARGIN
    const poseH = h * view * OFFSCREEN_MARGIN

    let pose
    if (swapPhase === 'out') {
      swapProgressRef.current = Math.min(
        1,
        swapProgressRef.current + delta / animation.outDuration
      )
      pose = animation.exit(swapProgressRef.current, swapDirection, poseW, poseH)
      if (swapProgressRef.current === 1) commitSwap(video)
    } else if (swapPhase === 'loading') {
      const held = animation.exit(1, swapDirection, poseW, poseH)
      const hold = animation.hold?.(state.clock.elapsedTime, swapDirection)
      pose = { ...held, ry: held.ry + (hold?.ry ?? 0) }
    } else if (swapPhase === 'in') {
      swapProgressRef.current = Math.max(
        0,
        swapProgressRef.current - delta / animation.inDuration
      )
      pose = animation.enter(swapProgressRef.current, swapDirection, poseW, poseH)
      if (swapProgressRef.current === 0) setSwapPhase('idle')
    }

    if (swapGroup.current) {
      const { x, y, z, rx, ry, rz } = pose ?? SWAP_REST
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
        x + drag,
        y - Math.abs(drag) * DRAG_DIP,
        z + POLAROID_Z
      )
      swapGroup.current.rotation.set(rx, ry, rz - drag * DRAG_TILT)
      // Off-screen while the next dream loads anyway; hidden too, so
      // nothing can peek in however the screen is shaped. Not for a style
      // that shows something while it waits (flip rocks face-down).
      swapGroup.current.visible = swapPhase !== 'loading' || !!animation.hold

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
      polaroidMaterial.current.uDevelop =
        swapPhase === 'in' || swapPhase === 'idle' ? developRef.current : 1
      rippleUniform.current.z = rippleRef.current
      polaroidMaterial.current.uRipple = rippleUniform.current
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
    fadeRef.current = MathUtils.lerp(fadeRef.current, fadeTarget, FADE_EASE)
    if (fadeRef.current > 0.999) fadeRef.current = 1
    for (const material of [avatarMaterial.current, lyricsMaterial.current]) {
      if (material) material.uFade = fadeRef.current
    }

    // Full strength for a while after a swap, then back to the pointer.
    revealRef.current += delta
    if (avatarMaterial.current)
      avatarMaterial.current.uReveal = MathUtils.clamp(
        1 - (revealRef.current - REVEAL_HOLD) / REVEAL_RELEASE,
        0,
        1
      )

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
        {/* The dream's colour, glowing out from behind the polaroid */}
        <DreamGlow video={videoElement} fade={fadeRef} />

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
                uFrameSelected={7}
                uFrameTotal={7}
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
              uFrameTotal={7}
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
            uFrameSelected={7}
            uFrameMask={1}
            uMaskIntensity={1}
            uFrameTotal={7}
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
