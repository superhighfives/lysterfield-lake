import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mkcert from 'vite-plugin-mkcert'
import removeConsole from 'vite-plugin-remove-console'

// https://vitejs.dev/config/
export default defineConfig(() => {
  const external = process.env.npm_lifecycle_event === 'dev-external'
  const included = [react(), removeConsole()]
  const plugins = external ? [mkcert(), ...included] : included

  return {
    plugins,
    server: { https: external },
  }
})
