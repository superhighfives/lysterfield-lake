import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'

/**
 * Dev only: starts the app's Worker (worker/, `wrangler dev`) alongside `vite dev` when visitors' polaroids are on
 * (VITE_APP_POLAROIDS), since /polaroids and /p/<id> call its API through the dev server's /api proxy. It's
 * stopped with the dev server. If something is already listening on the port (a `bun run worker` of your own),
 * that one is used instead.
 *
 * It runs with the public routes on and Turnstile's always-pass test secret, so it works without a .dev.vars,
 * and applies the local database's migrations first (a no-op once they're in).
 */

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Cloudflare's always-pass Turnstile secret, for testing only: it pairs with .env.development's site key. */
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'

/** Whether anything accepts connections on the port, so a Worker already running isn't started twice. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })
    // Refused or unreachable: nothing is there.
    socket.once('error', () => resolve(false))
  })
}

export default function workerPlugin({ enabled, port }: { enabled: boolean; port: number }): Plugin {
  let worker: ChildProcess | undefined
  const stop = () => {
    worker?.kill('SIGTERM')
    worker = undefined
  }

  return {
    name: 'lysterfield-worker',
    apply: 'serve',
    async configureServer(server) {
      if (!enabled) return
      if (await listening(port)) {
        server.config.logger.info(`  ➜  Worker: using the one already on port ${port}`)
        return
      }
      // wrangler wants the built site's folder (wrangler.jsonc's assets) to exist, even empty.
      mkdirSync(path.join(CLIENT_DIR, 'dist'), { recursive: true })
      try {
        await promisify(execFile)('bunx', ['wrangler', 'd1', 'migrations', 'apply', 'lysterfield-polaroids', '--local'], { cwd: CLIENT_DIR })
      } catch (error) {
        server.config.logger.error(`[worker] local migrations failed: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`)
        return
      }
      worker = spawn(
        'bunx',
        ['wrangler', 'dev', '--port', String(port), '--var', 'POLAROIDS_PUBLIC:true', '--var', `TURNSTILE_SECRET:${TURNSTILE_TEST_SECRET}`],
        { cwd: CLIENT_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      server.config.logger.info(`  ➜  Worker: wrangler dev on port ${port} (worker/, for /api)`)
      // Its errors, so a Worker that fails to start says why; its routine request logs stay out of Vite's.
      worker.stdout?.resume()
      worker.stderr?.on('data', (chunk: Buffer) => server.config.logger.warn(`[worker] ${chunk.toString().trimEnd()}`))
      worker.on('exit', (code) => {
        if (code && code !== 0) server.config.logger.error(`[worker] wrangler dev exited with ${code}; /api will fail until it's running (bun run worker)`)
        worker = undefined
      })
      server.httpServer?.on('close', stop)
      process.once('exit', stop)
    },
  }
}
