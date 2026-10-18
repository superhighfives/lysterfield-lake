import { Canvas, useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { useDrag } from '@use-gesture/react'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Box3, Group, LinearSRGBColorSpace, MathUtils, Mesh, Vector3, VideoTexture } from 'three'
import ThemeToggle from '../components/theme-toggle.tsx'
import { PolaroidLoopMaterial, type PolaroidLoopMaterialProps } from '../materials/polaroid-loop-material.tsx'
import Polaroid from '../models/polaroid.tsx'
import { useStore } from '../store.ts'
import { api, jobFile } from './admin-api.ts'

// Dev-only viewer for a visitor's 3D polaroid (plans/backlog/user-polaroid-loops.md): a job's looping
// 5-panel atlas (the pipeline's `polaroid` step) on the player's polaroid model. The background fills the
// photo; the person, cut out by the matte and pushed forward by the depth panel, stands in front of it.
// Drag to turn it.

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

export default function AdminPolaroid() {
  const [jobs, setJobs] = useState<string[]>([])
  const [job, setJob] = useState(() => new URLSearchParams(location.search).get('job') ?? '')
  const [settings, setSettings] = useState(DEFAULTS)
  const dark = useStore((state) => state.colorScheme === 'dark')
  const { texture, error: atlasError } = useAtlas(job)
  const [listError, setListError] = useState('')
  const error = listError || atlasError
  const drag = useRef({ x: 0, y: 0, active: false })

  useEffect(() => {
    api<string[]>('/__admin/api/polaroids')
      .then((list) => {
        setJobs(list)
        setJob((current) => current || list[0] || '')
      })
      .catch((e: Error) => setListError(`Couldn't list polaroids: ${e.message}`))
  }, [])

  const bind = useDrag(({ active, movement: [mx, my], memo }) => {
    // Start from wherever the polaroid is when the drag begins, so it doesn't jump.
    const start = (memo as { x: number; y: number } | undefined) ?? { x: drag.current.x, y: drag.current.y }
    drag.current = { x: start.x + mx * DRAG_RADIANS, y: MathUtils.clamp(start.y + my * DRAG_RADIANS, -0.9, 0.9), active }
    if (!active) drag.current = { x: 0, y: 0, active: false }
    return start
  })

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }))

  return (
    <div className="fixed inset-0 bg-stone-100 font-sans text-stone-900 dark:bg-stone-950 dark:text-stone-100 [color-scheme:light] dark:[color-scheme:dark]">
      <div {...bind()} className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing">
        <Canvas camera={{ position: [0, 0, 6], fov: 35 }} dpr={[1, 2]}>
          <ambientLight intensity={dark ? 1.0 : 1.1} />
          <directionalLight position={[2, 3, 5]} intensity={dark ? 1.2 : 1.6} />
          <Suspense fallback={null}>{texture && <LoopPolaroid texture={texture} settings={settings} drag={drag} />}</Suspense>
        </Canvas>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-baseline gap-4 px-6 pt-6">
        <h1 className="font-serif text-3xl">Polaroid</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">{error || (texture ? 'Drag to turn it.' : job ? 'Loading…' : 'No polaroids yet: run the pipeline’s polaroid step on a job.')}</p>
      </div>

      <div className="absolute bottom-4 left-4 w-72 space-y-3 rounded-lg border border-stone-300 bg-white/85 p-4 text-sm backdrop-blur dark:border-stone-700 dark:bg-stone-900/85">
        {jobs.length > 0 && (
          <label className="flex items-center justify-between gap-2">
            Job
            <select value={job} onChange={(e) => setJob(e.target.value)} className="rounded border border-stone-300 bg-white px-2 py-1 dark:border-stone-700 dark:bg-stone-900">
              {jobs.map((j) => (
                <option key={j}>{j}</option>
              ))}
            </select>
          </label>
        )}
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
        <div className="flex items-center justify-between border-t border-stone-300 pt-3 dark:border-stone-700">
          <button onClick={() => setSettings(DEFAULTS)} className="rounded border border-stone-300 px-2 py-1 dark:border-stone-700">
            Reset
          </button>
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}
