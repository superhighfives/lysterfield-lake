import { useCallback, useEffect, useState } from 'react'
import { api, jobFile, pad, reason, runAction } from './admin-api.ts'

// The person check and its repairs (plans/in-progress/dreams.md). Panel 7
// must never show a person, and Deforum draws one into a few percent of
// frames. The pipeline's dream-check finds those frames; this is where they
// are looked at and replaced, instead of going through every frame by hand.

export type CheckSummary = { frames: number; flagged: number; stretches: number }
type Stretch = { start: number; end: number; frames: number; peak: number }
type Detail = {
  /** Dream frames, by the job frame each first appears at. */
  frames: number[]
  check: { threshold: number; stretches: Stretch[]; scores: Record<string, number> } | null
  keep: number[]
  replaced: number[]
}

/** Rough Replicate cost of re-rendering one dream frame (A100, ~21s), before rerolls: a frame still scored as a person is re-rendered up to twice more. */
const COST_PER_FRAME = 0.03
const dollars = (frames: number) => `about $${Math.max(0.05, frames * COST_PER_FRAME).toFixed(2)} before retries`
const plain = 'rounded border border-stone-300 dark:border-stone-700 px-2.5 py-1 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40'
const primary = 'rounded bg-stone-900 dark:bg-stone-100 px-2.5 py-1 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-40'

export function checkLabel(check: CheckSummary | null): { label: string; tone: string } {
  if (!check) return { label: 'Not checked for people', tone: 'bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-300' }
  if (check.flagged === 0) return { label: `No person found in ${check.frames} frames`, tone: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200' }
  return { label: `${check.flagged} of ${check.frames} frames flagged, in ${check.stretches} ${check.stretches === 1 ? 'stretch' : 'stretches'}`, tone: 'bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200' }
}

/** A button that asks once more before spending money. */
function Paid({ label, cost, disabled, onConfirm }: { label: string; cost: string; disabled?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button type="button" disabled={disabled} onClick={() => setAsking(true)} className={primary}>
        {label} ({cost})
      </button>
    )
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setAsking(false)
          onConfirm()
        }}
        className="rounded bg-amber-700 px-2.5 py-1 text-sm font-medium text-white disabled:opacity-40"
      >
        Spend {cost}
      </button>
      <button type="button" onClick={() => setAsking(false)} className={plain}>
        Cancel
      </button>
    </span>
  )
}

export function PersonCheck({ job, take, title, clip = false, summary, busy, onChanged }: {
  job: string
  take: string
  title: string
  /** Check the take's 15-second clip rather than its full song. */
  clip?: boolean
  summary: CheckSummary | null
  /** Something paid is already running for this footage. */
  busy: boolean
  onChanged: () => void
}) {
  // `/admin#check-<take>` opens that take's review straight away.
  const [open, setOpen] = useState(() => location.hash === `#check-${take}${clip ? '-clip' : ''}`)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  /** Bumped after every change, so replaced frames aren't shown from the browser's cache. */
  const [version, setVersion] = useState(0)
  const [cursor, setCursor] = useState(0)

  const dir = `7-dreams/${take}/${clip ? 'preview/dream/' : ''}`
  const frameUrl = (frame: number) => `${jobFile(job, `${dir}frames/${pad(frame)}.jpg`)}?v=${version}`
  const sourceUrl = (frame: number) => jobFile(job, `0-source/frames/${pad(frame)}.jpg`)
  const checkUrl = `/__admin/api/jobs/${job}/checks/${take}`

  const load = useCallback(async () => setDetail(await api<Detail>(`${checkUrl}${clip ? '?clip=true' : ''}`)), [checkUrl, clip])
  useEffect(() => {
    if (open) load().catch((e) => setError((e as Error).message))
  }, [open, load])

  const act = async (label: string, body: Record<string, unknown>) => {
    setError('')
    setWorking(label)
    try {
      const run = await runAction(job, { ...body, take, clip })
      if (run.status === 'failed') setError(reason(run.log))
      setVersion((v) => v + 1)
      if (open) await load()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking('')
    }
  }

  const range = (s: { start: number; end: number }) => (s.start === s.end ? String(s.start) : `${s.start}-${s.end}`)
  const repair = (action: 'rerender' | 'hold', stretches: { start: number; end: number }[]) =>
    act(action === 'rerender' ? 'Re-rendering on Replicate…' : 'Holding the frame before…', { action, frames: stretches.map(range).join(',') })
  const setKeep = async (keep: number[]) => {
    setError('')
    try {
      await api(checkUrl, { keep, clip })
      await load()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const status = checkLabel(summary)
  const stretches = detail?.check?.stretches.filter((s) => !detail.keep.includes(s.start)) ?? []
  const kept = detail?.check?.stretches.filter((s) => detail.keep.includes(s.start)) ?? []
  const flaggedFrames = stretches.reduce((sum, s) => sum + s.frames, 0)
  const score = (frame: number) => detail?.check?.scores[pad(frame)]
  const current = detail?.frames[Math.min(cursor, (detail?.frames.length ?? 1) - 1)]

  return (
    <div className="border-t border-stone-200 dark:border-stone-800 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{title}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
        {working && <span className="text-xs text-stone-500 dark:text-stone-400">{working}</span>}
        <span className="ml-auto flex gap-2">
          <button type="button" disabled={working !== ''} onClick={() => act('Checking every frame (about 6 minutes for a full song)…', { action: 'check' })} className={plain}>
            {summary ? 'Check again' : 'Check for people (free)'}
          </button>
          <button type="button" onClick={() => setOpen(!open)} className={plain}>
            {open ? 'Close' : 'Review'}
          </button>
        </span>
      </div>
      {error && <p className="mt-2 rounded bg-red-50 dark:bg-red-950/50 p-2 text-sm text-red-800 dark:text-red-200">{error}</p>}

      {open && detail && (
        <div className="mt-3">
          {!detail.check && <p className="text-sm text-stone-600 dark:text-stone-400">Not checked yet. You can still go through the frames below and replace any by hand.</p>}
          {detail.check && stretches.length === 0 && <p className="text-sm text-stone-600 dark:text-stone-400">Nothing flagged. {detail.replaced.length > 0 ? `${detail.replaced.length} frames have been replaced; the originals are in the take's replaced folder.` : ''}</p>}

          {stretches.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Paid label={`Re-render all ${flaggedFrames} flagged frames`} cost={dollars(flaggedFrames)} disabled={busy || working !== ''} onConfirm={() => repair('rerender', stretches)} />
              <span className="text-stone-500 dark:text-stone-400">Each stretch is a separate run, one after another.</span>
            </div>
          )}

          {stretches.map((s) => {
            const from = detail.frames.indexOf(s.start)
            const to = detail.frames.indexOf(s.end)
            const inside = detail.frames.slice(from, to + 1)
            const shown = inside.slice(0, 6)
            const before = detail.frames[from - 1]
            const after = detail.frames[to + 1]
            return (
              <div key={s.start} className="mb-3 rounded border border-stone-200 dark:border-stone-800 p-2">
                <div className="flex gap-1 overflow-x-auto">
                  {before !== undefined && <img src={frameUrl(before)} alt="" title={`Frame ${before}, before`} className="h-28 w-28 shrink-0 rounded object-cover opacity-60" />}
                  {shown.map((frame) => (
                    <div key={frame} className="relative shrink-0">
                      <img src={frameUrl(frame)} alt="" className="h-28 w-28 rounded object-cover ring-2 ring-amber-500" />
                      <img src={sourceUrl(frame)} alt="" title="The footage at this moment" className="absolute bottom-1 right-1 w-9 rounded border border-white" />
                      <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                        {frame} · {(score(frame) ?? 0).toFixed(2)}
                      </span>
                    </div>
                  ))}
                  {inside.length > shown.length && <div className="flex h-28 w-20 shrink-0 items-center justify-center text-xs text-stone-500 dark:text-stone-400">+{inside.length - shown.length} more</div>}
                  {after !== undefined && <img src={frameUrl(after)} alt="" title={`Frame ${after}, after`} className="h-28 w-28 shrink-0 rounded object-cover opacity-60" />}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Paid label={s.frames === 1 ? 'Re-render' : `Re-render ${s.frames} frames`} cost={dollars(s.frames)} disabled={busy || working !== '' || from === 0} onConfirm={() => repair('rerender', [s])} />
                  {s.frames <= 2 && (
                    <button type="button" disabled={working !== '' || from === 0} onClick={() => repair('hold', [s])} className={plain} title="Free: the frame before is held a little longer">
                      Hold the frame before (free)
                    </button>
                  )}
                  <button type="button" onClick={() => setKeep([...detail.keep, s.start])} className={plain}>
                    Keep, it&apos;s fine
                  </button>
                </div>
              </div>
            )
          })}

          {kept.length > 0 && (
            <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">
              {kept.length} flagged {kept.length === 1 ? 'stretch' : 'stretches'} kept as fine.{' '}
              <button type="button" onClick={() => setKeep([])} className="underline">
                Show them again
              </button>
            </p>
          )}

          {current !== undefined && (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-stone-600 dark:text-stone-400">Go through every frame</summary>
              <div className="mt-2 flex flex-wrap items-start gap-3">
                <img src={frameUrl(current)} alt="" className="h-64 w-64 rounded object-cover" />
                <img src={sourceUrl(current)} alt="" title="The footage at this moment" className="h-64 w-64 rounded object-cover" />
                <div className="flex min-w-60 flex-1 flex-col gap-2 text-sm">
                  <input type="range" min={0} max={detail.frames.length - 1} value={cursor} onChange={(e) => setCursor(Number(e.target.value))} aria-label="Dream frame" />
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setCursor(Math.max(0, cursor - 1))} className={plain}>
                      Back
                    </button>
                    <button type="button" onClick={() => setCursor(Math.min(detail.frames.length - 1, cursor + 1))} className={plain}>
                      Next
                    </button>
                    <span className="text-stone-600 dark:text-stone-400">
                      Frame {current}
                      {score(current) !== undefined ? `, person score ${score(current)!.toFixed(2)}` : ''}
                      {detail.replaced.includes(current) ? ', replaced' : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Paid label="Re-render this frame" cost={dollars(1)} disabled={busy || working !== '' || cursor === 0} onConfirm={() => repair('rerender', [{ start: current, end: current }])} />
                    <button type="button" disabled={working !== '' || cursor === 0} onClick={() => repair('hold', [{ start: current, end: current }])} className={plain}>
                      Hold the frame before (free)
                    </button>
                  </div>
                </div>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
