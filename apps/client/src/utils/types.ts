export type Dream = {
  id: string
  title: string
  link: string
  prompt: string
  /** Where this dream's videos live, if not `VITE_APP_DREAMS/<id>` — set only for dev previews of a take's test clip. */
  src?: string
  /** Where this dream's dream video lives, if not `VITE_APP_DREAMS/<id>` — set only for dev previews of a take's whole song. */
  dreamSrc?: string
}
