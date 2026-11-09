import { useEffect, useState } from 'react'
import { PolaroidScene } from '../../components/loop-polaroid.tsx'
import { isPolaroidId, loadStatus, polaroidFile, type PolaroidStatus } from './api.ts'
import { Page, PRIMARY, SECONDARY } from './shell.tsx'

// A visitor's private link (/p/<id>): where their polaroid is, from waiting to be looked at to made, and then the
// polaroid itself. The id is unguessable, so the link is theirs until the polaroid is shown in the gallery.

/** How often to look again while it's on its way. */
const POLL_MS = 20000

function where(polaroid: PolaroidStatus): string {
  switch (polaroid.status) {
    case 'uploading':
    case 'submitted':
      return "It's waiting for a person to look at it. Nothing is made until they have."
    case 'approved':
      return polaroid.ahead ? `It's in the queue, with ${polaroid.ahead} ${polaroid.ahead === 1 ? 'polaroid' : 'polaroids'} to be made before it.` : "It's next in the queue."
    case 'making':
      return "It's being made now. That takes about twenty minutes."
    case 'failed':
      return 'Something went wrong while it was being made. It will be looked at and tried again.'
    case 'made':
      return "It's made. It joins the gallery once it's been looked at again."
    case 'shown':
      return "It's in the gallery."
    case 'rejected':
      return "This one won't be made."
  }
}

export default function PolaroidLink() {
  const id = location.pathname.split('/')[2] ?? ''
  const [polaroid, setPolaroid] = useState<PolaroidStatus | null>(null)
  const [error, setError] = useState(isPolaroidId(id) ? '' : 'There’s no polaroid at this link.')

  useEffect(() => {
    if (!isPolaroidId(id)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      loadStatus(id).then(
        (p) => {
          setError('')
          setPolaroid(p)
          if (p.status !== 'made' && p.status !== 'shown' && p.status !== 'rejected') timer = setTimeout(load, POLL_MS)
        },
        (e: Error) => {
          setError(e.message)
          timer = setTimeout(load, POLL_MS)
        }
      )
    load()
    return () => clearTimeout(timer)
  }, [id])

  const made = polaroid?.status === 'made' || polaroid?.status === 'shown'

  return (
    <Page>
      <h1 className="font-serif text-4xl">Your polaroid</h1>
      {error && <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">{error}</p>}
      {polaroid && <p className="mt-2 text-stone-700 dark:text-stone-300">{where(polaroid)}</p>}
      {polaroid && !made && polaroid.status !== 'rejected' && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">Keep this link to come back to it. This page looks again by itself.</p>}
      {made && (
        <>
          <div className="relative mt-6 aspect-square w-full overflow-hidden rounded-lg">
            <PolaroidScene atlas={polaroidFile(id, 'atlas.mp4')} hint="" />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <a href={polaroidFile(id, 'loop.mp4')} download="lysterfield-lake-polaroid.mp4" className={PRIMARY}>
              Download the loop
            </a>
            {polaroid?.status === 'shown' && (
              <a href="/polaroids" className={SECONDARY}>
                See the gallery
              </a>
            )}
          </div>
          {polaroid?.status === 'made' && <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">This link is yours: it&apos;s private until it&apos;s in the gallery.</p>}
        </>
      )}
    </Page>
  )
}
