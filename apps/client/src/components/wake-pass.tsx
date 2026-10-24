import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three'
import {
  DROP_SECONDS,
  MAX_DROPS,
  SETTLE,
  TRAIL_SIZE,
  WAKE_MASK_LAYER,
  dropUniform,
  takeStroke,
  trailActive,
  writeDrops,
} from '../utils/liquid-trail'
import { useStore } from '../store'

// The cursor's liquid wake, over everything the canvas draws: the scene is
// rendered to a texture, then drawn to the screen through the water — the
// image pulled along the pointer's recent path (utils/liquid-trail.ts),
// photos, frames, text and the polaroid's own outline alike, and soft
// swells spreading out from where it's been. HTML on top (the cursor, the
// controls) is untouched.
//
// The trail itself lives here, on the GPU: a small half-float map, two
// copies traded each frame, faded by SETTLE and painted with the frame's
// stroke. In floats it fades exactly to nothing.
//
// The render target is flagged as an XR one, which in three.js r170 makes
// a render into it apply each material's own tone mapping and output colour
// space exactly as rendering to the screen does — this scene mixes
// tone-mapped materials with ones that opt out (the carousel's frames), so
// a plain target, which skips both, would shift its colours. What lands in
// the texture is then exactly what would have reached the screen, and the
// final pass copies it across unchanged, apart from the wake.

// How far (CSS px) the image is pulled at full flow — a fast flick; the
// trail's speed curve (utils/liquid-trail.ts) keeps slower moves well
// under it.
const WAKE_PX = 20
// The drops the pointer leaves (utils/liquid-trail.ts) spread as single
// soft swells, RING_SPEED_PX per second, RING_WIDTH_PX wide, fading out
// over the drop's life. They bend everything but the polaroids (up to
// RING_PUSH_PX) — the polaroids are the meshes on WAKE_MASK_LAYER, drawn
// into a small soft mask, MASK_SCALE of the screen — and in dark mode
// they're a faint lift of light on the bare page (RING_LIGHT), dithered
// by RING_NOISE so the faint gradient doesn't band. In light mode a plain
// shade or glow read as dirt, so each swell is a ripple instead: a bright
// crest on its leading side (RING_CREST) and a faint cool trough on its
// trailing side (RING_TROUGH, in RING_TROUGH_TINT), as light refracts
// through a real one.
const MASK_SCALE = 0.25
const RING_SPEED_PX = 150
const RING_WIDTH_PX = 80
const RING_PUSH_PX = 9
const RING_LIGHT = 0.05
const RING_NOISE = 0.012
const RING_CREST = 0.3
const RING_TROUGH = 0.1
// Overlapping swells add up; past this the ripple read as grey circles.
const RING_SLOPE_MAX = 0.12
const RING_TROUGH_TINT = [0.36, 0.42, 0.48]

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// The trail: last frame's map, faded, with this frame's stroke painted
// over it — a capsule along the pointer's segment, soft to its radius,
// pulling what's there toward the stroke's flow and presence.
const trailShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uPrevious;
  uniform float uAspect;
  uniform vec4 uSegment;
  uniform float uRadius;
  uniform vec3 uStamp;
  uniform float uAlpha;

  void main() {
    vec3 value = texture2D(uPrevious, vUv).rgb * ${(1 - SETTLE).toFixed(4)};
    if (uAlpha > 0.0) {
      // In width units, so the stroke is round on any screen.
      vec2 scale = vec2(1.0, 1.0 / uAspect);
      vec2 p = vUv * scale;
      vec2 a = uSegment.xy * scale;
      vec2 b = uSegment.zw * scale;
      vec2 ab = b - a;
      float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
      float d = length(p - (a + ab * t)) / uRadius;
      float paint = uAlpha * (1.0 - smoothstep(0.0, 1.0, d));
      value = mix(value, uStamp, paint);
    }
    gl_FragColor = vec4(value, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uScene;
  uniform sampler2D uTrail;
  uniform sampler2D uMask;
  uniform vec2 uSize;
  uniform float uDark;
  // xy = CSS px from the bottom-left, z = age (s), w = strength.
  uniform vec4 uDrops[${MAX_DROPS}];

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    // The trail's flow here (y up) — its presence is in .z.
    vec2 flow = texture2D(uTrail, vUv).xy;
    float polaroid = texture2D(uMask, vUv).a;

    // The swells: each drop's soft band spreading outward and fading.
    // swell is how much is here; push bends the image outward on a band's
    // leading side and back in on its trailing side.
    vec2 here = vUv * uSize;
    float swell = 0.0;
    // Which side of the bands this is: + leading (the crest), - trailing.
    float slope = 0.0;
    vec2 push = vec2(0.0);
    for (int i = 0; i < ${MAX_DROPS}; i++) {
      vec4 drop = uDrops[i];
      if (drop.w <= 0.0) continue;
      vec2 away = here - drop.xy;
      float front = (length(away) - drop.z * ${RING_SPEED_PX.toFixed(1)}) / ${RING_WIDTH_PX.toFixed(1)};
      float band = exp(-front * front);
      float life = clamp(drop.z / ${DROP_SECONDS.toFixed(2)}, 0.0, 1.0);
      // Eases in over the first moment, and out over the rest.
      float fade = smoothstep(0.0, 0.08, life) * (1.0 - life) * (1.0 - life) * drop.w;
      swell += band * fade;
      slope -= front * band * fade;
      push -= normalize(away + 1e-5) * front * band * fade * 1.4;
    }
    swell = min(swell, 1.0);
    slope = clamp(slope, -${RING_SLOPE_MAX.toFixed(3)}, ${RING_SLOPE_MAX.toFixed(3)});

    vec2 offset = flow * ${WAKE_PX.toFixed(1)} / uSize;
    offset += push * (1.0 - polaroid) * ${RING_PUSH_PX.toFixed(1)} / uSize;
    vec4 color = texture2D(uScene, vUv - offset);

    // Dark mode: the swells' light on the bare page, with a little grain.
    float behind = (1.0 - color.a) * swell * uDark;
    if (behind > 0.0005) {
      float grain = (hash(gl_FragCoord.xy) - 0.5) * ${RING_NOISE.toFixed(3)} * smoothstep(0.0, 0.15, behind);
      // Premultiplied: light adds white.
      float amount = max(0.0, behind * ${RING_LIGHT.toFixed(3)} + grain);
      color += vec4(vec3(amount), amount);
    }

    // Light mode: the swells' crest and trough on the bare page.
    float bare = (1.0 - color.a) * (1.0 - uDark);
    if (bare > 0.0005 && abs(slope) > 0.0005) {
      float grain = (hash(gl_FragCoord.xy) - 0.5) * ${RING_NOISE.toFixed(3)} * smoothstep(0.0, 0.05, abs(slope));
      float crest = max(0.0, max(slope, 0.0) * ${RING_CREST.toFixed(3)} * bare + grain);
      float trough = max(0.0, max(-slope, 0.0) * ${RING_TROUGH.toFixed(3)} * bare + grain);
      // Premultiplied: the crest adds white, the trough its tint.
      color += vec4(vec3(crest), crest);
      color += vec4(vec3(${RING_TROUGH_TINT.map((c) => c.toFixed(2)).join(', ')}) * trough, trough);
    }

    gl_FragColor = color;
  }
`

function WakePass() {
  const gl = useThree((state) => state.gl)
  const size = useThree((state) => state.size)

  const target = useMemo(() => {
    const renderTarget = new WebGLRenderTarget(1, 1)
    renderTarget.texture.colorSpace = SRGBColorSpace
    // Plain RGBA8, not an sRGB format: the values written are already
    // sRGB-encoded (see the flag below), so the texture must store them as
    // they are — and if MSAA comes back, its multisampled buffer is RGBA8
    // under the flag, and a mismatched resolve blanks the screen.
    renderTarget.texture.internalFormat = 'RGBA8'
    // See above: renders into this get the screen's own colour handling.
    ;(renderTarget as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true
    return renderTarget
  }, [])

  // The trail's two maps (see above).
  const trail = useMemo(() => {
    const make = () =>
      new WebGLRenderTarget(1, 1, {
        type: HalfFloatType,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
      })
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader: trailShader,
      uniforms: {
        uPrevious: { value: null },
        uAspect: { value: 1 },
        uSegment: { value: new Vector4() },
        uRadius: { value: 0.05 },
        uStamp: { value: new Vector3() },
        uAlpha: { value: 0 },
      },
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    })
    const scene = new Scene()
    scene.add(new Mesh(new PlaneGeometry(2, 2), material))
    return { read: make(), write: make(), material, scene, dirty: false }
  }, [])

  // The polaroids' coverage (see MASK_SCALE), drawn white over clear with
  // no depth test — a soft mask, not an exact one, is all the pass needs.
  const mask = useMemo(
    () => ({
      target: new WebGLRenderTarget(1, 1),
      material: new MeshBasicMaterial({
        color: 'white',
        depthTest: false,
        depthWrite: false,
      }),
    }),
    []
  )

  const pass = useMemo(() => {
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uScene: { value: target.texture },
        uTrail: { value: null },
        uSize: { value: new Vector2(1, 1) },
        uDrops: { value: dropUniform },
        uDark: { value: 0 },
        uMask: { value: mask.target.texture },
      },
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    const scene = new Scene()
    scene.add(new Mesh(new PlaneGeometry(2, 2), material))
    return { scene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), material }
  }, [target, mask])

  useEffect(() => {
    const dpr = gl.getPixelRatio()
    target.setSize(Math.round(size.width * dpr), Math.round(size.height * dpr))
    mask.target.setSize(
      Math.max(1, Math.round(size.width * MASK_SCALE)),
      Math.max(1, Math.round(size.height * MASK_SCALE))
    )
    const aspect = size.width / size.height || 1
    const trailWidth = aspect >= 1 ? TRAIL_SIZE : Math.round(TRAIL_SIZE * aspect)
    const trailHeight = aspect >= 1 ? Math.round(TRAIL_SIZE / aspect) : TRAIL_SIZE
    trail.read.setSize(trailWidth, trailHeight)
    trail.write.setSize(trailWidth, trailHeight)
    trail.material.uniforms.uAspect.value = aspect
    trail.dirty = true
    pass.material.uniforms.uSize.value.set(size.width, size.height)
  }, [gl, size, target, pass, mask, trail])

  useEffect(
    () => () => {
      target.dispose()
      pass.material.dispose()
      mask.target.dispose()
      mask.material.dispose()
      trail.read.dispose()
      trail.write.dispose()
      trail.material.dispose()
    },
    [target, pass, mask, trail]
  )

  // Priority 1: R3F stops rendering on its own, and this renders after
  // every other frame callback.
  useFrame((state) => {
    pass.material.uniforms.uDark.value =
      useStore.getState().colorScheme === 'dark' ? 1 : 0
    const stroke = takeStroke(state.size.width, state.size.height)
    writeDrops(state.size.height)
    // Nothing moving, or a dream playing (the wake's for the welcome and
    // choose screens; the player has its own water): the pass would copy
    // the scene across unchanged, so skip it and draw the scene straight to
    // the screen, as it was before the wake existed. Only a stroke's worth
    // of frames pay for the extra passes. The trail's faint remainder is
    // cleared, so it starts clean.
    if (!trailActive() || useStore.getState().dream) {
      if (trail.dirty) {
        for (const map of [trail.read, trail.write]) {
          gl.setRenderTarget(map)
          gl.clear()
        }

        trail.dirty = false
      }

      gl.setRenderTarget(null)
      gl.render(state.scene, state.camera)
      return
    }

    // The trail: fade last frame's, paint this frame's stroke, and trade.
    const uniforms = trail.material.uniforms
    uniforms.uPrevious.value = trail.read.texture
    uniforms.uAlpha.value = stroke ? stroke.alpha : 0
    if (stroke) {
      uniforms.uSegment.value.set(...stroke.from, ...stroke.to)
      uniforms.uRadius.value = stroke.radius
      uniforms.uStamp.value.set(...stroke.flow, stroke.presence)
    }

    gl.setRenderTarget(trail.write)
    gl.render(trail.scene, pass.camera)
    ;[trail.read, trail.write] = [trail.write, trail.read]
    trail.dirty = true
    pass.material.uniforms.uTrail.value = trail.read.texture

    const { scene, camera } = state
    const layers = camera.layers.mask
    camera.layers.set(WAKE_MASK_LAYER)
    scene.overrideMaterial = mask.material
    gl.setRenderTarget(mask.target)
    gl.clear()
    gl.render(scene, camera)
    scene.overrideMaterial = null
    camera.layers.mask = layers

    gl.setRenderTarget(target)
    gl.clear()
    gl.render(scene, camera)
    gl.setRenderTarget(null)
    gl.render(pass.scene, pass.camera)
  }, 1)

  return null
}

export default WakePass
