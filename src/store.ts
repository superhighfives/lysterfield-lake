import { create } from 'zustand'
import { MediaReadyState } from '@react-av/core'
import { Dream } from './utils/types'
import { Vector2 } from 'three'

export interface AppState {
  dream: Dream | null
  resetting: boolean
  collection: Dream[]
  videoState: MediaReadyState
  videoPlaying: boolean
  isMobile: boolean
  isTouch: boolean
  polaroidVisible: number
  ready: boolean
  showPlayhead: boolean
  initialRotation: [number, number, number]
  globalPointer: Vector2
  resetInitialRotation: boolean
  setDream: (dream: Dream | null) => void
  setResetting: (resetting: boolean) => void
  setCollection: (collection: Dream[]) => void
  setVideoState: (videoState: MediaReadyState) => void
  setVideoPlaying: (videoPlaying: boolean) => void
  setShowPlayhead: (showPlayhead: boolean) => void
  setIsMobile: (isMobile: boolean) => void
  setIsTouch: (isMobile: boolean) => void
  setPolaroidVisible: (polaroidVisible: number) => void
  setInitialRotation: (initialRotation: [number, number, number]) => void
  setResetInitialRotation: (resetInitialRotation: boolean) => void
  setGlobalPointer: (globalPointer: Vector2) => void
  setReady: (ready: boolean) => void
}

export const useStore = create<AppState>()((set) => ({
  dream: null,
  resetting: false,
  collection: [],
  videoState: MediaReadyState.HAVE_NOTHING,
  videoPlaying: false,
  isMobile: false,
  isTouch: false,
  polaroidVisible: 0,
  ready: false,
  showPlayhead: false,
  initialRotation: [0, 0, 0],
  globalPointer: new Vector2(0, 0),
  resetInitialRotation: true,
  setDream: (dream: Dream | null) => set({ dream }),
  setResetting: (resetting: boolean) => {
    set(() => ({ resetting: resetting }))
    if (resetting) {
      setTimeout(() => {
        set(() => ({ dream: null }))
        set(() => ({ resetting: false }))
      }, 1000)
    }
  },
  setCollection: (collection: Dream[]) => set({ collection }),
  setVideoState: (videoState) => set(() => ({ videoState: videoState })),
  setShowPlayhead: (showPlayhead: boolean) =>
    set(() => ({ showPlayhead: showPlayhead })),
  setVideoPlaying: (videoPlaying: boolean) =>
    set(() => ({ videoPlaying: videoPlaying })),
  setIsMobile: (isMobile: boolean) => set(() => ({ isMobile: isMobile })),
  setIsTouch: (isTouch: boolean) => set(() => ({ isTouch: isTouch })),
  setPolaroidVisible: (polaroidVisible: number) =>
    set(() => ({ polaroidVisible: polaroidVisible })),
  setInitialRotation: (initialRotation: [number, number, number]) =>
    set(() => ({ initialRotation: initialRotation })),
  setResetInitialRotation: (resetInitialRotation: boolean) =>
    set(() => ({ resetInitialRotation: resetInitialRotation })),
  setGlobalPointer: (globalPointer: Vector2) =>
    set(() => ({ globalPointer: globalPointer })),
  setReady: (ready: boolean) => set(() => ({ ready: ready })),
}))
