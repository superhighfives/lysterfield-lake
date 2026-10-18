import { shaderMaterial } from '@react-three/drei'
import { extend, ThreeElement } from '@react-three/fiber'
import { ShaderMaterial, Texture, Vector2 } from 'three'

const uniforms = {
  uTexture: new Texture(),
  uSize: new Vector2(),
  uAspect: new Vector2(),
  uHover: 0,
  // 1 = full colour, 0 = grayscale (a stacked card that isn't on top).
  uSaturation: 1,
}

export const PolaroidMaterial = shaderMaterial(
  uniforms,

  /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec2 uSize;
    varying vec2 vVertCoord;
    uniform float uHover;
    
    void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vVertCoord = 0.5 * ((gl_Position.xy * (-gl_Position.x / 2.0) / gl_Position.w) * (gl_Position.x / 2.0)) + vec2(0.5) * (1.0 - uHover * (gl_Position.xy * 0.25));
    }
  `,
  /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec2 uSize;
    uniform vec2 uAspect;
    varying vec2 vVertCoord;
    uniform float uHover;
    uniform float uSaturation;

    void main() {      
      // The photo is inset 10% on each side (vUv * 0.8 + 0.1) to leave room
      // for this screen-position parallax offset. The offset is built from
      // clip-space coordinates (before the perspective divide), so it grows
      // steeply toward the screen's edges — cards far out to the side (more
      // of them since the carousel grew and cards turn toward the cursor)
      // overshot that room and sampled off the image entirely, showing a
      // blank photo. Clamped to the room the inset actually leaves.
      vec2 parallax = clamp(vVertCoord - 0.5, -0.1, 0.1);
      vec2 position = (vUv.xy * 0.8) + 0.1 + parallax;
      vec4 image = texture2D(uTexture, position);
      float luma = dot(image.rgb, vec3(0.299, 0.587, 0.114));
      image.rgb = mix(vec3(luma), image.rgb, uSaturation);
      gl_FragColor = image;

      #include <colorspace_fragment>
    }
  `,
  (material) => {
    if (material) {
      material.transparent = true
      // The photo sits a hair in front of its frame. Face-on that's
      // enough, but on cards turned steeply away (the ends of the fan) the
      // gap collapses in depth and the frame won, hiding the photo — the
      // card read as a blank frame. Biased toward the camera so it doesn't.
      material.polygonOffset = true
      material.polygonOffsetFactor = -4
      material.polygonOffsetUnits = -4
      material.needsUpdate = true
    }
  }
)

export type PolaroidMaterialProps = ShaderMaterial & typeof uniforms

declare module '@react-three/fiber' {
  interface ThreeElements {
    polaroidMaterial: ThreeElement<typeof PolaroidMaterial>
  }
}

extend({ PolaroidMaterial })
