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

const dreamsOutput = dreams
  // Not dreams: old takes, and the split layout's shared main video
  // (dreams/main/, see src/utils/dream-video.ts).
  .filter((dream) => dream != 'archive' && dream != 'main')
  .map((dream) => {
    const existingDream = existingDreams.find((d) => d.id === dream)
    if (existingDream) {
      return existingDream
    } else {
      return {
        id: dream,
        title: 'TBA',
        link: 'https://youtube.com/watch?v=',
        prompt: '',
      }
    }
  })

let data = JSON.stringify(dreamsOutput)
fs.writeFileSync('src/dreams.json', data)
