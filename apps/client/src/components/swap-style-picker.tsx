import { SWAP_STYLES, useStore } from '../store'

// Prototype only: switches between the polaroid swap animations (see
// utils/swap-poses.ts) to compare them. Shown in dev, or anywhere with
// `?swap=<style>` in the URL.
const enabled =
  import.meta.env.DEV || new URLSearchParams(location.search).has('swap')

function SwapStylePicker() {
  const swapStyle = useStore((state) => state.swapStyle)
  const setSwapStyle = useStore((state) => state.setSwapStyle)
  const showPlayhead = useStore((state) => state.showPlayhead)
  if (!enabled || !showPlayhead) return null

  return (
    <div className="fixed z-10 top-1 left-1 flex items-center gap-1 font-sans text-sm bg-white/80 dark:bg-stone-900/80 rounded-full px-2 py-1 shadow">
      <span className="text-stone-500 px-1">Swap</span>
      {SWAP_STYLES.map((style) => (
        <button
          key={style}
          onClick={() => setSwapStyle(style)}
          className={`px-2 rounded-full ${
            style === swapStyle
              ? 'bg-yellow-400 text-stone-900'
              : 'hover:bg-yellow-200 dark:hover:bg-yellow-400/20'
          }`}
        >
          {style}
        </button>
      ))}
    </div>
  )
}

export default SwapStylePicker
