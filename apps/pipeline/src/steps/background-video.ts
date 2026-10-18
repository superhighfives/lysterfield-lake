import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { exists, framesDir, hasFiles, listFrames, siblingFramePath, type Job } from '../job.ts'
import { dilate } from '../mask.ts'
import { MODELS } from '../models.ts'
import { checkPublicUploads, deletePublic, uploadPublic } from '../r2.ts'
import { runModelToFileResumable } from '../replicate.ts'

/** Bria's limits: clips of at most 5s, at most 750p. */
const MAX_SECONDS = 5
const INPUT_SIZE = 720
/** Neighbouring chunks share at least this much, crossfaded across all of it. */
const MIN_OVERLAP_SECONDS = 1
/**
 * The mask for each frame is the union of the alphas this many frames
 * either side, then dilated, at `INPUT_SIZE`. With the raw alpha, arms that
 * moved faster than the matte followed left dark ghost arms in the sky
 * (full-video, ~frame 2023); ±2 frames and 24px fixed it.
 */
const MASK_WINDOW = 2
const MASK_DILATION_PX = 24
const COST_PER_SECOND = 0.05

/** One Bria call: frames `start` to `end` (1-based, inclusive), never crossing a cut. */
export interface Chunk {
  id: string
  start: number
  end: number
  /** The shot this chunk is in, so the mask's temporal window stops at the cut too. */
  segment: [number, number]
}

interface Plan {
  /** Random part of the R2 keys, so the public URLs can't be guessed. */
  uploadPrefix: string
  frames: number
  cuts: number[]
  chunks: Chunk[]
}

export interface BackgroundVideoResult {
  framesDir?: string
  chunks: number
  /** Chunks with no output yet, and what running them would cost. */
  toRun: string[]
  estimatedCost: string
  failed: { id: string; error: string }[]
  /** Free local checks on panel 2: frames unlike both neighbours, and likely cuts missing from job.json. */
  warnings: string[]
}

/**
 * Panel 3 from Bria's video object eraser instead of per-frame fill: panel 2
 * in overlapping 5s chunks with the person masked out, crossfaded back into
 * one sequence. The approach from `.jobs/full-video`
 * (plans/done/phase-4e-full-video-source-prep.md).
 *
 * Everything per chunk lives in `3-background/chunks/`: `plan.json`, each
 * chunk's inputs (`<id>-video.mp4`, `<id>-mask.mp4`), its prediction id and
 * its output (`<id>.mp4`). A chunk with an output is never run again; to
 * redo one, delete its `<id>.mp4` and `<id>.prediction.json`. The final
 * frames are blended from the chunk outputs every run, which is free.
 *
 * Bria reads its inputs from a public R2 bucket (r2.ts). They're uploaded
 * just before each chunk runs and deleted once it's done.
 *
 * Bria keeps whatever's in panel 2, so a stray frame there becomes a
 * glitch here. `planOnly` runs the free checks and prints the plan and cost
 * without spending anything.
 *
 * Untested against Bria and R2 (2026-10-16): full-video's panel 3 was made
 * by hand with the spike scripts, and this step is that same process. The
 * planning, masks, inputs and blend are tested (it reproduces full-video's
 * panel 3 from the spike's chunk outputs); the upload, the Bria call and
 * the delete haven't run yet. Try it first on a single chunk.
 */
export async function backgroundVideo(
  job: Job,
  portraitFramesDir: string,
  alphaFramesDir: string,
  outputName: string,
  opts: { concurrency?: number; planOnly?: boolean; only?: string[] } = {}
): Promise<BackgroundVideoResult> {
  const chunksDir = path.join(job.dir, '3-background/chunks')
  const outputDir = path.join(job.dir, outputName)
  const planPath = path.join(chunksDir, 'plan.json')
  // Don't blend over panel 3 frames that something else made (full-video's are the spike's, approved).
  if ((await hasFiles(outputDir)) && !(await exists(planPath))) {
    throw new Error(`${outputDir} already has frames this step didn't make. Move them aside first.`)
  }

  const frames = await listFrames(portraitFramesDir)
  frames.forEach((frame, i) => {
    if (path.basename(frame, path.extname(frame)) !== pad(i + 1)) {
      throw new Error(`${portraitFramesDir} isn't numbered 0001 onwards with no gaps (found ${frame} at position ${i + 1})`)
    }
  })
  const cuts = [...new Set(job.cuts ?? [])].sort((a, b) => a - b)
  const badCuts = cuts.filter((c) => !Number.isInteger(c) || c <= 1 || c > frames.length)
  if (badCuts.length > 0) throw new Error(`job.json cuts must be whole frame numbers from 2 to ${frames.length}, got ${badCuts.join(', ')}`)
  const plan = await loadOrCreatePlan(planPath, frames.length, job.fps, cuts, !opts.planOnly)

  const done = new Set(((await exists(chunksDir)) ? await readdir(chunksDir) : []).filter((f) => /^c\d+\.mp4$/.test(f)).map((f) => f.slice(0, -4)))
  const wanted = opts.only ?? plan.chunks.map((c) => c.id)
  const unknown = wanted.filter((id) => !plan.chunks.some((c) => c.id === id))
  if (unknown.length > 0) throw new Error(`No chunk ${unknown.join(', ')} in ${planPath}`)
  const toRun = plan.chunks.filter((c) => wanted.includes(c.id) && !done.has(c.id))
  const seconds = toRun.reduce((sum, c) => sum + (c.end - c.start + 1) / job.fps, 0)
  const warnings = await checkPortraitFrames(portraitFramesDir, frames, cuts)
  const result: BackgroundVideoResult = {
    chunks: plan.chunks.length,
    toRun: toRun.map((c) => c.id),
    estimatedCost: `$${(seconds * COST_PER_SECOND).toFixed(2)}`,
    failed: [],
    warnings,
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  if (opts.planOnly) return result

  if (toRun.length > 0) checkPublicUploads()
  console.log(`background-video: ${toRun.length} of ${plan.chunks.length} chunks to run, about ${result.estimatedCost}`)

  const queue = [...toRun]
  async function worker() {
    for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
      try {
        await runChunk(job, plan, chunk, chunksDir, portraitFramesDir, alphaFramesDir, frames)
        done.add(chunk.id)
        console.log(`${chunk.id}: done`)
      } catch (error) {
        // One attempt per chunk (CLAUDE.md): report it and carry on with the rest.
        const message = error instanceof Error ? error.message : String(error)
        console.log(`${chunk.id}: failed, ${message}`)
        result.failed.push({ id: chunk.id, error: message })
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker))
  result.toRun = plan.chunks.filter((c) => !done.has(c.id)).map((c) => c.id)

  if (result.toRun.length > 0) {
    console.log(`Not blending: no output yet for ${result.toRun.join(', ')}`)
    return result
  }
  const size = await sharp(path.join(portraitFramesDir, frames[0])).metadata()
  await blend(plan, chunksDir, await framesDir(job, outputName), size.width!, size.height!)
  return { ...result, framesDir: outputDir }
}

/**
 * Chunks of `MAX_SECONDS`, spaced evenly within each shot with at least
 * `MIN_OVERLAP_SECONDS` of overlap. A shot shorter than that is one chunk.
 */
export function planChunks(frameCount: number, fps: number, cuts: number[]): Chunk[] {
  const length = Math.floor(MAX_SECONDS * fps)
  const maxStride = length - Math.ceil(MIN_OVERLAP_SECONDS * fps)
  const starts = [1, ...cuts.filter((c) => c > 1 && c <= frameCount)]
  const chunks: Chunk[] = []
  starts.forEach((a, i) => {
    const b = (starts[i + 1] ?? frameCount + 1) - 1
    const segment: [number, number] = [a, b]
    const add = (start: number, end: number) => chunks.push({ id: `c${pad(chunks.length, 3)}`, start, end, segment })
    const span = b - a + 1 - length
    if (span <= 0) return add(a, b)
    const n = Math.ceil(span / maxStride) + 1
    for (let k = 0; k < n; k++) {
      const start = a + Math.round((span * k) / (n - 1))
      add(start, start + length - 1)
    }
  })
  return chunks
}

/**
 * The saved plan, so chunk ids keep meaning the same frames. If the frames
 * or cuts have changed since, it's planned again, unless a chunk has
 * already been run against the old plan.
 */
async function loadOrCreatePlan(planPath: string, frameCount: number, fps: number, cuts: number[], save: boolean): Promise<Plan> {
  const chunks = planChunks(frameCount, fps, cuts)
  if (await exists(planPath)) {
    const saved: Plan = JSON.parse(await readFile(planPath, 'utf8'))
    const started = (await readdir(path.dirname(planPath))).some((f) => /^c\d+(\.mp4|\.prediction\.json)$/.test(f))
    if (JSON.stringify(saved.chunks) === JSON.stringify(chunks)) return saved
    if (started) {
      throw new Error(
        `${planPath} was planned for ${saved.frames} frames with cuts [${saved.cuts}], now ${frameCount} with [${cuts}]. ` +
          `Its chunk outputs no longer line up; move 3-background/chunks aside to plan again.`
      )
    }
    // Inputs made for the old plan's chunks are stale. A plan-only run leaves them for the real run to clear.
    if (save) {
      for (const f of await readdir(path.dirname(planPath))) {
        if (/^c\d+-(video|mask)\.mp4$/.test(f)) await rm(path.join(path.dirname(planPath), f))
      }
    }
  }
  const plan: Plan = { uploadPrefix: randomUUID(), frames: frameCount, cuts, chunks }
  if (save) {
    await mkdir(path.dirname(planPath), { recursive: true })
    await writeFile(planPath, `${JSON.stringify(plan, null, 1)}\n`)
  }
  return plan
}

async function runChunk(
  job: Job,
  plan: Plan,
  chunk: Chunk,
  chunksDir: string,
  portraitFramesDir: string,
  alphaFramesDir: string,
  frames: string[]
): Promise<void> {
  const videoInput = path.join(chunksDir, `${chunk.id}-video.mp4`)
  const maskInput = path.join(chunksDir, `${chunk.id}-mask.mp4`)
  if (!(await exists(videoInput))) await encodeChunkVideo(job, chunk, portraitFramesDir, frames, videoInput)
  if (!(await exists(maskInput))) await encodeChunkMask(job, chunk, alphaFramesDir, frames, maskInput)

  // The same keys every run, so a run that died before deleting its inputs has them overwritten and deleted next time.
  const keys = [`${plan.uploadPrefix}/${chunk.id}-video.mp4`, `${plan.uploadPrefix}/${chunk.id}-mask.mp4`]
  try {
    const [videoUrl, maskUrl] = await Promise.all([
      uploadPublic(videoInput, keys[0], 'video/mp4'),
      uploadPublic(maskInput, keys[1], 'video/mp4'),
    ])
    await runModelToFileResumable(
      MODELS.backgroundVideo,
      { video_url: videoUrl, mask_url: maskUrl, preserve_audio: false, auto_trim: true },
      path.join(chunksDir, `${chunk.id}.mp4`),
      path.join(chunksDir, `${chunk.id}.prediction.json`)
    )
  } finally {
    // Reported, not thrown, so it can't hide the chunk's own error. A failed chunk's next run deletes them too,
    // but a chunk that succeeded is never run again, so its inputs stay public until deleted by hand.
    const deletes = await Promise.allSettled(keys.map(deletePublic))
    deletes.forEach((d, i) => {
      if (d.status === 'rejected') console.warn(`warning: couldn't delete ${keys[i]} from R2, it's still public: ${d.reason}`)
    })
  }
}

/** Panel 2's frames for `chunk`, at Bria's input size. */
async function encodeChunkVideo(job: Job, chunk: Chunk, dir: string, frames: string[], outputPath: string): Promise<void> {
  await encodeRaw(outputPath, job.fps, 'rgb24', async (write) => {
    for (let f = chunk.start; f <= chunk.end; f++) {
      await write(await sharp(path.join(dir, frames[f - 1])).resize(INPUT_SIZE, INPUT_SIZE).removeAlpha().raw().toBuffer())
    }
  })
}

/** White where Bria should erase: each frame's alpha unioned over ±`MASK_WINDOW` frames (within the shot), then dilated. */
async function encodeChunkMask(job: Job, chunk: Chunk, dir: string, frames: string[], outputPath: string): Promise<void> {
  const first = Math.max(chunk.segment[0], chunk.start - MASK_WINDOW)
  const last = Math.min(chunk.segment[1], chunk.end + MASK_WINDOW)
  const alphas = new Map<number, Buffer>()
  for (let f = first; f <= last; f++) {
    const alphaPath = await siblingFramePath(frames[f - 1], dir)
    alphas.set(f, await sharp(alphaPath).resize(INPUT_SIZE, INPUT_SIZE).greyscale().raw().toBuffer())
  }
  await encodeRaw(outputPath, job.fps, 'gray', async (write) => {
    for (let f = chunk.start; f <= chunk.end; f++) {
      const union = Buffer.alloc(INPUT_SIZE * INPUT_SIZE)
      for (let g = Math.max(first, f - MASK_WINDOW); g <= Math.min(last, f + MASK_WINDOW); g++) {
        const alpha = alphas.get(g)!
        for (let i = 0; i < union.length; i++) if (alpha[i] > 127) union[i] = 255
      }
      await write(dilate(union, INPUT_SIZE, MASK_DILATION_PX))
    }
  })
}

/** Pipes raw `INPUT_SIZE`² frames into a near-lossless H.264 file. */
async function encodeRaw(
  outputPath: string,
  fps: number,
  pixelFormat: 'rgb24' | 'gray',
  produce: (write: (frame: Buffer) => Promise<void>) => Promise<void>
): Promise<void> {
  const partPath = `${outputPath}.part.mp4`
  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pixelFormat, '-s', `${INPUT_SIZE}x${INPUT_SIZE}`, '-r', String(fps), '-i', '-',
      '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', partPath],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )
  let stderr = ''
  ffmpeg.stderr.on('data', (d) => (stderr += d))
  const closed = new Promise<number | null>((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', resolve)
  })
  await produce((frame) => new Promise((resolve, reject) => ffmpeg.stdin.write(frame, (e) => (e ? reject(e) : resolve()))))
  ffmpeg.stdin.end()
  const code = await closed
  if (code !== 0) throw new Error(`ffmpeg encoding ${path.basename(outputPath)} exited ${code}: ${stderr}`)
  // Renamed only once complete, so a half-written input is never mistaken for a finished one.
  await rename(partPath, outputPath)
}

/**
 * Joins the chunk outputs into `outputDir/NNNN.jpg` at panel size. A frame
 * in two chunks is a weighted mix, each weighted by its distance from that
 * chunk's nearest end: a linear crossfade across the whole overlap.
 * Chunks are decoded only while they're needed.
 */
async function blend(plan: Plan, chunksDir: string, outputDir: string, width: number, height: number): Promise<void> {
  const decodedDir = path.join(chunksDir, 'decoded')
  await rm(decodedDir, { recursive: true, force: true })
  const decoded = new Map<string, string[]>()

  async function framesOf(chunk: Chunk): Promise<string[]> {
    const cached = decoded.get(chunk.id)
    if (cached) return cached
    const dir = path.join(decodedDir, chunk.id)
    await mkdir(dir, { recursive: true })
    await run('ffmpeg', ['-v', 'error', '-i', path.join(chunksDir, `${chunk.id}.mp4`), '-vf', `scale=${width}:${height}:flags=lanczos`, path.join(dir, '%04d.png')])
    const paths = (await readdir(dir)).sort().map((f) => path.join(dir, f))
    const expected = chunk.end - chunk.start + 1
    if (paths.length < expected) throw new Error(`${chunk.id}.mp4 has ${paths.length} frames, expected ${expected}`)
    if (paths.length > expected) console.warn(`warning: ${chunk.id}.mp4 has ${paths.length} frames, expected ${expected}; using the first ${expected}`)
    decoded.set(chunk.id, paths)
    return paths
  }

  for (let f = 1; f <= plan.frames; f++) {
    const covering = plan.chunks.filter((c) => c.start <= f && f <= c.end)
    const out = path.join(outputDir, `${pad(f)}.jpg`)
    if (covering.length === 1) {
      const [chunk] = covering
      await sharp((await framesOf(chunk))[f - chunk.start]).jpeg({ quality: 92 }).toFile(out)
    } else {
      const weights = covering.map((c) => Math.min(f - c.start + 1, c.end - f + 1))
      const total = weights.reduce((a, b) => a + b, 0)
      const pixels = await Promise.all(covering.map(async (c) => sharp((await framesOf(c))[f - c.start]).removeAlpha().raw().toBuffer()))
      const mixed = Buffer.alloc(pixels[0].length)
      for (let i = 0; i < mixed.length; i++) {
        let v = 0
        for (let k = 0; k < pixels.length; k++) v += pixels[k][i] * weights[k]
        mixed[i] = Math.round(v / total)
      }
      await sharp(mixed, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toFile(out)
    }
    for (const [id] of decoded) {
      if (plan.chunks.find((c) => c.id === id)!.end <= f) {
        await rm(path.join(decodedDir, id), { recursive: true })
        decoded.delete(id)
      }
    }
  }
  await rm(decodedDir, { recursive: true, force: true })
}

const CHECK_SIZE = 64

/**
 * Free checks on panel 2 before anything is spent. Compares each frame with
 * the next at `CHECK_SIZE`px: a frame unlike both neighbours (whose
 * neighbours are like each other) is probably a stray, which Bria would
 * keep; a big jump that isn't listed in `cuts` is probably a cut, which a
 * chunk would blend across. A cut is one isolated jump; fast motion is a
 * run of big ones. On full-video the cut at 3770 was 0.17 with neighbours
 * under 0.01, while the fast arms around 2023 were 0.06-0.09 in a row.
 */
async function checkPortraitFrames(dir: string, frames: string[], cuts: number[]): Promise<string[]> {
  const small = await Promise.all(
    frames.map((f) => sharp(path.join(dir, f)).resize(CHECK_SIZE, CHECK_SIZE).greyscale().raw().toBuffer())
  )
  const diff = (a: Buffer, b: Buffer) => {
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
    return sum / a.length / 255
  }
  // step[i] is the change from frame i+1 to frame i+2 (1-based).
  const step = small.slice(1).map((s, i) => diff(small[i], s))
  if (step.length === 0) return []
  // The median, not mean and spread, so a short clip's one stray can't hide itself by raising the bar.
  const median = [...step].sort((a, b) => a - b)[Math.floor(step.length / 2)]
  const threshold = Math.max(0.05, 5 * median)

  const warnings: string[] = []
  const strays = new Set<number>()
  for (let i = 1; i < step.length; i++) {
    const frame = i + 1
    if (step[i - 1] > threshold && step[i] > threshold && diff(small[i - 1], small[i + 1]) < Math.min(step[i - 1], step[i]) / 4) {
      strays.add(frame)
      warnings.push(`panel 2 frame ${pad(frame)} looks unlike both its neighbours, a stray frame? Bria will keep it.`)
    }
  }
  step.forEach((d, i) => {
    const frame = i + 2
    const isolated = d > 4 * Math.max(step[i - 1] ?? 0, step[i + 1] ?? 0)
    if (d > threshold && isolated && !strays.has(frame) && !strays.has(frame - 1) && !cuts.includes(frame)) {
      warnings.push(`big jump into frame ${pad(frame)}: if it's a cut, add ${frame} to "cuts" in job.json.`)
    }
  })
  return warnings
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))))
  })
}

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0')
}
