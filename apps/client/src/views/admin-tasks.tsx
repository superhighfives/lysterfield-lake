import { useEffect, useState } from 'react'
import { active, api, reason, type Task } from './admin-api.ts'

// What the page has running, waiting and recently finished (admin-queue.ts):
// checks, samples, clips, full songs and repairs, several at once.

const LABELS: Record<string, string> = {
  directions: 'Brainstorm directions',
  samples: 'Samples',
  clip: '15-second clip',
  full: 'Full song',
  check: 'People check',
  rerender: 'Re-render frames',
  hold: 'Hold frames',
  restore: 'Put originals back',
  'polaroid-panels': 'Portrait, matte, depth and outline',
  'polaroid-background': 'Background',
  'polaroid-atlas': 'Polaroid',
}
const TONES: Record<Task['status'], string> = {
  queued: 'bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-300',
  running: 'bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200',
  succeeded: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200',
  failed: 'bg-red-50 dark:bg-red-950/50 text-red-800 dark:text-red-200',
  cancelled: 'bg-stone-200 dark:bg-stone-700 text-stone-600 dark:text-stone-400',
}
const STATUS: Record<Task['status'], string> = { queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed', cancelled: 'Stopped' }

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function Tasks({ job, tasks, titles, onChanged }: {
  job: string
  tasks: Task[]
  /** Display names for dreams that have one, by id. */
  titles: Record<string, string>
  onChanged: () => void
}) {
  const [, tick] = useState(0)
  const going = tasks.filter(active)
  useEffect(() => {
    if (going.length === 0) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [going.length])
  if (tasks.length === 0) return null

  const finished = tasks.filter((t) => !active(t))
  const post = (url: string) => api(url, {}).then(onChanged, onChanged)
  const plain = 'rounded border border-stone-300 dark:border-stone-700 px-2 py-0.5 text-xs hover:bg-stone-100 dark:hover:bg-stone-800'

  return (
    <section className="mb-10">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className="font-serif text-2xl">Tasks</h2>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          {going.length === 0 ? 'Nothing running.' : `${going.filter((t) => t.status === 'running').length} running, ${going.filter((t) => t.status === 'queued').length} waiting.`} Up to three Replicate runs, one job on the 4090 and one check at a time, and
          one task per dream.
        </p>
        {finished.length > 0 && (
          <button type="button" onClick={() => post(`/__admin/api/jobs/${job}/tasks/clear`)} className={`ml-auto ${plain}`}>
            Clear finished
          </button>
        )}
      </div>
      <ul className="max-h-[200px] overflow-y-auto rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 text-sm">
        {[...going, ...finished.reverse()].map((task) => {
          // A repair runs several Deforum runs side by side, each logging its own frame count, so once a stretch is done its count wins.
          const progress =
            task.log.match(/(Re-rendered )(\d+) of (\d+)(?![\s\S]*Re-rendered \d)/) ??
            task.log.match(/(Dream frames: |Scored |Re-rendered )(\d+) of (\d+)(?![\s\S]*(?:Dream frames: |Scored |Re-rendered )\d)/)
          return (
            <li key={task.id} className="border-t border-stone-200 dark:border-stone-800 py-2 first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{LABELS[task.action] ?? task.action}</span>
                <span className="text-stone-600 dark:text-stone-400">
                  {titles[task.take] ?? task.take}
                  {task.clip ? ', clip' : ''}
                  {task.lane === 'pc' ? ', on the 4090' : task.lane === 'replicate' ? ', on Replicate' : ''}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[task.status]}`}>{STATUS[task.status]}</span>
                <span className="text-xs tabular-nums text-stone-500 dark:text-stone-400">
                  {task.status === 'queued' && `waiting ${duration(Date.now() - task.created)}`}
                  {task.status === 'running' && `${duration(Date.now() - (task.started ?? task.created))}${progress ? `, ${progress[2]} of ${progress[3]} ${progress[1] === 'Re-rendered ' ? 'stretches' : 'frames'}` : ''}`}
                  {!active(task) && task.started && task.ended && `took ${duration(task.ended - task.started)}`}
                </span>
                {(task.status === 'failed' || task.status === 'cancelled') && !task.retriedBy && (
                  <button type="button" onClick={() => post(`/__admin/api/tasks/${task.id}/retry`)} className={`ml-auto ${plain}`} title="Runs it again. Finished work is kept, so only what didn't finish is redone.">
                    Retry
                  </button>
                )}
                {active(task) && (
                  <button type="button" onClick={() => post(`/__admin/api/tasks/${task.id}/cancel`)} className={`ml-auto ${plain}`} title={task.status === 'running' ? 'Stops it here. A Replicate run already started carries on there; starting the task again picks that run back up.' : undefined}>
                    {task.status === 'queued' ? 'Remove' : 'Stop'}
                  </button>
                )}
              </div>
              {task.status === 'failed' && <p className="mt-1 break-words text-xs text-red-800 dark:text-red-200">{reason(task.log)}</p>}
              {task.log && task.status !== 'queued' && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-stone-500 dark:text-stone-400">Log</summary>
                  <pre className="mt-1 whitespace-pre-wrap text-xs">{task.log}</pre>
                </details>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
