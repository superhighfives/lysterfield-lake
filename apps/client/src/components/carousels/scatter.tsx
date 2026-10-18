import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group } from 'three'
import DreamCard from '../dream-card'
import { CarouselProps, easeTo, seeded } from './shared'

// Polaroids strewn across a table: a loose grid, each card knocked off
// square and overlapping its neighbours, drifting very slightly. The
// hovered card straightens and lifts to the top of the pile.

// The grid the cards are loosely placed on (columns, and the spacing
// between cells), how far each is knocked off its cell and off square,
// the idle drift, and how quickly cards ease toward their places.
const COLUMNS = 5
const CELL: [number, number] = [0.44, 0.58]
const JITTER: [number, number] = [0.09, 0.07]
const TWIST = 0.32
const DRIFT = 0.008
const EASE = 0.1

function Scatter({ items, onSelect }: CarouselProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const cards = useRef<(Group | null)[]>([])

  // Each card's resting place, the same every visit.
  const places = useMemo(() => {
    const rows = Math.ceil(items.length / COLUMNS)
    return items.map((_, i) => {
      const column = i % COLUMNS
      const row = Math.floor(i / COLUMNS)
      // The last row centred under the rest.
      const inRow = Math.min(COLUMNS, items.length - row * COLUMNS)
      return {
        x: (column - (inRow - 1) / 2) * CELL[0] + (seeded(i, 1) - 0.5) * 2 * JITTER[0],
        y: ((rows - 1) / 2 - row) * CELL[1] + (seeded(i, 2) - 0.5) * 2 * JITTER[1],
        z: seeded(i, 3) * 0.04,
        rz: (seeded(i, 4) - 0.5) * 2 * TWIST,
        phase: seeded(i, 5) * Math.PI * 2,
      }
    })
  }, [items])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    cards.current.forEach((card, i) => {
      if (!card) return
      const place = places[i]
      const lifted = hovered === i
      easeTo(
        card,
        {
          x: place.x + Math.sin(time * 0.4 + place.phase) * DRIFT,
          y: place.y + Math.cos(time * 0.3 + place.phase) * DRIFT,
          z: lifted ? 0.2 : place.z,
          rz: lifted ? 0 : place.rz,
        },
        EASE
      )
    })
  })

  return (
    <group>
      {items.map((dream, i) => (
        <group key={dream.id} ref={(el) => (cards.current[i] = el)}>
          <DreamCard
            dream={dream}
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

export default Scatter
