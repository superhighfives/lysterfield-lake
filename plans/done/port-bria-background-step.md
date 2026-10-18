---
title: Port the Bria video-erase panel 3 approach into apps/pipeline
status: Complete
created: 2026-10-09
updated: 2026-10-16
---

# Port the Bria video-erase panel 3 approach into `apps/pipeline`

## Overview

`background-video` makes panel 3 from Bria's video object eraser: panel 2
in overlapping 5s chunks with the person masked out, crossfaded back into
`3-background/frames`. It's the process used by hand for `.jobs/full-video`
(phase 4e), written down as a pipeline step so the next job doesn't need
the spike scripts.

**Untested against Bria and R2.** Everything free was tested: the chunk
plan matches the spike's 55 chunks for full-video, the panel 2 checks find
the real cut and a planted stray, the inputs encode correctly, and blending
the spike's chunk outputs reproduces full-video's approved panel 3 (only
frame 0142 differs, which was hand-replaced). The upload, the Bria call and
the delete have never run. The first real run should be one chunk
(`--chunks c000`, about $0.25), checking that Bria reads the r2.dev URLs and
that the inputs are gone from the bucket afterwards.

## Architecture

- `src/steps/background-video.ts`: the step. `planChunks` (pure), the free
  panel 2 checks, chunk inputs piped as raw frames into ffmpeg, the run per
  chunk, and the blend.
- `src/r2.ts`: upload and delete against a public r2.dev bucket via Bun's
  `S3Client`. `@types/bun` was added and `bun` added to `tsconfig` types
  for it; the pipeline already ran under Bun.
- `models.ts`: `backgroundVideo`, pinned to the version the spike used
  (still Bria's latest on 2026-10-16).
- `job.ts`: `cuts`, the first frame of each new shot.
- `mask.ts`: `dilate` exported for the temporal mask.
- CLI: `background-video`, with `--plan true` (checks and cost only) and
  `--chunks` (run only these).

Deviations from the spike, and why:

- **Crossfade weights generalised.** Each covering chunk is weighted by its
  distance from its nearest end. For two chunks that's exactly the spike's
  linear crossfade, but it also handles a frame in three chunks, which the
  even spacing allows for some shot lengths (a ~220-frame shot at 24fps
  plans chunks 50 frames apart). The spike would have thrown there.
- **Prediction state saved per chunk** through `runModelToFileResumable`,
  rather than the spike's bare `predictions.create`, so a crashed run picks
  its predictions back up instead of paying again.
- **Same R2 keys every run** (a random prefix saved in `plan.json`), so
  inputs a crashed run left behind are overwritten and deleted next time.
- **Cut and stray checks** are new. Thresholds use the median step, not
  mean and spread, because in a short clip one stray raised the spread
  enough to hide itself. A cut must also be 4× both neighbouring steps:
  fast arms on full-video (~2023) were a run of big steps, while the real
  cut at 3770 was 0.17 against neighbours under 0.01.
- **Plan guard.** The plan is replanned freely until a chunk has run
  against it; after that a change in frames or cuts is refused. `--plan
  true` never saves it.
- **Blend is sequential**, decoding chunks only while needed instead of all
  up front: 9 min for the full song against the spike's ~5, but it uses far
  less disk. Fine for 5s loops.

## Goal

Make the panel 3 approach used for `.jobs/full-video` (Bria video-erase,
overlapping 5s chunks, crossfades) a real pipeline step, so the next job
doesn't need one-off scripts.

## Context

See [phase 4e](../done/phase-4e-full-video-source-prep.md)'s "Panel 3:
Bria full-song run". The one-off scripts are in
`.jobs/spikes/full-video-panel3/` (`bria-plan.ts`, `bria-run.ts`,
`bria-blend.ts`), with paths from before the job layout cleanup.

- `bria/video-erase-object`: $0.05 per output second, max 5s per clip, max
  750p. It only reads **public URLs**: Replicate Files API URLs need auth,
  so the spike used a temporary public R2 bucket.
- Chunks of 120 frames, evenly spaced within each segment with ≥24 frames
  of overlap, never crossing a hard cut; linear crossfade across the whole
  overlap; upscaled 720 → 1024.
- A temporal mask (union of the alpha ±2 frames, dilated ~24px at 720)
  fixed ghost arms on fast motion, and is probably a better default than
  the raw alpha.
- Bria passes through whatever it's given: a stray panel 2 frame became a
  panel 3 glitch. Worth a stray-frame check on panel 2 before running.

The next job is a 5s loop, which is a single chunk, but the step keeps
chunking and cuts so a full-song job works too.

## Decisions (user, 2026-10-16)

- **R2 via the S3 API**, public r2.dev bucket (as in the spike), not
  wrangler. Bun's built-in `S3Client`, so no new runtime dependency.
- **Hard cuts in `job.json`** (`cuts`: first frame of each new shot), with
  chunking kept for videos longer than 5s.

## Approach

`background-video` step (`src/steps/background-video.ts`), an alternative
to `background-plate` + `background-stabilize` that writes the same
`3-background/frames`.

- `3-background/chunks/` holds `plan.json`, each chunk's inputs
  (`<id>-video.mp4`, `<id>-mask.mp4`, 720px), its prediction id and its
  output `<id>.mp4`, so chunks can be re-blended or redone one at a time.
- Plan: `MAX_SECONDS * fps` frames per chunk, ≥1s overlap, evenly spaced
  within each shot; a shot under 5s is one chunk. Reproduces the spike's 55
  chunks exactly for full-video.
- Mask: alpha >127 unioned over ±2 frames (not across a cut), dilated 24px
  at 720.
- Run: upload both inputs to R2 under a random per-plan prefix, run Bria
  through `runModelToFileResumable` (a saved prediction is picked back up,
  never paid for twice), delete the inputs in `finally`. A chunk with an
  output is skipped; one attempt per chunk, failures listed, no retries.
- Blend: decode chunks as needed at panel 2's size, weight each covering
  chunk by its distance from its nearest end (the spike's linear crossfade,
  generalised), JPEG q92. Free, runs every time all chunks have output.
- Free checks every run (and `--plan true` stops after them, with the
  cost): strays in panel 2, and isolated jumps not listed in `cuts`.
- Refuses to blend over `3-background/frames` it didn't make, and to
  replan once a chunk has run against the old plan.

## Tasks

- [x] Scope and move to `in-progress/`
- [x] R2 helper (`src/r2.ts`), `.env.example` entries
- [x] `background-video` step, CLI wiring, `cuts` in `job.json`
- [x] Plan matches the spike's; stray/cut checks tested on full-video and a
      planted stray; inputs encoded and inspected; failing upload costs nothing
- [x] Blend the spike's chunk outputs and compare with full-video's approved
      panel 3: identical except frame 0142 (hand-replaced in the spike).
      9 min for 5,156 frames, sequential; fine for 5s loops
- Not done, by choice: R2 credentials and a first paid run. Panel 3 for
  full-video already exists, so the step was written down as the process
  and left untested against Bria and R2 for now.
