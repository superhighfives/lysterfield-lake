---
title: Add .jobs visuals to the charliegleason.com case study
status: Complete
created: 2026-10-23
updated: 2026-10-29
---

# Add .jobs visuals to the charliegleason.com case study

## Overview

Shipped in charliegleason.com PR #28 (merged 2026-10-29), which rewrote the
Lysterfield Lake case study for the relaunch. The article now shows the
rebuild with the project's own outputs: new recordings of the player,
chooser and dream switching; the face-check story, with frame 1735 as a
drag slider, the face-audit sheet and a style-image before-and-after; the
staged way a dream is made now, from samples to an `/admin` card; and
before-and-afters for depth, Bria's background and ArtLine's outline. All
twelve dreams appear, Paper Planes opens it, and a "Pick up the source"
section ends it.

## Architecture

The assets live in the website repo under
`apps/web/public/assets/case-studies/lysterfield-lake/`, built from
`.jobs/full-video` and the HDD spikes with ffmpeg and cwebp (stills at
quality 72-78, videos as H.264 with a webp poster). The site gained a few
pieces along the way: `Compare.astro` takes two videos (`video`), a
starting line (`start`) and a black seam; `Code.astro` makes full-bleed
code blocks with the code on the text column; `CaseStudyLayout` can show a
`banner-dark.webp` in dark mode; and the background grid and
`scrollbar-gutter: stable` keep every page the same width.

Deviations from the plan, all in the last round of review:

- **Walk-away strip:** the HDD reroll test (Lush and Light, ending at a
  boat) was swapped for eight frames of the published Sharp Edges across
  the whole walk-away (2862-3082). The boat went from the prose too.
- **Face-audit sheet:** the 27 faces the face check finds in its 60 tiles
  are circled in yellow, found by running `models/face-check` on each tile.
- **Style-image example:** frame 141 left a faceless figure, and only 141
  and 143 were ever re-rendered with the swapped style. Frame 1229 was
  re-rendered for the article with `sharp-edges-0001.png` as the style, on
  Replicate (about $0.01), in a throwaway copy of the take so the published
  dream didn't change; her face became a tower on a hill. The before and
  after are in `.jobs/spikes/face-audit/sharp-edges-style-1229/`. The
  published 1229 was already clean from the 2026-10-26 bulk repair, which
  got there with new seeds under the portrait style.
- **What's next** was cut, so the polaroids aren't mentioned.

## Goal

The relaunch write-up at charliegleason.com/work/lysterfield-lake tells the
rebuild's story, but was written on a Mac without `apps/pipeline/.jobs`, so
its pictures come only from the published videos and screen recordings. Once
`.jobs` is to hand, add the before-and-afters and bake-offs that the plans
describe but the article can only talk about.

Nothing here calls a model. Every asset comes from outputs that already
exist, so it costs nothing.

## Progress (2026-10-28)

Pushed to the website's PR #28 (`lysterfield-relaunch`, which also has
`main` merged in), not yet merged:

- **Opener:** Paper Planes (the user's pick over Sharp Edges and Oil
  Slick). Oil Slick is mentioned as the second new dream.
- **Dreams grid:** video and still remade at the walk-away (1:58) as a
  4x4: portrait, background, depth, outline, then all twelve dreams.
- **Counting the waifus:** the face-check story, frame 1735 and Sharp
  Edges' frame 141 as `Compare` sliders, and the face-audit sheet.
- **Making a dream now:** the five sample moments (footage over Oil Slick's
  samples) and Oil Slick's card from `/admin` (`image-admin-take.webp`;
  the old `image-admin.webp` stays in "Digging up 2023").
- **Avatar / Background / Outline:** walk-away depth as a video slider (the
  2023 depth flickers to black for about half of it), Bria's background
  beside panel 2 at 1:24, and footage against the outline at the fast arms.
- **`Compare`** (the site's diagonal slider) gained `video` and `start`.

The spike outputs named in the table below aren't in `.jobs/spikes/` on
this Mac (that only has `face-audit`, with its `sharp-edges-loop-fix/`,
and `pc-polaroid`). They're on the external drive:
`/Volumes/HDD/lysterfield-lake-pipeline/jobs-archive/spikes/`. From there:
the jetty reroll strip (`reroll-test/walk-away`), the style comparison
(`style-grid/all-0.6` against `up-1.2`), and ArtLine (`legacy-artline-
outline/frames/2025.jpg`) against the new outline as a slider. The 1:24
ghost-arms original can't be made: the c021 variants were deleted after
the fix (`done/phase-4e-full-video-source-prep.md`).

## Before starting (2026-10-27)

This was blocked on Sharp Edges showing faces (`in-progress/dreams.md`,
"The check misses painted faces"). That's settled: a face check now runs
beside the person check, all eleven dreams were reviewed and fixed, and
Sharp Edges stays with its chooser loop clear and some faces left through
the song (the user's call). A twelfth dream, Oil Slick, shipped on
2026-10-27. Some of the article's lines are now out of date, so update
them alongside the assets:

- "The person check … catches 97%" describes the probe alone. There are now
  two checks, and the probe missed painted faces: the story of the face
  check (and of `13.png`, the portrait style image) belongs in "Counting the
  waifus".
- "A few of the original ten still have the odd figure sneaking through.
  Repairing them properly is next on the list." Done: all were reviewed and
  repaired (Charcoal's bust kept on purpose).
- The dreams grid and its alt text name eleven dreams; Oil Slick makes
  twelve.
- Sharp Edges' five samples (below) show faces in places. Check any frame
  used against `check.json`, or use Oil Slick's instead.

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
| Sharp Edges' five samples, clip and `take.json` | `full-video/7-dreams/sharp-edges/` | `done/next-dream.md` |

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

- [x] Check that each source above exists, and note the real paths: most
      spike outputs are missing (see Progress)
- [x] Frame 1735 before and after in "Counting the waifus" (a slider),
      plus the reroll strip (from the HDD)
- [x] A new `/admin` screenshot with real takes (Oil Slick's card)
- [x] Samples beside the footage: Oil Slick's, not Sharp Edges'
- [x] The style grid: look and content against look only (from the HDD)
- [x] Bria's background clip. The 1:24 fix can't be shown: the original
      chunk was deleted
- [x] ArtLine vs coarse line art, as a slider at the fast arms (from the HDD)
- [x] Depth on the walk-away, before and after (a video slider)
- [x] `astro build` in `apps/web` (the site has no `astro check` set up),
      and a look in light and dark, at desktop and phone widths
- [x] PR #28 merged (user, 2026-10-29)
- [x] Polaroids: left out. The "What's next" section that mentioned them was cut
      (user, 2026-10-29)

## Open questions

- The original ten have been repaired (2026-10-26). A before-and-after from
  one of them could go beside frame 1735's. Not needed: Sharp Edges' frame
  1229 covers it (see Architecture).
- Should the article still open with Sharp Edges, or with Oil Slick?
  Neither: Paper Planes (user, 2026-10-28).
- Drag slider? Yes (user): the site already had one, `Compare.astro`.
