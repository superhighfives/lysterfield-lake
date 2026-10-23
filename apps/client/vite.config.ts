import { cpSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import mkcert from 'vite-plugin-mkcert'
import removeConsole from 'vite-plugin-remove-console'
import adminPlugin from './vite-plugin-admin'

// public/dreams links to dreams/ (the gitignored playback videos, ~9GB) so
// `vite dev` serves them; a build must leave them out — they're hosted on
// R2 (VITE_APP_DREAMS), and Workers' static assets reject files over 25MB. So
// builds copy public/ themselves, skipping dreams/.
function publicWithoutDreams(): Plugin {
  let publicDir = ''
  let outDir = ''
  return {
    name: 'public-without-dreams',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const dreams = path.join(publicDir, 'dreams')
      cpSync(publicDir, outDir, {
        recursive: true,
        dereference: true,
        filter: (source) => source !== dreams && !source.startsWith(dreams + path.sep),
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(() => {
  const external = process.env.npm_lifecycle_event === 'dev-external'
  // adminPlugin only applies to `vite dev` (apply: 'serve'); see vite-plugin-admin.ts.
  const included = [react(), removeConsole(), adminPlugin(), publicWithoutDreams()]
  const plugins = external ? [mkcert(), ...included] : included

  return {
    plugins,
    server: { https: external },
    build: { copyPublicDir: false },
  }
})
