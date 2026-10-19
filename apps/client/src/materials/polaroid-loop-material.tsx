import { shaderMaterial } from '@react-three/drei'
import { extend, ThreeElement } from '@react-three/fiber'
import { ShaderMaterial, Texture, Vector2 } from 'three'

// A visitor's looping polaroid (plans/in-progress/polaroid-admin-flow.md), drawn from the pipeline's 5-panel
// polaroid atlas (apps/pipeline/src/steps/polaroid.ts), not the music video's 7-panel one, which
// video-material.tsx reads. Panel order is fixed by POLAROID_PANELS there.
//
// The photo is a window into a shallow box (see admin-polaroid.tsx): the background is a plane set back
// behind the card, the person a plane between it and the window, both seen only through the window
// (stencil), so turning the card shows real parallax and nothing overhangs the frame.
export const POLAROID_PANEL = { portrait: 1, background: 2, matte: 3, depth: 4, outline: 5 } as const
const PANEL_TOTAL = 5

const uniforms = {
  uTexture: new Texture(),
  // 1 draws the person, cut out by the matte and pushed forward by the depth panel; 2 draws the background
  // on the inside of a bowl behind the window (see the fragment shader).
  uLayer: 0,
  // Depth relief, as video-material.tsx's avatar: world units at full depth, and the panel-UV radii the
  // depth is blurred over and the matte's edge rolls off across.
  uDepthStrength: 0,
  uShapeRadius: 0.12,
  uEdgeRadius: 0.04,
  // How much the outline panel inks over the portrait (0 = none).
  uOutline: 0,
  // For the person: how many window-widths their plane spans (it reaches past the window to the bowl).
  uUvScale: 1,
  // The bowl: half the window's size, the camera's distance (to see the bowl as it's seen face-on), and how
  // much of the background, from each edge, is kept for the part of the bowl outside the window.
  uHalf: new Vector2(1, 1),
  uCameraDistance: 12,
  uBand: 0.12,
}

const shared = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uBand;

  // One panel of the atlas, clamped a texel in so a lookup never bleeds into the panel beside it.
  vec4 panel(float index, vec2 uv) {
    float x = clamp(uv.x, 1.0 / 768.0, 1.0 - 1.0 / 768.0);
    return texture2D(uTexture, vec2((x + index - 1.0) / ${PANEL_TOTAL.toFixed(1)}, clamp(uv.y, 0.0, 1.0)));
  }

  // Where along one axis of the panels a point takes its colour from (the bowl's background, and the person's
  // edges). t is how far out it is
  // as seen face-on, 1 being the window's edge. Inside the window, the background's middle, undistorted;
  // past it, the outer band, easing out toward the panel's edge so the stretch grows smoothly. The two
  // parts meet with the same slope, so there's no crease where the window's edge falls.
  float bowlUv(float t) {
    float a = abs(t);
    float inner = 1.0 - 2.0 * uBand;
    float g = a <= 1.0 ? a * inner : inner + 2.0 * uBand * (1.0 - exp(-(a - 1.0) * inner / (2.0 * uBand)));
    return 0.5 + 0.5 * sign(t) * g;
  }
`

export const PolaroidLoopMaterial = shaderMaterial(
  uniforms,
  /* glsl */ `
    varying vec2 vUv;
    varying vec3 vPosition;
    uniform float uLayer;
    uniform float uUvScale;
    uniform float uDepthStrength;
    uniform float uShapeRadius;
    uniform float uEdgeRadius;
    ${shared}

    float blurPanel(float index, vec2 uv, float radius) {
      float sum = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          sum += panel(index, uv + vec2(float(x), float(y)) * (radius / 2.0)).r;
        }
      }
      return sum / 25.0;
    }

    void main() {
      // uUvScale is how many window-widths the mesh spans; the person's plane reaches past the window, and past
      // its edge their outer band is revealed and eased out, as the bowl does with the background.
      vec2 seen = (uv - 0.5) * 2.0 * uUvScale;
      vUv = uLayer == 1.0 ? vec2(bowlUv(seen.x), bowlUv(seen.y)) : 0.5 + (uv - 0.5) * uUvScale;
      vPosition = position;
      float relief = 0.0;
      if (uLayer == 1.0 && uDepthStrength != 0.0) {
        // As video-material.tsx: the coarse depth blurred into rounded forms, rolled off at the matte's edge.
        float shape = blurPanel(${POLAROID_PANEL.depth.toFixed(1)}, vUv, uShapeRadius);
        float inside = clamp((blurPanel(${POLAROID_PANEL.matte.toFixed(1)}, vUv, uEdgeRadius) - 0.5) * 2.0, 0.0, 1.0);
        relief = shape * smoothstep(0.0, 1.0, inside) * uDepthStrength;
      }
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, position.z + relief, 1.0);
    }
  `,
  /* glsl */ `
    varying vec2 vUv;
    varying vec3 vPosition;
    uniform float uLayer;
    uniform float uOutline;
    uniform vec2 uHalf;
    uniform float uCameraDistance;

    ${shared}

    void main() {
      if (uLayer == 2.0) {
        // The bowl, seen face-on: perspective draws a point further back closer to the middle.
        vec2 seen = vPosition.xy * uCameraDistance / (uCameraDistance - vPosition.z) / uHalf;
        vec3 color = panel(${POLAROID_PANEL.background.toFixed(1)}, vec2(bowlUv(seen.x), bowlUv(seen.y))).rgb;
        // Darker toward the rim, as the inside of a bowl is.
        float rim = smoothstep(0.7, 1.6, length(seen));
        gl_FragColor = vec4(color * mix(1.0, 0.78, rim), 1.0);
        return;
      }

      vec3 portrait = panel(${POLAROID_PANEL.portrait.toFixed(1)}, vUv).rgb;
      float ink = dot(panel(${POLAROID_PANEL.outline.toFixed(1)}, vUv).rgb, vec3(0.299, 0.587, 0.114));
      vec3 color = portrait * mix(1.0, ink, uOutline);
      float matte = smoothstep(0.35, 0.65, panel(${POLAROID_PANEL.matte.toFixed(1)}, vUv).r);
      if (matte < 0.01) discard;
      gl_FragColor = vec4(color, matte);
    }
  `,
  (material) => {
    if (material) {
      material.transparent = true
      material.needsUpdate = true
    }
  }
)

export type PolaroidLoopMaterialProps = ShaderMaterial & typeof uniforms

declare module '@react-three/fiber' {
  interface ThreeElements {
    polaroidLoopMaterial: ThreeElement<typeof PolaroidLoopMaterial>
  }
}

extend({ PolaroidLoopMaterial })
