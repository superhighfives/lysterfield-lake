import { MutableRefObject, useEffect, useRef, useState } from 'react'

// The welcome screen's title loop, drawn through a small WebGL canvas so
// it can be disturbed like water: moving the pointer over it drops ripples
// where it goes, and the start button drives it through a handle
// (useWater): a big splash from the centre on hover, and a "dive" into the
// lake when it's pressed —
// one huge splash as the title swells, blurs and fades away.
//
// Rings bend the title and also shade the paper around it a little, so
// the water shows between the letters too, fading out before the edge of
// the square. The blend with the page (multiply in light mode) is on the
// wrapper, not the canvas, so the dive can scale and fade it without
// isolating the blend from the page.

// Ripples: at most MAX_DROPS rings at once; a new drop every DROP_SPACING
// CSS px of pointer travel, at POINTER_STRENGTH — faint, next to the
// button's splashes, which a stroke never pushes out early. Each ring spreads at SPEED (UV/s), with this
// wavelength (FREQUENCY) and width at strength 1 — stronger rings are
// longer and wider — displaces by up to AMOUNT (UV) per unit of strength,
// and fades out over DROP_SECONDS. SHADE is how much a ring darkens and
// lightens the paper; kept faint, as dark mode's key turns near-white
// transparent and anything darker shows strongly against the dark page.
const MAX_DROPS = 12
const DROP_SPACING = 40
const POINTER_STRENGTH = 0.2
const SPEED = 0.35
const FREQUENCY = 60
const WIDTH = 0.06
const AMOUNT = 0.022
const DROP_SECONDS = 2.2
const SHADE = 0.05
// The button's ripples: the hover splash, and the dive's.
const HOVER_STRENGTH = 3.5
const DIVE_STRENGTH = 7
/** How long the dive takes, before the scene should replace this. */
export const DIVE_MS = 900
// How long the title takes to fade in once its video's first frame is in.
const FADE_IN_MS = 700

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
// 1 = key the video's white background out to transparency (dark mode).
// The same as components/key-white-filter.tsx's SVG filter, done here
// because iOS Safari doesn't apply SVG filters to a canvas: coverage from
// inverted brightness, choked by a texel, and the white un-mixed from
// anti-aliased edges.
uniform float uKeyWhite;
float coverage(vec3 c) {
  return clamp(4.0 * (2.88 - (c.r + c.g + c.b)), 0.0, 1.0);
}
void main() {
  vec2 offset = vec2(0.0);
  float shade = 0.0;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    vec4 drop = uDrops[i];
    if (drop.w <= 0.0) continue;
    // Stronger drops make longer, wider rings, not just taller ones.
    float scale = 0.6 + 0.4 * sqrt(drop.w);
    vec2 away = vUv - drop.xy;
    float front = length(away) - drop.z * ${SPEED.toFixed(3)} * scale;
    float width = ${WIDTH.toFixed(3)} * scale;
    float ring = exp(-(front * front) / (width * width));
    float fade = max(0.0, 1.0 - drop.z / ${DROP_SECONDS.toFixed(2)});
    float wave = sin(front * ${FREQUENCY.toFixed(1)} / scale) * ring * fade * fade * drop.w;
    offset += normalize(away + 1e-5) * wave * ${AMOUNT.toFixed(4)};
    shade += wave;
  }
  vec2 uv = vUv + offset;
  color = texture(uVideo, uv);
  if (uKeyWhite > 0.5) {
    vec2 texel = 1.0 / vec2(textureSize(uVideo, 0));
    float alpha = min(
      coverage(color.rgb),
      min(
        min(coverage(texture(uVideo, uv + vec2(texel.x, 0.0)).rgb),
            coverage(texture(uVideo, uv - vec2(texel.x, 0.0)).rgb)),
        min(coverage(texture(uVideo, uv + vec2(0.0, texel.y)).rgb),
            coverage(texture(uVideo, uv - vec2(0.0, texel.y)).rgb))
      )
    );
    // The letter's premultiplied colour is pixel + coverage - 1; the canvas
    // isn't premultiplied, so divided back out.
    vec3 letter = clamp(color.rgb + alpha - 1.0, 0.0, 1.0);
    color = vec4(alpha > 0.0 ? letter / alpha : vec3(0.0), alpha);
  }
  // Light and shadow on the water, out to just short of the square's
  // edge so it never shows as a box.
  float edge = smoothstep(0.5, 0.32, length(vUv - 0.5));
  color.rgb *= 1.0 - clamp(shade, -2.0, 2.0) * ${SHADE.toFixed(3)} * edge;
}`

type Drop = { x: number; y: number; born: number; strength: number }

export type WaterHandle = {
  /** A big splash from the centre (once, on hover). */
  hover: (on: boolean) => void
  /** One huge splash as the title swells, blurs and fades away. */
  dive: () => void
}

export function useWater() {
  return useRef<WaterHandle | null>(null)
}

const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

function WaterVideo({
  className,
  mediaClassName,
  keyWhite = false,
  size = 512,
  sources,
  handle,
}: {
  /** On the wrapper: the blend with the page. */
  className?: string
  /** On the fallback video (no WebGL2): filters, like dark mode's key. */
  mediaClassName?: string
  /** Key the video's white background out (dark mode), in the shader. */
  keyWhite?: boolean
  size?: number
  sources: { src: string; type: string }[]
  handle?: MutableRefObject<WaterHandle | null>
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  // Read each frame, so a scheme change doesn't rebuild the GL setup.
  const keyWhiteRef = useRef(keyWhite)
  keyWhiteRef.current = keyWhite
  const [diving, setDiving] = useState(false)
  // No WebGL2, so the plain video's shown in the canvas's place.
  const [plainVideo, setPlainVideo] = useState(false)
  // The video's first frame is in: the title fades in, rather than the
  // button waiting alone on a slow connection.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const vid = video.current
    if (!vid) return
    if (vid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      setLoaded(true)
      return
    }

    const show = () => setLoaded(true)
    vid.addEventListener('loadeddata', show)
    return () => vid.removeEventListener('loadeddata', show)
  }, [])

  useEffect(() => {
    const el = canvas.current
    const vid = video.current
    if (!el || !vid) return
    const gl = el.getContext('webgl2', { premultipliedAlpha: false })
    // No WebGL2: show the plain video instead.
    if (!gl) {
      setPlainVideo(true)
      el.style.display = 'none'
      if (handle) handle.current = { hover: () => {}, dive: () => setDiving(true) }
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
    const keyLocation = gl.getUniformLocation(program, 'uKeyWhite')
    const dropData = new Float32Array(MAX_DROPS * 4)

    const drops: Drop[] = []
    const addDrop = (x: number, y: number, strength: number) => {
      drops.push({ x, y, born: performance.now(), strength })
      if (drops.length <= MAX_DROPS) return
      // Make room by the oldest pointer drop, keeping the button's.
      const oldest = drops.findIndex((drop) => drop.strength <= POINTER_STRENGTH)
      drops.splice(oldest === -1 ? 0 : oldest, 1)
    }

    if (handle)
      handle.current = {
        hover: (on) => {
          if (on && !reducedMotion()) addDrop(0.5, 0.5, HOVER_STRENGTH)
        },
        dive: () => {
          if (!reducedMotion()) addDrop(0.5, 0.5, DIVE_STRENGTH)
          setDiving(true)
        },
      }

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
        addDrop(x, y, POINTER_STRENGTH)
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
      gl.uniform1f(keyLocation, keyWhiteRef.current ? 1 : 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    frame = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', handleMove)
      if (handle) handle.current = null
      gl.deleteTexture(texture)
      gl.deleteBuffer(quad)
      gl.deleteProgram(program)
    }
  }, [size, handle])

  // The dive: the title swells and fades as the splash spreads, and blurs
  // like it's sinking out of focus.
  return (
    <div
      className={`${className ?? ''} relative transition-[transform,opacity] ease-in motion-reduce:transition-none ${
        diving ? 'scale-[1.6] opacity-0' : ''
      }`}
      style={{ transitionDuration: `${DIVE_MS}ms` }}
    >
      <div
        className={`transition-[filter,opacity] ${diving ? 'blur-md' : ''} ${
          loaded ? '' : 'opacity-0'
        }`}
        style={{
          transitionDuration: `${DIVE_MS}ms, ${FADE_IN_MS}ms`,
          transitionTimingFunction: 'ease-in, ease-out',
        }}
      >
        {/* At most the screen's width (less a margin), staying square. */}
        <canvas
          ref={canvas}
          style={{
            width: size,
            maxWidth: 'calc(100vw - 2rem)',
            aspectRatio: '1',
            height: 'auto',
          }}
        />
      </div>
      {/* The source: transparent and out of the layout, unless WebGL2
          isn't there to draw it. Not display: none — Chrome pauses muted
          autoplay video it thinks is invisible. */}
      <video
        ref={video}
        className={mediaClassName}
        style={{
          position: plainVideo ? 'static' : 'absolute',
          top: 0,
          opacity: plainVideo && loaded ? 1 : 0,
          transition: `opacity ${FADE_IN_MS}ms ease-out`,
          pointerEvents: 'none',
          maxWidth: 'calc(100vw - 2rem)',
          height: 'auto',
        }}
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
    </div>
  )
}

export default WaterVideo
