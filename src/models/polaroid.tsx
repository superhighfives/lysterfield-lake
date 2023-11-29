import { useGLTF } from '@react-three/drei'
import { Euler, ThreeElements, Vector3 } from '@react-three/fiber'
import { forwardRef, JSX, RefObject } from 'react'
import { GLTF } from 'three-stdlib'
import { Group, Mesh } from 'three'
import { animated } from '@react-spring/three'

type GLTFResult = GLTF & {
  nodes: {
    Object_3: THREE.Mesh
    Object_3001: THREE.Mesh
    Object_4: THREE.Mesh
    Object_5: THREE.Mesh
  }
  materials: {
    Frameblinn2SG: THREE.MeshStandardMaterial
    ['Material.001']: THREE.MeshStandardMaterial
    Framelambert79SG: THREE.MeshStandardMaterial
    initialShadingGroup: THREE.MeshStandardMaterial
  }
}

const Polaroid = forwardRef<
  Group,
  ThreeElements['group'] & {
    passthroughMaterial: JSX.Element
    intersectRef?: RefObject<Mesh>
  }
>((props, ref) => {
  const { nodes, materials } = useGLTF('/models/polaroid.glb') as GLTFResult
  const rotation = [0, 0, 0]
  const position = [0, 0, 0]
  const scale = [1.0, 1.0, 1.0]

  materials['Material.001'].transparent = true

  return (
    <animated.group ref={ref} {...props} dispose={null}>
      {/* Overlay */}
      <mesh
        castShadow
        receiveShadow
        geometry={nodes.Object_3001.geometry}
        material={materials['Material.001']}
        position={[0, 0, 0.001]}
      />

      {/* Inside */}
      <mesh
        ref={props.intersectRef}
        castShadow
        receiveShadow
        geometry={nodes.Object_3.geometry}
        rotation={rotation as Euler}
        position={position as Vector3}
        scale={scale as Vector3}
      >
        {props.passthroughMaterial}
      </mesh>
      {/* Back */}
      <mesh
        castShadow
        receiveShadow
        geometry={nodes.Object_4.geometry}
        material={materials.Framelambert79SG}
        rotation={rotation as Euler}
        position={position as Vector3}
        scale={scale as Vector3}
      />
      {/* Front */}
      <mesh
        castShadow
        receiveShadow
        geometry={nodes.Object_5.geometry}
        material={materials.initialShadingGroup}
        rotation={rotation as Euler}
        position={position as Vector3}
        scale={scale as Vector3}
      />
    </animated.group>
  )
})

Polaroid.displayName = 'Polaroid'

export default Polaroid

useGLTF.preload('/models/polaroid.glb')
