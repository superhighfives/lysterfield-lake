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

interface DeviceEventWithPermission extends DeviceOrientationEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

export const handleDeviceOrientationPermissions = () => {
  return new Promise((resolve) => {
    const deviceMotionEvent =
      window.DeviceMotionEvent as unknown as DeviceEventWithPermission
    const deviceOrientationEvent =
      window.DeviceOrientationEvent as unknown as DeviceEventWithPermission
    if (
      deviceMotionEvent &&
      deviceMotionEvent.requestPermission &&
      typeof deviceMotionEvent.requestPermission === 'function'
    ) {
      deviceMotionEvent.requestPermission()
    }

    if (
      deviceOrientationEvent &&
      deviceOrientationEvent.requestPermission &&
      typeof deviceOrientationEvent.requestPermission === 'function'
    ) {
      deviceOrientationEvent
        .requestPermission()
        .then((res) => resolve(res === 'granted'))
        // Refused outright (not from a tap, say): no tilt.
        .catch(() => resolve(false))
    } else {
      // No permission to ask for (Android, and others): trust the sensor
      // only once it actually reports. A touchscreen laptop (Surface,
      // Chromebook) has the API and touch but usually no sensor, so it
      // sends nothing or a single all-null reading. On plain HTTP (a phone
      // on the dev server's network address) browsers withhold it, iOS
      // included. Either way the scene falls back to its idle drift.
      if (!deviceOrientationEvent || !window.isSecureContext) {
        resolve(false)
        return
      }

      const settle = (granted: boolean) => {
        window.clearTimeout(timeout)
        window.removeEventListener('deviceorientation', onReading)
        resolve(granted)
      }

      const onReading = (event: DeviceOrientationEvent) =>
        settle(event.beta !== null && event.gamma !== null)
      const timeout = window.setTimeout(() => settle(false), 500)
      window.addEventListener('deviceorientation', onReading)
    }
  })
}

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

export const isTouchDevice = () => {
  let isMobile = false
  if ('maxTouchPoints' in navigator) {
    isMobile = navigator.maxTouchPoints > 0
  } else if ('msMaxTouchPoints' in navigator) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    isMobile = navigator.msMaxTouchPoints > 0
  } else {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const mQ = window.matchMedia && matchMedia('(pointer:coarse)')
    if (mQ && mQ.media === '(pointer:coarse)') {
      isMobile = !!mQ.matches
    } else if ('orientation' in window) {
      isMobile = true // deprecated, but good fallback
    } else {
      // Only as a last resort, fall back to user agent sniffing
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const UA = navigator.userAgent
      isMobile =
        /\b(BlackBerry|webOS|iPhone|IEMobile)\b/i.test(UA) ||
        /\b(Android|Windows Phone|iPad|iPod)\b/i.test(UA)
    }
  }

  return isMobile
}
