import { execFile } from 'node:child_process'
import { copyFile, link, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { exists, framesDir, listFrames, type Job } from '../job.ts'
import { MODELS } from '../models.ts'
import { readFileAsInput, runModelToFileResumable } from '../replicate.ts'
import { COLOURS_DIR } from '../resources.ts'
import type { DreamSamplesResult, TakeConfig } from './dream.ts'

const execFileAsync = promisify(execFile)

/**
 * Dream (panel 7) takes made the way the ten legacy dreams were: Deforum
 * 0.7.1 with the legacy render.py, settings, negative prompt and colour
 * reference (`models/deforum/`, plans/ready/own-deforum-dream-model.md).
 *
 * Deforum grows each frame out of the previous one, with the subject's
 * shape (panel 2 inside the matte) steering it. So a single frame can't be
 * sampled on its own: each sample is a short warm-up run ending on the
 * sample frame, and the sample is its last frame.
 *
 * For the same reason a long stretch (the test clip, the full song) is a
 * chain of runs, one after another, each continuing from the last frame of
 * the one before (`deforumFrames`).
 */

/** Use every 2nd frame of the 24fps job: 12 dream frames per second, close to the legacy 10. */
export const DEFORUM_NTH_FRAME = 2
/** Dream frames in each sample's warm-up run (~1s): enough for the loop to settle into the subject's shape. */
const SAMPLE_WARMUP_FRAMES = 12
/**
 * Dream frames per Replicate run in a chain. At ~21s a frame on an A100 that
 * is about 17 minutes: the most a failed run can waste, and how often a long
 * take saves its progress.
 */
const CHUNK_DREAM_FRAMES = 48

const name = (frame: number) => String(frame).padStart(4, '0')

/**
 * Panel 7 must never show a person (CLAUDE.md). For Deforum (Stable
 * Diffusion) the guard is the legacy negative prompt, which the model always
 * applies and a take can only add to (models/deforum/predict.py). Naming a
 * person in the positive prompt would fight it, so such prompts are refused
 * here rather than patched with a "no people" suffix, which in SD tends to
 * summon what it names.
 */
const PERSON_TERMS =
  /\b(person|people|man|men|woman|women|boy|girl|child|children|kid|human|figure|face|faces|portrait|selfie|body|bodies|singer|dancer|character|crowd)\b/i

export function assertLandscapePrompt(prompt: string): void {
  const match = prompt.match(PERSON_TERMS)
  if (match) {
    throw new Error(`Deforum prompts must describe a landscape only; "${match[0]}" names a person. Panel 7 must never show a person.`)
  }
}

function colourPath(job: Job, take: string, colour: string): string {
  // A bare file name is one of the shared colour references; anything else is relative to the take.
  return colour.includes('/') ? path.join(job.dir, '7-dreams', take, colour) : path.join(COLOURS_DIR, colour)
}

interface DeforumRun {
  /** First job frame (1-based) of the init video. */
  start: number
  /** Dream frames the init video covers. */
  dreamFrames: number
  outDir: string
  /**
   * Continue an earlier run: its last frame (a PNG). `start` must then be
   * that frame's job frame; it counts towards `dreamFrames` but is not
   * rendered again or returned.
   */
  previousFrame?: string
}

/**
 * One Deforum run over job frames `start` onward, into `outDir` as
 * <timestring>_NNNNN.png (Deforum's own numbering). A real (GPU) Replicate
 * call: skipped once `outDir` has its `done` marker, and a run that was
 * still going when this process last stopped is picked back up rather than
 * started again (`runModelToFileResumable`).
 */
export async function deforumRun(job: Job, take: string, config: TakeConfig, run: DeforumRun): Promise<string[]> {
  const { start, dreamFrames, outDir } = run
  assertLandscapePrompt(config.prompt)
  await mkdir(outDir, { recursive: true })
  // `done` is written only after the frames are fully unzipped, so a run that died part-way
  // (a truncated unzip, stale init/mask videos) is redone rather than mistaken for finished.
  const marker = path.join(outDir, 'done')
  // Deforum's frames only (<timestring>_NNNNN.png), not a chain's kept `last.png`.
  const pngs = async () => (await readdir(outDir)).filter((f) => /_\d+\.png$/.test(f)).sort()
  if (await exists(marker)) return (await pngs()).map((f) => path.join(outDir, f))
  for (const stale of await pngs()) await rm(path.join(outDir, stale))

  const count = (dreamFrames - 1) * DEFORUM_NTH_FRAME + 1
  const initPath = path.join(outDir, 'init.mp4')
  const maskPath = path.join(outDir, 'mask.mp4')
  const encode = ['-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p']
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(job.fps), '-start_number', String(start),
    '-i', path.join(job.dir, '2-portrait/upscaled/%04d.jpg'), '-frames:v', String(count), ...encode, initPath])
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(job.fps), '-start_number', String(start),
    '-i', path.join(job.dir, '4-matte/frames/%04d.png'), '-frames:v', String(count), '-vf', 'scale=1024:1024', ...encode, maskPath])

  const zipPath = path.join(outDir, 'frames.zip')
  await runModelToFileResumable(
    MODELS.deforum,
    {
      init_video: await readFileAsInput(initPath),
      mask_video: await readFileAsInput(maskPath),
      prompt: config.prompt,
      negative_prompt: config.negativePrompt ?? '',
      // A colour reference matches every frame's palette to it (legacy "Specific"/"Random"); without
      // one, colours follow the footage itself (legacy "Video Input", as watercolour did).
      ...(config.colour
        ? { colour_image: await readFileAsInput(colourPath(job, take, config.colour)), colour_mode: 'Specific' }
        : { colour_mode: 'Video Input' }),
      preset: config.preset ?? 'lush-and-light',
      extract_nth_frame: DEFORUM_NTH_FRAME,
      max_frames: dreamFrames,
      seed: config.seed,
      ...(run.previousFrame && { previous_frame: await readFileAsInput(run.previousFrame) }),
    },
    zipPath,
    path.join(outDir, 'prediction.json')
  )
  await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', outDir])
  await rm(zipPath)
  const frames = await pngs()
  if (frames.length === 0) throw new Error(`Deforum returned no frames for ${take} at ${start}`)
  await writeFile(marker, '')
  return frames.map((f) => path.join(outDir, f))
}

/** `dream-samples` for a Deforum take: one warm-up run per sample frame, all in parallel. */
export async function deforumSamples(job: Job, take: string, config: TakeConfig): Promise<DreamSamplesResult> {
  const samplesDir = await framesDir(job, `7-dreams/${take}/samples`)
  const samples = job.samples ?? []
  // Every sample is seen through even if one fails: the others are already running (and paid for)
  // on Replicate, so stopping at the first failure would only throw their results away.
  const results = await Promise.allSettled(
    samples.map(async (sample) => {
      const outputPath = path.join(samplesDir, `${name(sample.frame)}.jpg`)
      const loopPath = path.join(samplesDir, `${name(sample.frame)}.mp4`)
      if ((await exists(outputPath)) && (await exists(loopPath))) return
      const start = Math.max(1, sample.frame - (SAMPLE_WARMUP_FRAMES - 1) * DEFORUM_NTH_FRAME)
      const dreamFrames = Math.floor((sample.frame - start) / DEFORUM_NTH_FRAME) + 1
      const runDir = path.join(samplesDir, 'runs', name(sample.frame))
      const frames = await deforumRun(job, take, config, { start, dreamFrames, outDir: runDir })
      await sharp(frames[frames.length - 1]).jpeg({ quality: 90 }).toFile(outputPath)
      // The run as a short loop, so the review shows motion as well as the look. Deforum names
      // frames <timestring>_NNNNN.png, so they're fed to ffmpeg as a sorted concat list.
      const list = path.join(runDir, 'frames.txt')
      // Absolute paths: ffmpeg reads a concat list's entries relative to the list file, not the cwd.
      await writeFile(list, frames.map((f) => `file '${path.resolve(f)}'\nduration ${DEFORUM_NTH_FRAME / job.fps}`).join('\n'))
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', loopPath])
    })
  )
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length > 0) throw new Error(`${failed.length} of ${samples.length} samples failed: ${failed.map((r) => String(r.reason?.message ?? r.reason).split('\n')[0]).join('; ')}`)
  return {
    samplesDir,
    samples: samples.map((s) => ({ ...s, path: path.join(samplesDir, `${name(s.frame)}.jpg`) })),
  }
}

export interface DeforumFramesOptions {
  /** The stretch to render (first job frame, 1-based, and frame count). Default: the whole job. */
  range?: { start: number; frames: number }
  /** Start a second early and throw that second away, so a stretch from the middle of the song opens already settled into the subject's shape (as the samples do). */
  warmUp?: boolean
  /** Where each run's working files go (absolute). */
  workDir: string
  /** Where the finished frames go, named by job frame (absolute). */
  framesDir: string
  chunkFrames?: number
}

/**
 * A long stretch of a Deforum take, as a chain of runs. Every run but the
 * first continues from the last frame of the one before, so the result is
 * the same feedback loop as one long run. Runs are strictly one after
 * another for that reason.
 *
 * Safe to stop and start again at any point: a finished run is never
 * repeated, and one that was still going on Replicate is picked back up.
 * Each dream frame is saved as a JPEG named for its job frame; the job
 * frames it is held over (`DEFORUM_NTH_FRAME`) are hard links to it.
 */
export async function deforumFrames(job: Job, take: string, config: TakeConfig, opts: DeforumFramesOptions): Promise<{ framesDir: string }> {
  const total = (await listFrames(path.join(job.dir, '2-portrait/upscaled'))).length
  const first = opts.range?.start ?? 1
  const last = Math.min(total, first + (opts.range?.frames ?? total) - 1)
  if (first < 1 || last < first) throw new Error(`Nothing to render: frames ${first} to ${last} of ${total}`)

  const warmUp = opts.warmUp ? Math.min(SAMPLE_WARMUP_FRAMES, Math.floor((first - 1) / DEFORUM_NTH_FRAME)) : 0
  const count = warmUp + Math.ceil((last - first + 1) / DEFORUM_NTH_FRAME)
  /** The job frame of the chain's i-th dream frame. */
  const jobFrame = (i: number) => first + (i - warmUp) * DEFORUM_NTH_FRAME
  const chunk = opts.chunkFrames ?? CHUNK_DREAM_FRAMES
  await mkdir(opts.framesDir, { recursive: true })

  let previousFrame: string | undefined
  for (let from = 0; from < count; from += chunk) {
    const to = Math.min(count, from + chunk)
    const outDir = path.join(opts.workDir, name(jobFrame(from)))
    const lastFrame = path.join(outDir, 'last.png')
    const finished = path.join(outDir, 'finished')
    if (!(await exists(finished))) {
      const pngs = await deforumRun(
        job,
        take,
        config,
        previousFrame
          ? { start: jobFrame(from - 1), dreamFrames: to - from + 1, outDir, previousFrame }
          : { start: jobFrame(from), dreamFrames: to - from, outDir }
      )
      if (pngs.length !== to - from) throw new Error(`Deforum returned ${pngs.length} frames for ${outDir}, expected ${to - from}`)
      for (let i = Math.max(from, warmUp); i < to; i++) {
        const frame = jobFrame(i)
        const jpg = path.join(opts.framesDir, `${name(frame)}.jpg`)
        if (!(await exists(jpg))) await sharp(pngs[i - from]).jpeg({ quality: 90 }).toFile(jpg)
        for (let held = frame + 1; held < frame + DEFORUM_NTH_FRAME && held <= last; held++) {
          const heldPath = path.join(opts.framesDir, `${name(held)}.jpg`)
          if (!(await exists(heldPath))) await link(jpg, heldPath)
        }
      }
      // Only the last frame is needed again (the next run continues from it), and it has to be
      // the lossless one. The rest are dropped once they're saved as JPEGs.
      await copyFile(pngs[pngs.length - 1], lastFrame)
      await writeFile(finished, '')
      for (const png of pngs) await rm(png)
      for (const video of ['init.mp4', 'mask.mp4']) await rm(path.join(outDir, video), { force: true })
    }
    previousFrame = lastFrame
    console.log(`Dream frames: ${to} of ${count} done`)
  }
  return { framesDir: opts.framesDir }
}
