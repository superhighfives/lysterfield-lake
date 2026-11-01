import { useState } from 'react'
import Recorder, { type Take } from '../components/recorder.tsx'
import ThemeToggle from '../components/theme-toggle.tsx'
import { api } from './admin-api.ts'

// Dev-only page for recording a 5-second webcam clip and making a pipeline job from it, for the polaroid
// prototype (plans/in-progress/polaroids.md). The dev server saves the clip and runs `init` on it,
// with the square picked here (components/recorder.tsx), so what's inside the frame is what the job gets.

function defaultName(): string {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `loop-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the recording"))
    reader.readAsDataURL(blob)
  })
}

export default function AdminRecord() {
  const [name, setName] = useState(defaultName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async ({ blob, crop }: Take) => {
    setError('')
    setSaving(true)
    try {
      const { job } = await api<{ job: string }>('/__admin/api/recordings', { name, type: blob.type, crop, data: await toBase64(blob) })
      // Straight on to making it.
      location.assign(`/admin/polaroid?job=${encodeURIComponent(job)}`)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 overflow-y-auto bg-stone-100 dark:bg-stone-950 font-sans text-stone-900 dark:text-stone-100 [color-scheme:light] dark:[color-scheme:dark] [touch-action:auto]">
      <div className="mx-auto max-w-xl px-6 pb-10 pt-7">
        <header className="mb-6">
          <h1 className="font-serif text-4xl">Record a loop</h1>
          <p className="text-sm text-stone-600 dark:text-stone-400">Five seconds from the webcam (or the start of a video file), saved as a new pipeline job. Only what&apos;s inside the square is kept.</p>
        </header>

        <Recorder
          details
          locked={saving}
          onError={error}
          review={(take, retake) => (
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm text-stone-600 dark:text-stone-400">
                Job name
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-1.5 text-stone-900 dark:text-stone-100" />
              </label>
              <button onClick={() => save(take)} disabled={saving || !name} className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900">
                {saving ? 'Making job…' : 'Make job'}
              </button>
              <button
                onClick={() => {
                  retake()
                  setName(defaultName())
                }}
                disabled={saving}
                className="rounded border border-stone-300 dark:border-stone-700 px-4 py-2 disabled:opacity-40"
              >
                Retake
              </button>
            </div>
          )}
        />

        <footer className="mt-10 flex items-center justify-between border-t border-stone-300 dark:border-stone-700 pt-4 text-sm text-stone-500 dark:text-stone-400">
          <span>Only runs on this machine.</span>
          <ThemeToggle />
        </footer>
      </div>
    </div>
  )
}
