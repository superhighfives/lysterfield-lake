import { execFile } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { exists, hasFiles, loadJob, saveJob } from '../job.ts'
import { clipExtension, downloadClip, getSubmission, markDone, submissionJobName, uploadFile, type UploadName } from '../polaroids-api.ts'
import { backgroundVideo } from './background-video.ts'
import { init } from './init.ts'
import { polaroid } from './polaroid.ts'
import { polaroidRun } from './polaroid-run.ts'

const execFileAsync = promisify(execFile)

export interface PolaroidMakeResult {
  job: string
  emailed: boolean
}

/**
 * A visitor's submission from claimed to made (plans/in-progress/polaroids.md, step 3): its clip from the
 * Worker, `init` with the visitor's crop, panels 2, 4, 5 and 6 (`polaroid-run`, on the 4090 when
 * POLAROID_URL is set), panel 3 (Bria), the atlas and loop, a still, then the files up to the public bucket
 * and the submission marked done.
 *
 * Only a submission the queue has claimed (`making`) is made: a person approved it in the inbox first, so a
 * visitor's clip costs nothing until it's been looked at. Every stage skips what's already there, so running
 * it again after a failure picks up where it stopped and never pays twice for finished work. Nothing is
 * retried here: a stage that fails stops the rest, and the admin's runner marks the submission failed.
 */
export async function polaroidMake(jobsDir: string, id: string, opts: { concurrency: number }): Promise<PolaroidMakeResult> {
  const submission = await getSubmission(id)
  if (submission.status !== 'making') throw new Error(`It's ${submission.status}: only one the queue has claimed is made`)
  const name = submissionJobName(id)
  const dir = path.join(jobsDir, name)

  if (!(await hasFiles(path.join(dir, '0-source/frames')))) {
    const recordings = path.join(jobsDir, '_recordings')
    await mkdir(recordings, { recursive: true })
    // The real path: .jobs is a symlink in a worktree, and job.json records where the source came from.
    const clip = path.join(await realpath(recordings), `${name}.${clipExtension(submission.clip_type)}`)
    if (!(await exists(clip))) {
      console.log(`polaroid-make: downloading ${id}'s clip`)
      await downloadClip(id, clip)
    }
    await init(dir, { sourceVideoPath: clip, length: 5, kind: 'polaroid', crop: submission.crop })
  }
  // Approved in the inbox, so /admin/polaroid shows it as one being made, and knows where it came from.
  const job = { ...(await loadJob(dir)), review: 'approved' as const, submission: id }
  await saveJob(job)

  console.log('polaroid-make: portrait, matte, depth and outline')
  const panels = await polaroidRun(job, { concurrency: opts.concurrency })
  if (panels.failed.length > 0) throw new Error(`The polaroid model failed: ${panels.failed.map((f) => f.error).join('; ')}`)

  console.log('polaroid-make: background')
  const background = await backgroundVideo(job, path.join(dir, '2-portrait/upscaled'), path.join(dir, '4-matte/frames'), '3-background/frames', { concurrency: opts.concurrency })
  if (background.failed.length > 0) throw new Error(`The background failed: ${background.failed.map((f) => f.error).join('; ')}`)

  console.log('polaroid-make: atlas and loop')
  const { atlasPath, loopPath } = await polaroid(job)
  // The gallery's still: shows by default, before (or instead of) the loop playing.
  const stillPath = path.join(path.dirname(loopPath), 'still.jpg')
  if (!(await exists(stillPath))) await execFileAsync('ffmpeg', ['-y', '-i', loopPath, '-frames:v', '1', '-q:v', '3', stillPath])

  const files: [UploadName, string][] = [
    ['atlas.mp4', atlasPath],
    ['loop.mp4', loopPath],
    ['still.jpg', stillPath],
  ]
  for (const [file, local] of files) {
    console.log(`polaroid-make: uploading ${file}`)
    await uploadFile(id, file, local)
  }
  const { emailed } = await markDone(id)
  console.log(`polaroid-make: ${id} is made${submission.hasEmail ? (emailed ? ', and its email sent' : "; its email didn't send (resend it from the inbox)") : ''}`)
  return { job: name, emailed }
}
