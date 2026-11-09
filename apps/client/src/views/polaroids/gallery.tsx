import { useCallback, useEffect, useRef, useState } from 'react'
import { PolaroidScene } from '../../components/loop-polaroid.tsx'
import { loadGallery, polaroidFile } from './api.ts'
import { mod, polaroidAt } from './grid.ts'
import { Header, PRIMARY, SECONDARY } from './shell.tsx'

// The gallery (/polaroids, plans/in-progress/polaroids.md step 4): every shown polaroid on an endless grid that
// wraps in every direction, dragged or scrolled around. Stills by default; only the few nearest the centre play
// their loops, so a phone isn't decoding dozens of videos. Opening one shows it in 3D.
//
// The motion borrows records.charliegleason.com's grid: a spotlight round the screen's centre, so the cards there
// are in colour, a little larger and straightened, and the rest grey and dim; colour that comes in fast and leaves
// slowly, so cards dragged past leave a trail; and, on top of that, the wall leaning a few degrees into the
// direction it's moving. On a desktop, pointing at a card lights it too. All of it is eased per frame and written
// straight to the cards, never through React or a CSS transition.

/** Loops playing at once: the cards nearest the centre. */
const PLAYING = 3
/** Drag slower than this (px/ms) and let go, and the grid stops where it is. */
const MIN_FLING = 0.05
/** How quickly a fling slows, per second. */
const FRICTION = 4
/** A press that moves less than this is a click on a card, not a drag. */
const CLICK_PX = 6
/** The spotlight, in pitches from the screen's centre to a card's: full within SPOT_CORE, gone by SPOT_FALLOFF. */
const SPOT_CORE = 0.55
const SPOT_FALLOFF = 1.5
/** How much a lit card grows, and how dim an unlit one gets (it also goes grey). */
const LIFT = 0.05
const DIM = 0.82
/** Per-frame easing toward the spotlight: quick into it, slow out of it, so cards dragged past leave a colour trail. */
const EASE_IN = 0.35
const EASE_OUT = 0.04
const SETTLE = 0.002
/** The lean while the wall moves: degrees per px/ms of sideways speed, at most MAX_LEAN, eased back when it stops. */
const LEAN_PER_SPEED = 5
const MAX_LEAN = 4
const LEAN_EASE = 0.12

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

type Cell = { key: string; cx: number; cy: number; id: string; x: number; y: number; turn: number }

/** The card's side and the grid's pitch: about two and a half cards across the shorter side of the screen. */
const pitchFor = (w: number, h: number) => Math.round(Math.min(300, Math.max(160, Math.min(w, h) / 2.4)))

/** A small, steady tilt for each grid position, so the wall looks pinned up by hand. */
function turnFor(cx: number, cy: number) {
  const n = Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453
  return ((n - Math.floor(n)) * 2 - 1) * 3
}

export default function Gallery() {
  const [ids, setIds] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [cells, setCells] = useState<Cell[]>([])
  const [playing, setPlaying] = useState<string[]>([])
  const plane = useRef<HTMLDivElement>(null)
  const pitch = pitchFor(size.w, size.h)
  // The grid's position, how fast it's moving (px/ms), and the press under way, kept out of React: they change every frame.
  const motion = useRef({ x: size.w / 2 - pitch / 2, y: size.h / 2 - pitch / 2, vx: 0, vy: 0 })
  const press = useRef<{ x: number; y: number; t: number; moved: number } | null>(null)
  // Each card's element and how lit it is (0 to 1, eased), the card under a mouse pointer, and the wall's lean.
  const cardEls = useRef(new Map<string, HTMLDivElement>())
  const light = useRef(new Map<string, { p: number; written: number }>())
  const hovered = useRef<string | null>(null)
  const lean = useRef(0)
  // Where the wall is gliding to, after a card was tabbed to; a drag or a scroll drops it.
  const aim = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    loadGallery().then(
      (polaroids) => setIds(polaroids.map((p) => p.id)),
      (e: Error) => setError(e.message)
    )
  }, [])

  useEffect(() => {
    const resize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // Every frame: carry a fling on, move the plane, and, when the visible grid positions or the nearest cards change,
  // render those.
  useEffect(() => {
    if (!ids || ids.length === 0) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = performance.now()
    let shown = ''
    let near = ''
    const frame = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      const m = motion.current
      if (!press.current && (m.vx || m.vy)) {
        m.x += m.vx * dt
        m.y += m.vy * dt
        const decay = still ? 0 : Math.exp((-FRICTION * dt) / 1000)
        m.vx = Math.abs(m.vx * decay) < 0.01 ? 0 : m.vx * decay
        m.vy = Math.abs(m.vy * decay) < 0.01 ? 0 : m.vy * decay
      }

      const a = aim.current
      if (a) {
        m.x += (a.x - m.x) * (still ? 1 : 0.15)
        m.y += (a.y - m.y) * (still ? 1 : 0.15)
        if (Math.hypot(a.x - m.x, a.y - m.y) < 0.5) aim.current = null
      }

      if (plane.current) plane.current.style.transform = `translate3d(${m.x}px, ${m.y}px, 0)`

      const x0 = Math.floor((-m.x - pitch) / pitch)
      const x1 = Math.ceil((size.w - m.x) / pitch)
      const y0 = Math.floor((-m.y - pitch) / pitch)
      const y1 = Math.ceil((size.h - m.y) / pitch)
      const range = `${x0},${x1},${y0},${y1}`
      const next: Cell[] = []
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const x = cx * pitch + (mod(cy, 2) ? pitch / 2 : 0)
          next.push({ key: `${cx},${cy}`, cx, cy, id: ids[polaroidAt(cx, cy, ids.length)], x, y: cy * pitch, turn: turnFor(cx, cy) })
        }
      }

      if (range !== shown) {
        shown = range
        setCells(next)
        const keys = new Set(next.map((c) => c.key))
        for (const key of light.current.keys()) if (!keys.has(key)) light.current.delete(key)
      }

      // The lean follows sideways speed, while dragging or flinging, and springs back level when the wall stops.
      lean.current += ((still ? 0 : clamp(-m.vx * LEAN_PER_SPEED, -MAX_LEAN, MAX_LEAN)) - lean.current) * LEAN_EASE
      const cardW = pitch * 0.84
      const offset = { x: pitch * 0.08 + cardW / 2, y: pitch * 0.04 + cardW * 0.6 }
      for (const c of next) {
        const el = cardEls.current.get(c.key)
        if (!el) continue
        const d = Math.hypot(m.x + c.x + offset.x - size.w / 2, m.y + c.y + offset.y - size.h / 2) / pitch
        const target = hovered.current === c.key && !press.current ? 1 : d <= SPOT_CORE ? 1 : clamp(1 - (d - SPOT_CORE) / (SPOT_FALLOFF - SPOT_CORE), 0, 1)
        const state = light.current.get(c.key) ?? { p: target, written: -1 }
        state.p += (target - state.p) * (target > state.p ? EASE_IN : EASE_OUT)
        if (Math.abs(target - state.p) < SETTLE) state.p = target
        light.current.set(c.key, state)
        // A lit card straightens; every card leans with the wall. Transforms are cheap, so they're written each frame.
        const turn = still ? c.turn : c.turn * (1 - state.p) + lean.current
        el.style.transform = `rotate(${turn}deg) scale(${still ? 1 : 1 + LIFT * state.p})`
        // Filters repaint, so only when the light has changed.
        if (Math.abs(state.p - state.written) > 0.004) {
          el.style.filter = `grayscale(${1 - state.p}) brightness(${DIM + (1 - DIM) * state.p})`
          el.style.zIndex = String(Math.round(state.p * 10))
          state.written = state.p
        }
      }

      // The cards whose centres are nearest the screen's.
      const centre = { x: size.w / 2 - m.x - pitch / 2, y: size.h / 2 - m.y - pitch / 2 }
      const nearest = next
        .map((c) => ({ key: c.key, d: (c.x - centre.x) ** 2 + (c.y - centre.y) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, PLAYING)
        .map((c) => c.key)
      const nearKey = nearest.join('|')
      if (nearKey !== near) {
        near = nearKey
        setPlaying(nearest)
      }

      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [ids, pitch, size])

  // Scrolling moves it too (a trackpad in both directions), and the arrow keys a card at a time.
  const viewport = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const m = motion.current
      m.vx = m.vy = 0
      aim.current = null
      m.x -= e.shiftKey ? e.deltaY : e.deltaX
      m.y -= e.shiftKey ? 0 : e.deltaY
    }

    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [ids])

  const close = useCallback(() => setOpen(null), [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close()
      if (open) return
      const step = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]
      if (!step) return
      motion.current.x += step[0] * pitch
      motion.current.y += step[1] * pitch
    }

    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, pitch, close])

  const empty = ids?.length === 0
  return (
    // Clip, not hidden: the cards spill past the edges, and a hidden overflow can still be scrolled (focusing a
    // card scrolls it into view), which shifted the whole page sideways.
    <div className="fixed inset-0 overflow-clip font-sans text-stone-900 dark:text-stone-100 [color-scheme:light] dark:[color-scheme:dark]">
      {ids && !empty && (
        <div
          ref={viewport}
          className="absolute inset-0 cursor-grab touch-none select-none overflow-clip active:cursor-grabbing"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            motion.current.vx = motion.current.vy = 0
            aim.current = null
            press.current = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }
          }}
          onPointerMove={(e) => {
            const p = press.current
            if (!p) return
            const now = performance.now()
            const dx = e.clientX - p.x
            const dy = e.clientY - p.y
            const dt = Math.max(1, now - p.t)
            const m = motion.current
            m.x += dx
            m.y += dy
            // Smoothed, so the last jittery move before letting go doesn't decide the fling.
            m.vx = m.vx * 0.6 + (dx / dt) * 0.4
            m.vy = m.vy * 0.6 + (dy / dt) * 0.4
            press.current = { x: e.clientX, y: e.clientY, t: now, moved: p.moved + Math.hypot(dx, dy) }
          }}
          onPointerUp={(e) => {
            const p = press.current
            press.current = null
            if (!p) return
            const m = motion.current
            if (Math.hypot(m.vx, m.vy) < MIN_FLING || performance.now() - p.t > 80) m.vx = m.vy = 0
            if (p.moved < CLICK_PX) {
              const card = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-polaroid]')
              if (card?.dataset.polaroid) setOpen(card.dataset.polaroid)
            }
          }}
          onPointerCancel={() => (press.current = null)}
        >
          <div ref={plane} className="absolute left-0 top-0 will-change-transform">
            {cells.map((cell) => (
              <div
                key={cell.key}
                data-polaroid={cell.id}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setOpen(cell.id)
                  }
                }}
                aria-label="Open this polaroid"
                ref={(el) => {
                  if (el) cardEls.current.set(cell.key, el)
                  else cardEls.current.delete(cell.key)
                }}
                // Tabbing to a card brings it to the middle, where the spotlight is; a click's focus doesn't move the wall.
                onFocus={(e) => {
                  if (!e.currentTarget.matches(':focus-visible')) return
                  motion.current.vx = motion.current.vy = 0
                  aim.current = { x: size.w / 2 - (cell.x + pitch / 2), y: size.h / 2 - (cell.y + pitch / 2) }
                }}
                onPointerEnter={(e) => {
                  if (e.pointerType === 'mouse') hovered.current = cell.key
                }}
                onPointerLeave={() => {
                  if (hovered.current === cell.key) hovered.current = null
                }}
                className="absolute bg-white shadow-lg shadow-stone-900/20 dark:bg-[#2b2826] dark:shadow-black/40"
                // Charcoal in dark mode, the 3D polaroid's FRAME_DARK (models/polaroid.tsx). The border is in pixels, from
                // the card's own width: a percentage would be of the plane's, which has none, so there'd be no border.
                style={{ left: cell.x + pitch * 0.08, top: cell.y + pitch * 0.04, width: pitch * 0.84, padding: `${pitch * 0.042}px ${pitch * 0.042}px ${pitch * 0.143}px`, transform: `rotate(${cell.turn}deg)`, filter: `grayscale(1) brightness(${DIM})`, willChange: 'transform' }}
              >
                {playing.includes(cell.key) ? (
                  <video src={polaroidFile(cell.id, 'loop.mp4')} poster={polaroidFile(cell.id, 'still.jpg')} autoPlay muted loop playsInline className="pointer-events-none aspect-square w-full bg-stone-200 object-cover" />
                ) : (
                  <img src={polaroidFile(cell.id, 'still.jpg')} alt="" draggable={false} loading="lazy" className="pointer-events-none aspect-square w-full bg-stone-200 object-cover" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0">
        <Header>
          <a href="/polaroids/add" className={`pointer-events-auto ${PRIMARY}`}>
            Add yours
          </a>
        </Header>
      </div>

      {(error || empty || !ids) && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          <div>
            <h1 className="font-serif text-4xl">Polaroids</h1>
            <p className="mt-2 text-stone-600 dark:text-stone-400">{error || (empty ? 'None yet. Yours could be the first.' : 'Loading…')}</p>
            {empty && (
              <a href="/polaroids/add" className={`mt-4 ${PRIMARY}`}>
                Add yours
              </a>
            )}
          </div>
        </div>
      )}

      {ids && !empty && <p className="pointer-events-none absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] text-center text-sm text-stone-500 dark:text-stone-400">Drag to look around. Tap one to see it up close.</p>}

      {open && (
        // Closed with its button or Escape: the whole of it is the polaroid's, which turns as the pointer moves over it.
        <div role="dialog" aria-modal="true" aria-label="A polaroid" className="absolute inset-0 z-10 bg-stone-100/90 backdrop-blur dark:bg-stone-950/90">
          <PolaroidScene atlas={polaroidFile(open, 'atlas.mp4')} hint="" />
          <button type="button" onClick={close} className={`absolute right-4 top-[max(1rem,env(safe-area-inset-top))] ${SECONDARY} bg-white/80 dark:bg-stone-900/80`}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
