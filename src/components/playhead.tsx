import {
  forwardRef,
  HTMLProps,
  MutableRefObject,
  useEffect,
  useState,
} from 'react'
import { useStore } from '../store'
import {
  Play,
  Pause,
  Spinner,
  SpeakerSimpleX,
  SpeakerSimpleNone,
  SpeakerSimpleLow,
  SpeakerSimpleHigh,
  CameraRotate,
} from '@phosphor-icons/react'
import Tooltip from '../views/tooltip'

import * as Media from '@react-av/core'
import {
  Mute,
  PlayPause,
  Timestamp,
  toTimestampString,
} from '@react-av/controls'
import * as Slider from '@radix-ui/react-slider'
import {
  ProgressBarRoot,
  ProgressBarBufferedRanges,
  ProgressBarTooltip,
  useMediaProgressBarTooltip,
} from '@react-av/sliders'
import Footer from '../views/footer'

function StyledProgressBarTooltip() {
  const { percentage } = useMediaProgressBarTooltip()
  const duration = Media.useMediaDuration()

  return (
    <ProgressBarTooltip
      className="text-gray-400 font-mono transition opacity-0 bg-white text-xs px-2 rounded-full absolute -translate-x-1/2 -translate-y-[calc(50%_+_24px)] tracking-wider pointer-events-none"
      position="center"
      showingClassName="opacity-100"
    >
      {toTimestampString(duration * percentage, duration >= 3600)}
    </ProgressBarTooltip>
  )
}

const Playhead = forwardRef<HTMLVideoElement, HTMLProps<HTMLVideoElement>>(
  (_props, ref) => {
    const dream = useStore((state) => state.dream)
    const showPlayhead = useStore((state) => state.showPlayhead)
    const videoPlaying = useStore((state) => state.videoPlaying)
    const isMobile = useStore((state) => state.isMobile)
    const isTouch = useStore((state) => state.isTouch)
    const globalPointer = useStore((state) => state.globalPointer)
    const [recalibrateMobile, setRecalibrateMobile] = useState(false)

    const setResetInitialRotation = useStore(
      (state) => state.setResetInitialRotation
    )
    const polaroidVisible = useStore((state) => state.polaroidVisible)
    const setResetting = useStore((state) => state.setResetting)
    const setSeeking = useStore((state) => state.setSeeking)

    function VideoPlayer() {
      const setVideoPlaying = useStore((state) => state.setVideoPlaying)
      const setVideoState = useStore((state) => state.setVideoState)

      const mediaReadyState = Media.useMediaReadyState()
      const [mediaPlaying] = Media.useMediaPlaying()
      const mediaEnded = Media.useMediaEnded()
      const mediaSeeking = Media.useMediaSeeking()

      useEffect(() => {
        setVideoState(mediaReadyState)
      }, [mediaReadyState])

      useEffect(() => {
        setSeeking(mediaSeeking)
      }, [mediaSeeking])

      useEffect(() => {
        if (mediaEnded) {
          setResetting(true)
        }
      }, [mediaEnded])

      useEffect(() => {
        setVideoPlaying(mediaPlaying)
      }, [mediaPlaying])

      return null
    }

    useEffect(() => {
      ;(ref as MutableRefObject<HTMLVideoElement>).current.load()
    }, [dream])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [testTimeout, setTestTimeout] = useState<any>(null)

    useEffect(() => {
      if (
        (globalPointer.x <= 0.33 ||
          globalPointer.x >= 1.67 ||
          globalPointer.y <= 0.33 ||
          globalPointer.y >= 1.67) &&
        isMobile
      ) {
        if (!recalibrateMobile) {
          if (!testTimeout) {
            console.log('setting timeout')
            setTestTimeout(setTimeout(() => setRecalibrateMobile(true), 3000))
          }
        }
      } else {
        if (testTimeout) {
          console.log('clearing timeout')
          clearTimeout(testTimeout)
          setTestTimeout(null)
        }

        if (recalibrateMobile) {
          setRecalibrateMobile(false)
        }
      }
    }, [globalPointer])

    return (
      <>
        <div
          className={`fixed z-10 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`}
        >
          <button
            className={`whitespace-nowrap fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-1 rounded-md px-4 py-2 bg-yellow-400 active:bg-black active:text-white flex items-center gap-2 shadow-xl transition-opacity duration-500 ${
              showPlayhead && recalibrateMobile && polaroidVisible > 0.3
                ? ''
                : 'pointer-events-none opacity-0'
            }`}
            onClick={() => setResetInitialRotation(true)}
          >
            <CameraRotate className="inline" />
            <span className="font-serif text-lg">Reorient mobile</span>
          </button>
        </div>
        <div
          className={`fixed z-10 bottom-10 left-1/2 -translate-x-1/2 bg-white border border-yellow-400 rounded-lg xs:rounded-full shadow-xl transition-opacity ${
            showPlayhead && polaroidVisible > 0.3
              ? ''
              : 'pointer-events-none opacity-0'
          }`}
        >
          <Media.Root>
            <Media.Container>
              <Media.Video
                ref={ref}
                muted={
                  location.hostname === 'localhost' ||
                  location.hostname === '127.0.0.1'
                }
                className="hidden"
                preload="auto"
                playsInline
                crossOrigin="anonymous"
              >
                <source
                  src={
                    dream
                      ? `${import.meta.env.VITE_APP_DREAMS}/${dream!.id}/video${
                          isMobile || isTouch ? '-small' : ''
                        }.webm`
                      : `video/title.webm`
                  }
                  type="video/webm"
                  key={dream ? `${dream!.id}-webm` : 'video-webm'}
                />
                <source
                  src={
                    dream
                      ? `${import.meta.env.VITE_APP_DREAMS}/${dream!.id}/video${
                          isMobile || isTouch ? '-small' : ''
                        }.mov`
                      : `video/title.mov`
                  }
                  type="video/mp4"
                  key={dream ? `${dream!.id}-mov` : 'video-mov'}
                />
              </Media.Video>
            </Media.Container>
            <VideoPlayer />
            <Media.Viewport
              className={`flex flex-col xs:flex-row w-[calc(100vw-4rem)] max-w-[400px] left-4 right-4 xs:space-x-3 items-center`}
            >
              <div className="flex self-stretch justify-center border-b xs:border-r xs:border-b-0 border-yellow-500">
                <Footer />
                <div className="group flex relative">
                  <Mute
                    defaultIconSize={24}
                    mutedIcon={<SpeakerSimpleX />}
                    noneIcon={<SpeakerSimpleNone />}
                    lowIcon={<SpeakerSimpleLow />}
                    highIcon={<SpeakerSimpleHigh />}
                    className="transition-colors hover:text-yellow-600 hover:bg-yellow-200 px-3 py-2"
                  />
                  <Tooltip text="Toggle mute" />
                </div>
                <div className="group flex relative">
                  <PlayPause
                    defaultIconSize={24}
                    playIcon={<Play />}
                    pauseIcon={<Pause />}
                    loadingIcon={<Spinner />}
                    className="transition-colors hover:text-yellow-600 hover:bg-yellow-200 px-3 pr-4 py-2"
                  />
                  <Tooltip text={videoPlaying ? 'Pause' : 'Play'} />
                </div>
              </div>
              <div className="flex w-full gap-2 items-center pl-3 xs:pl-0 pr-3 py-2 ">
                <Timestamp type="elapsed" className="font-mono text-xs" />
                <ProgressBarRoot className="grow relative flex items-center select-none touch-none h-4">
                  <Slider.Track className="relative bg-slate-300/40 grow rounded-full h-2">
                    <ProgressBarBufferedRanges className="absolute h-full rounded-full bg-slate-300/60" />
                    <Slider.Range className="absolute h-full rounded-full bg-yellow-400" />
                  </Slider.Track>
                  <StyledProgressBarTooltip />
                  <Slider.Thumb className="block w-4 h-4 rounded-full bg-slate-50 border border-yellow-500 outline-none z-20" />
                </ProgressBarRoot>
              </div>
            </Media.Viewport>
          </Media.Root>
        </div>
      </>
    )
  }
)

Playhead.displayName = 'Playhead'

export default Playhead
