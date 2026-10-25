'use strict'

import fs from 'fs'

const getDirectories = (source) =>
  fs
    .readdirSync(source, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)

// Every dream has its chooser assets (hero.jpg, loop.mov) committed in
// public/assets/<id>/; its videos are in the bucket (VITE_APP_DREAMS).
const ids = getDirectories('./public/assets')

const existingDreamsData = fs.readFileSync('src/dreams.json', {
  encoding: 'utf8',
})

const existingDreams = JSON.parse(existingDreamsData)

if (ids.length === 0 && existingDreams.length > 0) {
  console.warn(
    'public/assets/ has no dream folders — leaving src/dreams.json untouched instead of wiping it.'
  )
  process.exit(0)
}

// Order is the chooser's: the first dream is the newest, on top of the
// stack (see src/routes/root.tsx). Known dreams keep their place, and a new
// one goes first.
const dreamsOutput = [
  ...ids
    .filter((id) => !existingDreams.some((d) => d.id === id))
    .map((id) => ({
      id,
      title: 'TBA',
      link: '',
      prompt: '',
    })),
  ...existingDreams.filter((d) => ids.includes(d.id)),
]

let data = JSON.stringify(dreamsOutput)
fs.writeFileSync('src/dreams.json', data)
