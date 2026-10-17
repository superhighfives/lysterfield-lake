import { copyFile, link, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exists, framesDir, listFrames, type Job } from '../job.ts'
import { MODELS } from '../models.ts'
import { readFileAsInput, runModelToFile } from '../replicate.ts'
import { assertLandscapePrompt, deforumSamples } from './dream-deforum.ts'

export interface DreamResult {
  framesDir: string
}

export interface DreamOptions {
  /** Describes the reimagined look — the one creative choice that varies per take, so it's a caller-supplied prompt rather than a fixed constant like artwork.ts's. `NO_PEOPLE_SUFFIX` is always appended on top of this — never rely on this prompt alone to keep people out. */
  prompt: string
  /** Name for this dream attempt — written to `7-dreams/<take>/frames/`, never overwriting another take. */
  take: string
  /** How many of the real per-second frames actually get regenerated; the rest hold the nearest one. Matches panel 3's stepped cadence (background-stabilize.ts) and the legacy Deforum dreaming lane's own ~10fps generation rate — a deliberate stop-motion look, not a cost-saving shortcut. */
  stepFps?: number
  concurrency?: number
  /** Fixed across every keyframe call so consecutive frames don't pick up unrelated color/composition drift from flux-kontext-dev's own random seed — same reasoning as background-plate.ts's fixed seed. */
  seed?: number
  /** Only generate this stretch (first frame, 1-based, and frame count) — `dream-clip`'s test clip. Keyframes stay on the same global `stepFps` grid, so a later full run reuses them. */
  range?: { start: number; frames: number }
}

/**
 * Where a take is in the preview/approval loop
 * (plans/done/frame-preview-approval-tool.md). Each stage needs the one
 * before it approved; the full `dream` run needs `clip-approved`.
 */
export const TAKE_STATUSES = ['proposed', 'samples-approved', 'clip-approved', 'generated', 'rejected'] as const
export type TakeStatus = (typeof TAKE_STATUSES)[number]

/** A take's settings and review state, saved to `7-dreams/<take>/take.json` so the take always remembers what made it. */
export interface TakeConfig {
  /** The caller's prompt, or `STYLE_ONLY_PROMPT` for a Deforum take made from a style image alone. */
  prompt: string
  seed: number
  stepFps: number
  /** Unset on takes made before the approval loop existed. */
  status?: TakeStatus
  /** The brief the take's direction came from, if any. */
  brief?: string
  /** The direction this take was made from (`dream-directions`), minus the prompt, which is above. */
  direction?: { name: string; palette: string[]; rationale: string }
  /** Reviewer notes, free text. */
  notes?: string
  /** How the dream is made: flux-kontext keyframes (default) or Deforum, the legacy dreams' method (dream-deforum.ts). */
  method?: 'flux-kontext' | 'deforum'
  /** Deforum: colour reference, a file in `resources/colours/` (or a path inside the take folder); unset = colours follow the footage. */
  colour?: string
  /** Deforum: which legacy dream's settings to start from (models/deforum/settings/). */
  preset?: string
  /** Deforum: style reference (IP-Adapter), an image in `resources/colours/` (or inside the take folder): every frame is steered towards its look (and, with `styleCopies`, its content too), not just its colours. */
  style?: string
  /** Deforum: how strongly the style reference steers each frame, 0 to 1.5 (default 1.0 for its look only, 0.6 with its content). */
  styleStrength?: number
  /** Deforum: what the style reference carries over: its look only (colour, texture, medium; the default) or its look and content (its buildings, figures, objects). */
  styleCopies?: 'look' | 'look-and-content'
  /** Deforum: extra negative prompt, added to the legacy dreams' own (no people, faces, bodies...), which always applies. */
  negativePrompt?: string
}

const DEFAULT_STEP_FPS = 6
/**
 * The prompt for a Deforum take with a style image and no prompt of its own. Deforum always needs
 * some text (every frame is diffused with it, and its CLIP guidance pulls towards it), so this is a
 * plain landscape that leaves the look to the style image.
 */
export const STYLE_ONLY_PROMPT = 'a beautiful landscape, detailed, soft light'
const DEFAULT_SEED = 42

function takePath(job: Job, take: string): string {
  return path.join(job.dir, '7-dreams', take, 'take.json')
}

/** Reads a take's saved settings, or undefined for a take that hasn't been started. */
export async function loadTake(job: Job, take: string): Promise<TakeConfig | undefined> {
  if (!(await exists(takePath(job, take)))) return undefined
  return JSON.parse(await readFile(takePath(job, take), 'utf8'))
}

/** Writes a take's `take.json`, merging into whatever is already there. */
export async function saveTake(job: Job, take: string, update: Partial<TakeConfig>): Promise<TakeConfig> {
  const merged = { ...(await loadTake(job, take)), ...update } as TakeConfig
  await mkdir(path.dirname(takePath(job, take)), { recursive: true })
  await writeFile(takePath(job, take), `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

/** Creates a new take at `proposed` from a prompt (and optionally the direction it came from). Refuses to overwrite an existing take. */
export async function createTake(
  job: Job,
  take: string,
  init: {
    prompt: string
    seed?: number
    stepFps?: number
    brief?: string
    direction?: TakeConfig['direction']
    method?: TakeConfig['method']
    colour?: string
    preset?: string
    style?: string
    styleStrength?: number
    styleCopies?: 'look' | 'look-and-content'
    negativePrompt?: string
  }
): Promise<TakeConfig> {
  if (await loadTake(job, take)) throw new Error(`Take "${take}" already exists — pick a new name.`)
  const prompt = init.prompt.trim() || (init.method === 'deforum' && init.style ? STYLE_ONLY_PROMPT : '')
  if (!prompt) throw new Error('A take needs a prompt (or, for Deforum, a style image).')
  if (init.method === 'deforum') assertLandscapePrompt(prompt)
  return saveTake(job, take, {
    prompt,
    seed: init.seed ?? DEFAULT_SEED,
    stepFps: init.stepFps ?? job.stepFps ?? DEFAULT_STEP_FPS,
    status: 'proposed',
    brief: init.brief,
    direction: init.direction,
    method: init.method,
    colour: init.colour,
    preset: init.preset,
    style: init.style,
    styleStrength: init.styleStrength,
    styleCopies: init.style ? (init.styleCopies ?? 'look') : undefined,
    negativePrompt: init.negativePrompt,
  })
}

/**
 * Always appended to the caller-supplied prompt, never left to the caller
 * to remember — both `dream-styletransfer-v2` and `dream-styletransfer-
 * v2-fixed` in `real-15s-60fps` came back showing a recognisable person
 * because the per-take prompt alone didn't hold the line. Panel 7 must
 * always read as an abstract repainting of the scene's shapes/light/colour,
 * never a person, no matter what creative direction a take's own prompt
 * asks for.
 */
const NO_PEOPLE_SUFFIX =
  " Abstract painterly reinterpretation of the scene's shapes, light, and colour only — dissolve any person, face, or human figure completely into brushwork, texture, and form indistinguishable from the rest of the scene. Never depict a recognisable person or body."

/** One dream keyframe: a real Replicate call, so callers must check the output doesn't exist first. */
async function dreamFrame(sourcePath: string, outputPath: string, prompt: string, seed: number): Promise<void> {
  await runModelToFile(
    MODELS.dream,
    {
      input_image: await readFileAsInput(sourcePath),
      prompt: prompt + NO_PEOPLE_SUFFIX,
      aspect_ratio: 'match_input_image',
      guidance: 2.5,
      seed,
    },
    outputPath,
    { jpegQuality: 90 }
  )
}

/** Hard-links `from` to `to`, copying only when a link can't cross filesystems. */
async function linkOrCopy(from: string, to: string): Promise<void> {
  await link(from, to).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EXDEV') throw error
    return copyFile(from, to)
  })
}

/**
 * `black-forest-labs/flux-kontext-dev`, once per kept frame — see
 * `models.ts` for why this replaced Kling. Checked against the real
 * Deforum output on the external drive: past the first handful of frames,
 * the legacy dreaming lane's `hybrid_composite` keeps the animation's
 * structure/layout locked to the real footage (a boardwalk stays a
 * boardwalk) while fully repainting it — this reproduces that by feeding
 * each *real* kept frame straight to an image-editing model with a
 * structure-preserving prompt, rather than generating from a single
 * start frame and letting a video model extrapolate motion on its own
 * (Kling's approach, and the reason it couldn't track real per-frame
 * content no matter the prompt).
 *
 * Only every `stepFps`-th frame is actually generated (a real Replicate
 * call); every frame in between holds that frame's output — same
 * held-cadence idea as `background-stabilize.ts`, but without motion-
 * compensated masking, since there's no cutout region here: the whole
 * frame is replaced, so a hard hold reads as the same deliberate
 * stepped/stop-motion look the legacy pipeline's own ~10fps dreaming
 * generation had, not a flaw to smooth over.
 */
export async function dream(job: Job, sourceFramesDir: string, opts: DreamOptions): Promise<DreamResult> {
  const stepFps = opts.stepFps ?? DEFAULT_STEP_FPS
  const concurrency = opts.concurrency ?? 4
  const seed = opts.seed ?? DEFAULT_SEED

  if (job.fps % stepFps !== 0) {
    throw new Error(`job.fps (${job.fps}) must be an exact multiple of stepFps (${stepFps})`)
  }
  const interval = job.fps / stepFps

  const outputDir = await framesDir(job, `7-dreams/${opts.take}/frames`)
  const saved = await loadTake(job, opts.take)
  if (saved && (saved.prompt !== opts.prompt || saved.seed !== seed || saved.stepFps !== stepFps) && (await listFrames(outputDir)).length > 0) {
    throw new Error(
      `Take "${opts.take}" already has frames made with different settings (${JSON.stringify(saved)}) — use a new --take name rather than mixing two looks in one take.`
    )
  }
  await saveTake(job, opts.take, { prompt: opts.prompt, seed, stepFps })

  const frames = await listFrames(sourceFramesDir)
  if (frames.length === 0) throw new Error(`No frames found in ${sourceFramesDir}`)

  // Indices are 0-based into `frames`; a range's start is a 1-based frame number.
  const first = opts.range ? opts.range.start - 1 : 0
  const end = opts.range ? Math.min(frames.length, first + opts.range.frames) : frames.length
  const keyframeIndices: number[] = []
  for (let i = Math.ceil(first / interval) * interval; i < end; i += interval) keyframeIndices.push(i)

  let cursor = 0
  async function worker() {
    while (cursor < keyframeIndices.length) {
      const frame = frames[keyframeIndices[cursor++]]
      const outputPath = path.join(outputDir, frame)
      if (await exists(outputPath)) continue
      await dreamFrame(path.join(sourceFramesDir, frame), outputPath, opts.prompt, seed)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  // Hold each keyframe's output across the rest of its window. Held frames
  // are hard links, not copies: the frame sequence stays complete for
  // compose, but only the keyframes take up disk space. A link shares the
  // keyframe's file, so replace a keyframe (delete + rewrite) rather than
  // editing it in place, or its held frames change with it.
  for (const i of keyframeIndices) {
    const keyframeOutputPath = path.join(outputDir, frames[i])
    for (let j = i + 1; j < Math.min(i + interval, frames.length); j++) {
      const heldPath = path.join(outputDir, frames[j])
      if (!(await exists(heldPath))) await linkOrCopy(keyframeOutputPath, heldPath)
    }
  }
  // A range that doesn't start on a keyframe still needs its first frames.
  if (opts.range && first % interval !== 0) {
    const before = first - (first % interval)
    const keyframeOutputPath = path.join(outputDir, frames[before])
    if (!(await exists(keyframeOutputPath))) await dreamFrame(path.join(sourceFramesDir, frames[before]), keyframeOutputPath, opts.prompt, seed)
    for (let j = first; j < Math.min(before + interval, end); j++) {
      const heldPath = path.join(outputDir, frames[j])
      if (!(await exists(heldPath))) await linkOrCopy(keyframeOutputPath, heldPath)
    }
  }

  return { framesDir: outputDir }
}

export interface DreamSamplesResult {
  samplesDir: string
  samples: { frame: number; label: string; path: string }[]
}

/**
 * Generates the take's look on the job's fixed sample frames only
 * (`job.json` `samples`), into `7-dreams/<take>/samples/`. A sample that
 * sits on a `stepFps` keyframe is also linked into the take's `frames/`, so
 * the clip and full runs reuse it instead of paying for it again.
 */
export async function dreamSamples(job: Job, sourceFramesDir: string, take: string, concurrency = 4): Promise<DreamSamplesResult> {
  const config = await loadTake(job, take)
  if (!config) throw new Error(`Take "${take}" doesn't exist — create it from a direction first.`)
  if (!job.samples?.length) throw new Error(`job.json has no "samples" — add the frames every direction is judged on.`)
  if (config.method === 'deforum') return deforumSamples(job, take, config)

  const samplesDir = await framesDir(job, `7-dreams/${take}/samples`)
  const framesOut = await framesDir(job, `7-dreams/${take}/frames`)
  const interval = job.fps / config.stepFps
  const samples = job.samples.map((s) => ({ ...s, name: `${String(s.frame).padStart(4, '0')}.jpg` }))

  let cursor = 0
  async function worker() {
    while (cursor < samples.length) {
      const sample = samples[cursor++]
      const outputPath = path.join(samplesDir, sample.name)
      if (!(await exists(outputPath))) {
        await dreamFrame(path.join(sourceFramesDir, sample.name), outputPath, config!.prompt, config!.seed)
      }
      const keyframePath = path.join(framesOut, sample.name)
      if ((sample.frame - 1) % interval === 0 && !(await exists(keyframePath))) await linkOrCopy(outputPath, keyframePath)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  return {
    samplesDir,
    samples: samples.map(({ frame, label, name }) => ({ frame, label, path: path.join(samplesDir, name) })),
  }
}
