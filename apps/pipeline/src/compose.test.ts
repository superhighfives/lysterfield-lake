import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from './compose.ts'

const tempDir = () => mkdtemp(path.join(tmpdir(), 'compose-once-'))

describe('once', () => {
  test('writes to a partial name, then renames it into place', async () => {
    const dir = await tempDir()
    const out = path.join(dir, 'main.mov')
    let partial = ''
    await once(out, async (p) => {
      partial = p
      await writeFile(p, 'video')
    })
    expect(partial).toBe(path.join(dir, 'main.partial.mov'))
    expect(await readFile(out, 'utf8')).toBe('video')
    expect(await readdir(dir)).toEqual(['main.mov'])
  })

  test('skips the work when the output already exists', async () => {
    const dir = await tempDir()
    const out = path.join(dir, 'main.mov')
    await writeFile(out, 'old')
    let ran = false
    await once(out, async () => {
      ran = true
    })
    expect(ran).toBe(false)
    expect(await readFile(out, 'utf8')).toBe('old')
  })

  test('a failed run leaves no file that looks done, so the next run tries again', async () => {
    const dir = await tempDir()
    const out = path.join(dir, 'main.mov')
    const failing = once(out, async (p) => {
      await writeFile(p, 'half')
      throw new Error('ffmpeg died')
    })
    await expect(failing).rejects.toThrow('ffmpeg died')
    expect(await readdir(dir)).toEqual(['main.partial.mov'])
    await once(out, (p) => writeFile(p, 'video'))
    expect(await readFile(out, 'utf8')).toBe('video')
  })
})
