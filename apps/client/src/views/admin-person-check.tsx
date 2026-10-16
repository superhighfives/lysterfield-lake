import { useCallback, useEffect, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { active, api, jobFile, pad, reason, type Task } from './admin-api.ts'
import { useRunOn } from './admin-run-on.tsx'

// The person check and its repairs (plans/in-progress/dreams.md). Panel 7
// must never show a person, and Deforum draws one into a few percent of
// frames. The pipeline's dream-check finds those frames; this is where they
// are looked at and replaced, instead of going through every frame by hand.

/** `flagged`/`stretches` count people only; `morphs` is the published dreams' 2023 RIFE morphs still to replace. `checked` false: morphs are known but the person check hasn't run. */
export type CheckSummary = { frames: number; flagged: number; stretches: number; morphs?: number; checked?: boolean }
type Stretch = { start: number; end: number; frames: number; peak: number }
type Detail = {
  /** Dream frames, by the job frame each first appears at. */
  frames: number[]
  check: { threshold: number; stretches: Stretch[]; scores: Record<string, number> } | null
  keep: number[]
  /** 2023 RIFE morphs still to replace (published dreams only): interpolated in 2023, so they lose the stop-motion look. */
  morphs: number[]
  /** Frames a hold replaced; their originals can be put back. */
  replaced: number[]
  /** Frames a re-render made. A re-render is final, so these have no original to go back to. */
  rerendered: number[]
}

/** Rough Replicate cost of re-rendering one dream frame (A100 with xformers, ~10s), before rerolls: a frame still scored as a person is re-rendered up to twice more. */
const COST_PER_FRAME = 0.015
/** What a check or repair task is doing, for the row's status line. */
const WORKING: Record<string, string> = { check: 'Checking every frame (about 6 minutes for a full song)…', rerender: 'Re-rendering on Replicate…', hold: 'Holding the frame before…', restore: 'Putting the originals back…' }
/** A re-render runs up to this many rounds (each with the model's own two retries) while a frame still shows a person: dream-repair.ts's MAX_REPAIR_ROUNDS. */
const MAX_ROUNDS = 10
const dollars = (frames: number) => `about $${Math.max(0.05, frames * COST_PER_FRAME).toFixed(2)}, up to $${(frames * COST_PER_FRAME * 3 * MAX_ROUNDS).toFixed(2)}`
const plain = 'rounded border border-stone-300 dark:border-stone-700 px-2.5 py-1 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40'
const primary = 'rounded bg-stone-900 dark:bg-stone-100 px-2.5 py-1 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-40'

export function checkLabel(check: CheckSummary | null): { label: string; tone: string } {
  if (!check || check.checked === false) return { label: 'Not checked for people', tone: 'bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-300' }
  if (check.flagged === 0) return { label: `No person found in ${check.frames} frames`, tone: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200' }
  return { label: `${check.flagged} ${check.flagged === 1 ? 'frame shows' : 'frames show'} a person, in ${check.stretches} ${check.stretches === 1 ? 'stretch' : 'stretches'}`, tone: 'bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200' }
}

/** Groups frames into runs of neighbouring dream frames, as repair stretches. */
function groupStretches(frames: number[], dreamFrames: number[]): { start: number; end: number; frames: number }[] {
  const index = new Map(dreamFrames.map((f, i) => [f, i]))
  const sorted = frames.filter((f) => index.has(f)).sort((a, b) => a - b)
  const out: { start: number; end: number; frames: number }[] = []
  for (const f of sorted) {
    const last = out.at(-1)
    if (last && index.get(f) === index.get(last.end)! + 1) {
      last.end = f
      last.frames++
    } else out.push({ start: f, end: f, frames: 1 })
  }

  return out
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
        {cost.startsWith('free') ? 'Start' : `Spend ${cost}`}
      </button>
      <button type="button" onClick={() => setAsking(false)} className={plain}>
        Cancel
      </button>
    </span>
  )
}

export function PersonCheck({ job, take, title, clip = false, summary, tasks, onChanged }: {
  job: string
  take: string
  title: string
  /** Check the take's 15-second clip rather than its full song. */
  clip?: boolean
  summary: CheckSummary | null
  /** This footage's queued, running and recent tasks. */
  tasks: Task[]
  onChanged: () => void
}) {
  const runOn = useRunOn()
  /** A re-render's cost where it runs: free on the 4090 PC. */
  const cost = (frames: number) => (runOn === 'pc' ? 'free on the 4090' : dollars(frames))
  // `/admin#check-<take>` opens that take's review straight away.
  const [open, setOpen] = useState(() => location.hash === `#check-${take}${clip ? '-clip' : ''}`)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  /** Bumped after every change, so replaced frames aren't shown from the browser's cache. */
  const [version, setVersion] = useState(0)
  const [cursor, setCursor] = useState(0)
  /** "Check again" asks once before starting: a full song's check ties up this machine's GPU for 6 minutes or more. */
  const [confirmingCheck, setConfirmingCheck] = useState(false)

  const dir = `7-dreams/${take}/${clip ? 'preview/dream/' : ''}`
  const frameUrl = (frame: number) => `${jobFile(job, `${dir}frames/${pad(frame)}.jpg`)}?v=${version}`
  const sourceUrl = (frame: number) => jobFile(job, `0-source/frames/${pad(frame)}.jpg`)
  const checkUrl = `/__admin/api/jobs/${job}/checks/${take}`

  const load = useCallback(async () => setDetail(await api<Detail>(`${checkUrl}${clip ? '?clip=true' : ''}`)), [checkUrl, clip])
  useEffect(() => {
    if (open) load().catch((e) => setError((e as Error).message))
  }, [open, load])

  // This take's check and repair tasks, from the queue. What is shown as going on comes from there
  // rather than from this component, so it survives a page reload and shows work queued elsewhere.
  const mine = tasks.filter((t) => t.take === take && t.clip === clip && t.action in WORKING)
  const going = mine.find(active)
  const working = going ? (going.status === 'queued' ? 'Queued' : WORKING[going.action]) : ''
  /**
   * Frames already queued or running for a repair of this dream. More repairs can be queued behind them
   * (the queue runs one task per dream at a time, in order); only these frames can't be asked for twice.
   */
  const pendingRanges = tasks
    .filter((t) => t.take === take && t.clip === clip && active(t) && (t.action === 'rerender' || t.action === 'hold' || t.action === 'restore'))
    .flatMap((t) => (t.args[t.args.indexOf('--frames') + 1] ?? '').split(',').filter(Boolean).map((part) => part.split('-').map(Number)))
    .map(([start, end = start]) => ({ start, end }))
  const pending = (stretches: { start: number; end: number }[]) => stretches.some((a) => pendingRanges.some((b) => a.start <= b.end && b.start <= a.end))
  /** A check reads every frame, so it waits until nothing is queued for this dream. */
  const busy = tasks.some((t) => t.take === take && active(t))
  const lastEnded = mine.filter((t) => !active(t)).at(-1)
  // When one of them ends: show the new frames and counts, or why it failed.
  useEffect(() => {
    if (!lastEnded) return
    setError(lastEnded.status === 'failed' ? reason(lastEnded.log) : '')
    setVersion((v) => v + 1)
    if (open) load().catch((e) => setError((e as Error).message))
    // Only when a different task becomes the last one ended, so the task's other fields are left out.
  }, [lastEnded?.id])

  const act = async (body: Record<string, unknown>) => {
    setError('')
    try {
      await api(`/__admin/api/jobs/${job}/actions`, { ...body, take, clip, on: runOn })
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const retry = async (id: string) => {
    setError('')
    try {
      await api(`/__admin/api/tasks/${id}/retry`, {})
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const range = (s: { start: number; end: number }) => (s.start === s.end ? String(s.start) : `${s.start}-${s.end}`)
  const repair = (action: 'rerender' | 'hold' | 'restore', stretches: { start: number; end: number }[]) =>
    // A stretch re-rendered before is only re-rendered again when asked for explicitly, which these buttons are.
    act({ action, frames: stretches.map(range).join(','), again: action === 'rerender' })
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
  // A flagged stretch that is all 2023 morph gets replaced with the morphs, so it's listed there, not as a person.
  const isMorph = (frame: number) => detail?.morphs.includes(frame) ?? false
  const inStretch = (st: { start: number; end: number }) => detail?.frames.filter((f) => f >= st.start && f <= st.end) ?? []
  const isAllMorph = (st: { start: number; end: number }) => {
    const frames = inStretch(st)
    return frames.length > 0 && frames.every(isMorph)
  }

  const stretches = detail?.check?.stretches.filter((st) => !detail.keep.includes(st.start) && !isAllMorph(st)) ?? []
  const kept = detail?.check?.stretches.filter((st) => detail.keep.includes(st.start)) ?? []
  const flaggedFrames = stretches.reduce((sum, st) => sum + st.frames, 0)
  const morphStretches = detail ? groupStretches(detail.morphs, detail.frames) : []
  const [showMorphs, setShowMorphs] = useState(false)
  const score = (frame: number) => detail?.check?.scores[pad(frame)]
  const current = detail?.frames[Math.min(cursor, (detail?.frames.length ?? 1) - 1)]

  const renderStretch = (s: { start: number; end: number; frames: number }, kind: 'person' | 'morph') => {
    if (!detail) return null
          const from = detail.frames.indexOf(s.start)
          const to = detail.frames.indexOf(s.end)
          const inside = detail.frames.slice(from, to + 1)
          const shown = inside.slice(0, 6)
          const before = detail.frames[from - 1]
          const after = detail.frames[to + 1]
          return (
            <div key={s.start} className="mb-3 rounded border border-stone-200 dark:border-stone-800 p-2">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">{kind === 'morph' ? '2023 morph' : inside.some(isMorph) ? 'Person, with 2023 morphs (blue)' : 'Person'}</p>
              <div className="flex gap-1 overflow-x-auto">
                {before !== undefined && <img src={frameUrl(before)} alt="" title={`Frame ${before}, before`} className="h-28 w-28 shrink-0 rounded object-cover opacity-60" />}
                {shown.map((frame) => (
                  <div key={frame} className="relative shrink-0">
                    <img src={frameUrl(frame)} alt="" className={`h-28 w-28 rounded object-cover ring-2 ${isMorph(frame) ? 'ring-sky-500' : 'ring-amber-500'}`} title={isMorph(frame) ? '2023 morph' : 'Flagged as a person'} />
                    <img src={sourceUrl(frame)} alt="" title="The footage at this moment" className="absolute bottom-1 right-1 w-9 rounded border border-white" />
                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                      {frame}{score(frame) !== undefined ? ` · ${score(frame)!.toFixed(2)}` : ''}{isMorph(frame) ? ' · morph' : ''}
                    </span>
                  </div>
                ))}
                {inside.length > shown.length && <div className="flex h-28 w-20 shrink-0 items-center justify-center text-xs text-stone-500 dark:text-stone-400">+{inside.length - shown.length} more</div>}
                {after !== undefined && <img src={frameUrl(after)} alt="" title={`Frame ${after}, after`} className="h-28 w-28 shrink-0 rounded object-cover opacity-60" />}
              </div>
              {inside.every((frame) => detail.rerendered.includes(frame)) && (
                <p className="mt-2 text-sm text-amber-900 dark:text-amber-200">Re-rendered, with up to ten rounds of new seeds, and it still shows a person. Hold the frame before, or try ten more rounds.</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Paid label={(inside.every((frame) => detail.rerendered.includes(frame)) ? 'Ten more rounds' : 'Re-render') + (s.frames === 1 ? '' : ` ${s.frames} frames`)} cost={cost(s.frames)} disabled={pending([s]) || from === 0} onConfirm={() => repair('rerender', [s])} />
                {kind === 'person' && s.frames <= 2 && (
                  <button type="button" disabled={pending([s]) || from === 0} onClick={() => repair('hold', [s])} className={plain} title="Free: the frame before is held a little longer">
                    Hold the frame before (free)
                  </button>
                )}
                {kind === 'person' && inside.some((frame) => detail.replaced.includes(frame)) && (
                  <button type="button" disabled={pending([s])} onClick={() => repair('restore', [s])} className={plain} title="Free: undoes the hold, putting the frames that were here before back">
                    Put the original back
                  </button>
                )}
                {kind === 'person' && (
                  <button type="button" onClick={() => setKeep([...detail.keep, s.start])} className={plain}>
                    Keep, it&apos;s fine
                  </button>
                )}
              </div>
            </div>
          )

  }

  return (
    <div className="border-t border-stone-200 dark:border-stone-800 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{title}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
        {(summary?.morphs ?? 0) > 0 && (
          <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200" title="Frames interpolated between real frames in 2023 (RIFE), to be re-rendered as real Deforum frames">
            {summary!.morphs} 2023 {summary!.morphs === 1 ? 'morph' : 'morphs'} to replace
          </span>
        )}
        {working && <span className="text-xs text-stone-500 dark:text-stone-400">{working}</span>}
        <span className="ml-auto flex gap-2">
          {confirmingCheck ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="text-stone-600 dark:text-stone-400">{clip ? 'Checks every frame of the clip, under a minute.' : 'Checks every frame, 6 minutes or more.'}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingCheck(false)
                  act({ action: 'check' })
                }}
                className={plain}
              >
                Run the check
              </button>
              <button type="button" onClick={() => setConfirmingCheck(false)} className={plain}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmingCheck(true)} className={plain}>
              {summary ? 'Check again' : 'Check for people (free)'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={open ? `Close ${title}'s review` : `Review ${title}`}
            title={open ? 'Close' : 'Review'}
            className="relative rounded p-1.5 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            {/* Flagged frames waiting to be looked at. */}
            {((summary?.flagged ?? 0) > 0 || (summary?.morphs ?? 0) > 0) && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-orange-500" />}
            <CaretDown size={18} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </span>
      </div>
      {error && (
        <div className="mt-2 flex items-start gap-3 rounded bg-red-50 dark:bg-red-950/50 p-2 text-sm text-red-800 dark:text-red-200">
          <p className="flex-1 break-words">{error}</p>
          {lastEnded?.status === 'failed' && !lastEnded.retriedBy && !busy && (
            <button type="button" onClick={() => retry(lastEnded.id)} className={plain} title="Runs it again. Frames already replaced are kept; only what didn't finish is redone.">
              Retry
            </button>
          )}
        </div>
      )}

      {open && detail && (
        <div className="mt-3">
          {!detail.check && <p className="text-sm text-stone-600 dark:text-stone-400">Not checked yet. You can still go through the frames below and replace any by hand.</p>}
          {detail.check && stretches.length === 0 && <p className="text-sm text-stone-600 dark:text-stone-400">No person flagged. {detail.replaced.length > 0 ? `${detail.replaced.length} frames have been replaced; the originals are in the take's replaced folder.` : ''}</p>}

          {stretches.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Paid label={`Re-render the ${stretches.length} stretches that show a person (${flaggedFrames} frames)`} cost={cost(flaggedFrames)} disabled={pending(stretches)} onConfirm={() => repair('rerender', stretches)} />
              <span className="text-stone-500 dark:text-stone-400">{runOn === 'pc' ? 'They take turns on the 4090.' : 'Each stretch is its own Replicate run, all side by side.'} One that still shows a person goes again with new seeds, up to ten rounds.</span>
            </div>
          )}

          {stretches.map((s) => renderStretch(s, 'person'))}

          {morphStretches.length > 0 && (
            <div className="mb-3 mt-5 rounded border border-sky-200 p-3 dark:border-sky-900">
              <p className="text-sm font-medium">
                2023 morphs: {detail.morphs.length} {detail.morphs.length === 1 ? 'frame' : 'frames'} in {morphStretches.length} {morphStretches.length === 1 ? 'stretch' : 'stretches'}
              </p>
              <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                In 2023 these were interpolated between the real frames either side (RIFE), which loses the stop-motion look. Re-rendering makes each a real Deforum frame; any that still shows a person goes again with new seeds, up to ten rounds.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Paid label={`Re-render all ${detail.morphs.length} morph frames`} cost={cost(detail.morphs.length)} disabled={pending(morphStretches)} onConfirm={() => repair('rerender', morphStretches)} />
                <button type="button" onClick={() => setShowMorphs(!showMorphs)} className={plain}>
                  {showMorphs ? 'Hide them' : 'Show them'}
                </button>
              </div>
              {showMorphs && <div className="mt-3">{morphStretches.map((s) => renderStretch(s, 'morph'))}</div>}
            </div>
          )}

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
                    <Paid label="Re-render this frame" cost={cost(1)} disabled={pending([{ start: current, end: current }]) || cursor === 0} onConfirm={() => repair('rerender', [{ start: current, end: current }])} />
                    <button type="button" disabled={pending([{ start: current, end: current }]) || cursor === 0} onClick={() => repair('hold', [{ start: current, end: current }])} className={plain}>
                      Hold the frame before (free)
                    </button>
                    {detail.replaced.includes(current) && (
                      <button type="button" disabled={pending([{ start: current, end: current }])} onClick={() => repair('restore', [{ start: current, end: current }])} className={plain}>
                        Put the original back (free)
                      </button>
                    )}
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
