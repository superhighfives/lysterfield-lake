// Numbers for debug mode (components/debug-overlay.tsx), filled in each
// frame by components/debug-probe.tsx inside the canvas. Mutated in place,
// never through React.

/** How many frames the frame-time graph keeps. */
export const HISTORY = 240

export const debugStats = {
  /** Frame times in ms, oldest first, HISTORY long. */
  frames: new Float32Array(HISTORY),
  /** Where the next frame time goes (frames is a ring buffer). */
  cursor: 0,
  /** From three.js, summed over every render call in the last frame. */
  calls: 0,
  triangles: 0,
  lines: 0,
  points: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  /** Objects in the scene graph, counted every so often. */
  objects: 0,
  /** The canvas's drawing buffer size and pixel ratio. */
  width: 0,
  height: 0,
  dpr: 1,
  /** The GPU, if the browser says. */
  gpu: '',
}

export function pushFrame(ms: number) {
  debugStats.frames[debugStats.cursor] = ms
  debugStats.cursor = (debugStats.cursor + 1) % HISTORY
}
