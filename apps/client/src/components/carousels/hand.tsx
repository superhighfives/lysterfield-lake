import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group } from 'three'
import DreamCard from '../dream-card'
import { CarouselProps, easeTo } from './shared'

// A splayed hand of cards: fanned around a pivot below them, like a hand
// of playing cards. The hovered card rises out of the hand toward you, and
// the whole hand leans a little with the pointer.

// The hand's radius (world units; the pivot sits this far below the
// cards), the angle between neighbours, how far a hovered card rises, how
// far the hand leans with the pointer (radians at the screen's edge), and
// how quickly cards ease toward their places.
const RADIUS = 4.2
const SPREAD = 0.072
const RISE = 0.22
const LEAN = 0.12
const EASE = 0.12
const LAYER = 0.025

function Hand({ items, onSelect }: CarouselProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const cards = useRef<(Group | null)[]>([])
  const lean = useRef(0)

  useFrame((state) => {
    lean.current += (-state.pointer.x * LEAN - lean.current) * 0.05
    const middle = (items.length - 1) / 2
    cards.current.forEach((card, i) => {
      if (!card) return
      const angle = (i - middle) * SPREAD + lean.current
      const rise = hovered === i ? RISE : 0
      easeTo(
        card,
        {
          x: Math.sin(angle) * (RADIUS + rise),
          y: Math.cos(angle) * (RADIUS + rise) - RADIUS,
          // Left to right overlapping, apart in depth by more than the
          // photo's depth bias (polaroid-material.tsx), or one card's photo
          // shows through its neighbour; the hovered card clear of the rest.
          z: i * LAYER + (hovered === i ? 0.12 : 0),
          rz: -angle,
        },
        EASE
      )
    })
  })

  return (
    <group position={[0, 0.05, 0]}>
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

export default Hand
