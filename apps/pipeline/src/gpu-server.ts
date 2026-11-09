import { writeFile } from 'node:fs/promises'
import { z } from 'zod'

/**
 * Runs the Deforum model on our own GPU machine instead of Replicate: the
 * PC with the RTX 4090, over Tailscale, serving the model's own Docker
 * image (Cog's HTTP API). Free per frame and with no cold starts, but one
 * GPU, so one run at a time. Set up in plans/in-progress/dreams.md
 * (Our own GPU).
 *
 * The address comes from `DEFORUM_URL` in apps/pipeline/.env, never from
 * the code (CLAUDE.md: no hardcoded hostnames for local model servers).
 * Unset, everything runs on Replicate as before; `--on replicate` on a
 * command sends that one there anyway.
 */
export function gpuServerUrl(): string | undefined {
  return process.env.DEFORUM_URL?.replace(/\/+$/, '') || undefined
}

/**
 * The polaroid model (models/polaroid) on the same PC, its own container on
 * its own port: `POLAROID_URL` in apps/pipeline/.env, the same rules as
 * `DEFORUM_URL`. Unset, polaroids run on the Replicate deployment.
 */
export function polaroidServerUrl(): string | undefined {
  return process.env.POLAROID_URL?.replace(/\/+$/, '') || undefined
}

/**
 * The fields we read from Cog's prediction reply; anything else is ignored.
 * Every key optional: a successful reply has no `detail` or `error`, a refused one no `output`.
 * (In zod 4 a bare `z.unknown()` key is required, which rejected every successful run.)
 */
const PredictionReply = z.object({
  status: z.string().optional(),
  output: z.unknown().optional(),
  error: z.string().nullish(),
  detail: z.unknown().optional(),
  metrics: z.object({ predict_time: z.number().nullish() }).nullish(),
})

/** One run at a time from this process: the server takes one prediction at a time and refuses a second. */
let turn: Promise<unknown> = Promise.resolve()

async function asDataUri(value: unknown): Promise<unknown> {
  if (!(value instanceof Blob)) return value
  // The type tells the server which extension to give the file it writes (a video must stay a video).
  const byExtension: Record<string, string> = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
  const extension = value instanceof File ? (value.name.split('.').pop() ?? '').toLowerCase() : ''
  const type = value.type || byExtension[extension] || 'application/octet-stream'
  return `data:${type};base64,${Buffer.from(await value.arrayBuffer()).toString('base64')}`
}

/**
 * Runs one prediction on the GPU server and writes its file output to
 * `outputPath`. Waits while the GPU is busy with another run (the server
 * answers 409), checking every 15 seconds; a run that fails is reported,
 * never repeated (CLAUDE.md), the same as on Replicate.
 */
export function runOnGpuServer(baseUrl: string, input: Record<string, unknown>, outputPath: string): Promise<void> {
  const run = turn.then(async () => {
    const body = JSON.stringify({ input: Object.fromEntries(await Promise.all(Object.entries(input).map(async ([k, v]) => [k, await asDataUri(v)]))) })
    // A run takes minutes; Bun's fetch would otherwise give up on a quiet connection.
    const init: RequestInit & { timeout?: boolean } = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeout: false }
    for (;;) {
      const response = await fetch(`${baseUrl}/predictions`, init).catch((error: Error) => {
        throw new Error(`Couldn't reach the GPU server at ${baseUrl} (${error.message}). Is the PC on and Tailscale connected? Run it on Replicate instead with --on replicate.`)
      })
      if (response.status === 409) {
        console.log('The GPU server is busy with another run; waiting for it')
        await new Promise((resolve) => setTimeout(resolve, 15_000))
        continue
      }
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`The GPU server answered ${response.status} with something that isn't JSON: ${text.slice(0, 300)}. It was not run again.`)
      }
      const reply = PredictionReply.safeParse(parsed)
      if (!reply.success) throw new Error(`The GPU server answered ${response.status} with an unexpected reply: ${text.slice(0, 300)}. It was not run again.`)
      if (reply.data.metrics?.predict_time != null) console.log(`The GPU server rendered for ${reply.data.metrics.predict_time.toFixed(1)}s`)
      const result = reply.data
      if (!response.ok || result.status !== 'succeeded') {
        throw new Error(`The GPU server's run ${result.status ?? response.status}: ${result.error ?? JSON.stringify(result.detail ?? parsed).slice(0, 300)}. It was not run again.`)
      }
      const output = Array.isArray(result.output) ? result.output[0] : result.output
      const match = typeof output === 'string' ? output.match(/^data:[^;]*;base64,(.*)$/s) : null
      if (!match) throw new Error('The GPU server returned no file.')
      await writeFile(outputPath, Buffer.from(match[1], 'base64'))
      return
    }
  })
  // The next run waits on this one whether it succeeds or fails; its error still reaches the caller through `run`.
  turn = run.catch(() => undefined)
  return run
}
