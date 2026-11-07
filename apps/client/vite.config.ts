import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mkcert from 'vite-plugin-mkcert'
import removeConsole from 'vite-plugin-remove-console'
import adminPlugin from './vite-plugin-admin'

// https://vitejs.dev/config/
export default defineConfig(() => {
  const external = process.env.npm_lifecycle_event === 'dev-external'
  // adminPlugin only applies to `vite dev` (apply: 'serve'); see vite-plugin-admin.ts.
  const included = [react(), removeConsole(), adminPlugin()]
  const plugins = external ? [mkcert(), ...included] : included

  return {
    plugins,
    server: {
      https: external,
      // The polaroid API is the Worker's (worker/): run `bun run worker` alongside (`wrangler dev`, port 8787; set
      // WORKER_PORT here if it's elsewhere). Without it, /polaroids and /p/<id> get a 500.
      proxy: { '/api': `http://localhost:${process.env.WORKER_PORT ?? 8787}` },
    },
  }
})
