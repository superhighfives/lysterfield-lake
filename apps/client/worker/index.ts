// The next app's Worker (plans/in-progress/polaroids.md, step 2). The built
// site is static assets (wrangler.jsonc); only /api comes here.
//
// Visitors: POST /api/polaroids (Turnstile, then a row), PUT its clip to
// /api/polaroids/<id>/clip, and GET /api/polaroids/<id> (the private link).
// The gallery is GET /api/polaroids.
//
// The Mac, with ADMIN_TOKEN: /api/admin/polaroids to moderate, and
// /api/admin/queue/claim, files, done and failed to make them.

import {
  adminView,
  claim,
  create,
  decide,
  done,
  fail,
  gallery,
  get,
  HttpError,
  parseCrop,
  parseEmail,
  publicView,
  putFile,
  receiveClip,
  remove,
  sweepAbandoned,
  type Status,
} from './polaroids.ts'

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new HttpError(400, 'Send JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object')
  return body as Record<string, unknown>
}

/** Turnstile's answer for this visitor. Without a secret configured nothing gets in. */
async function checkTurnstile(env: Env, token: unknown, ip: string | null) {
  if (!env.TURNSTILE_SECRET) throw new HttpError(503, "Submissions aren't open yet")
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'Missing the human check')
  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET)
  form.append('response', token)
  if (ip) form.append('remoteip', ip)
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  const result: unknown = res.ok ? await res.json().catch(() => null) : null
  if (typeof result !== 'object' || result === null || !('success' in result)) throw new HttpError(503, "The human check isn't answering: try again in a minute")
  if (result.success !== true) throw new HttpError(403, "The human check didn't pass: try again")
}

/** The Mac's key, compared in constant time. */
async function checkAdmin(env: Env, request: Request) {
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  if (!env.ADMIN_TOKEN || !given) throw new HttpError(401, 'Not allowed')
  const digest = async (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  const [a, b] = await Promise.all([digest(given), digest(env.ADMIN_TOKEN)])
  if (!crypto.subtle.timingSafeEqual(a, b)) throw new HttpError(401, 'Not allowed')
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean).slice(1) // after "api"
  const method = request.method

  if (parts[0] === 'polaroids') {
    const id = parts[1]
    if (!id && method === 'GET') {
      const before = Number(url.searchParams.get('before')) || null
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200)
      return json(await gallery(env.DB, before, limit))
    }
    if (!id && method === 'POST') {
      const body = await readJson(request)
      const crop = parseCrop(body.crop)
      const email = parseEmail(body.email)
      await checkTurnstile(env, body.turnstile, request.headers.get('cf-connecting-ip'))
      const row = await create(env.DB, crop, email)
      return json({ id: row.id, upload: `/api/polaroids/${row.id}/clip` }, 201)
    }
    if (id && parts[2] === 'clip' && method === 'PUT') return json(publicView(await receiveClip(env, id, request)))
    if (id && !parts[2] && method === 'GET') return json(publicView(await get(env.DB, id)))
  }

  if (parts[0] === 'admin') {
    await checkAdmin(env, request)
    const [, what, id, action, name] = parts
    if (what === 'polaroids' && !id && method === 'GET') {
      const statuses = (url.searchParams.get('status') ?? '').split(',').filter(Boolean) as Status[]
      const where = statuses.length > 0 ? `WHERE status IN (${statuses.map(() => '?').join(', ')})` : ''
      const { results } = await env.DB.prepare(`SELECT * FROM polaroids ${where} ORDER BY created_at DESC LIMIT 500`)
        .bind(...statuses)
        .all()
      return json(results.map((r) => adminView(r as never)))
    }
    if (what === 'polaroids' && id && !action && method === 'GET') return json(adminView(await get(env.DB, id)))
    if (what === 'polaroids' && id && !action && method === 'DELETE') {
      await remove(env, id)
      return json({ id, deleted: true })
    }
    if (what === 'polaroids' && id && action === 'clip' && method === 'GET') {
      await get(env.DB, id)
      const clip = await env.INBOX.get(id)
      if (!clip) throw new HttpError(404, 'Its clip is gone')
      return new Response(clip.body, { headers: { 'content-type': clip.httpMetadata?.contentType ?? 'application/octet-stream', 'content-length': String(clip.size) } })
    }
    if (what === 'polaroids' && id && action === 'review' && method === 'POST') return json(adminView(await decide(env.DB, id, String((await readJson(request)).decision))))
    if (what === 'polaroids' && id && action === 'files' && name && method === 'PUT') return json(await putFile(env, id, name, request))
    if (what === 'polaroids' && id && action === 'done' && method === 'POST') {
      const result = await done(env, id)
      return json({ ...adminView(result.row), emailed: result.emailed })
    }
    if (what === 'polaroids' && id && action === 'failed' && method === 'POST') return json(adminView(await fail(env.DB, id, String((await readJson(request)).error ?? 'failed'))))
    if (what === 'queue' && id === 'claim' && method === 'POST') {
      const row = await claim(env.DB)
      return json(row ? adminView(row) : null)
    }
  }

  throw new HttpError(404, 'Not found')
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      console.error(e)
      return json({ error: 'Something went wrong' }, 500)
    }
  },
  async scheduled(_controller, env) {
    const swept = await sweepAbandoned(env)
    if (swept > 0) console.log(`swept ${swept} abandoned submissions`)
  },
} satisfies ExportedHandler<Env>
