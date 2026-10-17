import { MutableRefObject, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  MeshBasicMaterial,
  NormalBlending,
} from 'three'
import { useStore } from '../store'

// The dream's own colour, glowing out from behind the polaroid and pooling
// faintly in the page's bowl (see --dream-tint in index.css). The dream
// panel (7 of the composite video) is drawn into a tiny canvas a few times
// a second and averaged; the glow and the tint ease toward that, so they
// drift with the video rather than flicker.

// How often the dream's colour is sampled, and how quickly (per frame) the
// shown colour eases toward it.
const SAMPLE_MS = 250
const EASE = 0.04
// The glow behind the polaroid: its size relative to the polaroid's group,
// how far behind it sits, and its strength per scheme — additive in dark
// mode, so it lights the dark page; a plain wash in light mode, where
// adding would just clip to white.
const GLOW_SIZE: [number, number] = [2.4, 2.6]
const GLOW_Z = -1.15
const GLOW_OPACITY = { light: 0.45, dark: 0.55 }
// The page tint's strength per scheme. Its colour is pushed toward full
// saturation first, so a pale dream still tints.
const TINT_ALPHA = { light: 0.18, dark: 0.22 }
// The composite video's panel count, and the dream panel (1-based).
const PANELS = 7
const DREAM_PANEL = 7

// Scratch objects for the per-frame tint maths.
const scratchHsl = { h: 0, s: 0, l: 0 }
const scratchColor = new Color()

// A soft round falloff, white in the middle to clear at the edge.
const glowTexture = (() => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  )
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.45)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
})()

function DreamGlow({
  video,
  fade,
}: {
  video: HTMLVideoElement
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
      new MeshBasicMaterial({
        map: glowTexture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      }),
    []
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

    material.color.copy(shown.current)
    material.opacity = GLOW_OPACITY[scheme] * presence

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
