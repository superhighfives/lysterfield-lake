import { SkipBack, YoutubeLogo, DeviceMobile } from '@phosphor-icons/react'
import { useStore } from '../store'
import Tooltip from './tooltip'

function Footer() {
  const setResetting = useStore((state) => state.setResetting)
  const setResetInitialRotation = useStore(
    (state) => state.setResetInitialRotation
  )
  const dream = useStore((state) => state.dream)
  const isMobile = useStore((state) => state.isMobile)

  return (
    <>
      <button
        onClick={() => setResetting(true)}
        className="xs:rounded-l-full group relative flex transition-colors hover:text-yellow-600 hover:bg-yellow-200 pl-5 pr-3 py-2"
      >
        <SkipBack className="inline" />
        <Tooltip text="Return to home" />
      </button>
      {isMobile ? (
        <button
          onClick={() => setResetInitialRotation(true)}
          className="group relative flex transition-colors hover:text-yellow-600 hover:bg-yellow-200 px-3 py-2"
        >
          <DeviceMobile className="inline" />
          <Tooltip text="Reorient mobile" />
        </button>
      ) : null}
      {dream ? (
        <a
          className="group relative flex transition-colors hover:text-yellow-600 hover:bg-yellow-200 px-3 py-2"
          href={dream.link}
        >
          <YoutubeLogo className="inline" />
          <Tooltip text="View on YouTube" />
        </a>
      ) : null}
    </>
  )
}

export default Footer
