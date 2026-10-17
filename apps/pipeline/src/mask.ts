import sharp from 'sharp'

/**
 * Growing/feathering the mask well past the matte's precise silhouette.
 * flux-fill-pro at max guidance still reconstructed a person on ~30% of a
 * 20-frame sample (see models.ts) when given the exact person-shaped alpha
 * mask — the shape itself, not just prompt weight, was pulling the model
 * toward "there's a person here". A same-model retest on those exact
 * failure frames plus 8 fresh ones (11/11 clean) confirmed a heavily
 * dilated + blurred mask — which no longer reads as a person silhouette —
 * removes that pull. See `background-plate.ts` for the fuller history.
 */
export const MASK_WORKING_SIZE = 1024
export const MASK_DILATION_PX = 96
export const MASK_BLUR_SIGMA = 24

/**
 * Unions one or more alpha masks, then dilates and blurs the result into a
 * soft, oversized fill mask at `outputPath` (`MASK_WORKING_SIZE`² greyscale
 * PNG).
 *
 * Worked at a fixed size, so the grow/blur amounts don't depend on the
 * alpha's resolution. Earlier values (100 dilation passes, sigma 30) were
 * applied at whatever resolution the alpha came in at, which was 2160px
 * for both real jobs: about 47px/sigma 14 in panel terms. Bumped after
 * full-video's pilot: DiffusionCLIP's painterly arms smear well past the
 * true silhouette, and during fast arm moves those smears showed through
 * the old mask's soft edge into panel 3.
 *
 * Passing several alphas (a keyframe's whole hold window) makes the mask
 * cover everywhere the subject goes during that window, not just one pose.
 */
export async function reshapeMask(alphaPaths: string | string[], outputPath: string): Promise<void> {
  const paths = Array.isArray(alphaPaths) ? alphaPaths : [alphaPaths]
  const size = MASK_WORKING_SIZE
  const union = Buffer.alloc(size * size)
  for (const p of paths) {
    const alpha = await sharp(p).resize(size, size).greyscale().raw().toBuffer()
    for (let i = 0; i < union.length; i++) if (alpha[i] > union[i]) union[i] = alpha[i]
  }
  await sharp(dilate(union, size, MASK_DILATION_PX), { raw: { width: size, height: size, channels: 1 } })
    .blur(MASK_BLUR_SIGMA)
    .toColourspace('b-w')
    .png()
    .toFile(outputPath)
}

/**
 * Square-kernel greyscale dilation (max filter) of a `size`² single-channel
 * image by `radius` px, done as two separable sliding-window-max passes.
 * Hand-rolled because sharp's own `dilate`/`erode` didn't behave as a
 * plain max filter on these masks (tested: the silhouette's top edge moved
 * the wrong way and by inconsistent amounts).
 */
export function dilate(data: Buffer, size: number, radius: number): Buffer {
  const pass = (src: Buffer, horizontal: boolean): Buffer => {
    const out = Buffer.alloc(src.length)
    const at = (line: number, i: number) => (horizontal ? line * size + i : i * size + line)
    const deque = new Int32Array(size)
    for (let line = 0; line < size; line++) {
      let head = 0
      let tail = 0
      let next = 0
      for (let i = 0; i < size; i++) {
        // Window for output i is [i - radius, i + radius]; push new right-edge entries.
        for (; next <= Math.min(size - 1, i + radius); next++) {
          const v = src[at(line, next)]
          while (tail > head && src[at(line, deque[tail - 1])] <= v) tail--
          deque[tail++] = next
        }
        while (deque[head] < i - radius) head++
        out[at(line, i)] = src[at(line, deque[head])]
      }
    }
    return out
  }
  return pass(pass(data, true), false)
}
