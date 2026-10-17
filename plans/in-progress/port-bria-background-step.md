---
title: Port the Bria video-erase panel 3 approach into apps/pipeline
status: In Progress
created: 2026-10-09
updated: 2026-10-16
---

# Port the Bria video-erase panel 3 approach into `apps/pipeline`

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
- [ ] R2 bucket and credentials in `apps/pipeline/.env` (user)
- [ ] First paid run on the 5s loop job (~$0.25), checking Bria reads the
      R2 URLs and the inputs are gone afterwards
