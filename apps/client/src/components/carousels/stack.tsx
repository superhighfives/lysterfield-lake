import { useEffect, useMemo, useRef, useState } from 'react'
import { ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { Group } from 'three'
import DreamCard from '../dream-card'
import { cursorHint } from '../../utils/cursor-hint'
import { useStore } from '../../store'
import { CarouselProps, easeTo, seeded } from './shared'

// A single pile of polaroids, loose enough that the cards beneath peek out.
// Drag the top one aside and let go: it slides out just past the pile and
// tucks back in underneath, revealing the next. Click it to step into
// that dream. The same gesture as swapping dreams in the player, taught by
// the same cursor (utils/cursor-hint.ts). Only the top card responds.

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
// A pointer press that moves less than this (CSS px) is a click.
const CLICK_PX = 6

function Stack({ items, onSelect }: CarouselProps) {
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
  // The card being tossed, and which way.
  const tossed = useRef<{ index: number; direction: number } | null>(null)
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
  const [topHovered, setTopHovered] = useState(false)
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
      // Toss it, then tuck it back in under the pile.
      tossed.current = { index: top, direction: Math.sign(current.dx) }
      window.setTimeout(() => {
        tossed.current = null
        setOrder((previous) => [previous[previous.length - 1], ...previous.slice(0, -1)])
      }, TUCK_MS)
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
    // The stack stays mounted under the player; the hint's only its own
    // while the choose screen's showing.
    cursorHint.active = !useStore.getState().dream
    cursorHint.near = topHovered && !tossed.current
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

      if (tossed.current?.index === index) {
        x = tossed.current.direction * THROW
        rz = -tossed.current.direction * 0.6
      }

      easeTo(card, { x, y: place.y, z: depth * LAYER, rz }, EASE)
    })
  })

  return (
    <group scale={PILE_SCALE}>
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
            // Grayscale until it reaches the top of the pile.
            saturation={i === top ? 1 : 0}
            onHoverChange={(hover) => i === top && setTopHovered(hover)}
            onSelect={(e) => {
              e.stopPropagation()
              // A drag that ended on the card isn't a click.
              if (i === top && !tossed.current && !pressMoved.current)
                onSelect(dream)
            }}
          />
        </group>
      ))}
    </group>
  )
}

export default Stack
