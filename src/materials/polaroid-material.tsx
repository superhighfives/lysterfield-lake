import { shaderMaterial } from '@react-three/drei'
import { extend, MaterialNode } from '@react-three/fiber'
import { ShaderMaterial, Texture, Vector2 } from 'three'

const uniforms = {
  uTexture: new Texture(),
  uSize: new Vector2(),
  uAspect: new Vector2(),
  uHover: 0,
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

    void main() {      
      vec2 position = (vUv.xy * 0.8) + 0.1 + (vVertCoord - 0.5);
      vec4 image = texture2D(uTexture, position);
      gl_FragColor = image;

      #include <colorspace_fragment>
    }
  `,
  (material) => {
    if (material) {
      material.transparent = true
      material.needsUpdate = true
    }
  }
)

export type PolaroidMaterialProps = ShaderMaterial & typeof uniforms

declare module '@react-three/fiber' {
  interface ThreeElements {
    polaroidMaterial: MaterialNode<
      PolaroidMaterialProps,
      typeof PolaroidMaterial
    >
  }
}

extend({ PolaroidMaterial })
