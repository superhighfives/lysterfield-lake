import { useState } from 'react'
import Recorder from '../../components/recorder.tsx'
import { submit } from './api.ts'
import { Page, PRIMARY, SECONDARY } from './shell.tsx'
import Turnstile from './turnstile.tsx'

// "Add yours" (/polaroids/add, plans/in-progress/polaroids.md step 4): five seconds of yourself, framed in a square,
// sent to the Worker's inbox. A person looks at every clip before anything is made from it; the visitor gets a
// private link (/p/<id>) that says where theirs is, and an email when it's made if they leave an address.

// The consent wording is the artist's to settle (the plan's Open questions: terms, minors, what delete removes).
const CONSENT = "This is me (or everyone in it said yes), and I'm happy for it to be made into a polaroid and, once it's been looked at, shown in the gallery."

export default function AddPolaroid() {
  const [email, setEmail] = useState('')
  const [consent, setConsent] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // A token is good once: a refused submission needs a fresh check, so the widget is made again.
  const [check, setCheck] = useState(0)

  return (
    <Page>
      <h1 className="font-serif text-4xl">Add yours</h1>
      <p className="mb-6 mt-2 text-sm text-stone-600 dark:text-stone-400">
        Five seconds of you, made into a looping polaroid like the ones in the song. Frame yourself in the square, record, and send it. A person looks at every one before it&apos;s made, so it can take a while.
      </p>
      <Recorder
        locked={sending}
        onError={error}
        review={(take, retake) => (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!token) return
              setError('')
              setSending(true)
              try {
                const id = await submit(take, email, token)
                location.assign(`/p/${id}`)
              } catch (err) {
                setError((err as Error).message)
                setSending(false)
                setToken(null)
                setCheck((n) => n + 1)
              }
            }}
          >
            <label className="block text-sm">
              <span className="text-stone-600 dark:text-stone-400">Email, to hear when it&apos;s ready (optional)</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="mt-1 block w-full rounded border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
              />
              <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">Only used to send that one email, then forgotten.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
              <span>{CONSENT}</span>
            </label>
            <Turnstile key={check} onToken={setToken} onError={setError} />
            <div className="flex flex-wrap gap-3">
              <button type="submit" disabled={!consent || !token || sending} className={PRIMARY}>
                {sending ? 'Sending…' : 'Send it'}
              </button>
              <button type="button" onClick={retake} disabled={sending} className={SECONDARY}>
                Retake
              </button>
            </div>
          </form>
        )}
      />
    </Page>
  )
}
