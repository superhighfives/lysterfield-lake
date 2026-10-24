import { CSSProperties, useEffect, useRef, useState } from 'react'
import { useProgress } from '@react-three/drei'
import { seeded } from './carousels/shared'
import Spinner from './spinner'
import { useStore } from '../store'
import dreams from '../dreams.json'

// While the scene loads: the stack you'll choose from, built as it loads —
// a polaroid drops onto the pile for each asset that arrives, with the
// same loose jitter as the choose screen's stack (components/carousels/
// stack.tsx). Cards beneath the newest go grey, as they do there, and each
// photo starts as a blank, milky print and develops as its image arrives.
// They fall from above the window. A spinner turns where they land until
// the first covers it, and the count beneath fades out once it's complete.
//
// Plain HTML over the canvas rather than the canvas's Suspense fallback,
// so it can leave rather than vanish. A card only drops once its photo has
// loaded, so it lands ready to develop. Once the scene's mounted
// (`sceneLoaded`) and every card's photo has developed, the pile holds
// for HOLD_MS, then scatters card by card from the top,
// while the scene fades in beneath it (`pileLeaving`, routes/root.tsx).

// The most cards the pile holds (a card per asset drei's progress counts),
// each card's jitter in the pile (px, degrees). The fall in and out are
// tailwind.config.js's card-drop and card-leave. DROP_STAGGER: the delay between cards that arrive together
// (ms), so a batch drops one after another rather than in a lump;
// LEAVE_STAGGER: the delay between one card leaving and the next, so the
// pile peels away from the top rather than falling as one; LEAVE_MS: how
// long until the last has gone.
const MAX_CARDS = 20
const JITTER: [number, number] = [34, 18]
const TWIST = 16
const DROP_STAGGER = 70
const LEAVE_STAGGER = 25
// How long after a card starts falling its photo starts developing (ms).
const DEVELOP_AFTER = 400
// The develop itself (tailwind.config.js's develop), then how long the
// developed pile holds before it falls away (ms).
const DEVELOP_MS = 1600
const HOLD_MS = 1000
const LEAVE_MS = 600 + MAX_CARDS * LEAVE_STAGGER

// How the pile scatters as it leaves: each card flies off in its own
// direction, SCATTER_DISTANCE (vmax, enough to clear the screen from the
// middle) plus a little more for some, turning up to SCATTER_SPIN degrees.
const SCATTER_DISTANCE = 75
const SCATTER_SPIN = 140
const scatter = (i: number) => {
  const angle = seeded(i, 4) * Math.PI * 2
  const distance = SCATTER_DISTANCE * (1 + seeded(i, 5) * 0.3)
  return {
    '--sx': `${Math.cos(angle) * distance}vmax`,
    '--sy': `${Math.sin(angle) * distance}vmax`,
    '--sr': `${(seeded(i, 6) - 0.5) * 2 * SCATTER_SPIN}deg`,
  }
}

// The photos the pile shows (one per dream, repeating), preloaded as it
// mounts so a card can wait for its own.
const heroUrl = (id: string) => `/assets/${id}/hero.jpg`

function Loading() {
  // Counted against what's actually queued, so it ends on "n of n" (a
  // fixed 20 stopped at 19).
  const { loaded, total } = useProgress()
  const sceneLoaded = useStore((state) => state.sceneLoaded)
  const setPileLeaving = useStore((state) => state.setPileLeaving)
  // Already loaded when this mounts (a cached scene): there's no pile to
  // clear away.
  const [gone, setGone] = useState(sceneLoaded)
  const [leaving, setLeaving] = useState(sceneLoaded)

  // Which dreams' photos have loaded. One that fails counts too, so the
  // pile can't wait on it forever.
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (gone) return
    const images = dreams.map(({ id }) => {
      const image = new Image()
      // Anonymous, as three.js's texture loader fetches the same photos
      // for the chooser (views/choose.tsx), so they're downloaded once.
      image.crossOrigin = 'anonymous'
      const done = () => setReady((prev) => new Set(prev).add(id))
      image.onload = done
      image.onerror = done
      image.src = heroUrl(id)
      return image
    })
    return () => images.forEach((image) => (image.onload = image.onerror = null))
  }, [gone])

  // Cards drop in order, each once its asset's counted and its photo's in.
  const wanted = Math.min(loaded, MAX_CARDS)
  let count = 0
  while (count < wanted && ready.has(dreams[count % dreams.length].id)) count++
  // Each card's drop delay, fixed when it first appears (changing it
  // mid-fall would restart the fall), and when its photo finishes
  // developing (performance.now() ms).
  const dropDelays = useRef<number[]>([])
  const developed = useRef<number[]>([])
  const shown = dropDelays.current.length
  const now = performance.now()
  for (let i = shown; i < count; i++) {
    const delay = (i - shown) * DROP_STAGGER
    dropDelays.current.push(delay)
    developed.current.push(now + delay + DEVELOP_AFTER + DEVELOP_MS)
  }

  // Every card in (the count only reaches n of n once the scene's loaded):
  // hold once the last has developed, then leave.
  const allIn = sceneLoaded && count === Math.min(Math.max(loaded, total), MAX_CARDS)
  useEffect(() => {
    if (!allIn || leaving) return
    const lastDeveloped = Math.max(0, ...developed.current)
    const wait = Math.max(0, lastDeveloped - performance.now()) + HOLD_MS
    const timeout = window.setTimeout(() => setLeaving(true), wait)
    return () => window.clearTimeout(timeout)
  }, [allIn, leaving])

  useEffect(() => {
    if (leaving) setPileLeaving(true)
    if (!leaving || gone) return
    const timeout = window.setTimeout(() => setGone(true), LEAVE_MS)
    return () => window.clearTimeout(timeout)
  }, [leaving, gone, setPileLeaving])

  if (gone) return null

  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-10 pointer-events-none whitespace-nowrap">
      <div className="relative w-[180px] h-[220px]">
        {/* Behind the cards, which cover it as they land. Already faded in
            by components/loading-shell.tsx, which draws it here first. */}
        <div
          className={`absolute inset-0 grid place-items-center transition-opacity duration-300 ${
            leaving ? 'opacity-0' : ''
          }`}
        >
          <Spinner />
        </div>
        {Array.from({ length: count }, (_, i) => {
          const dream = dreams[i % dreams.length]
          const newest = i === count - 1
          return (
            <div
              key={i}
              // Paper with a faint fall of light across it, a fine edge, and
              // two shadows: tight where it touches, soft around it.
              className={`absolute inset-0 flex flex-col rounded-[3px] p-[11px] bg-[linear-gradient(165deg,#ffffff,#f1eee9)] dark:bg-[linear-gradient(165deg,#36322e,#252220)] ring-1 ring-black/5 dark:ring-white/5 shadow-[0_1px_2px_rgba(0,0,0,0.1),0_10px_24px_rgba(0,0,0,0.16)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.5),0_10px_24px_rgba(0,0,0,0.6)] ${
                leaving
                  ? 'motion-safe:animate-card-leave motion-reduce:opacity-0'
                  : 'motion-safe:animate-card-drop'
              }`}
              style={
                {
                  '--x': `${(seeded(i, 1) - 0.5) * 2 * JITTER[0]}px`,
                  '--y': `${(seeded(i, 2) - 0.5) * 2 * JITTER[1]}px`,
                  '--r': `${(seeded(i, 3) - 0.5) * 2 * TWIST}deg`,
                  // Where it scatters to as the pile leaves: its own
                  // direction, far enough to clear the screen, with a spin.
                  ...scatter(i),
                  // The top card leaves first.
                  animationDelay: `${
                    leaving
                      ? (count - 1 - i) * LEAVE_STAGGER
                      : dropDelays.current[i]
                  }ms`,
                  transform: 'translate(var(--x), var(--y)) rotate(var(--r))',
                } as CSSProperties
              }
            >
              {/* Greyed here rather than on the photo, whose develop
                  animates its own filter. */}
              <div
                className={`relative aspect-square w-full overflow-hidden bg-[#e7e3dc] dark:bg-[#d9d4cb] transition-[filter] duration-1000 ${
                  newest ? '' : 'grayscale'
                }`}
              >
                {/* Develops once the card's landed, whether or not the
                    image was cached (an onLoad fade never showed then). */}
                <img
                  src={heroUrl(dream.id)}
                  crossOrigin="anonymous"
                  alt=""
                  className="w-full h-full object-cover motion-safe:animate-develop"
                  style={{
                    animationDelay: `${dropDelays.current[i] + DEVELOP_AFTER}ms`,
                  }}
                />
                {/* The print set into the frame, and a soft sheen. */}
                <div className="absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08),inset_0_1px_4px_rgba(0,0,0,0.12)] bg-[linear-gradient(135deg,rgba(255,255,255,0.22),rgba(255,255,255,0)_45%)]" />
              </div>
              {/* The caption strip: the dream's name and prompt, as on the
                  chooser's cards. */}
              <div className="flex-1 min-h-0 flex flex-col justify-center gap-[2px] px-[3px] overflow-hidden">
                <span className="font-serif italic text-[15px] leading-none text-stone-800 dark:text-stone-200 truncate">
                  {dream.title}
                </span>
                {dream.prompt ? (
                  <span className="font-mono text-[7px] leading-tight text-stone-400 dark:text-stone-500 truncate">
                    &ldquo;{dream.prompt}&rdquo;
                  </span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      {/* Fades in, and out once it reaches n of n. */}
      <div
        className={`font-serif italic text-lg text-stone-500 dark:text-stone-400 tabular-nums transition-opacity duration-500 ${
          sceneLoaded || (total > 0 && loaded >= total) ? 'opacity-0' : ''
        }`}
      >
        <div className="animate-fade-in">
          {loaded} of {Math.max(total, loaded)}
        </div>
      </div>
    </div>
  )
}

export default Loading
