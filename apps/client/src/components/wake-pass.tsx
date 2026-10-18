import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three'
import { trailTexture, updateTrail } from '../utils/liquid-trail'

// The cursor's liquid wake, over everything the canvas draws: the scene is
// rendered to a texture, then drawn to the screen pulled along the
// pointer's recent path (utils/liquid-trail.ts) — photos, frames, text and
// the polaroid's own outline alike. HTML on top (the cursor, the controls)
// is untouched.
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
// under it — and the catch of light on the wake's leading edge.
const WAKE_PX = 16
// Where there's wake, it reads as light on water rather than a blur:
// - glass: the wake's surface (its presence, as a height) catches the
//   light, as thin bright highlights — GLINT_STRENGTH, sharpened by
//   GLINT_SHARPNESS, its slope measured GLINT_SPREAD px apart;
// - bloom: a soft glow (a disc of BLOOM_TAPS samples, BLOOM_PX across)
//   laid over it, BLOOM_STRENGTH at full wake;
// - a short trail back along the flow (TRAIL_PX, no colour split).
const GLINT_STRENGTH = 0.55
const GLINT_SHARPNESS = 6.0
const GLINT_SPREAD = 4.0
const BLOOM_TAPS = 8
const BLOOM_PX = 10
const BLOOM_STRENGTH = 0.28
const TRAIL_PX = 6
// MSAA for the offscreen render, matching the canvas's own antialiasing.
const SAMPLES = 4

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uScene;
  uniform sampler2D uTrail;
  uniform vec2 uSize;

  // The trail's flow here, in screen space (y up), and how much wake.
  vec3 wakeAt(vec2 uv) {
    vec3 trail = texture2D(uTrail, uv).rgb;
    return vec3((trail.r - 0.5) * 2.0, -(trail.g - 0.5) * 2.0, trail.b);
  }

  void main() {
    vec3 wake = wakeAt(vUv);
    vec2 offset = wake.xy * ${WAKE_PX.toFixed(1)} / uSize;
    vec2 uv = vUv - offset;
    vec4 color = texture2D(uScene, uv);

    if (wake.z > 0.002) {
      // A short trail back along the flow.
      vec2 trail = normalize(wake.xy + 1e-5) * ${TRAIL_PX.toFixed(1)} * wake.z / uSize;
      color = (color + texture2D(uScene, uv - trail * 0.5) + texture2D(uScene, uv - trail)) / 3.0;

      // Bloom: a soft disc of the image around here, laid over it.
      vec4 bloom = vec4(0.0);
      for (int i = 0; i < ${BLOOM_TAPS}; i++) {
        float angle = float(i) / float(${BLOOM_TAPS}) * 6.2832;
        bloom += texture2D(uScene, uv + vec2(cos(angle), sin(angle)) * ${(BLOOM_PX / 2).toFixed(1)} / uSize);
      }
      bloom /= float(${BLOOM_TAPS});
      color.rgb += bloom.rgb * ${BLOOM_STRENGTH.toFixed(2)} * wake.z;

      // Glass: the wake's presence as a surface, lit from above-left. Its
      // slope picks out thin highlights where it rises toward the light.
      // Premultiplied, so the light is scaled by alpha.
      vec2 spread = ${GLINT_SPREAD.toFixed(1)} / uSize;
      vec2 slope = vec2(
        wakeAt(vUv + vec2(spread.x, 0.0)).z - wakeAt(vUv - vec2(spread.x, 0.0)).z,
        wakeAt(vUv + vec2(0.0, spread.y)).z - wakeAt(vUv - vec2(0.0, spread.y)).z
      );
      vec3 normal = normalize(vec3(-slope * 6.0, 1.0));
      float light = pow(max(dot(normal, normalize(vec3(-0.5, 0.6, 0.6))), 0.0), ${GLINT_SHARPNESS.toFixed(1)});
      color.rgb += light * ${GLINT_STRENGTH.toFixed(2)} * length(slope) * 4.0 * color.a;
      color.rgb = min(color.rgb, vec3(color.a));
    }

    gl_FragColor = color;
  }
`

function WakePass() {
  const gl = useThree((state) => state.gl)
  const size = useThree((state) => state.size)

  const target = useMemo(() => {
    const renderTarget = new WebGLRenderTarget(1, 1, { samples: SAMPLES })
    renderTarget.texture.colorSpace = SRGBColorSpace
    // The flag also stores the multisampled buffer as plain RGBA8 (the
    // values are already sRGB-encoded); the texture it resolves into has to
    // match, or the resolve fails and the screen goes blank.
    renderTarget.texture.internalFormat = 'RGBA8'
    // See above: renders into this get the screen's own colour handling.
    ;(renderTarget as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true
    return renderTarget
  }, [])

  const pass = useMemo(() => {
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uScene: { value: target.texture },
        uTrail: { value: trailTexture },
        uSize: { value: new Vector2(1, 1) },
      },
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    const scene = new Scene()
    scene.add(new Mesh(new PlaneGeometry(2, 2), material))
    return { scene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), material }
  }, [target])

  useEffect(() => {
    const dpr = gl.getPixelRatio()
    target.setSize(Math.round(size.width * dpr), Math.round(size.height * dpr))
    pass.material.uniforms.uSize.value.set(size.width, size.height)
  }, [gl, size, target, pass])

  useEffect(
    () => () => {
      target.dispose()
      pass.material.dispose()
    },
    [target, pass]
  )

  // Priority 1: R3F stops rendering on its own, and this renders after
  // every other frame callback.
  useFrame((state) => {
    updateTrail(state.size.width, state.size.height)
    gl.setRenderTarget(target)
    gl.clear()
    gl.render(state.scene, state.camera)
    gl.setRenderTarget(null)
    gl.render(pass.scene, pass.camera)
  }, 1)

  return null
}

export default WakePass
