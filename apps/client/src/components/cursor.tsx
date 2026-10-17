import { useEffect, useRef, useState } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { useStore } from '../store'
import type { Dream } from '../utils/types'
import {
  canSwap,
  dragPreview,
  nearPolaroid,
  swapDrag,
} from '../utils/swap-gesture'

// A custom cursor, on devices with a precise, hovering pointer (touch keeps
// its own). A dot sits exactly under the pointer; a ring trails it and
// changes with what's beneath:
// - default: a faint ring
// - hover: a larger ring over anything clickable (HTML controls, and the
//   carousel's cards, which flag it through drei's useCursor)
// - polaroid: near the player's polaroid, a wide ring with arrows either
//   side, offering a drag
// - drag: the ring fills toward the point where letting go swaps, with
//   the dream it'll swap to shown beside it on the side it'll come from
// - busy: a spinning dashed ring while the next dream loads

type Mode = 'default' | 'hover' | 'polaroid' | 'drag' | 'busy'

const RING_SIZE: Record<Mode, number> = {
  default: 28,
  hover: 44,
  polaroid: 76,
  drag: 76,
  busy: 36,
}
// How much of the way to the pointer the ring moves each frame.
const RING_FOLLOW = 0.3
const ARC_RADIUS = 36
const ARC_LENGTH = 2 * Math.PI * ARC_RADIUS

const INTERACTIVE =
  'a, button, input, label, [role="radio"], media-time-range, media-play-button, media-mute-button'

const finePointer = () =>
  window.matchMedia('(hover: hover) and (pointer: fine)').matches

function Cursor() {
  const [enabled, setEnabled] = useState(finePointer)
  const [mode, setMode] = useState<Mode>('default')
  const [visible, setVisible] = useState(false)
  const [preview, setPreview] = useState<{
    dream: Dream
    side: 'left' | 'right'
  } | null>(null)

  const dot = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const arc = useRef<SVGCircleElement>(null)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)')
    const handleChange = () => setEnabled(query.matches)
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('custom-cursor', enabled)
    if (!enabled) return

    const pointer = { x: -100, y: -100 }
    const ringPos = { x: -100, y: -100 }
    let hovered: Element | null = null
    let currentMode: Mode = 'default'
    let previewKey = ''
    let frame = 0

    const handleMove = (event: PointerEvent) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      setVisible(true)
    }

    const handleOver = (event: PointerEvent) => {
      hovered = event.target as Element
    }

    const handleLeave = () => setVisible(false)

    const tick = () => {
      frame = requestAnimationFrame(tick)

      ringPos.x += (pointer.x - ringPos.x) * RING_FOLLOW
      ringPos.y += (pointer.y - ringPos.y) * RING_FOLLOW
      if (dot.current)
        dot.current.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`
      if (ring.current)
        ring.current.style.transform = `translate3d(${ringPos.x}px, ${ringPos.y}px, 0)`

      const { swapPhase } = useStore.getState()
      let next: Mode = 'default'
      if (swapDrag.active) next = 'drag'
      else if (swapPhase === 'loading') next = 'busy'
      else if (canSwap() && nearPolaroid(pointer.x, pointer.y)) next = 'polaroid'
      else if (
        hovered?.closest(INTERACTIVE) ||
        document.body.style.cursor === 'pointer'
      )
        next = 'hover'
      if (next !== currentMode) {
        currentMode = next
        setMode(next)
      }

      if (next === 'drag') {
        const { dream, direction, progress } = dragPreview()
        // Dragging left brings the next one in from the right.
        const side = direction === 1 ? 'right' : 'left'
        const key = `${dream?.id}-${side}`
        if (key !== previewKey) {
          previewKey = key
          setPreview(dream ? { dream, side } : null)
        }

        if (arc.current)
          arc.current.style.strokeDashoffset = `${ARC_LENGTH * (1 - progress)}`
        if (card.current) {
          card.current.style.opacity = `${0.4 + progress * 0.6}`
          card.current.style.setProperty('--progress', `${progress}`)
          card.current.dataset.ready = progress >= 1 ? 'true' : 'false'
        }
      } else if (previewKey) {
        previewKey = ''
      }
    }

    frame = requestAnimationFrame(tick)

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerover', handleOver)
    document.documentElement.addEventListener('pointerleave', handleLeave)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerover', handleOver)
      document.documentElement.removeEventListener('pointerleave', handleLeave)
      document.documentElement.classList.remove('custom-cursor')
    }
  }, [enabled])

  if (!enabled) return null

  const size = RING_SIZE[mode]

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-50 transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* Ring, trailing the pointer */}
      <div ref={ring} className="absolute left-0 top-0">
        <div
          className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border transition-all duration-300 ease-out ${
            mode === 'busy'
              ? 'border-dashed border-stone-900/60 dark:border-white/60 animate-spin'
              : mode === 'hover'
                ? 'border-yellow-500 bg-yellow-400/20'
                : mode === 'polaroid' || mode === 'drag'
                  ? // A faint halo of the opposite colour outside the ring,
                    // so it reads over the photo whatever's in it.
                    'border-stone-900/60 dark:border-white/60 bg-white/10 shadow-[0_0_0_1px_rgba(255,255,255,0.5)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]'
                  : 'border-stone-900/30 dark:border-white/30'
          }`}
          style={{ width: size, height: size }}
        />

        {/* Drag progress: fills toward the point where letting go swaps */}
        <svg
          className={`absolute -translate-x-1/2 -translate-y-1/2 -rotate-90 transition-opacity duration-200 ${
            mode === 'drag' ? 'opacity-100' : 'opacity-0'
          }`}
          width={ARC_RADIUS * 2 + 4}
          height={ARC_RADIUS * 2 + 4}
        >
          <circle
            ref={arc}
            cx={ARC_RADIUS + 2}
            cy={ARC_RADIUS + 2}
            r={ARC_RADIUS}
            fill="none"
            strokeWidth={3}
            strokeLinecap="round"
            className="stroke-yellow-400"
            strokeDasharray={ARC_LENGTH}
            strokeDashoffset={ARC_LENGTH}
          />
        </svg>

        {/* Offer to drag: arrows either side of the ring, and a label
            under it (clear of the dot) */}
        <div
          className={`absolute -translate-y-1/2 flex items-center justify-between text-stone-900 dark:text-white drop-shadow-[0_0_2px_rgba(255,255,255,0.9)] dark:drop-shadow-[0_0_2px_rgba(0,0,0,0.9)] transition-all duration-300 ${
            mode === 'polaroid' ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ width: size + 36, left: -(size + 36) / 2 }}
        >
          <CaretLeft
            weight="bold"
            size={14}
            style={{ animation: 'cursor-nudge-left 1.4s ease-in-out infinite' }}
          />
          <span
            className="absolute left-1/2 -translate-x-1/2 font-mono text-[10px] uppercase tracking-widest bg-white/80 dark:bg-stone-900/80 rounded-full px-2"
            style={{ top: size / 2 + 12 }}
          >
            drag
          </span>
          <CaretRight
            weight="bold"
            size={14}
            style={{ animation: 'cursor-nudge-right 1.4s ease-in-out infinite' }}
          />
        </div>

        {/* Where letting go lands: the incoming dream, as a little polaroid
            on the side it'll come in from */}
        {mode === 'drag' && preview ? (
          <div
            ref={card}
            className={`group absolute top-0 -translate-y-1/2 flex flex-col items-center gap-1 transition-[opacity] ${
              preview.side === 'right' ? 'left-12' : 'right-12'
            }`}
          >
            <div
              className="bg-white dark:bg-stone-800 p-1 pb-3 shadow-lg transition-transform duration-200 group-data-[ready=true]:ring-2 group-data-[ready=true]:ring-yellow-400"
              style={{
                transform: `rotate(${preview.side === 'right' ? 4 : -4}deg) scale(calc(0.85 + var(--progress, 0) * 0.15))`,
              }}
            >
              <img
                src={`/assets/${preview.dream.id}/hero.jpg`}
                alt=""
                className="w-16 h-16 object-cover"
              />
            </div>
            <span className="font-serif italic text-sm whitespace-nowrap text-stone-900 dark:text-white">
              {preview.dream.title}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-stone-500 opacity-0 group-data-[ready=true]:opacity-100 transition-opacity">
              let go
            </span>
          </div>
        ) : null}
      </div>

      {/* Dot, exactly under the pointer */}
      <div ref={dot} className="absolute left-0 top-0">
        <div className="absolute -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-stone-900 dark:bg-white" />
      </div>
    </div>
  )
}

export default Cursor
