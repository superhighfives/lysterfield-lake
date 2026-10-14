import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The /admin page's task queue (dev only, like the rest of vite-plugin-admin.ts).
 *
 * Every pipeline command the page starts is a task: a check, a set of
 * samples, a clip, a full song, a repair. Tasks are files in
 * `apps/pipeline/.jobs/_queue/` (`<id>.json`, `<id>.log`, `<id>.exit`), and
 * each runs as its own detached process, so the list, the logs and the runs
 * themselves survive the dev server restarting.
 *
 * It is local on purpose. The pipeline works on frames on this machine
 * (ffmpeg, the person check's model, hard links), so a hosted queue could
 * only ever hand work back to a consumer running here.
 *
 * Several tasks run at once, within limits:
 * - a lane's capacity: Replicate runs a few at a time; the person check
 *   uses this machine's GPU, so one at a time;
 * - one task per dream at a time, since they read and write the same
 *   frames, `replaced/` and `check.json`.
 */

export type Lane = 'replicate' | 'local' | 'quick' | 'instant'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export interface Task {
  id: string
  job: string
  take: string
  action: string
  /** The task is about the take's 15-second clip rather than its full song. */
  clip: boolean
  args: string[]
  lane: Lane
  status: TaskStatus
  created: number
  started?: number
  ended?: number
  pid?: number
  /** The task that retried this one: a task is retried once, so a double click can't queue it twice. */
  retriedBy?: string
}

/** How many tasks a lane runs at once. `instant` tasks (creating a take, approvals, notes) take milliseconds and never wait. */
const CAPACITY: Record<Lane, number> = { replicate: 3, local: 1, quick: Infinity, instant: Infinity }
const LANES: Record<string, Lane> = { directions: 'replicate', samples: 'replicate', clip: 'replicate', full: 'replicate', rerender: 'replicate', check: 'local', hold: 'quick' }
/** Finished tasks kept on disk; older ones are swept when the queue loads. */
const KEEP_FINISHED = 100

const ended = (task: Task) => task.status !== 'queued' && task.status !== 'running'

export function createQueue(opts: { dir: string; cwd: string; env: () => NodeJS.ProcessEnv }) {
  const { dir } = opts
  mkdirSync(dir, { recursive: true })
  const file = (id: string, ext: string) => path.join(dir, `${id}.${ext}`)
  const save = (task: Task) => writeFileSync(file(task.id, 'json'), `${JSON.stringify(task, null, 2)}\n`)
  const remove = (id: string) => ['json', 'log', 'exit'].forEach((ext) => rmSync(file(id, ext), { force: true }))

  const tasks = new Map<string, Task>()
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const task = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Task
      tasks.set(task.id, task)
    } catch {
      // A half-written task file from a crash: nothing to recover.
    }
  }
  for (const old of Array.from(tasks.values()).filter(ended).slice(0, -KEEP_FINISHED)) {
    tasks.delete(old.id)
    remove(old.id)
  }

  const alive = (pid?: number) => {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function start(task: Task) {
    // Detached, with its output and exit code going to files rather than to this process, so the
    // task outlives a dev-server restart and its result can still be read afterwards.
    const out = openSync(file(task.id, 'log'), 'a')
    const child = spawn('sh', ['-c', 'bun run src/cli.ts "$@"; echo $? > "$EXIT"', 'task', ...task.args], {
      cwd: opts.cwd,
      env: { ...opts.env(), EXIT: file(task.id, 'exit') },
      detached: true,
      stdio: ['ignore', out, out],
    })
    closeSync(out)
    child.unref()
    Object.assign(task, { status: 'running', started: Date.now(), pid: child.pid })
    save(task)
  }

  function finish(task: Task, status: TaskStatus) {
    Object.assign(task, { status, ended: Date.now() })
    save(task)
  }

  /** Settles tasks whose process has ended, then starts whatever the lanes and the per-dream rule now allow. */
  function pump() {
    const all = Array.from(tasks.values())
    for (const task of all.filter((t) => t.status === 'running')) {
      if (existsSync(file(task.id, 'exit'))) finish(task, readFileSync(file(task.id, 'exit'), 'utf8').trim() === '0' ? 'succeeded' : 'failed')
      // No exit code and no process: it was killed, or the machine restarted under it.
      else if (!alive(task.pid)) finish(task, 'failed')
    }
    for (const task of all.filter((t) => t.status === 'queued')) {
      const running = Array.from(tasks.values()).filter((t) => t.status === 'running')
      if (running.filter((t) => t.lane === task.lane).length >= CAPACITY[task.lane]) continue
      if (task.lane !== 'instant' && running.some((t) => t.lane !== 'instant' && t.job === task.job && t.take === task.take)) continue
      // Tasks for one dream run in the order they were asked for.
      if (task.lane !== 'instant' && all.some((t) => t.status === 'queued' && t.created < task.created && t.lane !== 'instant' && t.job === task.job && t.take === task.take)) continue
      start(task)
    }
  }
  const timer = setInterval(pump, 1000)
  timer.unref()
  pump()

  /** The end of a task's log: enough for progress and the error, without sending a long run's whole output every poll. */
  function logTail(id: string, bytes: number): string {
    if (!existsSync(file(id, 'log'))) return ''
    const { size } = statSync(file(id, 'log'))
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    const fd = openSync(file(id, 'log'), 'r')
    readSync(fd, buffer, 0, length, size - length)
    closeSync(fd)
    return buffer.toString('utf8')
  }

  return {
    add(job: string, body: Record<string, unknown>, args: string[]): Task {
      const action = String(body.action)
      const task: Task = {
        // Sorts by time, so the files (and the list) are in the order tasks were asked for.
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        job,
        take: String(body.take ?? ''),
        action,
        clip: body.clip === true,
        args,
        lane: LANES[action] ?? 'instant',
        status: 'queued',
        created: Date.now(),
      }
      tasks.set(task.id, task)
      save(task)
      pump()
      return task
    },
    get(id: string) {
      const task = tasks.get(id)
      return task && { ...task, log: logTail(id, 20_000) }
    },
    /** A job's tasks that someone would want to see: everything waiting or running, and the most recent finished ones. */
    list(job: string) {
      const mine = Array.from(tasks.values()).filter((t) => t.job === job && t.lane !== 'instant')
      return [...mine.filter((t) => !ended(t)), ...mine.filter(ended).slice(-12)]
        .sort((a, b) => a.created - b.created)
        .map((t) => ({ ...t, log: logTail(t.id, t.status === 'failed' ? 6000 : 600) }))
    },
    /**
     * Stops a task. A waiting one just never starts. A running one has its process stopped; a
     * Replicate run it had already started carries on there, and starting the task again picks
     * that same run back up rather than paying for another.
     */
    cancel(id: string) {
      const task = tasks.get(id)
      if (!task || ended(task)) return
      if (task.status === 'running' && task.pid) {
        // The whole process group: the shell, the pipeline, and anything it started (the person
        // check's Python). SIGTERM first; anything still there a few seconds later is killed outright,
        // since `bun run` doesn't always pass SIGTERM on and left checks running when it was the only
        // signal sent.
        const group = -task.pid
        const signal = (name: NodeJS.Signals) => {
          try {
            process.kill(group, name)
          } catch {
            // Already gone.
          }
        }
        signal('SIGTERM')
        setTimeout(() => signal('SIGKILL'), 3000).unref()
      }
      finish(task, 'cancelled')
      pump()
    },
    /**
     * Runs a failed or stopped task again, as a new task at the back of the queue. Finished work is
     * kept, so it only redoes what didn't finish. A Replicate run that failed is replaced with a
     * fresh one (`--retry true`); one still going or done is picked back up, never paid for twice.
     */
    retry(id: string): Task | undefined {
      const old = tasks.get(id)
      if (!old || (old.status !== 'failed' && old.status !== 'cancelled') || old.retriedBy) return undefined
      const args = old.lane === 'replicate' && !old.args.includes('--retry') ? [...old.args, '--retry', 'true'] : old.args
      const task: Task = { ...old, retriedBy: undefined, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, args, status: 'queued', created: Date.now(), started: undefined, ended: undefined, pid: undefined }
      tasks.set(task.id, task)
      save(task)
      old.retriedBy = task.id
      save(old)
      pump()
      return task
    },
    /** Stops pumping. A dev-server restart makes a new queue over the same files, and two pumping queues could both start one queued task. */
    close() {
      clearInterval(timer)
    },
    /** Forgets a job's finished tasks. */
    clear(job: string) {
      for (const task of Array.from(tasks.values()).filter((t) => t.job === job && ended(t))) {
        tasks.delete(task.id)
        remove(task.id)
      }
    },
  }
}
