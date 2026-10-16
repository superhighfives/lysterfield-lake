import { createContext, useContext } from 'react'

// Where the page's Deforum jobs run: our own GPU (the RTX 4090 PC, over
// Tailscale; plans/in-progress/dreams.md, Our own GPU) or Replicate. The PC
// is free and about twice as fast but does one job at a time; Replicate
// costs money and boots a machine per run, but runs several at once.

export type RunOn = 'pc' | 'replicate'
export type GpuStatus = { configured: boolean; status?: string }

export const RunOnContext = createContext<RunOn>('replicate')
export const useRunOn = () => useContext(RunOnContext)

/** What a job costs where it runs: free on the PC, else Replicate's estimate. */
export const priced = (runOn: RunOn, replicate: string) => (runOn === 'pc' ? 'free on the 4090' : replicate)

const STATUS: Record<string, { label: string; dot: string }> = {
  READY: { label: 'ready', dot: 'bg-emerald-500' },
  BUSY: { label: 'busy', dot: 'bg-amber-500' },
  STARTING: { label: 'starting', dot: 'bg-amber-500' },
  offline: { label: 'offline', dot: 'bg-red-500' },
}

/** The "Run on" switch in the page header. Hidden when no GPU server is set up (DEFORUM_URL in the pipeline's .env). */
export function RunOnSwitch({ value, gpu, onChange }: { value: RunOn; gpu: GpuStatus | null; onChange: (value: RunOn) => void }) {
  if (!gpu?.configured) return null
  const state = STATUS[gpu.status ?? ''] ?? { label: gpu.status ?? 'unknown', dot: 'bg-stone-400' }
  const option = (selected: boolean) =>
    `flex items-center gap-1.5 rounded px-2.5 py-1 text-sm ${selected ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800'}`
  return (
    <div role="radiogroup" aria-label="Run Deforum jobs on" className="flex items-center gap-1 rounded border border-stone-300 p-0.5 dark:border-stone-700">
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
