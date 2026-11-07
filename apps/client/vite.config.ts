import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import mkcert from 'vite-plugin-mkcert'
import removeConsole from 'vite-plugin-remove-console'
import adminPlugin from './vite-plugin-admin'
import workerPlugin from './vite-plugin-worker'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const external = process.env.npm_lifecycle_event === 'dev-external'
  // The polaroid API is the Worker's (worker/), proxied at /api. With polaroids on, `vite dev` starts it too
  // (vite-plugin-worker.ts), or uses one already on the port. Without it, /polaroids and /p/<id> get a 500.
  const workerPort = Number(process.env.WORKER_PORT ?? 8787)
  const polaroids = loadEnv(mode, process.cwd()).VITE_APP_POLAROIDS === 'true'
  // adminPlugin and workerPlugin only apply to `vite dev` (apply: 'serve').
  const included = [react(), removeConsole(), adminPlugin(), workerPlugin({ enabled: polaroids, port: workerPort })]
  const plugins = external ? [mkcert(), ...included] : included

  return {
    plugins,
    server: {
      https: external,
      proxy: { '/api': `http://localhost:${workerPort}` },
    },
  }
})
