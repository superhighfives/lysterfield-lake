export type Dream = {
  id: string
  title: string
  link: string
  prompt: string
  /** Where this dream's dream video lives, if not `VITE_APP_DREAMS/<id>` — set only for dev previews of a take. */
  dreamSrc?: string
  /** Where in the song to start, in seconds, ahead of any saved position — set only for a take's test clip. */
  start?: number
}
