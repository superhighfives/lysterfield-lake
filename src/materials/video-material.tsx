import { shaderMaterial } from '@react-three/drei'
import { extend, MaterialNode } from '@react-three/fiber'
import { ShaderMaterial, Texture, Vector2 } from 'three'

const uniforms = {
  uOpacity: 0,
  uTexture: new Texture(),
  uFrameSelected: 0,
  uFrameMask: 0,
  uFrameTotal: 0,
  uMaskIntensity: 0,
  uInversion: 0,
  uInvert: 0,
  uFrameDepth: 0,
  uFrameOverlay: 0,
  uPointerPos: new Vector2(0, 0),
  uPointerRelative: new Vector2(0, 0),
  uTime: 0,
  uAvatar: 0,
  uFrameSketch: 0,
  uIdle: 0,
}

export const VideoMaterial = shaderMaterial(
  uniforms,

  /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float uFrameSelected;
    uniform float uFrameDepth;
    uniform float uFrameTotal;
    uniform float uOpacity;
    uniform float uFrameOverlay;
    uniform vec2 uPointerPos;
    uniform vec2 uPointerRelative;
    varying vec2 texCoord;
    uniform float uTime;
    
    void main(){
        vUv = uv;
        float intensity = 0.0;

        float fadeAmount = clamp((uTime / 4.0) - 1.25, 0.0, 1.0);

        if(uFrameDepth != 0.0) {
          vec4 mask = texture2D(uTexture, vec2((vUv.x + (uFrameDepth - 1.0)) / uFrameTotal, vUv.y));
          float depth = ((mask.r + (vUv.y * 2.0)) / 8.0) * fadeAmount;
          intensity = (0.75 * depth + 0.05);
        }

        vec3 newPosition = vec3(position.x, position.y, position.z + intensity);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
    }
  `,
  /* glsl */ `
    varying vec2 vUv;
    varying vec2 texCoord;
    uniform sampler2D uTexture;
    uniform float uOpacity;
    uniform float uFrameSelected;
    uniform float uFrameTotal;
    uniform float uFrameMask;
    uniform float uFrameSketch;
    uniform float uMaskIntensity;
    uniform float uInvert;
    uniform float uFrameOverlay;
    uniform vec2 uPointerPos;
    uniform vec2 uPointerRelative;
    uniform float uTime;
    uniform float uAvatar;
    uniform float uIdle;

    vec3 blendMultiply(vec3 base, vec3 blend) {
      return base*blend;
    }
    
    vec3 blendMultiply(vec3 base, vec3 blend, float opacity) {
      return (blendMultiply(base, blend) * opacity + base * (1.0 - opacity));
    }

    const int dither_matrix_2x2[4] = int[](
        0,  3,  
        2,  1
    );

    const int dither_matrix_8x8[64] = int[](
      24, 10, 12, 26, 35, 47, 49, 37,
      8,  0,  2,  14, 45, 59, 61, 51,
      22, 6,  4,  16, 43, 57, 63, 53,
      30, 20, 18, 28, 33, 41, 55, 39,
      34, 46, 48, 36, 25, 11, 13, 27,
      44, 58, 60, 50, 9,  1,  3,  15,
      42, 56, 62, 52, 23, 7,  5,  17,
      32, 40, 54, 38, 31, 21, 19, 29
    );

    float dither2x2(vec2 uv, float luma) {
      float dither_amount = 2.0;
      int x = int(mod(uv.x, dither_amount));
      int y = int(mod(uv.y, dither_amount));
      int index = x + y * int(dither_amount);
      float limit = (float(dither_matrix_2x2[index]) + 1.0) / (1.0 + 4.0);
      return luma < limit ? 0.0 : 1.0;
    }

    float dither8x8(vec2 uv, float luma) {
      float dither_amount = 8.0;
      int x = int(mod(uv.x, dither_amount));
      int y = int(mod(uv.y, dither_amount));
      int index = x + y * int(dither_amount);
      float limit = (float(dither_matrix_8x8[index]) + 1.0) / (1.0 + 64.0);
      return luma < limit ? 0.0 : 1.0;
    }

    void main() {      
      float offsetX = 0.0;
      float offsetY = 0.0;
      if(uFrameSelected == 7.0) {
        offsetX = -uPointerRelative.x / 40.0;
        offsetY = -uPointerRelative.y / 40.0;
      }
      
      vec4 image = texture2D(uTexture, vec2((vUv.x - offsetX + (uFrameSelected - 1.0)) / uFrameTotal, uInvert == 1.0 ? 1.0 - vUv.y : vUv.y - offsetY));
      vec4 mask = texture2D(uTexture, vec2((vUv.x - offsetX + (uFrameMask - 1.0)) / uFrameTotal, vUv.y - offsetY));

      float mixValue = uMaskIntensity;
      float shortenedFadeAmount = 1.0 - clamp((uTime / 4.0) - 0.75, 0.0, 1.0);
      float fadeAmount = 1.0 - clamp((uTime / 4.0) - 1.0, 0.0, 1.0);
      float extendedFadeAmount = 1.0 - clamp((uTime / 4.0), 0.25, 1.0);

      vec3 colorA = vec3(0.912, 0.921, 0.929);
      vec3 colorB = vec3(0.95, 0.95, 0.92);
      vec3 color = mix(colorA, colorB, vUv.y);
      vec4 white = vec4(vec3(color), 1.0);

      if(uFrameOverlay != 0.0) {
        fadeAmount = extendedFadeAmount;

        vec4 overlay = texture2D(uTexture, vec2((vUv.x - offsetX + (uFrameOverlay - 1.0)) / uFrameTotal, vUv.y - offsetY));

        float minRadius = 0.15;
        float maxRadius = 0.5;
        float dist = distance(clamp(uPointerRelative / 2.0, 0.15, 0.85), vUv.xy);
        float range = maxRadius - minRadius;
        float mixAmount = clamp((dist - minRadius) / range, 0.0, 1.0);
        
        float gray = dot(overlay.rgb, vec3(0.299, 0.587, 0.114));
        overlay = vec4(mix(vec3(gray), overlay.rgb, 0.0), overlay.a);

        image = mix(image, overlay, mixAmount);
        image = mix(image, overlay, fadeAmount);
        image = mix(image, white, 1.0 - clamp(uTime - 1.0, 0.0, 1.0));
      }

      float opacityOverride = 0.0;

      if(uAvatar == 1.0) {
        fadeAmount = extendedFadeAmount;

        vec4 sketch = texture2D(uTexture, vec2((vUv.x - offsetX + (uFrameSketch - 1.0)) / uFrameTotal, vUv.y - offsetY));

        vec4 luma = vec4(0.299, 0.587, 0.114, 0.0);
        float grayscale = dot(sketch, luma);
        
        vec4 outColor = vec4(vec3(dither2x2(gl_FragCoord.xy, grayscale)), 1.0);

        image = vec4(blendMultiply(vec3(image), vec3(outColor), 0.3), 1.0);

        float minRadius = 0.15;
        float maxRadius = 0.30;
        float dist = distance(uPointerRelative / 2.0, vec2(0.5, 0.6));
        float range = maxRadius - minRadius;
        float mixAmount = clamp((dist - minRadius) / range, 0.15, 1.0);
        float fadeIn = clamp(uTime / 4.0 - 1.5, 0.0, 1.0);
        float radial = clamp((0.5 - vUv.y) * 1.0 - mixAmount, 0.0, 1.0);

        opacityOverride = ((1.0 - (mixAmount - radial + (mask.r * uIdle))) * fadeIn);
      }

      image = mix(image, white, fadeAmount);

      //Calculate edge curvature
      vec2 curve = pow(abs(vUv * 2.0 - 1.0), vec2(1.0 / 0.005));
      //Compute distance to edge
      float edge = pow(length(curve), 1.0);
      //Compute vignette gradient and intensity
      float vignette = 1.0 - 1.0 * smoothstep(0.0,0.05,edge);

      float maskIncrease = 0.0;

      if(uFrameMask == 1.0) {
        maskIncrease = 0.1;
      }

      gl_FragColor = vec4(vec3(image), uOpacity - mixValue * (1.0 - mask.r + maskIncrease + opacityOverride));

      //Add vignette to the resulting texture
      gl_FragColor.a *= vignette;
    }
  `,
  (material) => {
    if (material) {
      material.transparent = true
      material.needsUpdate = true
    }
  }
)

export type VideoMaterialProps = ShaderMaterial & typeof uniforms

declare module '@react-three/fiber' {
  interface ThreeElements {
    videoMaterial: MaterialNode<VideoMaterialProps, typeof VideoMaterial>
  }
}

extend({ VideoMaterial })
