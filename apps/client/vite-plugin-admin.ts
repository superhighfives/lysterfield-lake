import { execFile, execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'
import { createQueue } from './admin-queue.ts'

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
/** Webcam clips from /admin/record (plans/in-progress/polaroids.md), kept apart from the jobs made from them. */
const RECORDINGS_DIR = path.join(JOBS_DIR, '_recordings')
const MAX_RECORDING_UPLOAD = 150 * 1024 * 1024
const DEFORUM_PRESETS = path.resolve(PIPELINE_DIR, '..', '..', 'models', 'deforum', 'settings', 'presets.json')

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mov': 'video/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
}

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

function listJobs(kind?: 'polaroid') {
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'spikes' && existsSync(path.join(JOBS_DIR, d.name, 'job.json')))
    .map((d) => d.name)
    .filter((name) => (readJson(path.join(JOBS_DIR, name, 'job.json')) as { kind?: string }).kind === kind)
}

const countFrames = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.(png|jpg)$/.test(f)).length : 0)

/**
 * Moderation, in job.json's `review`: a new recording is `submitted`; `approved` lets it be made (the paid
 * stages refuse anything else); once made, `shown` approves it for showing; `rejected` stops it anywhere.
 */
type PolaroidReview = 'submitted' | 'approved' | 'shown' | 'rejected'
const REVIEW_MOVES: Record<string, { from: PolaroidReview[]; to: PolaroidReview; needsMade?: boolean }> = {
  approve: { from: ['submitted'], to: 'approved' },
  show: { from: ['approved'], to: 'shown', needsMade: true },
  hide: { from: ['shown'], to: 'approved' },
  reject: { from: ['submitted', 'approved', 'shown'], to: 'rejected' },
  reopen: { from: ['rejected'], to: 'submitted' },
}

function reviewOf(job: string): PolaroidReview {
  return (readJson(path.join(jobDir(job), 'job.json')) as { review?: PolaroidReview }).review ?? 'submitted'
}

function setPolaroidReview(job: string, decision: string) {
  const move = REVIEW_MOVES[decision]
  if (!move) throw new Error(`Unknown decision "${decision}"`)
  const current = reviewOf(job)
  if (!move.from.includes(current)) throw new Error(`Can't ${decision} a polaroid that's ${current}`)
  if (move.needsMade && !polaroidDetail(job, false).stages.atlas.done) throw new Error('Make it before approving it to show')
  // Rejecting stops anything still waiting to run; a run already started has to be stopped from the task list.
  if (move.to === 'rejected') for (const task of tasks().activeFor(job, 'polaroid')) if (task.status === 'queued') tasks().cancel(task.id)
  const file = path.join(jobDir(job), 'job.json')
  writeFileSync(file, `${JSON.stringify({ ...(readJson(file) as object), review: move.to }, null, 2)}\n`)
  return { review: move.to }
}

/** Deletes a polaroid outright: its job folder (every panel, the atlas, the loop) and its original recording. */
function deletePolaroid(job: string) {
  const dir = jobDir(job)
  if ((readJson(path.join(dir, 'job.json')) as { kind?: string }).kind !== 'polaroid') throw new Error(`"${job}" isn't a polaroid`)
  const active = tasks().activeFor(job, 'polaroid')
  if (active.some((t) => t.status === 'running')) throw new Error('Something is running for it; stop it first')
  for (const task of active) tasks().cancel(task.id)
  rmSync(dir, { recursive: true, force: true })
  if (existsSync(RECORDINGS_DIR)) for (const f of readdirSync(RECORDINGS_DIR).filter((f) => path.parse(f).name === job)) rmSync(path.join(RECORDINGS_DIR, f))
}

/**
 * A polaroid job's stages (plans/done/polaroid-admin-flow.md), each read from the files on disk: panels 2, 4, 5
 * and 6 from the polaroid model, panel 3 from Bria, then the atlas and the flattened loop. `withCost` adds
 * what the paid stages would cost to run now, from `polaroid-run --plan` (which knows what's already done), with
 * the panels priced where `on` says they'll run.
 */
function polaroidDetail(job: string, withCost: boolean, on?: string) {
  const dir = jobDir(job)
  const config = readJson(path.join(dir, 'job.json')) as { fps: number; review?: PolaroidReview }
  const frames = countFrames(path.join(dir, '0-source/frames'))
  const panels = Math.min(...['2-portrait/upscaled', '4-matte/frames', '5-depth/frames', '6-outline/frames'].map((d) => countFrames(path.join(dir, d))))
  const background = countFrames(path.join(dir, '3-background/frames'))
  const stages = {
    panels: { done: frames > 0 && panels >= frames, frames: panels },
    background: { done: frames > 0 && background >= frames, frames: background },
    atlas: { done: existsSync(path.join(dir, 'polaroid', 'atlas.mp4')) && existsSync(path.join(dir, 'polaroid', 'loop.mp4')) },
  }
  let cost: { panels: string; background: string } | undefined
  if (withCost) {
    const plan = execFileSync('bun', ['run', 'src/cli.ts', 'polaroid-run', '--job', `.jobs/${job}`, '--plan', 'true', ...runOn({ on })], { cwd: PIPELINE_DIR, env: pipelineEnv(), encoding: 'utf8' })
    const estimate = (key: string) => plan.match(new RegExp(`"${key}": "(\\$[\\d.]+)"`))?.[1] ?? '?'
    cost = { panels: stages.panels.done ? '$0.00' : estimate('estimatedCost'), background: stages.background.done ? '$0.00' : estimate('backgroundCost') }
  }
  return { name: job, frames, fps: config.fps, review: config.review ?? 'submitted', stages, cost }
}

/** Where a take's frames, check.json and review.json live: the take folder for the full song, preview/dream for its 15s clip. */
function checkDir(job: string, take: string, clip: boolean): string {
  if (!/^[\w-]+$/.test(take) || take.startsWith('_')) throw new Error('bad take')
  return path.join(jobDir(job), '7-dreams', take, clip ? 'preview/dream' : '')
}

type CheckFile = {
  threshold: number
  faceThreshold?: number
  frames: number
  flagged: number
  stretches: { start: number; end: number; frames: number; peak: number; facePeak?: number }[]
  scores: Record<string, number>
  /** Face scores (models/face-check), absent in checks from before it. */
  faces?: Record<string, number>
}
type Review = { keep: number[] }

function readReview(dir: string): Review {
  const file = path.join(dir, 'review.json')
  return existsSync(file) ? (readJson(file) as Review) : { keep: [] }
}

/** Frames a finished re-render made (repairs/<first>-<last>/applied), as ranges. */
function rerenderedRanges(dir: string): [number, number][] {
  const repairsDir = path.join(dir, 'repairs')
  if (!existsSync(repairsDir)) return []
  return readdirSync(repairsDir)
    .filter((d) => /^\d{4}-\d{4}$/.test(d) && existsSync(path.join(repairsDir, d, 'applied')))
    .map((d) => d.split('-').map(Number) as [number, number])
}

/**
 * The published dreams' 2023 RIFE morphs still to replace (morphs.json, from scripts/legacy-morphs.ts):
 * every morph frame not yet re-rendered or held. Those frames were interpolated between real frames
 * in 2023, which loses the stop-motion look, so all of them get replaced, person or not.
 */
function outstandingMorphs(dir: string): number[] {
  const file = path.join(dir, 'morphs.json')
  if (!existsSync(file)) return []
  const done = rerenderedRanges(dir)
  const replacedDir = path.join(dir, 'replaced')
  const held = new Set(existsSync(replacedDir) ? readdirSync(replacedDir).map((f) => Number(f.slice(0, 4))) : [])
  return (readJson(file) as { frames: number[] }).frames.filter((f) => !held.has(f) && !done.some(([a, b]) => f >= a && f <= b))
}

/**
 * A take's person check, summarised for the list: null if it has frames but was never checked.
 * People and 2023 morphs are counted apart: a flagged frame that is also a morph counts as a morph,
 * since it gets replaced either way. Stretches the reviewer marked "keep" don't count.
 */
function checkSummary(dir: string) {
  if (!existsSync(path.join(dir, 'frames'))) return undefined
  const morphs = outstandingMorphs(dir)
  const file = path.join(dir, 'check.json')
  if (!existsSync(file)) return morphs.length > 0 ? { frames: 0, flagged: 0, stretches: 0, morphs: morphs.length, checked: false } : null
  const check = readJson(file) as CheckFile
  const keep = new Set(readReview(dir).keep)
  const morphSet = new Set(morphs)
  const open = check.stretches.filter((s) => !keep.has(s.start))
  // Frames flagged as a person that aren't morphs (a flagged morph is replaced with the morphs anyway), and the
  // stretches they're in. A stretch can hold both; the review marks each frame.
  // Flagged by either score, as in dream-check.ts's isFlagged.
  const flagged = (key: string) => check.scores[key] > check.threshold || (check.faces?.[key] ?? 0) > (check.faceThreshold ?? 0.5)
  const people = Object.keys(check.scores)
    .filter(flagged)
    .map(Number)
    .filter((frame) => !morphSet.has(frame) && open.some((s) => frame >= s.start && frame <= s.end))
    .map((frame) => ({ frame }))
  const peopleStretches = open.filter((s) => people.some(({ frame }) => frame >= s.start && frame <= s.end))
  return { frames: check.frames, flagged: people.length, stretches: peopleStretches.length, morphs: morphs.length, checked: true }
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
  // Frames a finished re-render made (repairs/<first>-<last>/applied), so the review can say when one still shows a person.
  const rerendered = rerenderedRanges(dir).flatMap(([start, end]) => frames.filter((f) => f >= start && f <= end))
  // Only morphs that are still dream frames of their own (a hold folds a frame into the one before).
  const own = new Set(frames)
  return {
    morphs: outstandingMorphs(dir).filter((f) => own.has(f)),
    rerendered,
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
            hasSong: existsSync(path.join(take, 'split', 'dream.mp4')),
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
        .filter((d) => (takes.find((t) => t.id === d.name) as { status?: string } | undefined)?.status !== 'rejected')
        .map((d) => ({
          id: d.name,
          title: presets[d.name]?.title ?? d.name,
          published: !existsSync(path.join(dreams, d.name, 'take.json')),
          check: checkSummary(path.join(dreams, d.name)) ?? null,
        }))
    : []
  return { name: job, config: readJson(path.join(dir, 'job.json')), takes, songs, directions }
}

/**
 * Where a GPU job runs: our own GPU (the 4090 PC, DEFORUM_URL or POLAROID_URL in the pipeline's .env) or Replicate.
 * Unsaid, the pipeline decides.
 */
function runOn(body: Record<string, unknown>): string[] {
  return body.on === 'pc' || body.on === 'replicate' ? ['--on', body.on] : []
}

/** One of our own GPU servers, if it's set up: whether it's up (Cog's health check). Deforum's, or the polaroid model's. */
async function gpuStatus(variable: 'DEFORUM_URL' | 'POLAROID_URL') {
  const url = pipelineEnv()[variable]?.replace(/\/+$/, '')
  if (!url) return { configured: false }
  try {
    const response = await fetch(`${url}/health-check`, { signal: AbortSignal.timeout(4000) })
    const { status } = (await response.json()) as { status?: string }
    return { configured: true, status: status ?? 'unknown' }
  } catch {
    // Deliberate: a timeout, a bad URL, or a reply that isn't JSON all mean the same to the status dot.
    return { configured: true, status: 'offline' }
  }
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
        if (!body.prompt && !body.style) throw new Error('a prompt, or a style image, is required')
        if (body.colour && !/^[\w.-]+\.(png|jpe?g)$/i.test(String(body.colour))) throw new Error('bad colour reference')
        if (body.style && !/^[\w.-]+\.(png|jpe?g)$/i.test(String(body.style))) throw new Error('bad style reference')
        if (body.styleStrength !== undefined && !(Number(body.styleStrength) >= 0 && Number(body.styleStrength) <= 1.5)) throw new Error('style strength must be 0 to 1.5')
        if (body.preset && !/^[\w-]+$/.test(String(body.preset))) throw new Error('bad preset')
        return [
          'dream-take', ...base, '--take', take, '--method', 'deforum', '--prompt', String(body.prompt ?? ''),
          ...(body.colour ? ['--colour', String(body.colour)] : []),
          ...(body.style ? ['--style', String(body.style), '--style-strength', String(body.styleStrength ?? 1), '--style-copies', body.styleCopies === 'look-and-content' ? 'look-and-content' : 'look'] : []),
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
      return ['dream-samples', ...base, '--take', take, ...runOn(body)]
    case 'clip':
      if (!takeOk) throw new Error('bad take')
      return ['dream-clip', ...base, '--take', take, ...runOn(body)]
    case 'full':
      // The whole song. Publishing to the client (which edits dreams.json) stays a separate, deliberate `compose`.
      if (!takeOk) throw new Error('bad take')
      return ['dream', ...base, '--take', take, '--skip-client', 'true', ...runOn(body)]
    case 'check':
      // The person check: local and free.
      if (!takeOk) throw new Error('bad take')
      return ['dream-check', ...base, '--take', take, ...(body.clip ? ['--clip', 'true'] : [])]
    case 'rerender':
    case 'hold':
    case 'restore':
      // Replace dream frames that show a person: re-rendered on Replicate (paid), or the frame before held (free); or undo that (restore, free).
      if (!takeOk) throw new Error('bad take')
      if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(String(body.frames))) throw new Error('frames: e.g. 1735,934-936')
      return ['dream-repair', ...base, '--take', take, '--frames', String(body.frames), '--action', String(body.action), '--confirm', 'true', ...(body.clip ? ['--clip', 'true'] : []), ...(body.again === true ? ['--again', String(Date.now())] : []), ...runOn(body)]
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
    // A polaroid's stages (plans/done/polaroid-admin-flow.md). Panels 2, 4, 5 and 6 run where the page says: the
    // 4090 (POLAROID_URL, free) or Replicate. The background is Bria, always on Replicate.
    case 'polaroid-panels':
    case 'polaroid-background':
    case 'polaroid-atlas':
      // Nothing is made, and nothing spent, until a person has approved it.
      if (reviewOf(job) !== 'approved') throw new Error(`Approve it to make before running anything (it's ${reviewOf(job)})`)
      return body.action === 'polaroid-panels' ? ['polaroid-run', ...base, ...runOn(body)] : body.action === 'polaroid-background' ? ['background-video', ...base] : ['polaroid', ...base]
    default:
      throw new Error(`Unknown action "${String(body.action)}"`)
  }
}

/**
 * Deletes a take that hasn't made anything yet: no samples, clip, frames or final output, so nothing is lost but its
 * settings. Waiting tasks for it are cancelled first; one that is running has to be stopped before.
 * A take with output, or a published dream (no take.json), is refused.
 */
function deleteTake(job: string, take: string) {
  const dir = checkDir(job, take, false)
  if (!existsSync(path.join(dir, 'take.json'))) throw new Error(`"${take}" isn't a take that can be deleted`)
  const made = ['samples', 'frames', 'preview', 'repairs', 'final'].filter((sub) => existsSync(path.join(dir, sub)) && readdirSync(path.join(dir, sub)).length > 0)
  if (made.length > 0) throw new Error(`"${take}" already has ${made.join(', ')}; only a take that hasn't run can be deleted`)
  const active = tasks().activeFor(job, take)
  if (active.some((t) => t.status === 'running')) throw new Error(`Something is running for "${take}"; stop it first`)
  for (const task of active) tasks().cancel(task.id)
  rmSync(dir, { recursive: true })
}

/**
 * Saves a webcam recording and makes a new job from it with the pipeline's own `init` (crop to a square, 1280px,
 * frames at 24fps). `init` makes no Replicate calls, so it runs straight away rather than through the queue.
 */
async function createRecordingJob(body: Record<string, unknown>): Promise<{ job: string }> {
  const { name, data, type, crop } = body
  if (typeof name !== 'string' || !/^[a-z0-9][\w-]*$/.test(name) || name === 'spikes') throw new Error('name must be letters, numbers and dashes')
  if (existsSync(path.join(JOBS_DIR, name))) throw new Error(`There's already a job called "${name}"`)
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new Error('data must be base64')
  if (data.length > MAX_RECORDING_UPLOAD * 1.4) throw new Error('recording is too large (max 150MB)')
  // MediaRecorder writes mp4 or webm; a chosen file may also be a phone's .mov. ffmpeg reads all three.
  const ext = typeof type !== 'string' ? 'webm' : type.startsWith('video/mp4') ? 'mp4' : type.startsWith('video/quicktime') ? 'mov' : 'webm'
  // The square picked on the page: { x, y, zoom }, as init's --crop takes it. init checks the ranges.
  const cropArgs: string[] = []
  if (crop !== undefined) {
    const { x, y, zoom } = (crop ?? {}) as Record<string, unknown>
    if (![x, y, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error('crop must be { x, y, zoom }')
    cropArgs.push('--crop', `${x},${y},${zoom}`)
  }
  mkdirSync(RECORDINGS_DIR, { recursive: true })
  // The real path: .jobs is a symlink in a worktree, and job.json records where the source came from.
  const source = path.join(realpathSync(RECORDINGS_DIR), `${name}.${ext}`)
  writeFileSync(source, Buffer.from(data, 'base64'))
  try {
    await promisify(execFile)('bun', ['run', 'src/cli.ts', 'init', '--job', path.join(JOBS_DIR, name), '--source', source, '--length', '5', '--kind', 'polaroid', ...cropArgs], { cwd: PIPELINE_DIR, env: pipelineEnv() })
  } catch (error) {
    throw new Error(`init failed: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`)
  }
  return { job: name }
}

/** Every pipeline command the page starts goes through the queue (admin-queue.ts). Made on first use, so nothing touches .jobs until the admin API is called. */
let queue: ReturnType<typeof createQueue> | undefined
const tasks = () => (queue ??= createQueue({ dir: path.join(JOBS_DIR, '_queue'), cwd: PIPELINE_DIR, env: pipelineEnv }))

async function readBody(req: IncomingMessage, limit = MAX_COLOUR_UPLOAD): Promise<Record<string, unknown>> {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > limit * 1.5) throw new Error('request body too large')
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

function serveFile(req: IncomingMessage, res: ServerResponse, job: string, rel: string) {
  const dir = jobDir(job)
  const file = path.resolve(dir, rel)
  if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' })
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Accept-Ranges', 'bytes')
  // Videos ask for byte ranges to seek (Safari won't play one without them).
  const size = statSync(file).size
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.setHeader('Content-Length', size)
  createReadStream(file).pipe(res)
}

export default function adminPlugin(): Plugin {
  return {
    name: 'lysterfield-admin',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.on('close', () => {
        queue?.close()
        queue = undefined
      })
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
          if (parts[0] === 'files' && parts.length > 2) return serveFile(req, res, parts[1], parts.slice(2).join('/'))
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
          if (parts[1] === 'gpu' && req.method === 'GET') return send(res, 200, await gpuStatus(url.searchParams.get('for') === 'polaroid' ? 'POLAROID_URL' : 'DEFORUM_URL'))
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
          // Polaroid jobs, newest first, and one job's stages with what the paid ones would cost, for /admin/polaroid.
          if (parts[1] === 'polaroids' && parts.length === 2 && req.method === 'GET') {
            const created = (j: string) => statSync(path.join(JOBS_DIR, j, 'job.json')).birthtimeMs
            return send(res, 200, listJobs('polaroid').sort((a, b) => created(b) - created(a)).map((j) => polaroidDetail(j, false)))
          }
          if (parts[1] === 'polaroids' && parts[2] && !parts[3] && req.method === 'GET') return send(res, 200, polaroidDetail(parts[2], true, url.searchParams.get('on') ?? undefined))
          if (parts[1] === 'polaroids' && parts[2] && parts[3] === 'review' && req.method === 'POST') return send(res, 200, setPolaroidReview(parts[2], String((await readBody(req)).decision)))
          if (parts[1] === 'polaroids' && parts[2] && parts[3] === 'delete' && req.method === 'POST') {
            deletePolaroid(parts[2])
            return send(res, 200, {})
          }
          if (parts[1] === 'recordings' && req.method === 'POST') return send(res, 200, await createRecordingJob(await readBody(req, MAX_RECORDING_UPLOAD)))
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
            const body = await readBody(req)
            const task = tasks().add(parts[2], body, actionArgs(parts[2], body))
            return send(res, 200, { runId: task.id })
          }
          if (parts[1] === 'runs' && parts[2]) {
            const task = tasks().get(parts[2])
            return task ? send(res, 200, task) : send(res, 404, { error: 'no such task' })
          }
          if (parts[1] === 'jobs' && parts[3] === 'tasks' && req.method === 'GET') return send(res, 200, tasks().list(parts[2]))
          if (parts[1] === 'jobs' && parts[3] === 'tasks' && parts[4] === 'clear' && req.method === 'POST') {
            tasks().clear(parts[2])
            return send(res, 200, {})
          }
          if (parts[1] === 'tasks' && parts[3] === 'retry' && req.method === 'POST') {
            const task = tasks().retry(parts[2])
            return task ? send(res, 200, { runId: task.id }) : send(res, 400, { error: 'Only a failed or stopped task can be retried, and only once' })
          }
          if (parts[1] === 'jobs' && parts[3] === 'takes' && parts[4] && parts[5] === 'delete' && req.method === 'POST') {
            deleteTake(parts[2], parts[4])
            return send(res, 200, {})
          }
          if (parts[1] === 'tasks' && parts[3] === 'cancel' && req.method === 'POST') {
            tasks().cancel(parts[2])
            return send(res, 200, {})
          }
          return send(res, 404, { error: 'not found' })
        } catch (error) {
          return send(res, 400, { error: (error as Error).message })
        }
      })
    },
  }
}
