// Device checks for the start button (routes/root.tsx), kept apart from
// utils/index.ts's orientation maths so the title doesn't load three.js.

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
