import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { debugStats, pushFrame } from '../utils/debug-stats'

// Inside the canvas while debug mode's on: records each frame's time and
// three.js's renderer stats for the overlay (components/debug-overlay.tsx).
//
// The renderer's stats normally reset at the start of every render call,
// and a frame here can have two (the scene into the wake pass's target,
// then the pass to the screen), so the probe turns that off and reads and
// resets them itself, once a frame. It runs first in the frame (priority
// -2: something else at -1 draws a small render of its own early on, which
// a probe at 0 saw as the whole frame), so what it reads is all of the
// frame before. A negative priority doesn't take over rendering, so the
// wake pass can still be switched off.

// How often (frames) the scene graph's objects are counted.
const COUNT_EVERY = 30

function DebugProbe() {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const frame = useRef(0)

  useEffect(() => {
    gl.info.autoReset = false
    const context = gl.getContext()
    const info = context.getExtension('WEBGL_debug_renderer_info')
    debugStats.gpu = info
      ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : ''
    return () => {
      gl.info.autoReset = true
    }
  }, [gl])

  useFrame((state, delta) => {
    pushFrame(delta * 1000)
    const { render, memory, programs } = gl.info
    debugStats.calls = render.calls
    debugStats.triangles = render.triangles
    debugStats.lines = render.lines
    debugStats.points = render.points
    debugStats.geometries = memory.geometries
    debugStats.textures = memory.textures
    debugStats.programs = programs?.length ?? 0
    gl.info.reset()

    const buffer = gl.domElement
    debugStats.width = buffer.width
    debugStats.height = buffer.height
    debugStats.dpr = state.viewport.dpr

    if (frame.current++ % COUNT_EVERY === 0) {
      let objects = 0
      scene.traverse(() => objects++)
      debugStats.objects = objects
    }
  }, -2)

  return null
}

export default DebugProbe
