import { shaderMaterial } from '@react-three/drei'
import { extend, ThreeElement } from '@react-three/fiber'
import { ShaderMaterial, Texture, Vector2 } from 'three'

// A visitor's looping polaroid (plans/backlog/user-polaroid-loops.md), drawn from the pipeline's 5-panel
// polaroid atlas (apps/pipeline/src/steps/polaroid.ts), not the music video's 7-panel one, which
// video-material.tsx reads. Panel order is fixed by POLAROID_PANELS there.
export const POLAROID_PANEL = { portrait: 1, background: 2, matte: 3, depth: 4, outline: 5 } as const
const PANEL_TOTAL = 5

const uniforms = {
  uTexture: new Texture(),
  // 0 draws the background into the photo window; 1 draws the person, cut out by the matte and pushed
  // forward by the depth panel, as a separate plane in front of it.
  uLayer: 0,
  // Pointer/tilt parallax for the background, in panel UV.
  uParallax: new Vector2(0, 0),
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

  // Both layers show the panels' middle 84%: the background needs the margin for its parallax, and the person
  // has to line up with it.
  vec2 inset(vec2 uv) {
    return uv * 0.84 + 0.08;
  }

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
      float relief = 0.0;
      if (uLayer == 1.0 && uDepthStrength != 0.0) {
        // As video-material.tsx: the coarse depth blurred into rounded forms, rolled off at the matte's edge.
        float shape = blurPanel(${POLAROID_PANEL.depth.toFixed(1)}, inset(uv), uShapeRadius);
        float inside = clamp((blurPanel(${POLAROID_PANEL.matte.toFixed(1)}, inset(uv), uEdgeRadius) - 0.5) * 2.0, 0.0, 1.0);
        relief = shape * smoothstep(0.0, 1.0, inside) * uDepthStrength;
      }
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, position.z + relief, 1.0);
    }
  `,
  /* glsl */ `
    varying vec2 vUv;
    uniform float uLayer;
    uniform vec2 uParallax;
    uniform float uOutline;
    ${shared}

    void main() {
      if (uLayer == 0.0) {
        vec2 uv = inset(vUv) + clamp(uParallax, -0.08, 0.08);
        gl_FragColor = vec4(panel(${POLAROID_PANEL.background.toFixed(1)}, uv).rgb, 1.0);
        return;
      }
      vec2 uv = inset(vUv);
      vec3 portrait = panel(${POLAROID_PANEL.portrait.toFixed(1)}, uv).rgb;
      float ink = dot(panel(${POLAROID_PANEL.outline.toFixed(1)}, uv).rgb, vec3(0.299, 0.587, 0.114));
      vec3 color = portrait * mix(1.0, ink, uOutline);
      float matte = smoothstep(0.35, 0.65, panel(${POLAROID_PANEL.matte.toFixed(1)}, uv).r);
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
