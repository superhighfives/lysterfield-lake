import {
  SkipBack,
  YoutubeLogo,
  CameraRotate,
  CaretLeft,
  CaretRight,
} from '@phosphor-icons/react'
import { useStore } from '../store'
import Tooltip from './tooltip'

function Footer() {
  const setResetting = useStore((state) => state.setResetting)
  const setResetInitialRotation = useStore(
    (state) => state.setResetInitialRotation
  )
  const dream = useStore((state) => state.dream)
  const isMobile = useStore((state) => state.isMobile)
  const requestSwap = useStore((state) => state.requestSwap)

  return (
    <>
      <button
        onClick={() => setResetting(true)}
        className="xs:rounded-l-full group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 pl-5 pr-3 py-2 xs:pl-4 xs:pr-2 xs:py-1"
      >
        <SkipBack className="w-5 h-5 xs:w-4 xs:h-4" />
        <Tooltip text="Return to home" />
      </button>
      <button
        onClick={() => requestSwap(-1)}
        className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
      >
        <CaretLeft className="w-5 h-5 xs:w-4 xs:h-4" />
        <Tooltip text="Previous dream" />
      </button>
      <button
        onClick={() => requestSwap(1)}
        className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
      >
        <CaretRight className="w-5 h-5 xs:w-4 xs:h-4" />
        <Tooltip text="Next dream" />
      </button>
      {isMobile ? (
        <button
          onClick={() => setResetInitialRotation(true)}
          className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
        >
          <CameraRotate className="w-5 h-5 xs:w-4 xs:h-4" />
          <Tooltip text="Reorient mobile" />
        </button>
      ) : null}
      {dream ? (
        <a
          className="group relative flex items-center transition-colors hover:text-yellow-600 hover:bg-yellow-200 dark:hover:text-yellow-400 dark:hover:bg-yellow-400/20 px-3 py-2 xs:px-2 xs:py-1"
          href={dream.link}
        >
          <YoutubeLogo className="w-5 h-5 xs:w-4 xs:h-4" />
          <Tooltip text="View on YouTube" />
        </a>
      ) : null}
    </>
  )
}

export default Footer
