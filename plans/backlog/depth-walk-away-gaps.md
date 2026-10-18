---
title: Redo the depth panel where the walk-away goes black
status: Backlog
created: 2026-10-17
updated: 2026-10-17
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
4. Re-compose: every dream shares panel 5, so all ten need `compose` again
   (about 5½ hours locally, 24-38 minutes each), then `compose-split` for
   the main video. Then the R2 sync.

## Cost

ZoeDepth on Replicate for about 130 frames: well under $1. Re-composing is
local and free, but slow.

## Finding the frames again

The scan compared each depth frame's brightest pixel with the matte's: depth
under 8 while the matte is over 128 (both on a 64×64 thumbnail) marks a
blank depth panel with a person present. It takes about 15 minutes over
the whole song, mostly reading the 2160px matte PNGs.
