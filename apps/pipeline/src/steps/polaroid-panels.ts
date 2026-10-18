import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { exists, forEachFrame, framesDir, siblingFramePath, videoPath, type Job } from '../job.ts'
import { maskDepth } from './depth.ts'
import { matte } from './matte.ts'
import { maskOutline } from './outline.ts'

const execFileAsync = promisify(execFile)

/** The folders models/polaroid returns, unpacked into the job as they are. */
const RAW = ['2-portrait/raw', '2-portrait/upscaled', '5-depth/raw', '6-outline/raw']

export interface PolaroidPanelsResult {
  matteRepairs: number
  frames: number
}

/**
 * Unpacks a models/polaroid output tar into the job, then runs the pipeline's own post-processing on it, so
 * panels 2, 4, 5 and 6 end up exactly where and how the per-model steps leave them:
 * - the matte step finds `4-matte/raw.mp4` already there, so it only extracts and repairs frames;
 * - portrait and upscale frames are final as they are;
 * - depth gets its gamma rescale and matte mask, and outline its matte mask, both with the repaired matte.
 * Files already in the job are kept (skip-if-exists, as every step). No Replicate calls.
 */
export async function polaroidPanels(job: Job, tarPath: string, concurrency: number): Promise<PolaroidPanelsResult> {
  const unpacked = await mkdtemp(path.join(tmpdir(), 'polaroid-panels-'))
  try {
    await execFileAsync('tar', ['-xf', tarPath, '-C', unpacked])
    for (const dir of RAW) {
      const from = path.join(unpacked, dir)
      if (!(await exists(from))) continue
      const to = await framesDir(job, dir)
      for (const frame of await readdir(from)) {
        if (!(await exists(path.join(to, frame)))) await copyFile(path.join(from, frame), path.join(to, frame))
      }
    }
    const rawMatte = path.join(unpacked, '4-matte', 'raw.mp4')
    const jobMatte = await videoPath(job, '4-matte/raw', 'mp4')
    if ((await exists(rawMatte)) && !(await exists(jobMatte))) {
      await mkdir(path.dirname(jobMatte), { recursive: true })
      await copyFile(rawMatte, jobMatte)
    }
  } finally {
    await rm(unpacked, { recursive: true, force: true })
  }

  if (!(await exists(await videoPath(job, '4-matte/raw', 'mp4')))) throw new Error('No 4-matte/raw.mp4 in the job or the tar')
  const { alphaFramesDir, repairs } = await matte(job, await videoPath(job, '0-source/video'))

  const sourceFrames = path.join(job.dir, '0-source/frames')
  const depthOut = await framesDir(job, '5-depth/frames')
  await forEachFrame(sourceFrames, depthOut, concurrency, async (inputPath, outputPath) => {
    await maskDepth(await siblingFramePath(inputPath, path.join(job.dir, '5-depth/raw')), await siblingFramePath(inputPath, alphaFramesDir), outputPath)
  })
  const outlineOut = await framesDir(job, '6-outline/frames')
  await forEachFrame(sourceFrames, outlineOut, concurrency, async (inputPath, outputPath) => {
    await maskOutline(await siblingFramePath(inputPath, path.join(job.dir, '6-outline/raw')), await siblingFramePath(inputPath, alphaFramesDir), outputPath)
  })

  return { matteRepairs: repairs.length, frames: (await readdir(sourceFrames)).length }
}
