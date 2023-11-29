/* eslint-disable */
// @ts-nocheck

type Frame = {
  timestamp: number
} & Record<string, number>

export default (frames: Frame[]) => {
  const first_keys = new Map<string, number>()
  for (const frame of frames) {
    const { timestamp, ...rest } = frame
    for (const [k, v] of Object.entries(rest)) {
      if (!first_keys.has(k)) {
        first_keys.set(k, v)
      }
    }
  }

  const full_keys: Frame[] = []
  frames.forEach((frame, i) => {
    if (i === 0) {
      full_keys.push({
        ...Object.fromEntries(first_keys.entries()),
        ...frame,
      })
    } else {
      full_keys.push({
        ...full_keys[i - 1],
        ...frame,
      })
    }
  })

  return (t: number) => {
    let before: Frame
    let after: Frame
    for (const frame of full_keys) {
      if (frame.timestamp >= t) {
        after = frame
        break
      } else {
        before = frame
      }
    }

    // [before,after] should be [null, x], [x,y], or [y, null]

    if (!before) {
      const { timestamp, ...rest } = after
      return rest
    } else if (!after) {
      const { timestamp, ...rest } = before
      return rest
    } else {
      const { timestamp: a, ...pre } = before
      const { timestamp: b, ...post } = after
      const lerp = (t - a) / (b - a)
      return Object.fromEntries(
        Object.keys(pre).map((k) => [k, pre[k] + (post[k] - pre[k]) * lerp])
      )
    }
  }
}
