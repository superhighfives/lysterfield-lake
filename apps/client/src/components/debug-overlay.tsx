import {
  ReactNode,
  useEffect,
  useRef,
  useState,
  version as reactVersion,
} from 'react'
import { REVISION } from 'three'
import { useStore } from '../store'
import { debugStats, HISTORY } from '../utils/debug-stats'
import { trailActive } from '../utils/liquid-trail'

// Debug mode: Shift+D (or ?debug) toggles a diagnostics panel — frame rate
// and a frame-time graph to spot spikes, three.js's renderer stats, the
// app's state, and switches for performance experiments (the full-screen
// wake pass, and a cap on the pixel ratio). The numbers come from
// components/debug-probe.tsx inside the canvas.

// Graph size (CSS px), and the frame times its guide lines mark (60 and
// 30 fps); bars above BAD_MS draw red, above WARN_MS amber.
const GRAPH: [number, number] = [280, 72]
const GRAPH_MAX_MS = 50
const WARN_MS = 17.5
const BAD_MS = 34
// How often (ms) the text refreshes; the graph redraws every frame.
const TEXT_MS = 250

// Caps on the pixel ratio; 1.5x is the default.
const DPR_CAPS: { label: string; value: number | null }[] = [
  { label: '1×', value: 1 },
  { label: '1.5×', value: 1.5 },
  { label: 'native', value: null },
]

type Memory = { usedJSHeapSize: number; jsHeapSizeLimit: number }

function summarise() {
  const frames = Array.from(debugStats.frames).filter((ms) => ms > 0)
  const recent = frames.slice(-60)
  const mean = recent.reduce((sum, ms) => sum + ms, 0) / (recent.length || 1)
  const sorted = [...frames].sort((a, b) => a - b)
  return {
    fps: mean ? 1000 / mean : 0,
    mean,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    spikes: frames.filter((ms) => ms > BAD_MS).length,
  }
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 rounded-full ${
        active ? 'bg-yellow-400 text-stone-900' : 'bg-white/10 hover:bg-white/20'
      }`}
    >
      {children}
    </button>
  )
}

function DebugOverlay() {
  const debug = useStore((state) => state.debug)
  const setDebug = useStore((state) => state.setDebug)
  const wakeEnabled = useStore((state) => state.wakeEnabled)
  const setWakeEnabled = useStore((state) => state.setWakeEnabled)
  const dprCap = useStore((state) => state.dprCap)
  const setDprCap = useStore((state) => state.setDprCap)
  const dprAuto = useStore((state) => state.dprAuto)
  const autoDpr = useStore((state) => state.autoDpr)
  const setAutoDpr = useStore((state) => state.setAutoDpr)
  const dream = useStore((state) => state.dream)
  const swapPhase = useStore((state) => state.swapPhase)
  const carouselStyle = useStore((state) => state.carouselStyle)
  const colorScheme = useStore((state) => state.colorScheme)
  const isMobile = useStore((state) => state.isMobile)
  const isTouch = useStore((state) => state.isTouch)
  const graph = useRef<HTMLCanvasElement>(null)
  const [, setTick] = useState(0)

  // Shift+D, anywhere but a text field.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.key.toLowerCase() !== 'd') return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable]')) return
      setDebug(!useStore.getState().debug)
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [setDebug])

  useEffect(() => {
    if (!debug) return
    const text = window.setInterval(() => setTick((tick) => tick + 1), TEXT_MS)
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const canvas = graph.current
      const context = canvas?.getContext('2d')
      if (!canvas || !context) return
      const dpr = window.devicePixelRatio || 1
      const [width, height] = GRAPH
      if (canvas.width !== width * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      const barWidth = width / HISTORY
      for (let i = 0; i < HISTORY; i++) {
        const ms = debugStats.frames[(debugStats.cursor + i) % HISTORY]
        if (!ms) continue
        const barHeight = Math.min(ms / GRAPH_MAX_MS, 1) * height
        context.fillStyle =
          ms > BAD_MS ? '#f87171' : ms > WARN_MS ? '#facc15' : '#a8a29e'
        context.fillRect(i * barWidth, height - barHeight, Math.max(barWidth, 1), barHeight)
      }

      // 60 and 30 fps.
      context.strokeStyle = 'rgba(255, 255, 255, 0.35)'
      context.setLineDash([3, 3])
      for (const ms of [1000 / 60, 1000 / 30]) {
        const y = height - (ms / GRAPH_MAX_MS) * height
        context.beginPath()
        context.moveTo(0, y)
        context.lineTo(width, y)
        context.stroke()
      }

      context.setLineDash([])
    }

    frame = requestAnimationFrame(draw)
    return () => {
      window.clearInterval(text)
      cancelAnimationFrame(frame)
    }
  }, [debug])

  if (!debug) return null

  const summary = summarise()
  const memory = (performance as Performance & { memory?: Memory }).memory
  const rows: [string, string][] = [
    ['frame', `${summary.mean.toFixed(1)}ms avg · ${summary.p95.toFixed(1)} p95 · ${summary.max.toFixed(1)} max`],
    ['spikes', `${summary.spikes} over ${BAD_MS}ms (last ${HISTORY})`],
    ['draw calls', `${debugStats.calls}`],
    ['triangles', debugStats.triangles.toLocaleString()],
    ['geometries', `${debugStats.geometries}`],
    ['textures', `${debugStats.textures}`],
    ['shaders', `${debugStats.programs}`],
    ['objects', `${debugStats.objects}`],
    ['buffer', `${debugStats.width}×${debugStats.height} @ ${debugStats.dpr}x`],
    ['auto dpr', autoDpr ? `${dprAuto}x (monitor)` : 'off'],
    ['wake pass', !wakeEnabled ? 'off' : trailActive() ? 'running' : 'idle (skipped)'],
    ['gpu', debugStats.gpu || 'unknown'],
    ...(memory
      ? [['js heap', `${(memory.usedJSHeapSize / 1048576).toFixed(0)} / ${(memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB`] as [string, string]]
      : []),
    ['versions', `react ${reactVersion} · three r${REVISION}`],
    ['dream', dream ? dream.id : '—'],
    ['swap', swapPhase],
    ['carousel', carouselStyle],
    ['device', `${colorScheme}${isMobile ? ' · tilt' : ''}${isTouch ? ' · touch' : ''}`],
  ]

  return (
    <div className="fixed z-50 bottom-2 left-2 w-[304px] rounded-xl bg-stone-950/85 text-stone-100 backdrop-blur-sm shadow-2xl p-3 font-mono text-[11px] leading-snug">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-2xl font-semibold tabular-nums">
          {summary.fps.toFixed(0)}
          <span className="text-xs text-stone-400 ml-1">fps</span>
        </span>
        <span className="text-stone-500">shift+d to close</span>
      </div>
      <canvas
        ref={graph}
        className="block mb-2 rounded bg-white/5"
        style={{ width: GRAPH[0], height: GRAPH[1] }}
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-stone-400">{label}</dt>
            <dd className="truncate tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-stone-400 w-16">wake</span>
          <Toggle active={wakeEnabled} onClick={() => setWakeEnabled(true)}>on</Toggle>
          <Toggle active={!wakeEnabled} onClick={() => setWakeEnabled(false)}>off</Toggle>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-stone-400 w-16">auto</span>
          <Toggle active={autoDpr} onClick={() => setAutoDpr(true)}>on</Toggle>
          <Toggle active={!autoDpr} onClick={() => setAutoDpr(false)}>off</Toggle>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-stone-400 w-16">pixels</span>
          {DPR_CAPS.map(({ label, value }) => (
            <Toggle key={label} active={dprCap === value} onClick={() => setDprCap(value)}>
              {label}
            </Toggle>
          ))}
        </div>
      </div>
    </div>
  )
}

export default DebugOverlay
