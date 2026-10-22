// Visitors' polaroids in D1 and R2 (plans/in-progress/polaroids.md): what each
// status allows, and every change to a row. The routes are in index.ts.

export type Status = 'uploading' | 'submitted' | 'approved' | 'making' | 'made' | 'shown' | 'rejected' | 'failed'

export interface Row {
  id: string
  status: Status
  crop: string
  email: string | null
  clip_type: string | null
  clip_size: number | null
  error: string | null
  created_at: number
  updated_at: number
  approved_at: number | null
  made_at: number | null
  shown_at: number | null
}

export interface Crop {
  x: number
  y: number
  zoom: number
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Clips a browser records: 5 seconds is a few MB, so this is generous. */
export const CLIP_TYPES = ['video/webm', 'video/mp4', 'video/quicktime']
export const MAX_CLIP_BYTES = 60 * 1024 * 1024
/** Submissions waiting for a person: past this the inbox refuses more, so it can't be flooded. */
export const MAX_WAITING = 300
/** What the Mac uploads for a made polaroid, served from the public bucket as `<id>/<name>`. */
export const FILES: Record<string, string> = {
  'atlas.mp4': 'video/mp4',
  'atlas.webm': 'video/webm',
  'loop.mp4': 'video/mp4',
  'loop.webm': 'video/webm',
  'still.jpg': 'image/jpeg',
}

/** A moderation or queue decision: which statuses it applies to, and what it sets. */
const DECISIONS: Record<string, { from: Status[]; to: Status }> = {
  approve: { from: ['submitted', 'rejected'], to: 'approved' },
  reject: { from: ['submitted', 'approved', 'made', 'shown', 'failed'], to: 'rejected' },
  show: { from: ['made'], to: 'shown' },
  hide: { from: ['shown'], to: 'made' },
  reopen: { from: ['rejected'], to: 'submitted' },
  // Back in the queue: a failed one, or one the Mac stopped making partway.
  requeue: { from: ['failed', 'making'], to: 'approved' },
}
export const DECISION_NAMES = Object.keys(DECISIONS)

/** 96 random bits as hex: unguessable, since it's the visitor's private link. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const isId = (id: string) => /^[0-9a-f]{24}$/.test(id)

export function parseCrop(value: unknown): Crop {
  const c = value as Partial<Crop> | null
  const ok = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
  if (!c || !ok(c.x, 0, 1) || !ok(c.y, 0, 1) || !ok(c.zoom, 1, 4)) throw new HttpError(400, 'crop needs x and y from 0 to 1, and zoom from 1 to 4')
  return { x: c.x!, y: c.y!, zoom: c.zoom! }
}

export function parseEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, "That email address doesn't look right")
  return value.trim()
}

export async function get(db: D1Database, id: string): Promise<Row> {
  const row = isId(id) ? await db.prepare('SELECT * FROM polaroids WHERE id = ?').bind(id).first<Row>() : null
  if (!row) throw new HttpError(404, 'No such polaroid')
  return row
}

export async function create(db: D1Database, crop: Crop, email: string | null): Promise<Row> {
  const waiting = await db.prepare("SELECT count(*) AS n FROM polaroids WHERE status IN ('uploading', 'submitted')").first<number>('n')
  if ((waiting ?? 0) >= MAX_WAITING) throw new HttpError(503, 'Too many polaroids are waiting to be looked at. Try again in a few days.')
  const now = Date.now()
  const id = newId()
  await db
    .prepare("INSERT INTO polaroids (id, status, crop, email, created_at, updated_at) VALUES (?, 'uploading', ?, ?, ?, ?)")
    .bind(id, JSON.stringify(crop), email, now, now)
    .run()
  return get(db, id)
}

/** The visitor's clip, once: only while the row is still waiting for it. */
export async function receiveClip(env: Env, id: string, request: Request): Promise<Row> {
  const row = await get(env.DB, id)
  if (row.status !== 'uploading') throw new HttpError(409, 'This polaroid already has its clip')
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!CLIP_TYPES.includes(type)) throw new HttpError(415, `A clip is one of ${CLIP_TYPES.join(', ')}`)
  const size = Number(request.headers.get('content-length'))
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(411, 'The clip needs its length')
  if (size > MAX_CLIP_BYTES) throw new HttpError(413, 'That clip is too big')
  if (!request.body) throw new HttpError(400, 'No clip')

  await env.INBOX.put(id, request.body, { httpMetadata: { contentType: type } })
  const now = Date.now()
  const { meta } = await env.DB.prepare("UPDATE polaroids SET status = 'submitted', clip_type = ?, clip_size = ?, updated_at = ? WHERE id = ? AND status = 'uploading'")
    .bind(type, size, now, id)
    .run()
  if (meta.changes === 0) throw new HttpError(409, 'This polaroid already has its clip')
  return get(env.DB, id)
}

/** The gallery: shown polaroids, newest first, a page at a time (`before` is the last page's oldest `shownAt`). */
export async function gallery(db: D1Database, before: number | null, limit: number) {
  const { results } = await db
    .prepare("SELECT id, shown_at FROM polaroids WHERE status = 'shown' AND shown_at < ? ORDER BY shown_at DESC LIMIT ?")
    .bind(before ?? Number.MAX_SAFE_INTEGER, limit)
    .all<{ id: string; shown_at: number }>()
  return {
    polaroids: results.map((r) => ({ id: r.id, shownAt: r.shown_at })),
    next: results.length === limit ? results[results.length - 1].shown_at : null,
  }
}

/** What the visitor's private link shows: never their email or a failure's log. */
export const publicView = (row: Row) => ({ id: row.id, status: row.status, createdAt: row.created_at, shownAt: row.shown_at })

/** What the admin sees: everything but the email itself. */
export const adminView = (row: Row) => {
  const { email, crop, ...rest } = row
  return { ...rest, crop: JSON.parse(crop) as Crop, hasEmail: email !== null }
}

export async function decide(db: D1Database, id: string, decision: string): Promise<Row> {
  const rule = DECISIONS[decision]
  if (!rule) throw new HttpError(400, `A decision is one of ${DECISION_NAMES.join(', ')}`)
  const row = await get(db, id)
  if (!rule.from.includes(row.status)) throw new HttpError(409, `Can't ${decision} a polaroid that's ${row.status}`)
  const now = Date.now()
  const stamp = rule.to === 'approved' ? ', approved_at = ?4' : rule.to === 'shown' ? ', shown_at = ?4' : ''
  const { meta } = await db
    .prepare(`UPDATE polaroids SET status = ?1, updated_at = ?4, error = NULL${stamp} WHERE id = ?2 AND status = ?3`)
    .bind(rule.to, id, row.status, now)
    .run()
  if (meta.changes === 0) throw new HttpError(409, 'It changed while you were deciding: look again')
  return get(db, id)
}

/** The queue's next polaroid to make, the longest-approved first, marked `making` in the same statement. */
export async function claim(db: D1Database): Promise<Row | null> {
  const now = Date.now()
  return db
    .prepare(
      "UPDATE polaroids SET status = 'making', updated_at = ?1 WHERE id = (SELECT id FROM polaroids WHERE status = 'approved' ORDER BY approved_at LIMIT 1) AND status = 'approved' RETURNING *"
    )
    .bind(now)
    .first<Row>()
}

export async function putFile(env: Env, id: string, name: string, request: Request) {
  const type = FILES[name]
  if (!type) throw new HttpError(400, `A polaroid's files are ${Object.keys(FILES).join(', ')}`)
  const row = await get(env.DB, id)
  if (row.status !== 'making') throw new HttpError(409, `Files go up while it's making, and it's ${row.status}`)
  if (!request.body) throw new HttpError(400, 'No file')
  await env.POLAROIDS.put(`${id}/${name}`, request.body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=604800' } })
  return { id, name }
}

/**
 * Made: its files are up. The visitor's clip is deleted (nothing keeps it once the polaroid exists), and if
 * they left an email they're told it's ready, after which the address is cleared too.
 */
export async function done(env: Env, id: string) {
  const row = await get(env.DB, id)
  if (row.status !== 'making') throw new HttpError(409, `Only one that's making can be done, and it's ${row.status}`)
  const missing = (await Promise.all(['atlas.mp4', 'loop.mp4'].map(async (n) => ((await env.POLAROIDS.head(`${id}/${n}`)) ? null : n)))).filter(Boolean)
  if (missing.length > 0) throw new HttpError(409, `Upload ${missing.join(' and ')} first`)

  const now = Date.now()
  await env.DB.prepare("UPDATE polaroids SET status = 'made', made_at = ?, updated_at = ?, error = NULL WHERE id = ? AND status = 'making'").bind(now, now, id).run()
  await env.INBOX.delete(id)
  const emailed = row.email ? await sendReady(env, row.email, id) : false
  if (row.email) await env.DB.prepare('UPDATE polaroids SET email = NULL WHERE id = ?').bind(id).run()
  return { row: await get(env.DB, id), emailed }
}

export async function fail(db: D1Database, id: string, error: string) {
  const now = Date.now()
  const { meta } = await db
    .prepare("UPDATE polaroids SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'making'")
    .bind(error.slice(0, 4000), now, id)
    .run()
  if (meta.changes === 0) throw new HttpError(409, "Only one that's making can fail")
  return get(db, id)
}

/** Everything about one polaroid: its row, its clip and its files. */
export async function remove(env: Env, id: string) {
  await get(env.DB, id)
  await env.INBOX.delete(id)
  const files = await env.POLAROIDS.list({ prefix: `${id}/` })
  if (files.objects.length > 0) await env.POLAROIDS.delete(files.objects.map((o) => o.key))
  await env.DB.prepare('DELETE FROM polaroids WHERE id = ?').bind(id).run()
}

/** Submissions whose clip never arrived within a day: the row, and any part of a clip. */
export async function sweepAbandoned(env: Env) {
  const { results } = await env.DB.prepare("SELECT id FROM polaroids WHERE status = 'uploading' AND created_at < ?")
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .all<{ id: string }>()
  for (const { id } of results) await remove(env, id)
  return results.length
}

/** "Your polaroid is ready", with its private link. A failure is logged, not thrown: the polaroid is made either way. */
async function sendReady(env: Env, to: string, id: string): Promise<boolean> {
  const link = `${env.APP_URL}/?polaroid=${id}`
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM, name: 'Lysterfield Lake' },
      subject: 'Your polaroid is ready',
      text: `Your polaroid is ready. See it here:\n\n${link}\n\nThe link is yours: it's private until it goes in the gallery.`,
      html: `<p>Your polaroid is ready. <a href="${link}">See it here</a>.</p><p>The link is yours: it's private until it goes in the gallery.</p>`,
    })
    return true
  } catch (e) {
    console.error('polaroid email failed', id, (e as Error).message)
    return false
  }
}
