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
import {
  DROP_SECONDS,
  MAX_DROPS,
  dropUniform,
  trailActive,
  trailTexture,
  updateTrail,
  writeDrops,
} from '../utils/liquid-trail'

// The cursor's liquid wake, over everything the canvas draws: the scene is
// rendered to a texture, then drawn to the screen through the water — the
// image pulled along the pointer's recent path, crisp rings spreading from
// where it's been, and colours blooming where the water moves
// (utils/liquid-trail.ts) — photos, frames, text and the polaroid's own
// outline alike. HTML on top (the cursor, the controls) is untouched.
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
const WAKE_PX = 10
// The water, crisp like the welcome screen's (no blur): rings dropped by
// the pointer (utils/liquid-trail.ts) spread at RING_SPEED_PX per second,
// RING_WAVELENGTH_PX apart, in a band RING_WIDTH_PX wide, pushing the image
// by up to RING_PUSH_PX and catching the light on their crests
// (RING_GLINT). Where there's water, colours bloom: lifted by a gamma of
// up to BLOOM_GAMMA (1 = none), rather than blurred.
const RING_SPEED_PX = 200
const RING_WAVELENGTH_PX = 46
const RING_WIDTH_PX = 34
const RING_PUSH_PX = 7
const RING_GLINT = 0.07
const BLOOM_GAMMA = 0.7

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
  // xy = CSS px from the bottom-left, z = age (s), w = strength.
  uniform vec4 uDrops[${MAX_DROPS}];

  // The trail's flow here, in screen space (y up), and how much wake.
  vec3 wakeAt(vec2 uv) {
    vec3 trail = texture2D(uTrail, uv).rgb;
    return vec3((trail.r - 0.5) * 2.0, -(trail.g - 0.5) * 2.0, trail.b);
  }

  void main() {
    vec3 wake = wakeAt(vUv);
    vec2 offset = wake.xy * ${WAKE_PX.toFixed(1)} / uSize;

    // Rings: each drop's ring pushes the image outward along it as it
    // spreads, and fades as it goes.
    vec2 here = vUv * uSize;
    vec2 push = vec2(0.0);
    float crest = 0.0;
    float energy = 0.0;
    for (int i = 0; i < ${MAX_DROPS}; i++) {
      vec4 drop = uDrops[i];
      if (drop.w <= 0.0) continue;
      vec2 away = here - drop.xy;
      float front = length(away) - drop.z * ${RING_SPEED_PX.toFixed(1)};
      float ring = exp(-(front * front) / ${(RING_WIDTH_PX * RING_WIDTH_PX).toFixed(1)});
      float fade = max(0.0, 1.0 - drop.z / ${DROP_SECONDS.toFixed(2)});
      float wave = sin(front * 6.2832 / ${RING_WAVELENGTH_PX.toFixed(1)}) * ring * fade * fade * drop.w;
      push += normalize(away + 1e-5) * wave;
      crest += max(wave, 0.0);
      energy += ring * fade * drop.w;
    }
    offset += push * ${RING_PUSH_PX.toFixed(1)} / uSize;

    vec4 color = texture2D(uScene, vUv - offset);

    // Light on the crests, and colours blooming where the water moves.
    // Premultiplied, so both work on colour over alpha.
    float water = clamp(max(wake.z, energy), 0.0, 1.0);
    if (color.a > 0.001 && water > 0.002) {
      vec3 straight = color.rgb / color.a;
      straight = pow(straight, vec3(mix(1.0, ${BLOOM_GAMMA.toFixed(2)}, water)));
      straight += crest * ${RING_GLINT.toFixed(3)};
      color.rgb = min(straight, vec3(1.0)) * color.a;
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

  const pass = useMemo(() => {
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uScene: { value: target.texture },
        uTrail: { value: trailTexture },
        uSize: { value: new Vector2(1, 1) },
        uDrops: { value: dropUniform },
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
    writeDrops(state.size.height)
    // Nothing moving: the pass would copy the scene across unchanged, so
    // skip it and draw the scene straight to the screen, as it was before
    // the wake existed. Only a stroke's worth of frames pay for two passes.
    if (!trailActive()) {
      gl.setRenderTarget(null)
      gl.render(state.scene, state.camera)
      return
    }

    gl.setRenderTarget(target)
    gl.clear()
    gl.render(state.scene, state.camera)
    gl.setRenderTarget(null)
    gl.render(pass.scene, pass.camera)
  }, 1)

  return null
}

export default WakePass
