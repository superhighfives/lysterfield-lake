import { MathUtils, Object3D } from 'three'
import type { Dream } from '../../utils/types'

// For the choose screen's stack (stack.tsx). Its cards sit apart in depth,
// so plain depth sorting draws them right. Cards that overlap need to sit
// apart by more than the photo's depth bias (polaroid-material.tsx, ~0.02
// here), or a photo shows through the card in front of it.

export type CarouselProps = {
  items: Dream[]
  onSelect: (dream: Dream) => void
}

/** A stable pseudo-random value in [0, 1) for card `i` and stream `k`, so
 *  each layout's jitter is the same on every visit. */
export const seeded = (i: number, k = 0) => {
  const value = Math.sin(i * 127.1 + k * 311.7) * 43758.5453
  return value - Math.floor(value)
}

export type Pose = {
  x: number
  y: number
  z: number
  rx?: number
  ry?: number
  rz?: number
}

/** Eases an object toward a pose by `ease` per frame. */
export function easeTo(object: Object3D, pose: Pose, ease: number) {
  object.position.x = MathUtils.lerp(object.position.x, pose.x, ease)
  object.position.y = MathUtils.lerp(object.position.y, pose.y, ease)
  object.position.z = MathUtils.lerp(object.position.z, pose.z, ease)
  object.rotation.x = MathUtils.lerp(object.rotation.x, pose.rx ?? 0, ease)
  object.rotation.y = MathUtils.lerp(object.rotation.y, pose.ry ?? 0, ease)
  object.rotation.z = MathUtils.lerp(object.rotation.z, pose.rz ?? 0, ease)
}
