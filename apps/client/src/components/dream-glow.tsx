import { MutableRefObject, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending,
  Color,
  NormalBlending,
  ShaderMaterial,
  Texture,
  Vector2,
} from 'three'
import { useStore } from '../store'

// The dream spilling out of its frame: the dream panel itself, larger than
// the polaroid, blurred, and fading out at its edges behind it. And its
// colour pooling faintly in the page's bowl (see --dream-tint in
// index.css): the dream panel (7 of the composite video) is drawn into a
// tiny canvas a few times a second and averaged, and the tint eases toward
// that, so it drifts with the video rather than flickering.

// How often the dream's colour is sampled, and how quickly (per frame) the
// shown colour eases toward it.
const SAMPLE_MS = 250
const EASE = 0.04
// The spill behind the polaroid: its size relative to the polaroid's group
// (the dream fills it), how far behind it sits — well back, so the
// polaroid's tilt never swings its edge into it — and its fade to clear: a
// soft round falloff (a gaussian, FADE_FALLOFF steep, reaching nothing at
// the plane's edge), with no edge or corners to read as a halo. Its
// strength per scheme — additive in dark
// mode, so it lights the dark page; a plain wash in light mode, where
// adding would just clip to white.
const GLOW_SIZE: [number, number] = [4.0, 4.0]
const GLOW_Z = -2.4
// How many photo-widths the spill spans on screen (it's larger, and much
// further back, than the polaroid's photo) — to map its pixels onto the
// photo, so its colour-or-grey follows the photo's (below).
const SPILL_TO_PHOTO = 2.3
const FADE_FALLOFF = 3.0
const GLOW_OPACITY = { light: 0.5, dark: 0.45 }
// The page tint's strength per scheme. Its colour is pushed toward full
// saturation first, so a pale dream still tints.
const TINT_ALPHA = { light: 0.15, dark: 0.1 }
// The spill and tint fade in (and out) at this much per frame, once the
// dream's own colour has been sampled — so entering a dream doesn't flash
// whatever colour was last seen. Samples taken within SETTLE_MS of a new
// dream are skipped, while its video is still loading or seeking.
const PRESENCE_EASE = 0.02
const SETTLE_MS = 400
// The composite video's panel count, and the dream panel (1-based).
const PANELS = 7
const DREAM_PANEL = 7

// Scratch objects for the per-frame tint maths.
const scratchHsl = { h: 0, s: 0, l: 0 }
const scratchColor = new Color()

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// The dream panel, sharp, faded out softly toward its edges — in
// colour or grey just as the polaroid's photo is (video-material.tsx's
// overlay): colour near the pointer, grey further away, by the same radii,
// measured in photo space. Its own grey, not the photo's grey portrait
// background (panel 3), which has hard-edged regions that showed as sharp
// rectangles behind the polaroid.
const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uOpacity;
  uniform vec2 uPointerRelative;

  vec3 panelAt(float panel, vec2 uv) {
    float x = clamp(uv.x, 1.0 / 512.0, 1.0 - 1.0 / 512.0);
    return texture2D(uTexture, vec2((x + panel - 1.0) / ${PANELS.toFixed(1)}, clamp(uv.y, 0.0, 1.0))).rgb;
  }

  void main() {
    vec2 photoUv = (vUv - 0.5) * ${SPILL_TO_PHOTO.toFixed(2)} + 0.5;
    float dist = distance(clamp(uPointerRelative / 2.0, 0.15, 0.85), photoUv);
    float grey = clamp((dist - 0.15) / 0.35, 0.0, 1.0);
    vec3 dream = panelAt(${DREAM_PANEL.toFixed(1)}, vUv);
    vec3 color = mix(dream, vec3(dot(dream, vec3(0.299, 0.587, 0.114))), grey);
    float r = length(vUv - 0.5) * 2.0;
    float floorAt = exp(-${FADE_FALLOFF.toFixed(1)});
    float fade = max(0.0, (exp(-${FADE_FALLOFF.toFixed(1)} * r * r) - floorAt) / (1.0 - floorAt));
    gl_FragColor = vec4(color, fade * uOpacity);
  }
`

function DreamGlow({
  video,
  texture,
  fade,
}: {
  video: HTMLVideoElement
  /** The composite video's texture, for the spill. */
  texture: Texture
  /** 0-1: how present the avatar and lyrics are (main.tsx's fadeRef), so
   *  the spill fades as the polaroid's dragged, and is gone through a
   *  swap, with them. Followed directly, not through the slow presence
   *  ease below. */
  fade: MutableRefObject<number>
}) {
  const scheme = useStore((state) => state.colorScheme)
  const dream = useStore((state) => state.dream)

  const sampler = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    return canvas.getContext('2d', { willReadFrequently: true })
  }, [])
  const target = useRef(new Color(0.5, 0.5, 0.5))
  const shown = useRef(new Color(0.5, 0.5, 0.5))
  const lastSample = useRef(0)
  const lastTint = useRef('')
  // The dream the colour was last sampled for, when it changed, and
  // whether it has a sample yet; and the spill and tint's eased presence.
  const sampledFor = useRef<string | null>(null)
  const dreamSince = useRef(0)
  const hasSample = useRef(false)
  const presenceRef = useRef(0)
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uTexture: { value: texture },
          uOpacity: { value: 0 },
          uPointerRelative: { value: new Vector2(1, 1) },
        },
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [texture]
  )

  useEffect(() => {
    material.blending = scheme === 'dark' ? AdditiveBlending : NormalBlending
    material.needsUpdate = true
  }, [material, scheme])

  // No dream, no tint.
  useEffect(() => {
    if (dream) return
    document.documentElement.style.setProperty('--dream-tint-alpha', '0')
  }, [dream])

  useFrame(() => {
    const now = performance.now()
    if ((dream?.id ?? null) !== sampledFor.current) {
      sampledFor.current = dream?.id ?? null
      dreamSince.current = now
      hasSample.current = false
    }

    if (
      sampler &&
      dream &&
      now - dreamSince.current > SETTLE_MS &&
      now - lastSample.current > SAMPLE_MS &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth
    ) {
      lastSample.current = now
      const panel = video.videoWidth / PANELS
      try {
        sampler.drawImage(
          video,
          panel * (DREAM_PANEL - 1),
          0,
          panel,
          video.videoHeight,
          0,
          0,
          8,
          8
        )
        const data = sampler.getImageData(0, 0, 8, 8).data
        let r = 0
        let g = 0
        let b = 0
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
        }

        const count = data.length / 4
        target.current.setRGB(r / count / 255, g / count / 255, b / count / 255)
        // A new dream's first sample is its colour straight away, rather
        // than an ease from the last dream's.
        if (!hasSample.current) shown.current.copy(target.current)
        hasSample.current = true
      } catch {
        // A cross-origin video without CORS can't be read; keep the last.
      }
    }

    shown.current.lerp(target.current, EASE)
    const goal = dream && hasSample.current ? 1 : 0
    presenceRef.current += (goal - presenceRef.current) * PRESENCE_EASE
    const presence = presenceRef.current * fade.current

    material.uniforms.uOpacity.value = GLOW_OPACITY[scheme] * presence
    // The pointer as the polaroid's photo sees it (set by main.tsx).
    material.uniforms.uPointerRelative.value = useStore.getState().globalPointer

    // The page tint: the shown colour, a little more saturated, at a
    // gentle alpha. Only written when it changes (it repaints the page).
    shown.current.getHSL(scratchHsl)
    const vivid = scratchColor.setHSL(
      scratchHsl.h,
      Math.min(1, scratchHsl.s * 1.4 + 0.1),
      0.5
    )
    const tint = `${Math.round(vivid.r * 255)} ${Math.round(vivid.g * 255)} ${Math.round(vivid.b * 255)}`
    const alpha = (TINT_ALPHA[scheme] * presence).toFixed(3)
    const key = `${tint}/${alpha}`
    if (key !== lastTint.current) {
      lastTint.current = key
      const root = document.documentElement.style
      root.setProperty('--dream-tint', tint)
      root.setProperty('--dream-tint-alpha', alpha)
    }
  })

  return (
    <mesh position={[0, 0, GLOW_Z]} scale={[...GLOW_SIZE, 1]} material={material}>
      <planeGeometry />
    </mesh>
  )
}

export default DreamGlow
