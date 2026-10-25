import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ComposeResult } from './compose.ts'

export interface Dream {
  id: string
  title: string
  link: string
  prompt: string
}

/**
 * Copies compose()'s choose-screen assets into
 * `apps/client/public/assets/<id>/` (committed, part of the normal Vite
 * public/ build), then upserts `src/dreams.json`, matching
 * `scripts/generate-dreams.js`'s shape and find-and-preserve behavior (new
 * scenes get placeholder title/link/prompt for a human to fill in by hand).
 *
 * The playback videos stay in the job: `compose-split` writes them to
 * `7-dreams/<take>/split/` and `main/`, `apps/client/scripts/upload-dreams.sh`
 * uploads them to R2, and the app reads them from there via `VITE_APP_DREAMS`.
 */
export async function writeClientAssets(
  clientDir: string,
  id: string,
  result: ComposeResult
): Promise<void> {
  const assetsDir = path.join(clientDir, 'public', 'assets', id)
  await mkdir(assetsDir, { recursive: true })
  await copyFile(result.heroImagePath, path.join(assetsDir, 'hero.jpg'))
  await copyFile(result.loopPath, path.join(assetsDir, 'loop.mov'))

  await upsertDreamsJson(clientDir, id)
}

async function upsertDreamsJson(clientDir: string, id: string): Promise<void> {
  const dreamsJsonPath = path.join(clientDir, 'src', 'dreams.json')
  const dreams: Dream[] = JSON.parse(await readFile(dreamsJsonPath, 'utf8'))

  if (!dreams.some((d) => d.id === id)) {
    dreams.push({
      id,
      title: 'TBA',
      // Unused: every dream links to the one YouTube video (apps/client/src/utils/youtube.ts).
      link: '',
      prompt: '',
    })
  }

  await writeFile(dreamsJsonPath, JSON.stringify(dreams))
}
