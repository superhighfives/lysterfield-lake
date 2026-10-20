import { MutableRefObject, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, Texture, VideoTexture } from 'three'
import { dreamVideo } from '../utils/dream-video'
import { useStore } from '../store'
import {
  SCREEN_OPACITY,
  createDreamScreen,
  setScreenScheme,
} from '../materials/dream-screen'

// The dream behind everything, like a cinema screen: the dream panel
// filling the whole screen (materials/dream-screen.ts). And its
// colour pooling faintly in the page's bowl (see --dream-tint in
// index.css): the dream panel (7 of the composite video) is drawn into a
// tiny canvas a few times a second and averaged, and the tint eases toward
// that, so it drifts with the video rather than flickering.

// How often the dream's colour is sampled, and how quickly (per frame) the
// shown colour eases toward it.
const SAMPLE_MS = 250
const EASE = 0.04
// The page tint's strength per scheme. Its colour is pushed toward full
// saturation first, so a pale dream still tints.
const TINT_ALPHA = { light: 0.15, dark: 0.1 }
// The spill and tint fade in (and out) at this much per frame, once the
// dream's own colour has been sampled — so entering a dream doesn't flash
// whatever colour was last seen. Samples taken within SETTLE_MS of a new
// dream are skipped, while its video is still loading or seeking. Leaving
// the player, they go faster (PRESENCE_LEAVE), out of the choose screen's
// way.
const PRESENCE_EASE = 0.02
const PRESENCE_LEAVE = 0.08
const SETTLE_MS = 400
// The composite video's panel count, and the dream panel (1-based).
const PANELS = 7
const DREAM_PANEL = 7

// Scratch objects for the per-frame tint maths.
const scratchHsl = { h: 0, s: 0, l: 0 }
const scratchColor = new Color()

function DreamGlow({
  video,
  texture,
  dreamTextures,
  fade,
  develop,
}: {
  video: HTMLVideoElement
  /** The composite video's texture, for the spill. */
  texture: Texture
  /** Split (utils/dream-video.ts): the two dream videos' textures, of
   *  which the screen shows whichever is in front — whole frames, not a
   *  panel of `texture`. */
  dreamTextures: VideoTexture[] | null
  /** 0-1: how present the avatar is (main.tsx's fadeRef), so
   *  the spill fades as the polaroid's dragged, and is gone through a
   *  swap, with them. Followed directly, not through the slow presence
   *  ease below. */
  fade: MutableRefObject<number>
  /** 0-1: how developed the polaroid's photo is (main.tsx's developRef);
   *  the screen stays grey until the colour comes up in it. */
  develop: MutableRefObject<number>
}) {
  const scheme = useStore((state) => state.colorScheme)
  const split = !!dreamTextures
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
  // The composite video's dream panel, as the screen behind everything
  // (materials/dream-screen.ts).
  // Its scheme from the start (see createDreamScreen); later changes
  // below.
  const screen = useMemo(() => {
    const scheme = useStore.getState().colorScheme
    return split
      ? createDreamScreen(null, { scheme })
      : createDreamScreen(texture, { panels: PANELS, panel: DREAM_PANEL, scheme })
  }, [split, texture])
  const { material } = screen
  useEffect(
    () => () => {
      screen.mesh.geometry.dispose()
      material.dispose()
    },
    [screen, material]
  )

  useEffect(() => setScreenScheme(material, scheme), [material, scheme])

  // No dream, no tint.
  useEffect(() => {
    if (dream) return
    document.documentElement.style.setProperty('--dream-tint-alpha', '0')
  }, [dream])

  useFrame((state) => {
    material.uniforms.uAspect.value = state.size.width / state.size.height
    // The video the colour's sampled from, and how its frame's laid out.
    const front = dreamTextures?.[dreamVideo.front]
    if (front) material.uniforms.uTexture.value = front
    const source = (front?.image as HTMLVideoElement | undefined) ?? video
    const panels = front ? 1 : PANELS
    const panelIndex = front ? 1 : DREAM_PANEL
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
      source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      source.videoWidth
    ) {
      lastSample.current = now
      const panel = source.videoWidth / panels
      try {
        sampler.drawImage(
          source,
          panel * (panelIndex - 1),
          0,
          panel,
          source.videoHeight,
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
    presenceRef.current +=
      (goal - presenceRef.current) * (dream ? PRESENCE_EASE : PRESENCE_LEAVE)
    const presence = presenceRef.current * fade.current

    material.uniforms.uOpacity.value = SCREEN_OPACITY[scheme] * presence
    // The pointer as the polaroid's photo sees it (set by main.tsx).
    material.uniforms.uPointerRelative.value = useStore.getState().globalPointer
    // Grey while the photo's blank, the colour coming up as it develops.
    const developed = Math.min(Math.max((develop.current - 0.35) / 0.65, 0), 1)
    material.uniforms.uSaturation.value = developed * developed * (3 - 2 * developed)

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
    <primitive object={screen.mesh} />
  )
}

export default DreamGlow
