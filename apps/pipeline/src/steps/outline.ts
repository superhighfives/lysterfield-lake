import { forEachFrame, framesDir, siblingFramePath, type Job } from '../job.ts'
import { MODELS } from '../models.ts'
import { readFileAsInput, runModelToFile } from '../replicate.ts'

export interface OutlineResult {
  framesDir: string
}

/**
 * Panel 6: cleaned coarse line art of the subject, from the private
 * `models/lineart/` Cog model. It replaced ArtLine after the outline
 * bake-off (plans/done/phase-4g-outline-coarse-lineart.md): ArtLine
 * ran at 300px and came out soft, and none of its pre-processing (cut-out
 * onto white, contrast stretch, soft-light depth blend) applies here.
 *
 * The model takes the raw source frame and the matte, and does everything
 * else itself: light edge-preserving smoothing (so skin texture and stubble
 * don't turn into stray strokes), the coarse line pass, dropping faint
 * strokes, and masking lines to the subject. Pass `cleanup: false` to the
 * model for the plain coarse version instead.
 */
export async function outline(
  job: Job,
  sourceFramesDir: string,
  matteFramesDir: string,
  concurrency: number
): Promise<OutlineResult> {
  const outputDir = await framesDir(job, '6-outline/frames')
  await forEachFrame(sourceFramesDir, outputDir, concurrency, async (inputPath, outputPath) => {
    await runModelToFile(
      MODELS.outline,
      {
        image: await readFileAsInput(inputPath),
        mask: await readFileAsInput(await siblingFramePath(inputPath, matteFramesDir)),
      },
      outputPath
    )
  })
  return { framesDir: outputDir }
}
