import { writeFile } from 'node:fs/promises'
import { z } from 'zod'

/**
 * The app Worker's admin API for visitors' polaroids (apps/client/worker, plans/in-progress/polaroids.md):
 * the Mac reads a claimed submission, downloads its clip, uploads what it made and marks it done.
 * `POLAROIDS_API` (the app's address) and `POLAROIDS_ADMIN_TOKEN` (the Worker's ADMIN_TOKEN) come from
 * apps/pipeline/.env, never the code.
 */

/** A submission as the Worker's `adminView` returns it: the row without the email itself. */
export const Submission = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/),
  status: z.enum(['uploading', 'submitted', 'approved', 'making', 'made', 'shown', 'rejected', 'failed']),
  crop: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
  hasEmail: z.boolean(),
  clip_type: z.string().nullable(),
  clip_size: z.number().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  approved_at: z.number().nullable(),
  made_at: z.number().nullable(),
  shown_at: z.number().nullable(),
})
export type Submission = z.infer<typeof Submission>

/** The files a made polaroid uploads, with their content types: the Worker's `FILES` accepts these names. */
export const UPLOADS = { 'atlas.mp4': 'video/mp4', 'loop.mp4': 'video/mp4', 'still.jpg': 'image/jpeg' } as const
export type UploadName = keyof typeof UPLOADS

/** A clip's extension from its type, as /admin/record names a recording's file. ffmpeg reads all three. */
export function clipExtension(type: string | null): 'mp4' | 'mov' | 'webm' {
  if (type?.startsWith('video/mp4')) return 'mp4'
  if (type?.startsWith('video/quicktime')) return 'mov'
  return 'webm'
}

/** The local job a submission is made in: one per submission, so a retry finds what the last attempt made. */
export const submissionJobName = (id: string) => `visitor-${id}`

function config() {
  const base = process.env.POLAROIDS_API?.replace(/\/+$/, '')
  const token = process.env.POLAROIDS_ADMIN_TOKEN
  if (!base || !token) throw new Error('POLAROIDS_API and POLAROIDS_ADMIN_TOKEN need setting in apps/pipeline/.env')
  return { base, token }
}

async function call(pathname: string, init: RequestInit = {}): Promise<Response> {
  const { base, token } = config()
  const response = await fetch(`${base}/api/admin/${pathname}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message = z.object({ error: z.string() }).safeParse(body)
    throw new Error(`${init.method ?? 'GET'} /api/admin/${pathname}: ${response.status} ${message.success ? message.data.error : response.statusText}`)
  }
  return response
}

export async function getSubmission(id: string): Promise<Submission> {
  return Submission.parse(await (await call(`polaroids/${id}`)).json())
}

/** Saves the visitor's clip to `file`. */
export async function downloadClip(id: string, file: string): Promise<void> {
  const response = await call(`polaroids/${id}/clip`)
  await writeFile(file, new Uint8Array(await response.arrayBuffer()))
}

export async function uploadFile(id: string, name: UploadName, file: string): Promise<void> {
  await call(`polaroids/${id}/files/${name}`, { method: 'PUT', headers: { 'content-type': UPLOADS[name] }, body: Bun.file(file) })
}

/** Made: the Worker deletes the clip and emails the visitor their link. */
export async function markDone(id: string): Promise<{ emailed: boolean }> {
  return z.object({ emailed: z.boolean() }).parse(await (await call(`polaroids/${id}/done`, { method: 'POST' })).json())
}
