import { MutableRefObject, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending,
  Color,
  NormalBlending,
  ShaderMaterial,
  Texture,
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
// (the dream fills it), how far behind it sits, how soft it's blurred (UV
// radius of the dream panel), where its fade to clear starts and ends
// (radius from the centre), and its strength per scheme — additive in
// dark mode, so it lights the dark page; a plain wash in light mode, where
// adding would just clip to white.
const GLOW_SIZE: [number, number] = [2.3, 2.3]
const GLOW_Z = -1.15
const GLOW_BLUR = 0.035
const GLOW_FADE: [number, number] = [0.12, 0.5]
const GLOW_OPACITY = { light: 0.55, dark: 0.6 }
// The page tint's strength per scheme. Its colour is pushed toward full
// saturation first, so a pale dream still tints.
const TINT_ALPHA = { light: 0.18, dark: 0.22 }
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

// The dream panel, blurred over a ring of taps around each pixel, faded to
// clear toward the edge of the plane.
const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uOpacity;

  vec3 dreamAt(vec2 uv) {
    float x = clamp(uv.x, 1.0 / 512.0, 1.0 - 1.0 / 512.0);
    return texture2D(uTexture, vec2((x + ${(DREAM_PANEL - 1).toFixed(1)}) / ${PANELS.toFixed(1)}, clamp(uv.y, 0.0, 1.0))).rgb;
  }

  void main() {
    vec3 color = dreamAt(vUv) * 0.2;
    for (int i = 0; i < 12; i++) {
      float angle = float(i) / 12.0 * 6.2832;
      vec2 tap = vec2(cos(angle), sin(angle)) * ${GLOW_BLUR.toFixed(3)};
      color += dreamAt(vUv + tap) * (0.8 / 24.0);
      color += dreamAt(vUv + tap * 0.5) * (0.8 / 24.0);
    }
    float fade = smoothstep(${GLOW_FADE[1].toFixed(2)}, ${GLOW_FADE[0].toFixed(2)}, length(vUv - 0.5));
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
   *  the glow dips through a swap with them. */
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
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { uTexture: { value: texture }, uOpacity: { value: 0 } },
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
    if (
      sampler &&
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
      } catch {
        // A cross-origin video without CORS can't be read; keep the last.
      }
    }

    shown.current.lerp(target.current, EASE)
    const presence = dream ? fade.current : 0

    material.uniforms.uOpacity.value = GLOW_OPACITY[scheme] * presence

    // The page tint: the shown colour pushed to full saturation, at a
    // gentle alpha. Only written when it changes (it repaints the page).
    shown.current.getHSL(scratchHsl)
    const vivid = scratchColor.setHSL(
      scratchHsl.h,
      Math.min(1, scratchHsl.s * 2 + 0.2),
      0.55
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
