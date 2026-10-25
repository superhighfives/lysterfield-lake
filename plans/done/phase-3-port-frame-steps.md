---
title: "Phase 3: scaffold apps/pipeline and port init/matte/background-plate/depth/artwork/background/upscale"
status: Complete
created: 2026-08-18
updated: 2026-08-29
---

# Phase 3: scaffold apps/pipeline and port init/matte/background-plate/depth/artwork/background/upscale

## Goal

Stand up `apps/pipeline` as a real Bun/TypeScript workspace package and port
every already-decided, already-on-Replicate pipeline step from the old bash/
Python scripts. This is the first "Phase 3" bullet in the parent plan —
`outline`/`dream` (the model-audit-dependent steps) are deliberately excluded
and get their own follow-up spec once this lands, since they depend on the
Cog model push and Kling integration being wired up separately.

This is phase 3 of
[`rebuild-pipeline-as-replicate-cli.md`](rebuild-pipeline-as-replicate-cli.md)
— see that document for full architecture and the model inventory table.
This spec only covers phase 3's own scope and the exact technical parameters
extracted from the legacy scripts.

## Context

**Source of truth for exact parameters**: `generate-init.sh`,
`generate-init-alpha.sh`, `main.py`, `background.py`, `other.py`,
`generate-watercolour.sh`, `generate-background.sh`, `generate-other.sh` in
`lysterfield-lake-pipeline` (tracked repo, byte-identical to the external
drive copy per phase 0's diff). `main.py` and `background.py` are
byte-identical files — the only difference between the "artwork" and
"background" steps is which frame folder they're pointed at, driven by the
orchestrating shell script's `-i`/`--input` flag, not anything in the Python
itself. Port that as one shared step function parameterized by input frames,
not two near-duplicate files.

**Live Replicate schemas have already drifted from what the scripts show** —
confirmed by fetching each model's current `openapi_schema` directly rather
than trusting the old HTTP call shapes:

- `cjwbw/real-esrgan` dropped the old `version: "General - RealESRGANplus"`
  enum param entirely. Its current input is just `image` + `upscale` (int,
  default `4`). The old scripts also used a different key name (`img`, not
  `image`) — an artifact of the old local Cog server, not something to
  carry forward.
- `gwang-kim/diffusionclip` gained two params the old scripts never set:
  `manipulation` (default `"ImageNet style transfer"`) and
  `degree_of_change` (default `1`). Its defaults already match what the old
  script hardcoded (`edit_type: "ImageNet style transfer - Watercolor art"`,
  `n_test_step: 12`) — confirmed `"ImageNet style transfer - Watercolor
  art"` is still a valid enum value today, so this one param hasn't drifted,
  just gained neighbors. Use the defaults for the two new params.
- `cjwbw/zoedepth` takes `image` + `model_type` (enum `ZoeD_N`/`ZoeD_K`/
  `ZoeD_NK`, default `ZoeD_N`) — matches the old script, which never set
  `model_type` either (relied on the same default).
- `arielreplicate/robust_video_matting` takes `input_video` (a whole video,
  not per-frame!) + `output_type` (enum `green-screen`/`alpha-mask`/
  `foreground-mask`, default `green-screen` — **must be set to
  `alpha-mask`**, the default is wrong for this pipeline).

Current `latest_version` ids (informational — pin at implementation time,
don't hardcode into this spec as they can move): `gwang-kim/diffusionclip`
`a64682eb…`, `cjwbw/zoedepth` `6375723d…`, `cjwbw/real-esrgan` `d0ee3d70…`,
`arielreplicate/robust_video_matting` `73d2128a…`, `jd7h/propainter`
`e5ea7ae0…`.

**Version pinning turned out not to be optional.** Discovered while
smoke-testing `matte.ts`: the `"owner/name"` latest-version shorthand (both
`replicate.run()` without a version and the `/v1/models/{owner}/{name}/
predictions` REST endpoint it calls) 404s for every single model this
pipeline uses — confirmed against all five. Only the explicit
`"owner/name:version"` form (or `/v1/predictions` with a `version` field)
works. Not something the parent plan's design anticipated — `replicate.ts`
and every step must always call through a pinned identifier; see
`src/models.ts` for the single source of truth.

**`background-plate` has no direct legacy equivalent to port** — the old
approach (`pc-settings/script.sh` + `video-inpaint-anything/
remove_anything_video.py`) ran SAM (`vit_h`) + LaMa (`big-lama`) + STTN by
hand on a PC, splitting the video into 5-second segments, clicking a fixed
point (`--point-coords 256 256`) to select the subject, `--dilate-kernel-
size 30`, at 60fps, then concatenating segments back together. Per the
parent plan, the new version should be driven by the alpha matte instead of
a manual click. Searched Replicate for a fit: **`jd7h/propainter`**
(`video` + `mask` — accepts a static image or video mask, `mode:
video_inpainting`, `save_fps`) is a proper temporally-consistent video
object-removal model, a strictly better match than re-running frame-by-frame
LaMa (`allenhooo/lama`, image-only, would flicker frame to frame with no
temporal consistency). Use ProPainter with the matte step's alpha-mask
video as `mask` directly — no manual segmentation needed at all.

**Depth step has real postprocessing to replicate**, not just a model call.
Before calling ZoeDepth, `other.py` composites the frame onto a **transparent**
background using the alpha matte (`Image.new(mode="RGBA", color=(0,0,0,0))`,
paste with the alpha as mask, resize to 1024×1024, convert to RGB before
sending — matting the subject out, not in, is intentional: it's masking
everything except the depth-relevant subject). After the model call, it
gamma-corrects (`skimage.exposure.adjust_gamma(result, 1.0/2.2)`) then
rescales intensity to a narrow high band (`skimage.exposure.rescale_intensity(
result, (235, 255))`) — this specific narrow rescale is why the depth panel
reads as it does in the final composite; get this math right, there's no
`skimage` equivalent to reach for in TS, hand-roll both steps.

**Upscale runs twice per frame**, once each on the artwork output and the
background-artwork output (`other.py`'s `resized` and `resized-background`
sub-blocks) — same model, same params, two different input folders. Port as
one step function called twice, not two step files.

**Frame/directory conventions to preserve**: 4-digit zero-padded PNG frame
numbers (`%04d.png`) throughout, matching the legacy scripts exactly —
`job.ts`'s working-directory layout should keep this convention so a human
comparing output trees against the old pipeline's `output/` folder can
still make sense of it. Idempotency in the old scripts is a same-shaped
check everywhere: skip a frame if its output path already exists
(`if not os.path.exists(...)` in Python, `[ ! -f ... ]` in bash) — `job.ts`
centralizes this instead of repeating it in every step.

**`init` needs no model** — pure `ffmpeg`/`ffprobe`. From
`generate-init.sh`: crop to a square capped at 2160px
(`crop=w='min(min(iw\,ih)\,2160)':h='min(min(iw\,ih)\,2160)',scale=2160:2160,
setsar=1`), extract frames at a configurable fps (default 60,
`-r $frames`), then compile two reference videos — a 1024-wide "original"
(`scale=1024:-1`) and a full-res "full" (no scale) — both `libx264`/
`yuv420p`. `generate-init-alpha.sh` does the mirror operation once alpha
frames exist (compiles `output/alpha/%04d.png` into a 1024-wide video) — a
useful example of the "compile a frame folder into a reference video" shape
that recurs after every per-frame step, not just alpha.

## Approach

### Package scaffold

`apps/pipeline/` as a Bun workspace package (matches the root's `bun.lock`/
`bunfig.toml` from phase 1): `package.json`, `tsconfig.json` (mirror
`apps/client`'s strict-mode settings — ESM, bundler resolution — swap
`jsx`/DOM lib for a Node-only lib set), `.env.example` documenting
`REPLICATE_API_TOKEN`, `src/` per the parent plan's layout:

```
apps/pipeline/
├── src/
│   ├── steps/
│   │   ├── init.ts
│   │   ├── matte.ts
│   │   ├── background-plate.ts
│   │   ├── artwork.ts          # shared by "artwork" and "background" — see below
│   │   ├── depth.ts
│   │   └── upscale.ts
│   ├── replicate.ts
│   ├── job.ts
│   └── cli.ts                  # minimal — enough to run one step in isolation
└── package.json
```

`artwork.ts` exports one function taking an explicit input-frames directory,
called once for the raw frames and once for the background-plate frames —
don't create a separate `background.ts` that duplicates it, matching the
legacy `main.py`/`background.py` finding above.

### `replicate.ts`

Thin client: read `REPLICATE_API_TOKEN` from `.env`, create a prediction,
poll until terminal state. Real behavioural difference from the old
scripts — Replicate's hosted API is async (create → poll), the old scripts
called a local Cog server synchronously and got the result inline. Every
step module goes through this, not raw `fetch` calls.

### `job.ts`

Per-run working directory (mirrors the legacy `output/<scene>/...` tree),
concurrency cap for per-frame steps (artwork/background/depth/upscale — the
ones that fan out to one Replicate call per frame), and the shared
skip-if-exists idempotency check described above. Also owns the "compile a
frame folder into a reference video" ffmpeg helper (the pattern used
repeatedly across `generate-*.sh` after every per-frame step) so step
modules don't each reimplement it.

### Steps

- **`init.ts`**: ffmpeg crop/scale/extract per Context above. No Replicate
  call.
- **`matte.ts`**: one `arielreplicate/robust_video_matting` call against the
  init step's cropped video, `output_type: "alpha-mask"`. Video-level, not
  per-frame — extract the returned alpha video into `%04d.png` frames
  afterward to keep the rest of the pipeline's frame-based contract intact.
- **`background-plate.ts`**: one `jd7h/propainter` call, `video` = the init
  step's cropped video, `mask` = the matte step's alpha-mask video,
  `mode: "video_inpainting"`, `save_fps` matching the init step's fps.
  Output is the "background" plate directly — extract frames the same way
  as matte, feeding `artwork.ts` a second time for the "background artwork"
  panel.
- **`artwork.ts`**: per-frame `gwang-kim/diffusionclip`, `edit_type:
  "ImageNet style transfer - Watercolor art"`, `n_test_step: 12`, defaults
  for `manipulation`/`degree_of_change`. Called against init's raw frames
  (artwork panel) and again against background-plate's frames (background
  panel).
- **`depth.ts`**: per-frame — composite onto transparent background using
  the matte's alpha (not white; see Context), resize 1024×1024, call
  `cjwbw/zoedepth` with defaults, then gamma-correct + narrow-range
  rescale exactly as `other.py` does.
- **`upscale.ts`**: per-frame `cjwbw/real-esrgan`, `upscale: 4` (current
  default — confirm this still matches the old pipeline's visual target
  before locking it in, since the old `version` param is gone and there's
  no longer a direct equivalent to compare against). Called once against
  artwork output, once against background-artwork output.

### Testing shape

Per the parent plan: "each step should be runnable and testable in
isolation against a single frame before wiring into the full CLI." The
minimal `cli.ts` in this phase should support that — invoke one step by
name against a small local input and inspect the output — not a full
`lysterfield generate` end-to-end command yet (that's phase 4, once
`compose.ts` and client-manifest writing exist too).

## Tasks

- [x] Scaffold `apps/pipeline` (package.json, tsconfig.json, `.env.example`,
      `src/` layout)
- [x] `replicate.ts` — auth, create + poll predictions
- [x] `job.ts` — working directory, concurrency cap, skip-if-exists,
      compile-frames-to-video helper
- [x] `init.ts` — crop/scale/extract, compile original + full reference
      videos
- [x] `matte.ts` — Robust Video Matting, alpha-mask output, frame extraction
- [x] `background-plate.ts` — per-frame LaMa (ProPainter, the original
      pick, turned out not to work at all — see Architecture)
- [x] `artwork.ts` — DiffusionCLIP, shared function for artwork + background
      panels
- [x] `depth.ts` — transparent-composite preprocessing, ZoeDepth call,
      gamma + rescale-intensity postprocessing
- [x] `upscale.ts` — Real-ESRGAN, called against both artwork outputs
- [x] Minimal `cli.ts` to run one step in isolation against a small local
      input
- [x] Smoke-test each step against a real frame/short clip (e.g. from the
      external drive's `main.mov`) before considering the phase done —
      ran the full chain end to end via the CLI, not just each step alone

## Open questions

- **Resolved — Real-ESRGAN's `upscale` factor**: `4` (the model's default)
  confirmed good visually — DiffusionCLIP's native 512×512 output upscales
  cleanly to 2048×2048, sharp with no artifacting. That's larger than the
  legacy pipeline ever needed (its compiled reference videos were all
  scaled to 1024-wide) — fine, since final sizing happens in phase 4's
  `compose.ts` hstack regardless of how much headroom upscale produces.
- **Resolved — `background-plate` model**: ProPainter doesn't work at all —
  its Cog wrapper's mask-extension validation fails against every
  Replicate-hosted file URL, reproduced via raw API calls with clean,
  freshly-uploaded URLs (a bug in that model, not our upload). Switched to
  the anticipated fallback, per-frame `allenhooo/lama`. Mechanically
  correct (confirmed: cleanly erases whatever region the mask marks), but
  smoke-testing surfaced a separate, real content-quality issue worth
  tracking into phase 5's parity check rather than solving now: Robust
  Video Matting's alpha output for the test clip (a person standing mostly
  still, gesturing with one arm) only tracked the moving arm, not the full
  body — so `background-plate` only erased the arm, not the person. Worth
  revisiting matte quality (dilate the mask before inpainting, matching the
  legacy SAM step's own `--dilate-kernel-size 30`; or try `model_type`
  variants) once there's a full real scene to test against, not blocking
  the rest of phase 3's step-by-step porting.
- **Resolved — `artwork.ts` no longer uses DiffusionCLIP** (2026-08-28):
  `gwang-kim/diffusionclip` (a 2022, cog 0.4.1 community model) hit a
  genuine 3-hour boot hang while smoke-testing phase 4 — the same
  "abandoned old image, unreliable Replicate infra" failure mode as
  `outline`'s pre-fix GPU builds (see phase 3b), except this model isn't
  ours to rebuild. A follow-up isolated test confirmed it does still work,
  just with an unreliable cold boot (sometimes 7+ minutes). Replaced with
  Google's official `nano-banana-2`: the same source frame plus a fixed
  `resources/style/watercolor-reference.png` (a real DiffusionCLIP
  watercolor output, kept as the canonical style target rather than
  depending on a model checkpoint) passed via `image_input`, with a prompt
  asking it to match that reference's technique. Compared side by side
  against DiffusionCLIP's own output on the same frame — matched the style
  convincingly, arguably cleaner than DiffusionCLIP's blurry 512×512
  native output, while being fast (~14s) and reliable. `replicate.ts`
  gained `uploadFileOnce()` so the fixed style-reference image is uploaded
  once per `artwork()` call rather than re-uploaded on every frame.
  Worth revisiting for phase 5's parity check: nano-banana-2's output
  resolution (roughly matches the ~1024×1024 input, well above
  DiffusionCLIP's 512×512) means `upscale.ts`'s `upscale: 4` now produces
  much larger intermediate files than before for no visual benefit, since
  `compose.ts` downsamples every panel back to 1024×1024 regardless —
  not incorrect, just wasted work worth tuning later.

## Overview

`apps/pipeline` is now a real Bun/TypeScript CLI package with six working
pipeline steps — `init`, `matte`, `background-plate`, `artwork` (shared
between the artwork and background panels), `depth`, and `upscale` — plus
the shared infrastructure (`replicate.ts`, `job.ts`, `models.ts`) they run
on. Every step was smoke-tested against real footage from the external
drive's `main.mov`, both individually and chained end to end through a
minimal `cli.ts`, with real Replicate spend. `outline` and `dream` remain
out of scope (their own follow-up phase, per the parent plan).

## Architecture

`src/replicate.ts` wraps the official `replicate` npm client with two
project-specific concerns: pinned model versions (see below) and
`readFileAsInput()`, which uploads local files as a properly-named `File`
rather than a raw `Buffer` — several models validate the uploaded
filename's extension server-side and reject the generic `buffer_<timestamp>`
name the client gives a bare `Buffer`. `src/job.ts` centralizes the
working-directory layout (`<job>/video/`, `<job>/frames/<name>/`), the
skip-if-exists idempotency check every legacy script had inline, and the
recurring compile-frames-to-video ffmpeg pattern. `src/models.ts` is the
single source of truth for pinned model versions.

**Deviations from the spec, both discovered by smoke-testing rather than
assumed up front:**

1. **Every model needs an explicitly pinned version.** The spec listed
   current version ids as "informational," expecting the `"owner/name"`
   latest-version shorthand to work day to day. It doesn't — confirmed
   404ing for all five models this phase uses, both via `replicate.run()`
   and the raw REST endpoint it calls. `models.ts` is not optional
   convenience; it's load-bearing.
2. **`background-plate` doesn't use ProPainter.** The spec's pick
   (`jd7h/propainter`, chosen for temporal consistency over frame-by-frame
   LaMa) fails its own mask-extension validation against every
   Replicate-hosted file URL — reproduced via raw API calls with clean,
   freshly-uploaded URLs, so it's a bug in that Cog model, not our upload.
   Shipped the spec's own anticipated fallback instead: per-frame
   `allenhooo/lama`, driven by the matte's alpha frames through `job.ts`'s
   `forEachFrame`. Mechanically correct; real flicker-across-frames risk
   from going per-frame instead of per-video is untested at full-clip
   length, tracked for phase 5.
3. **`depth.ts`'s pixel manipulation uses `sharp`, not a straight port of
   the Python.** The legacy pre/post-processing (transparent-background
   compositing via an alpha mask, then a specific gamma-correction +
   narrow-intensity-rescale) used PIL and `skimage`, which have no direct
   TS equivalent — reimplemented as raw-buffer math and a 256-entry lookup
   table (`gammaAndRescale` in `depth.ts`). Confirmed matching visually
   (correct high-contrast depth mask) but not verified byte-for-byte
   against the original Python's output.
4. **`artwork.ts` doesn't use DiffusionCLIP** (added 2026-08-28, after
   phase 4 smoke-testing surfaced a 3-hour boot hang on that model). First
   replaced with `google/nano-banana-2`, steered to DiffusionCLIP's
   watercolor look via a fixed reference image passed through
   `image_input` alongside each frame. See the Open Questions entry above
   for that comparison and the upscale-factor follow-up it left open.
   **Updated again 2026-08-29** (phase 5's real-footage cost check):
   `nano-banana-2` at $0.07/call, called twice per frame, made a full
   scene ~$80+ even at a modest 2fps — replaced with `black-forest-labs/
   flux-kontext-dev` ($0.03/call, an official open-weights image-editing
   model), which also turned out more temporally stable frame-to-frame on
   real footage and needs only a text prompt, no style-reference image —
   `uploadFileOnce()` and `resources/style/watercolor-reference.png` were
   removed as a result. See
   [`plans/in-progress/phase-5-end-to-end-parity-check.md`](../in-progress/phase-5-end-to-end-parity-check.md)
   for the full comparison, including a still-open temporal-flicker gap
   against the original published videos that neither model fully closed
   on its own.

Not a deviation, but worth flagging for phase 4/5: DiffusionCLIP's native
output is 512×512, and Real-ESRGAN's default `upscale: 4` takes that to
2048×2048 — well past the legacy pipeline's 1024-wide compiled reference
videos. Confirmed good visual quality; final sizing is `compose.ts`'s
problem in phase 4, not something resolved here. (Superseded by
deviation 4 above — the artwork panel's native resolution changed again
with the DiffusionCLIP → nano-banana-2 swap.)
