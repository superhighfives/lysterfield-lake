import { Canvas, extend, type ThreeElement, useFrame } from '@react-three/fiber'
import { shaderMaterial, useGLTF } from '@react-three/drei'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AlwaysDepth, AlwaysStencilFunc, Box3, DoubleSide, EqualStencilFunc, Group, LinearSRGBColorSpace, MathUtils, Mesh, type MeshStandardMaterial, ReplaceStencilOp, SphereGeometry, Vector2, Vector3, VideoTexture } from 'three'
import ThemeToggle from '../components/theme-toggle.tsx'
import { PolaroidLoopMaterial } from '../materials/polaroid-loop-material.tsx'
import Polaroid, { polaroidBend } from '../models/polaroid.tsx'
import { useStore } from '../store.ts'
import { active, api, jobFile, type Task } from './admin-api.ts'
import { Tasks } from './admin-tasks.tsx'

// Dev-only: a visitor's polaroid from recording to finished loop (plans/in-progress/polaroid-admin-flow.md).
// /admin/polaroid lists the polaroid jobs; ?job=<name> shows one job's stages, each paid one behind a
// confirm with its cost, the queue's tasks for it, and, once made, the 3D polaroid: the job's looping
// 5-panel atlas on the player's polaroid model, the person cut out by the matte and pushed forward by the
// depth panel in front of the background. It turns to follow the pointer.

type Settings = { depth: number; outline: number; background: boolean }
const DEFAULTS: Settings = { depth: 1, outline: 0.25, background: true }

/** How far the polaroid turns toward the pointer, in radians, with the pointer at the viewer's edge. */
const FOLLOW = { y: 0.6, x: 0.45 }

/** The polaroid's photo window, from the model's own "inside" mesh: where the person's plane goes. */
function usePhotoWindow() {
  const { nodes } = useGLTF('/models/polaroid.glb') as unknown as { nodes: { Object_3: Mesh } }
  return useMemo(() => {
    const box = new Box3().setFromBufferAttribute(nodes.Object_3.geometry.attributes.position as never)
    return { size: box.getSize(new Vector3()), center: box.getCenter(new Vector3()), front: box.max.z }
  }, [nodes])
}

/**
 * The photo as a window into a shallow bowl. The window draws nothing: it marks the stencil and resets the
 * depth behind it to "far", so the bowl can sit behind the card (which would otherwise hide it) and still
 * depth-test against itself. The background lines the bowl, the middle of it as it would look face-on and
 * its outer band stretched round toward the rim, and the person stands partway in, their depth relief
 * bringing them up toward the glass. Nothing shows outside the window, and the frame's own overlay (its
 * soft inner shadow) is drawn last, over all of it, like the edge of a print.
 */
const SCALE = 0.5
/** How deep the bowl behind the window is, in the model's units (the card is 3.66 wide). */
const BOX_DEPTH = 1.6
/** Where the person stands, as a fraction of the bowl's depth; the relief brings them up from here. */
const PERSON_DEPTH = 0.6
/** The camera's distance in the model's units (camera at z 6, card scaled by SCALE). */
const CAMERA_DISTANCE = 6 / SCALE
/**
 * How much of the background, from each edge, is kept for the part of the bowl outside the window: face-on the
 * window shows the rest, and turning the card reveals the band, stretched more toward the rim.
 */
const BAND = 0.04
/** How far the person's plane reaches past the window, so their edges (shoulders) stretch out to the walls. */
const PERSON_REACH = 1.8
/** The back and walls with the background panel turned off, by theme. */
const PLAIN = { light: '#d9d4cc', dark: '#1c1a19' }

const STENCIL = { stencilWrite: true, stencilRef: 1 }
const IN_THE_BOX = { ...STENCIL, stencilFunc: EqualStencilFunc }

/** The window: stencil 1 wherever it's seen from the front, and depth reset to the far plane there. */
const WindowMaterial = shaderMaterial(
  {},
  /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  /* glsl */ `void main() { gl_FragColor = vec4(0.0); gl_FragDepth = 1.0; }`
)
extend({ WindowMaterial })
declare module '@react-three/fiber' {
  interface ThreeElements {
    windowMaterial: ThreeElement<typeof WindowMaterial>
  }
}

/**
 * The bowl the background lines: a half-sphere behind the window, opening toward the viewer, flattened to
 * `depth`. Its rim is a circle around the window's corners, so the window looks into it everywhere. The
 * geometry is in the window's own frame (centre at the origin, window at z 0), which the material reads to
 * work out how each point looks face-on.
 */
function useBowl(radius: number, depth: number) {
  return useMemo(() => {
    const geometry = new SphereGeometry(radius, 96, 48, 0, Math.PI * 2, 0, Math.PI / 2)
    geometry.rotateX(-Math.PI / 2)
    geometry.scale(1, 1, depth / radius)
    return geometry
  }, [radius, depth])
}

function LoopPolaroid({ texture, settings, pointer }: { texture: VideoTexture; settings: Settings; pointer: { current: { x: number; y: number } } }) {
  const group = useRef<Group>(null)
  const photoWindow = useRef<Mesh>(null)
  const photo = usePhotoWindow()
  const dark = useStore((state) => state.colorScheme === 'dark')

  // Each layer is sized so that, face-on, it exactly fills the window: perspective shrinks what's further back.
  const fill = (depth: number) => ({ x: (photo.size.x / 2) * ((CAMERA_DISTANCE + depth) / CAMERA_DISTANCE), y: (photo.size.y / 2) * ((CAMERA_DISTANCE + depth) / CAMERA_DISTANCE) })
  const personDepth = BOX_DEPTH * PERSON_DEPTH
  const person = fill(personDepth)
  const bowl = useBowl(Math.hypot(photo.size.x, photo.size.y) / 2, BOX_DEPTH)
  const half = useMemo(() => new Vector2(photo.size.x / 2, photo.size.y / 2), [photo])

  useEffect(() => {
    // The window marks the stencil after the opaque card and before the box; the frame's overlay (its inner
    // shadow) goes last, over everything.
    if (photoWindow.current) photoWindow.current.renderOrder = 1
    group.current?.traverse((object) => {
      if (object instanceof Mesh && (object.material as MeshStandardMaterial).name === 'Material.001') object.renderOrder = 4
    })
  }, [])

  useFrame((state, delta) => {
    const g = group.current
    if (!g) return
    // The player bends the shared polaroid as it moves (models/polaroid.tsx); this view keeps it flat, so the
    // window and the box behind it stay lined up.
    polaroidBend.value.set(0, 0)
    const t = state.clock.elapsedTime
    // A slow sway, turned toward the pointer.
    const p = pointer.current
    const targetY = Math.sin(t * 0.5) * 0.12 + p.x * FOLLOW.y
    const targetX = Math.sin(t * 0.37) * 0.05 - p.y * FOLLOW.x
    g.rotation.y = MathUtils.damp(g.rotation.y, targetY, 4, delta)
    g.rotation.x = MathUtils.damp(g.rotation.x, targetX, 4, delta)
  })

  return (
    <group ref={group} scale={SCALE}>
      <Polaroid
        intersectRef={photoWindow as RefObject<Mesh>}
        passthroughMaterial={<windowMaterial colorWrite={false} depthFunc={AlwaysDepth} {...STENCIL} stencilFunc={AlwaysStencilFunc} stencilZPass={ReplaceStencilOp} />}
      />
      <group position={[photo.center.x, photo.center.y, photo.front]}>
        {/* The bowl the background lines. */}
        <mesh geometry={bowl} renderOrder={2}>
          {settings.background ? (
            <polaroidLoopMaterial key={PolaroidLoopMaterial.key} uTexture={texture} uLayer={2} uHalf={half} uCameraDistance={CAMERA_DISTANCE} uBand={BAND} transparent={false} side={DoubleSide} {...IN_THE_BOX} />
          ) : (
            <meshBasicMaterial color={dark ? PLAIN.dark : PLAIN.light} side={DoubleSide} {...IN_THE_BOX} />
          )}
        </mesh>
        {/* Reaching past the window, its edges stretched out (the panels clamp at their edge), so where the person
            meets the edge of the frame (shoulders) they carry on until the bowl curves in front of them. Face-on,
            the window shows the same middle of the panels as the bowl does. */}
        <mesh position={[0, 0, -personDepth]} renderOrder={3}>
          <planeGeometry args={[person.x * 2 * PERSON_REACH, person.y * 2 * PERSON_REACH, 256, 256]} />
          <polaroidLoopMaterial key={PolaroidLoopMaterial.key} uTexture={texture} uLayer={1} uUvScale={PERSON_REACH} uBand={BAND} uDepthStrength={settings.depth * personDepth} uOutline={settings.outline} {...IN_THE_BOX} />
        </mesh>
      </group>
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
type Review = 'submitted' | 'approved' | 'shown' | 'rejected'
type PolaroidJob = {
  name: string
  frames: number
  fps: number
  review: Review
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
const DANGER = 'rounded border border-red-300 dark:border-red-900 px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40'

/** A button that asks first: for spending money, or for something that can't be undone. */
function ConfirmButton({ label, title, body, confirm, className = BUTTON, disabled, onConfirm }: {
  label: string
  title: string
  body: string
  confirm: string
  className?: string
  disabled?: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger disabled={disabled} className={className}>
        {label}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/40 dark:bg-black/60" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white dark:bg-stone-900 p-6 font-sans text-stone-900 dark:text-stone-100 shadow-xl [color-scheme:light] dark:[color-scheme:dark] [touch-action:auto]">
          <AlertDialog.Title className="font-serif text-2xl">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-stone-600 dark:text-stone-400">{body}</AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className={SECONDARY}>Cancel</AlertDialog.Close>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
              className={className === DANGER ? 'rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white' : BUTTON}
            >
              {confirm}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

/** A paid step's button: says what it costs and asks before spending it. */
function SpendButton({ label, cost, what, disabled, onConfirm }: { label: string; cost: string; what: string; disabled?: boolean; onConfirm: () => void }) {
  return (
    <ConfirmButton
      label={`${label} (${cost})`}
      title={`Spend about ${cost}?`}
      body={`${what} It runs on Replicate. Finished work isn't paid for twice if it's run again, but what has run is spent.`}
      confirm={`Spend ${cost} and start`}
      disabled={disabled}
      onConfirm={onConfirm}
    />
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

/** Where a polaroid is, for people: its review and, once approved, whether it's been made. */
function standing(job: PolaroidJob) {
  if (job.review === 'rejected') return { group: 'Rejected', label: 'Rejected', tone: 'text-red-700 dark:text-red-400' }
  if (job.review === 'shown') return { group: 'Shown', label: 'Shown', tone: 'text-emerald-700 dark:text-emerald-400' }
  if (job.review === 'submitted') return { group: 'To review', label: 'Waiting for approval to make', tone: 'text-amber-700 dark:text-amber-400' }
  if (job.stages.atlas.done) return { group: 'Ready to show', label: 'Made: waiting for approval to show', tone: 'text-amber-700 dark:text-amber-400' }
  const done = STAGES.filter((s) => job.stages[s.key].done).length
  return { group: 'Being made', label: `Approved: ${done} of ${STAGES.length} steps made`, tone: 'text-stone-500 dark:text-stone-400' }
}

const GROUPS = ['To review', 'Ready to show', 'Being made', 'Shown', 'Rejected']

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
      {GROUPS.map((group) => {
        const inGroup = jobs?.filter((job) => standing(job).group === group) ?? []
        if (inGroup.length === 0) return null
        return (
          <section key={group} className="mb-8">
            <h2 className="mb-3 font-serif text-2xl">
              {group} <span className="text-base text-stone-500">{inGroup.length}</span>
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {inGroup.map((job) => (
                <a key={job.name} href={`/admin/polaroid?job=${encodeURIComponent(job.name)}`} className={`group overflow-hidden rounded-lg border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900 ${job.review === 'rejected' ? 'opacity-60' : ''}`}>
                  <img src={jobFile(job.name, '0-source/frames/0001.jpg')} alt="" className="aspect-square w-full object-cover transition group-hover:opacity-90" />
                  <div className="p-3 text-sm">
                    <div className="truncate font-medium">{job.name}</div>
                    <div className={standing(job).tone}>{standing(job).label}</div>
                  </div>
                </a>
              ))}
            </div>
          </section>
        )
      })}
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

  const review = async (decision: string, then?: () => Promise<void>) => {
    setError('')
    try {
      await api(`/__admin/api/polaroids/${job}/review`, { decision })
      if (then) await then()
    } catch (e) {
      fail(e as Error)
    }

    await reload().catch(fail)
  }

  const remove = async () => {
    try {
      await api(`/__admin/api/polaroids/${job}/delete`, {})
      location.assign('/admin/polaroid')
    } catch (e) {
      fail(e as Error)
    }
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
  const prices = detail.cost ? [detail.cost.panels, detail.cost.background].map((c) => Number(c.slice(1))) : []
  const total = prices.length > 0 && prices.every(Number.isFinite) ? `$${prices.reduce((a, b) => a + b, 0).toFixed(2)}` : '?'
  const approved = detail.review === 'approved'
  const made = detail.stages.atlas.done
  const makeAll = () => run(todo.map((s) => s.action))

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

      {/* Moderation: nothing is made until it's approved, and nothing is shown until it's approved again. */}
      <section className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-stone-300 bg-white p-4 dark:border-stone-700 dark:bg-stone-900">
        <span className={`flex-1 text-sm font-medium ${standing(detail).tone}`}>{standing(detail).label}</span>
        {detail.review === 'submitted' && (
          <>
            <SpendButton label="Approve and make" cost={total} what="Approves this polaroid to be made, then runs every step: the panels, the background, and the polaroid itself." onConfirm={() => review('approve', makeAll)} />
            <button type="button" onClick={() => review('approve')} className={SECONDARY}>
              Approve
            </button>
            <button type="button" onClick={() => review('reject')} className={SECONDARY}>
              Reject
            </button>
          </>
        )}
        {approved && made && (
          <>
            <button type="button" onClick={() => review('show')} className={BUTTON}>
              Approve to show
            </button>
            <button type="button" onClick={() => review('reject')} className={SECONDARY}>
              Reject
            </button>
          </>
        )}
        {approved && !made && (
          <button type="button" onClick={() => review('reject')} className={SECONDARY}>
            Reject
          </button>
        )}
        {detail.review === 'shown' && (
          <>
            <button type="button" onClick={() => review('hide')} className={SECONDARY}>
              Hide
            </button>
            <button type="button" onClick={() => review('reject')} className={SECONDARY}>
              Reject
            </button>
          </>
        )}
        {detail.review === 'rejected' && (
          <button type="button" onClick={() => review('reopen')} className={SECONDARY}>
            Reopen
          </button>
        )}
        <ConfirmButton
          label="Delete"
          title={`Delete ${detail.name}?`}
          body="This deletes the recording and everything made from it: the frames, every panel, the polaroid and its loop. It can't be undone."
          confirm="Delete it"
          className={DANGER}
          disabled={tasks.some((t) => t.status === 'running')}
          onConfirm={remove}
        />
      </section>

      <section className="mb-8 flex flex-col gap-6 md:flex-row">
        <img src={jobFile(job, '0-source/frames/0001.jpg')} alt="" className="aspect-square w-full self-start rounded-lg object-cover md:w-56" />
        <ol className={`flex-1 space-y-3 ${approved || detail.review === 'shown' ? '' : 'opacity-60'}`}>
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
                ) : !approved ? (
                  <span className="text-sm text-stone-500">Needs approval</span>
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
          {approved && todo.length > 1 && (
            <div className="pt-1">
              <SpendButton label="Make the whole polaroid" cost={total} what="Runs every remaining step in order: the panels, then the background, then the polaroid itself." onConfirm={makeAll} />
            </div>
          )}
        </ol>
      </section>

      <Tasks job={job} tasks={tasks} titles={{}} onChanged={() => reload().catch(fail)} />

      {made && (
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
  // The pointer anywhere on the page, relative to the viewer: 0 at its centre, 1 at its edges, held a little
  // past them, so the card keeps following as you move around the page.
  const area = useRef<HTMLDivElement>(null)
  const pointer = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = area.current?.getBoundingClientRect()
      if (!r) return
      pointer.current = {
        x: MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1.5, 1.5),
        y: MathUtils.clamp(1 - ((e.clientY - r.top) / r.height) * 2, -1.5, 1.5),
      }
    }

    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [])

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }))

  return (
    <div className="relative h-[70vh] overflow-hidden rounded-lg border border-stone-300 bg-stone-200/50 dark:border-stone-700 dark:bg-stone-900/50">
      <div ref={area} className="absolute inset-0">
        <Canvas camera={{ position: [0, 0, 6], fov: 35 }} dpr={[1, 2]} gl={{ stencil: true }}>
          <ambientLight intensity={dark ? 1.0 : 1.1} />
          <directionalLight position={[2, 3, 5]} intensity={dark ? 1.2 : 1.6} />
          <Suspense fallback={null}>{texture && <LoopPolaroid texture={texture} settings={settings} pointer={pointer} />}</Suspense>
        </Canvas>
      </div>
      <p className="pointer-events-none absolute left-4 top-3 text-sm text-stone-600 dark:text-stone-400">{error || (texture ? 'Move the pointer to turn it.' : 'Loading…')}</p>
      <div className="absolute bottom-4 left-4 w-72 space-y-3 rounded-lg border border-stone-300 bg-white/85 p-4 text-sm backdrop-blur dark:border-stone-700 dark:bg-stone-900/85">
        <label className="flex items-center gap-2">
          <span className="w-16">Depth</span>
          <input type="range" min={0} max={1} step={0.01} value={settings.depth} onChange={(e) => set({ depth: Number(e.target.value) })} className="flex-1" />
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
