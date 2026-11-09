import type { Crop } from '../../components/recorder.tsx'

// Visitors' polaroids from the app Worker's public API (worker/index.ts), and their files from the public bucket
// (VITE_APP_POLAROIDS_URL; in dev, this machine's own jobs through the dev server).

export type Status = 'uploading' | 'submitted' | 'approved' | 'making' | 'made' | 'shown' | 'rejected' | 'failed'
/** A visitor's polaroid as its private link sees it: `ahead` is how many the queue makes first, while it's queued. */
export type PolaroidStatus = { id: string; status: Status; createdAt: number; shownAt: number | null; ahead: number | null }
export type GalleryPage = { polaroids: { id: string; shownAt: number }[]; next: number | null }

const files = (import.meta.env.VITE_APP_POLAROIDS_URL ?? '').replace(/\/+$/, '')
export const polaroidFile = (id: string, name: 'atlas.mp4' | 'loop.mp4' | 'still.jpg') => `${files}/${id}/${name}`

export const isPolaroidId = (id: string) => /^[0-9a-f]{24}$/.test(id)

async function call<T>(url: string, init?: Parameters<typeof fetch>[1]): Promise<T> {
  const res = await fetch(url, init)
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `Something went wrong (${res.status})`
    throw new Error(message)
  }

  // The Worker's own replies, typed by the caller: worker/index.ts is the other side of this.
  return body as T
}

/** Every shown polaroid, newest first, a page at a time up to `max`. */
export async function loadGallery(max = 1000): Promise<GalleryPage['polaroids']> {
  const all: GalleryPage['polaroids'] = []
  let before: number | null = null
  do {
    const page: GalleryPage = await call(`/api/polaroids?limit=200${before ? `&before=${before}` : ''}`)
    all.push(...page.polaroids)
    before = page.next
  } while (before !== null && all.length < max)

  return all
}

export const loadStatus = (id: string) => call<PolaroidStatus>(`/api/polaroids/${id}`)

/** A new submission: its row (Turnstile checked there), then its clip. Returns the private link's id. */
export async function submit({ blob, crop }: { blob: Blob; crop: Crop }, email: string, turnstile: string): Promise<string> {
  const { id, upload } = await call<{ id: string; upload: string }>('/api/polaroids', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ crop, email: email.trim() || undefined, turnstile }),
  })
  await call(upload, { method: 'PUT', headers: { 'content-type': blob.type.split(';')[0] }, body: blob })
  return id
}
