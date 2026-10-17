import { useEffect, useState } from 'react'

// A colour reference shown as its colours rather than its picture. Deforum
// matches every frame's whole colour distribution to the reference (histogram
// matching, helpers/colors.py), so what carries over is how much of each colour
// there is, not just which colours appear: the bands are its main colours, each
// as wide as the share of the image it covers, with the picture small in the corner and in full on hover.

type Band = { colour: string; share: number }
const cache = new Map<string, Promise<Band[]>>()

/** The image's main colours by k-means over a small copy, widest first by share, then ordered dark to light. */
function extract(src: string, k = 6): Promise<Band[]> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const size = 40
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return reject(new Error('no canvas'))
      ctx.drawImage(img, 0, 0, size, size)
      const data = ctx.getImageData(0, 0, size, size).data
      const pixels: number[][] = []
      for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]])
      // Seed the centres spread through the pixels, then a few rounds of k-means.
      let centres = Array.from({ length: k }, (_, i) => pixels[Math.floor(((i + 0.5) * pixels.length) / k)])
      let counts = new Array(k).fill(0)
      for (let round = 0; round < 8; round++) {
        const sums = centres.map(() => [0, 0, 0])
        counts = new Array(k).fill(0)
        for (const p of pixels) {
          let best = 0
          let bestDistance = Infinity
          centres.forEach((c, i) => {
            const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
            if (d < bestDistance) [best, bestDistance] = [i, d]
          })
          counts[best]++
          sums[best][0] += p[0]
          sums[best][1] += p[1]
          sums[best][2] += p[2]
        }

        centres = centres.map((c, i) => (counts[i] ? sums[i].map((s) => s / counts[i]) : c))
      }

      const lightness = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
      resolve(
        centres
          .map((c, i) => ({ c, share: counts[i] / pixels.length }))
          .filter((b) => b.share > 0.02)
          .sort((a, b) => lightness(a.c) - lightness(b.c))
          .map(({ c, share }) => ({ colour: `rgb(${c.map(Math.round).join(',')})`, share }))
      )
    }

    img.onerror = () => reject(new Error(`couldn't load ${src}`))
    img.src = src
  })
}

function usePalette(src: string): Band[] | null {
  const [bands, setBands] = useState<Band[] | null>(null)
  useEffect(() => {
    let current = true
    if (!cache.has(src)) cache.set(src, extract(src))
    cache.get(src)!.then(
      (b) => current && setBands(b),
      (error: unknown) => {
        // An empty swatch is the fallback; the picture still shows on hover.
        console.warn(`Couldn't read the palette of ${src}`, error)
        if (current) setBands([])
      }
    )
    return () => {
      current = false
    }
  }, [src])
  return bands
}

/** A colour reference's swatch: its colour bands, with the picture small in the bottom-right corner, and in full on hover. */
export function PaletteSwatch({ src, name, className, onClick }: { src: string; name: string; className: string; onClick: () => void }) {
  const bands = usePalette(src)
  return (
    <button type="button" title={name} onClick={onClick} className={`${className} group relative`}>
      <span className="flex h-full w-full">
        {(bands ?? []).map((b, i) => (
          <span key={i} style={{ background: b.colour, flexGrow: b.share }} className="h-full" />
        ))}
      </span>
      <img src={src} alt="" className="absolute bottom-1 right-1 h-1/3 w-1/3 rounded-sm border border-white/80 object-cover shadow transition-opacity duration-150 group-hover:opacity-0" />
      {/* The whole picture on hover. */}
      <img src={src} alt={name} className="absolute inset-0 h-full w-full rounded object-cover opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
    </button>
  )
}
