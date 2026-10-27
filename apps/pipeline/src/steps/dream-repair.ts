import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { exists, type Job } from '../job.ts'
import { assertFreeSpace, faceScores, flaggedStretches, listDreamFrames, runCheck, scoredFrames, type DreamCheck, type DreamFrame } from './dream-check.ts'
import { deforumRun } from './dream-deforum.ts'
import { loadTake, type TakeConfig } from './dream.ts'

/**
 * Replaces dream (panel 7) frames that show a person
 * (plans/in-progress/dreams.md). Never by interpolating: the 2023 repair
 * filled gaps with a RIFE morph, which loses the stop-motion look where
 * every dream frame is its own picture. A replaced frame here is either a
 * real Deforum frame, re-rendered from the last good frame before the
 * stretch, or that last good frame held a little longer. A re-render is
 * final and its originals are deleted; a hold can be undone.
 *
 * Works on any take whose frames folder follows the usual layout, including
 * the ten legacy dreams, whose frames sit at 10 per second of song: the
 * dream frames and the job frames they are made from are read off the
 * folder itself.
 */

const PRESETS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'models', 'deforum', 'settings', 'presets.json')

/**
 * Re-render runs going at once for one repair. Each is its own Replicate
 * prediction, so more at once means more machines booting (each ~2.5
 * minutes, billed on a private model) for less waiting.
 */
export const REPAIR_CONCURRENCY = 10

/**
 * Rounds a re-render request runs for one stretch before giving up and
 * leaving it flagged (user, 2026-10-14). A round is one Replicate run with
 * the model's own two retries, so a stretch can cost up to 30 frames of GPU
 * time per frame in it. A deliberate, capped exception to CLAUDE.md's
 * no-retry-loops rule.
 */
export const MAX_REPAIR_ROUNDS = 10

/** Rough cost of one Deforum frame on the L40S (~8s with xformers at ~$0.000975/s), for the estimate printed before a paid repair. */
export const DEFORUM_COST_PER_FRAME = 0.008

export interface RepairStretch {
  /** First and last dream frame to replace, by job frame number. */
  start: number
  end: number
}

export type RepairAction = 'rerender' | 'hold' | 'restore'

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

/**
 * Swaps one dream frame's picture. A hold keeps the original in
 * `replacedDir` (the first one only: a second repair must not overwrite it),
 * so it can be undone. A re-render is final (user, 2026-10-13): the frame
 * it replaces, and any original kept from an earlier hold, are deleted.
 */
async function replaceFrame(target: DreamFrame, framesDir: string, replacedDir: string, write: (file: string) => Promise<void>, keepOriginal: boolean): Promise<void> {
  const kept = path.join(replacedDir, path.basename(target.file))
  // Made beside the frames first and renamed over the old one, so a write that fails leaves the old frame in place.
  const incoming = path.join(replacedDir, '..', 'incoming', path.basename(target.file))
  await mkdir(path.dirname(incoming), { recursive: true })
  await rm(incoming, { force: true })
  await write(incoming)
  if (keepOriginal && !(await exists(kept))) await rename(target.file, kept)
  await rename(incoming, target.file)
  if (!keepOriginal) await rm(kept, { force: true })
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
  /** Re-rendered frames the model itself still scored as a person, after its own retries and every round. */
  stillFlagged: number[]
  /** Re-render rounds this request ran for the stretch (each with new seeds). */
  rounds?: number
}

/**
 * Repairs `stretches` of the take's frames in `framesDir`, in order. A
 * re-render is a real (GPU) Replicate run per stretch: skipped once applied,
 * and picked back up rather than started again if it was still going
 * (`deforumRun`). A held frame's original is kept in `<takeDir>/replaced/`;
 * a re-rendered frame's is deleted.
 */
export async function dreamRepair(
  job: Job,
  take: string,
  opts: {
    takeDir: string
    framesDir: string
    stretches: RepairStretch[]
    action: RepairAction
    /**
     * Re-render a stretch that has been re-rendered before, when that result still shows a person:
     * the time (ms) the request was made. Only a re-render finished before then is redone, so a
     * retried task, which passes the same time, skips one it already finished rather than paying twice.
     */
    again?: number
    /**
     * For this request only, re-render with another style image (a file in resources/colours), or none
     * (null), and/or another prompt. take.json is left as it is. For a stretch the take's own settings
     * keep painting back: Sharp Edges' style image is a portrait, so its re-renders kept her face.
     */
    style?: string | null
    prompt?: string
  }
): Promise<RepairResult[]> {
  await assertFreeSpace('A repair', [os.tmpdir(), opts.takeDir])
  const saved = opts.action === 'rerender' ? await repairConfig(job, take) : undefined
  const config = saved && {
    ...saved,
    ...(opts.style !== undefined && { style: opts.style ?? undefined }),
    ...(opts.prompt !== undefined && { prompt: opts.prompt }),
  }
  const checkPath = path.join(opts.takeDir, 'check.json')
  const replacedDir = path.join(opts.takeDir, 'replaced')
  await mkdir(replacedDir, { recursive: true })
  // check.json is read, changed and written per stretch; with stretches finishing side by side, one at a time.
  let checkQueue = Promise.resolve()
  const updatingCheck = (update: () => Promise<void>) => (checkQueue = checkQueue.then(update, update))

  /**
   * `snapshot`: the take's dream frames as they were before any re-render started. Re-renders running
   * side by side would otherwise list the folder while another is swapping a file in it. A re-render
   * keeps every frame's name and holds, so the snapshot stays true; a hold doesn't, so holds read the
   * folder afresh each time.
   */
  const repairOne = async (stretch: RepairStretch, snapshot?: DreamFrame[]): Promise<RepairResult> => {
    const dreamFrames = snapshot ?? (await listDreamFrames(opts.framesDir))
    const from = dreamFrames.findIndex((f) => f.frame === stretch.start)
    const to = dreamFrames.findIndex((f) => f.frame === stretch.end)
    if (from === -1 || to < from) throw new Error(`Frames ${stretch.start}-${stretch.end} aren't dream frames in ${opts.framesDir} (a dream frame is named by the first job frame it appears at).`)
    if (from === 0) throw new Error(`Frame ${stretch.start} is the take's first: there is no good frame before it to continue from.`)
    const previous = dreamFrames[from - 1]
    const targets = dreamFrames.slice(from, to + 1)

    if (opts.action === 'hold') {
      for (const target of targets) await replaceFrame(target, opts.framesDir, replacedDir, (file) => link(previous.file, file), true)
      await updatingCheck(() => updateCheck(checkPath, targets.map((t) => ({ frame: t.frame }))))
      return { stretch, action: 'hold', frames: targets.length, stillFlagged: [] }
    }

    const outDir = path.join(opts.takeDir, 'repairs', `${name(stretch.start)}-${name(stretch.end)}`)
    const applied = path.join(outDir, 'applied')
    // Which attempt at this stretch this is (`round`, 0 the first time). Deforum from the same frame
    // with the same seed paints the same picture again, so every further round uses new seeds.
    const roundPath = path.join(outDir, 'round')
    const saved = (await exists(roundPath)) ? Number(await readFile(roundPath, 'utf8')) : 0
    if (!Number.isInteger(saved) || saved < 0) throw new Error(`${roundPath} isn't a round number; fix or delete it before re-rendering this stretch.`)
    let round = saved
    // Asked for again: an earlier result (from before the request) is replaced, so its run starts from scratch.
    if (opts.again !== undefined && (await exists(applied)) && (await stat(applied)).mtimeMs < opts.again) {
      await rm(outDir, { recursive: true, force: true })
      round += 1
    }
    const scoresPath = path.join(outDir, 'scores.json')
    for (let pass = 0; ; pass++) {
      const renderedNow = !(await exists(applied))
      if (renderedNow) {
        await mkdir(outDir, { recursive: true })
        await writeFile(roundPath, String(round))
        const previousFrame = path.join(outDir, 'previous.png')
        if (!(await exists(previousFrame))) await sharp(previous.file).png().toFile(previousFrame)
        // A large prime step keeps each round's seeds clear of the model's own retry seeds (seed + 7919 n).
        const seeded = { ...config!, seed: (config!.seed + 15485863 * round) % 2 ** 32 }
        const pngs = await deforumRun(job, take, seeded, {
          start: previous.frame,
          dreamFrames: targets.length + 1,
          jobFrames: [previous.frame, ...targets.map((t) => t.frame)],
          outDir,
          previousFrame,
        })
        if (pngs.length !== targets.length) throw new Error(`Deforum returned ${pngs.length} frames for ${outDir}, expected ${targets.length}`)
        for (const [i, target] of targets.entries()) {
          await replaceFrame(target, opts.framesDir, replacedDir, async (file) => void (await sharp(pngs[i]).jpeg({ quality: 90 }).toFile(file)), false)
        }
        await writeFile(applied, '')
        for (const png of pngs) await rm(png)
        for (const video of ['init.mp4', 'mask.mp4']) await rm(path.join(outDir, video), { force: true })
      }
      // The model's own verdict on each new frame (models/deforum/predict.py), in frame order.
      const scores = (await exists(scoresPath)) ? (Object.values(JSON.parse(await readFile(scoresPath, 'utf8'))) as { score: number; flagged: boolean }[]) : []
      const stillFlagged = targets.filter((_, i) => scores[i]?.flagged).map((t) => t.frame)
      // Still a person after the model's own retries: go again with new seeds, up to MAX_REPAIR_ROUNDS
      // rounds per request (user, 2026-10-14). Only for a round rendered just now, so retrying a task
      // that already finished never starts paying again.
      const done = stillFlagged.length === 0 || !renderedNow || pass + 1 >= MAX_REPAIR_ROUNDS
      await updatingCheck(async () => {
        // The face check scores only the frames a request ends on, for the review, and never decides
        // another round: rounds searched against it would find the faces it misses.
        const faces = done ? await faceScores(targets.map((t) => t.file)) : {}
        await updateCheck(checkPath, targets.flatMap((t, i) => (scores[i] ? [{ frame: t.frame, score: scores[i].score, face: faces[t.file] }] : [])))
      })
      if (done) return { stretch, action: 'rerender', frames: targets.length, stillFlagged, rounds: pass + 1 }
      console.log(`Stretch ${stretch.start}-${stretch.end} still shows a person after round ${round}; trying new seeds`)
      await rm(outDir, { recursive: true, force: true })
      round += 1
    }
  }

  const sorted = [...opts.stretches].sort((a, b) => a.start - b.start)
  // Holds are free and instant: one after another.
  if (opts.action !== 'rerender') {
    const results: RepairResult[] = []
    for (const stretch of sorted) results.push(await repairOne(stretch))
    return results
  }

  // Re-renders run side by side, each its own Replicate run. A stretch continues from the good frame
  // just before it, so one whose frame before is inside the stretch ahead of it has to wait for that
  // one: those are chained, and the chains run in parallel.
  const snapshot = await listDreamFrames(opts.framesDir)
  const dreamFrames = snapshot.map((f) => f.frame)
  const chains: RepairStretch[][] = []
  for (const stretch of sorted) {
    const before = dreamFrames[dreamFrames.indexOf(stretch.start) - 1]
    const last = chains.at(-1)?.at(-1)
    if (last && before !== undefined && before >= last.start && before <= last.end) chains.at(-1)!.push(stretch)
    else chains.push([stretch])
  }
  const settled: PromiseSettledResult<RepairResult>[] = []
  let next = 0
  const worker = async () => {
    while (next < chains.length) {
      const chain = chains[next++]
      for (const stretch of chain) {
        const result = await repairOne(stretch, snapshot).then(
          (value): PromiseSettledResult<RepairResult> => ({ status: 'fulfilled', value }),
          (reason): PromiseSettledResult<RepairResult> => ({ status: 'rejected', reason })
        )
        settled.push(result)
        console.log(`Re-rendered ${settled.length} of ${sorted.length} stretches`)
        // The rest of a chain continues from this stretch, so it can't go on after a failure.
        if (result.status === 'rejected') break
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REPAIR_CONCURRENCY, chains.length) }, worker))
  // Every run is seen through before reporting a failure: the others were already paid for.
  const failed = settled.filter((r) => r.status === 'rejected')
  if (failed.length > 0) {
    // A failure stops the rest of its chain, so those stretches were never run.
    const skipped = sorted.length - settled.length
    throw new Error(`${failed.length} of ${sorted.length} stretches failed${skipped > 0 ? `, ${skipped} after them were skipped` : ''} (the rest were re-rendered): ${failed.map((r) => String(r.reason?.message ?? r.reason).split('\n')[0]).join('; ')}`)
  }
  return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])).sort((a, b) => a.stretch.start - b.stretch.start)
}

/**
 * Brings the take's check.json up to date after a repair, without scoring
 * the whole take again: held frames are no longer dream frames of their
 * own, and a re-rendered frame takes the person score the model gave it as
 * it was made (the same classifier) and a face score from the face check. A
 * take that was never checked has nothing to update.
 */
async function updateCheck(checkPath: string, changes: { frame: number; score?: number; face?: number }[]): Promise<void> {
  if (!(await exists(checkPath))) return
  const check = JSON.parse(await readFile(checkPath, 'utf8')) as DreamCheck
  for (const { frame, score, face } of changes) {
    if (score === undefined) {
      delete check.scores[name(frame)]
      if (check.faces) delete check.faces[name(frame)]
    } else {
      check.scores[name(frame)] = score
      // A new picture: a face score from before it is stale, so one not scored this time is dropped.
      if (face !== undefined) (check.faces ??= {})[name(frame)] = face
      else if (check.faces) delete check.faces[name(frame)]
    }
  }
  const scored = scoredFrames(check)
  check.stretches = flaggedStretches(scored, check)
  check.frames = scored.length
  check.flagged = check.stretches.reduce((sum, s) => sum + s.frames, 0)
  await writeFile(checkPath, JSON.stringify(check, null, 2) + '\n')
}

/**
 * Undoes a hold: puts each frame's original (kept in `replaced/`) back,
 * held over the same job frames as before. A re-render is final and keeps
 * no original, so there is nothing to put back after one. Free and local; the frames
 * are scored again so check.json stays right.
 */
export async function restoreFrames(opts: { takeDir: string; framesDir: string; frames: number[] }): Promise<number[]> {
  await assertFreeSpace('Putting the originals back', [os.tmpdir(), opts.takeDir])
  const replacedDir = path.join(opts.takeDir, 'replaced')
  const names = (await readdir(opts.framesDir)).filter((f) => /^\d{4}\.jpg$/.test(f)).sort()
  const restored: string[] = []
  for (const frame of opts.frames) {
    const kept = path.join(replacedDir, `${name(frame)}.jpg`)
    if (!(await exists(kept))) throw new Error(`Frame ${frame} hasn't been replaced; there is no original to put back.`)
    const target = path.join(opts.framesDir, `${name(frame)}.jpg`)
    // The job frames that held this frame are the ones from it onward still sharing its picture
    // (a re-render or a hold relinked them all together). A frame with its own original in
    // `replaced/` was repaired in its own right (a hold onto this one), so it and what follows stay.
    const { ino } = await stat(target)
    const held: string[] = []
    for (const other of names.filter((f) => Number(f.slice(0, 4)) > frame)) {
      if ((await stat(path.join(opts.framesDir, other))).ino !== ino) break
      if (await exists(path.join(replacedDir, other))) break
      held.push(path.join(opts.framesDir, other))
    }
    for (const file of [target, ...held]) await rm(file)
    await rename(kept, target)
    for (const file of held) await link(target, file)
    // A later re-render of this frame must run again, not find this one marked done.
    for (const dir of (await readdir(path.join(opts.takeDir, 'repairs')).catch(() => [] as string[])).filter((d) => /^\d{4}-\d{4}$/.test(d))) {
      const [start, end] = dir.split('-').map(Number)
      if (frame >= start && frame <= end) await rm(path.join(opts.takeDir, 'repairs', dir), { recursive: true, force: true })
    }
    restored.push(target)
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'dream-restore-'))
  try {
    await runCheck(restored, path.join(workDir, 'scores.json'))
    const { scores } = JSON.parse(await readFile(path.join(workDir, 'scores.json'), 'utf8')) as { scores: Record<string, number> }
    const faces = await faceScores(restored)
    await updateCheck(path.join(opts.takeDir, 'check.json'), restored.map((file) => ({ frame: Number(path.basename(file).slice(0, 4)), score: scores[file], face: faces[file] })))
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
  return opts.frames
}

/** Parses `--frames 1735,934-936` into stretches. */
export function parseStretches(value: string): RepairStretch[] {
  return value.split(',').map((part) => {
    const [start, end = start] = part.trim().split('-').map(Number)
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) throw new Error(`Can't read "${part}" as a frame or a range of frames`)
    return { start, end }
  })
}
