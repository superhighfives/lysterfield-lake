import { useGLTF } from '@react-three/drei'
import { Euler, ThreeElements, Vector3 } from '@react-three/fiber'
import { forwardRef, JSX, RefObject, useEffect, useMemo, useRef } from 'react'
import { GLTF } from 'three-stdlib'
import {
  BufferGeometry,
  CanvasTexture,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Vector2,
} from 'three'
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js'
import { animated } from '@react-spring/three'
import { useStore } from '../store'
import { WAKE_MASK_LAYER } from '../utils/liquid-trail'

// A soft-edged rectangle used as the drop shadow's alpha map — built once
// at module load (up to ~20 Polaroids share this one texture) rather than
// shipping another binary asset for a blurred box. alphaMap reads the
// texture's *green* channel, not its alpha, so the falloff is drawn as
// white-on-black: a gradient that only faded canvas alpha (as this first
// did) left green at full strength right up to the edge, giving a hard
// disc. The blur comes from canvas's shadowBlur: the rectangle itself is
// drawn off-canvas, and only its offset shadow lands inside.
const shadowTexture = (() => {
  const size = 128
  const inset = 24
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, size, size)
  ctx.shadowColor = 'white'
  ctx.shadowBlur = 16
  ctx.shadowOffsetX = size * 4
  ctx.fillStyle = 'white'
  ctx.fillRect(inset - size * 4, inset, size - inset * 2, size - inset * 2)
  return new CanvasTexture(canvas)
})()

type GLTFResult = GLTF & {
  nodes: {
    Object_3: Mesh
    Object_3001: Mesh
    Object_4: Mesh
    Object_5: Mesh
  }
  materials: {
    Frameblinn2SG: MeshStandardMaterial
    ['Material.001']: MeshStandardMaterial
    Framelambert79SG: MeshStandardMaterial
    initialShadingGroup: MeshStandardMaterial
  }
}

const FRAME_LIGHT = '#ffffff'
const FRAME_DARK = '#2b2826'
const FRAME_DARK_ROUGHNESS = 0.75
// The player's polaroid in dark mode: still a sheen as it tilts, but a
// broad, soft one. At the glossy paper's own roughness the spotlight
// focused into a hard white streak across the charcoal frame, even dimmed;
// rougher spreads it, and the dimmer dark-mode light (scene.tsx) keeps the
// spread from washing the frame grey.
const PLAYER_DARK_ROUGHNESS = 0.5

// Carousel cards are drawn as layers, one at a time, each into its own
// cleared depth buffer (see slider.tsx). That only works if every part of
// a card lands in three.js's transparent pass — opaque objects all draw
// first, in a pass of their own — so the carousel gets its own
// transparent copies of the frame materials. The player's polaroid keeps
// the shared originals. One copy per material is enough: draw order comes
// from each mesh's renderOrder, not its material.
const layeredCopies = new Map<MeshStandardMaterial, MeshStandardMaterial>()
function layeredCopy(material: MeshStandardMaterial) {
  let copy = layeredCopies.get(material)
  if (!copy) {
    copy = material.clone()
    copy.transparent = true
    // Out of the renderer's ACES tone mapping, which pulls white paper down
    // to a muted, slightly olive grey — the carousel's lit frames should
    // read as white (see the choose-screen light levels in scene.tsx).
    copy.toneMapped = false
    copy.userData.roughness = material.userData.roughness ?? material.roughness
    layeredCopies.set(material, copy)
  }

  return copy
}

// The player's polaroid flexes like card as it moves (see main.tsx, which
// sets this every frame): z offset per squared normalised x and y, the same
// as video-material.tsx's vertex shader does for the photo. The model is a
// few dozen vertices, which can't bend, so the player's copies of its
// geometry are subdivided once, and its frame materials get the same
// displacement injected. The overlay material is shared with the
// carousel, so the player gets its own copy of that one.
export const polaroidBend = { value: new Vector2() }
const BEND_EXTENT = 'vec2(1.83, 2.3)'
const TESSELLATE_EDGE = 0.25
const TESSELLATE_ITERATIONS = 8

const tessellated = new Map<BufferGeometry, BufferGeometry>()
function tessellate(geometry: BufferGeometry) {
  let result = tessellated.get(geometry)
  if (!result) {
    result = new TessellateModifier(
      TESSELLATE_EDGE,
      TESSELLATE_ITERATIONS
    ).modify(geometry)
    tessellated.set(geometry, result)
  }

  return result
}

function injectBend(material: Material) {
  if (material.userData.bend) return
  material.userData.bend = true
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBend = polaroidBend
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uBend;')
      // Tilt the normals with the curve too, so the sheen sweeps across
      // it — face-on, the curl alone barely shows.
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vec2 bendExtent = ${BEND_EXTENT};
        vec2 slope = 2.0 * uBend * position.xy / (bendExtent * bendExtent);
        objectNormal = normalize(objectNormal - vec3(slope, 0.0) * sign(objectNormal.z));`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec2 bendUv = transformed.xy / ${BEND_EXTENT};
        transformed.z += dot(uBend, bendUv * bendUv);`
      )
  }

  material.needsUpdate = true
}

let playerOverlay: MeshStandardMaterial | null = null

// Every Object_3/Object_4/Object_5 mesh below shares this same identity
// transform — hoisted so the ~20 on-screen Polaroid instances in the
// choose-screen carousel aren't each allocating three fresh arrays per
// render.
const rotation = [0, 0, 0]
const position = [0, 0, 0]
const scale = [1.0, 1.0, 1.0]

const Polaroid = forwardRef<
  Group,
  ThreeElements['group'] & {
    passthroughMaterial: JSX.Element
    intersectRef?: RefObject<Mesh>
    /** Carousel card: use the transparent material copies (see above),
     *  and stay out of the spotlight's shadow map. Cards are drawn as
     *  separate layers, so shadow-map shadows between them don't belong,
     *  and with the choose screen's light aimed sideways from the camera
     *  they came out low-res and jagged. The drop-shadow plane does that
     *  job instead. */
    layered?: boolean
  }
>(({ layered, passthroughMaterial, intersectRef, ...props }, ref) => {
  const { nodes, materials } = useGLTF(
    '/models/polaroid.glb'
  ) as unknown as GLTFResult
  const frame = (material: MeshStandardMaterial) =>
    layered ? layeredCopy(material) : material

  // The player's bending copies (see polaroidBend above).
  const player = useMemo(() => {
    if (layered) return null
    if (!playerOverlay) {
      playerOverlay = materials['Material.001'].clone()
      playerOverlay.transparent = true
    }

    for (const material of [
      playerOverlay,
      materials.Framelambert79SG,
      materials.initialShadingGroup,
    ])
      injectBend(material)
    return {
      overlay: playerOverlay,
      inside: tessellate(nodes.Object_3.geometry),
      overlayGeometry: tessellate(nodes.Object_3001.geometry),
      back: tessellate(nodes.Object_4.geometry),
      front: tessellate(nodes.Object_5.geometry),
    }
  }, [layered, nodes, materials])

  materials['Material.001'].transparent = true

  // Charcoal frames in dark mode. The frame materials are a white paper
  // texture times `color`, so tinting keeps the paper grain. useGLTF
  // shares one set of materials across every Polaroid instance (and the
  // carousel shares one set of copies), so this tints them all at once.
  const dark = useStore((state) => state.colorScheme === 'dark')
  useEffect(() => {
    for (const material of [
      materials.Frameblinn2SG,
      materials.Framelambert79SG,
      materials.initialShadingGroup,
    ]) {
      material.color.set(dark ? FRAME_DARK : FRAME_LIGHT)
      material.userData.roughness ??= material.roughness
      material.roughness = dark
        ? PLAYER_DARK_ROUGHNESS
        : material.userData.roughness
      const copy = layeredCopies.get(material)
      if (copy) {
        copy.color.set(dark ? FRAME_DARK : FRAME_LIGHT)
        // Matte in dark mode: the glossy paper's specular highlight, from
        // a light right by the camera, read as a bright white smear on the
        // charcoal cards under the pointer.
        copy.roughness = dark ? FRAME_DARK_ROUGHNESS : copy.userData.roughness
      }
    }
  }, [dark, materials, layered])

  // The card itself (not its drop shadow) joins the wake's mask layer, so
  // the wake pass blurs polaroids and ripples everything else (see
  // components/wake-pass.tsx).
  const card = useRef<Group>(null)
  useEffect(() => {
    card.current?.traverse((object) => object.layers.enable(WAKE_MASK_LAYER))
  }, [player])

  return (
    <animated.group ref={ref} {...props} dispose={null}>
      {/* Drop shadow, so a card in front reads as resting on the one
          behind it. The plane has to be larger than the frame itself
          (3.66 x 4.47 units) to show at all — an earlier 3.5 x 3.6 sat
          entirely hidden behind its own card — and the alpha map's soft
          box only fills its middle ~60%, so it's sized well past that.
          It's also nudged left, toward the neighbour behind (cards
          further left sit further back).
          `depthWrite={false}`: it's meant to be seen through, not to
          occlude anything. */}
      <mesh position={[-0.35, -0.2, -0.3]}>
        <planeGeometry args={[5.6, 6.6]} />
        <meshBasicMaterial
          color="black"
          alphaMap={shadowTexture}
          transparent
          // Much stronger for carousel cards in dark mode, where it falls
          // on charcoal cards and black-on-near-black barely registers at
          // the light value. Not on the player's polaroid, where it has no
          // card behind to land on and just reads as a dark smudge on the
          // background.
          opacity={dark ? (layered ? 0.8 : 0.28) : 0.16}
          depthWrite={false}
        />
      </mesh>

      <group ref={card}>
        {/* Overlay */}
        <mesh
          castShadow={!layered}
          receiveShadow={!layered}
          geometry={player?.overlayGeometry ?? nodes.Object_3001.geometry}
          material={player?.overlay ?? materials['Material.001']}
          position={[0, 0, 0.001]}
        />

        {/* Inside */}
        <mesh
          ref={intersectRef}
          castShadow={!layered}
          receiveShadow={!layered}
          geometry={player?.inside ?? nodes.Object_3.geometry}
          rotation={rotation as Euler}
          position={position as Vector3}
          scale={scale as Vector3}
        >
          {passthroughMaterial}
        </mesh>
        {/* Back */}
        <mesh
          castShadow={!layered}
          receiveShadow={!layered}
          geometry={player?.back ?? nodes.Object_4.geometry}
          material={frame(materials.Framelambert79SG)}
          rotation={rotation as Euler}
          position={position as Vector3}
          scale={scale as Vector3}
        />
        {/* Front */}
        <mesh
          castShadow={!layered}
          receiveShadow={!layered}
          geometry={player?.front ?? nodes.Object_5.geometry}
          material={frame(materials.initialShadingGroup)}
          rotation={rotation as Euler}
          position={position as Vector3}
          scale={scale as Vector3}
        />
      </group>
    </animated.group>
  )
})

Polaroid.displayName = 'Polaroid'

export default Polaroid

useGLTF.preload('/models/polaroid.glb')
