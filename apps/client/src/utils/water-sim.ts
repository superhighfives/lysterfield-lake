import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three'

// A small sheet of water for the polaroid's blank print to ripple in (see
// views/main.tsx and video-material.tsx): a height field on the GPU, run
// through the wave equation each frame — so a stroke leaves a real wake,
// rings that cross and interfere and settle on their own — and stirred
// where the pointer moves over the print.
//
// Two half-float maps, traded each frame: red is the surface now, green
// the surface a frame ago (the wave equation needs both).

// The sheet's resolution (texels a side), how fast waves travel (the wave
// equation's c², per step: lower is slower and smoother; stable below
// 0.5), how much of each wave survives a step (lower settles sooner), and
// a stroke's radius (photo UV) and strength per unit of pointer speed —
// broad and gentle, so a stroke leaves a long, soft wake rather than a
// sharp groove.
const SIZE = 192
const WAVE_SPEED = 0.12
const DAMPING = 0.993
const RADIUS = 0.07
const PUSH = 0.05

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const stepShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uPrevious;
  uniform vec2 uTexel;
  uniform vec4 uSegment;
  uniform float uStrength;

  void main() {
    vec2 now = texture2D(uPrevious, vUv).rg;
    float around =
      texture2D(uPrevious, vUv + vec2(uTexel.x, 0.0)).r +
      texture2D(uPrevious, vUv - vec2(uTexel.x, 0.0)).r +
      texture2D(uPrevious, vUv + vec2(0.0, uTexel.y)).r +
      texture2D(uPrevious, vUv - vec2(0.0, uTexel.y)).r;
    float next = (2.0 * now.r - now.g + ${WAVE_SPEED.toFixed(2)} * (around - 4.0 * now.r)) * ${DAMPING.toFixed(3)};

    // The pointer pressing into the surface along this frame's path.
    if (uStrength > 0.0) {
      vec2 a = uSegment.xy;
      vec2 ab = uSegment.zw - a;
      float t = clamp(dot(vUv - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
      float d = length(vUv - (a + ab * t)) / ${RADIUS.toFixed(3)};
      next -= uStrength * exp(-d * d * 3.0);
    }

    gl_FragColor = vec4(next, now.r, 0.0, 1.0);
  }
`

export function createWaterSim() {
  const make = () =>
    new WebGLRenderTarget(SIZE, SIZE, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    })
  let read = make()
  let write = make()
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader: stepShader,
    uniforms: {
      uPrevious: { value: null },
      uTexel: { value: new Vector2(1 / SIZE, 1 / SIZE) },
      uSegment: { value: new Vector4() },
      uStrength: { value: 0 },
    },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  })
  const scene = new Scene()
  scene.add(new Mesh(new PlaneGeometry(2, 2), material))
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  let dirty = false

  return {
    /** The surface: red = height. */
    get texture() {
      return read.texture
    },
    texel: 1 / SIZE,
    /** One step, stirred along `from` -> `to` (photo UV) at `speed` (0-1),
     *  or left alone (speed 0). */
    step(gl: WebGLRenderer, from: Vector2, to: Vector2, speed: number) {
      const uniforms = material.uniforms
      uniforms.uPrevious.value = read.texture
      uniforms.uSegment.value.set(from.x, from.y, to.x, to.y)
      uniforms.uStrength.value = speed * PUSH
      const previous = gl.getRenderTarget()
      gl.setRenderTarget(write)
      gl.render(scene, camera)
      gl.setRenderTarget(previous)
      ;[read, write] = [write, read]
      dirty = true
    },
    /** Still water again. */
    clear(gl: WebGLRenderer) {
      if (!dirty) return
      const previous = gl.getRenderTarget()
      for (const target of [read, write]) {
        gl.setRenderTarget(target)
        gl.clear()
      }

      gl.setRenderTarget(previous)
      dirty = false
    },
    dispose() {
      read.dispose()
      write.dispose()
      material.dispose()
    },
  }
}
