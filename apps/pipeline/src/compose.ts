import { execFile } from 'node:child_process'
import { access, rename, unlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'
import path from 'node:path'
import { compileFramesToVideo, firstFrame, listFrames, videoPath, type Job } from './job.ts'
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
  /** Overrides the real audio's duration for the final clip length — for a quick review render against a short test job's actual unique frame count, rather than looping/clipping to a full ~3.5min song. Real scenes should never set this. */
  durationSeconds?: number
}

export interface ComposeResult {
  /** The uncompressed 7-panel hstack + audio mux, before compression. */
  compositeVideoPath: string
  /** `7-dreams/<take>/final/` — every finished file for the take, in the legacy pipeline's `output/final/<id>/` format plus `hero.jpg`. */
  finalDir: string
  videoPath: string
  videoWebmPath: string
  videoSmallPath: string
  videoSmallWebmPath: string
  /** 5s loop clip cropped from the dream panel — apps/client's choose-screen asset. */
  loopPath: string
  loopWebmPath: string
  /** apps/client's choose-screen thumbnail, from the dream panel's first frame. */
  heroImagePath: string
  /** `00.jpg`-`03.jpg`: four dream stills spread through the take (the legacy pipeline picked four at random). */
  stillPaths: string[]
}

/**
 * Ports generate-videos.sh: 7-panel hstack (words, portrait, background,
 * matte, depth, outline, dream — the exact order the client shader
 * expects) + audio mux, clipped to the audio's length, then the
 * video/video-small/loop/hero compression passes.
 *
 * Each panel's compiled video lives under that panel's own numbered folder
 * (`1-words/video/panel.mov`, etc.) — shared across every take for
 * panels 1-6, since their frame inputs don't depend on which dream take is
 * selected; panel 7's compile and every output below it lives under
 * `7-dreams/<take>/` instead, since the dream frames themselves are the
 * one thing that varies per take.
 */
export async function compose(job: Job, input: ComposeInput): Promise<ComposeResult> {
  const audioDuration = input.durationSeconds ?? (await probeDuration(AUDIO_PATH))

  const wordsPanel = await normalizePanel(job, '1-words', input.wordsFramesDir, 'jpg')
  const portraitPanel = await normalizePanel(job, '2-portrait', input.portraitFramesDir, 'jpg')
  const backgroundPanel = await normalizePanel(job, '3-background', input.backgroundFramesDir, 'jpg')
  const mattePanel = await normalizePanel(job, '4-matte', input.matteFramesDir, 'png')
  const depthPanel = await normalizePanel(job, '5-depth', input.depthFramesDir, 'jpg')
  const outlinePanel = await normalizePanel(job, '6-outline', input.outlineFramesDir, 'jpg')
  const dreamPanel = await normalizePanel(job, `7-dreams/${input.take}`, input.dreamFramesDir, 'jpg')

  const compositeVideoPath = await videoPath(job, `7-dreams/${input.take}/composite`)
  await hstackWithAudio(
    [wordsPanel, portraitPanel, backgroundPanel, mattePanel, depthPanel, outlinePanel, dreamPanel],
    compositeVideoPath,
    { fps: job.fps, duration: audioDuration }
  )

  const final = `7-dreams/${input.take}/final`
  const finalVideoPath = await videoPath(job, `${final}/video`)
  const videoWebmPath = await videoPath(job, `${final}/video`, 'webm')
  await compress(compositeVideoPath, finalVideoPath)
  await compress(compositeVideoPath, videoWebmPath)

  const videoSmallPath = await videoPath(job, `${final}/video-small`)
  const videoSmallWebmPath = await videoPath(job, `${final}/video-small`, 'webm')
  await compress(compositeVideoPath, videoSmallPath, { half: true })
  await compress(compositeVideoPath, videoSmallWebmPath, { half: true })

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
  const loopWebmPath = await videoPath(job, `${final}/loop`, 'webm')
  await compress(loopPath, loopWebmPath)

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

  // Four stills at 20/40/60/80% through the dream, so they're spread out and
  // stable across re-composes (the legacy pipeline picked four at random).
  const dreamFrames = await listFrames(input.dreamFramesDir)
  const stillPaths: string[] = []
  for (const [n, at] of [0.2, 0.4, 0.6, 0.8].entries()) {
    const stillPath = await videoPath(job, `${final}/${String(n).padStart(2, '0')}`, 'jpg')
    await sharp(path.join(input.dreamFramesDir, dreamFrames[Math.floor(dreamFrames.length * at)]))
      .resize(PANEL_SIZE, PANEL_SIZE)
      .jpeg({ quality: 85 })
      .toFile(stillPath)
    stillPaths.push(stillPath)
  }

  return {
    compositeVideoPath,
    videoPath: finalVideoPath,
    videoWebmPath,
    videoSmallPath,
    videoSmallWebmPath,
    finalDir: path.join(job.dir, final),
    loopPath,
    loopWebmPath,
    heroImagePath,
    stillPaths,
  }
}

export interface ComposePreviewResult {
  /** `7-dreams/<take>/preview/` — `video.mov` and `video-small.mov`, the same names the player loads. */
  previewDir: string
  videoPath: string
  videoSmallPath: string
}

/**
 * A short test composite of one frame range (`dream-clip`), with the
 * matching slice of the song's audio, for reviewing a take in the real
 * player before paying for the full song
 * (plans/done/frame-preview-approval-tool.md). Same 7-panel order as
 * `compose`; everything lands in `7-dreams/<take>/preview/`, so the shared
 * panel videos and the take's real output are untouched.
 */
export async function composePreview(
  job: Job,
  input: Omit<ComposeInput, 'durationSeconds'>,
  range: { start: number; frames: number }
): Promise<ComposePreviewResult> {
  const previewDir = `7-dreams/${input.take}/preview`
  const panelInputs: [string, string, 'png' | 'jpg'][] = [
    ['1-words', input.wordsFramesDir, 'jpg'],
    ['2-portrait', input.portraitFramesDir, 'jpg'],
    ['3-background', input.backgroundFramesDir, 'jpg'],
    ['4-matte', input.matteFramesDir, 'png'],
    ['5-depth', input.depthFramesDir, 'jpg'],
    ['6-outline', input.outlineFramesDir, 'jpg'],
    ['7-dream', input.dreamFramesDir, 'jpg'],
  ]
  const panels: string[] = []
  for (const [name, dir, ext] of panelInputs) {
    const out = await videoPath(job, `${previewDir}/panels/${name}`)
    await compileFramesToVideo(dir, out, {
      fps: job.fps,
      scale: `${PANEL_SIZE}:${PANEL_SIZE}`,
      ext,
      startNumber: range.start,
      frameCount: range.frames,
    })
    panels.push(out)
  }

  const compositePath = await videoPath(job, `${previewDir}/composite`)
  await hstackWithAudio(panels, compositePath, {
    fps: job.fps,
    duration: range.frames / job.fps,
    audioOffset: (range.start - 1) / job.fps,
  })

  const videoPathOut = await videoPath(job, `${previewDir}/video`)
  const videoSmallPath = await videoPath(job, `${previewDir}/video-small`)
  await compress(compositePath, videoPathOut)
  await compress(compositePath, videoSmallPath, { half: true })

  return { previewDir: path.join(job.dir, previewDir), videoPath: videoPathOut, videoSmallPath }
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
 * - `main/main{,-small}.{mov,webm}`: panels 1-6 in their usual order, with the
 *   audio. Shared by every take, so made once per job.
 * - `7-dreams/<take>/split/dream{,-small}.{mov,webm}`: panel 7 alone, silent,
 *   the same length and frame rate as the main video, so the two stay in step.
 *
 * Built from the panel videos `compose` already compiled (`<panel>/video/panel.mov`),
 * so run `compose` on a take first. Anything already made is skipped.
 */
export async function composeSplit(job: Job, takes: string[]): Promise<ComposeSplitResult> {
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
    const outputs = ['dream.mov', 'dream.webm', 'dream-small.mov', 'dream-small.webm'].map((f) => path.join(job.dir, dir, f))
    if ((await Promise.all(outputs.map(exists))).every(Boolean)) continue

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

/** `<base>.mov`, `<base>.webm`, `<base>-small.mov` and `<base>-small.webm` from one source, the same passes `compose` makes. Skips any that exist. */
async function compressAll(job: Job, source: string, base: string): Promise<void> {
  for (const [suffix, ext, half] of [['', 'mov', false], ['', 'webm', false], ['-small', 'mov', true], ['-small', 'webm', true]] as const) {
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
  opts: { fps: number; duration: number; audioOffset?: number }
): Promise<void> {
  const inputArgs = panels.flatMap((p) => ['-i', p])
  if (opts.audioOffset) inputArgs.push('-ss', String(opts.audioOffset))
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
    // full media payload. A browser without WebM support (Safari) falls
    // back to this .mov source, and must then download the entire file
    // before playback can begin at all: indistinguishable from "stuck at
    // 0:00" on anything but a tiny clip.
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
