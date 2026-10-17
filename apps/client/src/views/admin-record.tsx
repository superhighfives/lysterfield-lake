import { useCallback, useEffect, useRef, useState } from 'react'
import ThemeToggle from '../components/theme-toggle.tsx'
import { api } from './admin-api.ts'

// Dev-only page for recording a 5-second webcam clip and making a pipeline job from it, for the polaroid
// prototype (plans/backlog/user-polaroid-loops.md). The dev server saves the clip and runs `init` on it,
// which crops it to the same centred square this page shows, so what's inside the frame is what the job gets.

/** Recorded a little longer than the 5 seconds `init` keeps, since MediaRecorder takes a moment to start. */
const RECORD_MS = 5400
const COUNTDOWN = 3
/** Formats MediaRecorder can write, best first. ffmpeg reads any of them. */
const MIME_TYPES = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']

type Stage = { kind: 'idle' } | { kind: 'countdown'; n: number } | { kind: 'recording'; started: number } | { kind: 'review'; blob: Blob; url: string } | { kind: 'saving'; blob: Blob; url: string } | { kind: 'saved'; job: string; url: string }

/** The camera last picked, remembered in this browser only. */
const CAMERA_KEY = 'admin-record-camera'

function savedCamera(): string {
  try {
    return localStorage.getItem(CAMERA_KEY) ?? ''
  } catch {
    return ''
  }
}

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

function Progress({ started }: { started: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    let raf = 0
    const frame = () => {
      tick((n) => n + 1)
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])
  const progress = Math.min(1, (performance.now() - started) / RECORD_MS)
  return (
    <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/30">
      <div className="h-full bg-red-500" style={{ width: `${progress * 100}%` }} />
    </div>
  )
}

export default function AdminRecord() {
  const live = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [name, setName] = useState(defaultName)
  const [error, setError] = useState('')
  const [size, setSize] = useState('')
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [camera, setCamera] = useState(savedCamera)

  // Camera names only show once the page has been allowed a camera, so the list is read after each one opens,
  // and again when one is plugged in or out.
  const listCameras = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    setCameras(devices.filter((d) => d.kind === 'videoinput' && d.deviceId))
  }, [])

  useEffect(() => {
    navigator.mediaDevices.addEventListener('devicechange', listCameras)
    return () => navigator.mediaDevices.removeEventListener('devicechange', listCameras)
  }, [listCameras])

  useEffect(() => {
    let cancelled = false
    setSize('')
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: camera ? { exact: camera } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream.current = s
        if (live.current) live.current.srcObject = s
        const settings = s.getVideoTracks()[0]?.getSettings()
        if (settings) setSize(`${settings.width}×${settings.height} at ${Math.round(settings.frameRate ?? 0)}fps`)
        listCameras().catch(() => {})
      })
      .catch((e: Error) => {
        if (cancelled) return
        // A remembered camera that's gone: fall back to the default one.
        if (camera && e.name === 'OverconstrainedError') return setCamera('')
        setError(`Couldn't open the camera: ${e.message}`)
      })
    return () => {
      cancelled = true
      stream.current?.getTracks().forEach((t) => t.stop())
      stream.current = null
    }
  }, [camera, listCameras])

  const chooseCamera = (id: string) => {
    setError('')
    setCamera(id)
    try {
      localStorage.setItem(CAMERA_KEY, id)
    } catch {
      // Not remembered; it still switches.
    }
  }

  const record = useCallback(async () => {
    const s = stream.current
    if (!s) return
    setError('')
    for (let n = COUNTDOWN; n > 0; n--) {
      setStage({ kind: 'countdown', n })
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(s, { mimeType, videoBitsPerSecond: 16_000_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType })
      setStage({ kind: 'review', blob, url: URL.createObjectURL(blob) })
    }

    recorder.start()
    setStage({ kind: 'recording', started: performance.now() })
    setTimeout(() => recorder.stop(), RECORD_MS)
  }, [])

  const retake = () => {
    if ('url' in stage) URL.revokeObjectURL(stage.url)
    setStage({ kind: 'idle' })
    setName(defaultName())
  }

  const save = async () => {
    if (stage.kind !== 'review') return
    setError('')
    setStage({ ...stage, kind: 'saving' })
    try {
      const { job } = await api<{ job: string }>('/__admin/api/recordings', { name, type: stage.blob.type, data: await toBase64(stage.blob) })
      setStage({ kind: 'saved', job, url: stage.url })
    } catch (e) {
      setError((e as Error).message)
      setStage({ ...stage, kind: 'review' })
    }
  }

  const reviewing = stage.kind === 'review' || stage.kind === 'saving' || stage.kind === 'saved'

  return (
    <div className="fixed inset-0 overflow-y-auto bg-stone-100 dark:bg-stone-950 font-sans text-stone-900 dark:text-stone-100 [color-scheme:light] dark:[color-scheme:dark] [touch-action:auto]">
      <div className="mx-auto max-w-xl px-6 pb-10 pt-7">
        <header className="mb-6">
          <h1 className="font-serif text-4xl">Record a loop</h1>
          <p className="text-sm text-stone-600 dark:text-stone-400">Five seconds from the webcam, saved as a new pipeline job. Only what&apos;s inside the square is kept.</p>
        </header>

        {error && <p className="mb-6 rounded bg-red-50 dark:bg-red-950/50 p-3 text-sm text-red-800 dark:text-red-200">{error}</p>}

        <div className="relative mb-4 aspect-square overflow-hidden rounded-lg bg-black">
          {/* Mirrored like a mirror while framing; the recording itself isn't. object-cover crops the same centred square init does. */}
          <video ref={live} autoPlay muted playsInline className={`h-full w-full -scale-x-100 object-cover ${reviewing ? 'invisible' : ''}`} />
          {'url' in stage && <video src={stage.url} autoPlay muted loop playsInline className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />}
          {stage.kind === 'countdown' && <div className="absolute inset-0 grid place-items-center font-serif text-8xl text-white drop-shadow">{stage.n}</div>}
          {stage.kind === 'recording' && (
            <>
              <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> Recording
              </span>
              <Progress started={stage.started} />
            </>
          )}
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600 dark:text-stone-400">
          {cameras.length > 0 && (
            <label>
              Camera{' '}
              <select value={camera} onChange={(e) => chooseCamera(e.target.value)} disabled={stage.kind === 'countdown' || stage.kind === 'recording'} className="max-w-64 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-1 text-stone-900 dark:text-stone-100 disabled:opacity-40">
                <option value="">Default</option>
                {cameras.map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {size && <span className="text-xs text-stone-500 dark:text-stone-400">{size}</span>}
        </div>

        {stage.kind === 'idle' && (
          <button onClick={record} disabled={!size} className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900">
            Record 5 seconds
          </button>
        )}

        {(stage.kind === 'review' || stage.kind === 'saving') && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-stone-600 dark:text-stone-400">
              Job name
              <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-1.5 text-stone-900 dark:text-stone-100" />
            </label>
            <button onClick={save} disabled={stage.kind === 'saving' || !name} className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900">
              {stage.kind === 'saving' ? 'Making job…' : 'Make job'}
            </button>
            <button onClick={retake} disabled={stage.kind === 'saving'} className="rounded border border-stone-300 dark:border-stone-700 px-4 py-2 disabled:opacity-40">
              Retake
            </button>
          </div>
        )}

        {stage.kind === 'saved' && (
          <div className="space-y-3">
            <p className="text-sm">
              Saved as <code className="rounded bg-stone-200 px-1 dark:bg-stone-800">.jobs/{stage.job}</code>: cropped, 5 seconds at 24fps, ready for the pipeline steps.
            </p>
            <button onClick={retake} className="rounded border border-stone-300 dark:border-stone-700 px-4 py-2">
              Record another
            </button>
          </div>
        )}

        <footer className="mt-10 flex items-center justify-between border-t border-stone-300 dark:border-stone-700 pt-4 text-sm text-stone-500 dark:text-stone-400">
          <span>Only runs on this machine.</span>
          <ThemeToggle />
        </footer>
      </div>
    </div>
  )
}
