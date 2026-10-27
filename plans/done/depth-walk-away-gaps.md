---
title: Redo the depth panel where the walk-away goes black
status: Complete
created: 2026-10-17
updated: 2026-10-27
---

# Redo the depth panel where the walk-away goes black

## Goal

Panel 5 (depth) shows the person for the whole song, including the stretch
where they walk away down the boardwalk, where it's currently black.

## Context

Found while checking the re-composed published dreams (2026-10-17). 132 of
`full-video`'s 5,156 frames (about 5½ seconds) have a completely black depth
panel while the matte (panel 4) clearly shows the person:

| Frames | Time | Note |
| --- | --- | --- |
| 2858-3085 | 1:59-2:08 | The walk-away on the boardwalk: 113 frames in about 20 runs, the longest 2891-2940 (50 frames) |
| 5056-5070 | 3:30 | 15 frames |
| 35, 739-741, 751-752 | 0:01, 0:31 | Single frames and pairs |

**Why.** `depth.ts` (porting the legacy `other.py`) gamma-corrects ZoeDepth's
output, then keeps only the 235-255 brightness band, stretched to full range.
That band is what gives the panel its high-contrast look, but it's a fixed
threshold on absolute depth: when the whole subject is far from the camera,
none of it is bright enough to survive, and the panel goes black.

**Not new.** `full-video`'s depth frames are the legacy run's, reused. The
2023 depth frames on the HDD
(`video-final/output/main/output/depth/`, e.g. legacy 7194-7198 for job frame
2881) are black at the same moments, so every published video since 2023 has
had this gap. The user chose to publish the re-composed dreams as they were
and fix this separately.

**Why it matters beyond the panel itself.** The avatar's 3D relief
(`video-material.tsx`'s vertex shader) comes from panel 5, so during these
frames the avatar also goes flat.

## Approach

1. Re-run ZoeDepth on only the affected frames. `depth.ts` runs over a whole
   frames folder, skipping frames whose output exists. It needs a way to take
   a list of frames, for example `forEachFrame`'s `only` option, behind a
   `--frames` flag. Keep the skip-if-exists check (CLAUDE.md), and move the
   current black frames aside first rather than overwriting them, so the
   change can be undone.
2. Scale each of those frames to the subject's own depth range, rather than
   the fixed 235-255 band. For example, rescale from the subject's own
   bright end (a high percentile of the matte-covered pixels) down to a
   matching floor, so a distant figure keeps its relief and still reads in
   the same high-contrast style. Compare a few frames either side of each
   stretch so the cut between the fixed and the per-frame rescale isn't
   visible. If it is, apply the per-frame rescale across a wider window and
   ease it in.
3. Review the fixed frames as stills and in motion, including the avatar's
   relief in the player.
4. Re-compose. In the split layout panel 5 is only in the shared main
   video, so only it needed remaking, not the ten dreams.

## Cost

ZoeDepth on Replicate for about 130 frames: well under $1. Re-composing is
local and free, but slow.

## Finding the frames again

The scan compared each depth frame's brightest pixel with the matte's: depth
under 8 while the matte is over 128 (both on a 64×64 thumbnail) marks a
blank depth panel with a person present. It takes about 15 minutes over
the whole song, mostly reading the 2160px matte PNGs.

## Overview

Shipped 2026-10-18 (commits `70af0ff`, `8591ca7`). Panel 5 no longer goes
black when the subject is far from the camera. The affected frames of
`full-video` were re-run through ZoeDepth and scaled to the subject's own
depth instead of the fixed 235-255 band, then the split main video was
re-composed with them. 325 frames were redone, more than the 132 black ones,
because the whole walk-away flickered.

## Architecture

- `depth --frames <ranges> --fit-to-subject true` (`depth.ts`, wired up in
  `cli.ts`): redoes just those frames, moving the old ones to
  `5-depth/replaced/` first, and keeps ZoeDepth's raw output in
  `5-depth/raw/` so the post-processing can be re-tuned for free. A second
  `--frames` run deletes the earlier redo rather than skipping it (the first
  original stays in `replaced/`). `parseFrameRanges` rejects empty parts and
  frame 0, and has a test in `depth.test.ts`.
- Fitting: each frame is shifted so the subject's nearest point (99.5th
  percentile under the matte) sits at 255, then cut to a 14-level band rather
  than the fixed 20. A far subject spans fewer levels, and 20 left it a flat
  white silhouette; 14 gives about the shading of the 2023 near frames
  (lower quartile ~165, median ~195-203).
- Redone: 736-756, 2846-3125 and 5050-5073, 325 frames. The walk-away was
  wider than the black frames: from 2846 to 3125 the old panel flickered
  between full, dim and black frame to frame as the subject crossed the
  band, so the whole stretch was redone, and it is now steady (8-10% of the
  frame lit throughout). The short windows are the subject entering or
  leaving the frame, where only an arm or shoulder shows.
- Deviation: the plan's fallback of easing the rescale in over a wider
  window wasn't needed. The joins with the 2023 frames either side show a
  small change in character (the 2023 torso is brighter and blurrier); the
  2023 frames just before 2846 already flickered.
- Later reuse: the post-processing half is exported as `maskDepth`, which
  the polaroid flow runs over the raw depth the polaroid model writes to the
  same `5-depth/raw/` layout (commit `36e25d2`).

The split main video was made after the redone frames (2026-10-18 00:20,
the frames 2026-10-17 23:36), and has them: at frames 2900 and 2920 its
panel 5 matches the redone frames (checked 2026-10-21). That's the file on
the next bucket (`main/main.webm`, the same size byte for byte), so the next
app plays the fix. The artist watched the walk-away (1:52-2:16) in the new
composite on 2026-10-18. Only the live site's old 7-panel videos still had
the black frames when this was written; the 7-panel video has since been
dropped altogether (PR #62, 2026-10-25), so nothing the app plays now has
them.
