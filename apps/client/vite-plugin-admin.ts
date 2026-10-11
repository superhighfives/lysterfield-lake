import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/**
 * Dev-only API for the /admin page (plans/ready/frame-preview-approval-tool.md):
 * reads `apps/pipeline/.jobs`, serves job files read-only, and runs the
 * pipeline's dream preview-loop commands. `apply: 'serve'` means none of
 * this exists in a production build.
 */

const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pipeline')
const JOBS_DIR = path.join(PIPELINE_DIR, '.jobs')

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mov': 'video/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
}

type Run = { id: string; job: string; args: string[]; status: 'running' | 'succeeded' | 'failed'; log: string }
const runs = new Map<string, Run>()

/** Pipeline env from its .env, applied over the dev server's own, so the shell's tokens never win. */
function pipelineEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const file = path.join(PIPELINE_DIR, '.env')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
  return env
}

function jobDir(job: string): string {
  if (!/^[\w-]+$/.test(job) || job === 'spikes') throw new Error(`Bad job name "${job}"`)
  const dir = path.join(JOBS_DIR, job)
  if (!existsSync(path.join(dir, 'job.json'))) throw new Error(`No job "${job}"`)
  return dir
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function listJobs() {
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'spikes' && existsSync(path.join(JOBS_DIR, d.name, 'job.json')))
    .map((d) => d.name)
}

function jobDetail(job: string) {
  const dir = jobDir(job)
  const dreams = path.join(dir, '7-dreams')
  const takes = existsSync(dreams)
    ? readdirSync(dreams, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(path.join(dreams, d.name, 'take.json')))
        .map((d) => {
          const take = path.join(dreams, d.name)
          const samplesDir = path.join(take, 'samples')
          return {
            id: d.name,
            ...(readJson(path.join(take, 'take.json')) as object),
            samples: existsSync(samplesDir) ? readdirSync(samplesDir).filter((f) => f.endsWith('.jpg')).map((f) => Number(f.slice(0, 4))) : [],
            hasPreview: existsSync(path.join(take, 'preview', 'video.mov')),
            modified: statSync(path.join(take, 'take.json')).mtimeMs,
          }
        })
        .sort((a, b) => b.modified - a.modified)
    : []
  const directionsDir = path.join(dreams, '_directions')
  const directions = existsSync(directionsDir)
    ? readdirSync(directionsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .map((file) => ({ file, ...(readJson(path.join(directionsDir, file)) as object) }))
    : []
  return { name: job, config: readJson(path.join(dir, 'job.json')), takes, directions }
}

/** The pipeline command for an admin action. Each one is a stage of the loop; the pipeline enforces the approval order itself. */
function actionArgs(job: string, body: Record<string, unknown>): string[] {
  const take = String(body.take ?? '')
  const takeOk = /^[\w-]+$/.test(take)
  const base = ['--job', `.jobs/${job}`]
  switch (body.action) {
    case 'directions':
      if (!body.brief) throw new Error('brief is required')
      return ['dream-directions', ...base, '--brief', String(body.brief), ...(body.count ? ['--count', String(body.count)] : [])]
    case 'take':
      if (!takeOk) throw new Error('take name: letters, numbers, - and _ only')
      if (body.directions) {
        if (!/^[\w.-]+\.json$/.test(String(body.directions))) throw new Error('bad directions file')
        return ['dream-take', ...base, '--take', take, '--directions', String(body.directions), '--index', String(body.index ?? 0)]
      }
      if (!body.prompt) throw new Error('prompt or directions is required')
      return ['dream-take', ...base, '--take', take, '--prompt', String(body.prompt)]
    case 'samples':
      if (!takeOk) throw new Error('bad take')
      return ['dream-samples', ...base, '--take', take]
    case 'clip':
      if (!takeOk) throw new Error('bad take')
      return ['dream-clip', ...base, '--take', take]
    case 'status':
      if (!takeOk) throw new Error('bad take')
      return [
        'take-status',
        ...base,
        '--take',
        take,
        ...(body.status ? ['--status', String(body.status)] : []),
        ...(body.notes !== undefined ? ['--notes', String(body.notes)] : []),
      ]
    default:
      throw new Error(`Unknown action "${String(body.action)}"`)
  }
}

function startRun(job: string, args: string[]): Run {
  if (Array.from(runs.values()).some((r) => r.job === job && r.status === 'running')) {
    throw new Error('Something is already running for this job; wait for it to finish.')
  }
  const run: Run = { id: `${Date.now()}`, job, args, status: 'running', log: `$ ${args.join(' ')}\n` }
  runs.set(run.id, run)
  const child = spawn('bun', ['run', 'src/cli.ts', ...args], { cwd: PIPELINE_DIR, env: pipelineEnv() })
  child.stdout.on('data', (d) => (run.log += d))
  child.stderr.on('data', (d) => (run.log += d))
  child.on('close', (code) => (run.status = code === 0 ? 'succeeded' : 'failed'))
  return run
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = ''
  for await (const chunk of req) data += chunk
  return data ? JSON.parse(data) : {}
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function serveFile(res: ServerResponse, job: string, rel: string) {
  const dir = jobDir(job)
  const file = path.resolve(dir, rel)
  if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' })
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-cache')
  createReadStream(file).pipe(res)
}

export default function adminPlugin(): Plugin {
  return {
    name: 'lysterfield-admin',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__admin', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
          if (parts[0] === 'files' && parts.length > 2) return serveFile(res, parts[1], parts.slice(2).join('/'))
          if (parts[0] !== 'api') return send(res, 404, { error: 'not found' })
          if (parts[1] === 'jobs' && parts.length === 2) return send(res, 200, listJobs())
          if (parts[1] === 'jobs' && parts.length === 3 && req.method === 'GET') return send(res, 200, jobDetail(parts[2]))
          if (parts[1] === 'jobs' && parts[3] === 'actions' && req.method === 'POST') {
            jobDir(parts[2])
            const run = startRun(parts[2], actionArgs(parts[2], await readBody(req)))
            return send(res, 200, { runId: run.id })
          }
          if (parts[1] === 'runs' && parts[2]) {
            const run = runs.get(parts[2])
            return run ? send(res, 200, run) : send(res, 404, { error: 'no such run' })
          }
          return send(res, 404, { error: 'not found' })
        } catch (error) {
          return send(res, 400, { error: (error as Error).message })
        }
      })
    },
  }
}
