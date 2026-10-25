import { execFile } from 'node:child_process'
import { access, rename, rm, unlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'
import path from 'node:path'
import { compileFramesToVideo, firstFrame, videoPath, type Job } from './job.ts'
import { AUDIO_PATH } from './resources.ts'

const execFileAsync = promisify(execFile)

const PANEL_SIZE = 1024
export interface ComposeInput {
  /** words.ts output (panel 1) */
  wordsFramesDir: string
  /** upscale.ts output on the raw portrait (panel 2) frames */
  portraitFramesDir: string
  /** Panel 3's final frames (`3-background/frames`): background-stabilize.ts output, or a video-removal model's output written there instead (full-video used Bria — see plans/in-progress/phase-4e-full-video-source-prep.md) */
  backgroundFramesDir: string
  matteFramesDir: string
  depthFramesDir: string
  outlineFramesDir: string
  /** Which dream attempt to composite — every output below is written under `7-dreams/<take>/`. */
  take: string
  /** dream.ts output — a per-take frames folder, same shape as every other panel. */
  dreamFramesDir: string
}

export interface ComposeResult {
  /** `7-dreams/<take>/final/`: the chooser's assets for the take. */
  finalDir: string
  /** 5s loop clip cropped from the dream panel — apps/client's choose-screen asset. */
  loopPath: string
  /** apps/client's choose-screen thumbnail, from the dream panel's first frame. */
  heroImagePath: string
}

/**
 * Compiles each panel's frames into its panel video, which `composeSplit`
 * stacks into the shared main video (panels 1-6) and each take's dream
 * video (panel 7), plus the chooser's loop and hero image from the dream.
 *
 * Each panel's compiled video lives under that panel's own numbered folder
 * (`1-words/video/panel.mov`, etc.) — shared across every take for
 * panels 1-6, since their frame inputs don't depend on which dream take is
 * selected; panel 7's compile and every output below it lives under
 * `7-dreams/<take>/` instead, since the dream frames themselves are the
 * one thing that varies per take.
 */
export async function compose(job: Job, input: ComposeInput): Promise<ComposeResult> {
  await normalizePanel(job, '1-words', input.wordsFramesDir, 'jpg')
  await normalizePanel(job, '2-portrait', input.portraitFramesDir, 'jpg')
  await normalizePanel(job, '3-background', input.backgroundFramesDir, 'jpg')
  await normalizePanel(job, '4-matte', input.matteFramesDir, 'png')
  await normalizePanel(job, '5-depth', input.depthFramesDir, 'jpg')
  await normalizePanel(job, '6-outline', input.outlineFramesDir, 'jpg')
  const dreamPanel = await normalizePanel(job, `7-dreams/${input.take}`, input.dreamFramesDir, 'jpg')

  const final = `7-dreams/${input.take}/final`
  const loopPath = await videoPath(job, `${final}/loop`)
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    '3',
    '-t',
    '5',
    '-i',
    dreamPanel,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '28',
    '-movflags',
    '+faststart',
    loopPath,
  ])

  // Sourced from the dream panel, not the (take-independent) portrait
  // panel — a job's takes can look completely different from each other
  // (that's the whole point of a take), so the choose-screen thumbnail
  // needs to show each take's own dream style, not one shared image every
  // take of the same job would otherwise have in common.
  const heroImagePath = await videoPath(job, `${final}/hero`, 'jpg')
  await sharp(await firstFrame(input.dreamFramesDir))
    .resize(PANEL_SIZE, PANEL_SIZE)
    .jpeg({ quality: 85 })
    .toFile(heroImagePath)

  return {
    finalDir: path.join(job.dir, final),
    loopPath,
    heroImagePath,
  }
}

export interface ComposePreviewResult {
  /** `7-dreams/<take>/preview/`: `dream.mp4` and `dream-small.mp4`, the same names the player loads. */
  previewDir: string
  /** Where the clip starts in the song, in seconds: the player starts there. */
  start: number
}

/**
 * A take's test clip (`dream-clip`) as a dream video the player can play
 * against the shared main video, for reviewing a take before paying for
 * the full song (plans/done/frame-preview-approval-tool.md). The clip's
 * dream frames are padded out to the whole song, holding the first frame
 * before it and the last after, so it stays in step with the main video
 * like any published dream; the player starts at the clip. Free and local;
 * everything lands in `7-dreams/<take>/preview/`, so the take's real
 * output is untouched.
 */
export async function composePreview(job: Job, take: string, dreamFramesDir: string, range: { start: number; frames: number }): Promise<ComposePreviewResult> {
  const previewDir = `7-dreams/${take}/preview`
  const duration = await probeDuration(AUDIO_PATH)
  const start = (range.start - 1) / job.fps
  const clip = await videoPath(job, `${previewDir}/clip`)
  await compileFramesToVideo(dreamFramesDir, clip, {
    fps: job.fps,
    scale: `${PANEL_SIZE}:${PANEL_SIZE}`,
    ext: 'jpg',
    startNumber: range.start,
    frameCount: range.frames,
  })
  const padded = await videoPath(job, `${previewDir}/padded`)
  const after = Math.max(0, duration - start - range.frames / job.fps)
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    clip,
    '-vf',
    `tpad=start_duration=${start}:start_mode=clone:stop_duration=${after}:stop_mode=clone`,
    '-t',
    String(duration),
    '-r',
    String(job.fps),
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '14',
    padded,
  ])
  // H.264 only: the player loads a dream video as .mp4 in every browser (apps/client/src/utils/dream-video.ts).
  await compress(padded, await videoPath(job, `${previewDir}/dream`, 'mp4'))
  await compress(padded, await videoPath(job, `${previewDir}/dream-small`, 'mp4'), { half: true })
  await unlink(padded)
  await unlink(clip)
  return { previewDir: path.join(job.dir, previewDir), start }
}

export interface ComposeSplitResult {
  /** `main/`: the shared 6-panel video (panels 1-6, the same for every take) with the song's audio. */
  mainDir: string
  /** Each take's silent, dream-only clip folder (`7-dreams/<take>/split/`). */
  dreamDirs: string[]
}

/**
 * The composite split in two, so the client can swap dreams mid-song without
 * reloading the audio:
 *
 * - `main/main{,-small}.{mp4,webm}`: panels 1-6 in their usual order, with the
 *   audio. Shared by every take, so made once per job.
 * - `7-dreams/<take>/split/dream{,-small}.{mp4,webm}`: panel 7 alone, silent,
 *   the same length and frame rate as the main video, so the two stay in step.
 *
 * H.264 in `.mp4`, not `.mov` as `compose` writes: Cloudflare's edge caches
 * `.mp4` and not `.mov`, and the client plays the dream clips as H.264 in
 * every browser (apps/client/src/utils/dream-video.ts says why).
 *
 * Built from the panel videos `compose` already compiled (`<panel>/video/panel.mov`),
 * so run `compose` on a take first. Anything already made is skipped, except
 * the takes' dream videos with `fresh` (`compose` passes it, having just
 * compiled the dream panel again, after a repair perhaps).
 */
export async function composeSplit(job: Job, takes: string[], opts: { fresh?: boolean } = {}): Promise<ComposeSplitResult> {
  const duration = await probeDuration(AUDIO_PATH)
  const panelVideo = async (dir: string) => {
    const p = path.join(job.dir, dir, 'video/panel.mov')
    if (!(await exists(p))) throw new Error(`${p} is missing: run compose on a take first`)
    return p
  }

  const mainDir = 'main'
  const mainComposite = await videoPath(job, `${mainDir}/composite`)
  const panels = await Promise.all(['1-words', '2-portrait', '3-background', '4-matte', '5-depth', '6-outline'].map(panelVideo))
  await once(mainComposite, (out) => hstackWithAudio(panels, out, { fps: job.fps, duration }))
  await compressAll(job, mainComposite, `${mainDir}/main`)

  const dreamDirs: string[] = []
  for (const take of takes) {
    const dir = `7-dreams/${take}/split`
    dreamDirs.push(path.join(job.dir, dir))
    const outputs = ['dream.mp4', 'dream.webm', 'dream-small.mp4', 'dream-small.webm'].map((f) => path.join(job.dir, dir, f))
    if (opts.fresh) await Promise.all(outputs.map((f) => rm(f, { force: true })))
    else if ((await Promise.all(outputs.map(exists))).every(Boolean)) continue

    const dreamPanel = await panelVideo(`7-dreams/${take}`)
    // Trimmed to the song and resampled to the job's rate exactly as the main video is, without audio.
    // Only needed until the four clips are made (about 250MB a take), so it's deleted after.
    const trimmed = await videoPath(job, `${dir}/dream-full`)
    await once(trimmed, (out) =>
      execFileAsync('ffmpeg', ['-y', '-i', dreamPanel, '-t', String(duration), '-r', String(job.fps), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '14', out]).then(() => undefined)
    )
    await compressAll(job, trimmed, `${dir}/dream`)
    await unlink(trimmed)
  }

  return { mainDir: path.join(job.dir, mainDir), dreamDirs }
}

/** `<base>.mp4`, `<base>.webm`, `<base>-small.mp4` and `<base>-small.webm` from one source, the same passes `compose` makes. Skips any that exist. */
async function compressAll(job: Job, source: string, base: string): Promise<void> {
  for (const [suffix, ext, half] of [['', 'mp4', false], ['', 'webm', false], ['-small', 'mp4', true], ['-small', 'webm', true]] as const) {
    await once(await videoPath(job, `${base}${suffix}`, ext), (out) => compress(source, out, { half }))
  }
}

/** Makes `out` with `make` unless it exists. Written under a temporary name first, so a stopped run never leaves a half-written file that looks done. */
export async function once(out: string, make: (partial: string) => Promise<void>): Promise<void> {
  if (await exists(out)) return
  const partial = out.replace(/\.(\w+)$/, '.partial.$1')
  await make(partial)
  await rename(partial, out)
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false
  )
}

/** Compiles a frame folder into a PANEL_SIZE² square panel video — every frame-based panel is already square, so this is a plain resize, no crop. `panelDir` is the panel's own folder relative to the job root (e.g. `2-portrait`, or `7-dreams/<take>` for the one per-take panel) — its compiled video lands at `<panelDir>/video/panel.mov`. `ext` must match the frame folder's actual format (alpha/matte stays png; everything else is jpg — see init.ts). */
async function normalizePanel(job: Job, panelDir: string, framesDir: string, ext: 'png' | 'jpg'): Promise<string> {
  const out = await videoPath(job, `${panelDir}/video/panel`)
  await compileFramesToVideo(framesDir, out, { fps: job.fps, scale: `${PANEL_SIZE}:${PANEL_SIZE}`, ext })
  return out
}

async function hstackWithAudio(
  panels: string[],
  outputPath: string,
  opts: { fps: number; duration: number }
): Promise<void> {
  const inputArgs = panels.flatMap((p) => ['-i', p])
  const labels = panels.map((_, i) => `[${i}:v]`).join('')
  const filter = `${labels}hstack=inputs=${panels.length}[v]`

  await execFileAsync('ffmpeg', [
    '-y',
    ...inputArgs,
    '-i',
    AUDIO_PATH,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-map',
    `${panels.length}:a:0`,
    '-shortest',
    '-t',
    String(opts.duration),
    '-r',
    String(opts.fps),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ])
}

async function compress(inputPath: string, outputPath: string, opts: { half?: boolean } = {}): Promise<void> {
  const isWebm = outputPath.endsWith('.webm')
  const args = ['-y', '-i', inputPath]
  if (opts.half) args.push('-vf', 'scale=iw/2:ih/2')
  if (isWebm) {
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', '35', '-b:v', '0')
  } else {
    // Without +faststart, ffmpeg's default mp4/mov muxer writes moov (the
    // index a browser needs before it can start playback) after mdat — the
    // full media payload. Every browser plays the dream video from this
    // H.264 file, and one without WebM support (Safari) uses it for the main
    // video too. Without faststart it must download the entire file before
    // playback can begin at all: indistinguishable from "stuck at 0:00" on
    // anything but a tiny clip.
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-movflags', '+faststart')
  }
  args.push(outputPath)
  await execFileAsync('ffmpeg', args)
}

async function probeDuration(mediaPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    mediaPath,
  ])
  return Number(stdout.trim())
}
