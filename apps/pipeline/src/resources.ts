import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RESOURCES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources')

/**
 * Fixed, non-per-scene assets — one words.mov + one audio track shared by
 * every scene. Matches the legacy `generate-videos.sh`'s literal paths
 * (`resources/words/words.mov`, `resources/audio/lysterfield-lake.wav`).
 * Both are timed to the song from 0s, so every job's panel 1 and audio
 * start at the song's start too.
 */
export const WORDS_VIDEO_PATH = path.join(RESOURCES_DIR, 'words', 'words.mov')
export const AUDIO_PATH = path.join(RESOURCES_DIR, 'audio', 'lysterfield-lake.wav')

/** Colour references for Deforum dream takes (the legacy PC's Dreaming/Colours; gitignored, ~55MB). */
export const COLOURS_DIR = path.join(RESOURCES_DIR, 'colours')
