/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_DREAMS: string
  /** "true" turns on visitors' polaroids: /polaroids, /polaroids/add and /p/<id> (plans/in-progress/polaroids.md). */
  readonly VITE_APP_POLAROIDS?: string
  /** The public bucket finished polaroids are served from. */
  readonly VITE_APP_POLAROIDS_URL?: string
  readonly VITE_APP_TURNSTILE_SITE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
