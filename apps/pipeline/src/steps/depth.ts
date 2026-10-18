import { access, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { loadImageAndMaskRaw } from '../composite.ts'
import { forEachFrame, framesDir, siblingFramePath, type Job } from '../job.ts'
import { MODELS } from '../models.ts'
import { runModelToFile } from '../replicate.ts'

export interface DepthResult {
  framesDir: string
}

const SIZE = 1024
/** How many gamma-corrected levels below the subject's nearest point show, for `fitToSubject` frames (the fixed band is 20). */
const FIT_BAND = 14

/**
 * ZoeDepth, with the pre/post-processing `other.py` did around the raw
 * model call:
 *
 * Pre: composite the frame onto a transparent background using the matte's
 * alpha as the alpha channel (not white — masking everything except the
 * subject is intentional, matching the legacy `green` sub-step).
 *
 * Post: gamma-correct (matching `skimage.exposure.adjust_gamma(x, 1/2.2)`),
 * rescale intensity so only the top 235-255 brightness band survives,
 * stretched across the full 0-255 range (matching
 * `skimage.exposure.rescale_intensity(x, (235, 255))`) — this is what
 * gives the depth panel its high-contrast look — then re-apply the alpha
 * mask as a hard cutout on the model's actual output.
 *
 * That last step isn't redundant with the pre-composite above: ZoeDepth
 * occasionally hallucinates structure in the masked-out region anyway
 * (confirmed on `real-15s-60fps` frames 0250/0300 — faint grey wedges in
 * the bottom corners despite solid-black input there), so relying on the
 * model to respect a masked input isn't reliable. Forcing it back to black
 * post-hoc, driven by the same alpha used for the pre-mask, closes that
 * gap regardless of what the model does with the "empty" region — and
 * doesn't depend on which depth model is wired up (tried swapping to
 * `depth-anything-v2` for this same artifact; it didn't honor masked input
 * at all and instead hallucinated a whole-frame depth gradient across
 * every frame, not just occasionally — worse, not better, on this
 * specific failure mode. A post-mask fixes it regardless of model choice).
 */
export async function depth(
  job: Job,
  sourceFramesDir: string,
  alphaFramesDir: string,
  concurrency: number,
  opts: DepthOptions = {}
): Promise<DepthResult> {
  const outputDir = await framesDir(job, '5-depth/frames')
  const only = opts.frames && new Set(opts.frames)
  const frameNumber = (file: string) => Number(path.basename(file, path.extname(file)))

  // Redoing frames that already exist: move each one aside first, so the redo can be undone and
  // `forEachFrame` doesn't skip it. A frame already moved aside keeps its first original.
  if (only) {
    const replacedDir = await framesDir(job, '5-depth/replaced')
    for (const n of only) {
      const file = `${String(n).padStart(4, '0')}.jpg`
      const [current, original] = [path.join(outputDir, file), path.join(replacedDir, file)]
      if ((await exists(current)) && !(await exists(original))) await rename(current, original)
    }
  }
  const rawDir = opts.fitToSubject ? await framesDir(job, '5-depth/raw') : undefined

  await forEachFrame(
    sourceFramesDir,
    outputDir,
    concurrency,
    async (inputPath, outputPath) => {
      const alphaPath = await siblingFramePath(inputPath, alphaFramesDir)
      const { png: compositePng, alpha } = await compositeOnTransparent(inputPath, alphaPath)

      // Fitted frames keep ZoeDepth's raw output, so the post-processing can be tuned without paying again.
      const modelOutputPath = rawDir ? path.join(rawDir, `${path.basename(outputPath, path.extname(outputPath))}.png`) : `${outputPath}.model.png`
      if (!(await exists(modelOutputPath))) {
        await runModelToFile(MODELS.zoedepth, { image: new File([new Uint8Array(compositePng)], 'frame.png') }, modelOutputPath)
      }

      await gammaRescaleAndMask(modelOutputPath, alpha, outputPath, { fitToSubject: opts.fitToSubject })
      if (!rawDir) await unlink(modelOutputPath)
    },
    { only: only && ((frame) => only.has(frameNumber(frame))) }
  )

  return { framesDir: outputDir }
}

export interface DepthOptions {
  /** Only these frames (1-based). Any that already exist are moved to `5-depth/replaced/` first and made again. */
  frames?: number[]
  /**
   * Scale each frame to the subject's own depth, rather than a fixed band (see `gammaRescaleAndMask`).
   * For stretches where the subject is far from the camera and the fixed band leaves the panel black,
   * like full-video's walk-away (plans/in-progress/depth-walk-away-gaps.md).
   */
  fitToSubject?: boolean
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false
  )
}

async function compositeOnTransparent(
  imagePath: string,
  maskPath: string
): Promise<{ png: Buffer; alpha: Buffer }> {
  const { rgb, alpha } = await loadImageAndMaskRaw(imagePath, maskPath, SIZE)

  const rgba = Buffer.alloc(SIZE * SIZE * 4)
  for (let i = 0; i < SIZE * SIZE; i++) {
    rgba[i * 4] = rgb[i * 3]
    rgba[i * 4 + 1] = rgb[i * 3 + 1]
    rgba[i * 4 + 2] = rgb[i * 3 + 2]
    rgba[i * 4 + 3] = alpha[i]
  }

  const png = await sharp(rgba, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer()
  return { png, alpha }
}

/**
 * `alpha` is the same `SIZE`x`SIZE` greyscale mask used to build the model's input — see the `depth()` docstring for why it's re-applied here too.
 *
 * The 235-255 band is fixed, so a subject far from the camera (nothing of it gamma-corrected above 235)
 * comes out black. `fitToSubject` first shifts the frame up so the subject's nearest part (its 99.5th
 * percentile, under the matte) sits at 255, which keeps the same band, and so the same look, on
 * whatever depth the subject is at. A frame whose subject already reaches 255 is unchanged.
 */
async function gammaRescaleAndMask(inputPath: string, alpha: Buffer, outputPath: string, opts: { fitToSubject?: boolean } = {}): Promise<void> {
  const image = sharp(inputPath).resize(SIZE, SIZE)
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })

  const gamma = 1.0 / 2.2
  // A fitted subject is far off, so its depth spans fewer levels: a narrower band gives it about the same
  // shading as a near one (checked against frames 2850-2970: lower quartile ~170, median ~200, like the 2023 near frames).
  const [low, high] = opts.fitToSubject ? [255 - FIT_BAND, 255] : [235, 255]
  const gammaOf = (v: number) => 255 * (v / 255) ** gamma
  const shift = opts.fitToSubject ? 255 - subjectNearest(data, info.channels, alpha, gammaOf) : 0
  const lut = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    const gammaCorrected = gammaOf(v) + shift
    const clipped = Math.min(Math.max(gammaCorrected, low), high)
    lut[v] = Math.round(((clipped - low) / (high - low)) * 255)
  }

  // `alpha` has one entry per pixel; `data` is channel-interleaved (sharp's
  // raw buffer layout), so each byte's pixel is `i / info.channels`.
  for (let i = 0; i < data.length; i++) {
    const pixel = Math.floor(i / info.channels)
    data[i] = Math.round((lut[data[i]] * alpha[pixel]) / 255)
  }

  await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .jpeg({ quality: 90 })
    .toFile(outputPath)
}

/** The subject's nearest depth, gamma-corrected: the 99.5th percentile of the first channel under the matte (a single outlier pixel doesn't count). 255 when there's no subject, so nothing shifts. */
function subjectNearest(data: Buffer, channels: number, alpha: Buffer, gammaOf: (v: number) => number): number {
  const counts = new Array(256).fill(0)
  let total = 0
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    if (alpha[pixel] < 128) continue
    counts[data[pixel * channels]]++
    total++
  }
  if (total < 50) return 255
  let seen = 0
  for (let v = 255; v >= 0; v--) {
    seen += counts[v]
    if (seen >= total * 0.005) return gammaOf(v)
  }
  return 255
}
