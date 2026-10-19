import { shaderMaterial } from '@react-three/drei'
import { extend, ThreeElement } from '@react-three/fiber'
import { ShaderMaterial, Texture } from 'three'

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
  // 0 draws the background (the back of the box); 1 draws the person, cut out by the matte and pushed
  // forward by the depth panel; 2 draws the box's walls, the background's edges stretched back around them.
  uLayer: 0,
  // Depth relief, as video-material.tsx's avatar: world units at full depth, and the panel-UV radii the
  // depth is blurred over and the matte's edge rolls off across.
  uDepthStrength: 0,
  uShapeRadius: 0.12,
  uEdgeRadius: 0.04,
  // How much the outline panel inks over the portrait (0 = none).
  uOutline: 0,
}

const shared = /* glsl */ `
  uniform sampler2D uTexture;

  // One panel of the atlas, clamped a texel in so a lookup never bleeds into the panel beside it.
  vec4 panel(float index, vec2 uv) {
    float x = clamp(uv.x, 1.0 / 768.0, 1.0 - 1.0 / 768.0);
    return texture2D(uTexture, vec2((x + index - 1.0) / ${PANEL_TOTAL.toFixed(1)}, clamp(uv.y, 0.0, 1.0)));
  }
`

export const PolaroidLoopMaterial = shaderMaterial(
  uniforms,
  /* glsl */ `
    varying vec2 vUv;
    varying float vShade;
    attribute float shade;
    uniform float uLayer;
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
      vUv = uv;
      vShade = uLayer == 2.0 ? shade : 1.0;
      float relief = 0.0;
      if (uLayer == 1.0 && uDepthStrength != 0.0) {
        // As video-material.tsx: the coarse depth blurred into rounded forms, rolled off at the matte's edge.
        float shape = blurPanel(${POLAROID_PANEL.depth.toFixed(1)}, uv, uShapeRadius);
        float inside = clamp((blurPanel(${POLAROID_PANEL.matte.toFixed(1)}, uv, uEdgeRadius) - 0.5) * 2.0, 0.0, 1.0);
        relief = shape * smoothstep(0.0, 1.0, inside) * uDepthStrength;
      }
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, position.z + relief, 1.0);
    }
  `,
  /* glsl */ `
    varying vec2 vUv;
    varying float vShade;
    uniform float uLayer;
    uniform float uOutline;
    ${shared}

    void main() {
      if (uLayer == 2.0) {
        // A wall carries the background's edge where it meets the back, stretched toward the window: samples
        // just inside that edge, averaged, so it reads as the picture wrapping round. Darker toward the back,
        // as the inside of a box is.
        // Averaged along the edge too, so each pixel of it doesn't become its own hard streak.
        vec2 inward = (0.5 - vUv) * 0.06;
        vec3 color = vec3(0.0);
        for (int i = 0; i < 4; i++) {
          for (int j = -2; j <= 2; j++) {
            for (int k = -2; k <= 2; k++) {
              color += panel(${POLAROID_PANEL.background.toFixed(1)}, vUv + inward * float(i) / 3.0 + vec2(float(j), float(k)) * 0.008).rgb;
            }
          }
        }
        gl_FragColor = vec4(color / 100.0 * vShade, 1.0);
        return;
      }
      if (uLayer == 0.0) {
        // The back of the box: darker toward its edges, meeting the walls at their own shade (WALL_SHADE.back).
        vec3 color = panel(${POLAROID_PANEL.background.toFixed(1)}, vUv).rgb;
        vec2 edge = smoothstep(vec2(0.0), vec2(0.18), vUv) * smoothstep(vec2(0.0), vec2(0.18), 1.0 - vUv);
        gl_FragColor = vec4(color * mix(0.6, 1.0, edge.x * edge.y), 1.0);
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
