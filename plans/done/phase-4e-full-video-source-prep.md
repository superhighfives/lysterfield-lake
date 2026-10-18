---
title: "Phase 4e: full-song pipeline run (.jobs/full-video)"
status: Complete
created: 2026-09-30
updated: 2026-10-09
---

# Phase 4e: full-song pipeline run (`.jobs/full-video`)

## Goal

Run the **whole song** (214.8s, not the 165s `main.mov` this doc
originally targeted, see Findings) through `apps/pipeline` into
`.jobs/full-video`. Reuse the legacy pipeline's existing full-song
per-frame output wherever it's good enough instead of paying Replicate to
regenerate it.

## Overview

`.jobs/full-video` now holds every panel for the whole song (214.8s,
5,156 frames at 24fps), and one dream (`lush-and-light`) has been composed
end to end through the new pipeline and approved by the user. Composing and
publishing all ten dreams is the next plan,
[`phase-4f-regenerate-and-publish-dreams.md`](../in-progress/dreams.md).

Most panels were **reused from the legacy run** on the HDD instead of being
regenerated, which kept Replicate spend for the whole song to panel 3:

| Panel | Folder | Where it came from |
| --- | --- | --- |
| 0 source | `0-source/` | `main-compiled-full.mov` (the real full-song source, not `main.mov`), original kept in `0-source/original/` |
| 1 words | `1-words/frames` | `resources/words/words.mov`, extracted by the new `words` step |
| 2 portrait | `2-portrait/raw`, `upscaled` | Legacy `images`/`resized`, via the measured legacy frame map; 2 stray legacy frames replaced |
| 3 background | `3-background/frames` | **Generated**: Bria video-erase, 5s chunks with 1s crossfades (~$14) |
| 4 matte | `4-matte/frames` | Legacy `alpha`, no glitch repair |
| 5 depth | `5-depth/frames` | Legacy depth, alpha post-mask re-applied |
| 6 outline | `6-outline/frames` | Legacy `sketch` |
| 7 dreams | `7-dreams/<id>/frames` | The 10 legacy Deforum dreams, rebuilt from their real 10fps frames |

`job.json` records all of this per panel.

## Architecture

**Deviations from the original approach**, which are the main record here:

- **Source.** The doc started out targeting the 165s `main.mov`. The real
  full-length source is `main-compiled-full.mov` (60fps, 12,887 frames),
  which every legacy panel is aligned to. See Findings.
- **Panel 3 went through four approaches.** Flux-fill keyframes with manual
  review (~1,600 calls, kept inventing people, huts and signatures) →
  ProPainter (unusable on tracking-shot footage) → MiniMax-Remover (clean
  on simple stretches, ghosts on fast arms, soft) → **Bria with
  overlapping chunks and crossfades**, which the user picked. The flux
  plates were deleted. See the Panel 3 history below.
- **Panel 7 reuses the legacy dreams** instead of generating new ones. They
  were renamed from datestamps to readable ids (`watercolour`,
  `lush-and-light`, ...), and the client now keys off those ids too. See
  Dreams below.
- **Job layout.** Every panel now lives in a numbered folder with its
  frames in `<n>-<panel>/frames`, the input is `0-source/`, and `job.json`
  carries the job's settings and provenance. See Job layout cleanup.

**One-off scripts** (not committed, kept for reference in
`.jobs/spikes/full-video-panel3/`, with old paths): `populate-legacy.ts` +
`legacy-frame-map.json` (legacy reuse), `bria-plan.ts`/`bria-run.ts`/
`bria-blend.ts` (panel 3). Porting the Bria approach into the pipeline is
[`port-bria-background-step.md`](port-bria-background-step.md).

**Legacy frame map.** New 24fps frame *n* (0-based) sits on legacy 60fps
frame `map[n]` ≈ 2.5n − 3.5, measured rather than computed (see Findings).
It's what aligns every reused panel, and the dreams, to the source.

## Dreams (2026-10-09)

- The 10 published dreams were the legacy Deforum runs on the HDD
  (`video-final/dreaming/<datestamp>/`). Deforum read the 60fps panel 2
  video with `extract_nth_frame: 6`, so each dream is **2,148 real frames,
  10 per second of song**. The 60fps `output/dreaming/<datestamp>.mov` is
  not interpolated: it holds each real frame for 6 frames. Real frame *k*
  fills legacy 60fps frames 6(k−1) to 6k−1 (verified at k = 200, 800,
  1900); real frame 0 is never shown.
- Each dream's `7-dreams/<id>/frames` was built from the real PNGs: job
  frame *n* shows real frame `floor(map[n] / 6) + 1` (capped at 2,147).
  Each real frame is stored once as JPEG q90 and the job frames holding it
  are hard links (4.7GB for all ten). The user chose 10fps (every real
  frame) over stepping to panel 3's 6fps. An earlier attempt that stepped
  the 60fps video to 6fps was wrong and was redone.
- Checked against the old published composites at exact frames: panel 7
  matches. (Two apparent mismatches were imprecise `-ss` seeks, not timing
  errors; compare by frame number, not seek time.)
- `original/` holds each dream's `deforum-settings.txt` (prompt, seed).
  There's no `take.json`, because they weren't made by `dream.ts`.
- Ids now come from the titles in `apps/client/src/dreams.json`. The client
  was renamed to match (`dreams.json`, `index.html` preloads,
  `public/assets/<id>/`, local `dreams/<id>/`).

**Stray legacy frames.** The user spotted a one-frame glitch at 0:06 in
panels 2 and 3. The legacy `resized/0350.png` is a leftover file: a
different, larger upscale. It became panel 2 frame 142, and Bria processed
it into panel 3. A file-size scan (each frame against the median of its
±3 neighbours) also found `resized/2000.png` (never upscaled) at panel 2
frame 802. Both panel 2 frames were replaced with the clean legacy frame
1/60s later. Panel 3 frame 142 was replaced with a blend of 141 and 143.
Matte, depth and outline frame sizes vary too much with motion for this
scan to clear them.

## Panel 3 history

The flux keyframe sections below are superseded by Bria (the last
subsection); their files were deleted on 2026-10-09.

### Flux keyframe run (2026-10-04, superseded)

- **Started with `nohup` just before the session restart** so it survives
  it (PID was 12104). The log is
  `.jobs/full-video/3-background/plate-run.log`. Check it's still going
  and how far it's got:

  ```
  pgrep -fl "src/cli.ts background-plate"
  ls apps/pipeline/.jobs/full-video/3-background/plate | wc -l   # target 1,290
  tail apps/pipeline/.jobs/full-video/3-background/plate-run.log
  ```

- This run fills the ~430 keyframes left after 3565 **and** regenerates
  the 31 manually rejected fills (seed bumped per prior rejection).
- Replicate-side failures so far: 3 (a connection reset in pilot v1, a
  model-provider connect failure at fill 132, and a 3-minute prediction
  timeout at fill 864). The step stops on the first failure with no
  automatic retries. The user OK'd a rerun after the third. **If it fails
  again, ask the user before rerunning.** The rerun command (skips
  finished frames) is:

  ```
  cd apps/pipeline && nohup bun run src/cli.ts background-plate --job .jobs/full-video > .jobs/full-video/3-background/plate-run.log 2>&1 &
  ```

- **The automatic leak regeneration is now OFF** (user decision, see "Leak
  check" below). The check still runs and logs `flagged for review (not
  regenerated)` lines in the log. Use those as hints during visual review.

### Visual review progress

- Every keyframe fill from 0001 through 3565 has been reviewed on contact
  sheets, plus the pilot window.
- **31 rejected so far**, all moved to `3-background/plate-rejected/` and
  being regenerated by the current run. The list is in
  `.jobs/full-video/3-background/manual-rejects.txt`:
  - Invented people: 0049 (figure at the frame edge where the subject
    enters); 1329-1345 (distant walkers at the far end of the boardwalk,
    5 fills); 2881, 2885, 2889, 2897, 2901, 2909, 3101 (a figure walking
    on the boardwalk, where the subject walks away from camera; the
    leak check can't see a figure from behind).
  - Buildings, huts and sheds: 0713, 0785, 1749, 1857, 1953, 1965, 2121,
    2125, 2385, 2797, 3201, 3209, 3213.
  - Other: 0709 (paved road), 0965 (pole), 1957 and 1961 (faint wind
    turbines), 3157 (crisp lone tree).
- Rejects cluster: the fixed per-scene seed plus near-identical
  consecutive inputs repeat an invention across neighbouring keyframes,
  so always check a reject's neighbours.
- Kept on purpose: rope railings and handrails, side branches of the
  boardwalk, red poppies, painterly sky smears, and red horizon smudges
  that come from panel 2 itself. The colour blotches in the intro
  (0001-~0120) are panel 2's own look.
- Contact sheets (script since deleted): `review-sheet.sh <start-index> <out.png>`
  makes a sheet of 48 fills starting at that index in the sorted
  `3-background/plate` listing. Find the index with
  `ls plate | sort | grep -n '^3569'`.

### Replicate spend (flux-fill-pro), approximate

- Pilots: 126 calls.
- Full run up to the restart: ~833 keyframe fills + ~141 automatic leak
  regenerations (about 90% wasted on false positives, which is why that's
  now off).
- Remaining: ~430 keyframes + 31 manual-reject regenerations, plus any
  second-round rejects from review.
- Per-call price still **unconfirmed**. The user is checking the Replicate
  dashboard. It's believed to be ~$0.05/image.

### Round 2-3 review (2026-10-05)

- The detached run finished cleanly (all 1,289 keyframes; 1,290 with the
  stray boundary keyframe dropped in the pilot).
- Seed-bump regeneration alone reproduced the same walkers and huts, so
  `FILL_PROMPT` now leads with "an empty, deserted landscape with nobody
  on the boardwalk". The 18 bad redos were regenerated with it and came
  out clean. 0713 and 0965 keep red spiky horizon shapes that are panel
  2's own, which is accepted.
- **Signatures:** ~75 fills (mostly 3601-4905) had a faint script
  signature that shows through the mask in the final panel. Naming them in
  the prompt seemed to prime them, so it's now "a plain unsigned
  painting" (3/3 clean in a test). That shifts the look, so per the user
  (option 1) **all of 3601-5153 is being regenerated as one stretch**
  with the new prompt, plus scattered rejects 0133, 0681, 0805, 0849,
  2609, 3193, 3385 (signatures/text), 3577-3585 (red figure, red barn) and
  3653 (animals, in range). That's 398 fills in total, listed in
  `3-background/round3-rejects.txt`. 4733 was already clean on the new
  prompt and is kept.
- Round 3 ran detached (log `3-background/plate-run.log`) and **stopped
  on Oct 5 at 19:35 after fill 4809**, with an empty log, so the cause is
  unknown. The 86 fills 4813-5153 are missing (1,203/1,289 on disk). It's
  on hold while video-removal models are evaluated (see below), so don't
  resume it without asking.
- Review tip: signatures sit in the lower-right fill area and are too
  faint for 48-up sheets. Crop `crop=464:240:560:770` at 96-up instead.

### ProPainter spike (2026-10-08): not suitable for this footage

- Our own Cog wrapper (`models/propainter`, pushed as private
  `superhighfives/propainter`, version `d35f3fae…`) fixes the public
  `jd7h/propainter` input bug and works end to end.
- On `real-15s-60fps` (361 frames, 1024px, A100, about 7.5 min per run) the
  output is clearly worse than flux-fill. With the pipeline's grown mask it
  left a brown checkerboard blob. With a tight mask (raw alpha + 8
  dilation, fp16) it left a smeared ghost of the silhouette. The subject
  stays centred while the camera tracks them, so the background behind
  them almost never appears in other frames for ProPainter to propagate.
  An fp32 run failed inside upstream's script, most likely out of memory,
  but unconfirmed because the wrapper doesn't surface subprocess output yet.
- Compare clip: `.jobs/real-15s-60fps/legacy/propainter-spike-compare.mp4`
  (panel 2, current panel 3, ProPainter grown mask, ProPainter tight mask).
- Decision: keep flux-fill with the review loop as the pipeline's panel 3
  (later replaced by Bria). The wrapper was deleted from `models/` on
  2026-10-09; it's in git history if footage where the background is
  actually revealed (static camera, subject crossing the frame) ever needs it.
- Tokens: in the user's shell `REPLICATE_API_TOKEN` is the
  `superhighfives` token and `REPLICATE_PERSONAL_API_TOKEN` is the
  `replicate` org token (the same one in `apps/pipeline/.env`). Bun gives
  the shell priority over `.env`, so the pipeline has been running, and
  billing, as `superhighfives`. The user is fixing the names on their end.

### MiniMax-Remover spike (2026-10-08): promising

- `ayushunleashed/minimax-remover` (public, diffusion-based video object
  removal, video + mask video in). One run on `real-15s-60fps` (tight mask,
  default `num_inference_steps` 6, `mask_dilation_iterations` 8, seed 42)
  took ~19 min for 361 frames at 1024px.
- Result: the subject is fully removed in every frame, with no ghost or
  checkerboard, and the fill continues the boardwalk consistently across
  the clip. Weakness: the fill is smooth and soft, less painterly than
  the surrounding panel-2 style.
- Compare clip: `.jobs/real-15s-60fps/legacy/minimax-spike-compare.mp4`
  (panel 2, current flux panel 3, ProPainter tight, MiniMax).
- Not yet tried: `num_inference_steps` 12 (sharper?), running it on the
  grown mask, and `runwayml/aleph-2` (text-driven, 2-30s clips, optional
  keyframe images).
- At this speed the full song (5,156 frames) would be roughly 4-5 hours
  of GPU time, likely in chunks. The per-run price isn't listed.
- **Price (from the dashboard): $0.98** for that run (16m 44s running), so
  roughly $0.001/s of GPU time.

### Panel 3 video-removal round 2 (2026-10-08): MiniMax on full-video

Inputs, scripts and outputs are in `.jobs/spikes/video-removal/`
(`run.ts` creates predictions, `fetch.ts` only collects them). Compare
clips there are panel 2 | current flux keyframe plate (held) | MiniMax.

- **2841-2960, walk-away, tight mask** (raw alpha >127, model dilation 8,
  6 steps, seed 42): 151s of GPU time, about $0.15. **Good.** It continues
  the boardwalk consistently with no invented walkers (flux's problem
  here). It's still soft, and it leaves faint dark smudges where the feet
  and the subject's shadow were, because the shadow isn't in the alpha.
- **2001-2240, fast arms, grown mask** (pipeline `reshapeMask` thresholded
  >16): 474s, about $0.46. **Bad.** When the mask covers most of the
  frame, the fill is a large featureless green-grey blur with a smeared
  tree line. MiniMax needs surrounding context and falls apart on big
  masks, so the grown-mask approach doesn't transfer.
- **2001-2237, fast arms, tight mask** (same settings as 2841): 457s,
  about $0.45. **Also fails, differently.** The boardwalk edges carry
  through, but a pale ghost of the subject stays: the cap and head outline
  (frame ~2110) and a hand/stick at the right edge (~2110, ~2200). The
  painterly smears outside the true alpha are left as "background". Flux
  is clearly better on this stretch. In `compare-2001.mp4`, the order is
  panel 2 | flux | MiniMax grown | MiniMax tight.
- **Frame count:** MiniMax returns 4k+1 frames and drops the rest (240 in,
  237 out; 120 in, 117 out). Full-song chunks must be 4k+1 frames long or
  overlap.
- **Bria (`bria/video-erase-object`)**: $0.05 per output second, max 5s
  per clip, max 750p. It needs public URLs: Replicate Files API URLs need
  auth (first attempt failed "Failed to load video", no output), so inputs
  go on the temporary public R2 bucket `lysterfield-spike-temp` instead.
  On `real-15s-60fps` frames 1-118 (720px, tight mask): 32s, about $0.25.
  **Most painterly fill of the three**, with textured grass that stays
  consistent across the clip. But it fills with grass rather than the
  boardwalk, and leaves a white patch at the bottom right (shoulder) and
  a red blotch at the bottom (shirt colours). Compare:
  `compare-bria-r15.mp4` (panel 2 | flux | MiniMax | Bria). Not yet tried
  on full-video's hard stretches.
- **30s test, full-video 2201-2921** (`spikes/video-removal/s30/`, compare
  `compare-30s-bria.mp4`: panel 2 | flux | Bria):
  - Bria, six 5s chunks at 720px, tight mask: about 30-50s each, about
    $1.50 total. Within a chunk it's good. It continues the boardwalk
    painterly and stably, with no people. But **every chunk boundary is
    a visible jump**: the boardwalk texture changes, orange shirt-colour
    blotches come and go, and in one chunk (~2501) it turns the boardwalk
    into a truncated slab and grass. It has no seed or reference input to
    hold chunks together, so it would need overlapping chunks and
    crossfades.
  - MiniMax, 721 frames in one run: **failed with a GPU out-of-memory
    error** after 153s. 361 frames at 1024px is known to fit, so it needs
    chunks of ≤361 frames (4k+1).
  - MiniMax as two **15s blocks of 361 frames** (2201-2561, 2561-2921,
    sharing 2561): both succeeded, ~965s each, roughly $1 each. That makes
    **15s/361 frames the working block size**, and the full song would be
    ~15 blocks, about $15. Quality was uneven: block 1 continues a grey
    boardwalk with some plank texture, but in block 0 the boardwalk is a
    pale blue-white smear. The block boundary is a visible jump (smear to
    planks), and the walk-away leaves dark feet/shadow smudges as before.
    Four-way compare: `compare-30s.mp4` (panel 2 | flux | MiniMax | Bria).
  - On this stretch, **Bria's fill is crisper and more painterly than
    MiniMax's**, but it has 5 boundary jumps against MiniMax's 1, plus the
    slab failure at ~2501. Neither is clean without handling the block
    boundaries.
  - **Bria with overlapping chunks + crossfade** (`xf/`, compare
    `compare-30s-crossfade.mp4`: panel 2 | Bria hard cuts | Bria
    crossfaded): eight 5s chunks starting every 96 frames (24-frame
    overlap), joined with 1s `xfade` dissolves. About $2, 30-60s per chunk.
    The dissolves read as a soft morph instead of a jump, with a brief
    double image of the boardwalk edges mid-fade. **This fixes the
    boundaries.**
  - **The 00:15-00:20 path loss (~2561-2700) is not random.** The fresh
    chunks lose the boardwalk in the same place, turning it into a slab
    and grass. There, the subject is a centred close-up covering the whole
    boardwalk, so a 5s chunk never shows Bria any boardwalk to continue.
    Regenerating the same chunk won't fix it. MiniMax's 15s block did keep
    a boardwalk there, because it had more context. Options: flux keyframes
    or MiniMax for such stretches, or a chunk window shifted to include
    frames where the boardwalk is visible.
- **Takeaway so far:** with a tight mask, video models leave the
  subject's stylized smears behind (ghosts, shirt-colour blotches), and
  with a big mask they lose detail. MiniMax suits stretches where the
  subject stays inside the alpha, like walking away. Flux is still the
  better choice for arm movement. A hybrid split per stretch is the
  likely shape.
- Token: these runs were billed to the `replicate` org. The user has since
  switched both `.env` and the shell to the personal `superhighfives`
  token.

### Panel 3: Bria full-song run (2026-10-09)

The user picked Bria with overlapping chunks and crossfades over MiniMax
and flux. The 00:15-00:20-style path losses in close-ups were accepted
as they are.

- One-off scripts, now in `.jobs/spikes/full-video-panel3/` (not committed;
  they still use the old paths and are kept for reference only):
  `bria-plan.ts`, `bria-run.ts`, `bria-blend.ts`. The chunk outputs and
  plan are in `bria-chunks/` there; the inputs and c021 variants were
  deleted.
  - `bria-plan.ts` makes 55 chunks of 120 frames (5s). They're spaced
    evenly within two segments, 0001-3769 and 3770-5156, with 26-30
    frames of overlap, so no chunk crosses the hard cut (between files
    3769 and 3770, confirmed visually). The plan is in
    `bria-chunks/plan.json`.
  - `bria-run.ts` runs Bria once per chunk, 8 at a time, with no retries.
    It skips chunks whose `out-<id>.mp4` exists. Inputs (720px panel 2 and
    the alpha >127 mask) come from the temporary public R2 bucket
    `lysterfield-spike-temp` under `full/`, because Bria can't read
    Replicate file URLs. Pass chunk ids to rerun specific ones (delete
    their `out-` file first).
  - `bria-blend.ts` upscales each chunk to 1024 (lanczos) and linearly
    crossfades across each full overlap. It writes
    `3-background/frames/NNNN.jpg` (5,156 frames). It's free, local and
    takes about 5 min.
- Result: 55/55 chunks succeeded at 30-60s each, about $13.75 on the
  `superhighfives` token. On a 48-up sample sheet there were no people,
  buildings or signatures, and the boardwalk carries through except in the
  known centred close-ups (~2590-2700, a slab near ~3670).
- Review video: `.jobs/spikes/full-video-panel3/review/panel3-bria-full.mp4` (panel 2 |
  new panel 3, with audio). **Approved by the user** after one fix:
  - At 1:24 (~frame 2023), dark ghost arms appeared in the sky for a few
    frames. The arms shoot up faster than the matte follows, and the
    painterly streaks fall outside it. Fixed by regenerating chunk c021
    only, with a wider mask: union of alphas ±2 frames, then a 24px
    dilation (`bria-chunks/grow-c021.ts`, variant `a`; variant `b` was ±3
    frames and 48px, also clean but softer). The original is kept as
    `out-c021.orig.mp4`. Close-up clip: `review/panel3-bria-1m24-fix.mp4`.
  - Lesson for porting this into the pipeline: a temporal union (±2
    frames) plus a modest dilation is probably a better default mask than
    the raw alpha for fast motion. Cost ~$0.50 for the two variants.
- `compose` reads `3-background/frames` by default, so no flag is needed.
- **Panel 3 approved by the user (2026-10-09).**
- Cleanup done: the R2 bucket `lysterfield-spike-temp` (144 objects) and
  all 12 spike inputs in Replicate Files were deleted. A chunk redo would
  need a new public bucket, since `bria-run.ts` still points at the old
  URL.
- Follow-up: port this into `apps/pipeline` as a real step. R2 hosting is
  the new dependency; upload, run, then delete the inputs, so nothing
  stays public.

## Panel 3 pipeline changes (2026-10-04)

Motivated by the full-video pilots. All in `apps/pipeline/src`:

- **Keyframe-only fills.** `background-plate` now fills only the
  `stepFps` keyframes (shared `keyframeIndices()` in `job.ts`, so plate and
  stabilize can't drift apart). `background-stabilize` takes panel 2
  (`2-portrait/upscaled`, CLI `--base`) as the base layer outside the mask,
  instead of each frame's own fill. Measured flux-fill-pro drift from its
  input outside the mask: 1.4/255 mean, so this is visually equivalent at
  ~1/4 the calls. (An earlier note here said a keyframe-only plate would
  be "identical"; it isn't byte-identical, because stabilize used every
  frame's fill as the base layer, but it's equivalent in practice.)
- **Bigger mask, covering the whole hold.** The user flagged stylized arms
  showing through panel 3 on fast moves (pilot frames 2023-2028).
  DiffusionCLIP's painterly arms smear past the true silhouette, and the
  mci-interpolated mask lags fast motion mid-hold. Fixes:
  - `reshapeMask` unions several alphas at a fixed 1024px working size and
    applies 96px dilation then blur sigma 24. The old values (100
    ffmpeg dilation passes, sigma 30, at the alpha's native 2160px) worked
    out to ~47px/sigma 14. The dilation is a hand-rolled separable max
    filter, because sharp 0.35's `dilate`/`erode` didn't behave as a plain
    max filter on these masks (the silhouette's top edge moved the wrong
    way, inconsistently).
  - `background-plate`'s mask for each keyframe is the union over its
    hold window plus the next keyframe.
  - `background-stabilize` floors each frame's interpolated mask at that
    frame's own reshaped alpha.
- **Tighter `FILL_PROMPT`.** Pilot v1 invented a paved road with lane
  markings, a red barn, a wind turbine, a power pole, a water channel and
  one signature-like scribble. The prompt now leads with "only open
  grassland, sky and the existing wooden boardwalk" and names exclusions.
- **Leak check.** Each fill is scored with the existing local
  `scoreLeak` as it lands. It originally regenerated a failing fill once
  with seed + 1 (requested by the user, a bounded exception to the
  CLAUDE.md no-retry rule). On the full run that fired on ~1 in 5 fills,
  and 11 of 12 sampled were false positives (boardwalk planks and orange
  flowers read as skin). It also misses the commonest real leak, a figure
  seen from behind. So the user agreed to turn regeneration **off by
  default**: it now only logs `flagged for review`. `--regenerate-leaks
  true` opts back in.
- **Manual reject -> regenerate.** Move a fill into
  `3-background/plate-rejected/` and rerun `background-plate`. The seed
  is bumped by the number of prior rejections of that frame, so each redo
  is a genuinely different fill.
- **Result (pilot v2, 62 calls on frames 2001-2240):** no arm leaks, no
  invented objects, a consistent boardwalk through grassland. When the
  arms go wide the mask covers most of the frame and the fill becomes
  soft haze; one frame (2025) shows a faint horizontal haze edge. Clips:
  `.jobs/full-video/pilot/panel3-pilot.mp4` (v1) and `panel3-pilot-v2.mp4`
  (v2), panel 2 left and panel 3 right.

## Job layout cleanup (2026-10-09)

A job is now `0-source/` (input) plus one numbered folder per panel, each
with its final frames in `<n>-<panel>/frames`. Both jobs were moved over,
and the pipeline defaults changed to match:

- `0-source/video.mov` (the square crop `matte` sends to Replicate; was
  `video/cropped.mov`) and `0-source/frames/` (was `source/*.jpg`). `init`
  no longer makes `video/original.mov` and `video/full.mov`, which nothing
  read.
- Panel 1: the new `words` step extracts `resources/words/words.mov` into
  `1-words/frames` once, padding the black tail to the job's length.
  `compose` runs it automatically if it's missing, and compiles panel 1
  like any other panel (it used to copy `words.mov` in).
- Panel 3: `3-background/frames` (was `3-background/stable`).
- Panel 4: `4-matte/frames` (was `alpha/`), and the matte model's raw video
  is `4-matte/raw.mp4` (was `video/alpha-source.mp4`).
- `init` copies the untouched original into `0-source/original/` and
  crops from that copy, so a job never depends on an external drive.
  `full-video`'s is `0-source/original/main-compiled-full.mov` (2160px,
  446MB, byte-identical to the HDD copy).
- `job.json` now holds `fps`, `source` (`path` = the local original,
  `from` = where it was copied from, plus any offset/length), `stepFps`
  (the default for `--step-fps`), and a `panels` note on where each
  panel's frames came from. `real-15s-60fps`'s source isn't recorded
  anywhere, so its `job.json` has none.
- Each dream take saves `7-dreams/<take>/take.json` (prompt, seed,
  stepFps). Re-running a take reuses it, so `--prompt` is only needed for
  a new take. `dream` refuses to add frames made with different settings
  to a take that already has some.
- Experiment leftovers are in `.jobs/spikes/`.

## Other fixes (2026-10-04)

- **`init.ts` crop.** It capped the *crop* at 1280px, so any source larger
  than 1280 got a zoomed-in center crop instead of a full-frame downscale.
  It now crops the full centered square, then scales to 1280.
- **`repairGlitchedFrames` is not safe at full length.** On the full song it
  flagged 80 frames. The cluster checked (2011-2040) was all fast real arm
  motion with correct masks, and "repairing" it would have frozen the arms.
  All 80 were restored to the legacy originals and their depth regenerated.
  The detector needs tuning (or a flagged-frame review list) before it's
  trusted on long footage. There may still be real glitches among those 80;
  nobody has reviewed them individually.

## Findings (2026-09-30 / 10-02, legacy drive)

The legacy run at
`/Volumes/HDD/lysterfield-lake-pipeline/video-final/output/main/output/`
holds a **complete per-frame set for the whole song**: `alpha` (2160px),
`resized` (portrait, upscaled, 1024px; `images` is the 512px raw),
`depth` (RGBA), `sketch` (outline), `words`, `background`/
`resized-background`, `green`, at 12,887 frames each, 1-indexed `%04d.png`.

- **The real full-length source is not `main.mov`.** The legacy frames run
  at 60fps for 214.78s, matching `resources/audio/lysterfield-lake.wav`
  (214.82s). `main.mov` (165s) is a partial edit. Frame-matching 32px
  signatures against `main-cropped.mov`:
  - legacy 0-429 (0-7.15s): **different intro**. It opens on an empty-field
    pan before the subject walks in, where `main.mov` opens on a close-up.
    They converge at 7.17s.
  - legacy 430-9417 (7.17-156.95s): same footage as `main.mov`,
    time-aligned (a `-r 60` resample of the 59.94fps source).
  - **Hard cut at legacy frame 9418 (156.97s)**, confirmed by the user.
    9418-12886 (~57.8s) is a second clip not in `main.mov`.
- `output/main-compiled-full.mov` (2160px, 60fps, 12,887 frames, built
  from the legacy source frames) is therefore the full-song source, aligned
  with every legacy panel.
- **Frame map (measured, not formula).** New 24fps frame k (0-based) lands
  on legacy frame ≈ 2.5k − 3.5 (−3 or −4 vs `round(2.5k)`). That's
  ffmpeg's `-r 24` frame selection, about 58ms behind naive rounding. The
  match error is under 0.6, against ~8 between different encodes, and the
  map is monotonic.
- Spot-checked legacy alpha/portrait/depth/outline/words at legacy frames
  4000 (pre-cut) and 11000 (post-cut): all production-quality.
- Legacy depth already carries its own gamma, so only the alpha post-mask
  from `depth.ts`'s `gammaRescaleAndMask()` was applied (gamma twice would
  double it).
- Panel 3 is deliberately **not** reused: the user wants the new
  soft-stepped mcimask style (reference
  `~/Desktop/panel3-soft-stepped-mcimask.mp4`).

## Earlier session (2026-09-30), on `real-15s-60fps`

1. **Matte (panel 4) glitch repair** added to `matte.ts`
   (`repairGlitchedFrames()`). 9 frames were repaired on the 15s job. See
   the full-length caveat above.
2. **Depth (panel 5) corner artifacts**: `depth.ts` re-applies the alpha
   mask after gamma/rescale. `depth-anything-v2` was tested and rejected
   (it ignores alpha).
3. **Outline (panel 6)** regenerated for the same 9 frames.
4. **`dream.ts`** always appends `NO_PEOPLE_SUFFIX` (also in CLAUDE.md).
5. `real-15s-60fps`'s panel 3 can't be cheaply patched, because its
   `3-background/plate` is gone. Fixing it needs a background-plate re-run.
   Now ~91 keyframe calls with the keyframe-only change. Not done.
6. Filed `plans/backlog/frame-preview-approval-tool.md`.

## Tasks

- [x] Confirm drive access
- [x] Investigate legacy frame reuse (feasible for every panel except 3)
- [x] Decide scope: the whole 214.8s song from `main-compiled-full.mov`
- [x] `init` `.jobs/full-video` and populate panels 2/4/5/6 from legacy
- [x] Panel 3: flux keyframes (superseded), ProPainter and MiniMax spikes,
      then Bria with crossfades, approved by the user
- [x] Panel 1 as frames (`words` step)
- [x] Panel 7: import the 10 legacy dreams under readable ids, at 10fps
- [x] Rename the client's dream ids to match
- [x] Job layout cleanup (`0-source`, numbered panel folders, `job.json`,
      `take.json`, `final/` output folder)
- [x] Compose one dream end to end (`lush-and-light`), reviewed by the user
- [x] Fix the stray legacy frames the review found (panel 2 frames 142 and
      802, panel 3 frame 142)
- Moved to [`phase-4f`](../in-progress/dreams.md):
  compose all ten, publish, sync R2, deploy
- Dropped: confirm flux-fill-pro's per-call price (flux no longer used);
  fix `real-15s-60fps`'s panel 3 (that job isn't used for anything)
- Still open, tracked in 4f's review: `repairGlitchedFrames` needs tuning
  before it's trusted on long footage, and its 80 flags on this job were
  never reviewed one by one

## Open questions

All resolved or moved:

- Flux prompt wording, `scoreLeak` and the arms-wide haze: moot, flux is no
  longer used for panel 3.
- `real-15s-60fps`'s offset within the song: still unknown, still only
  matters if something from that job gets reused.
