import { SWAP_STYLES, useStore } from '../store'

// Prototype only: switches between the polaroid swap animations (see
// utils/swap-poses.ts) in the player, to compare them. Shown in dev, or
// anywhere with `?swap=` in the URL.
const enabled =
  import.meta.env.DEV || new URLSearchParams(location.search).has('swap')

function Row<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="fixed z-10 top-1 left-1 flex items-center gap-1 font-sans text-sm bg-white/80 dark:bg-stone-900/80 rounded-full px-2 py-1 shadow">
      <span className="text-stone-500 px-1">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`px-2 rounded-full ${
            option === value
              ? 'bg-yellow-400 text-stone-900'
              : 'hover:bg-yellow-200 dark:hover:bg-yellow-400/20'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function SwapStylePicker() {
  const swapStyle = useStore((state) => state.swapStyle)
  const setSwapStyle = useStore((state) => state.setSwapStyle)
  const showPlayhead = useStore((state) => state.showPlayhead)
  const ready = useStore((state) => state.ready)
  if (!enabled || !ready) return null

  if (!showPlayhead) return null
  return (
    <Row
      label="Swap"
      options={SWAP_STYLES}
      value={swapStyle}
      onChange={setSwapStyle}
    />
  )
}

export default SwapStylePicker
