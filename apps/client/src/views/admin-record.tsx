import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import ThemeToggle from '../components/theme-toggle.tsx'
import { api } from './admin-api.ts'

// Dev-only page for recording a 5-second webcam clip and making a pipeline job from it, for the polaroid
// prototype (plans/in-progress/polaroids.md). The dev server saves the clip and runs `init` on it,
// with the square picked here (drag to move it, scroll or the slider to zoom), so what's inside the frame is what
// the job gets.

/** Recorded a little longer than the 5 seconds `init` keeps, since MediaRecorder takes a moment to start. */
const RECORD_MS = 5400
const COUNTDOWN = 3
/** Formats MediaRecorder can write, best first. ffmpeg reads any of them. */
const MIME_TYPES = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']

/** The square kept: its centre as a fraction of the video's width and height, and a zoom (1 = the largest square). The same shape as the pipeline's Crop (job.ts). */
type Crop = { x: number; y: number; zoom: number }
type Size = { w: number; h: number }
const CENTRED: Crop = { x: 0.5, y: 0.5, zoom: 1 }
const MAX_ZOOM = 4

/** Keeps the square inside the video. */
function clampCrop(crop: Crop, size: Size | null): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, crop.zoom))
  if (!size) return { ...crop, zoom }
  const side = Math.min(size.w, size.h) / zoom
  const clamp = (v: number, length: number) => Math.min(1 - side / 2 / length, Math.max(side / 2 / length, v))
  return { x: clamp(crop.x, size.w), y: clamp(crop.y, size.h), zoom }
}

/** Places a video inside the square frame so that exactly the crop shows (as percentages of the frame). */
function cropStyle(crop: Crop, size: Size | null): CSSProperties {
  if (!size) return { inset: 0, width: '100%', height: '100%', objectFit: 'cover' }
  const { x, y, zoom } = clampCrop(crop, size)
  const side = Math.min(size.w, size.h) / zoom
  return {
    width: `${(size.w / side) * 100}%`,
    height: `${(size.h / side) * 100}%`,
    left: `${(-(x * size.w - side / 2) / side) * 100}%`,
    top: `${(-(y * size.h - side / 2) / side) * 100}%`,
    maxWidth: 'none',
  }
}

const sizeOf = (v: HTMLVideoElement): Size | null => (v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null)

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
  const [cameraInfo, setCameraInfo] = useState('')
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [camera, setCamera] = useState(savedCamera)
  const [crop, setCrop] = useState<Crop>(CENTRED)
  const [liveSize, setLiveSize] = useState<Size | null>(null)
  const [reviewSize, setReviewSize] = useState<Size | null>(null)
  /** A chosen file isn't mirrored: only the camera (and what it recorded) is shown like a mirror. */
  const [fromFile, setFromFile] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

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

  // Keeps any camera error already showing: that's the one to act on.
  const reportListError = (e: Error) => setError((current) => current || `Couldn't list cameras: ${e.message}`)

  useEffect(() => {
    let cancelled = false
    setCameraInfo('')
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: camera ? { exact: camera } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream.current = s
        if (live.current) live.current.srcObject = s
        const settings = s.getVideoTracks()[0]?.getSettings()
        if (settings) setCameraInfo(`${settings.width}×${settings.height} at ${Math.round(settings.frameRate ?? 0)}fps`)
        listCameras().catch(reportListError)
      })
      .catch((e: Error) => {
        if (cancelled) return
        // A remembered camera that's gone: fall back to the default one.
        if (camera && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) return setCamera('')
        setError(
          e.name === 'NotFoundError'
            ? 'No camera found. Connect one (or bring an iPhone close for Continuity Camera), or choose a video file below.'
            : `Couldn't open the camera: ${e.message}`
        )
        listCameras().catch(reportListError)
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

  const chooseFile = (file: File | undefined) => {
    if (!file) return
    setError('')
    setFromFile(true)
    setReviewSize(null)
    setCrop(CENTRED)
    setStage({ kind: 'review', blob: file, url: URL.createObjectURL(file) })
  }

  const retake = () => {
    if ('url' in stage) URL.revokeObjectURL(stage.url)
    setStage({ kind: 'idle' })
    setName(defaultName())
    setReviewSize(null)
    if (fromFile) setCrop(CENTRED)
    setFromFile(false)
  }

  const save = async () => {
    if (stage.kind !== 'review') return
    setError('')
    setStage({ ...stage, kind: 'saving' })
    try {
      const { job } = await api<{ job: string }>('/__admin/api/recordings', { name, type: stage.blob.type, crop: clampCrop(crop, size), data: await toBase64(stage.blob) })
      // Straight on to making it.
      location.assign(`/admin/polaroid?job=${encodeURIComponent(job)}`)
      setStage({ kind: 'saved', job, url: stage.url })
    } catch (e) {
      setError((e as Error).message)
      setStage({ ...stage, kind: 'review' })
    }
  }

  const reviewing = stage.kind === 'review' || stage.kind === 'saving' || stage.kind === 'saved'
  const size = reviewing ? reviewSize : liveSize
  const mirrored = !(reviewing && fromFile)
  const framing = stage.kind !== 'saving' && stage.kind !== 'saved'

  // Dragging moves the picture under the frame, so the crop's centre moves the other way (unless it's mirrored).
  const onPointerMove = (e: PointerEvent) => {
    const start = drag.current
    const box = frame.current?.getBoundingClientRect()
    if (!start || !box || !size) return
    drag.current = { x: e.clientX, y: e.clientY }
    const side = Math.min(size.w, size.h) / crop.zoom
    const dx = ((e.clientX - start.x) / box.width) * (side / size.w)
    const dy = ((e.clientY - start.y) / box.height) * (side / size.h)
    setCrop((c) => clampCrop({ ...c, x: c.x + (mirrored ? dx : -dx), y: c.y - dy }, size))
  }

  // Scrolling zooms. A native listener, since React's wheel events can't stop the page scrolling.
  useEffect(() => {
    const el = frame.current
    if (!el || !framing) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setCrop((c) => clampCrop({ ...c, zoom: c.zoom * Math.exp(-e.deltaY * 0.002) }, size))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [framing, size])

  return (
    <div className="fixed inset-0 overflow-y-auto bg-stone-100 dark:bg-stone-950 font-sans text-stone-900 dark:text-stone-100 [color-scheme:light] dark:[color-scheme:dark] [touch-action:auto]">
      <div className="mx-auto max-w-xl px-6 pb-10 pt-7">
        <header className="mb-6">
          <h1 className="font-serif text-4xl">Record a loop</h1>
          <p className="text-sm text-stone-600 dark:text-stone-400">Five seconds from the webcam (or the start of a video file), saved as a new pipeline job. Only what&apos;s inside the square is kept.</p>
        </header>

        {error && <p className="mb-6 rounded bg-red-50 dark:bg-red-950/50 p-3 text-sm text-red-800 dark:text-red-200">{error}</p>}

        <div
          ref={frame}
          onPointerDown={(e) => {
            if (!framing) return
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY }
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onDoubleClick={() => framing && setCrop(CENTRED)}
          className={`relative mb-3 aspect-square touch-none select-none overflow-hidden rounded-lg bg-black ${framing ? 'cursor-grab active:cursor-grabbing' : ''}`}
        >
          {/* The camera is mirrored like a mirror while framing; the recording itself isn't. */}
          <div className={`absolute inset-0 ${mirrored ? '-scale-x-100' : ''}`}>
            <video ref={live} autoPlay muted playsInline onLoadedMetadata={(e) => setLiveSize(sizeOf(e.currentTarget))} onResize={(e) => setLiveSize(sizeOf(e.currentTarget))} style={cropStyle(crop, liveSize)} className={`absolute ${reviewing ? 'invisible' : ''}`} />
            {'url' in stage && <video src={stage.url} autoPlay muted loop playsInline onLoadedMetadata={(e) => setReviewSize(sizeOf(e.currentTarget))} style={cropStyle(crop, reviewSize)} className="absolute" />}
          </div>
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
        <div className="mb-3 flex items-center gap-3 text-sm text-stone-600 dark:text-stone-400">
          <label className="flex flex-1 items-center gap-2">
            Zoom
            <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={crop.zoom} disabled={!framing} onChange={(e) => setCrop((c) => clampCrop({ ...c, zoom: Number(e.target.value) }, size))} className="flex-1 accent-stone-900 disabled:opacity-40 dark:accent-stone-100" />
            <span className="w-10 text-right tabular-nums">{crop.zoom.toFixed(1)}×</span>
          </label>
          <button onClick={() => setCrop(CENTRED)} disabled={!framing} className="rounded border border-stone-300 dark:border-stone-700 px-2 py-1 disabled:opacity-40">
            Centre
          </button>
        </div>
        <p className="mb-4 text-xs text-stone-500 dark:text-stone-400">Drag the picture to move it, scroll or use the slider to zoom, double-click to reset.</p>
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
          {cameraInfo && <span className="text-xs text-stone-500 dark:text-stone-400">{cameraInfo}</span>}
        </div>

        {stage.kind === 'idle' && (
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={record} disabled={!cameraInfo} className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900">
              Record 5 seconds
            </button>
            {/* A clip from elsewhere (a phone, say): its first 5 seconds are used. */}
            <label className="cursor-pointer rounded border border-stone-300 dark:border-stone-700 px-4 py-2">
              Choose a video file
              <input type="file" accept="video/*" onChange={(e) => chooseFile(e.target.files?.[0])} className="sr-only" />
            </label>
          </div>
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
