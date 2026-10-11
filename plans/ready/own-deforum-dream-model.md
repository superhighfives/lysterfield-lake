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
the legacy recipe on it ran on 2026-10-11 (`.jobs/spikes/dream-deforum/`).

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

- [ ] Finish scanning the Linux backup; extract the Deforum checkout,
      weights and environment if present
- [ ] Build `models/deforum/` and run it locally (cog) on a short clip
- [ ] Push `superhighfives/lysterfield-deforum` (private) and time a run;
      estimate the cost of a full song
- [ ] Verify against lush-and-light
- [ ] `dream.ts` deforum method, wired into the preview loop

## Open questions

- GPU tier: A100 vs L40S, once a run is timed. A full song is ~2,148 frames
  at 50 steps; expect hours per take, so chunking and resume matter.
- Watercolour's folder has no saved colour image; its settings point at a
  fixed `colormatch_image` URL instead. Check how that dream's colour was set.
- Keep the 60fps init (legacy) or feed 24fps with a matching frame skip? The
  legacy frame timing is already mapped, so 60fps keeps new takes identical
  in timing to the old ones.
