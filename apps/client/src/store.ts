import { create } from 'zustand'
import { Dream } from './utils/types'
import { Vector2 } from 'three'
import {
  ColorScheme,
  ThemePreference,
  readThemePreference,
  resolveColorScheme,
} from './utils/theme'

export type Resume = { dreamId: string; time: number }

/** Swapping to another dream mid-song (see utils/swap-dream.ts): the
 *  polaroid animates `out`, waits off-screen (or face-down) while the next
 *  dream's video loads at the same playback position, then animates `in`. */
export type SwapPhase = 'idle' | 'out' | 'loading' | 'in'
/** 1 = next dream, -1 = previous. */
export type SwapDirection = 1 | -1
export const SWAP_STYLES = ['snap', 'drop', 'slide', 'flip'] as const
export type SwapStyle = (typeof SWAP_STYLES)[number]

function initialSwapStyle(): SwapStyle {
  const param = new URLSearchParams(location.search).get('swap')
  return SWAP_STYLES.find((style) => style === param) ?? 'snap'
}

export interface AppState {
  dream: Dream | null
  resetting: boolean
  seeking: boolean
  collection: Dream[]
  /** Mirrors the native HTMLMediaElement.readyState scale (0=HAVE_NOTHING .. 4=HAVE_ENOUGH_DATA). */
  videoState: number
  videoPlaying: boolean
  isMobile: boolean
  isTouch: boolean
  /** Continuous 0-1 scroll-driven value, written every frame — read via
   *  `getState()` inside a `useFrame`, never through the reactive
   *  `useStore` hook (would re-render on every frame-sized change). */
  polaroidVisible: number
  /** Derived `polaroidVisible > 0.3`, only written when it actually
   *  flips — this is the one safe to subscribe to reactively. */
  polaroidPillVisible: boolean
  ready: boolean
  showPlayhead: boolean
  initialRotation: [number, number, number]
  globalPointer: Vector2
  resetInitialRotation: boolean
  isTooSlow: boolean
  /** What the user picked in the theme toggle — 'system' follows
   *  prefers-color-scheme. */
  themePreference: ThemePreference
  /** The resolved scheme actually showing, after applying `system`. */
  colorScheme: ColorScheme
  /** Playback position to seek to once that dream's video has loaded (set
   *  when restoring from browser history), consumed by Playhead. */
  resume: Resume | null
  swapPhase: SwapPhase
  swapDirection: SwapDirection
  swapStyle: SwapStyle
  /** Debug mode (Shift+D, or ?debug): the diagnostics overlay, and
   *  switches for performance experiments — the full-screen wake pass, and
   *  a cap on the canvas's pixel ratio (null = native, up to 2). */
  debug: boolean
  wakeEnabled: boolean
  dprCap: number | null
  /** The pixel ratio the performance monitor has settled on (see
   *  components/scene.tsx), between 1 and the cap; and whether it's
   *  allowed to (debug mode can turn it off). */
  dprAuto: number
  autoDpr: boolean
  setDream: (dream: Dream | null) => void
  setResetting: (resetting: boolean) => void
  setSeeking: (seeking: boolean) => void
  setCollection: (collection: Dream[]) => void
  setVideoState: (videoState: number) => void
  setVideoPlaying: (videoPlaying: boolean) => void
  setShowPlayhead: (showPlayhead: boolean) => void
  setIsMobile: (isMobile: boolean) => void
  setIsTouch: (isMobile: boolean) => void
  setPolaroidVisible: (polaroidVisible: number) => void
  setPolaroidPillVisible: (polaroidPillVisible: boolean) => void
  setInitialRotation: (initialRotation: [number, number, number]) => void
  setResetInitialRotation: (resetInitialRotation: boolean) => void
  setGlobalPointer: (globalPointer: Vector2) => void
  setReady: (ready: boolean) => void
  setIsTooSlow: (ready: boolean) => void
  setThemePreference: (themePreference: ThemePreference) => void
  setColorScheme: (colorScheme: ColorScheme) => void
  setResume: (resume: Resume | null) => void
  /** Starts a swap, unless one is already running or nothing's playing. */
  requestSwap: (direction: SwapDirection) => void
  setSwapPhase: (swapPhase: SwapPhase) => void
  setSwapStyle: (swapStyle: SwapStyle) => void
  setDebug: (debug: boolean) => void
  setWakeEnabled: (wakeEnabled: boolean) => void
  setDprCap: (dprCap: number | null) => void
  setDprAuto: (dprAuto: number) => void
  setAutoDpr: (autoDpr: boolean) => void
}

export const useStore = create<AppState>()((set) => ({
  dream: null,
  resetting: false,
  seeking: false,
  collection: [],
  videoState: HTMLMediaElement.HAVE_NOTHING,
  videoPlaying: false,
  isMobile: false,
  isTouch: false,
  polaroidVisible: 0,
  polaroidPillVisible: false,
  ready: false,
  showPlayhead: false,
  initialRotation: [0, 0, 0],
  globalPointer: new Vector2(0, 0),
  resetInitialRotation: true,
  isTooSlow: false,
  themePreference: readThemePreference(),
  colorScheme: resolveColorScheme(readThemePreference()),
  resume: null,
  swapPhase: 'idle',
  swapDirection: 1,
  swapStyle: initialSwapStyle(),
  debug: new URLSearchParams(location.search).has('debug'),
  wakeEnabled: true,
  // 1.5 rather than native: at 2x on a big display the canvas is ~12M
  // pixels, rendered twice a frame while the wake runs (debug mode's
  // numbers: ~31ms a frame at 2x, ~22ms at 1.5x, ~17.5ms at 1x).
  dprCap: 1.5,
  dprAuto: 2,
  autoDpr: true,
  setDream: (dream: Dream | null) => set({ dream }),
  setResetting: (resetting: boolean) => {
    set(() => ({ resetting }))
    if (resetting) {
      setTimeout(() => {
        set(() => ({ dream: null }))
        set(() => ({ resetting: false }))
      }, 1000)
    }
  },
  setCollection: (collection: Dream[]) => set({ collection }),
  setVideoState: (videoState) => set(() => ({ videoState })),
  setShowPlayhead: (showPlayhead: boolean) => set(() => ({ showPlayhead })),
  setVideoPlaying: (videoPlaying: boolean) => set(() => ({ videoPlaying })),
  setIsMobile: (isMobile: boolean) => set(() => ({ isMobile })),
  setIsTouch: (isTouch: boolean) => set(() => ({ isTouch })),
  setPolaroidVisible: (polaroidVisible: number) =>
    set(() => ({ polaroidVisible })),
  setPolaroidPillVisible: (polaroidPillVisible: boolean) =>
    set(() => ({ polaroidPillVisible })),
  setInitialRotation: (initialRotation: [number, number, number]) =>
    set(() => ({ initialRotation })),
  setResetInitialRotation: (resetInitialRotation: boolean) =>
    set(() => ({ resetInitialRotation })),
  setGlobalPointer: (globalPointer: Vector2) => set(() => ({ globalPointer })),
  setReady: (ready: boolean) => set(() => ({ ready })),
  setIsTooSlow: (isTooSlow: boolean) => set(() => ({ isTooSlow })),
  setSeeking: (seeking: boolean) => set(() => ({ seeking })),
  setThemePreference: (themePreference: ThemePreference) =>
    set(() => ({ themePreference })),
  setColorScheme: (colorScheme: ColorScheme) => set(() => ({ colorScheme })),
  setResume: (resume: Resume | null) => set(() => ({ resume })),
  requestSwap: (swapDirection: SwapDirection) =>
    set((state) =>
      state.dream && !state.resetting && state.swapPhase === 'idle'
        ? { swapPhase: 'out', swapDirection }
        : {}
    ),
  setSwapPhase: (swapPhase: SwapPhase) => set(() => ({ swapPhase })),
  setSwapStyle: (swapStyle: SwapStyle) => set(() => ({ swapStyle })),
  setDebug: (debug: boolean) => set(() => ({ debug })),
  setWakeEnabled: (wakeEnabled: boolean) => set(() => ({ wakeEnabled })),
  setDprCap: (dprCap: number | null) => set(() => ({ dprCap })),
  setDprAuto: (dprAuto: number) => set(() => ({ dprAuto })),
  setAutoDpr: (autoDpr: boolean) => set(() => ({ autoDpr })),
}))
