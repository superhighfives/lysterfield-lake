import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group, MathUtils } from 'three'
import DreamCard from '../dream-card'
import { CarouselProps, easeTo, seeded } from './shared'

// Polaroids floating on the lake: laid out on a water surface tipped back
// in perspective, bobbing and turning slowly, pushed aside where the
// pointer passes over them like a hand through water. The hovered card
// lifts out of the water and turns up toward you.

// How far the water tips back, how the cards spread over it (a sunflower
// spiral: the spacing per card, and how much wider than deep it is), the
// bob (height along the water's normal, and turn), the pointer's push
// (its reach and strength, in water units), and how quickly cards ease.
const TILT = -1.0
const SPACING = 0.27
const STRETCH = 1.4
const BOB = 0.025
const SWAY = 0.12
const PUSH_RADIUS = 0.6
const PUSH = 0.18
const EASE = 0.06
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

function Lake({ items, onSelect }: CarouselProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const cards = useRef<(Group | null)[]>([])

  const places = useMemo(
    () =>
      items.map((_, i) => {
        const radius = Math.sqrt(i + 0.5) * SPACING
        const angle = i * GOLDEN_ANGLE
        return {
          x: Math.cos(angle) * radius * STRETCH,
          y: Math.sin(angle) * radius,
          phase: seeded(i, 1) * Math.PI * 2,
          rz: (seeded(i, 2) - 0.5) * 0.8,
        }
      }),
    [items]
  )

  useFrame((state) => {
    const time = state.clock.elapsedTime
    // The pointer, roughly on the water: across, and (foreshortened) into
    // the distance.
    const pointerX = state.pointer.x * 1.6
    const pointerY = state.pointer.y * 1.4
    cards.current.forEach((card, i) => {
      if (!card) return
      const place = places[i]
      const dx = place.x - pointerX
      const dy = place.y - pointerY
      const distance = Math.hypot(dx, dy)
      const push =
        hovered === null
          ? MathUtils.clamp(1 - distance / PUSH_RADIUS, 0, 1) * PUSH
          : 0
      const lifted = hovered === i
      easeTo(
        card,
        {
          x: place.x + (dx / (distance || 1)) * push,
          y: place.y + (dy / (distance || 1)) * push,
          z: lifted ? 0.25 : Math.sin(time * 0.8 + place.phase) * BOB,
          // Lifted, it turns up out of the water to face you.
          rx: lifted ? -TILT * 0.85 : Math.sin(time * 0.6 + place.phase) * 0.05,
          rz: lifted ? 0 : place.rz + Math.sin(time * 0.3 + place.phase) * SWAY,
        },
        EASE
      )
    })
  })

  return (
    <group rotation={[TILT, 0, 0]} position={[0, 0.05, -0.45]}>
      {items.map((dream, i) => (
        <group key={dream.id} ref={(el) => (cards.current[i] = el)}>
          <DreamCard
            dream={dream}
            tilt={false}
            onSelect={(e) => {
              e.stopPropagation()
              onSelect(dream)
            }}
            onHoverChange={(hover) =>
              setHovered((current) => (hover ? i : current === i ? null : current))
            }
          />
        </group>
      ))}
    </group>
  )
}

export default Lake
