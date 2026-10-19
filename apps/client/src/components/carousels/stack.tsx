import {
  MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { CanvasTexture, Group, Texture, VideoTexture } from 'three'
import DreamCard from '../dream-card'
import { cursorHint } from '../../utils/cursor-hint'
import { useStore } from '../../store'
import type { Dream } from '../../utils/types'
import {
  SCREEN_OPACITY,
  createDreamScreen,
  setScreenScheme,
} from '../../materials/dream-screen'
import { CarouselProps, easeTo, seeded } from './shared'

// A single pile of polaroids, loose enough that the cards beneath peek out.
// Drag the top one aside and let go: it slides out just past the pile and
// tucks back in underneath, revealing the next. Click it to step into
// that dream. The same gesture as swapping dreams in the player, taught by
// the same cursor (utils/cursor-hint.ts). Only the top card responds — and
// the next one's on top the moment one's let go, so you can flick through.
//
// The pile lies on a surface rather than floating: tipped back a little
// (TABLE_TILT), with one broad soft shadow beneath it all (PILE_SHADOW,
// offset away from the light). The top card plays its dream's loop
// (public/assets/<id>/loop.mov — one video, moved to each new top card;
// the cards beneath keep their stills, in grey anyway). Hovering (or
// dragging) the top card brings
// its dream up big behind it all, through the same cinema screen as the
// player's (materials/dream-screen.ts), crossfading to each new top
// card's — fading in and out at SCREEN_EASE per frame.

// Each card's jitter in the pile (position, turn), the gap between cards
// in depth, how far (CSS px) a drag has to go to toss the top card, how
// far it's thrown, how long before a tossed card tucks back in under the
// pile, and how quickly cards ease toward their places.
const JITTER: [number, number] = [0.11, 0.06]
const TWIST = 0.3
// Apart by more than the photo's depth bias (polaroid-material.tsx), or
// a lower card's photo shows through the one above.
const LAYER = 0.025
const TOSS_PX = 80
// Just past the edge of the pile (a card is ~0.37 wide), not off-screen.
const THROW = 0.62
const TUCK_MS = 380
const EASE = 0.14
// The pile's size, relative to a card's own: it's the only thing on
// screen, so it can be big.
const PILE_SCALE = 1.5
const TABLE_TILT = -0.28
const SCREEN_EASE = 0.08
// The pile's shadow: size, offset (pile units, behind the bottom card),
// and strength per scheme.
const PILE_SHADOW = {
  size: [0.7, 0.8] as [number, number],
  offset: [0.03, -0.05, -0.05] as [number, number, number],
  opacity: { light: 0.3, dark: 0.75 },
}

// A soft round falloff for the shadow's alpha map, built once at module
// load like the polaroid's drop-shadow map — and like it, white on black:
// alphaMap reads the green channel, not alpha, so a white-to-clear
// gradient stays solid right to its edge.
const softTexture = (() => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')!
  context.fillStyle = 'black'
  context.fillRect(0, 0, size, size)
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  )
  gradient.addColorStop(0, 'rgb(255, 255, 255)')
  gradient.addColorStop(0.45, 'rgb(150, 150, 150)')
  gradient.addColorStop(1, 'rgb(0, 0, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
})()
// A pointer press that moves less than this (CSS px) is a click.
const CLICK_PX = 6

// The top card's dream behind the pile: two screens, so the outgoing one
// fades out as the incoming one fades in.
function StackScreen({
  items,
  top,
  presence,
  active,
  loop,
}: {
  items: Dream[]
  top: number
  presence: MutableRefObject<number>
  /** Whether the top card's hovered or being dragged. */
  active: MutableRefObject<boolean>
  /** The top card's loop, once it's playing; its still until then. */
  loop?: Texture
}) {
  const scheme = useStore((state) => state.colorScheme)
  // One hero at a time, by its own URL: the same cache entry choose.tsx
  // preloads, so it's a synchronous hit. An array of them is a different
  // entry, which loaded mid-render and updated Loading's progress from
  // inside this component's render.
  const still = useTexture(`/assets/${items[top].id}/hero.jpg`)
  const texture = loop ?? still
  const screens = useMemo(
    () => [createDreamScreen(null, { order: 0 }), createDreamScreen(null, { order: 1 })],
    []
  )
  const front = useRef(0)
  const opacity = useRef([0, 0])

  useEffect(() => {
    for (const { material } of screens) setScreenScheme(material, scheme)
  }, [screens, scheme])

  useEffect(() => {
    const shown = screens[front.current].material.uniforms.uTexture
    if (shown.value === texture) return
    // Unless nothing's showing yet, bring the new one in on the other screen.
    if (shown.value && opacity.current[front.current] > 0.01)
      front.current = 1 - front.current
    screens[front.current].material.uniforms.uTexture.value = texture
  }, [screens, texture])

  useEffect(
    () => () => {
      for (const { mesh, material } of screens) {
        mesh.geometry.dispose()
        material.dispose()
      }
    },
    [screens]
  )

  useFrame((state) => {
    // Behind the choose screen only; the player has its own.
    const showing =
      useStore.getState().dream || !active.current ? 0 : presence.current
    screens.forEach(({ material }, i) => {
      const goal = i === front.current ? SCREEN_OPACITY[scheme] * showing : 0
      opacity.current[i] += (goal - opacity.current[i]) * SCREEN_EASE
      material.uniforms.uOpacity.value = opacity.current[i]
      material.uniforms.uAspect.value = state.size.width / state.size.height
      material.uniforms.uPointerRelative.value.set(
        state.pointer.x + 1,
        state.pointer.y + 1
      )
    })
  })

  return (
    <>
      {screens.map(({ mesh }, i) => (
        <primitive key={i} object={mesh} />
      ))}
    </>
  )
}

// One video for the top card's loop, moved to each new top card. Ready
// (`loopFor` names the dream) once it's actually playing, so the still
// shows until there's a frame to replace it with.
function useTopLoop(id: string | undefined, colorSpace: string) {
  const loop = useMemo(() => {
    const el = document.createElement('video')
    el.muted = true
    el.loop = true
    el.playsInline = true
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    el.setAttribute('playsinline', '')
    return { el, texture: new VideoTexture(el) }
  }, [])
  loop.texture.colorSpace = colorSpace
  const [loopFor, setLoopFor] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    const { el } = loop
    setLoopFor(null)
    el.src = `/assets/${id}/loop.mov`
    const ready = () => setLoopFor(id)
    el.addEventListener('playing', ready, { once: true })
    el.play().catch(() => {})
    return () => el.removeEventListener('playing', ready)
  }, [loop, id])

  useEffect(
    () => () => {
      loop.el.pause()
      loop.el.removeAttribute('src')
      loop.el.load()
      loop.texture.dispose()
    },
    [loop]
  )

  // Paused under the player, where the stack's out of sight.
  useFrame(() => {
    const hidden = !!useStore.getState().dream
    if (hidden && !loop.el.paused) loop.el.pause()
    else if (!hidden && loop.el.paused && loop.el.getAttribute('src'))
      loop.el.play().catch(() => {})
  })

  return loopFor && loopFor === id ? loop.texture : undefined
}

function Stack({ items, onSelect, presence }: CarouselProps) {
  // Bottom to top: the last is the card on top.
  const [order, setOrder] = useState(() => items.map((_, i) => i))
  useEffect(() => setOrder(items.map((_, i) => i)), [items])
  const cards = useRef<(Group | null)[]>([])
  const drag = useRef<{ startX: number; dx: number; moved: boolean } | null>(
    null
  )
  // Whether the last press moved (the click that follows its release
  // isn't one, if so).
  const pressMoved = useRef(false)
  // Cards mid-toss (out beside the pile, before tucking in under it), and
  // which way each went.
  const tossed = useRef(new Map<number, number>())
  const dark = useStore((state) => state.colorScheme === 'dark')
  const { size, viewport } = useThree()

  const jitter = useMemo(
    () =>
      items.map((_, i) => ({
        x: (seeded(i, 1) - 0.5) * 2 * JITTER[0],
        y: (seeded(i, 2) - 0.5) * 2 * JITTER[1],
        rz: (seeded(i, 3) - 0.5) * 2 * TWIST,
      })),
    [items]
  )

  const top = order[order.length - 1]
  const topStill = useTexture(`/assets/${items[top].id}/hero.jpg`)
  const loop = useTopLoop(items[top]?.id, topStill.colorSpace)
  const [topHovered, setTopHovered] = useState(false)
  const screenActive = useRef(false)
  // A new card on top starts unhovered.
  useEffect(() => setTopHovered(false), [top])

  // The cursor's drag hint: on while the stack's showing.
  useEffect(() => {
    cursorHint.active = true
    return () => {
      cursorHint.active = false
      cursorHint.near = cursorHint.dragging = false
    }
  }, [])

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (!drag.current) return
      drag.current.dx = event.clientX - drag.current.startX
      if (Math.abs(drag.current.dx) > CLICK_PX) drag.current.moved = true
    }

    const handleUp = () => {
      const current = drag.current
      drag.current = null
      if (!current) return
      pressMoved.current = current.moved
      if (Math.abs(current.dx) < TOSS_PX) return
      // Under the pile straight away, so the next card's ready to grab;
      // it's shown tossed out beside the pile for a moment, then tucks in.
      const card = top
      tossed.current.set(card, Math.sign(current.dx))
      setOrder((previous) => [previous[previous.length - 1], ...previous.slice(0, -1)])
      window.setTimeout(() => tossed.current.delete(card), TUCK_MS)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [top])

  useFrame(() => {
    const pxToWorld = viewport.width / size.width / PILE_SCALE
    const dragging = !!drag.current?.moved
    screenActive.current = topHovered || dragging
    // The stack stays mounted under the player; the hint's only its own
    // while the choose screen's showing.
    cursorHint.active = !useStore.getState().dream
    cursorHint.near = topHovered
    cursorHint.dragging = dragging
    // Just the ring, no preview of what's next: the next card's already in
    // view underneath, and it's the same either way.
    cursorHint.dream = null
    if (dragging && drag.current)
      cursorHint.progress = Math.min(1, Math.abs(drag.current.dx) / TOSS_PX)

    order.forEach((index, depth) => {
      const card = cards.current[index]
      if (!card) return
      const place = jitter[index]
      let x = place.x
      let rz = place.rz
      if (index === top && drag.current) {
        // Follows the drag, turning into it.
        x += drag.current.dx * pxToWorld
        rz -= drag.current.dx * pxToWorld * 0.4
      }

      let z = depth * LAYER
      const direction = tossed.current.get(index)
      if (direction !== undefined) {
        // Still above the pile while it's out beside it.
        x = direction * THROW
        rz = -direction * 0.6
        z = order.length * LAYER
      }

      easeTo(card, { x, y: place.y, z, rz }, EASE)
    })
  })

  return (
    <group scale={PILE_SCALE} rotation={[TABLE_TILT, 0, 0]}>
      <StackScreen
        items={items}
        top={top}
        presence={presence}
        active={screenActive}
        loop={loop}
      />
      <mesh position={PILE_SHADOW.offset}>
        <planeGeometry args={PILE_SHADOW.size} />
        <meshBasicMaterial
          color="black"
          alphaMap={softTexture}
          transparent
          depthWrite={false}
          opacity={PILE_SHADOW.opacity[dark ? 'dark' : 'light']}
        />
      </mesh>
      {items.map((dream, i) => (
        <group
          key={dream.id}
          ref={(el) => (cards.current[i] = el)}
          onPointerDown={(event: ThreeEvent<PointerEvent>) => {
            if (i !== top) return
            event.stopPropagation()
            drag.current = { startX: event.clientX, dx: 0, moved: false }
            pressMoved.current = false
          }}
        >
          {/* No hover tilt: tipping back pushes its top edge behind
              the card below it. */}
          <DreamCard
            dream={dream}
            tilt={false}
            interactive={i === top}
            photo={i === top ? loop : undefined}
            // Grayscale until it reaches the top of the pile.
            saturation={i === top ? 1 : 0}
            onHoverChange={(hover) => i === top && setTopHovered(hover)}
            onSelect={(e) => {
              e.stopPropagation()
              // A drag that ended on the card isn't a click.
              if (i === top && !tossed.current.has(i) && !pressMoved.current)
                onSelect(dream)
            }}
          />
        </group>
      ))}
    </group>
  )
}

export default Stack
