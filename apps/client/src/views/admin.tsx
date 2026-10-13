import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { GridForm } from 'formulaire-ui'
import formulaireCss from 'formulaire-ui/styles.css?raw'
import { api, jobFile, pad, reason } from './admin-api.ts'
import { PersonCheck, type CheckSummary } from './admin-person-check.tsx'

// Dev-only page for making and reviewing new dreams (panel 7), and for
// checking any dream for people: plans/in-progress/dreams.md. Talks to the /__admin API that
// vite-plugin-admin.ts adds to the dev server; never part of a build.
//
// One flow: describe a look (starting from a published dream), five samples
// are generated, then approve or reject. The form is Formulaire
// (https://formulaire.mattrothenberg.com).

type Take = {
  id: string
  prompt: string
  status?: 'proposed' | 'samples-approved' | 'clip-approved' | 'generated' | 'rejected'
  notes?: string
  samples: number[]
  hasPreview: boolean
  /** The person check on the 15-second clip: undefined if there is no clip yet, null if it hasn't been checked. */
  clipCheck?: CheckSummary | null
  method?: 'flux-kontext' | 'deforum'
  colour?: string
  preset?: string
}
type Action = 'samples' | 'clip' | 'full'
type Running = { id: string; take: string; action: string; started: number }
type Song = { id: string; title: string; published: boolean; check: CheckSummary | null }
type JobDetail = { name: string; config: { samples?: { frame: number; label: string }[] }; takes: Take[]; songs: Song[]; running: Running | null }
type Preset = { title: string; prompt: string; colour: string | null; seed: number }
type DeforumOptions = { presets: Record<string, Preset>; colours: string[] }
type Run = Running & { status: 'running' | 'succeeded' | 'failed'; log: string }
type Activity = Running & { log: string; failed?: boolean }
type NewTake = { name: string; prompt: string; colour: string | null; preset: string; negative: string; seed?: number }

// Rough Replicate cost and time for each paid stage of a Deforum take (A100, ~21s a dream frame).
const COST: Record<Action, string> = { samples: 'about $2, 8 minutes', clip: 'about $6, 70 minutes', full: 'about $75, 15 hours' }
const WORKING: Record<string, string> = { samples: 'Generating samples…', clip: 'Rendering the 15-second clip…', full: 'Generating the full song…' }
const SAMPLES_COST = COST.samples
/** "Start from" choice with nothing filled in. The model's default settings (Lush and Light's) still apply underneath. */
const BLANK = 'blank'

const colourUrl = (name: string) => `/__admin/colours/${name}`
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

// Formulaire ships its CSS inside `@layer formulaire`. Tailwind's reset is
// unlayered, and unlayered rules always beat layered ones, so the layer
// wrapper is removed here and the stylesheet injected as plain CSS.
const FORMULAIRE_CSS =
  formulaireCss.replace(/@layer formulaire\s*\{/, '').replace(/\}\s*$/, '') +
  // Formulaire doesn't style a disabled button.
  '.gf-button:disabled { opacity: 0.45; cursor: not-allowed; }'


/** What a take's status means for the person reviewing it. */
function describe(take: Take, working: string | null, expected: number): { label: string; tone: string } {
  const waiting = 'bg-sky-100 text-sky-900'
  const good = 'bg-emerald-100 text-emerald-900'
  const idle = 'bg-stone-200 text-stone-700'
  if (working) return { label: WORKING[working] ?? 'Working…', tone: 'bg-amber-100 text-amber-900' }
  switch (take.status) {
    case 'rejected':
      return { label: 'Rejected', tone: 'bg-stone-200 text-stone-600' }
    case 'proposed':
      if (take.samples.length === 0) return { label: 'No samples yet', tone: idle }
      return take.samples.length < expected ? { label: `${take.samples.length} of ${expected} samples made`, tone: idle } : { label: 'Samples ready to review', tone: waiting }
    case 'samples-approved':
      return take.hasPreview ? { label: 'Clip ready to review', tone: waiting } : { label: 'Samples approved', tone: good }
    case 'clip-approved':
      return { label: 'Clip approved', tone: good }
    default:
      return { label: 'Full song done', tone: good }
  }
}

function Steps() {
  const steps = ['Describe a look', 'Review five samples', 'Review a 15-second clip', 'Generate the full song']
  return (
    <ol className="mb-10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-900 text-xs font-semibold text-white">{i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  )
}

/**
 * The full song is the one expensive, slow step, so it asks first: a dialog
 * that says what it costs, and won't start until the reviewer confirms the
 * clip shows no person (panel 7 must never show one, and clean samples
 * aren't proof of that).
 */
function FullSongButton({ take, disabled, onConfirm }: { take: string; disabled?: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState(false)
  const [cost, time] = COST.full.split(', ')
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setChecked(false)
      }}
    >
      <AlertDialog.Trigger disabled={disabled} className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
        Generate the full song…
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/40" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 font-sans text-stone-900 shadow-xl [color-scheme:light] [touch-action:auto]">
          <AlertDialog.Title className="font-serif text-2xl">Generate the full song for {take}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-stone-600">
            This renders the whole song on Replicate: {cost}, over {time}. It can be stopped and started again without paying twice for finished work, but the money for what has already rendered is spent.
          </AlertDialog.Description>
          <label className="mt-4 flex cursor-pointer items-start gap-2 rounded bg-amber-50 p-3 text-sm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5" />
            <span>I watched the whole 15-second clip and no person appears in the dream. A person has come through on back views before, even when the samples looked clean.</span>
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className="rounded border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100">Cancel</AlertDialog.Close>
            <button
              type="button"
              disabled={!checked}
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
              className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              Spend {cost} and start
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.floor((Date.now() - since) / 1000)
  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function NewDream({ options, busy, existing, onCreate, onUploaded }: {
  options: DeforumOptions
  busy: boolean
  existing: string[]
  onCreate: (take: NewTake) => void
  onUploaded: () => Promise<void>
}) {
  const [preset, setPreset] = useState('')
  const [prompt, setPrompt] = useState('')
  const [colour, setColour] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [negative, setNegative] = useState('')
  const [uploadError, setUploadError] = useState('')

  const startFrom = useCallback(
    (id: string) => {
      if (id === BLANK) {
        setPreset(BLANK)
        setPrompt('')
        setColour(null)
        return
      }

      const p = options.presets[id]
      if (!p) return
      setPreset(id)
      setPrompt(p.prompt)
      setColour(p.colour)
    },
    [options.presets]
  )
  // Start with a published dream filled in rather than an empty form.
  useEffect(() => {
    if (!preset) startFrom(options.presets['lush-and-light'] ? 'lush-and-light' : Object.keys(options.presets)[0] ?? '')
  }, [preset, options.presets, startFrom])

  const upload = async (input: HTMLInputElement) => {
    const f = input.files?.[0]
    if (!f) return
    setUploadError('')
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(f)
      })
      const fileName = f.name.replace(/[^\w.-]+/g, '-')
      await api('/__admin/api/colours', { name: fileName, data })
      await onUploaded()
      setColour(fileName)
    } catch (e) {
      setUploadError((e as Error).message)
    }

    input.value = ''
  }

  const id = name.replace(/^-+|-+$/g, '')
  const taken = existing.includes(id)
  const ready = !busy && prompt.trim() !== '' && id !== '' && !taken && preset !== ''
  const swatch = (selected: boolean) => `h-14 w-14 overflow-hidden rounded ${selected ? 'ring-2 ring-stone-900 ring-offset-2' : 'opacity-80 hover:opacity-100'}`

  return (
    <section className="mb-14">
      <h2 className="mb-1 font-serif text-2xl">New dream</h2>
      <p className="mb-4 text-sm text-stone-600">Pick a published dream to start from, then change the prompt or the colours to make it your own. Or start blank.</p>

      <div className="mb-4 grid grid-cols-6 gap-2 sm:grid-cols-11">
        <button type="button" onClick={() => startFrom(BLANK)} title="Start with an empty prompt" className={`overflow-hidden rounded text-left ${preset === BLANK ? 'ring-2 ring-stone-900 ring-offset-2 ring-offset-stone-100' : 'opacity-60 hover:opacity-100'}`}>
          <span className="flex aspect-square w-full items-center justify-center border border-dashed border-stone-400 bg-white text-2xl text-stone-400">+</span>
          <span className="block truncate bg-white px-1 py-0.5 text-[10px] leading-tight">Blank</span>
        </button>
        {Object.entries(options.presets).map(([key, p]) => (
          <button key={key} type="button" onClick={() => startFrom(key)} title={p.title} className={`overflow-hidden rounded text-left ${preset === key ? 'ring-2 ring-stone-900 ring-offset-2 ring-offset-stone-100' : 'opacity-60 hover:opacity-100'}`}>
            <img src={`/assets/${key}/hero.jpg`} alt="" className="aspect-square w-full object-cover" />
            <span className="block truncate bg-white px-1 py-0.5 text-[10px] leading-tight">{p.title}</span>
          </button>
        ))}
      </div>

      <GridForm.Root density="comfortable" onFormSubmit={() => ready && onCreate({ name: id, prompt, colour, preset: preset === BLANK ? '' : preset, negative: negative.trim(), seed: options.presets[preset]?.seed })}>
        <GridForm.Section legend="The look">
          <GridForm.Row>
            <GridForm.Field name="prompt" label="Prompt" description="Describe a landscape only, never a person. The shape of the person in the footage becomes part of the scene.">
              <GridForm.Textarea required rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </GridForm.Field>
          </GridForm.Row>
          <GridForm.Row>
            {/* Not a text control, so a plain Formulaire cell rather than a Field. */}
            <div className="gf-field" style={{ cursor: 'default' }}>
              <span className="gf-label">Colours</span>
              <div className="gf-control flex flex-wrap gap-2 py-1">
                <button type="button" onClick={() => setColour(null)} className={`${swatch(colour === null)} border border-stone-300 bg-white text-[10px] leading-tight`}>
                  from the footage
                </button>
                {options.colours.map((c) => (
                  <button key={c} type="button" title={c} onClick={() => setColour(c)} className={swatch(colour === c)}>
                    <img src={colourUrl(c)} alt={c} className="h-full w-full object-cover" />
                  </button>
                ))}
                <label className="flex h-14 w-14 cursor-pointer items-center justify-center rounded border border-dashed border-stone-400 px-1 text-center text-[10px] leading-tight hover:bg-white">
                  + your own
                  <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => upload(e.target)} />
                </label>
              </div>
              <p className="gf-description">{uploadError ? <span className="text-red-700">{uploadError}</span> : 'Every frame is colour-matched to the image you pick.'}</p>
            </div>
          </GridForm.Row>
        </GridForm.Section>
        <GridForm.Section legend="Details">
          <GridForm.Row>
            <GridForm.Field name="name" label="Name" error={taken ? 'Already used' : undefined} description="Becomes the dream's id, like autumn-ink.">
              <GridForm.Input required value={name} onChange={(e) => setName(slug(e.target.value))} />
            </GridForm.Field>
            <GridForm.Field name="negative" label="Also avoid" span={2} description="Optional, like buildings or text. Added to the built-in list that keeps people out.">
              <GridForm.Input value={negative} onChange={(e) => setNegative(e.target.value)} />
            </GridForm.Field>
          </GridForm.Row>
        </GridForm.Section>
        <GridForm.Actions>
          <span className="text-sm text-stone-600">{busy ? 'Wait for the current run to finish.' : `Runs on Replicate: ${SAMPLES_COST}.`}</span>
          <GridForm.Button type="submit" variant="primary" disabled={!ready}>
            Generate 5 samples
          </GridForm.Button>
        </GridForm.Actions>
      </GridForm.Root>
    </section>
  )
}

function TakeCard({ job, take, samples, presets, activity, generating, onGenerate, onUpdate, onChanged }: {
  job: string
  take: Take
  samples: { frame: number; label: string }[]
  presets: Record<string, Preset>
  activity: Activity | null
  /** Something paid is already running for this footage. */
  generating: boolean
  onGenerate: (take: string, action: Action) => void
  onUpdate: (take: string, change: { status?: Take['status']; notes?: string }) => void
  onChanged: () => void
}) {
  const mine = activity?.take === take.id ? activity : null
  const working = mine !== null && !mine.failed
  const status = describe(take, working ? mine.action : null, samples.length)
  const allSamples = take.samples.length >= samples.length
  const isDeforum = take.method === 'deforum'
  const sample = (frame: number, ext: string) => jobFile(job, `7-dreams/${take.id}/samples/${pad(frame)}.${ext}`)
  const progress = mine?.log.match(/Dream frames: (\d+) of (\d+) done(?![\s\S]*Dream frames:)/)
  const primary = 'rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40'
  const approve = 'rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800'
  const plain = 'rounded border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100'
  const watchClip = take.hasPreview && (
    <a href={`/?preview=${job}/${take.id}`} target="_blank" rel="noreferrer" className={plain}>
      Watch the clip in the player
    </a>
  )
  const reject = (
    <button type="button" onClick={() => onUpdate(take.id, { status: 'rejected' })} className={plain}>
      Reject
    </button>
  )

  return (
    <article className="mb-6 rounded-lg border border-stone-300 bg-white p-4">
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <h3 className="font-serif text-xl">{take.id}</h3>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
        {mine && working && (
          <span className="text-xs text-stone-500">
            <Elapsed since={mine.started} />
            {progress ? `, ${progress[1]} of ${progress[2]} frames` : ''}
            {mine.action in COST ? ` (usually ${COST[mine.action as Action].split(', ')[1]})` : ''}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-stone-500">
          {take.preset && presets[take.preset] ? `Started from ${presets[take.preset].title}` : null}
          {take.colour && <img src={colourUrl(take.colour)} alt="" title={`Colours: ${take.colour}`} className="h-6 w-6 rounded object-cover" />}
        </span>
      </header>
      <p className="mb-3 max-w-3xl text-sm text-stone-700">{take.prompt}</p>

      {(take.samples.length > 0 || (working && mine.action === 'samples')) && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {samples.map((s) => (
            <figure key={s.frame}>
              <div className="relative">
                {!take.samples.includes(s.frame) ? (
                  <div className="flex aspect-square w-full items-center justify-center rounded border border-dashed border-stone-300 text-xs text-stone-400">{working ? 'Generating…' : 'Not made yet'}</div>
                ) : isDeforum ? (
                  <video src={sample(s.frame, 'mp4')} poster={sample(s.frame, 'jpg')} autoPlay loop muted playsInline className="aspect-square w-full rounded object-cover" />
                ) : (
                  <img src={sample(s.frame, 'jpg')} alt="" className="aspect-square w-full rounded object-cover" />
                )}
                <img src={jobFile(job, `0-source/frames/${pad(s.frame)}.jpg`)} alt="" title="The footage at this moment" className="absolute bottom-1 right-1 w-1/3 rounded border border-white shadow" />
              </div>
              <figcaption className="mt-1 text-xs text-stone-500">{s.label}</figcaption>
            </figure>
          ))}
        </div>
      )}

      {mine?.failed && (
        <div className="mb-3 rounded bg-red-50 p-3 text-sm text-red-800">
          <p className="font-medium">That run stopped with an error.</p>
          <p className="mt-1 break-words">{reason(mine.log)}</p>
          <p className="mt-1 text-red-700">Nothing is retried automatically. Starting it again carries on from where it stopped, without paying twice for finished work.</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs">Full log</summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs">{mine.log.slice(-6000)}</pre>
          </details>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {take.status === 'proposed' && take.samples.length > 0 && !working && (
          <>
            {allSamples && (
              <button type="button" onClick={() => onUpdate(take.id, { status: 'samples-approved' })} className={approve}>
                Approve samples
              </button>
            )}
            {reject}
          </>
        )}
        {take.status === 'proposed' && take.samples.length < samples.length && !working && (
          <button type="button" disabled={generating} onClick={() => onGenerate(take.id, 'samples')} className={primary}>
            {take.samples.length > 0 || mine?.failed ? 'Generate the missing samples' : `Generate 5 samples (${isDeforum ? COST.samples : 'about $0.15'})`}
          </button>
        )}
        {take.status === 'samples-approved' && !working && (
          <>
            {watchClip}
            {take.hasPreview && (
              <button type="button" onClick={() => onUpdate(take.id, { status: 'clip-approved' })} className={approve}>
                Approve clip
              </button>
            )}
            {isDeforum && !take.hasPreview && (
              <button type="button" disabled={generating} onClick={() => onGenerate(take.id, 'clip')} className={primary}>
                Render the 15-second clip ({COST.clip})
              </button>
            )}
            {reject}
          </>
        )}
        {take.status === 'clip-approved' && !working && (
          <>
            {watchClip}
            {isDeforum && <FullSongButton take={take.id} disabled={generating} onConfirm={() => onGenerate(take.id, 'full')} />}
            {reject}
          </>
        )}
        {take.status === 'generated' && <span className="text-sm text-stone-600">Frames are in 7-dreams/{take.id}/frames. Publish it with the pipeline&apos;s compose command.</span>}
        {take.status === 'rejected' && (
          <button type="button" onClick={() => onUpdate(take.id, { status: 'proposed' })} className="text-sm underline">
            Move back to review
          </button>
        )}
        <input
          defaultValue={take.notes ?? ''}
          placeholder="Notes"
          aria-label={`Notes on ${take.id}`}
          onBlur={(e) => e.target.value !== (take.notes ?? '') && onUpdate(take.id, { notes: e.target.value })}
          className="ml-auto w-full rounded border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 sm:w-72"
        />
      </div>
      {take.clipCheck !== undefined && take.status !== 'rejected' && (
        <div className="mt-3">
          <PersonCheck job={job} take={take.id} title="People in the clip" clip summary={take.clipCheck} busy={generating} onChanged={onChanged} />
          <p className="text-xs text-stone-500">The share of clip frames flagged is roughly what the full song will need replaced.</p>
        </div>
      )}
      {isDeforum && (take.status === 'samples-approved' || take.status === 'clip-approved') && (
        <p className="mt-2 text-xs text-stone-500">Long runs are safe to interrupt: starting one again carries on from where it stopped, without paying twice.</p>
      )}
      {!isDeforum && (take.status === 'samples-approved' || take.status === 'clip-approved') && <p className="mt-2 text-xs text-stone-500">Made with the older method; its clip and full song run from the pipeline&apos;s command line.</p>}
    </article>
  )
}

export default function Admin() {
  const [jobs, setJobs] = useState<string[]>([])
  const [job, setJob] = useState('')
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [options, setOptions] = useState<DeforumOptions>({ presets: {}, colours: [] })
  const [activity, setActivity] = useState<Activity | null>(null)
  const [error, setError] = useState('')
  /** The paid run this page is following, so it is never followed twice. */
  const following = useRef('')

  const reload = useCallback(async () => {
    if (job) setDetail(await api<JobDetail>(`/__admin/api/jobs/${job}`))
  }, [job])
  const loadOptions = useCallback(async () => setOptions(await api<DeforumOptions>('/__admin/api/deforum')), [])
  const fail = (e: unknown) => setError((e as Error).message)

  useEffect(() => {
    // Formulaire follows the OS colour scheme unless told otherwise; this page is always light.
    document.documentElement.dataset.theme = 'light'
    api<string[]>('/__admin/api/jobs')
      .then((list) => {
        setJobs(list)
        setJob((current) => current || (list.includes('full-video') ? 'full-video' : list[0] ?? ''))
      })
      .catch(fail)
    loadOptions().catch(fail)
  }, [loadOptions])
  useEffect(() => {
    reload().catch(fail)
  }, [reload])

  /** Waits for a pipeline run to end, reporting its log as it goes. */
  const wait = async (runId: string, onLog?: (run: Run) => void): Promise<Run> => {
    for (;;) {
      const run = await api<Run>(`/__admin/api/runs/${runId}`)
      onLog?.(run)
      if (run.status !== 'running') return run
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  /** Follows a paid run on its take's card until it ends. */
  const follow = useCallback(
    async (running: Running) => {
      if (following.current === running.id) return
      following.current = running.id
      setActivity({ ...running, log: '' })
      try {
        const run = await wait(running.id, (state) => setActivity({ ...running, log: state.log }))
        setActivity(run.status === 'failed' ? { ...running, log: run.log, failed: true } : null)
        await reload()
      } catch (e) {
        setActivity(null)
        fail(e)
      }
    },
    [reload]
  )
  // A run that was already going when the page loaded (a reload during a long render).
  useEffect(() => {
    if (detail?.running) follow(detail.running)
  }, [detail?.running, follow])

  /** Starts a pipeline action and returns its run id. */
  const start = (body: Record<string, unknown>) => api<{ runId: string }>(`/__admin/api/jobs/${job}/actions`, body).then((r) => r.runId)

  const generate = async (take: string, action: Action) => {
    setError('')
    try {
      await follow({ id: await start({ action, take }), take, action, started: Date.now() })
    } catch (e) {
      fail(e)
    }
  }

  /** Approvals and notes: instant, and allowed while something is generating. */
  const update = async (take: string, change: { status?: Take['status']; notes?: string }) => {
    setError('')
    try {
      const run = await wait(await start({ action: 'status', take, ...change }))
      if (run.status === 'failed') setError(reason(run.log))
      await reload()
    } catch (e) {
      fail(e)
    }
  }

  const create = async (take: NewTake) => {
    setError('')
    try {
      const made = await wait(await start({ action: 'take', method: 'deforum', take: take.name, prompt: take.prompt, colour: take.colour, preset: take.preset, negative: take.negative || undefined, seed: take.seed }))
      await reload()
      if (made.status === 'failed') return setError(reason(made.log))
      await generate(take.name, 'samples')
    } catch (e) {
      fail(e)
    }
  }

  const generating = activity !== null && !activity.failed
  const takes = detail?.takes.filter((t) => t.status) ?? []
  const samples = detail?.config.samples ?? []
  const inReview = takes.filter((t) => t.status !== 'generated' && t.status !== 'rejected')
  const finished = takes.filter((t) => t.status === 'generated')
  const rejected = takes.filter((t) => t.status === 'rejected')
  const card = (take: Take) => <TakeCard key={take.id} job={job} take={take} samples={samples} presets={options.presets} activity={activity} generating={generating} onGenerate={generate} onUpdate={update} onChanged={() => reload().catch(fail)} />

  return (
    // The player's global styles lock the page (overflow hidden, touch-action none), so this view scrolls itself.
    <div className="fixed inset-0 overflow-y-auto bg-stone-100 font-sans text-stone-900 [touch-action:auto]">
      <style>{FORMULAIRE_CSS}</style>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-serif text-4xl">Dreams</h1>
          <p className="text-sm text-stone-600">Make and review new looks for the dream panel. Only runs on this machine.</p>
          {jobs.length > 1 && (
            <label className="ml-auto text-sm text-stone-600">
              Footage{' '}
              <select value={job} onChange={(e) => setJob(e.target.value)} disabled={generating} className="rounded border border-stone-300 bg-white px-2 py-1 text-stone-900">
                {jobs.map((j) => (
                  <option key={j}>{j}</option>
                ))}
              </select>
            </label>
          )}
        </header>
        <Steps />

        {error && <p className="mb-6 rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}

        <NewDream options={options} busy={generating} existing={detail?.takes.map((t) => t.id) ?? []} onCreate={create} onUploaded={loadOptions} />

        <section className="mb-10">
          <h2 className="mb-1 font-serif text-2xl">In review</h2>
          <p className="mb-4 text-sm text-stone-600">
            {inReview.length > 0
              ? 'Each dream moves through samples, a 15-second clip, then the full song, and needs your approval before each paid step. In the samples, the small inset is the footage at that moment.'
              : 'Nothing to review. Generate samples above to start.'}
          </p>
          {inReview.map(card)}
        </section>

        {finished.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-4 font-serif text-2xl">Finished</h2>
            {finished.map(card)}
          </section>
        )}

        {(detail?.songs.length ?? 0) > 0 && (
          <section className="mb-10">
            <h2 className="mb-1 font-serif text-2xl">People check</h2>
            <p className="mb-3 text-sm text-stone-600">
              Every dream with a full song, published ones included. The check is free and runs on this machine. It flags a literal person, hands, or a cut-out of the subject; a shape that only looks like a person is the
              intended look and is left alone. A flagged frame is re-rendered from the frame before it, or that frame is held; the original is always kept.
            </p>
            <div className="rounded-lg border border-stone-300 bg-white px-4">
              {detail!.songs.map((song) => (
                <PersonCheck key={song.id} job={job} take={song.id} title={song.published ? `${song.title} (published)` : song.title} summary={song.check} busy={generating} onChanged={() => reload().catch(fail)} />
              ))}
            </div>
          </section>
        )}

        {rejected.length > 0 && (
          <details className="mb-10">
            <summary className="cursor-pointer font-serif text-xl text-stone-500">Rejected ({rejected.length})</summary>
            <div className="mt-4">{rejected.map(card)}</div>
          </details>
        )}
      </div>
    </div>
  )
}
