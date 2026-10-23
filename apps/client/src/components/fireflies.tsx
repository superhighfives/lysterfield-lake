import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useScroll } from '@react-three/drei'
import { dreamVideo } from '../utils/dream-video'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  MathUtils,
  NormalBlending,
  ShaderMaterial,
} from 'three'
import { useStore } from '../store'

// Bugs drifting over the lake: soft points that wander on slow, overlapping
// sine paths, with a fast low-amplitude jitter on top (the darting) and a
// per-bug flicker. Warm glowing fireflies in dark mode (additive); on a light
// page an additive glow would vanish, so there they're small dark gnats.
//
// Two layers, so they sit *in* the scene rather than on top of it:
// - `back`: depth-tested, so anything genuinely in front (the player's
//   polaroid, the carousel's cards) hides them.
// - `front`: a few, closer to the camera, drawn after everything with no
//   depth test.
// three.js sorts transparent objects by their nearest group's renderOrder
// before their own, so each layer's order goes on a wrapping group.
//
// Fixed in view (rendered outside the scrolling content), drifting with the
// page by only a fraction of its scroll — a little parallax. While a video plays
// the bugs fly off out of frame, and drift back when it stops. Skipped entirely for
// people who've asked for reduced motion.

// How quickly the swarm clears out when a video starts, and comes back
// when it stops, as MathUtils.damp rates: a few seconds out, well under a
// second back.
const SCATTER_RATE_OUT = 0.8
const SCATTER_RATE_BACK = 5
// The swarm's first arrival, when the scene appears: gentler than the
// quick return from the player, so it reads as an entrance.
const SCATTER_RATE_INTRO = 1.2
// The swarm's vertical band, as a multiple of the viewport height — a
// little taller than the frame so the scroll-parallax wrap happens off it.
const SPREAD_Y = 1.3

const BACK_COUNT = 70
const FRONT_COUNT = 12
// renderOrder for each layer: before anything else in the scene, and after
// everything.
const BACK_RENDER_ORDER = -1
const FRONT_RENDER_ORDER = 3000

const vertexShader = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uScatter;
  uniform float uExtent;
  uniform float uScroll;
  uniform float uParallax;
  uniform float uSpreadY;
  varying float vFlicker;

  void main() {
    // Each bug gets its own frequencies and phases from its seed, so no two
    // move in step.
    vec4 s = aSeed;
    float t = uTime;
    vec3 wander = vec3(
      sin(t * (0.13 + s.x * 0.17) + s.y * 6.28) * 0.18,
      sin(t * (0.11 + s.z * 0.15) + s.w * 6.28) * 0.12,
      sin(t * (0.09 + s.y * 0.12) + s.x * 6.28) * 0.10
    );
    vec3 dart = vec3(
      sin(t * (5.0 + s.w * 4.0) + s.z * 6.28),
      sin(t * (6.0 + s.x * 5.0) + s.y * 6.28),
      0.0
    ) * 0.006;

    // While a video plays, each bug flies off radially from the centre of
    // the frame, staggered so they don't leave as one ring, accelerating
    // as they go (squared), far enough to clear the frame from anywhere.
    vec2 away = normalize(position.xy + vec2(0.0001, 0.0001));
    float leave = smoothstep(0.0, 1.0, clamp(uScatter * 1.6 - s.z * 0.6, 0.0, 1.0));
    vec3 scatter = vec3(away * leave * leave * uExtent * (1.0 + s.y), 0.0);

    // Scroll parallax: the swarm drifts with the page by a fraction of its
    // scroll (more for the near layer), wrapping within its own band so it
    // never runs out — the wrap happens just past the frame's edge.
    vec3 base = position;
    base.y = mod(base.y + uScroll * uParallax + uSpreadY * 0.5, uSpreadY) - uSpreadY * 0.5;

    vec4 mvPosition = modelViewMatrix * vec4(base + wander + dart + scatter, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = uSize * uPixelRatio * (1.0 / -mvPosition.z) * (0.6 + s.x * 0.8);

    // Mostly lit, with the occasional slow dim-out.
    float pulse = sin(t * (0.7 + s.z * 1.3) + s.w * 6.28);
    vFlicker = smoothstep(-0.6, 0.4, pulse);
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFlicker;

  void main() {
    // A soft round dot with a bright core.
    float d = length(gl_PointCoord - 0.5);
    float glow = pow(smoothstep(0.5, 0.0, d), 2.0);
    gl_FragColor = vec4(uColor, glow * vFlicker * uOpacity);
  }
`

const LOOKS = {
  dark: { color: '#ffd98a', opacity: 0.9, size: 26, blending: AdditiveBlending },
  light: { color: '#4a4334', opacity: 0.55, size: 12, blending: NormalBlending },
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function Swarm({
  count,
  depth,
  renderOrder,
  depthTest,
  parallax,
}: {
  count: number
  /** [near, far] z range, in world units. */
  depth: [number, number]
  renderOrder: number
  depthTest: boolean
  /** Fraction of the page's scroll the layer moves by. */
  parallax: number
}) {
  const { width, height } = useThree((state) => state.viewport)
  const dpr = useThree((state) => state.viewport.dpr)
  const colorScheme = useStore((state) => state.colorScheme)
  const scroll = useScroll()
  // Whether the swarm has finished its first fly-in (see SCATTER_RATE_INTRO).
  const arrived = useRef(false)

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      // Spread a little past the viewport's edges so bugs drift in and out.
      positions[i * 3] = (Math.random() - 0.5) * width * 1.2
      positions[i * 3 + 1] = (Math.random() - 0.5) * height * SPREAD_Y
      positions[i * 3 + 2] = depth[0] + Math.random() * (depth[1] - depth[0])
      for (let j = 0; j < 4; j++) seeds[i * 4 + j] = Math.random()
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4))
    return geometry
  }, [count, width, height, depth[0], depth[1]])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthTest,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: 1 },
          uPixelRatio: { value: 1 },
          uColor: { value: new Color() },
          uOpacity: { value: 1 },
          // Starts fully scattered, so the swarm flies in from the edges
          // when the scene first appears.
          uScatter: { value: 1 },
          uExtent: { value: 1 },
          uScroll: { value: 0 },
          uParallax: { value: parallax },
          uSpreadY: { value: 1 },
        },
      }),
    [depthTest, parallax]
  )

  useEffect(() => {
    const look = LOOKS[colorScheme]
    material.uniforms.uColor.value.set(look.color)
    material.uniforms.uOpacity.value = look.opacity
    material.uniforms.uSize.value = look.size
    material.blending = look.blending
    material.needsUpdate = true
  }, [colorScheme, material])

  useEffect(() => {
    material.uniforms.uPixelRatio.value = dpr
  }, [dpr, material])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material]
  )

  useEffect(() => {
    material.uniforms.uExtent.value = Math.max(width, height)
    material.uniforms.uSpreadY.value = height * SPREAD_Y
  }, [width, height, material])

  useFrame((state, delta) => {
    material.uniforms.uTime.value = state.clock.elapsedTime
    // Eased toward 1 while a dream's video is playing, back to 0 (the bugs
    // drift home) when it pauses or the player closes.
    // Heading back (resetting) counts as stopped straight away, and the
    // return is much quicker than the exit, so the swarm is home before
    // the polaroids slide back up.
    // Playing is read off the video itself as well as the store: arriving
    // straight at a dream (from its URL), the store's flag could miss the
    // start, and the bugs stayed on screen through the song.
    // Held out of frame until the loading pile starts falling away, so the
    // first fly-in is seen as the scene fades in (components/loading.tsx).
    const { dream, videoPlaying, resetting, pileLeaving } = useStore.getState()
    const main = dreamVideo.main
    const playing = videoPlaying || (!!main && !main.paused && !main.ended)
    const target = !pileLeaving || (dream && playing && !resetting) ? 1 : 0
    const scatter = material.uniforms.uScatter
    if (scatter.value < 0.01) arrived.current = true
    scatter.value = MathUtils.damp(
      scatter.value,
      target,
      target > scatter.value
        ? SCATTER_RATE_OUT
        : arrived.current
        ? SCATTER_RATE_BACK
        : SCATTER_RATE_INTRO,
      delta
    )
    // How far the page content has scrolled, in world units (drei's
    // <Scroll> moves it by viewport height * (pages - 1) * offset).
    material.uniforms.uScroll.value =
      height * (scroll.pages - 1) * scroll.offset
  })

  return (
    <group
      ref={(el) => {
        if (el) el.renderOrder = renderOrder
      }}
    >
      <points
        ref={(el) => {
          if (!el) return
          el.renderOrder = renderOrder
          // Positions move in the shader, so the CPU-side bounds are wrong.
          el.frustumCulled = false
        }}
        geometry={geometry}
        material={material}
      />
    </group>
  )
}

function Fireflies() {
  const reducedMotion = useReducedMotion()
  if (reducedMotion) return null

  return (
    <>
      <Swarm
        count={BACK_COUNT}
        depth={[-0.9, 0.3]}
        renderOrder={BACK_RENDER_ORDER}
        depthTest
        parallax={0.35}
      />
      <Swarm
        count={FRONT_COUNT}
        depth={[0.6, 1.1]}
        renderOrder={FRONT_RENDER_ORDER}
        depthTest={false}
        parallax={0.8}
      />
    </>
  )
}

export default Fireflies
