import Spinner from './spinner'
import { dreamFromLocation } from '../utils/use-history-sync'
import { PILE_GAP, pileSpread } from './loading-card'

// The loading pile before its code has arrived (components/experience.tsx
// loads lazily): its spinner, laid out exactly where components/loading.tsx
// draws its own, so the hand-over doesn't jump. The count's line is held
// empty for the same reason.
function LoadingShell() {
  return (
    <div
      className="fixed inset-0 z-10 flex flex-col items-center justify-center pointer-events-none whitespace-nowrap"
      // As components/loading.tsx spaces it: a dream's own link is a
      // single card, with no spread.
      style={{ gap: dreamFromLocation() ? PILE_GAP : PILE_GAP + pileSpread(1) }}
    >
      <div className="relative w-[180px] h-[220px] grid place-items-center">
        <div className="animate-fade-in">
          <Spinner />
        </div>
      </div>
      <div aria-hidden className="font-serif italic text-lg invisible">
        0
      </div>
    </div>
  )
}

export default LoadingShell
