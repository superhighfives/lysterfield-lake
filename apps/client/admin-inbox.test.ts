import { describe, expect, test } from 'vitest'
import { nextSteps, parseMaking, parseState, type RunnerState } from './admin-inbox.ts'
import type { Task, TaskStatus } from './admin-queue.ts'

const A = 'a'.repeat(24)
const B = 'b'.repeat(24)
const task = (id: string, status: TaskStatus, log = '') => ({ id, job: `visitor-${A}`, take: 'polaroid', action: 'polaroid-make', clip: false, args: [], lane: 'pc', status, created: 1, log }) satisfies Task & { log: string }
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

  test('a claim whose task was swept from the queue starts again', () => {
    expect(nextSteps([{ id: B, updated_at: 5 }], state({ claims: { [B]: { claimedAt: 5, task: 'gone' } } }), none)).toEqual([{ kind: 'start', id: B, claimedAt: 5 }])
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
