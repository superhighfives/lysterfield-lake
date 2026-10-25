import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listFrames } from '../job.ts'

/**
 * Finds the dream (panel 7) frames that show a person, so a take can be
 * repaired without anyone looking at every frame
 * (plans/in-progress/dreams.md). "A person" means a literal one, hands, or
 * a paper cut-out of the subject; a shape that merely looks like a person
 * (an ink-wash bust, a rock where the head was) is the intended look. Deforum leaks a person into a few percent
 * of frames whatever the negative prompt says; the ten legacy dreams did
 * too, and were cleaned by hand.
 *
 * Two scores, both run locally with `uv`: no Replicate calls, so this is
 * free and safe to run again at any time. A frame is flagged if either is
 * over its threshold.
 *
 * - The person score, `models/person-check/check.py`: CLIP and a small
 *   classifier trained on the 2023 keep/replace decisions. It catches
 *   people from behind, hands and cut-outs, but it learned that a face
 *   painted on a bust is the bust.
 * - The face score, `models/face-check/check.py`: a face detector trained
 *   on real and illustrated faces, which catches those painted faces.
 *   Never fed back into the reroll or a re-render's rounds: a search
 *   against it would find the faces it misses (plans/in-progress/dreams.md,
 *   "The check misses painted faces").
 */
const MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'models')
const CHECK_SCRIPT = path.join(MODELS_DIR, 'person-check', 'check.py')
const FACE_SCRIPT = path.join(MODELS_DIR, 'face-check', 'check.py')

/**
 * A frame with a person score above this is flagged. 0.35 was
 * cross-validated on the 2023 decisions (97% of the frames replaced then,
 * 1% of those kept), but the Deforum reroll keeps frames at or under 0.35,
 * so on a new take that threshold only re-reads the reroll's own verdict:
 * Sharp Edges had 187 frames between 0.30 and 0.35, many of them faces.
 * 0.18 sits well under the reroll's line. On a hand-labelled set of 327
 * frames from the published dreams, together with the face score below, it
 * catches 57 of 72 frames with a person (51 of 62 with a face), and 5 of 255
 * without, none of them busts or silhouettes. Set low on purpose: a false
 * alarm is one more stretch to glance at, a miss is a person in a
 * published dream.
 */
export const PERSON_SCORE_THRESHOLD = 0.18

/** A frame with a face score above this is flagged (the same 327-frame set as above). */
export const FACE_SCORE_THRESHOLD = 0.5

export interface FlaggedStretch {
  /** First and last flagged frame, by frame number as named in the frames folder. */
  start: number
  end: number
  /** Dream frames in the stretch. */
  frames: number
  /** Highest person score in the stretch. */
  peak: number
  /** Highest face score in the stretch (absent in checks from before the face check). */
  facePeak?: number
}

export interface DreamCheck {
  model: string
  threshold: number
  faceModel?: string
  faceThreshold?: number
  /** Dream frames scored. A frame held over several job frames counts once. */
  frames: number
  flagged: number
  stretches: FlaggedStretch[]
  /** Person score per dream frame, keyed by the frame number it first appears at. */
  scores: Record<string, number>
  /** Face score per dream frame, keyed the same way (absent in checks from before the face check). */
  faces?: Record<string, number>
}

export interface ScoredFrame {
  frame: number
  score: number
  face?: number
}

export interface Thresholds {
  threshold: number
  faceThreshold?: number
}

/** Whether a frame's scores flag it: either over its threshold. */
export function isFlagged({ score, face }: Omit<ScoredFrame, 'frame'>, { threshold, faceThreshold = FACE_SCORE_THRESHOLD }: Thresholds): boolean {
  return score > threshold || (face ?? 0) > faceThreshold
}

/** A check's frames with both their scores, in frame order. */
export function scoredFrames(check: Pick<DreamCheck, 'scores' | 'faces'>): ScoredFrame[] {
  return Object.entries(check.scores)
    .map(([frame, score]) => ({ frame: Number(frame), score, face: check.faces?.[frame] }))
    .sort((a, b) => a.frame - b.frame)
}

/** Groups flagged frames into stretches of neighbouring dream frames. `scored` must be in frame order. */
export function flaggedStretches(scored: ScoredFrame[], thresholds: Thresholds): FlaggedStretch[] {
  const stretches: FlaggedStretch[] = []
  let open: FlaggedStretch | undefined
  for (const scoredFrame of scored) {
    const { frame, score, face } = scoredFrame
    if (!isFlagged(scoredFrame, thresholds)) {
      open = undefined
      continue
    }
    if (open) {
      open.end = frame
      open.frames++
      open.peak = Math.max(open.peak, score)
      if (face !== undefined) open.facePeak = Math.max(open.facePeak ?? 0, face)
    } else {
      open = { start: frame, end: frame, frames: 1, peak: score, ...(face !== undefined && { facePeak: face }) }
      stretches.push(open)
    }
  }
  return stretches
}

/**
 * Free disk space a check or repair needs before it starts. The scores
 * themselves are small, but the model run writes Metal caches to the system
 * temp folder, and a full disk fails a check only after it has scored every
 * frame (or a re-render only after it has been paid for).
 */
const MIN_FREE_BYTES = 2 * 1024 ** 3

/** Refuses to start `what` when the temp folder's or the job's disk has less than `MIN_FREE_BYTES` free. */
export async function assertFreeSpace(what: string, dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    const { bavail, bsize } = await statfs(dir)
    const free = bavail * bsize
    if (free < MIN_FREE_BYTES) {
      throw new Error(`Only ${(free / 1024 ** 3).toFixed(1)}GB free on the disk holding ${dir}. ${what} needs at least ${MIN_FREE_BYTES / 1024 ** 3}GB, so free some space and try again.`)
    }
  }
}

function runScript(script: string, what: string, paths: string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', '--quiet', script, '--out', outPath], { stdio: ['pipe', 'inherit', 'inherit'] })
    child.on('error', (error) => reject(new Error(`Couldn't run uv (needed for the ${what}): ${error.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`The ${what} exited with code ${code}`))))
    child.stdin.end(paths.join('\n'))
  })
}

/** Person scores for `paths`, written to `outPath` as `{ model, scores: { <path>: 0..1 } }`. */
export function runCheck(paths: string[], outPath: string): Promise<void> {
  return runScript(CHECK_SCRIPT, 'person check', paths, outPath)
}

/** Face scores for `paths`, written to `outPath` as `{ model, scores: { <path>: 0..1 }, boxes }`. */
export function runFaceCheck(paths: string[], outPath: string): Promise<void> {
  return runScript(FACE_SCRIPT, 'face check', paths, outPath)
}

/** Face scores for `paths`, by path: for scoring a few frames again after a repair. */
export async function faceScores(paths: string[]): Promise<Record<string, number>> {
  if (paths.length === 0) return {}
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'face-check-'))
  try {
    await runFaceCheck(paths, path.join(workDir, 'faces.json'))
    return (JSON.parse(await readFile(path.join(workDir, 'faces.json'), 'utf8')) as { scores: Record<string, number> }).scores
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

export interface DreamFrame {
  /** The job frame the dream frame first appears at. */
  frame: number
  file: string
  /** The job frames after it that hold the same picture (hard links to `file`). */
  holds: number[]
}

/**
 * A take's dream frames, in order. A dream frame is held over several job
 * frames as hard links to one file (`deforumFrames`, and the legacy
 * import), so each is listed once, under the first frame number it appears
 * at.
 */
export async function listDreamFrames(dreamFramesDir: string): Promise<DreamFrame[]> {
  const byInode = new Map<number, DreamFrame>()
  for (const name of await listFrames(dreamFramesDir)) {
    const file = path.join(dreamFramesDir, name)
    const frame = Number(path.basename(name, path.extname(name)))
    const { ino } = await stat(file)
    const first = byInode.get(ino)
    if (first) first.holds.push(frame)
    else byInode.set(ino, { frame, file, holds: [] })
  }
  return [...byInode.values()]
}

/** Scores every dream frame in `dreamFramesDir` and writes the result to `outPath` (`check.json`). */
export async function dreamCheck(dreamFramesDir: string, outPath: string, threshold = PERSON_SCORE_THRESHOLD, faceThreshold = FACE_SCORE_THRESHOLD): Promise<DreamCheck> {
  const unique = await listDreamFrames(dreamFramesDir)
  if (unique.length === 0) throw new Error(`No dream frames in ${dreamFramesDir}`)
  await assertFreeSpace('The person check', [os.tmpdir(), path.dirname(outPath)])

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'dream-check-'))
  try {
    const scoresPath = path.join(workDir, 'scores.json')
    const facesPath = path.join(workDir, 'faces.json')
    const files = unique.map((u) => u.file)
    await runCheck(files, scoresPath)
    await runFaceCheck(files, facesPath)
    type Raw = { model: string; scores: Record<string, number> }
    const raw = JSON.parse(await readFile(scoresPath, 'utf8')) as Raw
    const rawFaces = JSON.parse(await readFile(facesPath, 'utf8')) as Raw
    const scored = unique.map((u) => {
      const score = raw.scores[u.file]
      const face = rawFaces.scores[u.file]
      if (score === undefined) throw new Error(`The person check returned no score for ${u.file}`)
      if (face === undefined) throw new Error(`The face check returned no score for ${u.file}`)
      return { frame: u.frame, score, face }
    })
    const stretches = flaggedStretches(scored, { threshold, faceThreshold })
    const key = (frame: number) => String(frame).padStart(4, '0')
    const result: DreamCheck = {
      model: raw.model,
      threshold,
      faceModel: rawFaces.model,
      faceThreshold,
      frames: scored.length,
      flagged: stretches.reduce((sum, s) => sum + s.frames, 0),
      stretches,
      scores: Object.fromEntries(scored.map((s) => [key(s.frame), s.score])),
      faces: Object.fromEntries(scored.map((s) => [key(s.frame), s.face])),
    }
    await writeFile(outPath, JSON.stringify(result, null, 2) + '\n')
    return result
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
