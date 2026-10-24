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
// for HOLD_MS, then falls away together (the top card a touch ahead),
// while the scene fades in beneath it (`pileLeaving`, routes/root.tsx).

// The most cards the pile holds (a card per asset drei's progress counts),
// each card's jitter in the pile (px, degrees). The fall in and out are
// tailwind.config.js's card-drop and card-leave. DROP_STAGGER: the delay between cards that arrive together
// (ms), so a batch drops one after another rather than in a lump;
// LEAVE_STAGGER: the delay between one card leaving and the next, a
// little looseness in a pile that otherwise falls as one; LEAVE_MS: how
// long until the last has gone.
const MAX_CARDS = 20
const JITTER: [number, number] = [34, 18]
const TWIST = 16
const DROP_STAGGER = 70
const LEAVE_STAGGER = 12
// How long after a card starts falling its photo starts developing (ms).
const DEVELOP_AFTER = 400
// The develop itself (tailwind.config.js's develop), then how long the
// developed pile holds before it falls away (ms).
const DEVELOP_MS = 1600
const HOLD_MS = 1000
const LEAVE_MS = 600 + MAX_CARDS * LEAVE_STAGGER

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
              className={`absolute inset-0 rounded-[2px] bg-white dark:bg-[#2b2826] shadow-[0_6px_18px_rgba(0,0,0,0.18)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.6)] p-[12px] pb-[46px] ${
                leaving
                  ? 'motion-safe:animate-card-leave motion-reduce:opacity-0'
                  : 'motion-safe:animate-card-drop'
              }`}
              style={
                {
                  '--x': `${(seeded(i, 1) - 0.5) * 2 * JITTER[0]}px`,
                  '--y': `${(seeded(i, 2) - 0.5) * 2 * JITTER[1]}px`,
                  '--r': `${(seeded(i, 3) - 0.5) * 2 * TWIST}deg`,
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
                className={`w-full h-full bg-[#e7e3dc] dark:bg-[#d9d4cb] transition-[filter] duration-1000 ${
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
