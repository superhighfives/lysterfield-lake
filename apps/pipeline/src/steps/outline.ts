import sharp from 'sharp'
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

/**
 * The lineart model's last step on its own, for unmasked line art made elsewhere (the polaroid model,
 * models/polaroid, which leaves masking to the pipeline so it can use the repaired matte): lines outside the
 * matte are removed, with the matte dilated a few pixels first so the silhouette keeps its own edge line.
 * The model's PIL MaxFilter(9) is a 9px square window, which is sharp's dilate(4).
 */
export async function maskOutline(rawPath: string, alphaPath: string, outputPath: string): Promise<void> {
  const { data: line, info } = await sharp(rawPath).greyscale().raw().toBuffer({ resolveWithObject: true })
  const { data: alpha } = await sharp(alphaPath).greyscale().resize(info.width, info.height, { kernel: 'lanczos3' }).dilate(4).raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.alloc(line.length)
  for (let i = 0; i < line.length; i++) out[i] = Math.round(255 - ((255 - line[i]) * alpha[i]) / 255)
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).jpeg({ quality: 90 }).toFile(outputPath)
}
