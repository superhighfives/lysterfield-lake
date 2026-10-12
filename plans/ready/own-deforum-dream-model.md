---
title: Our own Deforum dream model, rebuilt from the legacy setup
status: Ready
created: 2026-10-11
updated: 2026-10-11
---

# Our own Deforum dream model, rebuilt from the legacy setup

## Goal

Make new dream (panel 7) takes the way the ten published dreams were made,
on Replicate: Deforum 0.7.1 with the hand-edited script, render changes,
settings, negative prompt and colour references from the legacy PC. This is
the baseline the app is built around; other, more temporally consistent
methods can be explored against it later.

## Context

**What makes the legacy dreams work:** the subject's shape without the
subject. A raised pair of hands becomes rock spires, a walking figure a jetty,
head and shoulders a red rock and its reflection. See the comparison in
`.jobs/spikes/dream-model-bakeoff/` and the user's note on 2026-10-11.

**How Deforum did it** (from `video-final/dreaming/<id>/<id>_settings.txt`
and `pc-settings/` on the HDD):

- Init video = panel 2 (`main-compiled-resized-images.mov`, 60fps), every
  6th frame (`extract_nth_frame: 6`, 10 frames per second of song); mask
  video = the matte (`main-compiled-alpha.mov`, `use_mask_video`).
- 3D animation mode with depth warping (MiDaS weight 0.3, near 200, far
  10000, fov 40, reflection padding); hybrid video: composite on (alpha 1.0,
  mask blend 0.65, auto contrast), motion "Perspective".
- Each frame starts from the previous dream frame, warped by the footage's
  motion, so the picture stays landscape and the subject only steers it.
- Strength schedule 0.5, noise 0.04, euler_ancestral, 50 steps, CFG 7,
  1024×1024, fixed seed, Protogen V2.2 checkpoint.
- **Prompt:** landscape only (e.g. "aesthetic landscape picture with lake,
  detailed, vibrant colors, HDR, ~*~Enhance~*~, ~*~Ghibli~*~").
- **Negative prompt:** a long hand-written list excluding people and body
  parts (face, head, person, hand, arm, body, skin, figure, man, woman,
  clothes...), in `pc-settings/Deforum_Stable_Diffusion.py`.
- **Colour:** `pc-settings/render.py` adds `Random`, `Specific` and `Sticky`
  colour-coherence modes. `Random` (used by nine dreams) colour-matches every
  frame to an image picked from `Dreaming/Colours/` (15 images, in
  `backups/Dreaming/Colours/` on the HDD); each dream's folder records which
  one (e.g. lush-and-light used `08.png`).
- `Deforum_Stable_Diffusion.py` was hand-edited into a CLI: `-p` prompt,
  `-f` frame skip, `-c` colour mode, `-s` specific colour image, `-i` init
  video type, `-r` resume, `-t` test.
- Base: `deforum-art/deforum-stable-diffusion` branch `0.7.1` (last commit
  2023-10). That is effectively the final standalone release; `main` only got
  notebook touch-ups until a "last commit" in July 2024. The A1111 extension
  (`sd-webui-deforum`) also stopped in 2024.

**Hosted alternative:** `deforum-art/deforum-stable-diffusion` on Replicate
is a 2023 build of the same project with most of these inputs (video init,
mask video, hybrid composite, depth warping, Protogen), but not the custom
colour modes, the DIS flow method, or a negative prompt. A 5s prototype of
the legacy recipe on it (2026-10-11, `.jobs/spikes/dream-deforum/`, 60
frames in 1,084s, ~18s a frame) **kept a person** (a different face in the
subject's pose) where the legacy run made a red tower and its reflection. So
the negative prompt, the colour reference and the CLIP/aesthetics guidance
are what make the legacy look, and the hosted build can't do it.

**The legacy checkout itself** is in the HDD's Linux backup
(`~/ai/deforum-stable-diffusion`): upstream `main` @ `40f5c2e` (2023-06-02,
"Merge 0.7.1"), plus the user's commits and edits to `render.py`,
`conditioning.py` (weighted CLIP prompts split on `=`) and the notebook
script. The legacy settings use `clip_scale` and `aesthetics_scale` 50, so
CLIP ViT-L/14 guidance was on. `~/ai/dsd-cog` is an unmodified upstream
clone. `models/deforum/fetch.sh` pins `40f5c2e` and applies both edits.

**Why not a simpler model** (tested 2026-10-11, `.jobs/spikes/`):

- Per-frame image models from panel 2 (`dream-model-bakeoff/`): flux-kontext
  and low-strength img2img keep the person; flux img2img at 0.65 and flux
  depth/canny invent a new person in his pose. Only SDXL img2img at 0.65
  turned the close-up into landscape the way Deforum does, and not reliably
  (the walk-away kept a figure).
- A hand-rolled SDXL feedback loop (`dream-sdxl-feedback/`: previous dream
  frame + panel 2 inside the matte, img2img 0.5) collapsed into saturated,
  posterised noise after one frame. Deforum's colour coherence, noise
  schedule and depth-warped motion are what keep its loop stable.

**First run (2026-10-11):** `superhighfives/lysterfield-deforum` on an A100
reproduces the legacy look. With lush-and-light's prompt, seed and colour
reference, a 12-frame warm-up ending on the shouting close-up (frame 4033)
converges from a plain lake (Deforum's first frame has no init) to a red tree,
a red house and then the red rock and its reflection, the same composition
and palette as the published frame, with no person. ~21s a frame (CLIP and
aesthetics guidance on), 253s for the run plus ~2 min cold boot; roughly
$0.35 a sample run if the A100 rate is ~$0.0014/s (unconfirmed). A full song
at 12 dream frames/s is ~2,580 frames, ~15h of GPU, roughly $75.

**Build notes:** Cog 0.21's `python_requirements` step fails on GPU images
(`uv run pip install` vs uv's managed Python, PEP 668), so packages install in
a `run:` step with `uv pip install --system --index-strategy unsafe-best-match`
and torch from the cu116 index. Upstream's `triton==2.0.0.dev20221202` is gone
from PyPI and isn't needed; `pydantic` 1.10 had to be added (Cog used to ship
it). Cog 0.13 builds fine but validates the schema by starting the container
on a GPU, which fails on a Mac.

**Chained runs (2026-10-11):** the clip and the full song are a chain of
runs of 48 dream frames (~17 minutes each), strictly one after another. The
model takes a `previous_frame` input: the last frame of the run before, which
it loads through Deforum's own resume path (`resume_from_timestring`) with an
init video that starts on that same frame. This is only the same as one long
run because nothing in the legacy presets is keyframed over time (every
schedule is a single value, `seed_behavior` is fixed, the sampler schedule is
off); the model refuses to continue a run where that isn't true, or with a
colour mode that matches the take's first frame. Each run's prediction id is
saved before waiting on it, so a stopped pipeline picks the same prediction
back up instead of paying for another, and a failed one is never rerun
without deleting its `prediction.json`. Replicate keeps output files for
about an hour, so a run that finished while the pipeline was stopped for
longer than that has to be made again.

Checked 2026-10-11 (`.jobs/spikes/deforum-chain-test/`, `seam.jpg`): 12 dream
frames from job frame 2901 as one run and as a chain of two runs of 6. The
chain carries straight across the join, and the two differ no more after it
than before it (PSNR ~30dB throughout: two runs of the same settings are not
bit-identical on the GPU, even with a fixed seed).

**A person can still appear (2026-10-11).** That same test, started cold on
the walk-away with lush-and-light's prompt, seed and colour reference, drew a
person walking away from its third frame on, where the published
lush-and-light shows none at that moment. The `neon-dream` take's "after the
cut" sample (frame 4501) also shows a person from behind; its other four
samples don't. So the legacy negative prompt is not a guarantee in this
rebuild, the result depends on the frames leading up to a moment, and both
leaks are back views without a face. Not yet understood. Until it is, every
stage needs a person check by eye, and a full song should not be started on
the strength of clean samples alone.

Runs can't be parallel without changing the look: each frame depends on the
one before. So a full song is ~15 hours of wall-clock time however it is
split.

The 15-second clip is its own chain (`preview/dream/`), with a one-second
warm-up that is thrown away, and is not reused by the full song: a clip from
the middle of the song isn't what a run from frame 1 will make there.

Cog 0.21 treats `x: Path = Input(default=None)` as a required input; optional
inputs need `Optional[...]`. Before this was fixed (version `06f47531…`),
takes with colours "from the footage" could not have run.

## Approach

1. **Recover the exact environment.** Check `backups/Linux Backups/
   ubuntubackup.tar` (202GB, being scanned) for the legacy
   `deforum-stable-diffusion` checkout, models folder (Protogen, MiDaS,
   AdaBins) and conda environment. If it isn't there, rebuild from branch
   `0.7.1` + `pc-settings/`.
2. **Cog model `models/deforum/`** (private, GPU):
   - Deforum 0.7.1, with `pc-settings/render.py` and the edited
     `Deforum_Stable_Diffusion.py` adapted to take its arguments from Cog
     inputs instead of argparse, and paths from the container instead of
     `/mnt/c/Users/hi/...`.
   - Weights baked in: Protogen V2.2, MiDaS (dpt_large), plus anything else
     0.7.1 loads at start-up.
   - The 15 colour references baked in; `Random`/`Specific`/`Sticky` work as
     before, with `Specific` choosing by name so a take is reproducible.
   - Inputs: prompt, negative prompt (default: the legacy list), init video
     (panel 2), mask video (matte), colour mode + image, seed, frame skip,
     frame range and resume, plus a settings JSON for everything else
     (default: lush-and-light's settings).
   - Output: a zip of frames (with the settings and colour image used).
3. **Verify against a legacy dream:** run lush-and-light's exact settings and
   colour image on a few seconds and compare with its published frames.
   Diffusion on different hardware won't be bit-identical, but the look,
   palette and "shape without the person" should match.
4. **Pipeline step:** `dream.ts` gets a `deforum` method alongside
   flux-kontext: it builds the init and mask videos from the job's panel 2
   and matte, runs the model in chunks with resume, and maps the output
   frames onto the job's 24fps frames the same way the legacy dreams were
   imported (phase 4e's Dreams section). The preview loop's samples and
   clip stages use it too.

## Tasks

- [x] Find the legacy checkout in the Linux backup (`~/ai/deforum-stable-diffusion`)
- [x] Build `models/deforum/` (fetch.sh pins the legacy base `40f5c2e` + legacy render.py/conditioning.py)
- [x] Push `superhighfives/lysterfield-deforum` (private, A100) and time a run
- [x] Verify against lush-and-light (one sample; see First run)
- [x] `dream-deforum.ts` samples, wired into the preview loop and /admin
- [x] Deforum for the 15s clip and the full song (chained runs that pick up where they stopped; `dream-clip` and `dream`, and both from /admin)
- [ ] Find out why back views of the subject can come through as a person (walk-away, after the cut) when the legacy run's didn't; compare init video, matte and composite settings against the legacy run at those moments
- [ ] Run a real 15s clip and a real full song for a new take

## Open questions

- GPU tier: A100 vs L40S, once a run is timed. A full song is ~2,148 frames
  at 50 steps; expect hours per take, so chunking and resume matter.
- Watercolour's folder has no saved colour image; its settings point at a
  fixed `colormatch_image` URL instead. Check how that dream's colour was set.
- Keep the 60fps init (legacy) or feed 24fps with a matching frame skip? The
  legacy frame timing is already mapped, so 60fps keeps new takes identical
  in timing to the old ones.
