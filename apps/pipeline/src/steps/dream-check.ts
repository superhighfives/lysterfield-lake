import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
 * The score comes from `models/person-check/check.py` (CLIP and a small
 * classifier trained on the 2023 keep/replace decisions),
 * run locally with `uv`: no Replicate calls, so this is free and safe to
 * run again at any time.
 */
const CHECK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'models', 'person-check', 'check.py')

/**
 * A frame scoring above this is flagged. Cross-validated on the ten legacy
 * dreams' pre-repair videos (21,480 frames): 0.35 flags 97% of the 1,322
 * frames replaced by hand in 2023 and 1% of the frames that were kept, most
 * of those in paper-planes, where people were missed at the time. Set low
 * on purpose: a false alarm is one more stretch to glance at, a miss is a
 * person in a published dream. Re-check it with `models/person-check/train.py`
 * whenever the classifier is retrained.
 */
export const PERSON_SCORE_THRESHOLD = 0.35

export interface FlaggedStretch {
  /** First and last flagged frame, by frame number as named in the frames folder. */
  start: number
  end: number
  /** Dream frames in the stretch. */
  frames: number
  /** Highest score in the stretch. */
  peak: number
}

export interface DreamCheck {
  model: string
  threshold: number
  /** Dream frames scored. A frame held over several job frames counts once. */
  frames: number
  flagged: number
  stretches: FlaggedStretch[]
  /** Score per dream frame, keyed by the frame number it first appears at. */
  scores: Record<string, number>
}

/** Groups flagged frames into stretches of neighbouring dream frames. `scored` must be in frame order. */
export function flaggedStretches(scored: { frame: number; score: number }[], threshold: number): FlaggedStretch[] {
  const stretches: FlaggedStretch[] = []
  let open: FlaggedStretch | undefined
  for (const { frame, score } of scored) {
    if (score <= threshold) {
      open = undefined
      continue
    }
    if (open) {
      open.end = frame
      open.frames++
      open.peak = Math.max(open.peak, score)
    } else {
      open = { start: frame, end: frame, frames: 1, peak: score }
      stretches.push(open)
    }
  }
  return stretches
}

function runCheck(paths: string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', '--quiet', CHECK_SCRIPT, '--out', outPath], { stdio: ['pipe', 'inherit', 'inherit'] })
    child.on('error', (error) => reject(new Error(`Couldn't run uv (needed for the person check): ${error.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`The person check exited with code ${code}`))))
    child.stdin.end(paths.join('\n'))
  })
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
export async function dreamCheck(dreamFramesDir: string, outPath: string, threshold = PERSON_SCORE_THRESHOLD): Promise<DreamCheck> {
  const unique = await listDreamFrames(dreamFramesDir)
  if (unique.length === 0) throw new Error(`No dream frames in ${dreamFramesDir}`)

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'dream-check-'))
  try {
    const scoresPath = path.join(workDir, 'scores.json')
    await runCheck(unique.map((u) => u.file), scoresPath)
    const raw = JSON.parse(await readFile(scoresPath, 'utf8')) as { model: string; scores: Record<string, number> }
    const scored = unique.map((u) => {
      const score = raw.scores[u.file]
      if (score === undefined) throw new Error(`The person check returned no score for ${u.file}`)
      return { frame: u.frame, score }
    })
    const stretches = flaggedStretches(scored, threshold)
    const result: DreamCheck = {
      model: raw.model,
      threshold,
      frames: scored.length,
      flagged: stretches.reduce((sum, s) => sum + s.frames, 0),
      stretches,
      scores: Object.fromEntries(scored.map((s) => [String(s.frame).padStart(4, '0'), s.score])),
    }
    await writeFile(outPath, JSON.stringify(result, null, 2) + '\n')
    return result
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
