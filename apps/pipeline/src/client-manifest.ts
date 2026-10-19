import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ComposeResult, ComposeSplitResult } from './compose.ts'

export interface Dream {
  id: string
  title: string
  link: string
  prompt: string
}

/**
 * Copies compose()'s output into the two places apps/client actually reads
 * from — they're genuinely separate, not one "dreams/" folder:
 *
 * - `apps/client/dreams/<id>/` — full-quality playback video, gitignored,
 *   not part of the Vite build. Deployed by syncing this folder to R2
 *   (`npm run deploy-dreams`), read at runtime via `VITE_APP_DREAMS`.
 * - `apps/client/public/assets/<id>/` — choose-screen assets, committed
 *   directly to the repo, part of the normal Vite public/ build.
 *
 * Then upserts `src/dreams.json`, matching `scripts/generate-dreams.js`'s
 * existing shape and find-and-preserve behavior (new scenes get
 * placeholder title/link/prompt for a human to fill in by hand).
 */
export async function writeClientAssets(
  clientDir: string,
  id: string,
  result: ComposeResult
): Promise<void> {
  const dreamsDir = path.join(clientDir, 'dreams', id)
  const assetsDir = path.join(clientDir, 'public', 'assets', id)
  await mkdir(dreamsDir, { recursive: true })
  await mkdir(assetsDir, { recursive: true })

  await copyFile(result.videoPath, path.join(dreamsDir, 'video.mov'))
  await copyFile(result.videoWebmPath, path.join(dreamsDir, 'video.webm'))
  await copyFile(result.videoSmallPath, path.join(dreamsDir, 'video-small.mov'))
  await copyFile(result.videoSmallWebmPath, path.join(dreamsDir, 'video-small.webm'))

  await copyFile(result.heroImagePath, path.join(assetsDir, 'hero.jpg'))
  await copyFile(result.loopPath, path.join(assetsDir, 'loop.mov'))
  await copyFile(result.loopWebmPath, path.join(assetsDir, 'loop.webm'))
  for (const still of result.stillPaths) await copyFile(still, path.join(assetsDir, path.basename(still)))

  await upsertDreamsJson(clientDir, id)
}

async function upsertDreamsJson(clientDir: string, id: string): Promise<void> {
  const dreamsJsonPath = path.join(clientDir, 'src', 'dreams.json')
  const dreams: Dream[] = JSON.parse(await readFile(dreamsJsonPath, 'utf8'))

  if (!dreams.some((d) => d.id === id)) {
    dreams.push({
      id,
      title: 'TBA',
      link: 'https://youtube.com/watch?v=',
      prompt: '',
    })
  }

  await writeFile(dreamsJsonPath, JSON.stringify(dreams))
}

/**
 * Copies compose-split()'s output into `apps/client/dreams/`, next to the
 * 7-panel files, for the same R2 sync:
 *
 * - `dreams/main/main{,-small}.{webm,mov}`: the shared 6-panel video with the audio.
 * - `dreams/<id>/dream{,-small}.{webm,mov}`: each take's silent dream clip, `<id>` being the take's name.
 *
 * See plans/ready/split-dream-video-client.md for how the client plays them.
 */
export async function writeSplitClientAssets(clientDir: string, result: ComposeSplitResult): Promise<string[]> {
  const files = ['', '-small'].flatMap((size) => ['webm', 'mov'].map((ext) => `${size}.${ext}`))
  const written: string[] = []
  const copy = async (from: string, toDir: string, name: string) => {
    await mkdir(toDir, { recursive: true })
    await copyFile(path.join(from, name), path.join(toDir, name))
    written.push(path.join(toDir, name))
  }

  for (const f of files) await copy(result.mainDir, path.join(clientDir, 'dreams', 'main'), `main${f}`)
  for (const dir of result.dreamDirs) {
    // `<job>/7-dreams/<take>/split`
    const id = path.basename(path.dirname(dir))
    if (id === 'main') throw new Error('A take named "main" would overwrite the shared main video in dreams/main/')
    for (const f of files) await copy(dir, path.join(clientDir, 'dreams', id), `dream${f}`)
  }
  return written
}
