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

// How far (CSS px) the image is pulled at full flow, and the catch of light
// on the wake's leading edge.
const WAKE_PX = 8
const WAKE_GLINT = 0.12
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
    vec4 color = texture2D(uScene, vUv - offset);

    // Light on the edge the wake is moving into: how fast its presence
    // falls away ahead of the flow.
    vec2 ahead = normalize(wake.xy + 1e-5) * 6.0 / uSize;
    float edge = max(wake.z - wakeAt(vUv + ahead).z, 0.0);
    color.rgb += edge * ${WAKE_GLINT.toFixed(3)} * color.a;

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
