import { useCallback, useEffect, useState } from 'react'

// Dev-only review page for the dream preview/approval loop
// (plans/ready/frame-preview-approval-tool.md). Talks to the /__admin API
// that vite-plugin-admin.ts adds to the dev server; never part of a build.

type Direction = { name: string; prompt: string; palette: string[]; rationale: string }
type DirectionBatch = { file: string; brief: string; directions: Direction[] }
type Take = {
  id: string
  prompt: string
  status?: 'proposed' | 'samples-approved' | 'clip-approved' | 'generated' | 'rejected'
  brief?: string
  direction?: { name: string; palette: string[]; rationale: string }
  notes?: string
  samples: number[]
  hasPreview: boolean
  method?: 'flux-kontext' | 'deforum'
  colour?: string
  preset?: string
}
type Preset = { title: string; prompt: string; colour: string | null; seed: number }
type DeforumOptions = { presets: Record<string, Preset>; colours: string[] }
type JobDetail = {
  name: string
  config: { samples?: { frame: number; label: string }[]; clip?: { start: number; frames: number } }
  takes: Take[]
  directions: DirectionBatch[]
}
type Run = { id: string; status: 'running' | 'succeeded' | 'failed'; log: string }

const pad = (n: number) => String(n).padStart(4, '0')
const file = (job: string, rel: string) => `/__admin/files/${job}/${rel}`

async function api<T>(url: string, init?: Parameters<typeof fetch>[1]): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body as T
}

/** A button that needs a second click to confirm, showing what it costs. */
function SpendButton({ label, cost, disabled, onConfirm }: { label: string; cost: string; disabled?: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      onBlur={() => setArmed(false)}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${armed ? 'bg-amber-500 text-black' : 'bg-white/10 hover:bg-white/20'}`}
    >
      {armed ? `Confirm: spend ${cost}` : `${label} (${cost})`}
    </button>
  )
}

function Palette({ colours }: { colours: string[] }) {
  return (
    <div className="flex gap-1">
      {colours.map((c) => (
        <span key={c} title={c} className="h-5 w-5 rounded-sm border border-white/20" style={{ background: c }} />
      ))}
    </div>
  )
}

/** A new Deforum take: the legacy dreams' method. Prompt + colour reference, optionally starting from a legacy dream's settings. */
function DeforumForm({ busy, onCreate }: { busy: boolean; onCreate: (body: Record<string, unknown>) => void }) {
  const [options, setOptions] = useState<DeforumOptions>({ presets: {}, colours: [] })
  const [preset, setPreset] = useState('lush-and-light')
  const [prompt, setPrompt] = useState('')
  const [colour, setColour] = useState<string | null>(null)
  const [negative, setNegative] = useState('')
  const [name, setName] = useState('')
  const [uploadError, setUploadError] = useState('')

  const load = useCallback(() => api<DeforumOptions>('/__admin/api/deforum').then(setOptions), [])
  useEffect(() => {
    load()
  }, [load])

  const startFrom = (id: string) => {
    setPreset(id)
    const p = options.presets[id]
    if (p) {
      setPrompt(p.prompt)
      setColour(p.colour)
    }
  }

  const upload = async (fileInput: HTMLInputElement) => {
    const f = fileInput.files?.[0]
    if (!f) return
    setUploadError('')
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(f)
    })
    const fileName = f.name.replace(/[^\w.-]+/g, '-')
    try {
      await api('/__admin/api/colours', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: fileName, data }) })
      await load()
      setColour(fileName)
    } catch (e) {
      setUploadError((e as Error).message)
    }
  }

  return (
    <div className="max-w-5xl rounded border border-white/10 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-400">Start from a legacy dream:</span>
        {Object.entries(options.presets).map(([id, p]) => (
          <button key={id} type="button" onClick={() => startFrom(id)} className={`rounded px-2 py-1 ${preset === id ? 'bg-white/25' : 'bg-white/10 hover:bg-white/20'}`}>
            {p.title}
          </button>
        ))}
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Landscape-only prompt — never describe the person" className="mb-3 h-20 w-full rounded bg-white/5 p-2 text-sm" />
      <p className="mb-2 text-sm text-neutral-400">Colour reference (every frame is colour-matched to it):</p>
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => setColour(null)} className={`h-16 w-16 rounded text-xs ${colour === null ? 'ring-2 ring-amber-400' : 'bg-white/10'}`}>
          from the footage
        </button>
        {options.colours.map((c) => (
          <button key={c} type="button" title={c} onClick={() => setColour(c)} className={`h-16 w-16 overflow-hidden rounded ${colour === c ? 'ring-2 ring-amber-400' : ''}`}>
            <img src={`/__admin/colours/${c}`} alt={c} className="h-full w-full object-cover" />
          </button>
        ))}
        <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded bg-white/10 text-xs hover:bg-white/20">
          + upload
          <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => upload(e.target)} />
        </label>
      </div>
      {uploadError && <p className="mb-2 text-sm text-rose-300">{uploadError}</p>}
      <details className="mb-3 text-sm">
        <summary className="cursor-pointer text-neutral-400">Negative prompt (default: the legacy list — no people, faces, bodies…)</summary>
        <textarea value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="Leave empty for the legacy negative prompt" className="mt-2 h-20 w-full rounded bg-white/5 p-2 text-sm" />
      </details>
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} placeholder="take-name" className="rounded bg-white/5 px-2 py-1 text-sm" />
        <button
          type="button"
          disabled={busy || !prompt.trim() || !name}
          onClick={() => onCreate({ action: 'take', method: 'deforum', take: name, prompt, colour, preset, negative: negative.trim() || undefined, seed: options.presets[preset]?.seed })}
          className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-40"
        >
          Make Deforum take
        </button>
      </div>
    </div>
  )
}

const STATUS_STYLE: Record<string, string> = {
  proposed: 'bg-sky-500/20 text-sky-200',
  'samples-approved': 'bg-violet-500/20 text-violet-200',
  'clip-approved': 'bg-emerald-500/20 text-emerald-200',
  generated: 'bg-emerald-600/30 text-emerald-100',
  rejected: 'bg-rose-500/20 text-rose-200',
}

export default function Admin() {
  const [jobs, setJobs] = useState<string[]>([])
  const [job, setJob] = useState<string>('')
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState<string>('')
  const [brief, setBrief] = useState('')
  const [takeNames, setTakeNames] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    if (job) setDetail(await api<JobDetail>(`/__admin/api/jobs/${job}`))
  }, [job])

  useEffect(() => {
    api<string[]>('/__admin/api/jobs').then((list) => {
      setJobs(list)
      setJob((current) => current || (list.includes('full-video') ? 'full-video' : list[0] ?? ''))
    })
  }, [])
  useEffect(() => {
    reload().catch((e) => setError(e.message))
  }, [reload])

  // Poll the current run until it finishes, then refresh the job.
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const timer = setInterval(async () => {
      const next = await api<Run>(`/__admin/api/runs/${run.id}`)
      setRun(next)
      if (next.status !== 'running') reload()
    }, 2000)
    return () => clearInterval(timer)
  }, [run, reload])

  const act = async (body: Record<string, unknown>) => {
    setError('')
    try {
      const { runId } = await api<{ runId: string }>(`/__admin/api/jobs/${job}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setRun({ id: runId, status: 'running', log: '' })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const busy = run?.status === 'running'
  const samples = detail?.config.samples ?? []

  return (
    // The player's global styles lock the page (overflow hidden, touch-action none), so this view scrolls itself.
    <div className="fixed inset-0 overflow-y-auto bg-neutral-950 p-6 text-neutral-100 [font-family:system-ui] [touch-action:auto]">
      <header className="mb-6 flex items-center gap-4">
        <h1 className="text-xl font-semibold">Dream review</h1>
        <select value={job} onChange={(e) => setJob(e.target.value)} className="rounded bg-white/10 px-2 py-1 text-sm">
          {jobs.map((j) => (
            <option key={j}>{j}</option>
          ))}
        </select>
        <span className="text-sm text-neutral-400">dev only · approvals gate each paid stage</span>
      </header>

      {error && <p className="mb-4 rounded bg-rose-500/20 p-3 text-sm text-rose-100">{error}</p>}
      {run && (
        <section className="mb-6 rounded border border-white/10 p-3">
          <p className="mb-2 text-sm">
            Run: <strong>{run.status}</strong>
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-400">{run.log.slice(-4000)}</pre>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">1. Directions</h2>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Brief: the feeling, references, palette ideas…"
          className="mb-2 h-20 w-full max-w-2xl rounded bg-white/5 p-2 text-sm"
        />
        <div className="mb-6">
          <SpendButton label="Get directions" cost="~$0.05" disabled={busy || !brief.trim()} onConfirm={() => act({ action: 'directions', brief })} />
        </div>
        {detail?.directions.map((batch) => (
          <div key={batch.file} className="mb-6">
            <p className="mb-2 text-sm text-neutral-400">“{batch.brief}”</p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {batch.directions.map((d, i) => {
                const key = `${batch.file}#${i}`
                const name = takeNames[key] ?? d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
                return (
                  <div key={key} className="flex flex-col gap-2 rounded border border-white/10 p-3">
                    <strong>{d.name}</strong>
                    <Palette colours={d.palette} />
                    <p className="text-sm">{d.prompt}</p>
                    <p className="text-xs text-neutral-400">{d.rationale}</p>
                    <div className="mt-auto flex gap-2">
                      <input
                        value={name}
                        onChange={(e) => setTakeNames({ ...takeNames, [key]: e.target.value })}
                        className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-sm"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act({ action: 'take', take: name, directions: batch.file, index: i })}
                        className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
                      >
                        Make take
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">1b. Or a Deforum take (the legacy dreams&apos; method)</h2>
        <div className="mb-10">
          <DeforumForm busy={busy} onCreate={act} />
        </div>
        <h2 className="mb-3 text-lg font-semibold">2. Takes</h2>
        {detail?.takes.filter((t) => t.status).length === 0 && <p className="text-sm text-neutral-400">No takes yet — make one from a direction.</p>}
        {detail?.takes
          .filter((t) => t.status)
          .map((take) => (
            <article key={take.id} className="mb-8 rounded border border-white/10 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <h3 className="font-semibold">{take.id}</h3>
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[take.status!] ?? ''}`}>{take.status}</span>
                {take.direction && <Palette colours={take.direction.palette} />}
                {take.method === 'deforum' && (
                  <span className="flex items-center gap-2 text-xs text-neutral-400">
                    Deforum{take.preset ? ` · from ${take.preset}` : ''}
                    {take.colour ? <img src={`/__admin/colours/${take.colour}`} alt={take.colour} className="h-6 w-6 rounded object-cover" /> : ' · colours from the footage'}
                  </span>
                )}
              </div>
              <p className="mb-3 max-w-3xl text-sm text-neutral-300">{take.prompt}</p>

              {take.samples.length > 0 && (
                <div className="mb-3 flex gap-2 overflow-x-auto">
                  {samples.map((s) => (
                    <figure key={s.frame} className="w-48 shrink-0">
                      <img src={file(job, `0-source/frames/${pad(s.frame)}.jpg`)} alt="" className="aspect-square w-full object-cover opacity-60" />
                      {take.method === 'deforum' ? (
                        <video src={file(job, `7-dreams/${take.id}/samples/${pad(s.frame)}.mp4`)} poster={file(job, `7-dreams/${take.id}/samples/${pad(s.frame)}.jpg`)} autoPlay loop muted playsInline className="aspect-square w-full object-cover" />
                      ) : (
                        <img src={file(job, `7-dreams/${take.id}/samples/${pad(s.frame)}.jpg`)} alt="" className="aspect-square w-full object-cover" />
                      )}
                      <figcaption className="mt-1 text-xs text-neutral-400">{s.label}</figcaption>
                    </figure>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {take.status === 'proposed' && (
                  <SpendButton
                    label={take.samples.length ? 'Regenerate samples' : 'Generate samples'}
                    cost={take.method === 'deforum' ? '5 GPU runs, cost TBC' : '~$0.15'}
                    disabled={busy}
                    onConfirm={() => act({ action: 'samples', take: take.id })}
                  />
                )}
                {take.status === 'proposed' && take.samples.length > 0 && (
                  <button type="button" disabled={busy} onClick={() => act({ action: 'status', take: take.id, status: 'samples-approved' })} className="rounded bg-emerald-600/40 px-3 py-1.5 text-sm hover:bg-emerald-600/60 disabled:opacity-40">
                    Approve samples
                  </button>
                )}
                {take.method === 'deforum' && take.status === 'samples-approved' && (
                  <span className="text-xs text-neutral-400">Test clip for Deforum takes isn&apos;t wired up yet.</span>
                )}
                {take.method !== 'deforum' && (take.status === 'samples-approved' || take.status === 'clip-approved') && (
                  <SpendButton
                    label={take.hasPreview ? 'Re-render 15s clip' : 'Render 15s clip'}
                    cost="~$2.70"
                    disabled={busy}
                    onConfirm={() => act({ action: 'clip', take: take.id })}
                  />
                )}
                {take.hasPreview && (
                  <a href={`/?preview=${job}/${take.id}`} target="_blank" rel="noreferrer" className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
                    Watch clip in the player
                  </a>
                )}
                {take.status === 'samples-approved' && take.hasPreview && (
                  <button type="button" disabled={busy} onClick={() => act({ action: 'status', take: take.id, status: 'clip-approved' })} className="rounded bg-emerald-600/40 px-3 py-1.5 text-sm hover:bg-emerald-600/60 disabled:opacity-40">
                    Approve clip
                  </button>
                )}
                {take.status === 'clip-approved' && (
                  <code className="rounded bg-white/5 px-2 py-1 text-xs">bun run src/cli.ts dream --job .jobs/{job} --take {take.id}</code>
                )}
                {take.status !== 'rejected' && take.status !== 'generated' && (
                  <button type="button" disabled={busy} onClick={() => act({ action: 'status', take: take.id, status: 'rejected' })} className="rounded bg-rose-600/30 px-3 py-1.5 text-sm hover:bg-rose-600/50 disabled:opacity-40">
                    Reject
                  </button>
                )}
              </div>

              <textarea
                defaultValue={take.notes ?? ''}
                placeholder="Notes"
                onBlur={(e) => e.target.value !== (take.notes ?? '') && act({ action: 'status', take: take.id, notes: e.target.value })}
                className="mt-3 h-14 w-full max-w-2xl rounded bg-white/5 p-2 text-sm"
              />
            </article>
          ))}
      </section>
    </div>
  )
}
