import { execFile } from 'node:child_process'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createJob, exists, extractFrames, framesDir, hasFiles, videoPath, type Crop, type Job } from '../job.ts'

const execFileAsync = promisify(execFile)

export interface InitOptions {
  sourceVideoPath: string
  /**
   * Frames per second to extract at. Default 24, not the legacy pipeline's
   * 60 — every per-frame step (background-plate, artwork, depth, outline,
   * upscale) is one Replicate call per frame, so fps is a direct cost
   * multiplier. 24fps reads as smooth motion and cuts a full-length scene's
   * per-frame call count by more than half.
   */
  fps?: number
  /** ffmpeg `-ss` — seconds to skip from the start. */
  offset?: number
  /** ffmpeg `-t` — seconds to process. */
  length?: number
  /** Where to take the square from; the largest centred square if unset. */
  crop?: Crop
}

export interface InitResult {
  job: Job
  /** `0-source/video.mov` — the square-cropped source at its native frame rate; `matte` sends this to Replicate as one video. */
  sourceVideoPath: string
  /** `0-source/frames/` — the cropped source extracted at `job.fps`; every per-frame step reads these. */
  sourceFramesDir: string
}

/** ffmpeg's crop filter for a hand-picked square: `ow` is the square's side, and x/y are clamped so it stays inside the frame. */
function squareCrop({ x, y, zoom }: Crop): string {
  const side = `min(iw\\,ih)/${zoom}`
  const clamp = (centre: number, size: string) => `max(0\\,min(${size}-ow\\,${size}*${centre}-ow/2))`
  return `crop=w='${side}':h='${side}':x='${clamp(x, 'iw')}':y='${clamp(y, 'ih')}'`
}

/**
 * Crops the source video to a square (capped at 1280px — no model this
 * pipeline calls needs more: DiffusionCLIP works at 512px, flux-fill-pro
 * caps its own output around 1264px; the legacy pipeline's 2160px cap was
 * pure waste, ~3x the pixels for no visible benefit) and extracts frames,
 * recording the source in `job.json`. No Replicate calls.
 *
 * Source frames are extracted as JPEG, not PNG — they're large,
 * photographic, and (bar `dream`'s single start-frame read) only ever feed
 * models that already tolerate real-world recompression. Every other
 * frame format decision follows from this one, since sibling directories
 * (the matte excepted — masks need exact pixel values) inherit whatever
 * extension their own source input uses.
 */
export async function init(jobDir: string, opts: InitOptions): Promise<InitResult> {
  const fps = opts.fps ?? 24

  // Keep an untouched copy of the original in the job, so the job never
  // depends on wherever the footage first came from (e.g. an external drive).
  const originalRelativePath = path.join('0-source', 'original', path.basename(opts.sourceVideoPath))
  const originalPath = path.join(jobDir, originalRelativePath)
  if (!(await exists(originalPath))) {
    await mkdir(path.dirname(originalPath), { recursive: true })
    await copyFile(opts.sourceVideoPath, originalPath)
  } else if ((await stat(originalPath)).size !== (await stat(opts.sourceVideoPath)).size) {
    throw new Error(
      `${originalPath} already exists but doesn't match ${opts.sourceVideoPath}. A job holds one source; use a new job directory for a different video.`
    )
  }

  const crop = opts.crop
  if (crop && !(crop.zoom >= 1 && [crop.x, crop.y].every((v) => v >= 0 && v <= 1))) {
    throw new Error('crop needs x and y between 0 and 1, and a zoom of at least 1')
  }

  const job = await createJob(jobDir, {
    fps,
    source: { path: originalRelativePath, from: path.resolve(opts.sourceVideoPath), offset: opts.offset, length: opts.length, crop },
  })

  const sourceVideoPath = await videoPath(job, '0-source/video')
  if (!(await exists(sourceVideoPath))) {
    const args = ['-y']
    if (opts.offset !== undefined) args.push('-ss', String(opts.offset))
    args.push('-i', originalPath)
    if (opts.length !== undefined) args.push('-t', String(opts.length))
    args.push(
      '-filter:v',
      // Crop to the full centered square first, *then* scale — capping the
      // crop itself at 1280 would take a zoomed-in center crop of any source
      // larger than 1280px (e.g. the legacy 2160px `main-compiled-full.mov`).
      // A hand-picked crop is a smaller square centred on its x/y, kept inside the frame.
      `${crop ? squareCrop(crop) : "crop=w='min(iw\\,ih)':h='min(iw\\,ih)'"},scale=1280:1280,setsar=1`,
      sourceVideoPath
    )
    await execFileAsync('ffmpeg', args)
  }

  const sourceFramesDir = await framesDir(job, '0-source/frames')
  if (!(await hasFiles(sourceFramesDir))) {
    await extractFrames(sourceVideoPath, sourceFramesDir, fps, 'jpg')
  }

  return { job, sourceVideoPath, sourceFramesDir }
}
