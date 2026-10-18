import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Mesh,
  MeshBasicMaterial,
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
  WAKE_MASK_LAYER,
  dropUniform,
  trailActive,
  trailTexture,
  updateTrail,
  writeDrops,
} from '../utils/liquid-trail'
import { useStore } from '../store'

// The cursor's liquid wake, over everything the canvas draws: the scene is
// rendered to a texture, then drawn to the screen through the water — the
// image pulled along the pointer's recent path, colours blooming and
// catching the light where the water moves (utils/liquid-trail.ts) —
// photos, frames, text and the polaroid's own outline alike — and soft
// swells spreading behind them, on the page, from where it's been. HTML on top (the cursor, the controls) is untouched.
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
// Polaroids (the meshes on WAKE_MASK_LAYER, drawn into a small mask each
// frame, MASK_SCALE of the screen's CSS size, soft-edged by its own
// filtering) take the water as light through glass rather than ripples:
// - glass: the wake's surface (its presence, as a height) catches the
//   light, as thin bright highlights — GLINT_STRENGTH, sharpened by
//   GLINT_SHARPNESS, its slope measured GLINT_SPREAD px apart;
// - bloom: a soft glow (a disc of BLOOM_TAPS samples, BLOOM_PX across)
//   laid over it, BLOOM_STRENGTH at full wake;
// - a short trail back along the flow (TRAIL_PX, no colour split).
// Everywhere, colours lift by a gamma of up to BLOOM_GAMMA (1 = none)
// where the water moves.
const MASK_SCALE = 0.25
const GLINT_STRENGTH = 0.55
const GLINT_SHARPNESS = 6.0
const GLINT_SPREAD = 4.0
const BLOOM_TAPS = 8
const BLOOM_PX = 10
const BLOOM_STRENGTH = 0.28
const BLOOM_GAMMA = 0.75
const TRAIL_PX = 6
// The drops the pointer leaves (utils/liquid-trail.ts) spread as single
// soft swells — no ripples — RING_SPEED_PX per second, RING_WIDTH_PX wide,
// fading out over the drop's life. Over everything but the polaroids they
// bend the image (up to RING_PUSH_PX) and catch the light on their crests
// (RING_GLINT); on the page behind, they're a faint lift of light in dark
// mode and a shade in light mode (RING_LIGHT / RING_SHADE at full
// strength), dithered by RING_NOISE so the faint gradient doesn't band.
const RING_SPEED_PX = 150
const RING_WIDTH_PX = 80
const RING_PUSH_PX = 9
const RING_GLINT = 0.08
const RING_LIGHT = 0.05
const RING_SHADE = 0.1
const RING_NOISE = 0.012

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
  uniform sampler2D uMask;
  uniform vec2 uSize;
  uniform float uDark;
  // xy = CSS px from the bottom-left, z = age (s), w = strength.
  uniform vec4 uDrops[${MAX_DROPS}];

  // The trail's flow here, in screen space (y up), and how much wake.
  vec3 wakeAt(vec2 uv) {
    vec3 trail = texture2D(uTrail, uv).rgb;
    return vec3((trail.r - 0.5) * 2.0, -(trail.g - 0.5) * 2.0, trail.b);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 wake = wakeAt(vUv);
    float polaroid = texture2D(uMask, vUv).a;

    // The swells: each drop's soft band spreading outward and fading.
    // swell is how much is here; push bends the image outward on a band's
    // leading side and back in on its trailing side.
    vec2 here = vUv * uSize;
    float swell = 0.0;
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
      push -= normalize(away + 1e-5) * front * band * fade * 1.4;
    }
    swell = min(swell, 1.0);

    vec2 offset = wake.xy * ${WAKE_PX.toFixed(1)} / uSize;
    offset += push * (1.0 - polaroid) * ${RING_PUSH_PX.toFixed(1)} / uSize;
    vec2 uv = vUv - offset;
    vec4 color = texture2D(uScene, uv);

    if (wake.z > 0.002 && polaroid > 0.01) {
      vec4 glass = color;
      // A short trail back along the flow.
      vec2 trail = normalize(wake.xy + 1e-5) * ${TRAIL_PX.toFixed(1)} * wake.z / uSize;
      glass = (glass + texture2D(uScene, uv - trail * 0.5) + texture2D(uScene, uv - trail)) / 3.0;

      // Bloom: a soft disc of the image around here, laid over it.
      vec4 bloom = vec4(0.0);
      for (int i = 0; i < ${BLOOM_TAPS}; i++) {
        float angle = float(i) / float(${BLOOM_TAPS}) * 6.2832;
        bloom += texture2D(uScene, uv + vec2(cos(angle), sin(angle)) * ${(BLOOM_PX / 2).toFixed(1)} / uSize);
      }
      bloom /= float(${BLOOM_TAPS});
      glass.rgb += bloom.rgb * ${BLOOM_STRENGTH.toFixed(2)} * wake.z;

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
      glass.rgb += light * ${GLINT_STRENGTH.toFixed(2)} * length(slope) * 4.0 * glass.a;
      glass.rgb = min(glass.rgb, vec3(glass.a));
      color = mix(color, glass, polaroid);
    }

    // Colours lifted where the water moves, and light on the swells'
    // crests off the polaroids — on colour over alpha.
    float water = clamp(max(wake.z, swell), 0.0, 1.0);
    if (color.a > 0.001 && water > 0.002) {
      vec3 straight = min(color.rgb / color.a, vec3(1.0));
      straight = pow(straight, vec3(mix(1.0, ${BLOOM_GAMMA.toFixed(2)}, water)));
      straight += swell * (1.0 - polaroid) * ${RING_GLINT.toFixed(3)};
      color.rgb = min(straight, vec3(1.0)) * color.a;
    }

    // The swells on the page, only where the scene leaves it showing,
    // with a little grain.
    float behind = (1.0 - color.a) * swell;
    if (behind > 0.0005) {
      float grain = (hash(gl_FragCoord.xy) - 0.5) * ${RING_NOISE.toFixed(3)} * smoothstep(0.0, 0.15, behind);
      float amount = max(0.0, behind * mix(${RING_SHADE.toFixed(3)}, ${RING_LIGHT.toFixed(3)}, uDark) + grain);
      // Premultiplied: light adds white, shade adds black.
      color.rgb += vec3(amount * uDark);
      color.a += amount;
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
        uTrail: { value: trailTexture },
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
    pass.material.uniforms.uSize.value.set(size.width, size.height)
  }, [gl, size, target, pass, mask])

  useEffect(
    () => () => {
      target.dispose()
      pass.material.dispose()
      mask.target.dispose()
      mask.material.dispose()
    },
    [target, pass, mask]
  )

  // Priority 1: R3F stops rendering on its own, and this renders after
  // every other frame callback.
  useFrame((state) => {
    pass.material.uniforms.uDark.value =
      useStore.getState().colorScheme === 'dark' ? 1 : 0
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
