import { useEffect, useRef } from 'react'

// Cloudflare Turnstile, the "are you a person" check the Worker asks for before it takes a submission
// (worker/index.ts, checkTurnstile). Its site key is VITE_APP_TURNSTILE_SITE_KEY; the secret is the Worker's.

type TurnstileApi = {
  render: (el: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void; theme?: 'auto' }) => string
  remove: (widget: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | undefined

function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("The human check didn't load")))
    script.onerror = () => {
      // Let a later visit to the page try again.
      loading = undefined
      reject(new Error("The human check didn't load: check your connection and try again"))
    }

    document.head.appendChild(script)
  })
  return loading
}

/** The widget. `onToken` gets a fresh token, or null when one expires or fails. A token is good for one submission. */
export default function Turnstile({ onToken, onError }: { onToken: (token: string | null) => void; onError: (message: string) => void }) {
  const el = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onToken, onError })
  callbacks.current = { onToken, onError }

  useEffect(() => {
    const sitekey = import.meta.env.VITE_APP_TURNSTILE_SITE_KEY
    if (!sitekey) {
      callbacks.current.onError("Submissions aren't open yet")
      return
    }

    let widget: string | undefined
    let cancelled = false
    loadTurnstile().then(
      (turnstile) => {
        if (cancelled || !el.current) return
        widget = turnstile.render(el.current, {
          sitekey,
          theme: 'auto',
          callback: (token) => callbacks.current.onToken(token),
          'expired-callback': () => callbacks.current.onToken(null),
          'error-callback': () => {
            callbacks.current.onToken(null)
            callbacks.current.onError("The human check didn't pass: try again")
          },
        })
      },
      (e: Error) => !cancelled && callbacks.current.onError(e.message)
    )
    return () => {
      cancelled = true
      if (widget) window.turnstile?.remove(widget)
    }
  }, [])

  return <div ref={el} className="min-h-[65px]" />
}
