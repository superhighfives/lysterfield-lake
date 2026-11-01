import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createInbox, nextSteps, parseMaking, parseState, SETTLE_MS, type RunnerState } from './admin-inbox.ts'
import type { Task, TaskStatus } from './admin-queue.ts'

const A = 'a'.repeat(24)
const B = 'b'.repeat(24)
const task = (id: string, status: TaskStatus, log = ''): Task & { log: string } => ({ id, job: `visitor-${A}`, take: 'polaroid', action: 'polaroid-make', clip: false, args: [], lane: 'pc', status, created: 1, log })
const state = (patch: Partial<RunnerState> = {}): RunnerState => ({ on: true, runOn: 'pc', claims: {}, ...patch })
const none = () => undefined

describe('nextSteps', () => {
  test('claims the next one only when nothing is being made and the switch is on', () => {
    expect(nextSteps([], state(), none)).toEqual([{ kind: 'claim' }])
    expect(nextSteps([], state({ on: false }), none)).toEqual([])
  })

  test('starts a task for a fresh claim, and waits on one already running', () => {
    expect(nextSteps([{ id: A, updated_at: 5 }], state(), none)).toEqual([{ kind: 'start', id: A, claimedAt: 5 }])
    const running = state({ claims: { [A]: { claimedAt: 5, task: 't1' } } })
    expect(nextSteps([{ id: A, updated_at: 5 }], running, (id) => (id === 't1' ? task('t1', 'running') : undefined))).toEqual([])
  })

  test('switched off, it still waits for the one in progress without claiming more', () => {
    const running = state({ on: false, claims: { [A]: { claimedAt: 5, task: 't1' } } })
    expect(nextSteps([{ id: A, updated_at: 5 }], running, () => task('t1', 'running'))).toEqual([])
  })

  test("reports a failed task with the end of its log, and a stopped one as stopped", () => {
    const claimed = state({ claims: { [A]: { claimedAt: 5, task: 't1' } } })
    expect(nextSteps([{ id: A, updated_at: 5 }], claimed, () => task('t1', 'failed', 'step one\nerror: Bria refused\n'))).toEqual([{ kind: 'fail', id: A, error: 'step one\nerror: Bria refused' }])
    const [stopped] = nextSteps([{ id: A, updated_at: 5 }], claimed, () => task('t1', 'cancelled', 'portrait 3/120'))
    expect(stopped).toEqual({ kind: 'fail', id: A, error: 'Stopped from the admin.\n\nportrait 3/120' })
  })

  test("a later claim of the same submission is a new attempt, whatever the last one's task did", () => {
    const old = state({ claims: { [A]: { claimedAt: 5, task: 't1' } } })
    expect(nextSteps([{ id: A, updated_at: 9 }], old, () => task('t1', 'failed'))).toEqual([{ kind: 'start', id: A, claimedAt: 9 }])
  })

  test("forgets a claim once its submission isn't being made, and then claims the next", () => {
    const done = state({ claims: { [A]: { claimedAt: 5, task: 't1' } } })
    expect(nextSteps([], done, () => task('t1', 'succeeded'))).toEqual([{ kind: 'forget', id: A }, { kind: 'claim' }])
  })

  test("reports a claim whose task can't be found, rather than starting another", () => {
    const [step] = nextSteps([{ id: B, updated_at: 5 }], state({ claims: { [B]: { claimedAt: 5, task: 'gone' } } }), none)
    expect(step).toMatchObject({ kind: 'fail', id: B })
  })

  test('follows a task retried from the task list to its retry', () => {
    const claimed = state({ claims: { [A]: { claimedAt: 5, task: 't1' } } })
    const tasks: Record<string, ReturnType<typeof task>> = { t1: { ...task('t1', 'failed', 'first try'), retriedBy: 't2' }, t2: task('t2', 'running') }
    expect(nextSteps([{ id: A, updated_at: 5 }], claimed, (id) => tasks[id])).toEqual([])
    tasks.t2 = { ...task('t2', 'failed', 'second try') }
    expect(nextSteps([{ id: A, updated_at: 5 }], claimed, (id) => tasks[id])).toEqual([{ kind: 'fail', id: A, error: 'second try' }])
  })

  test('reports a task that succeeded without its submission being marked made, once that has had time to land', () => {
    const claimed = state({ claims: { [A]: { claimedAt: 5, task: 't1' } } })
    const done = { ...task('t1', 'succeeded', 'uploading still.jpg'), ended: 1_000 }
    expect(nextSteps([{ id: A, updated_at: 5 }], claimed, () => done, 1_000 + SETTLE_MS - 1)).toEqual([])
    const [step] = nextSteps([{ id: A, updated_at: 5 }], claimed, () => done, 1_000 + SETTLE_MS + 1)
    expect(step).toMatchObject({ kind: 'fail', id: A })
  })
})

describe('parseMaking', () => {
  test('takes a submission from the Worker', () => {
    expect(parseMaking({ id: A, updated_at: 3, status: 'making' })).toEqual({ id: A, updated_at: 3 })
  })

  test('refuses anything without a real id and time', () => {
    for (const bad of [null, 'x', { id: 'nope', updated_at: 3 }, { id: A }, { id: A, updated_at: '3' }]) expect(() => parseMaking(bad)).toThrow()
  })
})

describe('parseState', () => {
  test('reads back what the runner wrote', () => {
    const saved = state({ runOn: 'replicate', claims: { [A]: { claimedAt: 5, task: 't1' } } })
    expect(parseState(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })

  test('falls back to off and the 4090 for anything else', () => {
    expect(parseState(null)).toEqual({ on: false, runOn: 'pc', claims: {} })
    expect(parseState({ on: 'yes', runOn: 'gpu', claims: { [A]: { task: 1 } } })).toEqual({ on: false, runOn: 'pc', claims: {} })
  })
})

describe('the runner', () => {
  const realFetch = globalThis.fetch
  let dir: string
  let calls: { method: string; url: string; body?: string }[]
  let added: { job: string; args: string[] }[]
  let tasks: Record<string, Task & { log: string }>
  let close: (() => void) | undefined

  /** The Worker: `routes` maps "METHOD path" (after /api/admin/) to a reply. */
  const worker = (routes: Record<string, unknown>) => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const pathname = String(url).replace('http://worker.test/api/admin/', '')
      calls.push({ method, url: pathname, body: typeof init?.body === 'string' ? init.body : undefined })
      const key = `${method} ${pathname}`
      return key in routes ? Response.json(routes[key]) : Response.json({ error: `no route ${key}` }, { status: 404 })
    }) as typeof fetch
  }

  const start = (saved?: RunnerState) => {
    if (saved) writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify(saved))
    const inbox = createInbox({
      dir,
      env: () => ({ POLAROIDS_API: 'http://worker.test', POLAROIDS_ADMIN_TOKEN: 'secret' }),
      tasks: () => ({
        add: (job, _body, args) => {
          added.push({ job, args })
          const t = { ...task(`t${added.length}`, 'queued'), job, args }
          tasks[t.id] = t
          return t
        },
        get: (id) => tasks[id],
      }),
      jobName: (id) => `visitor-${id}`,
    })
    close = inbox.close
    return inbox
  }
  /** Lets the tick that starts with the runner finish. */
  const settle = async () => {
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const saved = () => parseState(JSON.parse(readFileSync(path.join(dir, 'inbox.json'), 'utf8')))

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'inbox-'))
    calls = []
    added = []
    tasks = {}
  })
  afterEach(() => {
    close?.()
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('switched on with nothing being made, claims the next and starts polaroid-make for it', async () => {
    worker({ 'GET polaroids?status=making': [], 'POST queue/claim': { id: A, updated_at: 7, status: 'making' } })
    const inbox = start(state())
    await settle()
    expect(added).toEqual([{ job: `visitor-${A}`, args: ['polaroid-make', '--id', A, '--on', 'pc'] }])
    expect(saved().claims).toEqual({ [A]: { claimedAt: 7, task: 't1' } })
    expect(inbox.runner().error).toBeUndefined()
  })

  test('switched off, claims nothing', async () => {
    worker({ 'GET polaroids?status=making': [] })
    start(state({ on: false }))
    await settle()
    expect(calls.map((c) => c.url)).toEqual(['polaroids?status=making'])
    expect(added).toEqual([])
  })

  test("reports a failed task to the Worker with its log, and forgets the claim", async () => {
    tasks.t9 = task('t9', 'failed', 'error: Bria refused')
    worker({ 'GET polaroids?status=making': [{ id: A, updated_at: 7 }], [`POST polaroids/${A}/failed`]: { id: A, status: 'failed' } })
    start(state({ on: false, claims: { [A]: { claimedAt: 7, task: 't9' } } }))
    await settle()
    const report = calls.find((c) => c.method === 'POST')
    expect(report).toMatchObject({ url: `polaroids/${A}/failed` })
    expect(JSON.parse(report?.body ?? '{}')).toEqual({ error: 'error: Bria refused' })
    expect(saved().claims).toEqual({})
  })

  test('keeps what went wrong reaching the Worker to show in the inbox, and starts nothing', async () => {
    worker({})
    const inbox = start(state())
    await settle()
    expect(inbox.runner().error).toContain('no route GET polaroids?status=making')
    expect(added).toEqual([])
  })
})
