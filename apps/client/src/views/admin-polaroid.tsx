import { Canvas, useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { useDrag } from '@use-gesture/react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box3, Group, LinearSRGBColorSpace, MathUtils, Mesh, Vector3, VideoTexture } from 'three'
import ThemeToggle from '../components/theme-toggle.tsx'
import { PolaroidLoopMaterial, type PolaroidLoopMaterialProps } from '../materials/polaroid-loop-material.tsx'
import Polaroid from '../models/polaroid.tsx'
import { useStore } from '../store.ts'
import { active, api, jobFile, type Task } from './admin-api.ts'
import { Tasks } from './admin-tasks.tsx'

// Dev-only: a visitor's polaroid from recording to finished loop (plans/in-progress/polaroid-admin-flow.md).
// /admin/polaroid lists the polaroid jobs; ?job=<name> shows one job's stages, each paid one behind a
// confirm with its cost, the queue's tasks for it, and, once made, the 3D polaroid: the job's looping
// 5-panel atlas on the player's polaroid model, the person cut out by the matte and pushed forward by the
// depth panel in front of the background. Drag to turn it.

type Settings = { depth: number; outline: number; background: boolean }
const DEFAULTS: Settings = { depth: 0.2, outline: 0.25, background: true }

/** A drag turns the polaroid this far per pixel; let go and it eases back to its idle sway. */
const DRAG_RADIANS = 0.008

/** The polaroid's photo window, from the model's own "inside" mesh: where the person's plane goes. */
function usePhotoWindow() {
  const { nodes } = useGLTF('/models/polaroid.glb') as unknown as { nodes: { Object_3: Mesh } }
  return useMemo(() => {
    const box = new Box3().setFromBufferAttribute(nodes.Object_3.geometry.attributes.position as never)
    return { size: box.getSize(new Vector3()), center: box.getCenter(new Vector3()), front: box.max.z }
  }, [nodes])
}

function LoopPolaroid({ texture, settings, drag }: { texture: VideoTexture; settings: Settings; drag: { current: { x: number; y: number; active: boolean } } }) {
  const group = useRef<Group>(null)
  const background = useRef<PolaroidLoopMaterialProps>(null)
  const photo = usePhotoWindow()

  useFrame((state, delta) => {
    const g = group.current
    if (!g) return
    const t = state.clock.elapsedTime
    const d = drag.current
    // Idle: a slow sway, nudged by the pointer. Dragging: wherever the drag puts it.
    const targetY = d.active ? d.x : Math.sin(t * 0.5) * 0.25 + state.pointer.x * 0.2
    const targetX = d.active ? d.y : Math.sin(t * 0.37) * 0.08 - state.pointer.y * 0.15
    g.rotation.y = MathUtils.damp(g.rotation.y, targetY, d.active ? 20 : 3, delta)
    g.rotation.x = MathUtils.damp(g.rotation.x, targetX, d.active ? 20 : 3, delta)
    if (background.current) background.current.uParallax.set(-g.rotation.y * 0.12, g.rotation.x * 0.12)
  })

  const scale = 0.5
  return (
    <group ref={group} scale={scale}>
      <Polaroid
        passthroughMaterial={
          settings.background ? (
            <polaroidLoopMaterial ref={background} key={PolaroidLoopMaterial.key} uTexture={texture} uLayer={0} />
          ) : (
            <meshBasicMaterial color="#d9d4cc" />
          )
        }
      />
      {/* The person: a finely divided plane over the photo window, so the depth relief has vertices to move. */}
      <mesh position={[photo.center.x, photo.center.y, photo.front + 0.02]}>
        <planeGeometry args={[photo.size.x, photo.size.y, 192, 192]} />
        <polaroidLoopMaterial key={PolaroidLoopMaterial.key} uTexture={texture} uLayer={1} uDepthStrength={settings.depth / scale} uOutline={settings.outline} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** Plays a job's atlas from a blob URL: the dev server's file route doesn't answer range requests, which looping needs. */
function useAtlas(job: string) {
  const [texture, setTexture] = useState<VideoTexture | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!job) return
    let cancelled = false
    let url = ''
    let tex: VideoTexture | null = null
    const video = document.createElement('video')
    Object.assign(video, { muted: true, loop: true, playsInline: true, crossOrigin: 'anonymous' })
    setTexture(null)
    setError('')
    fetch(jobFile(job, 'polaroid/atlas.mp4'))
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`No atlas for ${job}`))))
      .then(async (blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        video.src = url
        await video.play()
        tex = new VideoTexture(video)
        // As the player does: the shader passes the video's sRGB values straight through.
        tex.colorSpace = LinearSRGBColorSpace
        if (cancelled) tex.dispose()
        else setTexture(tex)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
      video.pause()
      tex?.dispose()
      if (url) URL.revokeObjectURL(url)
    }
  }, [job])
  return { texture, error }
}

type Stage = { done: boolean; frames?: number }
type PolaroidJob = {
  name: string
  frames: number
  fps: number
  stages: { panels: Stage; background: Stage; atlas: Stage }
  cost?: { panels: string; background: string }
}

const STAGES = [
  {
    key: 'panels',
    action: 'polaroid-panels',
    title: 'Portrait, matte, depth and outline',
    detail: 'The polaroid model on Replicate, the clip split four ways. About 9 minutes from cold.',
  },
  { key: 'background', action: 'polaroid-background', title: 'Background', detail: 'Bria erases the person from the portrait, keeping the scene. About a minute.' },
  { key: 'atlas', action: 'polaroid-atlas', title: 'Polaroid', detail: 'The looping atlas and a flat video to download. Free, a few seconds.' },
] as const

const BUTTON = 'rounded bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 disabled:opacity-40'
const SECONDARY = 'rounded border border-stone-300 dark:border-stone-700 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40'

/** A paid step's button: says what it costs and asks before spending it. */
function SpendButton({ label, cost, what, disabled, onConfirm }: { label: string; cost: string; what: string; disabled?: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger disabled={disabled} className={BUTTON}>
        {label} ({cost})
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/40 dark:bg-black/60" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white dark:bg-stone-900 p-6 font-sans text-stone-900 dark:text-stone-100 shadow-xl [color-scheme:light] dark:[color-scheme:dark] [touch-action:auto]">
          <AlertDialog.Title className="font-serif text-2xl">Spend about {cost}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-stone-600 dark:text-stone-400">
            {what} It runs on Replicate. Finished work isn&apos;t paid for twice if it&apos;s run again, but what has run is spent.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className={SECONDARY}>Cancel</AlertDialog.Close>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
              className={BUTTON}
            >
              Spend {cost} and start
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-y-auto bg-stone-100 font-sans text-stone-900 dark:bg-stone-950 dark:text-stone-100 [color-scheme:light] dark:[color-scheme:dark] [touch-action:auto]">
      <div className="mx-auto max-w-5xl px-6 pb-10 pt-7">
        {children}
        <footer className="mt-10 flex items-center justify-between border-t border-stone-300 pt-4 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
          <span>Only runs on this machine.</span>
          <ThemeToggle />
        </footer>
      </div>
    </div>
  )
}

const progress = (job: PolaroidJob) => STAGES.filter((s) => job.stages[s.key].done).length

function PolaroidList() {
  const [jobs, setJobs] = useState<PolaroidJob[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<PolaroidJob[]>('/__admin/api/polaroids').then(setJobs, (e: Error) => setError(e.message))
  }, [])
  return (
    <Page>
      <header className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-serif text-4xl">Polaroids</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">Five seconds of someone, made into a looping 3D polaroid.</p>
        <a href="/admin/record" className={`ml-auto ${BUTTON}`}>
          Record a new one
        </a>
      </header>
      {error && <p className="mb-6 rounded bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">{error}</p>}
      {jobs?.length === 0 && <p className="text-sm text-stone-600 dark:text-stone-400">No polaroids yet. Record one to start.</p>}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {jobs?.map((job) => (
          <a key={job.name} href={`/admin/polaroid?job=${encodeURIComponent(job.name)}`} className="group overflow-hidden rounded-lg border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900">
            <img src={jobFile(job.name, '0-source/frames/0001.jpg')} alt="" className="aspect-square w-full object-cover transition group-hover:opacity-90" />
            <div className="p-3 text-sm">
              <div className="truncate font-medium">{job.name}</div>
              <div className="text-stone-500 dark:text-stone-400">{progress(job) === STAGES.length ? 'Done' : `${progress(job)} of ${STAGES.length} steps`}</div>
            </div>
          </a>
        ))}
      </div>
    </Page>
  )
}

function JobView({ job }: { job: string }) {
  const [detail, setDetail] = useState<PolaroidJob | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState('')
  const fail = (e: Error) => setError(e.message)

  const reload = useCallback(async () => {
    const [d, t] = await Promise.all([api<PolaroidJob>(`/__admin/api/polaroids/${job}`), api<Task[]>(`/__admin/api/jobs/${job}/tasks`)])
    setDetail(d)
    setTasks(t)
  }, [job])
  useEffect(() => {
    reload().catch(fail)
  }, [reload])
  // While something is queued or running, keep the stages and the task list current.
  const busy = tasks.some(active)
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => reload().catch(fail), 3000)
    return () => clearInterval(id)
  }, [busy, reload])

  /** Queues stages one after another: the queue runs one job's tasks in the order they were asked for. */
  const run = async (actions: string[]) => {
    setError('')
    try {
      for (const action of actions) await api(`/__admin/api/jobs/${job}/actions`, { action, take: 'polaroid' })
    } catch (e) {
      fail(e as Error)
    }

    await reload().catch(fail)
  }

  if (!detail) {
    return (
      <Page>
        <p className="text-sm text-stone-600 dark:text-stone-400">{error || 'Loading…'}</p>
      </Page>
    )
  }

  const queued = (action: string) => tasks.some((t) => active(t) && t.action === action)
  const todo = STAGES.filter((s) => !detail.stages[s.key].done && !queued(s.action))
  const total = detail.cost ? (parseFloat(detail.cost.panels.slice(1)) + parseFloat(detail.cost.background.slice(1))).toFixed(2) : '?'

  return (
    <Page>
      <header className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <a href="/admin/polaroid" className="text-sm text-stone-500 hover:underline dark:text-stone-400">
          ← All polaroids
        </a>
        <h1 className="w-full font-serif text-4xl">{detail.name}</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          {detail.frames} frames at {detail.fps}fps
        </p>
      </header>

      {error && <p className="mb-6 rounded bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">{error}</p>}

      <section className="mb-8 flex flex-col gap-6 md:flex-row">
        <img src={jobFile(job, '0-source/frames/0001.jpg')} alt="" className="aspect-square w-full self-start rounded-lg object-cover md:w-56" />
        <ol className="flex-1 space-y-3">
          {STAGES.map((stage, i) => {
            const state = detail.stages[stage.key]
            const ready = STAGES.slice(0, i).every((s) => detail.stages[s.key].done)
            const cost = stage.key === 'atlas' ? undefined : detail.cost?.[stage.key]
            return (
              <li key={stage.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-300 bg-white p-4 dark:border-stone-700 dark:bg-stone-900">
                <span className={`grid h-6 w-6 place-items-center rounded-full text-xs ${state.done ? 'bg-emerald-600 text-white' : 'bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300'}`}>{state.done ? '✓' : i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{stage.title}</div>
                  <div className="text-sm text-stone-600 dark:text-stone-400">
                    {stage.detail}
                    {!state.done && state.frames ? ` ${state.frames} of ${detail.frames} frames so far.` : ''}
                  </div>
                </div>
                {state.done ? (
                  <span className="text-sm text-emerald-700 dark:text-emerald-400">Done</span>
                ) : queued(stage.action) ? (
                  <span className="text-sm text-amber-700 dark:text-amber-400">Running…</span>
                ) : !ready ? (
                  <span className="text-sm text-stone-500">After step {i}</span>
                ) : cost ? (
                  <SpendButton label="Run" cost={cost} what={stage.detail} onConfirm={() => run([stage.action])} />
                ) : (
                  <button type="button" onClick={() => run([stage.action])} className={BUTTON}>
                    Make it
                  </button>
                )}
              </li>
            )
          })}
          {todo.length > 1 && (
            <div className="pt-1">
              <SpendButton
                label="Make the whole polaroid"
                cost={`$${total}`}
                what="Runs every remaining step in order: the panels, then the background, then the polaroid itself."
                onConfirm={() => run(todo.map((s) => s.action))}
              />
            </div>
          )}
        </ol>
      </section>

      <Tasks job={job} tasks={tasks} titles={{}} onChanged={() => reload().catch(fail)} />

      {detail.stages.atlas.done && (
        <section className="mb-8">
          <div className="mb-3 flex items-baseline gap-4">
            <h2 className="font-serif text-2xl">The polaroid</h2>
            <a href={jobFile(job, 'polaroid/loop.mp4')} download={`${job}.mp4`} className="text-sm underline">
              Download the loop
            </a>
          </div>
          <Viewer job={job} />
        </section>
      )}
    </Page>
  )
}

/** The 3D polaroid, with the sliders for tuning how it's drawn. */
function Viewer({ job }: { job: string }) {
  const [settings, setSettings] = useState(DEFAULTS)
  const dark = useStore((state) => state.colorScheme === 'dark')
  const { texture, error } = useAtlas(job)
  const drag = useRef({ x: 0, y: 0, active: false })

  const bind = useDrag(({ active, movement: [mx, my], memo }) => {
    // Start from wherever the polaroid is when the drag begins, so it doesn't jump.
    const start = (memo as { x: number; y: number } | undefined) ?? { x: drag.current.x, y: drag.current.y }
    drag.current = { x: start.x + mx * DRAG_RADIANS, y: MathUtils.clamp(start.y + my * DRAG_RADIANS, -0.9, 0.9), active }
    if (!active) drag.current = { x: 0, y: 0, active: false }
    return start
  })

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }))

  return (
    <div className="relative h-[70vh] overflow-hidden rounded-lg border border-stone-300 bg-stone-200/50 dark:border-stone-700 dark:bg-stone-900/50">
      <div {...bind()} className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing">
        <Canvas camera={{ position: [0, 0, 6], fov: 35 }} dpr={[1, 2]}>
          <ambientLight intensity={dark ? 1.0 : 1.1} />
          <directionalLight position={[2, 3, 5]} intensity={dark ? 1.2 : 1.6} />
          <Suspense fallback={null}>{texture && <LoopPolaroid texture={texture} settings={settings} drag={drag} />}</Suspense>
        </Canvas>
      </div>
      <p className="pointer-events-none absolute left-4 top-3 text-sm text-stone-600 dark:text-stone-400">{error || (texture ? 'Drag to turn it.' : 'Loading…')}</p>
      <div className="absolute bottom-4 left-4 w-72 space-y-3 rounded-lg border border-stone-300 bg-white/85 p-4 text-sm backdrop-blur dark:border-stone-700 dark:bg-stone-900/85">
        <label className="flex items-center gap-2">
          <span className="w-16">Depth</span>
          <input type="range" min={0} max={0.8} step={0.01} value={settings.depth} onChange={(e) => set({ depth: Number(e.target.value) })} className="flex-1" />
          <span className="w-8 text-right tabular-nums">{settings.depth.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-16">Outline</span>
          <input type="range" min={0} max={1} step={0.01} value={settings.outline} onChange={(e) => set({ outline: Number(e.target.value) })} className="flex-1" />
          <span className="w-8 text-right tabular-nums">{settings.outline.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.background} onChange={(e) => set({ background: e.target.checked })} />
          Background panel
        </label>
        <button onClick={() => setSettings(DEFAULTS)} className={SECONDARY}>
          Reset
        </button>
      </div>
    </div>
  )
}

export default function AdminPolaroid() {
  const job = new URLSearchParams(location.search).get('job')
  return job ? <JobView job={job} /> : <PolaroidList />
}
