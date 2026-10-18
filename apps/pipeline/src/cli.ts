#!/usr/bin/env bun
// Bun loads .env from the cwd automatically — no dotenv package needed.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeClientAssets } from './client-manifest.ts'
import { compose, composePreview } from './compose.ts'
import { gpuServerUrl } from './gpu-server.ts'
import { loadJob, videoPath, type Job } from './job.ts'
import { retryFailedPredictions } from './replicate.ts'
import { backgroundPlate } from './steps/background-plate.ts'
import { stabilizeBackground } from './steps/background-stabilize.ts'
import { backgroundVideo } from './steps/background-video.ts'
import { depth } from './steps/depth.ts'
import { createTake, dream, dreamSamples, loadTake, saveTake, TAKE_STATUSES, type TakeStatus } from './steps/dream.ts'
import { dreamCheck, listDreamFrames, type DreamCheck } from './steps/dream-check.ts'
import { deforumFrames } from './steps/dream-deforum.ts'
import { DEFORUM_COST_PER_FRAME, MAX_REPAIR_ROUNDS, dreamRepair, parseStretches, restoreFrames, type RepairAction } from './steps/dream-repair.ts'
import { dreamDirections } from './steps/dream-directions.ts'
import { init } from './steps/init.ts'
import { matte } from './steps/matte.ts'
import { outline } from './steps/outline.ts'
import { portrait } from './steps/portrait.ts'
import { upscale } from './steps/upscale.ts'
import { words } from './steps/words.ts'

const DEFAULT_CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')

/**
 * Minimal CLI for running one pipeline step at a time against a job
 * directory — enough to test each step in isolation, per phase 3's scope.
 * A single `lysterfield generate` command that chains every step end to
 * end is phase 4's job, once compose.ts and client-manifest writing exist.
 *
 * Every step's input/output is addressed as a path relative to the job
 * root (see job.ts's `framesDir`/`videoPath`), following the numbered
 * per-panel folder layout: `0-source/` (`video.mov` + `frames/`) is the
 * input `init` writes; each panel's final frames are `<n>-<panel>/frames`;
 * `1-words` through `6-outline` are shared across every dream take;
 * `7-dreams/<take>` holds one take's dream frames, its `take.json`, and
 * its own composed/compressed output. Job-wide settings live in
 * `job.json` (see job.ts's `JobConfig`); flags override them.
 * `--input`/`--output` (and per-step flags like `--background`/`--matte`/
 * etc. on `compose`) override the default path for that step; all defaults
 * below assume the previous step in the chain was run with its own
 * defaults.
 *
 * `dream`/`compose` take a `--take` name so a scene can carry several dream
 * attempts side by side under `<job>/7-dreams/<take>/`. `dream` composes
 * and publishes to apps/client automatically once its frames finish
 * generating (pass `--skip-client true` to opt a scratch/test take out of
 * that) — `compose` remains available to (re)publish a take on its own,
 * e.g. after tweaking an earlier panel without regenerating the dream.
 */

const [step, ...rest] = process.argv.slice(2)
const flags = parseFlags(rest)

function requireFlag(name: string): string {
  const value = flags[name]
  if (!value) throw new Error(`--${name} is required for "${step}"`)
  return value
}

/** Resolves a step's input frame directory: `--<flag>` overrides `defaultRelativePath`, both relative to the job root. */
function frameDirFlag(job: Job, defaultRelativePath: string, flag = 'input'): string {
  return path.join(job.dir, flags[flag] ?? defaultRelativePath)
}

/** Resolves a step's output name (passed straight to `framesDir`/`videoPath`, which join it onto the job root themselves): `--output` overrides `defaultRelativePath`. */
function outputFlag(defaultRelativePath: string): string {
  return flags.output ?? defaultRelativePath
}

const concurrency = Number(flags.concurrency ?? 4)
// --on replicate: run on Replicate even when our own GPU server is set up (DEFORUM_URL; gpu-server.ts).
if (flags.on === 'replicate') delete process.env.DEFORUM_URL
else if (flags.on && flags.on !== 'pc') throw new Error('--on must be pc or replicate')
// --on pc asks for the free GPU: never fall back to billing Replicate because DEFORUM_URL is missing.
else if (flags.on === 'pc' && !gpuServerUrl()) throw new Error('--on pc needs DEFORUM_URL set in apps/pipeline/.env')
// --retry true: a person asked to run a failed or cancelled Replicate prediction again. Never set by default.
if (flags.retry === 'true') retryFailedPredictions()

/** `--step-fps` if passed, else the job's own `stepFps` from job.json, else the step's built-in default. */
function stepFpsFlag(job: Job): number | undefined {
  return flags['step-fps'] ? Number(flags['step-fps']) : job.stepFps
}

switch (step) {
  case 'init': {
    const result = await init(requireFlag('job'), {
      sourceVideoPath: requireFlag('source'),
      fps: flags.fps ? Number(flags.fps) : undefined,
      offset: flags.offset ? Number(flags.offset) : undefined,
      length: flags.length ? Number(flags.length) : undefined,
    })
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'matte': {
    const job = await loadJob(requireFlag('job'))
    const sourceVideoPath = await videoPath(job, '0-source/video')
    console.log(JSON.stringify(await matte(job, sourceVideoPath), null, 2))
    break
  }

  case 'portrait': {
    const job = await loadJob(requireFlag('job'))
    const result = await portrait(job, frameDirFlag(job, '0-source/frames'), outputFlag('2-portrait/raw'), concurrency)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'upscale': {
    const job = await loadJob(requireFlag('job'))
    const result = await upscale(
      job,
      frameDirFlag(job, '2-portrait/raw'),
      outputFlag('2-portrait/upscaled'),
      concurrency,
      flags.factor ? Number(flags.factor) : undefined
    )
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'background-plate': {
    const job = await loadJob(requireFlag('job'))
    const result = await backgroundPlate(
      job,
      frameDirFlag(job, '2-portrait/upscaled', 'input'),
      frameDirFlag(job, '4-matte/frames', 'alpha'),
      outputFlag('3-background/plate'),
      concurrency,
      {
        stepFps: stepFpsFlag(job),
        regenerateLeaks: flags['regenerate-leaks'] === 'true',
      }
    )
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'background-stabilize': {
    const job = await loadJob(requireFlag('job'))
    const result = await stabilizeBackground(
      job,
      frameDirFlag(job, '2-portrait/upscaled', 'base'),
      frameDirFlag(job, '3-background/plate', 'input'),
      frameDirFlag(job, '4-matte/frames', 'alpha'),
      outputFlag('3-background/frames'),
      { stepFps: stepFpsFlag(job), concurrency }
    )
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'background-video': {
    // Panel 3 from Bria (the other way to make 3-background/frames). --plan true: free checks and cost only.
    const job = await loadJob(requireFlag('job'))
    const result = await backgroundVideo(
      job,
      frameDirFlag(job, '2-portrait/upscaled', 'input'),
      frameDirFlag(job, '4-matte/frames', 'alpha'),
      outputFlag('3-background/frames'),
      { concurrency, planOnly: flags.plan === 'true', only: flags.chunks?.split(',') }
    )
    console.log(JSON.stringify(result, null, 2))
    if (result.failed.length > 0) process.exitCode = 1
    break
  }
  case 'depth': {
    const job = await loadJob(requireFlag('job'))
    const result = await depth(
      job,
      frameDirFlag(job, '0-source/frames', 'source'),
      frameDirFlag(job, '4-matte/frames', 'alpha'),
      concurrency
    )
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'outline': {
    const job = await loadJob(requireFlag('job'))
    const result = await outline(
      job,
      frameDirFlag(job, '0-source/frames', 'source'),
      frameDirFlag(job, '4-matte/frames', 'alpha'),
      concurrency
    )
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'words': {
    const job = await loadJob(requireFlag('job'))
    console.log(JSON.stringify(await words(job, frameDirFlag(job, '0-source/frames', 'source')), null, 2))
    break
  }

  case 'dream': {
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    // Re-running an existing take picks its settings back up from take.json; flags override.
    const saved = await loadTake(job, take)
    // The full song is the expensive stage: it needs the take's 15s clip approved first
    // (plans/done/frame-preview-approval-tool.md). Takes from before the approval loop have no status.
    if (saved?.status && saved.status !== 'clip-approved' && saved.status !== 'generated' && flags.force !== 'true') {
      throw new Error(`Take "${take}" is "${saved.status}"; the full dream run needs "clip-approved" (or --force true).`)
    }
    const prompt = flags.prompt ?? saved?.prompt
    if (!prompt) throw new Error(`--prompt is required for a new take ("${take}" has no take.json yet)`)
    const result =
      saved?.method === 'deforum'
        ? // The whole song as one chain of Deforum runs: hours long, and safe to stop and start again.
          await deforumFrames(job, take, saved, {
            workDir: path.join(job.dir, `7-dreams/${take}/runs`),
            framesDir: path.join(job.dir, `7-dreams/${take}/frames`),
          })
        : await dream(job, frameDirFlag(job, '0-source/frames', 'source'), {
            prompt,
            take,
            stepFps: flags['step-fps'] ? Number(flags['step-fps']) : (saved?.stepFps ?? job.stepFps),
            concurrency,
            seed: flags.seed ? Number(flags.seed) : saved?.seed,
          })
    if (saved?.status) await saveTake(job, take, { status: 'generated' })
    console.log(JSON.stringify(result, null, 2))

    if (flags['skip-client'] !== 'true') {
      await composeAndPublish(job, take, {
        durationSeconds: flags.duration ? Number(flags.duration) : undefined,
        clientDir: flags['client-dir'] ? path.resolve(flags['client-dir']) : undefined,
      })
    }
    break
  }

  case 'dream-directions': {
    const job = await loadJob(requireFlag('job'))
    const result = await dreamDirections(
      job,
      frameDirFlag(job, '0-source/frames', 'source'),
      requireFlag('brief'),
      flags.count ? Number(flags.count) : undefined
    )
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'dream-take': {
    // Creates a take at "proposed", from a direction (--directions <file> --index <n>) or a bare --prompt.
    // Deforum takes (the legacy dreams' method): --method deforum [--colour <ref in resources/colours>] [--preset <legacy dream>] [--negative <prompt>]
    // [--style <image in resources/colours>] [--style-strength <0-1.5>] [--style-copies look|look-and-content (default look)].
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    let prompt = flags.prompt
    let brief: string | undefined
    let direction: { name: string; palette: string[]; rationale: string } | undefined
    if (flags.directions) {
      const file = JSON.parse(await readFile(path.join(job.dir, '7-dreams/_directions', flags.directions), 'utf8'))
      const picked = file.directions[Number(flags.index ?? 0)]
      if (!picked) throw new Error(`No direction ${flags.index ?? 0} in ${flags.directions}`)
      prompt = picked.prompt
      brief = file.brief
      direction = { name: picked.name, palette: picked.palette, rationale: picked.rationale }
    }
    // With a style image a Deforum take can do without a prompt; createTake fills in a plain landscape.
    if (!prompt && !flags.style) throw new Error('--prompt (or --style for a Deforum take), or --directions <file> --index <n>, is required')
    const method = flags.method as 'flux-kontext' | 'deforum' | undefined
    if (method && method !== 'flux-kontext' && method !== 'deforum') throw new Error('--method must be flux-kontext or deforum')
    const styleStrength = flags['style-strength'] ? Number(flags['style-strength']) : undefined
    if (styleStrength !== undefined && !(styleStrength >= 0 && styleStrength <= 1.5)) throw new Error('--style-strength must be a number from 0 to 1.5')
    const styleCopies = flags['style-copies'] as 'look' | 'look-and-content' | undefined
    if (styleCopies && styleCopies !== 'look' && styleCopies !== 'look-and-content') throw new Error('--style-copies must be look or look-and-content')
    const config = await createTake(job, take, {
      prompt: prompt ?? '',
      brief,
      direction,
      method,
      colour: flags.colour,
      preset: flags.preset,
      style: flags.style,
      styleCopies,
      styleStrength,
      negativePrompt: flags.negative,
      seed: flags.seed ? Number(flags.seed) : undefined,
      stepFps: flags['step-fps'] ? Number(flags['step-fps']) : undefined,
    })
    console.log(JSON.stringify(config, null, 2))
    break
  }

  case 'dream-samples': {
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    const saved = await loadTake(job, take)
    if (saved?.status !== 'proposed' && saved?.status !== 'samples-approved') {
      throw new Error(`Take "${take}" is "${saved?.status}"; samples are for "proposed" takes.`)
    }
    const result = await dreamSamples(job, frameDirFlag(job, '0-source/frames', 'source'), take, concurrency)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'dream-clip': {
    // The 15s test clip: dream frames for job.json's "clip" range (kept for the full run), then a short composite.
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    const saved = await loadTake(job, take)
    if (saved?.status !== 'samples-approved' && saved?.status !== 'clip-approved') {
      throw new Error(`Take "${take}" is "${saved?.status}"; the test clip needs "samples-approved".`)
    }
    if (!job.clip) throw new Error('job.json has no "clip" range ({ "start": <frame>, "frames": <count> }).')
    const sourceFrames = frameDirFlag(job, '0-source/frames', 'source')
    // A Deforum clip is its own chain, kept apart from the full song's frames: each frame depends on
    // the ones before it, so a clip from the middle of the song isn't what the full run will make there.
    let dreamFramesDir = path.join(job.dir, `7-dreams/${take}/frames`)
    if (saved.method === 'deforum') {
      dreamFramesDir = path.join(job.dir, `7-dreams/${take}/preview/dream/frames`)
      await deforumFrames(job, take, saved, {
        range: job.clip,
        warmUp: true,
        workDir: path.join(job.dir, `7-dreams/${take}/preview/dream/runs`),
        framesDir: dreamFramesDir,
      })
    } else {
      await dream(job, sourceFrames, { prompt: saved.prompt, take, stepFps: saved.stepFps, seed: saved.seed, concurrency, range: job.clip })
    }
    const wordsResult = await words(job, sourceFrames)
    const result = await composePreview(
      job,
      {
        wordsFramesDir: wordsResult.framesDir,
        portraitFramesDir: frameDirFlag(job, '2-portrait/upscaled', 'portrait'),
        backgroundFramesDir: frameDirFlag(job, '3-background/frames', 'background'),
        matteFramesDir: frameDirFlag(job, '4-matte/frames', 'matte'),
        depthFramesDir: frameDirFlag(job, '5-depth/frames', 'depth'),
        outlineFramesDir: frameDirFlag(job, '6-outline/frames', 'outline'),
        take,
        dreamFramesDir,
      },
      job.clip
    )
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'take-status': {
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    if (!(await loadTake(job, take))) throw new Error(`Take "${take}" doesn't exist.`)
    const status = flags.status as TakeStatus | undefined
    if (status && !TAKE_STATUSES.includes(status)) throw new Error(`--status must be one of ${TAKE_STATUSES.join(', ')}`)
    const config = await saveTake(job, take, { ...(status && { status }), ...(flags.notes !== undefined && { notes: flags.notes }) })
    console.log(JSON.stringify(config, null, 2))
    break
  }

  case 'dream-check': {
    // Person check over a take's dream frames (local and free). --clip true checks a Deforum take's 15s clip instead of the full song.
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    const dir = path.join(job.dir, '7-dreams', take, flags.clip === 'true' ? 'preview/dream' : '')
    const { scores: _scores, ...summary } = await dreamCheck(path.join(dir, 'frames'), path.join(dir, 'check.json'))
    console.log(JSON.stringify(summary, null, 2))
    break
  }

  case 'dream-repair': {
    // Replaces dream frames that show a person: --frames 1735,934-936 (dream frames, by job frame), or --flagged true for
    // every stretch in check.json. --action rerender (default; a paid Deforum run per stretch, needs --confirm true), hold (free), or restore (free: undo, putting the originals back).
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    const takeDir = path.join(job.dir, '7-dreams', take, flags.clip === 'true' ? 'preview/dream' : '')
    const framesDir = path.join(takeDir, 'frames')
    const action = (flags.action ?? 'rerender') as RepairAction
    if (action !== 'rerender' && action !== 'hold' && action !== 'restore') throw new Error('--action must be rerender, hold or restore')
    const stretches = flags.frames
      ? parseStretches(flags.frames)
      : flags.flagged === 'true'
        ? (JSON.parse(await readFile(path.join(takeDir, 'check.json'), 'utf8')) as DreamCheck).stretches
        : undefined
    if (!stretches) throw new Error('Pass --frames <frame or range, comma-separated> or --flagged true (every stretch in check.json).')
    if (action === 'restore') {
      // Undo: each listed frame's original goes back (every frame in the given ranges that was replaced).
      const replaced = new Set((await readdir(path.join(takeDir, 'replaced')).catch(() => [] as string[])).map((f) => Number(f.slice(0, 4))))
      const frames = [...replaced].filter((f) => stretches.some((s) => f >= s.start && f <= s.end)).sort((a, b) => a - b)
      if (frames.length === 0) throw new Error('None of those frames have been replaced.')
      console.log(JSON.stringify({ restored: await restoreFrames({ takeDir, framesDir, frames }) }, null, 2))
      break
    }
    if (action === 'rerender' && flags.confirm !== 'true') {
      const dreamFrames = await listDreamFrames(framesDir)
      const count = stretches.reduce((sum, s) => sum + dreamFrames.filter((f) => f.frame >= s.start && f.frame <= s.end).length, 0)
      console.log(`Re-rendering ${count} dream frames in ${stretches.length} stretches: about $${(count * DEFORUM_COST_PER_FRAME).toFixed(2)} of GPU time if each comes out clean first time, up to $${(count * DEFORUM_COST_PER_FRAME * 3 * MAX_REPAIR_ROUNDS).toFixed(2)} if every one needs all ${MAX_REPAIR_ROUNDS} rounds and retries. Pass --confirm true to go ahead.`)
      break
    }
    // --again <ms>: re-render stretches that were re-rendered before that time (their result still shows a person).
    const again = flags.again === undefined ? undefined : Number(flags.again)
    if (again !== undefined && !Number.isFinite(again)) throw new Error('--again takes the time the re-render was asked for, in ms (e.g. Date.now()).')
    const results = await dreamRepair(job, take, { takeDir, framesDir, stretches, action, again })
    console.log(JSON.stringify(results, null, 2))
    break
  }

  case 'compose': {
    const job = await loadJob(requireFlag('job'))
    const take = requireFlag('take')
    await composeAndPublish(job, take, {
      id: flags.id,
      durationSeconds: flags.duration ? Number(flags.duration) : undefined,
      skipClient: flags['skip-client'] === 'true',
      clientDir: flags['client-dir'] ? path.resolve(flags['client-dir']) : undefined,
    })
    break
  }

  default:
    console.error(
      `Usage: bun run src/cli.ts <init|words|matte|portrait|upscale|background-plate|background-stabilize|background-video|depth|outline|dream-directions|dream-take|dream-samples|dream-clip|dream-check|dream-repair|take-status|dream|compose> --job <dir> [options]`
    )
    process.exit(1)
}

/**
 * Shared by `dream` (auto-publish every take immediately once its frames
 * finish generating) and `compose` (re-publish a take on its own, e.g.
 * after tweaking an earlier shared panel). Published `id` defaults to the
 * take name itself — pass `--id` on `compose` to publish under a different
 * apps/client id without renaming the take.
 */
async function composeAndPublish(
  job: Job,
  take: string,
  opts: { id?: string; durationSeconds?: number; skipClient?: boolean; clientDir?: string }
): Promise<void> {
  const id = opts.id ?? take
  // Panel 1 is free and local, so it's made here on first compose if `words` hasn't been run yet (skipped once its frames exist).
  const wordsResult = await words(job, frameDirFlag(job, '0-source/frames', 'source'))
  const result = await compose(job, {
    wordsFramesDir: wordsResult.framesDir,
    portraitFramesDir: frameDirFlag(job, '2-portrait/upscaled', 'portrait'),
    backgroundFramesDir: frameDirFlag(job, '3-background/frames', 'background'),
    matteFramesDir: frameDirFlag(job, '4-matte/frames', 'matte'),
    depthFramesDir: frameDirFlag(job, '5-depth/frames', 'depth'),
    outlineFramesDir: frameDirFlag(job, '6-outline/frames', 'outline'),
    take,
    dreamFramesDir: path.join(job.dir, `7-dreams/${take}/frames`),
    durationSeconds: opts.durationSeconds,
  })
  console.log(JSON.stringify(result, null, 2))

  if (!opts.skipClient) {
    const clientDir = opts.clientDir ?? DEFAULT_CLIENT_DIR
    await writeClientAssets(clientDir, id, result)
    console.log(`Wrote client assets for "${id}" to ${clientDir}`)
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!key.startsWith('--')) throw new Error(`Expected a --flag, got "${key}"`)
    flags[key.slice(2)] = args[i + 1]
  }
  return flags
}
