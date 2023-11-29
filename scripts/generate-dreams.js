'use strict'

import fs from 'fs'
import lodash from 'lodash'
const { find } = lodash

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

const dreamsOutput = dreams
  .filter((dream) => dream != 'archive')
  .map((dream) => {
    const existingDream = find(existingDreams, { id: dream })
    if (existingDream) {
      return find(existingDreams, { id: dream })
    } else {
      return {
        id: dream,
        title: 'TBA',
        link: 'https://youtube.com/watch?v=',
      }
    }
  })

let data = JSON.stringify(dreamsOutput)
fs.writeFileSync('src/dreams.json', data)
