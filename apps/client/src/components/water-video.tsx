import { MutableRefObject, useEffect, useRef } from 'react'

// The welcome screen's title loop, drawn through a small WebGL canvas so
// the pointer can disturb it like water: moving over it drops ripples
// where it goes, and `splash()` (the button's hover) drops a bigger one at
// the centre. The canvas takes the same CSS the plain <video> had (blend
// and dark-mode key), so at rest it looks exactly as before.

// Ripples: at most MAX_DROPS rings at once; a new drop every DROP_SPACING
// CSS px of pointer travel. Each ring spreads at SPEED (UV/s) with this
// wavelength (FREQUENCY) and width, displaces by up to AMOUNT (UV), and
// fades out over DROP_SECONDS. A splash is SPLASH_STRENGTH times a drop.
const MAX_DROPS = 12
const DROP_SPACING = 28
const SPEED = 0.35
const FREQUENCY = 60
const WIDTH = 0.06
const AMOUNT = 0.022
const DROP_SECONDS = 2.2
const SPLASH_STRENGTH = 2.5

const vertexSource = /* glsl */ `#version 300 es
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`

const fragmentSource = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
uniform sampler2D uVideo;
// xy = position (UV), z = age (s), w = strength
uniform vec4 uDrops[${MAX_DROPS}];
void main() {
  vec2 offset = vec2(0.0);
  float glint = 0.0;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    vec4 drop = uDrops[i];
    if (drop.w <= 0.0) continue;
    vec2 away = vUv - drop.xy;
    float dist = length(away);
    float front = dist - drop.z * ${SPEED.toFixed(3)};
    float ring = exp(-(front * front) / ${(WIDTH * WIDTH).toFixed(5)});
    float fade = max(0.0, 1.0 - drop.z / ${DROP_SECONDS.toFixed(2)});
    float wave = sin(front * ${FREQUENCY.toFixed(1)}) * ring * fade * fade * drop.w;
    offset += normalize(away + 1e-5) * wave * ${AMOUNT.toFixed(4)};
    glint += wave;
  }
  color = texture(uVideo, vUv + offset);
  // A faint catch of light on the crests.
  color.rgb += max(glint, 0.0) * 0.08;
}`

type Drop = { x: number; y: number; born: number; strength: number }

export function useWaterSplash() {
  return useRef<(() => void) | null>(null)
}

function WaterVideo({
  className,
  size = 512,
  sources,
  splashRef,
}: {
  className?: string
  size?: number
  sources: { src: string; type: string }[]
  splashRef?: MutableRefObject<(() => void) | null>
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = canvas.current
    const vid = video.current
    if (!el || !vid) return
    const gl = el.getContext('webgl2', { premultipliedAlpha: false })
    // No WebGL2: show the plain video instead.
    if (!gl) {
      vid.style.position = 'static'
      vid.style.opacity = '1'
      el.style.display = 'none'
      return
    }

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        console.warn(gl.getShaderInfoLog(shader))
      return shader
    }

    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource))
    gl.linkProgram(program)
    gl.useProgram(program)

    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    )
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const dropsLocation = gl.getUniformLocation(program, 'uDrops')
    const dropData = new Float32Array(MAX_DROPS * 4)

    const drops: Drop[] = []
    const addDrop = (x: number, y: number, strength: number) => {
      drops.push({ x, y, born: performance.now(), strength })
      if (drops.length > MAX_DROPS) drops.shift()
    }

    if (splashRef)
      splashRef.current = () => addDrop(0.5, 0.5, SPLASH_STRENGTH)

    let last: { x: number; y: number } | null = null
    const handleMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const x = (event.clientX - rect.left) / rect.width
      const y = 1 - (event.clientY - rect.top) / rect.height
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        last = null
        return
      }

      if (
        !last ||
        Math.hypot(event.clientX - last.x, event.clientY - last.y) >=
          DROP_SPACING
      ) {
        addDrop(x, y, 1)
        last = { x: event.clientX, y: event.clientY }
      }
    }

    window.addEventListener('pointermove', handleMove)

    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      if (vid.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      const dpr = window.devicePixelRatio || 1
      const pixels = Math.round(size * dpr)
      if (el.width !== pixels) {
        el.width = el.height = pixels
        gl.viewport(0, 0, pixels, pixels)
      }

      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid)
      const now = performance.now()
      dropData.fill(0)
      drops.forEach((drop, i) => {
        dropData.set(
          [drop.x, drop.y, (now - drop.born) / 1000, drop.strength],
          i * 4
        )
      })
      gl.uniform4fv(dropsLocation, dropData)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    frame = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', handleMove)
      if (splashRef) splashRef.current = null
      gl.deleteTexture(texture)
      gl.deleteBuffer(quad)
      gl.deleteProgram(program)
    }
  }, [size, splashRef])

  return (
    <>
      <canvas
        ref={canvas}
        className={className}
        style={{ width: size, height: size }}
      />
      {/* The source: transparent and out of the layout, unless WebGL2
          isn't there to draw it. Not display: none — Chrome pauses muted
          autoplay video it thinks is invisible. */}
      { }
      <video
        ref={video}
        className={className}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
        width={size}
        height={size}
        autoPlay
        playsInline
        loop
        muted
      >
        {sources.map((source) => (
          <source key={source.src} {...source} />
        ))}
      </video>
    </>
  )
}

export default WaterVideo
