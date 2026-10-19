import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { exists, listFrames, videoPath, type Job } from '../job.ts'

const execFileAsync = promisify(execFile)

/**
 * The polaroid's panels, in atlas order (plans/backlog/user-polaroid-loops.md). Its own layout, not the music
 * video's 7-panel one (CLAUDE.md): no words, no dream. The client's polaroid-loop-material.tsx reads these
 * indices, 1-based like the player's.
 */
export const POLAROID_PANELS = ['2-portrait/upscaled', '3-background/frames', '4-matte/frames', '5-depth/frames', '6-outline/frames'] as const

/** How strongly the outline inks over the portrait in the flattened loop: the 3D polaroid's default (admin-polaroid.tsx). */
const OUTLINE_INK = 0.25

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
  /** Where the loop was cut (1-based source frames), and how alike its two ends were (0 = identical). */
  loop?: Loop
}

interface Loop {
  start: number
  end: number
  difference: number
}

/** How far into each end of the clip the loop's start and end may move, in seconds. */
const LOOP_SEARCH_SECONDS = 1.5
/** The shortest the loop may become, in seconds. */
const MIN_LOOP_SECONDS = 3
/** How much worse than the best-matching cut a longer one may be and still be chosen (1.1 = 10%). */
const LOOP_TOLERANCE = 1.1
/** The size each frame is compared at: enough for pose and silhouette, cheap to compare. */
const THUMB = 32

/**
 * Where to cut a clip so it loops with the least ghosting. The loop's last `blend` frames are crossfaded with
 * its first, so the best cut is where those two stretches already look most alike: every start in the first
 * second and a half and end in the last, scored frame by frame on small thumbnails of the portrait and the
 * matte (doubled: a silhouette in two places is what reads as a ghost). Of the cuts within LOOP_TOLERANCE of
 * the best, the longest wins.
 */
async function findLoop(job: Job, total: number, trim: number, blend: number): Promise<Loop> {
  const search = Math.round(LOOP_SEARCH_SECONDS * job.fps)
  const minLength = Math.round(MIN_LOOP_SECONDS * job.fps)
  const portraits = await listFrames(path.join(job.dir, '2-portrait/upscaled'))
  const mattes = await listFrames(path.join(job.dir, '4-matte/frames'))
  const thumbs = new Map<number, { portrait: Buffer; matte: Buffer }>()
  const thumb = async (i: number) => {
    let t = thumbs.get(i)
    if (!t) {
      const load = (file: string, channels: 1 | 3) =>
        sharp(file).resize(THUMB, THUMB, { fit: 'fill' }).toColourspace(channels === 1 ? 'b-w' : 'srgb').removeAlpha().raw().toBuffer()
      t = { portrait: await load(path.join(job.dir, '2-portrait/upscaled', portraits[i]), 3), matte: await load(path.join(job.dir, '4-matte/frames', mattes[i]), 1) }
      thumbs.set(i, t)
    }
    return t
  }
  const differ = async (a: number, b: number) => {
    const [x, y] = [await thumb(a), await thumb(b)]
    let sum = 0
    for (let i = 0; i < x.portrait.length; i++) sum += Math.abs(x.portrait[i] - y.portrait[i]) / 255
    let matte = 0
    for (let i = 0; i < x.matte.length; i++) matte += Math.abs(x.matte[i] - y.matte[i]) / 255
    return sum / x.portrait.length + (2 * matte) / x.matte.length
  }

  // 0-based frame indices: the start, and the end (inclusive).
  const candidates: Loop[] = []
  for (let start = trim; start <= trim + search; start++) {
    for (let end = total - 1; end >= total - 1 - search; end--) {
      if (end - start + 1 < Math.max(minLength, blend * 3)) continue
      let difference = 0
      for (let k = 0; k < blend; k++) difference += await differ(end - blend + 1 + k, start + k)
      candidates.push({ start, end, difference: difference / blend })
    }
  }
  // The longest of the cuts nearly as good as the best: a few hundredths of a difference isn't worth a loop
  // that repeats twice as often.
  const lowest = Math.min(...candidates.map((c) => c.difference))
  const best = candidates.filter((c) => c.difference <= lowest * LOOP_TOLERANCE).sort((a, b) => b.end - b.start - (a.end - a.start) || a.difference - b.difference)[0]
  return { start: best.start + 1, end: best.end + 1, difference: Number(best.difference.toFixed(4)) }
}

/**
 * Stacks the five panels side by side into one looping video, the polaroid's whole content. A short clip
 * of real footage doesn't loop by itself, so it's cut where its two ends look most alike (`findLoop`) and
 * the last `blend` frames fade into the first: the output starts `blend` frames in and ends on the crossfade
 * back to that start, and plays seamlessly on repeat. The cut is saved in `polaroid/loop.json`. ffmpeg and
 * sharp only, no Replicate calls.
 */
export async function polaroid(job: Job, opts: PolaroidOptions = {}): Promise<PolaroidResult> {
  const trim = opts.trim ?? 3
  const blend = opts.blend ?? 6
  const atlasPath = await videoPath(job, 'polaroid/atlas', 'mp4')

  let total = Infinity
  const patterns: string[] = []
  for (const panel of POLAROID_PANELS) {
    const dir = path.join(job.dir, panel)
    const list = await listFrames(dir)
    if (list.length === 0) throw new Error(`No frames in ${panel}; run its step first`)
    total = Math.min(total, list.length)
    patterns.push(path.join(dir, `%04d${path.extname(list[0])}`))
  }
  if (total - trim < blend * 3) throw new Error(`Only ${total - trim} frames after trimming; too short to loop`)

  const loopPath = await videoPath(job, 'polaroid/loop', 'mp4')
  if (await exists(atlasPath)) {
    if (!(await exists(loopPath))) await flatten(atlasPath, loopPath)
    return { atlasPath, loopPath, frames: total - trim - blend }
  }

  const loop = await findLoop(job, total, trim, blend)
  await writeFile(path.join(job.dir, 'polaroid', 'loop.json'), `${JSON.stringify({ ...loop, blend }, null, 2)}\n`)
  const frames = loop.end - loop.start + 1
  const inputs = patterns.flatMap((pattern) => ['-framerate', String(job.fps), '-start_number', String(loop.start), '-i', pattern])

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
  return { atlasPath, loopPath, frames: frames - blend, loop }
}

/**
 * The atlas flattened into one square loop, for downloading and sharing: the portrait (panel 1) over the
 * background (panel 2) through the matte (panel 3), as the 3D polaroid layers them. Cut from the atlas, so it
 * loops exactly as the polaroid does.
 */
async function flatten(atlasPath: string, loopPath: string): Promise<void> {
  const panel = (i: number) => `crop=${PANEL_SIZE}:${PANEL_SIZE}:${i * PANEL_SIZE}:0`
  const filter = [
    `[0]split=4[a][b][c][d]`,
    `[a]${panel(0)},format=gbrp[raw]`,
    `[d]${panel(4)},format=gbrp[outline]`,
    // The outline inked over the portrait, as the 3D polaroid draws it by default (OUTLINE_INK).
    `[raw][outline]blend=all_mode=multiply:all_opacity=${OUTLINE_INK}[portrait]`,
    `[b]${panel(1)}[background]`,
    `[c]${panel(2)},format=gray[matte]`,
    `[portrait][matte]alphamerge[cutout]`,
    `[background][cutout]overlay=format=auto,format=yuv420p[v]`,
  ].join(';')
  await execFileAsync('ffmpeg', ['-y', '-i', atlasPath, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', '-an', loopPath])
}
