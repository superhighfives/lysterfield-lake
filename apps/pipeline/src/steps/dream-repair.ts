import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { exists, type Job } from '../job.ts'
import { flaggedStretches, listDreamFrames, type DreamCheck, type DreamFrame } from './dream-check.ts'
import { deforumRun } from './dream-deforum.ts'
import { loadTake, type TakeConfig } from './dream.ts'

/**
 * Replaces dream (panel 7) frames that show a person
 * (plans/in-progress/dreams.md). Never by interpolating: the 2023 repair
 * filled gaps with a RIFE morph, which loses the stop-motion look where
 * every dream frame is its own picture. A replaced frame here is either a
 * real Deforum frame, re-rendered from the last good frame before the
 * stretch, or that last good frame held a little longer.
 *
 * Works on any take whose frames folder follows the usual layout, including
 * the ten legacy dreams, whose frames sit at 10 per second of song: the
 * dream frames and the job frames they are made from are read off the
 * folder itself.
 */

const PRESETS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'models', 'deforum', 'settings', 'presets.json')

/** Rough cost of one Deforum frame on the A100 (~21s at ~$0.0014/s), for the estimate printed before a paid repair. */
export const DEFORUM_COST_PER_FRAME = 0.03

export interface RepairStretch {
  /** First and last dream frame to replace, by job frame number. */
  start: number
  end: number
}

export type RepairAction = 'rerender' | 'hold'

const name = (frame: number) => String(frame).padStart(4, '0')

/**
 * A take's Deforum settings. The ten legacy dreams have no take.json (they
 * weren't made by this pipeline); theirs come from the legacy presets,
 * which record each one's prompt, seed and colour reference.
 */
export async function repairConfig(job: Job, take: string): Promise<TakeConfig> {
  const saved = await loadTake(job, take)
  if (saved) {
    if (saved.method !== 'deforum') throw new Error(`Take "${take}" wasn't made with Deforum; re-rendering a stretch only works for Deforum takes.`)
    return saved
  }
  const presets = JSON.parse(await readFile(PRESETS_PATH, 'utf8')) as Record<string, { prompt: string; seed: number; colour: string | null }>
  const preset = presets[take]
  if (!preset) throw new Error(`Take "${take}" has no take.json and isn't one of the legacy dreams.`)
  return { prompt: preset.prompt, seed: preset.seed, stepFps: job.stepFps ?? 6, method: 'deforum', preset: take, ...(preset.colour && { colour: preset.colour }) }
}

/** Swaps one dream frame's picture, keeping the original in `replacedDir` (the first one only: a second repair must not overwrite it). */
async function replaceFrame(target: DreamFrame, framesDir: string, replacedDir: string, write: (file: string) => Promise<void>): Promise<void> {
  const kept = path.join(replacedDir, path.basename(target.file))
  if (await exists(kept)) await rm(target.file)
  else await rename(target.file, kept)
  await write(target.file)
  for (const held of target.holds) {
    const heldPath = path.join(framesDir, `${name(held)}${path.extname(target.file)}`)
    await rm(heldPath)
    await link(target.file, heldPath)
  }
}

export interface RepairResult {
  stretch: RepairStretch
  action: RepairAction
  frames: number
  /** Re-rendered frames the model itself still scored as a person, after its own retries. */
  stillFlagged: number[]
}

/**
 * Repairs `stretches` of the take's frames in `framesDir`, in order. A
 * re-render is a real (GPU) Replicate run per stretch: skipped once applied,
 * and picked back up rather than started again if it was still going
 * (`deforumRun`). Originals are kept in `<takeDir>/replaced/`.
 */
export async function dreamRepair(
  job: Job,
  take: string,
  opts: { takeDir: string; framesDir: string; stretches: RepairStretch[]; action: RepairAction }
): Promise<RepairResult[]> {
  const config = opts.action === 'rerender' ? await repairConfig(job, take) : undefined
  const checkPath = path.join(opts.takeDir, 'check.json')
  const replacedDir = path.join(opts.takeDir, 'replaced')
  await mkdir(replacedDir, { recursive: true })
  const results: RepairResult[] = []

  for (const stretch of [...opts.stretches].sort((a, b) => a.start - b.start)) {
    // Read again for every stretch: a hold changes which frames share a picture.
    const dreamFrames = await listDreamFrames(opts.framesDir)
    const from = dreamFrames.findIndex((f) => f.frame === stretch.start)
    const to = dreamFrames.findIndex((f) => f.frame === stretch.end)
    if (from === -1 || to < from) throw new Error(`Frames ${stretch.start}-${stretch.end} aren't dream frames in ${opts.framesDir} (a dream frame is named by the first job frame it appears at).`)
    if (from === 0) throw new Error(`Frame ${stretch.start} is the take's first: there is no good frame before it to continue from.`)
    const previous = dreamFrames[from - 1]
    const targets = dreamFrames.slice(from, to + 1)

    if (opts.action === 'hold') {
      for (const target of targets) await replaceFrame(target, opts.framesDir, replacedDir, (file) => link(previous.file, file))
      await updateCheck(checkPath, targets.map((t) => ({ frame: t.frame })))
      results.push({ stretch, action: 'hold', frames: targets.length, stillFlagged: [] })
      continue
    }

    const outDir = path.join(opts.takeDir, 'repairs', `${name(stretch.start)}-${name(stretch.end)}`)
    const applied = path.join(outDir, 'applied')
    const scoresPath = path.join(outDir, 'scores.json')
    if (!(await exists(applied))) {
      await mkdir(outDir, { recursive: true })
      const previousFrame = path.join(outDir, 'previous.png')
      if (!(await exists(previousFrame))) await sharp(previous.file).png().toFile(previousFrame)
      const pngs = await deforumRun(job, take, config!, {
        start: previous.frame,
        dreamFrames: targets.length + 1,
        jobFrames: [previous.frame, ...targets.map((t) => t.frame)],
        outDir,
        previousFrame,
      })
      if (pngs.length !== targets.length) throw new Error(`Deforum returned ${pngs.length} frames for ${outDir}, expected ${targets.length}`)
      for (const [i, target] of targets.entries()) {
        await replaceFrame(target, opts.framesDir, replacedDir, async (file) => void (await sharp(pngs[i]).jpeg({ quality: 90 }).toFile(file)))
      }
      await writeFile(applied, '')
      for (const png of pngs) await rm(png)
      for (const video of ['init.mp4', 'mask.mp4']) await rm(path.join(outDir, video), { force: true })
    }
    // The model's own verdict on each new frame (models/deforum/predict.py), in frame order.
    const scores = (await exists(scoresPath)) ? (Object.values(JSON.parse(await readFile(scoresPath, 'utf8'))) as { score: number; flagged: boolean }[]) : []
    await updateCheck(checkPath, targets.flatMap((t, i) => (scores[i] ? [{ frame: t.frame, score: scores[i].score }] : [])))
    results.push({
      stretch,
      action: 'rerender',
      frames: targets.length,
      stillFlagged: targets.filter((_, i) => scores[i]?.flagged).map((t) => t.frame),
    })
  }
  return results
}

/**
 * Brings the take's check.json up to date after a repair, without scoring
 * the whole take again: held frames are no longer dream frames of their
 * own, and a re-rendered frame takes the score the model gave it as it was
 * made (the same classifier). A take that was never checked has nothing to
 * update.
 */
async function updateCheck(checkPath: string, changes: { frame: number; score?: number }[]): Promise<void> {
  if (!(await exists(checkPath))) return
  const check = JSON.parse(await readFile(checkPath, 'utf8')) as DreamCheck
  for (const { frame, score } of changes) {
    if (score === undefined) delete check.scores[name(frame)]
    else check.scores[name(frame)] = score
  }
  const scored = Object.entries(check.scores).map(([frame, score]) => ({ frame: Number(frame), score })).sort((a, b) => a.frame - b.frame)
  check.stretches = flaggedStretches(scored, check.threshold)
  check.frames = scored.length
  check.flagged = check.stretches.reduce((sum, s) => sum + s.frames, 0)
  await writeFile(checkPath, JSON.stringify(check, null, 2) + '\n')
}

/** Parses `--frames 1735,934-936` into stretches. */
export function parseStretches(value: string): RepairStretch[] {
  return value.split(',').map((part) => {
    const [start, end = start] = part.trim().split('-').map(Number)
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) throw new Error(`Can't read "${part}" as a frame or a range of frames`)
    return { start, end }
  })
}
