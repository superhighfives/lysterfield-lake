import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { exists, framesDir, type Job } from '../job.ts'
import { MODELS } from '../models.ts'
import { readFileAsInput, runModelToFile } from '../replicate.ts'
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
 */

/** Use every 2nd frame of the 24fps job: 12 dream frames per second, close to the legacy 10. */
export const DEFORUM_NTH_FRAME = 2
/** Dream frames in each sample's warm-up run (~1s): enough for the loop to settle into the subject's shape. */
const SAMPLE_WARMUP_FRAMES = 12

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

/**
 * One Deforum run over job frames `start` (1-based) onward, `dreamFrames`
 * dream frames long, into `outDir` as NNNNN.png (Deforum's own numbering).
 * A real (GPU) Replicate call: skipped if `outDir` already has frames.
 */
export async function deforumRun(
  job: Job,
  take: string,
  config: TakeConfig,
  start: number,
  dreamFrames: number,
  outDir: string
): Promise<string[]> {
  assertLandscapePrompt(config.prompt)
  await mkdir(outDir, { recursive: true })
  // `done` is written only after the frames are fully unzipped, so a run that died part-way
  // (a truncated unzip, stale init/mask videos) is redone rather than mistaken for finished.
  const marker = path.join(outDir, 'done')
  const pngs = async () => (await readdir(outDir)).filter((f) => f.endsWith('.png')).sort()
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
  await runModelToFile(
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
    },
    zipPath
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
  await Promise.all(
    samples.map(async (sample) => {
      const outputPath = path.join(samplesDir, `${name(sample.frame)}.jpg`)
      if (await exists(outputPath)) return
      const start = Math.max(1, sample.frame - (SAMPLE_WARMUP_FRAMES - 1) * DEFORUM_NTH_FRAME)
      const dreamFrames = Math.floor((sample.frame - start) / DEFORUM_NTH_FRAME) + 1
      const runDir = path.join(samplesDir, 'runs', name(sample.frame))
      const frames = await deforumRun(job, take, config, start, dreamFrames, runDir)
      await sharp(frames[frames.length - 1]).jpeg({ quality: 90 }).toFile(outputPath)
      // The run as a short loop, so the review shows motion as well as the look. Deforum names
      // frames <timestring>_NNNNN.png, so they're fed to ffmpeg as a sorted concat list.
      const list = path.join(runDir, 'frames.txt')
      await writeFile(list, frames.map((f) => `file '${f}'\nduration ${DEFORUM_NTH_FRAME / job.fps}`).join('\n'))
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(samplesDir, `${name(sample.frame)}.mp4`)])
    })
  )
  return {
    samplesDir,
    samples: samples.map((s) => ({ ...s, path: path.join(samplesDir, `${name(s.frame)}.jpg`) })),
  }
}
