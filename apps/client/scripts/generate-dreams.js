'use strict'

import fs from 'fs'

const getDirectories = (source) =>
  fs
    .readdirSync(source, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)

const dreams = getDirectories('./dreams')

const existingDreamsData = fs.readFileSync('src/dreams.json', {
  encoding: 'utf8',
})

const existingDreams = JSON.parse(existingDreamsData)

if (dreams.length === 0 && existingDreams.length > 0) {
  console.warn(
    'dreams/ has no scene folders locally — leaving src/dreams.json untouched instead of wiping it. Sync dreams/ first if you want to regenerate.'
  )
  process.exit(0)
}

// Not dreams: old takes, and the split layout's shared main video
// (dreams/main/, see src/utils/dream-video.ts).
const scenes = dreams.filter((dream) => dream != 'archive' && dream != 'main')

// Order is the chooser's: the first dream is the newest, on top of the
// stack (see src/routes/root.tsx). Known dreams keep their place, and a new
// scene folder goes first.
const dreamsOutput = [
  ...scenes
    .filter((dream) => !existingDreams.some((d) => d.id === dream))
    .map((dream) => ({
      id: dream,
      title: 'TBA',
      link: '',
      prompt: '',
    })),
  ...existingDreams.filter((d) => scenes.includes(d.id)),
]

let data = JSON.stringify(dreamsOutput)
fs.writeFileSync('src/dreams.json', data)
