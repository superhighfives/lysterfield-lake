// The gallery's endless grid (gallery.tsx): which polaroid sits at each position.

export const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * The polaroid at a grid position: the list laid out in a near-square block that repeats endlessly. Odd rows sit
 * half a card across, so repeats don't line up in columns.
 */
export function polaroidAt(cx: number, cy: number, count: number) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.max(1, Math.ceil(count / cols))
  return mod(mod(cx, cols) + mod(cy, rows) * cols, count)
}
