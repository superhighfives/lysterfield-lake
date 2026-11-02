import { shaderMaterial, useGLTF } from '@react-three/drei'
import { Canvas, extend, type ThreeElement, useFrame } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AlwaysDepth, AlwaysStencilFunc, Box3, BufferGeometry, DoubleSide, EqualStencilFunc, Float32BufferAttribute, Group, LinearSRGBColorSpace, MathUtils, Mesh, type MeshStandardMaterial, ReplaceStencilOp, Vector2, Vector3, VideoTexture } from 'three'
import { PolaroidLoopMaterial } from '../materials/polaroid-loop-material.tsx'
import Polaroid, { polaroidBend } from '../models/polaroid.tsx'
import { useStore } from '../store.ts'

// A visitor's polaroid in 3D (plans/in-progress/polaroids.md): its looping 5-panel atlas on the player's polaroid
// model, the person cut out by the matte and pushed forward by the depth panel in front of the background. It
// sways, and turns to follow the pointer. Shared by /admin/polaroid and the public gallery and private link.

export type Settings = { depth: number; outline: number; background: boolean }
export const DEFAULTS: Settings = { depth: 1, outline: 0.25, background: true }

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
 * The photo as a window into a shallow, rounded tub. The window draws nothing: it marks the stencil and resets the
 * depth behind it to "far", so the tub can sit behind the card (which would otherwise hide it) and still
 * depth-test against itself. The background lines the tub, the middle of it as it would look face-on and
 * its outer band stretched round toward the rim, and the person stands partway in, their depth relief
 * bringing them up toward the glass. Nothing shows outside the window, and the frame's own overlay (its
 * soft inner shadow) is drawn last, over all of it, like the edge of a print.
 */
const SCALE = 0.5
/** How deep the tub behind the window is, in the model's units (the card is 3.66 wide). */
const BOX_DEPTH = 1.6
/** Where the person stands, as a fraction of the tub's depth; the relief brings them up from here. */
const PERSON_DEPTH = 0.6
/** The camera's distance in the model's units (camera at z 6, card scaled by SCALE). */
const CAMERA_DISTANCE = 6 / SCALE
/**
 * How much of the background, from each edge, is kept for the part of the tub outside the window: face-on the
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
 * The tub the background lines: a rounded rectangle (a superellipse, the window's own shape) behind the window,
 * opening toward the viewer, with a mostly flat floor that curves up into its walls. Its rim sits a little
 * outside the window (TUB_REACH), so face-on the walls stay behind the person even at the window's edges.
 * The geometry is in the window's own frame (centre at the origin, window at z 0), which the material reads to
 * work out how each point looks face-on.
 */
const TUB_REACH = 1.35
/** How square the tub's corners are: 2 is an ellipse, higher is closer to a rectangle. */
const TUB_SQUARENESS = 6
/** How flat its floor is: 2 is a half-ellipse profile, higher keeps the floor flat and curves only near the walls. */
const TUB_FLATNESS = 4

function useTub(half: { x: number; y: number }, depth: number) {
  return useMemo(() => {
    const around = 160
    const out = 48
    const positions: number[] = []
    const index: number[] = []
    for (let i = 0; i <= out; i++) {
      const r = i / out
      const z = -depth * Math.pow(1 - Math.pow(r, TUB_FLATNESS), 1 / 2)
      for (let j = 0; j <= around; j++) {
        const a = (j / around) * Math.PI * 2
        const [c, s] = [Math.cos(a), Math.sin(a)]
        // A point on the superellipse rim, scaled in by r.
        const rx = Math.sign(c) * Math.pow(Math.abs(c), 2 / TUB_SQUARENESS) * half.x * TUB_REACH
        const ry = Math.sign(s) * Math.pow(Math.abs(s), 2 / TUB_SQUARENESS) * half.y * TUB_REACH
        positions.push(rx * r, ry * r, z)
      }
    }

    for (let i = 0; i < out; i++) {
      for (let j = 0; j < around; j++) {
        const a = i * (around + 1) + j
        const b = a + around + 1
        index.push(a, b, a + 1, b, b + 1, a + 1)
      }
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setIndex(index)
    return geometry
  }, [half.x, half.y, depth])
}

export function LoopPolaroid({ texture, settings, pointer }: { texture: VideoTexture; settings: Settings; pointer: { current: { x: number; y: number } } }) {
  const group = useRef<Group>(null)
  const photoWindow = useRef<Mesh>(null)
  const photo = usePhotoWindow()
  const dark = useStore((state) => state.colorScheme === 'dark')

  // Each layer is sized so that, face-on, it exactly fills the window: perspective shrinks what's further back.
  const fill = (depth: number) => ({ x: (photo.size.x / 2) * ((CAMERA_DISTANCE + depth) / CAMERA_DISTANCE), y: (photo.size.y / 2) * ((CAMERA_DISTANCE + depth) / CAMERA_DISTANCE) })
  const personDepth = BOX_DEPTH * PERSON_DEPTH
  const person = fill(personDepth)
  const tub = useTub({ x: photo.size.x / 2, y: photo.size.y / 2 }, BOX_DEPTH)
  const half = useMemo(() => new Vector2(photo.size.x / 2, photo.size.y / 2), [photo])
  const tubHalf = useMemo(() => half.clone().multiplyScalar(TUB_REACH), [half])

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
        {/* The tub the background lines. */}
        <mesh geometry={tub} renderOrder={2}>
          {settings.background ? (
            <polaroidLoopMaterial key={PolaroidLoopMaterial.key} uTexture={texture} uLayer={2} uHalf={half} uCameraDistance={CAMERA_DISTANCE} uBand={BAND} transparent={false} side={DoubleSide} {...IN_THE_BOX} />
          ) : (
            <meshBasicMaterial color={dark ? PLAIN.dark : PLAIN.light} side={DoubleSide} {...IN_THE_BOX} />
          )}
        </mesh>
        {/* Reaching past the window, its edges stretched out (the panels clamp at their edge), so where the person
            meets the edge of the frame (shoulders) they carry on, wrapping round the tub's walls where those come
            forward of them (the material follows the tub's shape). Face-on, the window shows the same middle of
            the panels as the tub does. */}
        <mesh renderOrder={3}>
          <planeGeometry args={[person.x * 2 * PERSON_REACH, person.y * 2 * PERSON_REACH, 256, 256]} />
          <polaroidLoopMaterial key={PolaroidLoopMaterial.key} uTexture={texture} uLayer={1} uUvScale={PERSON_REACH} uBand={BAND} uPersonDepth={personDepth} uTubHalf={tubHalf} uTubDepth={BOX_DEPTH} uTubSquareness={TUB_SQUARENESS} uTubFlatness={TUB_FLATNESS} uDepthStrength={settings.depth * personDepth} uOutline={settings.outline} {...IN_THE_BOX} />
        </mesh>
      </group>
    </group>
  )
}

/**
 * Plays a polaroid's atlas as a texture: fetched whole into a blob URL first, since the dev server's file route
 * doesn't answer range requests, which looping needs (an atlas is a few MB). `url` is a job's file in /admin, or the
 * public bucket's `<id>/atlas.mp4`.
 */
export function useAtlas(url: string) {
  const [texture, setTexture] = useState<VideoTexture | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!url) return
    let cancelled = false
    let blobUrl = ''
    let tex: VideoTexture | null = null
    const video = document.createElement('video')
    Object.assign(video, { muted: true, loop: true, playsInline: true, crossOrigin: 'anonymous' })
    setTexture(null)
    setError('')
    fetch(url)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("Couldn't load the polaroid"))))
      .then(async (blob) => {
        if (cancelled) return
        blobUrl = URL.createObjectURL(blob)
        video.src = blobUrl
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
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [url])
  return { texture, error }
}

/**
 * One polaroid on its own canvas, filling its parent: the atlas at `atlas`, swaying and turning toward the pointer
 * anywhere on the page (held a little past the canvas's edges, so it keeps following around the page).
 */
export function PolaroidScene({ atlas, settings = DEFAULTS, hint = 'Move the pointer to turn it.' }: { atlas: string; settings?: Settings; hint?: string }) {
  const dark = useStore((state) => state.colorScheme === 'dark')
  const { texture, error } = useAtlas(atlas)
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

  return (
    <>
      <div ref={area} className="absolute inset-0">
        <Canvas camera={{ position: [0, 0, 6], fov: 35 }} dpr={[1, 2]} gl={{ stencil: true }}>
          <ambientLight intensity={dark ? 1.0 : 1.1} />
          <directionalLight position={[2, 3, 5]} intensity={dark ? 1.2 : 1.6} />
          <Suspense fallback={null}>{texture && <LoopPolaroid texture={texture} settings={settings} pointer={pointer} />}</Suspense>
        </Canvas>
      </div>
      <p className="pointer-events-none absolute left-4 top-3 text-sm text-stone-600 dark:text-stone-400">{error || (texture ? hint : 'Loading…')}</p>
    </>
  )
}
