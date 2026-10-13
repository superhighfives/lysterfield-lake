import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/**
 * Dev-only API for the /admin page (plans/in-progress/dreams.md): reads
 * `apps/pipeline/.jobs`, serves job files read-only, and runs the
 * pipeline's dream commands (the preview loop, the person check and its
 * repairs). `apply: 'serve'` means none of
 * this exists in a production build.
 */

const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pipeline')
const JOBS_DIR = path.join(PIPELINE_DIR, '.jobs')
const COLOURS_DIR = path.join(PIPELINE_DIR, 'resources', 'colours')
const MAX_COLOUR_UPLOAD = 20 * 1024 * 1024
const DEFORUM_PRESETS = path.resolve(PIPELINE_DIR, '..', '..', 'models', 'deforum', 'settings', 'presets.json')

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mov': 'video/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
}

type Run = { id: string; job: string; action: string; take: string; started: number; args: string[]; status: 'running' | 'succeeded' | 'failed'; log: string }
const runs = new Map<string, Run>()
/** Actions that spend money on Replicate: one at a time per job. The rest (creating a take, approving, notes) are instant and always allowed. */
const PAID_ACTIONS = ['directions', 'samples', 'clip', 'full', 'rerender']
const paidRun = (job: string) => Array.from(runs.values()).find((r) => r.job === job && r.status === 'running' && PAID_ACTIONS.includes(r.action))

/** Pipeline env from its .env, applied over the dev server's own, so the shell's tokens never win. */
function pipelineEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const file = path.join(PIPELINE_DIR, '.env')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
  return env
}

function jobDir(job: string): string {
  if (!/^[\w-]+$/.test(job) || job === 'spikes') throw new Error(`Bad job name "${job}"`)
  const dir = path.join(JOBS_DIR, job)
  if (!existsSync(path.join(dir, 'job.json'))) throw new Error(`No job "${job}"`)
  return dir
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function listJobs() {
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'spikes' && existsSync(path.join(JOBS_DIR, d.name, 'job.json')))
    .map((d) => d.name)
}

/** Where a take's frames, check.json and review.json live: the take folder for the full song, preview/dream for its 15s clip. */
function checkDir(job: string, take: string, clip: boolean): string {
  if (!/^[\w-]+$/.test(take) || take.startsWith('_')) throw new Error('bad take')
  return path.join(jobDir(job), '7-dreams', take, clip ? 'preview/dream' : '')
}

type CheckFile = { threshold: number; frames: number; flagged: number; stretches: { start: number; end: number; frames: number; peak: number }[]; scores: Record<string, number> }
type Review = { keep: number[] }

function readReview(dir: string): Review {
  const file = path.join(dir, 'review.json')
  return existsSync(file) ? (readJson(file) as Review) : { keep: [] }
}

/** A take's person check, summarised for the list: null if it has frames but was never checked. Stretches the reviewer marked "keep" don't count. */
function checkSummary(dir: string) {
  if (!existsSync(path.join(dir, 'frames'))) return undefined
  const file = path.join(dir, 'check.json')
  if (!existsSync(file)) return null
  const check = readJson(file) as CheckFile
  const keep = new Set(readReview(dir).keep)
  const open = check.stretches.filter((s) => !keep.has(s.start))
  return { frames: check.frames, flagged: open.reduce((sum, s) => sum + s.frames, 0), stretches: open.length }
}

/** Everything the review needs for one take: its dream frames (each with the job frames holding it), scores, and flagged stretches. */
function checkDetail(job: string, take: string, clip: boolean) {
  const dir = checkDir(job, take, clip)
  const framesDir = path.join(dir, 'frames')
  if (!existsSync(framesDir)) throw new Error(`"${take}" has no dream frames yet`)
  // A dream frame is held over several job frames as hard links to one file; list each once.
  const seen = new Set<number>()
  const frames: number[] = []
  for (const name of readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort()) {
    const { ino } = statSync(path.join(framesDir, name))
    if (seen.has(ino)) continue
    seen.add(ino)
    frames.push(Number(name.slice(0, 4)))
  }
  const file = path.join(dir, 'check.json')
  const check = existsSync(file) ? (readJson(file) as CheckFile) : null
  const replacedDir = path.join(dir, 'replaced')
  return {
    frames,
    check,
    keep: readReview(dir).keep,
    replaced: existsSync(replacedDir) ? readdirSync(replacedDir).map((f) => Number(f.slice(0, 4))) : [],
  }
}

function jobDetail(job: string) {
  const dir = jobDir(job)
  const dreams = path.join(dir, '7-dreams')
  const takes = existsSync(dreams)
    ? readdirSync(dreams, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(path.join(dreams, d.name, 'take.json')))
        .map((d) => {
          const take = path.join(dreams, d.name)
          const samplesDir = path.join(take, 'samples')
          return {
            id: d.name,
            ...(readJson(path.join(take, 'take.json')) as object),
            samples: existsSync(samplesDir) ? readdirSync(samplesDir).filter((f) => f.endsWith('.jpg')).map((f) => Number(f.slice(0, 4))) : [],
            hasPreview: existsSync(path.join(take, 'preview', 'video.mov')),
            clipCheck: checkSummary(path.join(take, 'preview', 'dream')),
            modified: statSync(path.join(take, 'take.json')).mtimeMs,
          }
        })
        .sort((a, b) => b.modified - a.modified)
    : []
  const directionsDir = path.join(dreams, '_directions')
  const directions = existsSync(directionsDir)
    ? readdirSync(directionsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .map((file) => ({ file, ...(readJson(path.join(directionsDir, file)) as object) }))
    : []
  // Every dream with a full song's frames, published ones included (those have no take.json), for the person check.
  const presets = existsSync(DEFORUM_PRESETS) ? (readJson(DEFORUM_PRESETS) as Record<string, { title: string }>) : {}
  const songs = existsSync(dreams)
    ? readdirSync(dreams, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(path.join(dreams, d.name, 'frames')))
        // A rejected take's frames are leftovers, not a dream anyone will publish.
        .filter((d) => takes.find((t) => t.id === d.name)?.status !== 'rejected')
        .map((d) => ({
          id: d.name,
          title: presets[d.name]?.title ?? d.name,
          published: !existsSync(path.join(dreams, d.name, 'take.json')),
          check: checkSummary(path.join(dreams, d.name)) ?? null,
        }))
    : []
  // The paid run in progress, if any, so a reloaded page can pick its progress back up.
  const active = paidRun(job)
  const running = active ? { id: active.id, take: active.take, action: active.action, started: active.started } : null
  return { name: job, config: readJson(path.join(dir, 'job.json')), takes, songs, directions, running }
}

/** The pipeline command for an admin action. Each one is a stage of the loop; the pipeline enforces the approval order itself. */
function actionArgs(job: string, body: Record<string, unknown>): string[] {
  const take = String(body.take ?? '')
  const takeOk = /^[\w-]+$/.test(take)
  const base = ['--job', `.jobs/${job}`]
  switch (body.action) {
    case 'directions':
      if (!body.brief) throw new Error('brief is required')
      return ['dream-directions', ...base, '--brief', String(body.brief), ...(body.count ? ['--count', String(body.count)] : [])]
    case 'take':
      if (!takeOk) throw new Error('take name: letters, numbers, - and _ only')
      if (body.method === 'deforum') {
        if (!body.prompt) throw new Error('prompt is required')
        if (body.colour && !/^[\w.-]+\.(png|jpe?g)$/i.test(String(body.colour))) throw new Error('bad colour reference')
        if (body.preset && !/^[\w-]+$/.test(String(body.preset))) throw new Error('bad preset')
        return [
          'dream-take', ...base, '--take', take, '--method', 'deforum', '--prompt', String(body.prompt),
          ...(body.colour ? ['--colour', String(body.colour)] : []),
          ...(body.preset ? ['--preset', String(body.preset)] : []),
          ...(body.negative ? ['--negative', String(body.negative)] : []),
          ...(body.seed ? ['--seed', String(body.seed)] : []),
        ]
      }
      if (body.directions) {
        if (!/^[\w.-]+\.json$/.test(String(body.directions))) throw new Error('bad directions file')
        return ['dream-take', ...base, '--take', take, '--directions', String(body.directions), '--index', String(body.index ?? 0)]
      }
      if (!body.prompt) throw new Error('prompt or directions is required')
      return ['dream-take', ...base, '--take', take, '--prompt', String(body.prompt)]
    case 'samples':
      if (!takeOk) throw new Error('bad take')
      return ['dream-samples', ...base, '--take', take]
    case 'clip':
      if (!takeOk) throw new Error('bad take')
      return ['dream-clip', ...base, '--take', take]
    case 'full':
      // The whole song. Publishing to the client (which edits dreams.json) stays a separate, deliberate `compose`.
      if (!takeOk) throw new Error('bad take')
      return ['dream', ...base, '--take', take, '--skip-client', 'true']
    case 'check':
      // The person check: local and free.
      if (!takeOk) throw new Error('bad take')
      return ['dream-check', ...base, '--take', take, ...(body.clip ? ['--clip', 'true'] : [])]
    case 'rerender':
    case 'hold':
      // Replace dream frames that show a person: re-rendered on Replicate (paid), or the frame before held (free).
      if (!takeOk) throw new Error('bad take')
      if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(String(body.frames))) throw new Error('frames: e.g. 1735,934-936')
      return ['dream-repair', ...base, '--take', take, '--frames', String(body.frames), '--action', String(body.action), '--confirm', 'true', ...(body.clip ? ['--clip', 'true'] : [])]
    case 'status':
      if (!takeOk) throw new Error('bad take')
      return [
        'take-status',
        ...base,
        '--take',
        take,
        ...(body.status ? ['--status', String(body.status)] : []),
        ...(body.notes !== undefined ? ['--notes', String(body.notes)] : []),
      ]
    default:
      throw new Error(`Unknown action "${String(body.action)}"`)
  }
}

function startRun(job: string, body: Record<string, unknown>): Run {
  const args = actionArgs(job, body)
  const action = String(body.action)
  if (PAID_ACTIONS.includes(action) && paidRun(job)) throw new Error('Something is already generating for this footage; wait for it to finish.')
  // A check or hold rewrites the same frames/, replaced/ and check.json a paid run is writing.
  if ((action === 'check' || action === 'hold') && paidRun(job)) throw new Error('Wait for the current generation on this footage to finish first.')
  const run: Run = { id: `${Date.now()}-${runs.size}`, job, action, take: String(body.take ?? ''), started: Date.now(), args, status: 'running', log: `$ ${args.join(' ')}\n` }
  runs.set(run.id, run)
  const child = spawn('bun', ['run', 'src/cli.ts', ...args], { cwd: PIPELINE_DIR, env: pipelineEnv() })
  child.stdout.on('data', (d) => (run.log += d))
  child.stderr.on('data', (d) => (run.log += d))
  child.on('close', (code) => (run.status = code === 0 ? 'succeeded' : 'failed'))
  return run
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > MAX_COLOUR_UPLOAD * 1.5) throw new Error('request body too large')
  }
  const parsed: unknown = data ? JSON.parse(data) : {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed as Record<string, unknown>
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function serveFile(res: ServerResponse, job: string, rel: string) {
  const dir = jobDir(job)
  const file = path.resolve(dir, rel)
  if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' })
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-cache')
  createReadStream(file).pipe(res)
}

export default function adminPlugin(): Plugin {
  return {
    name: 'lysterfield-admin',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__admin', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          // POSTs here run the pipeline, which spends money, so only this dev server's own pages may
          // send them: a page on any other origin in the same browser is refused.
          if (req.method === 'POST') {
            const origin = req.headers.origin
            if (!origin || new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin request refused' })
          }
          const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
          if (parts[0] === 'files' && parts.length > 2) return serveFile(res, parts[1], parts.slice(2).join('/'))
          if (parts[0] === 'colours' && parts[1]) {
            const file = path.join(COLOURS_DIR, path.basename(parts[1]))
            if (!existsSync(file)) return send(res, 404, { error: 'not found' })
            res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'image/jpeg')
            return createReadStream(file).pipe(res)
          }
          if (parts[0] !== 'api') return send(res, 404, { error: 'not found' })
          if (parts[1] === 'deforum' && req.method === 'GET') {
            return send(res, 200, {
              presets: existsSync(DEFORUM_PRESETS) ? readJson(DEFORUM_PRESETS) : {},
              colours: existsSync(COLOURS_DIR) ? readdirSync(COLOURS_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [],
            })
          }
          if (parts[1] === 'colours' && req.method === 'POST') {
            // A new colour reference: { name, data } with data as base64.
            const body = await readBody(req)
            const { name, data } = body
            if (typeof name !== 'string' || !/^[\w.-]+\.(png|jpe?g)$/i.test(name)) throw new Error('name must be a .png or .jpg file name')
            if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new Error('data must be base64')
            if (data.length > MAX_COLOUR_UPLOAD * 1.4) throw new Error('colour reference is too large (max 20MB)')
            mkdirSync(COLOURS_DIR, { recursive: true })
            const file = path.join(COLOURS_DIR, name)
            if (existsSync(file)) throw new Error(`${name} already exists`)
            writeFileSync(file, Buffer.from(data, 'base64'))
            return send(res, 200, { name })
          }
          if (parts[1] === 'jobs' && parts.length === 2) return send(res, 200, listJobs())
          if (parts[1] === 'jobs' && parts.length === 3 && req.method === 'GET') return send(res, 200, jobDetail(parts[2]))
          if (parts[1] === 'jobs' && parts[3] === 'checks' && parts[4] && req.method === 'GET') {
            return send(res, 200, checkDetail(parts[2], parts[4], url.searchParams.get('clip') === 'true'))
          }
          if (parts[1] === 'jobs' && parts[3] === 'checks' && parts[4] && req.method === 'POST') {
            // The reviewer's "keep" decisions: flagged stretches (by first frame) that are fine as they are.
            const body = await readBody(req)
            const keep = body.keep
            if (!Array.isArray(keep) || !keep.every((k) => Number.isInteger(k))) throw new Error('keep must be a list of frame numbers')
            writeFileSync(path.join(checkDir(parts[2], parts[4], body.clip === true), 'review.json'), `${JSON.stringify({ keep }, null, 2)}\n`)
            return send(res, 200, { keep })
          }
          if (parts[1] === 'jobs' && parts[3] === 'actions' && req.method === 'POST') {
            jobDir(parts[2])
            const run = startRun(parts[2], await readBody(req))
            return send(res, 200, { runId: run.id })
          }
          if (parts[1] === 'runs' && parts[2]) {
            const run = runs.get(parts[2])
            return run ? send(res, 200, run) : send(res, 404, { error: 'no such run' })
          }
          return send(res, 404, { error: 'not found' })
        } catch (error) {
          return send(res, 400, { error: (error as Error).message })
        }
      })
    },
  }
}
