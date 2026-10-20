import { CSSProperties, useEffect, useState } from 'react'
import { useProgress } from '@react-three/drei'
import { seeded } from './carousels/shared'
import { useStore } from '../store'
import dreams from '../dreams.json'

// While the scene loads: the stack you'll choose from, built as it loads —
// a polaroid drops onto the pile for each asset that arrives, with the
// same loose jitter as the choose screen's stack (components/carousels/
// stack.tsx). Cards beneath the newest go grey, as they do there, and each
// photo starts as a blank, milky print and develops as its image arrives.
//
// Plain HTML over the canvas rather than the canvas's Suspense fallback,
// so it can leave rather than vanish: once the scene's mounted
// (`sceneLoaded`), the cards fall away, the top one first, while the
// scene fades in beneath them (routes/root.tsx).

// The assets counted (drei's progress), each card's jitter in the pile
// (px, degrees). The fall in and out are tailwind.config.js's card-drop and
// card-leave. LEAVE_STAGGER: the delay between one card leaving and the
// next (ms); LEAVE_MS: how long until the last has gone.
const TOTAL = 20
const JITTER: [number, number] = [34, 18]
const TWIST = 16
const LEAVE_STAGGER = 35
const LEAVE_MS = 600 + TOTAL * LEAVE_STAGGER

function Loading() {
  const { loaded } = useProgress()
  const count = Math.min(loaded, TOTAL)
  const sceneLoaded = useStore((state) => state.sceneLoaded)
  // Already loaded when this mounts (a cached scene): there's no pile to
  // clear away.
  const [gone, setGone] = useState(sceneLoaded)

  useEffect(() => {
    if (!sceneLoaded || gone) return
    const timeout = window.setTimeout(() => setGone(true), LEAVE_MS)
    return () => window.clearTimeout(timeout)
  }, [sceneLoaded, gone])

  if (gone) return null
  const leaving = sceneLoaded

  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-10 pointer-events-none whitespace-nowrap">
      <div className="relative w-[180px] h-[220px]">
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
                  animationDelay: leaving
                    ? `${(count - 1 - i) * LEAVE_STAGGER}ms`
                    : undefined,
                  transform: 'translate(var(--x), var(--y)) rotate(var(--r))',
                } as CSSProperties
              }
            >
              <div className="w-full h-full bg-[#e7e3dc] dark:bg-[#d9d4cb]">
                <img
                  src={`/assets/${dream.id}/hero.jpg`}
                  alt=""
                  onLoad={(event) => (event.currentTarget.style.opacity = '1')}
                  style={{ opacity: 0 }}
                  className={`w-full h-full object-cover transition-[opacity,filter] duration-1000 ${
                    newest ? '' : 'grayscale'
                  }`}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div
        className={`font-serif italic text-lg text-stone-500 dark:text-stone-400 tabular-nums transition-opacity duration-300 ${
          leaving ? 'opacity-0' : ''
        }`}
      >
        {count} of {TOTAL}
      </div>
    </div>
  )
}

export default Loading
