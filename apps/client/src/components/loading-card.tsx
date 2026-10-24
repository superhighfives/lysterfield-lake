import { CSSProperties } from 'react'
import type { Dream } from '../utils/types'

export const heroUrl = (id: string) => `/assets/${id}/hero.jpg`

// The loading pile spreads wide, as cards tossed down from all over: up
// to SPREAD of the window's size each way (capped at SPREAD_MAX px). Here,
// not in components/loading.tsx, so the pile's placeholder
// (components/loading-shell.tsx) lays out the same, with the count below
// it PILE_GAP clear of the spread.
const SPREAD: [number, number] = [0.16, 0.12]
const SPREAD_MAX: [number, number] = [170, 110]
export const PILE_GAP = 40
export const pileSpread = (axis: 0 | 1) =>
  Math.min(
    (axis === 0 ? window.innerWidth : window.innerHeight) * SPREAD[axis],
    SPREAD_MAX[axis]
  )

// A polaroid in HTML, 180 x 220: the loading pile's cards
// (components/loading.tsx), and the dream about to play on the title
// screen (routes/root.tsx). Paper with a faint fall of light across it, a
// fine edge, and two shadows, tight where it touches and soft around it; a
// square print set into the frame; the dream's name and prompt beneath, as
// on the chooser's cards.
function LoadingCard({
  dream,
  className = '',
  style,
  grey = false,
  developDelay,
}: {
  dream: Dream
  className?: string
  style?: CSSProperties
  /** Greyed, as the cards beneath the newest are. */
  grey?: boolean
  /** When the photo starts developing (ms); left out, it's developed. */
  developDelay?: number
}) {
  return (
    <div
      className={`flex flex-col rounded-[3px] p-[11px] bg-[linear-gradient(165deg,#ffffff,#f1eee9)] dark:bg-[linear-gradient(165deg,#36322e,#252220)] ring-1 ring-black/5 dark:ring-white/5 shadow-[0_1px_2px_rgba(0,0,0,0.1),0_10px_24px_rgba(0,0,0,0.16)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.5),0_10px_24px_rgba(0,0,0,0.6)] ${className}`}
      style={style}
    >
      {/* Greyed here rather than on the photo, whose develop animates its
          own filter. */}
      <div
        className={`relative aspect-square w-full overflow-hidden bg-[#e7e3dc] dark:bg-[#d9d4cb] transition-[filter] duration-1000 ${
          grey ? 'grayscale' : ''
        }`}
      >
        {/* Develops once the card's landed, whether or not the image was
            cached (an onLoad fade never showed then). Anonymous, as
            three.js's texture loader fetches the same photos for the
            chooser, so they're downloaded once. */}
        <img
          src={heroUrl(dream.id)}
          crossOrigin="anonymous"
          alt=""
          className={`w-full h-full object-cover ${
            developDelay === undefined ? '' : 'motion-safe:animate-develop'
          }`}
          style={developDelay === undefined ? undefined : { animationDelay: `${developDelay}ms` }}
        />
        <div className="absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08),inset_0_1px_4px_rgba(0,0,0,0.12)] bg-[linear-gradient(135deg,rgba(255,255,255,0.22),rgba(255,255,255,0)_45%)]" />
      </div>
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
}

export default LoadingCard
