import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import sharp from 'sharp'
import { z } from 'zod'
import { framesDir, type Job } from '../job.ts'

/**
 * Brainstorms dream (panel 7) directions for a job: one Claude API call with
 * the user's brief and a few of the job's sample source frames, returning
 * named directions each with a dream prompt and palette. First stage of the
 * preview/approval loop (plans/ready/frame-preview-approval-tool.md).
 *
 * Needs ANTHROPIC_API_KEY (apps/pipeline/.env) or an `ant auth login`
 * profile. One call per run, no retries beyond the SDK's own for transient
 * errors.
 */

const MODEL = 'claude-opus-5-5'

const DirectionSchema = z.object({
  name: z.string().describe('Short evocative name, 2-4 words'),
  prompt: z
    .string()
    .describe(
      'The image-editing prompt for flux-kontext-dev, applied to each real video frame: describe the medium, palette, texture and mood to repaint the scene in. One to three sentences.'
    ),
  palette: z.array(z.string().describe('Hex colour, e.g. #1f3a5f')).describe('4-6 colours that define the look'),
  rationale: z.string().describe('One or two sentences on why this suits the brief and the footage'),
})
const DirectionsSchema = z.object({ directions: z.array(DirectionSchema) })

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

Every prompt must name a non-photographic medium that rebuilds the image out of its own marks: for example thick impasto, watercolour washes, ink, woodcut, mosaic, stained glass, paper collage, pastel. Never ask for a photograph, film stock, colour grade, filter, lighting change or "photo style": the model then keeps the footage as it is and the person stays fully recognisable (tested). Ask for the whole frame to be rebuilt in the medium, not tinted.`

/** Downscales a frame for the request (the model doesn't need full resolution to judge a scene). */
async function frameAsImageBlock(framePath: string): Promise<Anthropic.Beta.BetaImageBlockParam> {
  const jpeg = await sharp(framePath).resize(768, 768, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } }
}

export async function dreamDirections(job: Job, sourceFramesDir: string, brief: string, count = 4): Promise<DreamDirectionsResult> {
  if (!job.samples?.length) throw new Error(`job.json has no "samples" — add the frames every direction is judged on.`)
  const sampleFrames = job.samples.slice(0, 3)

  const content: Anthropic.Beta.BetaContentBlockParam[] = []
  for (const sample of sampleFrames) {
    content.push({ type: 'text', text: `Source frame ${sample.frame} (${sample.label}):` })
    content.push(await frameAsImageBlock(path.join(sourceFramesDir, `${String(sample.frame).padStart(4, '0')}.jpg`)))
  }
  content.push({ type: 'text', text: `Brief from the artist: ${brief}\n\nPropose ${count} directions for panel 7.` })

  const client = new Anthropic()
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(DirectionsSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  })

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'no category'}): ${response.stop_details?.explanation ?? ''}`)
  }
  if (!response.parsed_output) throw new Error(`Claude's reply didn't match the directions schema (stop_reason ${response.stop_reason}).`)

  const dir = await framesDir(job, '7-dreams/_directions')
  const outPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const result = { brief, model: response.model, samples: sampleFrames.map((s) => s.frame), directions: response.parsed_output.directions }
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`)

  return { path: outPath, brief, directions: result.directions }
}
