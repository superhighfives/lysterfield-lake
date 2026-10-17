import { ShaderChunk, WebGLProgramParametersWithUniforms } from 'three'
import { trailResolution, trailTexture } from '../utils/liquid-trail'

// The cursor's liquid wake (utils/liquid-trail.ts) as shader code, shared
// by everything it moves through: the player's video meshes
// (video-material.tsx), the carousel's cards (polaroid-material.tsx) and
// the choose screen's title (wakeShader below). Each declares the uniforms
// below and calls wakeSlope(), the trail's slope under this pixel; the
// image is offset by it (WAKE_SLOPE UV per unit) and lit along it.

// The slope is measured across WAKE_SPREAD trail texels — wide, so it
// reads as a broad, soft swell rather than a sharp edge — and shifts the
// image by WAKE_SLOPE UV per unit. WAKE_GLINT is the catch of light.
export const WAKE_GLSL = /* glsl */ `
  uniform sampler2D uTrail;
  uniform vec2 uResolution;
  uniform float uTrailAmount;
  const float WAKE_SPREAD = 5.0;
  const float WAKE_SLOPE = 0.045;
  const float WAKE_GLINT = 0.15;

  vec2 wakeSlope() {
    if (uTrailAmount <= 0.0) return vec2(0.0);
    vec2 screen = gl_FragCoord.xy / uResolution;
    vec2 texel = WAKE_SPREAD / vec2(textureSize(uTrail, 0));
    float hx = texture2D(uTrail, screen + vec2(texel.x, 0.0)).r - texture2D(uTrail, screen - vec2(texel.x, 0.0)).r;
    float hy = texture2D(uTrail, screen + vec2(0.0, texel.y)).r - texture2D(uTrail, screen - vec2(0.0, texel.y)).r;
    return vec2(hx, hy) * uTrailAmount;
  }

  // Light catching the wake's slopes, as if from above-left.
  float wakeGlint(vec2 slope) {
    return (slope.x - slope.y) * WAKE_GLINT;
  }
`

/** An onBeforeCompile that gives a stock three.js material (one with a
 *  map, and maybe an alpha map) the wake, by patching where its shader
 *  samples them. */
export function wakeShader(amount: number) {
  return (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uTrail = { value: trailTexture }
    shader.uniforms.uResolution = { value: trailResolution }
    shader.uniforms.uTrailAmount = { value: amount }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WAKE_GLSL}`)
      .replace(
        'void main() {',
        'void main() {\n  vec2 wake = wakeSlope();'
      )
      .replace(
        '#include <map_fragment>',
        ShaderChunk.map_fragment.replace(/vMapUv/g, '(vMapUv + wake * WAKE_SLOPE)') +
          '\n  diffuseColor.rgb += wakeGlint(wake);'
      )
      .replace(
        '#include <alphamap_fragment>',
        ShaderChunk.alphamap_fragment.replace(
          /vAlphaMapUv/g,
          '(vAlphaMapUv + wake * WAKE_SLOPE)'
        )
      )
  }
}
