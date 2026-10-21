// The song's video on YouTube: one link for every dream (the dreams are
// all the same song, so they no longer each link to their own). On touch
// devices, the vertical cut made for phones.
const YOUTUBE = 'https://www.youtube.com/watch?v=5mxj2btPbb0'
const YOUTUBE_VERTICAL = 'https://www.youtube.com/watch?v=a-9gGCQIPo8'

export const youtubeLink = (touch: boolean) =>
  touch ? YOUTUBE_VERTICAL : YOUTUBE
