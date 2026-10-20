import {
  CustomBlending,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
  SrcAlphaFactor,
  Texture,
  Vector2,
} from 'three'

// A dream behind everything, like a cinema screen: an image filling the
// whole screen, fixed there whatever the camera does. Behind the player
// (components/dream-glow.tsx, the composite video's dream panel) and the
// choose screen's stack (components/carousels/stack.tsx, the top card's
// still).
//
// The image's square fills the screen's short side, true to shape across
// its middle (LENS_CORE either side of centre, in short-side units), then
// stretched progressively harder toward the long side's edges to fill it —
// a wide, horizontal fisheye (vertical on a portrait screen) — and fades
// out as a broad vignette: a rounded (superellipse, FADE_ROUNDNESS) falloff
// from FADE_START of the way out to nothing at the screen's edges. A narrow
// band at the edges, as it was, left the image bright almost to the rim,
// where it read as a hard rounded frame. Colour near the pointer,
// grey beyond: GREY_NEAR to GREY_FAR from it (short-side units). Its
// strength per scheme — light in dark mode, so it lights the dark page
// (premultiplied: the light as colour, its brightest channel as alpha,
// which composites over the page as a screen blend; plain additive
// blending left colour in pixels with no alpha, which the browser drops
// from a premultiplied canvas, so the faint fade-out vanished and the
// screen began at a hard edge); a plain wash in light mode, where adding
// would just clip to white — and
// in light mode it's lifted LIGHT_LIFT toward white first, so the wash
// stays light rather than greying the page.
const LENS_CORE = 0.3
const GREY_NEAR = 0.2
const GREY_FAR = 0.65
const FADE_START = 0.4
const FADE_ROUNDNESS = 2.5
export const SCREEN_OPACITY = { light: 0.3, dark: 0.4 }
const LIGHT_LIFT = { light: 0.45, dark: 0 }

// Straight to clip space: the quad covers the screen wherever its mesh is.
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
  }
`

// The image (or one panel of a side-by-side atlas) through the lens.
const fragmentShader = (panels: number, panel: number) => /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uOpacity;
  uniform float uAspect;
  uniform float uLift;
  uniform float uScreenBlend;
  uniform vec2 uPointerRelative;
  // 1 = colour (near the pointer), 0 = grey everywhere.
  uniform float uSaturation;

  vec3 panelAt(vec2 uv) {
    float x = clamp(uv.x, 1.0 / 512.0, 1.0 - 1.0 / 512.0);
    return texture2D(uTexture, vec2((x + ${(panel - 1).toFixed(1)}) / ${panels.toFixed(1)}, clamp(uv.y, 0.0, 1.0))).rgb;
  }

  // x: short-side units from the centre, out to halfExtent at the screen's
  // edge. Returns the image's own coordinate, -0.5 to 0.5: true to shape
  // within the core, and beyond it easing out — ever more stretched — to
  // reach the image's edge exactly at the screen's.
  float lens(float x, float halfExtent) {
    float a = abs(x);
    float core = min(${LENS_CORE.toFixed(2)}, halfExtent);
    if (a <= core) return x;
    float span = halfExtent - core;
    float room = 0.5 - core;
    float r = clamp((a - core) / span, 0.0, 1.0);
    float q = max(span / room, 1.0);
    return sign(x) * (core + room * (1.0 - pow(1.0 - r, q)));
  }

  void main() {
    vec2 extent = vec2(max(uAspect, 1.0), max(1.0 / uAspect, 1.0));
    vec2 p = (vUv - 0.5) * extent;
    vec2 imageUv = 0.5 + vec2(lens(p.x, extent.x * 0.5), lens(p.y, extent.y * 0.5));

    vec2 pointer = (uPointerRelative / 2.0 - 0.5) * extent;
    float grey = max(
      smoothstep(${GREY_NEAR.toFixed(2)}, ${GREY_FAR.toFixed(2)}, distance(p, pointer)),
      1.0 - uSaturation
    );
    vec3 image = panelAt(imageUv);
    vec3 color = mix(image, vec3(dot(image, vec3(0.299, 0.587, 0.114))), grey);
    color = mix(color, vec3(1.0), uLift);
    // The vignette: 0 at the centre, 1 at each edge's midpoint (beyond it
    // in the corners).
    vec2 reach = abs(p) / (extent * 0.5);
    float out_ = pow(
      pow(reach.x, ${FADE_ROUNDNESS.toFixed(1)}) + pow(reach.y, ${FADE_ROUNDNESS.toFixed(1)}),
      ${(1 / FADE_ROUNDNESS).toFixed(3)}
    );
    float fade = 1.0 - smoothstep(${FADE_START.toFixed(2)}, 1.0, out_);
    float alpha = uOpacity * fade;
    if (uScreenBlend > 0.5) {
      vec3 light = color * alpha;
      gl_FragColor = vec4(light, max(light.r, max(light.g, light.b)));
    } else {
      gl_FragColor = vec4(color, alpha);
    }
  }
`

/** A screen for this texture — or, of a side-by-side atlas of `panels`,
 *  its `panel`th (1-based). Drawn before everything else, in screen
 *  space: never culled, never in the pointer's way. Later screens (higher
 *  `order`) draw over earlier ones. Set up for `scheme` from the start
 *  (setScreenScheme changes it later): until it is, it's drawn with no
 *  blending at all, and its first frame wrote colour with no alpha, which
 *  the premultiplied canvas showed as a flash of white. */
export function createDreamScreen(
  texture: Texture | null,
  {
    panels = 1,
    panel = 1,
    order = 0,
    scheme = 'dark' as 'light' | 'dark',
  } = {}
) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader: fragmentShader(panels, panel),
    uniforms: {
      uTexture: { value: texture },
      uOpacity: { value: 0 },
      uAspect: { value: 1 },
      uLift: { value: 0 },
      uScreenBlend: { value: 0 },
      uPointerRelative: { value: new Vector2(1, 1) },
      uSaturation: { value: 1 },
    },
    // Not in the transparent pass, so with the lowest renderOrder it draws
    // first, behind everything, blending onto the clear page.
    transparent: false,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new Mesh(new PlaneGeometry(), material)
  mesh.renderOrder = -1000 + order
  mesh.frustumCulled = false
  mesh.raycast = () => {}

  setScreenScheme(material, scheme)

  return { mesh, material }
}

/** Blending and lift for a colour scheme. */
export function setScreenScheme(
  material: ShaderMaterial,
  scheme: 'light' | 'dark'
) {
  // Blending spelled out (three.js skips NormalBlending on a material
  // outside the transparent pass): dark mode's light is already
  // premultiplied (see the shader), light mode's wash isn't.
  const dark = scheme === 'dark'
  material.blending = CustomBlending
  material.blendSrc = dark ? OneFactor : SrcAlphaFactor
  material.blendDst = OneMinusSrcAlphaFactor
  material.blendSrcAlpha = OneFactor
  material.blendDstAlpha = OneMinusSrcAlphaFactor
  material.uniforms.uScreenBlend.value = dark ? 1 : 0
  material.uniforms.uLift.value = LIGHT_LIFT[scheme]
  material.needsUpdate = true
}
