/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_DREAMS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
