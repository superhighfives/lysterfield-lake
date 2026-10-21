import {
  ArrowLeft,
  YoutubeLogo,
  Crosshair,
  CaretLeft,
  CaretRight,
} from '@phosphor-icons/react'
import { useStore } from '../store'
import Tooltip from './tooltip'
import { youtubeLink } from '../utils/youtube'

function Footer() {
  const setResetting = useStore((state) => state.setResetting)
  const setResetInitialRotation = useStore(
    (state) => state.setResetInitialRotation
  )
  const dream = useStore((state) => state.dream)
  const isMobile = useStore((state) => state.isMobile)
  const isTouch = useStore((state) => state.isTouch)
  // On touch, swiping the polaroid swaps dreams and the room's tight, so
  // the arrows and the YouTube link go (it's still offered while
  // buffering, in routes/root.tsx).
  const compact = isMobile || isTouch
  const requestSwap = useStore((state) => state.requestSwap)

  return (
    <>
      <button
        onClick={() => setResetting(true)}
        className="xs:rounded-l-full group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:pl-4 xs:pr-2 xs:py-1"
      >
        <ArrowLeft className="w-5 h-5 xs:w-4 xs:h-4" />
        <Tooltip text="Back" />
      </button>
      {compact ? null : (
        <>
      <button
        onClick={() => requestSwap(-1)}
        className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
      >
        <CaretLeft className="w-5 h-5 xs:w-4 xs:h-4" />
        <Tooltip text="Previous" />
      </button>
      <button
        onClick={() => requestSwap(1)}
        className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
      >
        <CaretRight className="w-5 h-5 xs:w-4 xs:h-4" />
        <Tooltip text="Next" />
      </button>
        </>
      )}
      {isMobile ? (
        <button
          onClick={() => setResetInitialRotation(true)}
          className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
        >
          <Crosshair className="w-5 h-5 xs:w-4 xs:h-4" />
          <Tooltip text="Recentre" />
        </button>
      ) : null}
      {dream && !compact ? (
        <a
          className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
          href={youtubeLink(false)}
        >
          <YoutubeLogo className="w-5 h-5 xs:w-4 xs:h-4" />
          <Tooltip text="YouTube" />
        </a>
      ) : null}
    </>
  )
}

export default Footer
