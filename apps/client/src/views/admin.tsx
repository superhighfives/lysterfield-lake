import { useCallback, useEffect, useRef, useState } from 'react'
import { GridForm } from 'formulaire-ui'
import formulaireCss from 'formulaire-ui/styles.css?raw'

// Dev-only page for making and reviewing new dreams (panel 7):
// plans/ready/frame-preview-approval-tool.md. Talks to the /__admin API that
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
  method?: 'flux-kontext' | 'deforum'
  colour?: string
  preset?: string
}
type JobDetail = { name: string; config: { samples?: { frame: number; label: string }[] }; takes: Take[] }
type Preset = { title: string; prompt: string; colour: string | null; seed: number }
type DeforumOptions = { presets: Record<string, Preset>; colours: string[] }
type Run = { id: string; status: 'running' | 'succeeded' | 'failed'; log: string }
type Activity = { take: string; started: number; log: string; failed?: boolean }
type NewTake = { name: string; prompt: string; colour: string | null; preset: string; negative: string; seed?: number }

const SAMPLES_COST = 'about $2, 8 minutes'
const pad = (n: number) => String(n).padStart(4, '0')
const jobFile = (job: string, rel: string) => `/__admin/files/${job}/${rel}`
const colourUrl = (name: string) => `/__admin/colours/${name}`
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json as T
}

// Formulaire ships its CSS inside `@layer formulaire`. Tailwind's reset is
// unlayered, and unlayered rules always beat layered ones, so the layer
// wrapper is removed here and the stylesheet injected as plain CSS.
const FORMULAIRE_CSS = formulaireCss.replace(/@layer formulaire\s*\{/, '').replace(/\}\s*$/, '')

/** What a take's status means for the person reviewing it. */
function describe(take: Take, working: boolean): { label: string; tone: string } {
  if (working) return { label: 'Generating samples…', tone: 'bg-amber-100 text-amber-900' }
  if (take.status === 'rejected') return { label: 'Rejected', tone: 'bg-stone-200 text-stone-600' }
  if (take.status === 'proposed') {
    return take.samples.length > 0 ? { label: 'Ready to review', tone: 'bg-sky-100 text-sky-900' } : { label: 'No samples yet', tone: 'bg-stone-200 text-stone-700' }
  }

  return { label: 'Approved', tone: 'bg-emerald-100 text-emerald-900' }
}

function Steps() {
  const steps: [string, boolean][] = [
    ['Describe a look', true],
    ['Review five samples', true],
    ['15-second test clip', false],
    ['Full song', false],
  ]
  return (
    <ol className="mb-10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {steps.map(([label, ready], i) => (
        <li key={label} className={`flex items-center gap-2 ${ready ? 'text-stone-900' : 'text-stone-400'}`}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${ready ? 'bg-stone-900 text-white' : 'border border-stone-300'}`}>{i + 1}</span>
          {label}
          {!ready && <span className="text-xs">(not built yet)</span>}
        </li>
      ))}
    </ol>
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
      <p className="mb-4 text-sm text-stone-600">Pick a published dream to start from, then change the prompt or the colours to make it your own.</p>

      <div className="mb-4 grid grid-cols-5 gap-2 sm:grid-cols-10">
        {Object.entries(options.presets).map(([key, p]) => (
          <button key={key} type="button" onClick={() => startFrom(key)} title={p.title} className={`overflow-hidden rounded text-left ${preset === key ? 'ring-2 ring-stone-900 ring-offset-2 ring-offset-stone-100' : 'opacity-60 hover:opacity-100'}`}>
            <img src={`/assets/${key}/hero.jpg`} alt="" className="aspect-square w-full object-cover" />
            <span className="block truncate bg-white px-1 py-0.5 text-[10px] leading-tight">{p.title}</span>
          </button>
        ))}
      </div>

      <GridForm.Root density="comfortable" onFormSubmit={() => ready && onCreate({ name: id, prompt, colour, preset, negative: negative.trim(), seed: options.presets[preset]?.seed })}>
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

function TakeCard({ job, take, samples, presets, activity, busy, onAct }: {
  job: string
  take: Take
  samples: { frame: number; label: string }[]
  presets: Record<string, Preset>
  activity: Activity | null
  busy: boolean
  onAct: (body: Record<string, unknown>, track?: boolean) => void
}) {
  const mine = activity?.take === take.id ? activity : null
  const working = mine !== null && !mine.failed
  const status = describe(take, working)
  const isDeforum = take.method === 'deforum'
  const sample = (frame: number, ext: string) => jobFile(job, `7-dreams/${take.id}/samples/${pad(frame)}.${ext}`)

  return (
    <article className="mb-6 rounded-lg border border-stone-300 bg-white p-4">
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <h3 className="font-serif text-xl">{take.id}</h3>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
        {mine && working && (
          <span className="text-xs text-stone-500">
            <Elapsed since={mine.started} /> so far, usually about 8 minutes
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-stone-500">
          {take.preset && presets[take.preset] ? `Started from ${presets[take.preset].title}` : null}
          {take.colour && <img src={colourUrl(take.colour)} alt="" title={`Colours: ${take.colour}`} className="h-6 w-6 rounded object-cover" />}
        </span>
      </header>
      <p className="mb-3 max-w-3xl text-sm text-stone-700">{take.prompt}</p>

      {take.samples.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {samples.map((s) => (
            <figure key={s.frame}>
              <div className="relative">
                {isDeforum ? (
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
        <details className="mb-3 rounded bg-red-50 p-2 text-sm text-red-800" open>
          <summary className="cursor-pointer">Something went wrong. Nothing is retried automatically.</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{mine.log.slice(-2000)}</pre>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {take.status === 'proposed' && take.samples.length > 0 && (
          <>
            <button type="button" disabled={busy} onClick={() => onAct({ action: 'status', take: take.id, status: 'samples-approved' })} className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40">
              Approve
            </button>
            <button type="button" disabled={busy} onClick={() => onAct({ action: 'status', take: take.id, status: 'rejected' })} className="rounded border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-40">
              Reject
            </button>
          </>
        )}
        {take.status === 'proposed' && take.samples.length < samples.length && !working && (
          <button type="button" disabled={busy} onClick={() => onAct({ action: 'samples', take: take.id }, true)} className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            {take.samples.length > 0 ? 'Generate the missing samples' : `Generate 5 samples (${isDeforum ? SAMPLES_COST : 'about $0.15'})`}
          </button>
        )}
        {take.status === 'samples-approved' && <span className="text-sm text-stone-600">Next is the 15-second test clip, which isn&apos;t built yet.</span>}
        {take.status === 'rejected' && (
          <button type="button" disabled={busy} onClick={() => onAct({ action: 'status', take: take.id, status: 'proposed' })} className="text-sm underline disabled:opacity-40">
            Move back to review
          </button>
        )}
        <input
          defaultValue={take.notes ?? ''}
          placeholder="Notes"
          aria-label={`Notes on ${take.id}`}
          onBlur={(e) => e.target.value !== (take.notes ?? '') && onAct({ action: 'status', take: take.id, notes: e.target.value })}
          className="ml-auto w-full rounded border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 sm:w-72"
        />
      </div>
    </article>
  )
}

export default function Admin() {
  const [jobs, setJobs] = useState<string[]>([])
  const [job, setJob] = useState('')
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [options, setOptions] = useState<DeforumOptions>({ presets: {}, colours: [] })
  const [activity, setActivity] = useState<Activity | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)

  const reload = useCallback(async () => {
    if (job) setDetail(await api<JobDetail>(`/__admin/api/jobs/${job}`))
  }, [job])
  const loadOptions = useCallback(async () => setOptions(await api<DeforumOptions>('/__admin/api/deforum')), [])

  useEffect(() => {
    // Formulaire follows the OS colour scheme unless told otherwise; this page is always light.
    document.documentElement.dataset.theme = 'light'
    api<string[]>('/__admin/api/jobs')
      .then((list) => {
        setJobs(list)
        setJob((current) => current || (list.includes('full-video') ? 'full-video' : list[0] ?? ''))
      })
      .catch((e) => setError(e.message))
    loadOptions().catch((e) => setError(e.message))
  }, [loadOptions])
  useEffect(() => {
    reload().catch((e) => setError(e.message))
  }, [reload])

  /** Runs one pipeline action to the end. `track` shows its progress on the take's card. Resolves true if it succeeded. */
  const run = async (body: Record<string, unknown>, track = false): Promise<boolean> => {
    const take = String(body.take ?? '')
    const started = Date.now()
    if (track) setActivity({ take, started, log: '' })
    const { runId } = await api<{ runId: string }>(`/__admin/api/jobs/${job}/actions`, body)
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const state = await api<Run>(`/__admin/api/runs/${runId}`)
      if (state.status === 'running') continue
      await reload()
      if (state.status === 'failed') setActivity({ take, started, log: state.log, failed: true })
      else if (track) setActivity(null)
      return state.status === 'succeeded'
    }
  }

  /** One thing at a time: the pipeline runs a single action per job. */
  const guarded = async (work: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError((e as Error).message)
      setActivity((current) => (current?.failed ? current : null))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const act = (body: Record<string, unknown>, track?: boolean) => guarded(() => run(body, track))
  const create = (take: NewTake) =>
    guarded(async () => {
      const made = await run({ action: 'take', method: 'deforum', take: take.name, prompt: take.prompt, colour: take.colour, preset: take.preset, negative: take.negative || undefined, seed: take.seed })
      if (made) await run({ action: 'samples', take: take.name }, true)
    })

  const takes = detail?.takes.filter((t) => t.status) ?? []
  const samples = detail?.config.samples ?? []
  const inReview = takes.filter((t) => t.status === 'proposed')
  const approved = takes.filter((t) => t.status !== 'proposed' && t.status !== 'rejected')
  const rejected = takes.filter((t) => t.status === 'rejected')
  const card = (take: Take) => <TakeCard key={take.id} job={job} take={take} samples={samples} presets={options.presets} activity={activity} busy={busy} onAct={act} />

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
              <select value={job} onChange={(e) => setJob(e.target.value)} disabled={busy} className="rounded border border-stone-300 bg-white px-2 py-1">
                {jobs.map((j) => (
                  <option key={j}>{j}</option>
                ))}
              </select>
            </label>
          )}
        </header>
        <Steps />

        {error && <p className="mb-6 rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}

        <NewDream options={options} busy={busy} existing={detail?.takes.map((t) => t.id) ?? []} onCreate={create} onUploaded={loadOptions} />

        <section className="mb-10">
          <h2 className="mb-1 font-serif text-2xl">In review</h2>
          <p className="mb-4 text-sm text-stone-600">
            {inReview.length > 0 ? 'Five short loops per dream, one for each test moment in the song. The small inset is the footage at that moment.' : 'Nothing to review. Generate samples above to start.'}
          </p>
          {inReview.map(card)}
        </section>

        {approved.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-4 font-serif text-2xl">Approved</h2>
            {approved.map(card)}
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
