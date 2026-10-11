import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Replicate from 'replicate'
import sharp from 'sharp'

let client: Replicate | undefined

function getClient(): Replicate {
  if (client) return client

  const auth = process.env.REPLICATE_API_TOKEN
  if (!auth) {
    throw new Error(
      'REPLICATE_API_TOKEN is not set — copy .env.example to .env and fill it in.'
    )
  }

  client = new Replicate({ auth })
  return client
}

/**
 * Runs a Replicate model to completion and returns its output.
 * `identifier` is "owner/name" (latest version) or "owner/name:version" (pinned).
 */
async function runModel<Output = unknown>(
  identifier: `${string}/${string}` | `${string}/${string}:${string}`,
  input: Record<string, unknown>
): Promise<Output> {
  const output = await getClient().run(identifier, { input })
  return output as Output
}

/**
 * Runs a language model that returns text (Replicate streams it back as an
 * array of string chunks) and returns the joined text.
 */
export async function runModelText(
  identifier: `${string}/${string}` | `${string}/${string}:${string}`,
  input: Record<string, unknown>
): Promise<string> {
  const output = await runModel<string | string[]>(identifier, input)
  return Array.isArray(output) ? output.join('') : output
}

/** An image/video model's file output (a single FileOutput, or the first of a list). */
type FileOutputLike = { blob: () => Promise<Blob> }

/**
 * Runs a model that returns a single file output (image or video) and
 * writes it to `outputPath`. Pass `jpegQuality` to re-encode the result as
 * JPEG before writing — most image models here only return PNG (or don't
 * expose a format choice at all), so re-encoding locally via `sharp` is
 * the one place that controls on-disk size/format, rather than depending
 * on each model's own (inconsistent) output-format support.
 */
export async function runModelToFile(
  identifier: `${string}/${string}` | `${string}/${string}:${string}`,
  input: Record<string, unknown>,
  outputPath: string,
  opts?: { jpegQuality?: number }
): Promise<void> {
  // Most models return one file; some (flux-dev, sdxl...) return a list even for num_outputs 1.
  const output = await runModel<FileOutputLike | FileOutputLike[]>(identifier, input)
  const file = Array.isArray(output) ? output[0] : output
  if (!file) throw new Error(`${identifier} returned no output`)
  await saveFileOutput(file, outputPath, opts)
}

async function saveFileOutput(
  output: FileOutputLike,
  outputPath: string,
  opts?: { jpegQuality?: number }
): Promise<void> {
  const blob = await output.blob()
  const buffer = Buffer.from(await blob.arrayBuffer())
  if (opts?.jpegQuality) {
    await sharp(buffer).jpeg({ quality: opts.jpegQuality }).toFile(outputPath)
  } else {
    await writeFile(outputPath, buffer)
  }
}

/**
 * Reads a local file for use as a model input, preserving its filename and
 * extension. A raw Buffer uploads as `buffer_<timestamp>` with no
 * extension and `application/octet-stream` — several models (ProPainter's
 * `mask` field, confirmed) validate the uploaded filename's extension
 * server-side and reject that. Always read local files through this, not
 * `readFile` directly, when passing them as Replicate input.
 */
export async function readFileAsInput(filePath: string): Promise<File> {
  const buffer = await readFile(filePath)
  return new File([new Uint8Array(buffer)], path.basename(filePath))
}
