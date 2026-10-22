import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeSplitClientAssets } from './client-manifest.ts'

const SIZES = ['.webm', '.mp4', '-small.webm', '-small.mp4']

/** A fake compose-split output: `main/` plus `7-dreams/<take>/split/` per take. */
async function fakeJob(takes: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'split-assets-'))
  const mainDir = path.join(root, 'job', 'main')
  await mkdir(mainDir, { recursive: true })
  for (const s of SIZES) await writeFile(path.join(mainDir, `main${s}`), `main${s}`)
  const dreamDirs = []
  for (const take of takes) {
    const dir = path.join(root, 'job', '7-dreams', take, 'split')
    await mkdir(dir, { recursive: true })
    for (const s of SIZES) await writeFile(path.join(dir, `dream${s}`), `${take}${s}`)
    dreamDirs.push(dir)
  }
  return { clientDir: path.join(root, 'client'), result: { mainDir, dreamDirs } }
}

describe('writeSplitClientAssets', () => {
  test('copies main into dreams/main and each take into dreams/<take>', async () => {
    const { clientDir, result } = await fakeJob(['lush-and-light', 'cold-water'])
    const written = await writeSplitClientAssets(clientDir, result)
    const dreams = path.join(clientDir, 'dreams')

    expect((await readdir(dreams)).sort()).toEqual(['cold-water', 'lush-and-light', 'main'])
    expect((await readdir(path.join(dreams, 'main'))).sort()).toEqual(SIZES.map((s) => `main${s}`).sort())
    expect((await readdir(path.join(dreams, 'cold-water'))).sort()).toEqual(SIZES.map((s) => `dream${s}`).sort())
    expect(await readFile(path.join(dreams, 'lush-and-light', 'dream-small.mp4'), 'utf8')).toBe('lush-and-light-small.mp4')
    expect(written).toHaveLength(12)
  })

  test('refuses a take named "main" before copying anything', async () => {
    const { clientDir, result } = await fakeJob(['lush-and-light', 'main'])
    await expect(writeSplitClientAssets(clientDir, result)).rejects.toThrow('"main"')
    await expect(readdir(clientDir)).rejects.toThrow()
  })
})
