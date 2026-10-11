---
title: "Phase 4g: replace ArtLine with cleaned coarse line art for panel 6"
status: In Progress
created: 2026-10-09
updated: 2026-10-10
---

# Phase 4g: replace ArtLine with cleaned coarse line art for panel 6

## Goal

A higher-fidelity panel 6 (outline). Regenerate it for `.jobs/full-video`,
and make the same method the pipeline's `outline` step via a private Replicate
model, so future jobs get it too.

## Context

Panel 6 in `full-video` is the legacy run's ArtLine output. The legacy
pipeline ran ArtLine at 300×300 and enlarged it to 1024, so its lines are soft
and smeary, and outstretched arms half disappear. The pipeline's `outline`
step uses the same model and size (`superhighfives/lysterfield-outline`,
`input_size` 300).

## Bake-off (2026-10-09)

Test frames 2023 (fast arms), 2900 (walk-away), 4033 (shouting close-up),
4500 (after the cut), then 3s of fast arms (2000-2071) and 15s across the cut
and the close-up (3700-4059). Everything ran locally. Outputs, sheets and
clips are in `.jobs/spikes/outline-bakeoff/`; the 15s comparisons are
`clip-15s.mp4` (lines only) and `clip-15s-over-portrait.mp4` (lines
multiplied over panel 2).

- **ArtLine at 1024** (650 or 920 checkpoint, near-identical): same inky look,
  far sharper, steadiest frame to frame. Thickening by 1-2px works; +2px
  fills hair and neckline in solid black.
- **ControlNet line extractors** (`controlnet_aux`): realistic lineart (faint,
  slightly twitchier), coarse lineart (clean, pencil-like), Anyline (noisy),
  TEED (bold comic outlines, but nearly twice the flicker), standard lineart
  (faint).
- **Coarse lineart drew stray strands across the face** (skin texture,
  stubble). Fixes tried on the input:
  - contrast-stretching the subject made it much worse (shading traced as
    hatching);
  - heavy edge-preserving smoothing erased eyes and jaw;
  - **light edge-preserving smoothing** (`cv2.edgePreservingFilter`,
    sigma_s 15, sigma_r 0.12), then dropping faint strokes (floor 50, gain
    1.3), kept features and removed most strands.
- Flicker relative to ink over the 15s was similar for every candidate
  (0.48-0.64); only TEED stood out as twitchy.

**Decision (user):** cleaned coarse line art ("8") for panel 6, with plain
coarse line art ("5") as the runner-up. ArtLine is retired for panel 6.

## Approach

1. Regenerate `full-video`'s panel 6 locally (free, ~1h45 for both
   versions): cleaned → `6-outline/frames`, plain → `6-outline/coarse/`. The
   legacy ArtLine frames move to `.jobs/spikes/legacy-artline-outline/`.
2. Package the method as a private CPU Cog model, `models/lineart/`
   (vendored line generator, `cleanup` input picks cleaned vs plain), and
   push it to Replicate after the user's go-ahead.
3. Point the pipeline's `outline` step at it: source frame + matte in, no
   depth blend or contrast stretch (that pre-processing was for ArtLine).
4. Retire `models/outline/` and `superhighfives/lysterfield-outline` once
   the new panel 6 has been watched over the whole song.

## Tasks

- [ ] Regenerate `full-video` panel 6 locally, both versions
- [x] Check the Cog model matches the local result on a test frame (mean difference 0.12/255 locally, identical on Replicate)
- [x] Push `superhighfives/lysterfield-lineart` (private, CPU; version `025736d0…`, ~6s per frame)
- [x] Switch `outline.ts` to it (source frame + matte in; depth no longer used)
- [ ] User watches the new panel 6 over the whole song
- [ ] Retire ArtLine (`models/outline/`, the Replicate model)

## Open questions

- Should panel 6 be shown over the portrait in the client (shader), as in
  `clip-15s-over-portrait.mp4`? That needs no change to panel 6 itself.
