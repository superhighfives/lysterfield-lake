import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clipExtension, getSubmission, markDone, submissionJobName } from './polaroids-api.ts'

const row = {
  id: 'a1b2c3d4e5f6a7b8c9d0e1f2',
  status: 'making',
  crop: { x: 0.5, y: 0.6, zoom: 1.2 },
  hasEmail: true,
  clip_type: 'video/webm',
  clip_size: 4096,
  error: null,
  created_at: 1,
  updated_at: 2,
  approved_at: 2,
  made_at: null,
  shown_at: null,
}

describe('clipExtension', () => {
  test('follows the clip type, with codecs or without', () => {
    expect(clipExtension('video/mp4')).toBe('mp4')
    expect(clipExtension('video/mp4;codecs=avc1')).toBe('mp4')
    expect(clipExtension('video/quicktime')).toBe('mov')
    expect(clipExtension('video/webm')).toBe('webm')
    expect(clipExtension(null)).toBe('webm')
  })
})

test('submissionJobName is one job per submission', () => {
  expect(submissionJobName(row.id)).toBe(`visitor-${row.id}`)
})

describe('the admin API', () => {
  const realFetch = globalThis.fetch
  const env = { api: process.env.POLAROIDS_API, token: process.env.POLAROIDS_ADMIN_TOKEN }
  let calls: { url: string; init?: RequestInit }[]
  const reply = (body: unknown, status = 200) => {
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return Response.json(body, { status })
      },
      { preconnect: realFetch.preconnect }
    )
  }

  beforeEach(() => {
    calls = []
    process.env.POLAROIDS_API = 'https://app.test/'
    process.env.POLAROIDS_ADMIN_TOKEN = 'secret'
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    for (const [key, value] of [['POLAROIDS_API', env.api], ['POLAROIDS_ADMIN_TOKEN', env.token]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('sends the token to the admin route', async () => {
    reply(row)
    expect((await getSubmission(row.id)).status).toBe('making')
    expect(calls[0].url).toBe(`https://app.test/api/admin/polaroids/${row.id}`)
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer secret')
  })

  test("says what the Worker refused, and why", async () => {
    reply({ error: 'Upload atlas.mp4 and loop.mp4 first' }, 409)
    await expect(markDone(row.id)).rejects.toThrow(`POST /api/admin/polaroids/${row.id}/done: 409 Upload atlas.mp4 and loop.mp4 first`)
  })

  test("refuses a reply that isn't a submission", async () => {
    reply({ ...row, status: 'lost' })
    await expect(getSubmission(row.id)).rejects.toThrow()
  })

  test('needs its settings', async () => {
    delete process.env.POLAROIDS_ADMIN_TOKEN
    await expect(getSubmission(row.id)).rejects.toThrow('POLAROIDS_API and POLAROIDS_ADMIN_TOKEN')
  })
})
