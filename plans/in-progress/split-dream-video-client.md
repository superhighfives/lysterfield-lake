---
title: Play the dream as its own video beside a shared 6-panel main video
status: In progress
created: 2026-10-18
updated: 2026-10-18
---

# Play the dream as its own video beside a shared 6-panel main video

## Goal

Switch dreams mid-song with no audio gap and no frozen avatar or lyrics. The
client plays one shared main video (panels 1-6 and the song) for every dream,
plus a small, silent dream video (panel 7) that follows it. Switching dreams
swaps only the dream video.

## Context

**Today.** Each dream is one 7-panel video with the audio
(`apps/client/dreams/<id>/video{,-small}.{webm,mov}`): 1 lyrics,
2 portrait, 3 portrait background, 4 matte, 5 depth, 6 outline, 7 dream.
Panels 1-6 are the same in every dream (they all come from the same
footage), so changing dream reloads a whole video that is six-sevenths
identical, which cuts the audio and freezes the avatar and lyrics while it
loads. Today you choose a dream on the choose screen and the song starts
from 0; Reset goes back to choosing; back/forward restores a dream and
position (`use-history-sync.ts`). There is no mid-song switch yet, and that
UI is being designed separately: this plan is the playback underneath it.

**The new files (already made, 2026-10-18).** `bun run src/cli.ts
compose-split --job .jobs/full-video` (PR #34) writes, under
`apps/pipeline/.jobs/full-video/`:

| File | What | Size |
| --- | --- | --- |
| `main/main.{webm,mov}` | Panels 1-6 in the order above, with the audio | 6144×1024 |
| `main/main-small.{webm,mov}` | The same, half size, for mobile and touch | 3072×512 |
| `7-dreams/<id>/split/dream.{webm,mov}` | Panel 7 alone, silent | 1024×1024 |
| `7-dreams/<id>/split/dream-small.{webm,mov}` | The same, half size | 512×512 |

All are 24fps and 3:34.8 long (they differ by under a frame), so a given
`currentTime` is the same frame in both. Encoding matches today's files:
VP9 CRF 35 for `.webm`, H.264 CRF 28 with `+faststart` for `.mov`. They
include the depth fix for the walk-away (PR #35). The ten ids are those in
`apps/client/src/dreams.json`.

**What the panel layout touches (CLAUDE.md: load-bearing).**

- `src/materials/video-material.tsx`: every lookup is
  `texture2D(uTexture, vec2((x + (panel - 1.0)) / uFrameTotal, y))`, in the
  vertex shader's `samplePanel` and five places in the fragment shader
  (image, sharpen, mask, overlay, sketch). The parallax nudge applies when
  `uFrameSelected == 7.0`.
- `src/views/main.tsx`: three materials on one `VideoTexture`, all
  `uFrameTotal={7}`:
  - Polaroid: selected 7 (dream), mask 3, overlay 3.
  - Avatar: selected 2, sketch 6, mask 4, depth 5.
  - Lyrics: selected 7 (the dream fills the lyrics), mask 1.
- So the polaroid and the lyrics read from both the dream and the main
  video; the avatar reads only from the main video.
- `src/components/playhead.tsx`: the one `<video>` (slotted into
  media-chrome's `MediaController`), its `<source>` URLs
  (`${VITE_APP_DREAMS}/${id}/video${small}.webm|.mov`, or `dream.src` for
  dev previews), and the load/play/resume effect.
- `src/utils/use-history-sync.ts`: saves and restores the position from the
  one video.

## Approach

### 1. Shader: panel 7 from its own texture

Add `uniform sampler2D uDream;` and route every panel lookup through one
function, so panel 7 reads the dream texture as a whole frame and panels 1-6
read the main texture with `uFrameTotal = 6`:

```glsl
vec4 panel(float p, vec2 uv) {
  if (p == 7.0) return texture2D(uDream, uv);
  return texture2D(uTexture, vec2((uv.x + (p - 1.0)) / uFrameTotal, uv.y));
}
```

- Keep the panel numbers as they are (7 still means the dream), so
  `main.tsx`'s indices only change in `uFrameTotal`, from 7 to 6.
- Keep the one-texel `localX` clamp for panels 1-6.
- The dream texture is a whole frame, so clamp only to `[0, 1]`. Use
  `ClampToEdgeWrapping`, which is the default for a `VideoTexture`.
- The sharpen pass uses `textureSize(uTexture, 0)` for its texel. It only
  runs on the avatar (panel 2), so it can stay on `uTexture`.
- `samplePanel` in the vertex shader only reads panels 4 and 5 (main).
  Update its divisor through the same `uFrameTotal`.

Update the CLAUDE.md section on the 7-panel order in the same change: the
main video is now 6 panels in the same order, and panel 7 is the separate
dream video.

### 2. Two videos, one clock

- **Main video:** the existing `<video>` in `playhead.tsx` plays
  `main{,-small}`. It keeps the audio, media-chrome's controls, history and
  `ended`. It loads once and is never reloaded for a dream change.
- **Dream video:** a second, muted, `playsInline`, `crossOrigin="anonymous"`
  `<video>` (hidden, like the first) plays the current dream's
  `dream{,-small}`. It never drives anything; it follows the main video:
  - `play`, `pause`, `seeking`/`seeked` and `ratechange` on the main video
    are mirrored to the dream video.
  - **Sync loop:** compare `dream.currentTime` with `main.currentTime` on
    every animation frame (or `requestVideoFrameCallback` where it exists).
    - Under ~1/24s apart: leave it.
    - Up to ~0.25s: nudge `playbackRate` (e.g. 1.05 or 0.95) until it's
      back. This avoids seeking, which is slow on iOS.
    - Over 0.25s, or after a seek: set `currentTime` directly.
  - If the dream video stalls (`waiting`), keep the main video playing. The
    polaroid holds its last frame, and the sync loop catches up once the
    dream video plays again.
- **Textures:** give `main.tsx` a second `VideoTexture` on the dream video
  as `uDream` for the polaroid and lyrics materials. The `suspend` that
  waits for `loadedmetadata` should keep waiting on the main video only.
  The dream texture can show a still or blank until its first frame (see 3).

### 3. Switching dreams

The URLs come from the current dream: `${VITE_APP_DREAMS}/main/main{small}`
for the main video (shared) and `${VITE_APP_DREAMS}/<id>/dream{small}` for
the dream (see 5 for hosting).

1. **Preload.** Create (or reuse a spare of) a second dream `<video>` for the
   next dream: set its source, `preload="auto"`, and once `loadedmetadata`
   fires, seek it to the main video's `currentTime`, plus a small lead (about
   0.1s) for the time the seek takes.
2. **Ready.** On `seeked` (and `canplay`), start it playing, hand it to the
   sync loop, and point a second `VideoTexture` at it.
3. **Crossfade.** Blend the polaroid and lyrics from the old dream texture to
   the new one over ~0.3-0.5s. Either:
   - add `uDreamNext` and `uDreamMix` uniforms, mixed in `panel(7, uv)`; or
   - fade the meshes.
   Then retire the old video: pause it, remove its `src`, and `load()` to
   free the decoder.
4. **Keep neighbours warm (optional).** If the switch UI has a natural
   next/previous, preload those dream videos ahead of time (`preload="auto"`,
   seeked near the current time). That makes the switch near-instant on a
   CDN. On mobile, warm only one, to limit memory and data.

The existing polaroid animations (the drop on first choose, Reset) stay as
they are. A mid-song switch doesn't need to hide a load any more, so it can
just be the crossfade.

The first choose from the choose screen works as today, except it loads
the main video and the chosen dream video together. Start both at 0, and
wait for both to be ready before playing, so the polaroid doesn't come in
blank.

### 4. History and resume

`use-history-sync.ts` keeps reading and saving the position from the main
video. `?dream=<id>` and `{ dream, t }` mean the same as before. A
popstate to another dream with the same main video is now a dream switch
(3) plus a seek, not a reload. `resume` then needs no `loadedmetadata`
wait on the main video when it's already loaded.

### 5. Hosting and deploy

`deploy-dreams` syncs `apps/client/dreams/` to the `lysterfield-lake-dreams`
R2 bucket (`VITE_APP_DREAMS`). Proposed layout:

```
dreams/main/main.webm, main.mov, main-small.webm, main-small.mov
dreams/<id>/dream.webm, dream.mov, dream-small.webm, dream-small.mov
dreams/<id>/video*.{webm,mov}   (the 7-panel files, kept until the switch ships)
```

`compose-split` copies them there itself (`writeSplitClientAssets`, as
`compose` does for the 7-panel files; `--skip-client true` to leave it), and
all ten dreams plus `main/` are in `apps/client/dreams/` now. `dreams/` is
gitignored. Publish in the order in `plans/in-progress/dreams.md`: copy to R2
without deleting, deploy the client, then `deploy-dreams` to delete the old
datestamp folders. The R2 steps need the user's go-ahead.

Check that R2 serves these with `Accept-Ranges` and a long `Cache-Control`,
so seeking into a dream video doesn't download it from the start.

### 6. Rollout

Keep the 7-panel path working until the split path has been checked on
real devices: the shader's `panel()` can take a `uSplit` uniform (0 =
panel 7 from `uTexture` with `uFrameTotal = 7`, as today). That gives a
fallback per device, for example 7-panel on a device where two videos
misbehave, without a second shader. Remove the 7-panel files and the flag
once the split path is the only one in use.

## Tasks

- [x] Shader: `uDream`, a `panel()` lookup for every sample, `uFrameTotal` 6
      for the main texture; `uSplit` fallback to the 7-panel layout
      (`?split=0`, and always for a take's dev preview)
- [x] CLAUDE.md: update the load-bearing panel-order section
- [x] `main.tsx`: dream `VideoTexture`s for the polaroid and lyrics (and
      the backdrop, `dream-glow.tsx`)
- [x] `playhead.tsx`: the main video plays `main{,-small}`; the dream videos
      (`utils/dream-video.ts`) mirror play, pause and seeks, plus the sync loop
- [x] Switching dreams: preload, seek, then switch (the snap swap's blank
      print covers it), with the next dream kept warm in the back slot
- [x] First choose waits for both videos; Reset and `ended` unchanged
- [x] A popstate to another dream is a switch plus a seek (handled in
      `playhead.tsx`; `use-history-sync.ts` needed no change)
- [x] Publishing: `compose-split` copies `main/` and each `split/` into
      `apps/client/dreams/` (done for all ten, 2026-10-18)
- [ ] R2: copy, deploy the client, then delete the datestamp folders, with
      the user's go-ahead; check `Accept-Ranges` and `Cache-Control` there
- [ ] Check on real devices:
  - iPhone Safari, including Low Power Mode
  - an Android phone
  - desktop Safari, Chrome and Firefox
  - sync after seeks, pause/resume, backgrounding the tab, and the
    back/forward cache
- [ ] Measure: how long a switch takes on R2 (cold and warm), and what
      happens to drift over the whole song on iPhone

## Things to watch

- **Seeks on the dev server (seen 2026-10-18):** on Vite (HTTP/1.1), a
  dream video loading while the main video, another dream video and the
  choose screen's loop videos all stream can wait seconds for a seek — six
  connections per host. A seek once wedged (seeking, network idle) when the
  main video's own seek re-seeked a dream video mid-load; mirrored seeks
  now skip loading videos, and a seek stuck for 4s reloads once. Measure on
  R2 (HTTP/2) before reading much into dev-server timings.

- **iOS:** several inline videos can play at once if all but one are muted
  (here, the dream). Low Power Mode can refuse autoplay, as it already can
  today. Seeks are slow, hence the playback-rate nudge rather than repeated
  `currentTime` sets.
- **Drift:** the two videos decode independently, so the sync loop has to
  run for the whole song, not just after a switch.
- **Memory:** two (briefly three) video textures. The dream texture is small
  (1024² or 512²), and the main texture shrinks from 7168 to 6144 wide.
- **Bandwidth:**
  - The main video is fetched once per visit (about 210MB `.webm`, 75MB
    small), instead of a 7-panel video per dream chosen (about 290MB, or
    100MB small).
  - Each dream after the first costs only its dream video (about 80MB
    `.webm`, 25MB small).
  - Warmed neighbours cost data even if unused, so keep it to one or two.
- **Sizes:** `main.mov` and `.webm` are 6144 wide. Check that the target
  phones decode `main-small` (3072×512) in hardware, as they do today's
  3584-wide `video-small`.
