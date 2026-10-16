/**
 * Finds the frames of the ten published (legacy) dreams that are 2023 RIFE
 * morphs rather than real Deforum frames, and writes them to each dream's
 * `7-dreams/<id>/morphs.json` (plans/in-progress/dreams.md).
 *
 * In 2023, frames that showed a person were deleted by hand and the gaps
 * filled by interpolating (RIFE) between the frames either side. Those fills
 * were written later than the run itself, so a frame whose file is newer than
 * a frame after it is a morph. Each dream's legacy run is found by its seed;
 * a legacy frame is mapped to the job frame that first shows it the same way
 * the dreams were imported (phase 4e: job frame n shows real frame
 * floor(map[n] / 6) + 1).
 *
 * Usage: bun run scripts/legacy-morphs.ts --job .jobs/full-video
 *   [--dreaming /Volumes/HDD/lysterfield-lake-pipeline/video-final/dreaming]
 *   [--map .jobs/spikes/full-video-panel3/legacy-frame-map.json]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const flags = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []))
const jobDir = path.resolve(flags.job ?? '.jobs/full-video')
const dreaming = flags.dreaming ?? '/Volumes/HDD/lysterfield-lake-pipeline/video-final/dreaming'
const map = JSON.parse(readFileSync(path.resolve(flags.map ?? '.jobs/spikes/full-video-panel3/legacy-frame-map.json'), 'utf8')) as number[]
if (!existsSync(dreaming)) throw new Error(`No legacy dreams at ${dreaming}: is the HDD mounted?`)

const LAST_REAL_FRAME = 2147
/** The job frame (1-based, as frames are named) that first shows each legacy real frame. */
const firstJobFrame = new Map<number, number>()
map.forEach((legacyFrame, n) => {
  const k = Math.min(Math.floor(legacyFrame / 6) + 1, LAST_REAL_FRAME)
  if (!firstJobFrame.has(k)) firstJobFrame.set(k, n + 1)
})

const runs = readdirSync(dreaming).filter((d) => /^\d{14}$/.test(d))
const seedOf = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { seed?: number }).seed
const runBySeed = new Map<number, string>()
for (const d of runs) {
  const seed = seedOf(path.join(dreaming, d, `${d}_settings.txt`))
  if (seed === undefined) continue
  const other = runBySeed.get(seed)
  if (other) throw new Error(`Legacy runs ${other} and ${d} share seed ${seed}`)
  runBySeed.set(seed, d)
}

for (const id of readdirSync(path.join(jobDir, '7-dreams'))) {
  const settings = path.join(jobDir, '7-dreams', id, 'original', 'deforum-settings.txt')
  if (!existsSync(settings)) continue
  const seed = seedOf(settings)
  if (seed === undefined) {
    console.log(`${id}: no seed in its deforum settings`)
    continue
  }
  const run = runBySeed.get(seed)
  if (!run) {
    console.log(`${id}: no legacy run with its seed`)
    continue
  }
  const frames = readdirSync(path.join(dreaming, run))
    .filter((f) => new RegExp(`^${run}_\\d{5}\\.png$`).test(f))
    .sort()
  const mtimes = frames.map((f) => statSync(path.join(dreaming, run, f)).mtimeMs)
  // Walking back from the end, a frame written after a later frame was filled in afterwards.
  const morphs: number[] = []
  let earliest = Infinity
  for (let i = frames.length - 1; i >= 0; i--) {
    if (mtimes[i] > earliest + 1000) morphs.push(Number(frames[i].slice(-9, -4)))
    else earliest = mtimes[i]
  }
  const jobFrames = [...new Set(morphs.map((k) => firstJobFrame.get(k)).filter((f): f is number => f !== undefined))].sort((a, b) => a - b)
  writeFileSync(path.join(jobDir, '7-dreams', id, 'morphs.json'), `${JSON.stringify({ source: run, frames: jobFrames }, null, 2)}\n`)
  console.log(`${id}: ${jobFrames.length} morph frames (legacy run ${run})`)
}
