import Spinner from './spinner'

// The loading pile before its code has arrived (components/experience.tsx
// loads lazily): its spinner, laid out exactly where components/loading.tsx
// draws its own, so the hand-over doesn't jump. The count's line is held
// empty for the same reason.
function LoadingShell() {
  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-10 pointer-events-none whitespace-nowrap">
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
