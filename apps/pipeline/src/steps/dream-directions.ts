import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { framesDir, type Job } from '../job.ts'
import { MODELS } from '../models.ts'
import { runModelText } from '../replicate.ts'

/**
 * Brainstorms dream (panel 7) directions for a job: one Claude call on
 * Replicate with the user's brief and a few of the job's sample source
 * frames, returning named directions each with a dream prompt and palette.
 * First stage of the preview/approval loop
 * (plans/ready/frame-preview-approval-tool.md).
 *
 * Replicate's Claude models take a single image and return plain text, so
 * the sample frames are stitched into one strip, and the reply is asked for
 * as JSON and validated here. One call, no retries: a malformed reply fails
 * with the raw text so it can be looked at.
 */

const DirectionSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  palette: z.array(z.string()),
  rationale: z.string(),
})
const DirectionsSchema = z.object({ directions: z.array(DirectionSchema).min(1) })

export type Direction = z.infer<typeof DirectionSchema>

export interface DreamDirectionsResult {
  path: string
  brief: string
  directions: Direction[]
}

const SYSTEM = `You are an art director for a music video. Every frame of the video is shown as seven side-by-side panels; you are choosing the look of panel 7, the "dream" panel.

How panel 7 is made: each real frame of the footage (a man singing in a grassy field and walking a wooden boardwalk under open sky) is repainted by an image-editing model (flux-kontext-dev) using one text prompt, at 6 frames per second, so the composition of the real footage stays recognisable while the medium, palette and texture change.

The rule that matters most: panel 7 must never show a person. It is an abstract repainting of the scene's shapes, light and colour; any figure dissolves into the landscape. A fixed suffix enforcing this is always appended to your prompt, so don't spend words on it, but never write a prompt that asks for a person, face, portrait or figure.

Write prompts that hold up over thousands of frames: name a concrete medium and technique, a palette and a mood. Avoid text, signatures, frames or borders in the image. Make the directions genuinely different from each other.

Every prompt must name a non-photographic medium that rebuilds the image out of its own marks: for example thick impasto, watercolour washes, ink, woodcut, mosaic, stained glass, paper collage, pastel. Never ask for a photograph, film stock, colour grade, filter, lighting change or "photo style": the model then keeps the footage as it is and the person stays fully recognisable (tested). Ask for the whole frame to be rebuilt in the medium, not tinted.

Reply with JSON only, no other text, in exactly this shape:
{"directions": [{"name": "2-4 word evocative name", "prompt": "1-3 sentence image-editing prompt", "palette": ["#rrggbb", "... 4-6 hex colours"], "rationale": "1-2 sentences on why it suits the brief and the footage"}]}`

/** Stitches frames side by side into one JPEG data URI (Replicate's Claude models take a single image). */
async function frameStrip(framePaths: string[]): Promise<string> {
  const size = 512
  const tiles = await Promise.all(framePaths.map((p) => sharp(p).resize(size, size, { fit: 'cover' }).toBuffer()))
  const strip = await sharp({ create: { width: size * tiles.length, height: size, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: i * size, top: 0 })))
    .jpeg({ quality: 85 })
    .toBuffer()
  return `data:image/jpeg;base64,${strip.toString('base64')}`
}

/** The JSON object in a reply, tolerating a stray code fence or sentence around it. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(`No JSON object in the reply:\n${text}`)
  return JSON.parse(text.slice(start, end + 1))
}

export async function dreamDirections(job: Job, sourceFramesDir: string, brief: string, count = 4): Promise<DreamDirectionsResult> {
  if (!job.samples?.length) throw new Error(`job.json has no "samples" — add the frames every direction is judged on.`)
  const sampleFrames = job.samples.slice(0, 3)

  const image = await frameStrip(sampleFrames.map((s) => path.join(sourceFramesDir, `${String(s.frame).padStart(4, '0')}.jpg`)))
  const frameList = sampleFrames.map((s, i) => `${i + 1}. frame ${s.frame}: ${s.label}`).join('\n')
  const prompt = `The attached image shows ${sampleFrames.length} source frames side by side, left to right:\n${frameList}\n\nBrief from the artist: ${brief}\n\nPropose ${count} directions for panel 7.`

  const text = await runModelText(MODELS.directions, {
    system_prompt: SYSTEM,
    prompt,
    image,
    max_tokens: 4000,
    max_image_resolution: 0.8,
  })

  let parsed: z.infer<typeof DirectionsSchema>
  try {
    parsed = DirectionsSchema.parse(extractJson(text))
  } catch (error) {
    throw new Error(`The reply didn't match the directions shape (${(error as Error).message}). Raw reply:\n${text}`)
  }

  const dir = await framesDir(job, '7-dreams/_directions')
  const outPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const result = { brief, model: MODELS.directions, samples: sampleFrames.map((s) => s.frame), directions: parsed.directions }
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`)

  return { path: outPath, brief, directions: result.directions }
}
