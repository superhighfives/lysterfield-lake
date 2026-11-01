import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Task } from './admin-queue.ts'

/**
 * Visitors' submissions, for /admin/polaroid's inbox (plans/in-progress/polaroids.md, step 3; dev only, like the
 * rest of vite-plugin-admin.ts). The submissions live in the app Worker's D1 (apps/client/worker); this reaches
 * its admin API with the pipeline's POLAROIDS_API and POLAROIDS_ADMIN_TOKEN, so the token never reaches a page.
 *
 * "Run the queue": while it's on, the runner claims the longest-approved submission and starts one
 * `polaroid-make` task for it on the task queue (admin-queue.ts), which makes it and marks it made. One at a
 * time; switching it off finishes the one in progress, then stops claiming. A task that fails or is stopped
 * marks its submission failed with the end of its log, and nothing is retried until a person asks (CLAUDE.md):
 * "Try again" in the inbox puts it back in the queue, and the job keeps what the last attempt made.
 *
 * Which task belongs to which claim is kept in `_queue/inbox.json` with the switch, so a dev-server restart
 * picks up where it was: a task still running is waited for, one that ended is reported.
 */

export type RunOn = 'pc' | 'replicate'
export interface Claim {
  /** The submission's `updated_at` when it was claimed: a later claim of the same submission is a new attempt. */
  claimedAt: number
  task: string
}
export interface RunnerState {
  on: boolean
  runOn: RunOn
  claims: Record<string, Claim>
}

/** The parts of a submission (the Worker's `adminView`) the runner reads. */
export interface Making {
  id: string
  updated_at: number
}

export type Step = { kind: 'start'; id: string; claimedAt: number } | { kind: 'fail'; id: string; error: string } | { kind: 'forget'; id: string } | { kind: 'claim' }

/** How much of a failed task's log goes into the submission's `error` (the Worker keeps 4000 characters). */
const ERROR_LOG = 3000

/**
 * What the runner does next, given the submissions being made and the tasks it started for them:
 * - a claim with no task of its own yet (just claimed, or claimed again after a failure): start one;
 * - one whose task failed or was stopped: report it, with the end of the task's log;
 * - a claim whose submission is no longer being made (made, or moved on in the inbox): forget it;
 * - nothing being made and the switch on: claim the next.
 * A task that succeeded has already marked its submission made, so it's no longer `making`.
 */
export function nextSteps(making: Making[], state: RunnerState, task: (id: string) => (Task & { log: string }) | undefined): Step[] {
  const steps: Step[] = []
  for (const row of making) {
    const claim = state.claims[row.id]
    const current = claim?.claimedAt === row.updated_at ? task(claim.task) : undefined
    if (!current) steps.push({ kind: 'start', id: row.id, claimedAt: row.updated_at })
    else if (current.status === 'failed' || current.status === 'cancelled') {
      const tail = current.log.trim().slice(-ERROR_LOG)
      steps.push({ kind: 'fail', id: row.id, error: current.status === 'cancelled' ? `Stopped from the admin.\n\n${tail}` : tail || 'polaroid-make failed' })
    }
  }
  for (const id of Object.keys(state.claims)) if (!making.some((row) => row.id === id)) steps.push({ kind: 'forget', id })
  if (state.on && making.length === 0) steps.push({ kind: 'claim' })
  return steps
}

const DEFAULT_STATE: RunnerState = { on: false, runOn: 'pc', claims: {} }

/** A submission from the Worker, checked for the two fields the runner needs. */
export function parseMaking(value: unknown): Making {
  if (typeof value === 'object' && value !== null && 'id' in value && 'updated_at' in value && typeof value.id === 'string' && /^[0-9a-f]{24}$/.test(value.id) && typeof value.updated_at === 'number') {
    return { id: value.id, updated_at: value.updated_at }
  }
  throw new Error('The inbox sent a submission without an id or time')
}

/** The runner's state file, or the defaults for anything in it that isn't what the runner wrote. */
export function parseState(value: unknown): RunnerState {
  if (typeof value !== 'object' || value === null) return DEFAULT_STATE
  const on = 'on' in value && value.on === true
  const runOn = 'runOn' in value && value.runOn === 'replicate' ? 'replicate' : 'pc'
  const claims: Record<string, Claim> = {}
  const saved = 'claims' in value && typeof value.claims === 'object' && value.claims !== null ? Object.entries(value.claims) : []
  for (const [id, claim] of saved) {
    if (typeof claim === 'object' && claim !== null && 'claimedAt' in claim && 'task' in claim && typeof claim.claimedAt === 'number' && typeof claim.task === 'string') claims[id] = { claimedAt: claim.claimedAt, task: claim.task }
  }
  return { on, runOn, claims }
}

export function createInbox(opts: {
  /** `_queue/`: the runner's state file sits with the task queue's. */
  dir: string
  env: () => NodeJS.ProcessEnv
  tasks: () => {
    add(job: string, body: Record<string, unknown>, args: string[]): Task
    get(id: string): (Task & { log: string }) | undefined
  }
  /** The local job a submission is made in (the pipeline's `submissionJobName`). */
  jobName: (id: string) => string
}) {
  const file = path.join(opts.dir, 'inbox.json')
  let state = existsSync(file) ? parseState(JSON.parse(readFileSync(file, 'utf8'))) : DEFAULT_STATE
  const save = () => writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  /** The last tick's failure (the Worker unreachable, say), shown in the inbox until a tick succeeds. */
  let lastError: string | undefined
  let ticking = false

  function config() {
    const env = opts.env()
    const base = env.POLAROIDS_API?.replace(/\/+$/, '')
    const token = env.POLAROIDS_ADMIN_TOKEN
    return base && token ? { base, token } : undefined
  }

  /** The Worker's admin API. Its own error message, if it gave one, becomes the thrown error's. */
  async function worker(pathname: string, init: RequestInit = {}): Promise<Response> {
    const settings = config()
    if (!settings) throw new Error('Set POLAROIDS_API and POLAROIDS_ADMIN_TOKEN in apps/pipeline/.env to reach the inbox')
    const response = await fetch(`${settings.base}/api/admin/${pathname}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${settings.token}` } })
    if (response.ok) return response
    const body: unknown = await response.json().catch(() => null)
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : response.statusText
    throw new Error(`The inbox said: ${message}`)
  }
  const workerJson = async (pathname: string, init?: RequestInit): Promise<unknown> => (await worker(pathname, init)).json()

  function start(id: string, claimedAt: number) {
    const job = opts.jobName(id)
    const task = opts.tasks().add(job, { action: 'polaroid-make', take: 'polaroid', on: state.runOn }, ['polaroid-make', '--id', id, '--on', state.runOn])
    state = { ...state, claims: { ...state.claims, [id]: { claimedAt, task: task.id } } }
    save()
  }

  function forget(id: string) {
    if (!(id in state.claims)) return
    const { [id]: _gone, ...claims } = state.claims
    state = { ...state, claims }
    save()
  }

  async function tick() {
    if (ticking || !config()) return
    ticking = true
    try {
      const rows = await workerJson('polaroids?status=making')
      if (!Array.isArray(rows)) throw new Error("The inbox's list of submissions being made wasn't a list")
      for (const step of nextSteps(rows.map(parseMaking), state, (id) => opts.tasks().get(id))) {
        if (step.kind === 'start') start(step.id, step.claimedAt)
        if (step.kind === 'forget') forget(step.id)
        if (step.kind === 'fail') {
          await worker(`polaroids/${step.id}/failed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: step.error }) })
          forget(step.id)
        }
        if (step.kind === 'claim') {
          // Nothing approved to claim: the Worker says null.
          const claimed = await workerJson('queue/claim', { method: 'POST' })
          if (claimed === null) continue
          const row = parseMaking(claimed)
          start(row.id, row.updated_at)
        }
      }
      lastError = undefined
    } catch (error) {
      // Kept to show in the inbox, and tried again on the next tick: nothing here spends money.
      lastError = (error as Error).message
    } finally {
      ticking = false
    }
  }

  // Ticks whether the switch is on or not: switched off, it still reports the one in progress when it ends.
  const timer = setInterval(() => void tick(), 15000)
  timer.unref()
  void tick()

  return {
    worker,
    workerJson,
    tick,
    forget,
    configured: () => config() !== undefined,
    runner: () => ({ on: state.on, runOn: state.runOn, error: lastError, claims: state.claims }),
    set(patch: { on?: boolean; runOn?: RunOn }) {
      state = { ...state, ...patch }
      save()
      void tick()
    },
    close() {
      clearInterval(timer)
    },
  }
}
