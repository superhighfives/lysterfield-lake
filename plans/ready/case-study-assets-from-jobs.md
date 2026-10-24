---
title: Add .jobs visuals to the charliegleason.com case study
status: Ready
created: 2026-10-23
updated: 2026-10-23
---

# Add .jobs visuals to the charliegleason.com case study

## Goal

The relaunch write-up at charliegleason.com/work/lysterfield-lake tells the
rebuild's story, but was written on a Mac without `apps/pipeline/.jobs`, so
its pictures come only from the published videos and screen recordings. Once
`.jobs` is to hand, add the before-and-afters and bake-offs that the plans
describe but the article can only talk about.

Nothing here calls a model. Every asset comes from outputs that already
exist, so it costs nothing.

## Context

**The article.** It lives in the website repo, not this one:

- Repo: `~/Development/charliegleason.com/auth.charliegleason.com`. The
  rewrite is on the branch `lysterfield-relaunch`, which may have merged by
  now. Pushing to that repo's `main` deploys it.
- Page: `apps/web/src/content/work/lysterfield-lake.astro`.
- Assets: `apps/web/public/assets/case-studies/lysterfield-lake/`.
- Components, in `apps/web/src/components/case-studies/`:
  - `Picture` takes `themed`, which also serves `<name>-dark.webp` in dark
    mode, and `mobile`, which serves `<name>-mobile.webp` under 800px.
  - `Video` is an H.264 `.mp4` with a `.webp` poster of the same name. It
    loads and plays only while it's on screen, and shows the poster with
    controls under reduced motion.
  - The wrappers that set the width are `content`, `wide`, `main` and
    `full`.

**What the article already has.**

- Clips of the player, the chooser, switching dreams, light mode and a
  dark/light wipe.
- The seven panels side by side, and all eleven dreams in a grid.
- The Sharp Edges loop and the March 2023 selfie test.
- An `/admin` screenshot, taken with no jobs present.
- The 2023 diagrams. Each one has a "What changed" paragraph after it.

**Where things are in `.jobs`.** The paths below are the ones the plans
name. Check that each exists before using it.

| Asset | Source | Plan |
| --- | --- | --- |
| Repair of frame 1735 | `spikes/person-check/repair-1735.jpg`, and the original in `full-video/7-dreams/lush-and-light/replaced/` | `in-progress/dreams.md` |
| Reroll of the walk-away (the boat at the end of the jetty) | `spikes/reroll-test/` | `in-progress/dreams.md` |
| Person-check sample sheets | `spikes/person-check/` | `in-progress/dreams.md` |
| Style reference, look only vs look and content | `spikes/style-grid/` | `in-progress/dreams.md` |
| Panel 3, Bria over the full song | `spikes/full-video-panel3/review/panel3-bria-full.mp4` | `done/phase-4e-full-video-source-prep.md` |
| Panel 3, the ghost arms at 1:24 and their fix | `spikes/full-video-panel3/review/panel3-bria-1m24-fix.mp4` and `out-c021.orig.mp4` | `done/phase-4e-full-video-source-prep.md` |
| Outline, ArtLine vs coarse line art | `spikes/outline-bakeoff/`, `spikes/legacy-artline-outline/` | `done/phase-4g-outline-coarse-lineart.md` |
| Depth on the walk-away (1:59-2:08), before and after fit-to-subject | `full-video/5-depth/frames` against the legacy depth frames | `done/depth-walk-away-gaps.md` |
| Sharp Edges' five samples, clip and `take.json` | `full-video/7-dreams/sharp-edges/` | `ready/next-dream.md` |

The five sample frames are job frames 1 (the wide intro), 2025 (fast arms),
2901 (the walk-away), 4033 (the shouting close-up) and 4501 (after the cut).
Use the same frames wherever a comparison needs a moment.

## Approach

Each asset goes beside the paragraph that already describes it. Add a
caption, and leave the prose alone unless a number turns out to be wrong.

1. **Counting the waifus** (in "The dreams, revisited"):
   - A before-and-after of frame 1735: a clear person from behind, then a
     lake and a tree.
   - The reroll strip, which ends on the boat at the end of the jetty.
   - Optionally, one person-check sheet showing flagged and kept frames
     with their scores.
2. **Making a dream now:**
   - Swap `image-admin.webp` for a screenshot with real takes in it: take
     cards, samples, the person-check strip and the clip's leak rate. It
     needs the dev server, `/admin` and `.jobs` together.
   - Add the five Sharp Edges samples beside the matching panel 2 frames.
   - Add the style grid next to the step that describes the style image.
3. **The Background:** a short clip of Bria's background beside panel 2,
   and the ghost arms at 1:24 next to their fix.
4. **The Outline:** ArtLine and coarse line art on the same frames,
   including the fast arms (2025), where ArtLine loses the arms.
5. **The Avatar:** depth on the walk-away, before and after
   fit-to-subject, ideally as a short clip, because the black gap is the
   point.
6. **Optionally, polaroids.** Only with Charlie's own clip, never a
   visitor's, and only after checking with Charlie, since polaroids aren't
   public yet (`VITE_APP_POLAROIDS=false`).

**How the current assets were made.** They were made with ffmpeg 9 and
`cwebp`.

- The ffmpeg build has no `libwebp`, so write posters to `.jpg` first and
  convert them with `cwebp -q 72`.
- Clips are H.264, `-crf 24` to `-crf 27 -preset slow -an -movflags
  +faststart`, and under about 5MB each.
- Stills are WebP at about 1600px wide.
- In the main video, panel n is `crop=1024:1024:(n-1)*1024:0`, or 512 a side
  in `main-small.mp4`.
- The diagonal dark/light split is a `blend` with `all_expr` choosing A or B
  on either side of a sloped line.
- The screen recordings were made with a throwaway Chrome on
  `--remote-debugging-port`, driving `Page.startScreencast` and
  `Input.dispatchMouseEvent` over CDP. That script isn't in the repo.

## Tasks

- [ ] Check that each source above exists, and note the real paths.
- [ ] Frame 1735 before and after, plus the reroll strip, in "Counting the
  waifus".
- [ ] A new `/admin` screenshot with real takes.
- [ ] Sharp Edges samples beside panel 2.
- [ ] The style grid.
- [ ] Bria's background clip, and the 1:24 fix.
- [ ] ArtLine vs coarse line art.
- [ ] Depth on the walk-away, before and after.
- [ ] `pnpm astro check` in `apps/web`, and a look at the page in light and
  dark, at desktop and phone widths.
- [ ] Optionally, polaroids, after asking Charlie.

## Open questions

- Should the repair before-and-after be a drag slider? The site has no
  slider component, so that would mean building one.
- If the original ten dreams are repaired before this happens, the article's
  line "a few of the original ten still have the odd figure sneaking through"
  needs updating, and their before-and-after belongs here too.
