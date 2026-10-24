import { useEffect, useRef, useState } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { useStore } from '../store'
import type { Dream } from '../utils/types'
import {
  canDrag,
  dragPreview,
  nearPolaroid,
  swapDrag,
} from '../utils/swap-gesture'
import { latestPulse } from '../utils/audio'
import { cursorHint } from '../utils/cursor-hint'
import { playback } from '../utils/dream-video'

// A custom cursor, on devices with a precise, hovering pointer (touch keeps
// its own). A dot sits exactly under the pointer; a ring trails it and
// changes with what's beneath:
// - default: just the dot, stretching along its direction of travel, with
//   a faint ghost trailing behind — the ring is collapsed into it, so every
//   other state grows out of the dot
// - hover: a larger ring over anything clickable (HTML controls, and the
//   carousel's cards, which flag it through drei's useCursor), labelled
//   with the control's name when it has one (views/tooltip.tsx)
// - polaroid: near the player's polaroid, a wide ring with arrows either
//   side, offering a drag
// - drag: the ring fills toward the point where letting go swaps, with
//   the dream it'll swap to shown beside it on the side it'll come from
// - busy: a spinning dashed ring, labelled, while the player waits on
//   video (the first dream loading, or a swap) — no drag offered then.
//   Over the polaroid a drag is still offered while it waits (a swap can
//   skip past a slow one), so there the polaroid ring spins and says it's
//   loading instead

type Mode = 'default' | 'hover' | 'polaroid' | 'drag' | 'busy'

const RING_SIZE: Record<Mode, number> = {
  default: 6,
  hover: 44,
  polaroid: 76,
  drag: 76,
  busy: 36,
}
// How much of the way to the pointer the ring moves each frame.
const RING_FOLLOW = 0.3
// The ghost trails further behind than the ring.
const GHOST_FOLLOW = 0.12
// Dot stretch: pointer speed (px per frame, eased by SPEED_EASE) per unit
// of stretch, capped at STRETCH_MAX (1 = twice as long).
const SPEED_PER_STRETCH = 25
const STRETCH_MAX = 1.2
const SPEED_EASE = 0.25
// How far a label under the ring keeps from the window's edges (px): as
// far as the header's buttons sit from them (routes/root.tsx).
const LABEL_MARGIN = 4
const ARC_RADIUS = 36
const ARC_LENGTH = 2 * Math.PI * ARC_RADIUS

const INTERACTIVE =
  'a, button, input, label, [role="radio"], media-time-range, media-play-button, media-mute-button'

const finePointer = () =>
  window.matchMedia('(hover: hover) and (pointer: fine)').matches

// Seconds as the player's own time display shows them: m:ss.
const formatTime = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// On a touch screen there's no pointer to replace, but the ring still
// shows while a finger's down: what a tap or drag is over, and a drag's
// progress and the dream it'll land on. It jumps to each touch rather than
// trailing in from the last.
function Cursor() {
  const [fine, setFine] = useState(finePointer)
  const [mode, setMode] = useState<Mode>('default')
  const [visible, setVisible] = useState(false)
  const [label, setLabel] = useState('')
  // The label sits above the ring rather than under it: in the lower half
  // of the window (see tick).
  const [above, setAbove] = useState(false)
  /** Waiting on video: the old dream going, the next one loading, or the
   *  player buffering. Not the new dream's reveal, which has its video. */
  const [waiting, setWaiting] = useState(false)
  const [preview, setPreview] = useState<{
    dream: Dream
    side: 'left' | 'right'
  } | null>(null)

  const dot = useRef<HTMLDivElement>(null)
  const dotShape = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const arc = useRef<SVGCircleElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const labelEl = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)')
    const handleChange = () => setFine(query.matches)
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('custom-cursor', fine)

    const pointer = { x: -100, y: -100 }
    const ringPos = { x: -100, y: -100 }
    const ghostPos = { x: -100, y: -100 }
    const last = { x: -100, y: -100 }
    const velocity = { x: 0, y: 0 }
    let hovered: Element | null = null
    let currentMode: Mode = 'default'
    let previewKey = ''
    let currentLabel = ''
    let currentAbove = false
    let currentWaiting = false
    let frame = 0

    const handleMove = (event: PointerEvent) => {
      // A touch only moves while it's down; a mouse on a touch screen
      // (or a pen hovering) doesn't count.
      if (!fine && event.pointerType !== 'touch') return
      pointer.x = event.clientX
      pointer.y = event.clientY
      setVisible(true)
    }

    const handleDown = (event: PointerEvent) => {
      if (fine || event.pointerType !== 'touch') return
      pointer.x = ringPos.x = ghostPos.x = last.x = event.clientX
      pointer.y = ringPos.y = ghostPos.y = last.y = event.clientY
      hovered = event.target as Element
      setVisible(true)
    }

    const handleUp = (event: PointerEvent) => {
      if (!fine && event.pointerType === 'touch') setVisible(false)
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
      // Centred under the ring, but nudged in from the window's edges.
      if (labelEl.current) {
        const half = labelEl.current.offsetWidth / 2
        const left = ringPos.x - half - LABEL_MARGIN
        const right = ringPos.x + half + LABEL_MARGIN - window.innerWidth
        labelEl.current.style.marginLeft = `${left < 0 ? -left : right > 0 ? -right : 0}px`
      }

      velocity.x += (pointer.x - last.x - velocity.x) * SPEED_EASE
      velocity.y += (pointer.y - last.y - velocity.y) * SPEED_EASE
      last.x = pointer.x
      last.y = pointer.y
      const speed = Math.hypot(velocity.x, velocity.y)
      const stretch = Math.min(speed / SPEED_PER_STRETCH, STRETCH_MAX)
      const angle = Math.atan2(velocity.y, velocity.x)
      if (dotShape.current) {
        dotShape.current.style.transform = `translate(-50%, -50%) rotate(${angle}rad) scale(${1 + stretch}, ${1 / (1 + stretch * 0.5)})`
        // The glow swells with the music's beat (utils/audio.ts).
        const pulse = latestPulse()
        dotShape.current.style.boxShadow = `0 0 ${10 + pulse * 14}px ${2 + pulse * 3}px rgba(248, 205, 13, ${0.55 + pulse * 0.35})`
      }

      ghostPos.x += (pointer.x - ghostPos.x) * GHOST_FOLLOW
      ghostPos.y += (pointer.y - ghostPos.y) * GHOST_FOLLOW
      if (ghost.current) {
        ghost.current.style.transform = `translate3d(${ghostPos.x}px, ${ghostPos.y}px, 0)`
        // Only while it's trailing; sitting under the dot it would just
        // thicken it.
        const lag = Math.hypot(pointer.x - ghostPos.x, pointer.y - ghostPos.y)
        ghost.current.style.opacity = `${Math.min(lag / 40, 1) * 0.35}`
      }

      const { swapPhase } = useStore.getState()
      // playback.waiting is also true through the reveal ('in'), so leave
      // that out here.
      const nowWaiting =
        swapPhase === 'out' ||
        swapPhase === 'loading' ||
        (swapPhase !== 'in' && playback.waiting)
      if (nowWaiting !== currentWaiting) {
        currentWaiting = nowWaiting
        setWaiting(nowWaiting)
      }

      let next: Mode = 'default'
      const hint = cursorHint.active ? cursorHint : null
      if (swapDrag.active || hint?.dragging) next = 'drag'
      // Over the polaroid, a drag's on offer even while it waits on video
      // (it skips past); elsewhere, waiting shows as busy.
      else if (hint?.near || (canDrag() && nearPolaroid(pointer.x, pointer.y)))
        next = 'polaroid'
      // Not on touch: a busy ring appearing under a finger read as part of
      // the page, not a cursor (the drag ring still shows when a swap's on
      // offer, loading or not).
      else if (fine && nowWaiting) next = 'busy'
      else if (
        hovered?.closest(INTERACTIVE) ||
        document.body.style.cursor === 'pointer'
      )
        next = 'hover'
      if (next !== currentMode) {
        currentMode = next
        setMode(next)
      }

      // The hovered control's name: its own, or a sibling's (the player's
      // mute and play buttons sit beside theirs).
      let nextLabel = currentLabel
      if (next === 'hover') {
        const control = hovered?.closest(INTERACTIVE)
        // The scrubber: the time under the pointer, which media-chrome sets
        // on it as the pointer moves (and clears in between, when the last
        // time shown stays).
        const scrubber = !!control?.matches('media-time-range')
        const previewAttribute = scrubber
          ? control?.getAttribute('mediapreviewtime')
          : null
        const previewTime = previewAttribute ? Number(previewAttribute) : NaN
        nextLabel = Number.isFinite(previewTime)
          ? formatTime(previewTime)
          : scrubber
            ? currentLabel
            : ((
              control?.querySelector('[data-cursor-label]') ??
              control?.parentElement?.querySelector(':scope > [data-cursor-label]')
            )?.textContent ?? '')
      }

      // In the lower half of the window, the label goes above the ring, where
      // the window's edge and the player's controls don't hide it. By where
      // the pointer is, not what it's over, so it doesn't jump back under
      // the ring as the pointer leaves a control (and its label fades).
      const nextAbove = pointer.y > window.innerHeight / 2
      if (nextAbove !== currentAbove) {
        currentAbove = nextAbove
        setAbove(nextAbove)
      }

      if (nextLabel !== currentLabel) {
        currentLabel = nextLabel
        setLabel(nextLabel)
      }

      if (next === 'drag') {
        const preview = dragPreview()
        const dream = hint?.dragging ? hint.dream : preview.dream
        const progress = hint?.dragging ? hint.progress : preview.progress
        // Dragging left brings the next one in from the right.
        const side = hint?.dragging
          ? hint.side
          : preview.direction === 1
            ? 'right'
            : 'left'
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
    window.addEventListener('pointerdown', handleDown)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    window.addEventListener('pointerover', handleOver)
    document.documentElement.addEventListener('pointerleave', handleLeave)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerdown', handleDown)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      window.removeEventListener('pointerover', handleOver)
      document.documentElement.removeEventListener('pointerleave', handleLeave)
      document.documentElement.classList.remove('custom-cursor')
    }
  }, [fine])

  const size = RING_SIZE[mode]
  // On touch, the ring's labels and the drag's preview go above it, clear
  // of the finger, and over the bottom controls (above); under it otherwise.
  const touch = !fine
  // Spaced from the hover (or busy) ring's size, not the current one's, so
  // the label holds still as the ring grows and shrinks on and off a
  // control (on touch, from the ring as it is: there, the drag's).
  const labelRing = RING_SIZE[mode === 'hover' ? 'hover' : 'busy']
  const labelTop = touch
    ? -size / 2 - 28
    : above
      ? -labelRing / 2 - 28
      : labelRing / 2 + 10

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-50 transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* Ring, trailing the pointer */}
      <div ref={ring} className="absolute left-0 top-0">
        {/* Centred and sized on the outside, so the busy spin (a transform
            of its own) doesn't replace the centring translate. */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 transition-[width,height] duration-300 ease-out"
          style={{ width: size, height: size }}
        >
          <div
            className={`w-full h-full rounded-full border transition-[color,background-color,border-color,box-shadow] duration-300 ease-out ${
              mode === 'busy' || (mode === 'polaroid' && waiting)
                ? 'border-dashed border-stone-900/60 dark:border-white/60 animate-spin'
                : mode === 'hover'
                  ? 'border-yellow-500 bg-yellow-400/20'
                  : mode === 'polaroid' || mode === 'drag'
                    ? // A faint halo of the opposite colour outside the ring,
                      // so it reads over the photo whatever's in it.
                      'border-stone-900/60 dark:border-white/60 bg-white/10 shadow-[0_0_0_1px_rgba(255,255,255,0.5)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]'
                    : 'border-transparent'
            }`}
          />
        </div>

        {/* A label under the ring: waiting, or the hovered control's name */}
        <span
          ref={labelEl}
          className={`absolute -translate-x-1/2 whitespace-nowrap font-mono text-[10px] uppercase tracking-widest text-stone-900 dark:text-white bg-white/80 dark:bg-stone-900/80 rounded-full px-2 transition-opacity duration-300 ${
            mode === 'busy' || (mode === 'hover' && label)
              ? 'opacity-100'
              : 'opacity-0'
          }`}
          style={{ top: labelTop }}
        >
          {mode === 'busy' ? 'Loading…' : label}
        </span>


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
            style={{ top: touch ? -size / 2 - 24 : size / 2 + 12 }}
          >
            {waiting ? 'Loading…' : 'drag'}
          </span>
          <CaretRight
            weight="bold"
            size={14}
            style={{
              animation: 'cursor-nudge-right 1.4s ease-in-out infinite',
            }}
          />
        </div>

        {/* Where letting go lands: the incoming dream, as a little polaroid
            on the side it'll come in from */}
        {mode === 'drag' && preview ? (
          <div
            ref={card}
            className={`group absolute flex flex-col items-center gap-1 transition-[opacity] ${
              touch
                ? preview.side === 'right'
                  ? 'left-2'
                  : 'right-2'
                : `top-0 -translate-y-1/2 ${preview.side === 'right' ? 'left-12' : 'right-12'}`
            }`}
            // Touch: above the ring, clear of the finger.
            style={touch ? { bottom: size / 2 + 12 } : undefined}
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
            {/* Backed, so they read over whatever photo is underneath. */}
            <span className="font-serif italic text-sm whitespace-nowrap text-stone-900 dark:text-white bg-white/85 dark:bg-stone-900/85 backdrop-blur-sm rounded-full px-2.5 py-0.5 shadow-sm">
              {preview.dream.title}
            </span>
            {/* Inverted against the name above it: it's the call to act. */}
            <span className="font-mono text-[10px] uppercase tracking-widest text-white dark:text-stone-900 bg-stone-900/90 dark:bg-white/90 backdrop-blur-sm rounded-full px-2 shadow-sm opacity-0 group-data-[ready=true]:opacity-100 transition-opacity">
              let go
            </span>
          </div>
        ) : null}
      </div>

      {/* Ghost, trailing the dot while it moves */}
      <div
        ref={ghost}
        className={`absolute left-0 top-0 transition-[visibility] ${
          mode === 'default' ? 'visible' : 'invisible'
        }`}
      >
        <div className="absolute -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-stone-900 dark:bg-white blur-[0.5px]" />
      </div>

      {/* Dot, exactly under the pointer, with a soft glow in the site's
          yellow */}
      <div ref={dot} className="absolute left-0 top-0">
        <div
          ref={dotShape}
          className="absolute w-2 h-2 rounded-full bg-stone-900 dark:bg-white"
          style={{ transform: 'translate(-50%, -50%)' }}
        />
      </div>
    </div>
  )
}

export default Cursor
