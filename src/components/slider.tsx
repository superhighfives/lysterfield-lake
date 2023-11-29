import { MutableRefObject, useCallback, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Euler, MathUtils, Vector3 } from 'three'
import { useCursor, Center } from '@react-three/drei'
import { animated, useSprings } from '@react-spring/three'
import { useGesture } from '@use-gesture/react'
import { useStore } from '../store'
import { Dream } from '../utils/types'

export default function Slider({
  items,
  isDragging,
  width = 600,
  visible = 4,
  children,
}: {
  items: Dream[]
  isDragging: MutableRefObject<boolean>
  width?: number
  visible?: number
  style?: { string: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  children: any
}) {
  const isTouch = useStore((state) => state.isTouch)

  const idx = useCallback(
    (x: number, l = items.length) => (x < 0 ? x + l : x) % l,
    [items]
  )
  const getPos = useCallback(
    (i: number, firstVis: number, firstVisIdx: number) =>
      idx(i - firstVis + firstVisIdx),
    [idx]
  )
  const [springs, api] = useSprings(items.length, (i) => ({
    position: [(i < items.length - 1 ? i : -1) * width, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }))
  const prev = useRef([0, 1])

  const runSprings = useCallback(
    (y: number, dy: number) => {
      const firstVis = idx(Math.floor(y / width) % items.length)
      const firstVisIdx = dy < 0 ? items.length - visible + 1 : 1
      api.start((i) => {
        const position = getPos(i, firstVis, firstVisIdx)
        const prevPosition = getPos(i, prev.current[0], prev.current[1])
        const rank =
          firstVis - (y < 0 ? items.length : 0) + position - firstVisIdx - 1
        const configPos = dy > 0 ? position : items.length - position
        const scale = 1.0
        return {
          position: [
            (-y % (width * items.length)) + width * rank,
            0.4 + ((-y % (width * items.length)) + width * rank) / -10,
            -(((-y % (width * items.length)) + width * rank - 1) / 2) * -1,
          ],
          rotation: [
            0.1,
            (((-y % (width * items.length)) + width * rank - 2.75) / 1.5) * -1,
            ((-y % (width * items.length)) + width * rank) / 5 - 0.5,
          ],
          scale: [scale, scale, scale],
          immediate: dy < 0 ? prevPosition > position : prevPosition < position,
          config: {
            tension: (1 + items.length - configPos) * 500,
            friction: 30 + configPos * 40,
            precision: 0.000001,
          },
        }
      })
      prev.current = [firstVis, firstVisIdx]
    },
    [idx, getPos, width, visible, api, items.length]
  )

  const [initalisedVisuals, setInitalisedVisuals] = useState(false)
  if (!initalisedVisuals) {
    // Surely there's a better way?
    setTimeout(() => {
      runSprings(Math.random() * 1000, 0)
      setInitalisedVisuals(true)
    })
  }

  const wheelOffset = useRef(0)
  const dragOffset = useRef(0)

  const [hover, setHover] = useState(false)
  const [px, setX] = useState(0)
  const [triggerInteractive, setTriggerInteractive] = useState(false)

  useCursor(hover)

  useFrame((_state, delta) => {
    if ((!triggerInteractive || isTouch) && !isDragging.current) {
      const positionX = px + delta / 10
      setX(positionX)
      wheelOffset.current = dragOffset.current = positionX
      runSprings(positionX, 1)
    }
  })

  const bind = useGesture(
    {
      onDrag: ({ offset: [x], direction: [dx], first, last }) => {
        if (dx) {
          if (!triggerInteractive) setTriggerInteractive(true)
          x = x / 750
          dragOffset.current = -x + px
          runSprings(wheelOffset.current + -x, -dx)
        }

        if (first) {
          isDragging.current = true
        } else if (last) {
          requestAnimationFrame(() => (isDragging.current = false))
        }
      },
      onWheel: ({ offset: [x], direction: [dx], first, last }) => {
        if (dx) {
          if (!triggerInteractive) setTriggerInteractive(true)
          x = x / 1000
          wheelOffset.current = x + px
          runSprings(dragOffset.current + x, dx)
        }

        if (first) {
          isDragging.current = true
        } else if (last) {
          requestAnimationFrame(() => (isDragging.current = false))
        }
      },
      onHover: ({ hovering }) => {
        setHover(hovering || false)
      },
    },
    {
      wheel: { eventOptions: { passive: false } },
      drag: { filterTaps: true },
    }
  )

  const { width: w } = useThree((state) => state.viewport)

  return (
    <>
      {!isTouch ? (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <mesh position={[0, 0, 0]} {...(bind() as any)}>
          <planeGeometry args={[MathUtils.clamp(w, 1.0, 10.0), 0.5, 1]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      ) : null}

      <Center position={[0, 0, -0.4]}>
        {springs.map(({ position, rotation, scale }, i) => (
          <animated.group
            position={position as unknown as Vector3}
            scale={scale as unknown as Vector3}
            rotation={rotation as unknown as Euler}
            key={i}
            // eslint-disable-next-line react/no-children-prop
            children={children(items[i], i)}
          />
        ))}
      </Center>
    </>
  )
}
