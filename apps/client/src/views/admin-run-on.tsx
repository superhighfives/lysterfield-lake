import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './admin-api.ts'

// Where the page's GPU jobs run: our own GPU (the RTX 4090 PC, over
// Tailscale; plans/in-progress/dreams.md, Our own GPU) or Replicate. The PC
// is free and about twice as fast but does one job at a time; Replicate
// costs money and boots a machine per run, but runs several at once. Dreams
// use the PC's Deforum server, polaroids its polaroid model server.

export type RunOn = 'pc' | 'replicate'
export type GpuStatus = { configured: boolean; status?: string }

export const RunOnContext = createContext<RunOn>('replicate')
export const useRunOn = () => useContext(RunOnContext)

/**
 * The page's choice of where to run, remembered on this machine under `key`, and the status of the server it
 * would use (`/__admin/api/gpu`, `?for=polaroid` for the polaroid model). The PC when it's set up, unless
 * chosen otherwise; without it set up, everything runs on Replicate whatever was chosen.
 */
export function useRunOnChoice(key: string, server?: 'polaroid') {
  const [gpu, setGpu] = useState<GpuStatus | null>(null)
  const [runOn, setRunOn] = useState<RunOn>(() => {
    try {
      return localStorage.getItem(key) === 'replicate' ? 'replicate' : 'pc'
    } catch {
      return 'pc'
    }
  })
  const choose = (value: RunOn) => {
    setRunOn(value)
    try {
      localStorage.setItem(key, value)
    } catch {
      // Storage blocked: the choice still holds for this visit.
    }
  }

  useEffect(() => {
    const load = () => api<GpuStatus>(`/__admin/api/gpu${server ? `?for=${server}` : ''}`).then(setGpu, () => setGpu(null))
    load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [server])
  return { gpu, runOn: (gpu?.configured ? runOn : 'replicate') as RunOn, choose }
}

/** What a job costs where it runs: free on the PC, else Replicate's estimate. */
export const priced = (runOn: RunOn, replicate: string) => (runOn === 'pc' ? 'free on the 4090' : replicate)

const STATUS: Record<string, { label: string; dot: string }> = {
  READY: { label: 'ready', dot: 'bg-emerald-500' },
  BUSY: { label: 'busy', dot: 'bg-amber-500' },
  STARTING: { label: 'starting', dot: 'bg-amber-500' },
  offline: { label: 'offline', dot: 'bg-red-500' },
}

/** The "Run on" switch in the page header. Hidden when its GPU server isn't set up (DEFORUM_URL or POLAROID_URL in the pipeline's .env). */
export function RunOnSwitch({ value, gpu, onChange, label = 'Run Deforum jobs on' }: { value: RunOn; gpu: GpuStatus | null; onChange: (value: RunOn) => void; label?: string }) {
  if (!gpu?.configured) return null
  const state = STATUS[gpu.status ?? ''] ?? { label: gpu.status ?? 'unknown', dot: 'bg-stone-400' }
  const option = (selected: boolean) =>
    `flex items-center gap-1.5 rounded px-2.5 py-1 text-sm ${selected ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800'}`
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-1 rounded border border-stone-300 p-0.5 dark:border-stone-700">
      <button type="button" role="radio" aria-checked={value === 'pc'} onClick={() => onChange('pc')} className={option(value === 'pc')} title={`Free, one job at a time. The PC is ${state.label}.`}>
        <span className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
        4090 PC
      </button>
      <button type="button" role="radio" aria-checked={value === 'replicate'} onClick={() => onChange('replicate')} className={option(value === 'replicate')} title="Paid, several jobs at once">
        Replicate
      </button>
    </div>
  )
}
