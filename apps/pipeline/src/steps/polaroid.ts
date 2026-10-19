import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { exists, listFrames, videoPath, type Job } from '../job.ts'

const execFileAsync = promisify(execFile)

/**
 * The polaroid's panels, in atlas order (plans/backlog/user-polaroid-loops.md). Its own layout, not the music
 * video's 7-panel one (CLAUDE.md): no words, no dream. The client's polaroid-loop-material.tsx reads these
 * indices, 1-based like the player's.
 */
export const POLAROID_PANELS = ['2-portrait/upscaled', '3-background/frames', '4-matte/frames', '5-depth/frames', '6-outline/frames'] as const

/** 5 x 768 = 3840px wide: inside H.264's 4096px limit, so it decodes everywhere. */
const PANEL_SIZE = 768

export interface PolaroidOptions {
  /** Frames dropped from the start: the matte (RVM) settles over its first few frames. */
  trim?: number
  /** Frames of the end crossfaded into the start, so the clip loops without a jump. */
  blend?: number
}

export interface PolaroidResult {
  atlasPath: string
  /** The flattened loop to download: the portrait over the background through the matte. */
  loopPath: string
  frames: number
}

/**
 * Stacks the five panels side by side into one looping video, the polaroid's whole content. A short clip
 * of real footage doesn't loop by itself, so the last `blend` frames fade into the first ones: the output
 * starts `blend` frames in and ends on the crossfade back to that start, and plays seamlessly on repeat.
 * ffmpeg only, no Replicate calls.
 */
export async function polaroid(job: Job, opts: PolaroidOptions = {}): Promise<PolaroidResult> {
  const trim = opts.trim ?? 3
  const blend = opts.blend ?? 12
  const atlasPath = await videoPath(job, 'polaroid/atlas', 'mp4')

  const inputs: string[] = []
  let frames = Infinity
  for (const panel of POLAROID_PANELS) {
    const dir = path.join(job.dir, panel)
    const list = await listFrames(dir)
    if (list.length === 0) throw new Error(`No frames in ${panel}; run its step first`)
    frames = Math.min(frames, list.length - trim)
    inputs.push('-framerate', String(job.fps), '-start_number', String(trim + 1), '-i', path.join(dir, `%04d${path.extname(list[0])}`))
  }
  if (frames < blend * 3) throw new Error(`Only ${frames} frames after trimming; too short to loop`)

  const loopPath = await videoPath(job, 'polaroid/loop', 'mp4')
  if (await exists(atlasPath)) {
    if (!(await exists(loopPath))) await flatten(atlasPath, loopPath)
    return { atlasPath, loopPath, frames: frames - blend }
  }

  const scaled = POLAROID_PANELS.map((_, i) => `[${i}]trim=end_frame=${frames},scale=${PANEL_SIZE}:${PANEL_SIZE},format=yuv420p,setsar=1[p${i}]`)
  const fade = blend / job.fps
  const filter = [
    ...scaled,
    `${POLAROID_PANELS.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${POLAROID_PANELS.length},split[a][b]`,
    `[a]trim=start_frame=${blend},setpts=PTS-STARTPTS[rest]`,
    `[b]trim=end_frame=${blend},setpts=PTS-STARTPTS[head]`,
    `[rest][head]xfade=transition=fade:duration=${fade}:offset=${(frames - 2 * blend) / job.fps}[v]`,
  ].join(';')
  await execFileAsync('ffmpeg', ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', '-an', atlasPath])
  await flatten(atlasPath, loopPath)
  return { atlasPath, loopPath, frames: frames - blend }
}

/**
 * The atlas flattened into one square loop, for downloading and sharing: the portrait (panel 1) over the
 * background (panel 2) through the matte (panel 3), as the 3D polaroid layers them. Cut from the atlas, so it
 * loops exactly as the polaroid does.
 */
async function flatten(atlasPath: string, loopPath: string): Promise<void> {
  const panel = (i: number) => `crop=${PANEL_SIZE}:${PANEL_SIZE}:${i * PANEL_SIZE}:0`
  const filter = [
    `[0]split=3[a][b][c]`,
    `[a]${panel(0)}[portrait]`,
    `[b]${panel(1)}[background]`,
    `[c]${panel(2)},format=gray[matte]`,
    `[portrait][matte]alphamerge[cutout]`,
    `[background][cutout]overlay=format=auto,format=yuv420p[v]`,
  ].join(';')
  await execFileAsync('ffmpeg', ['-y', '-i', atlasPath, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', '-an', loopPath])
}
