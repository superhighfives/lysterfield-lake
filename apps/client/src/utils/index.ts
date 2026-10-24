import { DeviceOrientationControlsProps } from '@react-three/drei'
import {
  Euler,
  Event as ThreeEvent,
  Quaternion,
  Vector3,
  MathUtils,
} from 'three'

export const isVideoPlaying = (video: HTMLVideoElement) =>
  !!(
    video.currentTime > 0 &&
    !video.paused &&
    !video.ended &&
    video.readyState > 2
  )

export function Quat2Angle(x: number, y: number, z: number, w: number) {
  let pitch, roll, yaw

  const test = x * y + z * w
  // singularity at north pole
  if (test > 0.499) {
    yaw = Math.atan2(x, w) * 2
    pitch = Math.PI / 2
    roll = 0

    return new Vector3(pitch, roll, yaw)
  }

  // singularity at south pole
  if (test < -0.499) {
    yaw = -2 * Math.atan2(x, w)
    pitch = -Math.PI / 2
    roll = 0
    return new Vector3(pitch, roll, yaw)
  }

  const sqx = x * x
  const sqy = y * y
  const sqz = z * z

  yaw = Math.atan2(2 * y * w - 2 * x * z, 1 - 2 * sqy - 2 * sqz)
  pitch = Math.asin(2 * test)
  roll = Math.atan2(2 * x * w - 2 * y * z, 1 - 2 * sqx - 2 * sqz)

  return new Vector3(pitch, roll, yaw)
}

export const setObjectQuaternion = (() => {
  const zee = new Vector3(0, 0, 1)
  const euler = new Euler()
  const q0 = new Quaternion()
  const q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))

  return function (
    quaternion: Quaternion,
    alpha: number,
    beta: number,
    gamma: number,
    orient: number
  ) {
    // 'ZXY' for the device, but 'YXZ' for us
    euler.set(beta, alpha, -gamma, 'YXZ')

    // Orient the device
    quaternion.setFromEuler(euler)

    // camera looks out the back of the device, not the top
    quaternion.multiply(q1)

    // adjust for screen orientation
    quaternion.multiply(q0.setFromAxisAngle(zee, -orient))
  }
})()

export const getRotation = (
  e?: ThreeEvent,
  initialRotation?: [number, number, number]
) => {
  if (!e) return
  if (!initialRotation) return

  const controls = e.target! as unknown as DeviceOrientationControlsProps

  const alpha = controls.deviceOrientation?.alpha
    ? MathUtils.degToRad(controls.deviceOrientation?.alpha % 360)
    : 0

  const beta = controls.deviceOrientation?.beta
    ? MathUtils.degToRad(((controls.deviceOrientation?.beta + 180) % 360) - 180)
    : 0

  const gamma = controls.deviceOrientation?.gamma
    ? MathUtils.degToRad(((controls.deviceOrientation?.gamma + 90) % 180) - 90)
    : 0

  const orient = controls.screenOrientation
    ? MathUtils.degToRad(controls.screenOrientation as number)
    : 0

  const currentQ = new Quaternion().copy(controls.object!.quaternion)
  setObjectQuaternion(currentQ, alpha, beta, gamma, orient)
  const currentAngle = Quat2Angle(
    currentQ.x,
    currentQ.y,
    currentQ.z,
    currentQ.w
  )

  return [
    currentAngle.y - initialRotation[0],
    currentAngle.x - initialRotation[1],
    0,
  ]
}
