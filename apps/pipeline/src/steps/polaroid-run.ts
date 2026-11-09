import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { exists, listFrames, videoPath, type Job } from '../job.ts'
import { MODELS } from '../models.ts'
import { polaroidServerUrl, runOnGpuServer } from '../gpu-server.ts'
import { readFileAsInput, runModelToFileResumable } from '../replicate.ts'
import { planChunks } from './background-video.ts'
import { polaroidPanels } from './polaroid-panels.ts'

/**
 * What a loop costs on the `lysterfield-polaroid` deployment (L40S, $0.000975/s), measured on `park-party`
 * (plans/in-progress/polaroids.md): ~10.4s of GPU a frame, and ~170s of boot per range from cold,
 * which a private model bills too. An estimate for the confirm button, not a bill.
 */
const L40S_PER_SECOND = 0.000975
const SECONDS_PER_FRAME = 10.4
const BOOT_SECONDS = 170
/** Bria's price, per second of output (background-video.ts). */
const BRIA_PER_SECOND = 0.05

/** The panels' raw folders a range fills; a range is done when all its frames are in each. */
const RAW = ['2-portrait/upscaled', '5-depth/raw', '6-outline/raw']

export interface PolaroidRunOptions {
  /** Predictions the clip is split across, run at once (the deployment allows up to 4 instances). */
  ranges?: number
  /** DiffusionCLIP inversion steps: 20 looks the same as 40 and is a third faster. */
  inversionSteps?: number
  /** Only report what would run and its cost. */
  planOnly?: boolean
  concurrency: number
}

export interface PolaroidRunResult {
  ranges: { start: number; frames: number; done: boolean }[]
  toRun: number
  estimatedCost: string
  /** What panel 3 (Bria, `background-video`) will cost, from the same chunk plan it makes. */
  backgroundCost: string
  failed: { start: number; error: string }[]
}

/**
 * Panels 2, 4, 5 and 6 of a polaroid job from the polaroid model (models/polaroid), each range unpacked and
 * post-processed by `polaroidPanels` as it lands, the first also doing the matte for the whole clip:
 *
 * - On the 4090 PC when `POLAROID_URL` is set: the whole clip in one prediction, free, one frame at a time
 *   (`portrait_batch` 1: Deforum holds 8GB of the GPU). About 8.3s a frame (models/polaroid/README.md).
 * - Otherwise on the Replicate deployment, the clip split into frame ranges run at once.
 *
 * Skip-if-exists per range (its frames are already in the job), and each range's prediction id is saved
 * as it starts, so running this again picks up predictions still going instead of paying twice. A failed
 * range is not run again unless asked (`--retry true`), as everywhere else (CLAUDE.md).
 */
export async function polaroidRun(job: Job, opts: PolaroidRunOptions): Promise<PolaroidRunResult> {
  const frames = await listFrames(path.join(job.dir, '0-source/frames'))
  if (frames.length === 0) throw new Error('No source frames: run init first')
  const pc = polaroidServerUrl()
  // One GPU on the PC, so splitting the clip gains nothing there.
  const count = pc ? 1 : Math.max(1, Math.min(opts.ranges ?? 4, frames.length))
  const size = Math.ceil(frames.length / count)
  const matteDone = await exists(await videoPath(job, '4-matte/raw', 'mp4'))

  const ranges = []
  for (let start = 1; start <= frames.length; start += size) {
    const names = frames.slice(start - 1, start - 1 + size).map((f) => path.parse(f).name)
    let done = start !== 1 || matteDone
    for (const dir of RAW) {
      if (!done) break
      // A missing folder is a range not run yet; any other read error throws, rather than reading as
      // "not done" and paying for the range again.
      const raw = path.join(job.dir, dir)
      const have = new Set(((await exists(raw)) ? await listFrames(raw) : []).map((f) => path.parse(f).name))
      done = names.every((n) => have.has(n))
    }
    ranges.push({ start, frames: names.length, done })
  }

  const todo = ranges.filter((r) => !r.done)
  const cost = pc ? 0 : todo.reduce((sum, r) => sum + (r.frames * SECONDS_PER_FRAME + BOOT_SECONDS) * L40S_PER_SECOND, 0)
  const briaSeconds = planChunks(frames.length, job.fps, job.cuts ?? []).reduce((sum, c) => sum + (c.end - c.start + 1) / job.fps, 0)
  const result: PolaroidRunResult = {
    ranges,
    toRun: todo.length,
    estimatedCost: `$${cost.toFixed(2)}`,
    backgroundCost: `$${(briaSeconds * BRIA_PER_SECOND).toFixed(2)}`,
    failed: [],
  }
  console.log(`polaroid-run: ${todo.length} of ${ranges.length} ranges to run, ${pc ? 'free on the 4090' : `about ${result.estimatedCost}`}`)
  if (opts.planOnly || todo.length === 0) return result

  const runsDir = path.join(job.dir, 'polaroid', 'runs')
  await mkdir(runsDir, { recursive: true })
  const video = await videoPath(job, '0-source/video')
  const settled = await Promise.allSettled(
    todo.map(async (r) => {
      const tar = path.join(runsDir, `range-${r.start}.tar`)
      if (!(await exists(tar))) {
        const input = {
          video: await readFileAsInput(video),
          fps: job.fps,
          start_frame: r.start,
          max_frames: r.frames,
          panels: r.start === 1 ? 'matte,portrait,depth,outline' : 'portrait,depth,outline',
          portrait_inv_steps: opts.inversionSteps ?? 20,
          portrait_batch: pc ? 1 : 4,
        }
        if (pc) await runOnGpuServer(pc, input, tar)
        else await runModelToFileResumable(MODELS.polaroidDeployment, input, tar, path.join(runsDir, `range-${r.start}.json`))
      }
      return { start: r.start, tar }
    })
  )

  // The matte's range first, so the others can be post-processed against it as they're unpacked.
  const landed = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])).sort((a, b) => a.start - b.start)
  for (const { tar } of landed) {
    await polaroidPanels(job, tar, opts.concurrency)
    await rm(tar)
  }
  settled.forEach((s, i) => {
    if (s.status === 'rejected') result.failed.push({ start: todo[i].start, error: (s.reason as Error).message })
  })
  return result
}
