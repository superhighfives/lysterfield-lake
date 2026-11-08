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
    server: { https: external },
  }
})
