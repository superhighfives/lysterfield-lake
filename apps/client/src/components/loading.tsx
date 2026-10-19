import { CSSProperties } from 'react'
import { Html, useProgress } from '@react-three/drei'
import { seeded } from './carousels/shared'
import dreams from '../dreams.json'

// While the scene loads: the stack you'll choose from, built as it loads —
// a polaroid drops onto the pile for each asset that arrives, with the
// same loose jitter as the choose screen's stack (components/carousels/
// stack.tsx). Cards beneath the newest go grey, as they do there, and each
// photo starts as a blank, milky print and develops as its image arrives.
// Plain HTML over the canvas, since the 3D polaroid is among what's
// loading.

// The assets counted (drei's progress), each card's jitter in the pile
// (px, degrees). The fall itself is tailwind.config.js's card-drop.
const TOTAL = 20
const JITTER: [number, number] = [34, 18]
const TWIST = 16

function Loading() {
  const { loaded } = useProgress()
  const count = Math.min(loaded, TOTAL)

  return (
    <Html center className="whitespace-nowrap">
      <div className="relative w-screen h-[100svh] flex flex-col items-center justify-center gap-10 pointer-events-none">
        <div className="relative w-[180px] h-[220px]">
          {Array.from({ length: count }, (_, i) => {
            const dream = dreams[i % dreams.length]
            const newest = i === count - 1
            return (
              <div
                key={i}
                className="absolute inset-0 motion-safe:animate-card-drop rounded-[2px] bg-white dark:bg-[#2b2826] shadow-[0_6px_18px_rgba(0,0,0,0.18)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.6)] p-[12px] pb-[46px]"
                style={
                  {
                    '--x': `${(seeded(i, 1) - 0.5) * 2 * JITTER[0]}px`,
                    '--y': `${(seeded(i, 2) - 0.5) * 2 * JITTER[1]}px`,
                    '--r': `${(seeded(i, 3) - 0.5) * 2 * TWIST}deg`,
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
        <div className="font-serif italic text-lg text-stone-500 dark:text-stone-400 tabular-nums">
          {count} of {TOTAL}
        </div>
      </div>
    </Html>
  )
}

export default Loading
