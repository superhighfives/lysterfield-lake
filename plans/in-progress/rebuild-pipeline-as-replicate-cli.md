---
title: Rebuild the pipeline as a single Replicate-driven CLI in a unified lysterfield repo
status: In Progress
created: 2026-08-16
updated: 2026-10-09
---

# Rebuild the pipeline as a single Replicate-driven CLI in a unified lysterfield repo

## Goal

Replace the current hand-run pipeline — 8 bash scripts chaining ffmpeg, three
local Cog model servers, a custom local PyTorch model, and a manual
Deforum/RIFE pass on a gaming PC — with a single Node/TypeScript CLI that
takes one iPhone video and produces every asset a scene needs (artwork,
artwork background, matte, depth mask, outline, unique dream video, and the
final composited video), driven almost entirely by Replicate. Land it,
alongside the existing client, in one new repo: `lysterfield`.

## Context

**Current architecture** (`lysterfield-lake-pipeline`, see its README): eight
`generate-*.sh` scripts, run manually in sequence, each idempotent via
`[ -f ... ] || do-the-thing` checks. They shell out to `ffmpeg`/`ffprobe`
directly and to a handful of Python scripts (`main.py`, `background.py`,
`other.py`) that call three **local** Cog model servers on the home network
(`superuniverse.local:5000/5005/5010`). `other.py` also loads a local PyTorch
checkpoint (`video-artline/torch_650.pkl`) for the pencil-sketch step, and
does image compositing (matte cutout, depth/sketch blending) with Pillow/
`blend_modes`. Separately, `pc-settings/` holds a Deforum Stable Diffusion
script run by hand on an RTX 3060 PC to generate the "dreaming" animation per
scene, and `interpolator.py` patches gaps in that output using
`rife-ncnn-vulkan` (also local/PC-only). `halftone.py` exists in the repo but
isn't called from any `generate-*.sh` script — confirmed abandoned (you tried
it, it looked wrong, and dropped it before it ever shipped). It's dead code
and won't be ported.

**The client** (`lysterfield-lake`) is a Vite/React/R3F app that reads a
static `dreams/<id>/...` folder plus `src/dreams.json`
(`{id, title, link, prompt}[]`, kept in sync by `scripts/generate-dreams.js`)
and expects, per scene, pre-rendered `.mov`/`.webm` outputs (the 7-way
composited video, a loop clip, and preview JPGs) already sitting in that
folder. It has no opinion on how those got there.

**The output shape** (see the reference frame image in this conversation):
seven horizontally-stacked panels per scene — lyrics, artwork, artwork
background, matte, depth mask, outline, and the unique dream video — muxed
with `resources/audio/lysterfield-lake.wav`. That 7-way hstack is exactly
what `generate-videos.sh` does today with `OUTPUT_VIDEO_COUNT=7`.

**Model inventory** — the pipeline README already documents Replicate pages
for every model currently run locally, which changes the migration risk a
lot:

| Step | Current implementation | Replicate today |
| --- | --- | --- |
| Artwork / artwork background (watercolour style transfer) | Local Cog server, DiffusionCLIP (`main.py`/`background.py`) | `gwang-kim/diffusionclip` — already listed, use directly |
| Background plate (input to the background-artwork step) | Confirmed derived, not a second shot: `video-inpaint-anything/remove_anything_video.py` (SAM + LaMa + STTN), run by hand on the PC via `pc-settings/script.sh`, erases the subject from `main-compiled-original.mov` by click-to-select | Not a Replicate model swap — a design simplification: drive an image/video inpainting model off the matte we already generate, instead of click-to-segment |
| Depth mask | Local Cog server, ZoeDepth (`other.py`) | `cjwbw/zoedepth` — already listed, use directly |
| Upscale (artwork + background) | Local Cog server, Real-ESRGAN (`other.py`) | `cjwbw/real-esrgan` — already listed, use directly |
| Matte (alpha) | Confirmed manual/local: run by hand via `video-matting/inference.py` (a local Robust Video Matting clone), never scripted | `arielreplicate/robust_video_matting` — already listed, not yet wired into any script |
| Unique dream video | Confirmed: literally `deforum/deforum_stable_diffusion`, but run locally on an RTX 3060 to avoid Replicate costs at the frame-by-frame volume it needed. The underlying SD1.x checkpoint had a persistent bias toward generating anime-style faces ("a tendency to add waifus"), so bad frames were deleted by hand and the gaps patched by interpolation. | Likely superseded rather than ported as-is — see "Modernizing the dreaming step" below |
| Outline / sketch | Confirmed source: [ArtLine](https://github.com/vijishmadhavan/ArtLine) (a fastai U-Net line-art model), loaded from a local checkpoint (`video-artline/torch_650.pkl`, one of several ArtLine checkpoints on disk) inside `other.py`, blended with the depth map via `blend_modes` | No public Replicate deployment of ArtLine found via search — needs a closer look for a community Cog port; failing that, package the checkpoint as a private Cog model (straightforward, since the model and inference code already exist), or evaluate a modern off-the-shelf Replicate line-art model as a visual substitute |
| Frame gap-fill (RIFE) / resize | Two different tools patched gaps in the deleted-frame Deforum output: `interpolator.py` (scripted, `rife-ncnn-vulkan`) and the Enhancr desktop app (manual, GUI-only, evidenced by `backups/Dreaming/Enhancr/`) | Moot if the dreaming step is replaced by a modern video-generation model (below) — those don't need frame-level curation or gap-filling at all |
| Lyrics | Pre-rendered `resources/words/*.mov` (not per-scene, not AI-generated) | N/A — per your note, lyrics/artwork/artwork-background can just be supplied as PNGs |
| Final 7-way composite + loop/preview generation | `ffmpeg` hstack + `convert` in `generate-videos.sh` | N/A — this is compositing, not model inference; stays local |

So five of eight steps already point at existing Replicate models and mostly
need their local Cog URLs swapped for Replicate API calls. The outline
model and the dreaming lane are the real migration work.

**Modernizing the dreaming step.** The 2023 approach (Deforum run frame by
frame on a local GPU, bad frames deleted by hand, gaps patched with RIFE or
the Enhancr GUI) was a workaround for two things that no longer apply: video
generation models barely existed then, and Deforum's per-frame SD1.x
pipeline was the only way to get an animated result at all. Per your steer,
this is worth rethinking rather than porting faithfully. Two candidates
worth prototyping in Phase 2, both on Replicate today and both supporting a
style-reference image (the "Midjourney-style reference" you asked for,
which is also a cleaner version of what the old `pc-settings/
Deforum_Stable_Diffusion.py` "Colours" palette-matching hack was reaching
for): **Kling 3.0 Omni** (unifies text-to-video, image-to-video, and
reference-to-video in one model) and **Grok Imagine** (accepts up to 7
tagged reference images for character/object/style). Either would take an
extracted frame + a prompt + a style-reference image and generate the
scene's unique animation directly, which — if the visual quality holds up —
collapses the entire old lane (local GPU run, manual frame curation, RIFE/
Enhancr gap-fill, `generate-dreaming.sh`'s minterpolate step) into a single
Replicate call per scene. Worth a side-by-side comparison against an
existing published scene before committing.

**Ground truth from the full project source (Phase 0, checked 2026-08-17,
external drive at `/Volumes/HDD/lysterfield-lake-pipeline`).** The scripts in
`lysterfield-lake-pipeline` are byte-identical on the drive (diffed
`generate-videos.sh`, `main.py`, `other.py`, `interpolator.py`,
`generate-dreaming.sh`, `generate-other.sh` — no differences), but the drive
has folders git never tracked: `video-matting/` (a full clone of Robust Video
Matting, with `.pth` checkpoints and `inference.py`), `video-artline/`
(multiple checkpoints — `torch_650.pkl`, `torch_920.pkl`, `ArtLine_650.pkl`,
`ArtLine_920.pkl`, not just the one `other.py` loads), `swin2sr/` (a second
upscaler, dated 2024 — much later than everything else, likely a later
experiment rather than part of the shipped video), `video-inpaint-anything/`
(genuinely used — see below, not the dead-end it first looked like), and a
`video-final/` folder holding one complete real run's output tree,
and a `backups/Dreaming/` folder holding intermediate working files from the
dreaming lane. Together these fill in what the tracked scripts alone don't
show:

- **Matte generation was a real, manual, undocumented step.** Nothing in any
  `generate-*.sh` produces `output/alpha/*.png` — it was run by hand via
  `video-matting/inference.py` (the local Robust Video Matting clone), not
  through any Cog server. This confirms the plan's existing assumption
  (`arielreplicate/robust_video_matting` is the right Replicate target) —
  it just wasn't a guess, it's now confirmed as the actual missing step.
- **`background.mov` isn't a second shot — it's derived from `main.mov` via
  video inpainting.** `pc-settings/script.sh` (run on the PC, in a
  `inpaint-anything` conda env) splits `main-compiled-original.mov` into
  segments and runs `video-inpaint-anything/remove_anything_video.py`
  (Segment Anything + LaMa + STTN) on each, clicking a point to select and
  erase the subject, then concats the segments back into `background.mov`.
  So the "artwork background" panel isn't a separate plate you shot — it's
  the same footage with the person removed. This is good news for "one
  iPhone video in": the new pipeline can derive the background plate
  automatically instead of asking for a second video, and can do it more
  precisely than the original did — it already has a pixel-accurate alpha
  matte from the `matte` step, so it can drive an inpainting model directly
  off that mask instead of a manual click-to-segment step. Worth adding as
  its own step (`background-plate.ts` or similar) rather than treating
  "artwork background" as a second required input.
- **The real Deforum prompts are not what's in `dreams.json`.** Its `prompt`
  field (e.g. `"A watercolor painting"`) is a short display caption for the
  client UI, not what was fed to Deforum. The actual per-scene prompts and
  full generation parameters survive on the drive at
  `video-final/dreaming/<id>/prompt.txt` and `<id>_settings.txt` (one per
  scene) — elaborate, era-typical prompt-soup (artist names, `<lora:...>`
  tags, even Midjourney-style `--ar`/`--stylize` flags pasted in), and they
  get visibly more complex over the project (later scenes reference an SDXL
  checkpoint + a custom LoRA, `DFunk_SDXL`, instead of the `Protogen_V2.2`
  SD1.5 checkpoint `Deforum_Stable_Diffusion.py` defaults to — consistent
  with the "waifu bias" you remembered being a Protogen/SD1.5 issue they
  moved off later). `<id>_settings.txt` also has a `colormatch_image` field
  — a reference photo URL Deforum used for its own built-in colour-coherence
  feature, per scene. That's the real ancestor of the "Colours" folder and
  the style-reference idea, more directly than the palette-hack guessed
  below — Deforum already had reference-image-driven colour control; it
  just wasn't a full style reference the way Kling/Grok support now. These
  files are good raw material for Phase 2: feed the real per-scene prompt
  (and maybe the same colormatch reference image) into Kling/Grok for an
  apples-to-apples comparison against the original Deforum output, rather
  than reconstructing a prompt from memory or from `dreams.json`.
- **The real run order**, reconstructed from file timestamps in
  `video-final/output/` (a completed run, all times 2023, Pacific):
  1. `main.mov` shot (Jun 30); `background.mov` derived via inpainting (see
     above) — exact timing unclear, but before the Aug 4 session below.
  2. `generate-init.sh` (crop/extract/compile original+full) and
     `generate-watercolour.sh` (artwork) both run **Aug 4, ~11:04–11:20am**.
  3. `generate-background.sh` (background artwork) — same session, ~11:24am.
  4. `generate-other.sh`'s upscale sub-step completes same session (~11:31am)
     — but its depth/green/sketch sub-steps silently no-op, because they
     depend on `output/alpha/` which doesn't exist yet.
  5. **[undocumented]** `video-matting/inference.py` run by hand to produce
     `output/alpha/*.png` — no timestamp evidence for exactly when, but
     before Aug 12.
  6. `generate-init-alpha.sh` (compile alpha video) and the rest of
     `generate-other.sh` (depth, now unblocked) — **Aug 12**.
  7. `generate-title.sh` — Aug 12 (independent, no dependencies).
  8. Deforum runs on the PC per scene, spread across **Aug 8–19** (matches
     the dream IDs themselves, which are literal generation timestamps) —
     entirely separate lane, not gated on any of the above.
  9. **[undocumented, GUI tool]** `backups/Dreaming/Enhancr/` contains a
     project file for **Enhancr** (a consumer desktop app that wraps
     RIFE/Real-ESRGAN) — some resize/interpolate work in the dreaming lane
     went through this GUI, not `interpolator.py`'s scripted
     `rife-ncnn-vulkan` path. `backups/Dreaming/Processing/` and
     `Processing Backup/` (with `input/output/final/splits` subfolders) do
     match `interpolator.py`'s own folder layout, so both tools were likely
     in play at different points — worth deciding on one Replicate-based
     replacement rather than reverse-engineering which was used when.
  10. `generate-other.sh`'s sketch sub-step finally completes — **Aug 22**,
      over a week after depth/alpha, and after most dreaming was already
      generated.
  11. `generate-videos.sh`'s 7-way hstack (`compiled/<id>/<id>-video.mov`) —
      first appears **Aug 23**.
  12. **[undocumented]** `output/main/output/words/*.png` — per-frame lyric
      text-mask frames exist and feed `dreams.py`, but no script generates
      them. They're almost certainly hand-extracted frames from
      `resources/words/words.mov`, done once and reused per scene.
  13. `generate-dreams.sh` (`dreams.py`, which multiply-blends the dream
      frame with the lyric mask) — **Nov 23**, months after everything
      else. Its output (`output/dreams/<id>/<id>.mov`, also copied to
      `compiled/<id>/<id>-dream.mov`) turns out **not to be what the client
      uses** — see below. This looks like a superseded design.
  14. Final export — `output/final/<id>/{video,video-small,loop}.{mov,webm}`
      plus `00–03.jpg` polaroid thumbnails — **Nov 19–27**, the actual
      publish-ready compression pass.
  15. May 2024 edits to `generate-videos.sh`, `generate-watercolour.sh`, and
      a touch on `output/main/` are repo tidy-up before open-sourcing, not
      part of the real generation process.
- **The client's real output contract is stricter than "a 7-way hstack for
  reference"** — it's the literal texture atlas the WebGL shader reads.
  `src/materials/video-material.tsx` samples one video texture at UV offsets
  driven by `uFrameSelected`/`uFrameMask`/`uFrameDepth`/`uFrameSketch`/
  `uFrameOverlay`, all divided by a fixed `uFrameTotal`. `src/views/main.tsx`
  pins `uFrameTotal={7}` and assigns fixed indices matching
  `generate-videos.sh`'s ffmpeg input order exactly: **1 = lyrics/words, 2 =
  artwork, 3 = artwork background, 4 = matte/alpha, 5 = depth, 6 =
  outline/sketch, 7 = dream video.** (Index 4, the matte, masks the artwork
  layer; index 1, the lyrics, masks the dream layer for a text-shaped reveal
  effect; index 3, the background, doubles as an overlay on the "choose"
  screen.) `dreams.py`'s lyric-baked-into-the-dream-layer approach is not
  used anywhere the client reads from — the new pipeline should target the
  7-way atlas as the one deliverable per scene and can very likely drop the
  `dreams.py` step and its per-frame `words/` masks entirely, since the
  shader already does that compositing at render time via index 1.
- **`halftone.py` is confirmed dead** — not in any `generate-*.sh` script,
  no folder on the external drive maps to it, and you confirmed it was an
  idea you tried and dropped because it looked wrong before it ever shipped.
  Not porting it.
- **`backups/Dreaming/Colours/` resolved**: an early, rudimentary attempt at
  steering "themed" visuals with colour palettes — the actual mechanism was
  Deforum's own `colormatch_image` setting (see above), and this folder
  looks like candidate reference images tried for it. The style-reference
  idea above is the properly-supported version of the same instinct.
- **A couple of loose ends that don't block the plan**:
  `backups/Dreaming/Matting/output-outro/` (matting was special-cased for at
  least one extra "outro" scene outside the normal per-song set), and
  `swin2sr/` (present on disk, dated 2024, no evidence it was used in the
  shipped video — likely a later experiment, not required for parity).

**Architecture decision (made 2026-08-16):** build a portable Node/TS CLI
first, not a Cloudflare-hosted service. Workers can't run `ffmpeg` or handle
GB-scale per-frame jobs natively, and the fastest path to "provide one iPhone
video, get a scene" is a script that calls Replicate for every AI step and
composites with local `ffmpeg`, mirroring how the pipeline is already used
today (run by hand, idempotent, resumable). A thin Cloudflare layer (upload
UI, job tracking, R2-hosted output) is a later phase once the CLI is proven
— not blocking now.

## Approach

### Repo layout

```
lysterfield/
├── apps/
│   ├── client/              # current lysterfield-lake, moved as-is initially
│   └── pipeline/             # new Node/TS CLI, replaces lysterfield-lake-pipeline
│       ├── src/
│       │   ├── steps/        # one module per pipeline stage
│       │   │   ├── init.ts          # crop/scale input video, extract frames (ffmpeg)
│       │   │   ├── matte.ts         # Robust Video Matting via Replicate
│       │   │   ├── background-plate.ts  # inpaint the subject out, driven by the matte
│       │   │   ├── artwork.ts       # DiffusionCLIP via Replicate
│       │   │   ├── background.ts    # DiffusionCLIP via Replicate, on the inpainted plate
│       │   │   ├── depth.ts         # ZoeDepth via Replicate
│       │   │   ├── upscale.ts       # Real-ESRGAN via Replicate
│       │   │   ├── outline.ts       # ArtLine (packaged or substitute) via Replicate
│       │   │   └── dream.ts         # modern video model via Replicate — prompt + style-ref image
│       │   ├── compose.ts    # ffmpeg 7-way hstack + audio mux + loop/preview
│       │   ├── replicate.ts  # thin client: run + poll a Replicate prediction
│       │   ├── job.ts        # per-run working directory, idempotent step cache
│       │   └── cli.ts        # `lysterfield generate --input scene.mov --id ... --prompt ... --style-ref ref.png`
│       └── package.json
├── models/                   # any custom Cog models we end up pushing to Replicate
│   └── outline/               # e.g. if video-artline gets packaged
├── plans/
└── package.json               # workspace root (npm/pnpm workspaces, per turbo.json already in client)
```

`apps/client` keeps its existing `dreams/<id>/...` contract unchanged so the
migration doesn't also force a client rewrite — the CLI's job is to produce
exactly the folder structure the client already reads, replacing
`scripts/generate-dreams.js`'s manual bookkeeping with output the CLI writes
directly.

### Pipeline step design

Each file in `src/steps/` wraps one Replicate model behind a small
`(input: StepInput) => Promise<StepOutput>` interface, keeping the same
per-frame, skip-if-exists idempotency the bash scripts already have (a step
checks its output path before calling Replicate again — important given
Replicate calls cost money and time). `src/replicate.ts` centralises auth
(`REPLICATE_API_TOKEN` from `.env`), prediction creation, and polling —
today's Python scripts talk to raw `/predictions` HTTP endpoints
synchronously; Replicate's hosted API is async (create prediction → poll or
webhook), so this is a real behavioural change, not a find-and-replace of the
URL.

Frame-level concurrency matters: a multi-minute scene at the frame rates the
current scripts use (up to 60fps) is potentially thousands of Replicate
calls per scene for the artwork/background/matte/depth/upscale/outline
steps. `job.ts` should cap concurrency and support resuming a partially
completed run — exactly what the `[ -f ... ]` checks do today, just
centralised instead of copy-pasted across eight scripts. The dream step is
the exception: if a modern image-to-video model replaces Deforum (see
"Modernizing the dreaming step"), it becomes one Replicate call per scene
instead of thousands of per-frame ones — a large cost and complexity win
worth confirming early in Phase 2.

### Compositing

`compose.ts` ports `generate-videos.sh` and `generate-dreaming.sh` directly:
ffmpeg `hstack` of the 7 panels, **in the exact fixed order the client shader
expects — words, artwork, artwork background, matte, depth, outline, dream
— matching `uFrameTotal={7}` in `apps/client/src/views/main.tsx`** — plus
audio mux to the fixed audio length, then the loop-clip and preview-JPG
generation at the end of that script. This is the one deliverable per scene;
panel count and order are load-bearing for the client's WebGL shader, not
just a convention, so the CLI shouldn't change them without also touching
`video-material.tsx`/`main.tsx`. `dreams.py`'s separate lyric-baked-in
dream video and its per-frame `words/` mask extraction are dropped — the
client already does that compositing at render time via the words panel
(index 1) masking the dream panel (index 7). Compositing stays local
shell-out to `ffmpeg`, same as today — no Replicate model needed unless a
later phase wants to move it into a custom "compositor" Cog model (noted as
a future option, not required now).

### Config & secrets

Single `.env` at the pipeline app root: `REPLICATE_API_TOKEN`, plus whatever
the eventual outline/interpolation models need. No more `superuniverse.local`
hardcoded hostnames.

### Repo hygiene (control-room)

Bring `lysterfield` up to the same standard as other repos from the start:
add `.github/workflows/claude-code-review.yml` referencing
`superhighfives/control-room` per its README, and a root `CLAUDE.md` that
adds any `lysterfield`-specific rules on top of `BASELINE.md` (e.g. anything
about not committing generated frames/videos, or Replicate cost
considerations).

### Phasing

0. **Recover ground truth from the full project source** — done
   (2026-08-17), against the external drive at
   `/Volumes/HDD/lysterfield-lake-pipeline`. Confirmed: the real run order
   (see Context), that matte generation really was a manual local step
   (`video-matting/inference.py`), that the client's 7-way output is a hard
   shader contract with a fixed panel order (not just a convention), that
   `dreams.py`'s lyric-compositing lane can be dropped, and that
   `halftone.py` is unreferenced anywhere in the fuller source tree either
   — you confirmed it was a dropped idea, not porting it. One loose end
   remains for Phase 2 (see open questions): what replaces the Enhancr GUI
   step.
1. **Repo scaffold** — create `lysterfield`, move `lysterfield-lake` into
   `apps/client` unchanged, set up workspaces, add the control-room review
   workflow and `CLAUDE.md`. No pipeline logic yet.
2. **Model audit** — for the outline step, check for a community Replicate
   port of ArtLine; if none is good enough, package one of the existing
   checkpoints (`video-artline/*.pkl`) as a private Cog model. For dreaming,
   prototype Kling 3.0 Omni and/or Grok Imagine (image + prompt +
   style-reference) against an existing published scene, and decide whether
   either replaces Deforum + manual frame curation + RIFE/Enhancr outright —
   this is the highest-leverage decision in the whole plan, since it
   collapses several messy manual steps into one Replicate call if it works.
3. **Port steps one at a time** — `init` (ffmpeg crop/extract, no model),
   then `matte`, `depth`, `artwork`, `background`, `upscale` (all
   already-on-Replicate models, lowest risk), then `outline` and `dream`
   (dependent on Phase 2's findings). Each step should be runnable and
   testable in isolation against a single frame before wiring into the full
   CLI.
4. **Compose + client manifest** — port `compose.ts`, and have the CLI write
   directly into `apps/client/dreams/<id>/...` plus update `dreams.json`,
   retiring `scripts/generate-dreams.js`'s manual role.
5. **End-to-end validation** — run one real iPhone video through the full
   CLI and compare the result against an already-published scene for
   parity (visual + rough cost/time budget per scene).
6. **Retire the old repos** — archive `lysterfield-lake-pipeline` once
   `apps/pipeline` covers everything it did, keeping its README's model
   documentation as historical reference.

Each phase above should become its own `plans/ready/` spec before it's
started, per the plans workflow — this document is the architecture-level
parent plan, not a substitute for per-phase specs.

## Tasks

- [x] Phase 0: recover actual script run order + confirm halftone.py's role from the full project source (external drive)
- [x] Phase 1: scaffold `lysterfield` repo (workspaces, move client, control-room workflow + CLAUDE.md)
- [x] Phase 2: model audit — ArtLine hosting decision, prototype Kling 3.0 Omni / Grok Imagine as a Deforum replacement for dreaming
- [x] Phase 3: port `init`, `matte`, `background-plate` (derive via inpainting instead of requiring a second video), `depth`, `artwork`, `background`, `upscale` steps
- [x] Phase 3: port `outline`, `dream` steps (post model audit)
- [x] Phase 4: port `compose.ts` (fixed 7-panel order) + client manifest writing, dropping `dreams.py`'s lyric-baked-in lane
- [x] Phase 4a-4c: compose/manifest, player and choose screen polish, frontend polish
- [x] Phase 5: end-to-end run + parity check against an existing published scene — superseded by 4e, see `done/phase-5-end-to-end-parity-check.md`
- [x] Phase 4e: full-song job `.jobs/full-video` — legacy panels reused, panel 3 via Bria, legacy dreams imported under readable ids, numbered job layout
- [ ] Phase 4f: regenerate and publish all ten dreams (now the Publish stage of `in-progress/dreams.md`)
- [x] Phase 6: archive `lysterfield-lake-pipeline`, with `lysterfield-lake-client`, on 2026-10-23 (that day this repo was renamed
      from `lysterfield` to `lysterfield-lake`, and the original client repo from
      `lysterfield-lake` to `lysterfield-lake-client`; both old repos' READMEs point here)

## Phase 1 notes (done 2026-08-17)

`lysterfield` is now a local-only git repo (no GitHub remote created yet —
push when ready) at `/Users/superhighfives/Development/lysterfield-lake/lysterfield`.
`apps/client` carries `lysterfield-lake`'s full 23-commit history, rewritten
under that subdirectory with `git-filter-repo --to-subdirectory-filter
apps/client` and merged in with `--allow-unrelated-histories` — `git log
apps/client` still shows the original commits. `lysterfield-lake` and
`lysterfield-lake-pipeline` were left untouched on disk, per plan (Phase 6
retires them later).

One gotcha worth remembering for later phases: a fresh install with no
lockfile re-resolves every caret-ranged dependency against today's registry,
and ~2 years of drift broke lint two different ways (`eslint-plugin-import`/
`eslint-import-resolver-typescript` changed how they resolve
`@uidotdev/usehooks`'s ESM `exports` field; a newer `eslint` broke
`eslint-plugin-import`'s `import/namespace` rule outright). Fixed by letting
`bun install` migrate the original `apps/client/package-lock.json` into
`bun.lock` instead of resolving fresh — same fix would apply again if
`apps/pipeline`'s lockfile is ever regenerated from scratch. Also fixed: the
client's `postinstall` script (`generate`) used to overwrite `src/dreams.json`
from whatever's in `dreams/` — since that folder's contents are gitignored
and empty in a fresh checkout, install alone would wipe real scene data. Now
guarded in `generate-dreams.js`: skips the write and warns instead.

**Switched package manager to bun** (2026-08-17, at your request). Workspace
root and `apps/client` both install via `bun install`; `bunfig.toml` pins the
`hoisted` linker because bun's default `isolated` linker's node_modules
layout broke `eslint-import-resolver-typescript`'s resolution of packages
like `three-stdlib` (spurious `import/no-unresolved`) — unrelated to the
version-drift issue above, a separate bug from bun's own module layout.
`npm run <script> --workspace=apps/<name>` becomes `bun run --cwd
apps/<name> <script>`; CI workflow updated to `runtime: bun`.

## Phase 3 notes (done 2026-08-18)

Full detail in [`plans/done/phase-3-port-frame-steps.md`](../done/phase-3-port-frame-steps.md).
`apps/pipeline` now has six working, real-footage-tested steps (`init`,
`matte`, `background-plate`, `artwork` — shared between the artwork and
background panels — `depth`, `upscale`) plus a minimal `cli.ts` to run them
individually. Two things worth knowing without reading the full spec:
every Replicate model call must use a pinned `owner/name:version` —
the latest-version shorthand 404s for all of them — and `background-plate`
runs on per-frame `allenhooo/lama` instead of the originally-planned
`jd7h/propainter` (that model's Cog wrapper has a real bug rejecting every
Replicate-hosted file URL as its mask input). `outline`/`dream` remain for
a follow-up phase, same as before.

## Open questions

- **Resolved — dreaming automation scope**: user-supplied, not derived from
  the source video. The CLI takes a per-scene `--prompt` and a
  `--style-ref` reference image — a proper version of what Deforum's own
  `colormatch_image` setting was already reaching for per scene (see the
  real prompts/settings finding above). Note this isn't the same as
  `dreams.json`'s `prompt` field, which is just UI display text — the real
  per-scene prompts to reuse for comparison live in
  `video-final/dreaming/<id>/{prompt.txt,<id>_settings.txt}` on the drive.
- **Resolved — outline model hosting** (2026-08-17, phase 2): no community
  Replicate port of ArtLine exists — confirmed via Replicate's search API
  and general web search across many query variants (line drawing, sketch,
  pencil portrait, outline drawing, cjwbw's whole catalog). Packaged
  `video-artline/torch_650.pkl` (the checkpoint `other.py` actually loaded
  in production, not the `_920` or fastai-learner variants) as a private Cog
  model at `models/outline/`. Validated locally with `cog predict` — loads,
  and produces correct line art on both the ArtLine-torch sample fixture and
  a real production frame. `fastai` is a required runtime dependency purely
  for pickle's class resolution (the checkpoint is `torch.save(learn.model,
  ...)`, a pickled fastai `DynamicUnet`) — nothing in `predict.py` calls
  fastai's API. Pushed to Replicate in phase 3 (`superhighfives/
  lysterfield-outline`) — runs on **CPU**, not GPU: a `gpu: true` build
  never booted on Replicate's actual GPU infrastructure (stuck in
  "starting" for 15+ minutes, every hardware tier, across several fresh
  pushes over a week — see phase 3b's plan for the full diagnosis), while
  the image was 6.97GB almost entirely from the CUDA/GPU-torch stack for a
  300×300 model that was never compute-heavy enough to need a GPU.
  Switching to CPU fixed the boot issue outright and predicts in ~0.8s.
- **Resolved — dreaming model choice** (2026-08-17/18, phase 2): both
  candidates hold up — the Deforum-fallback path is not needed. Prototyped
  against scene `20230808103741` ("Watercolour"), using its real prompt
  ("a detailed watercolor painting of a lake at dawn with sunlight through
  trees, trending on Artstation", from `video-final/dreaming/20230808103741/
  20230808103741_settings.txt`, not `dreams.json`'s display caption — for
  this scene those two are actually different scenes' captions, which is
  exactly the mismatch the plan already flagged), its real `colormatch_image`
  (an Unsplash photo, used only as a warm dawn/dusk **colour** reference —
  the prompt explicitly said not to borrow its literal content), a source
  frame pulled from the single shared `main.mov`, and an explicit "no
  people/faces/human figures" instruction folded into the prompt text (no
  negative-prompt field on either model) to match the original's
  waifu-avoidance negative prompting.

  **Kling 3.0 Omni** (`kwaivgi/kling-v3-omni-video`, `start_image` +
  `prompt` + `reference_images`): the real photo dissolves into a richly
  textured watercolor scene (visible paper-texture edges, individual light
  rays, brushstroke variation) within about a second, settling into a result
  close in character to the original 2023 Deforum output for the rest of the
  clip — and with no trace of the source person. This is also the more
  architecturally faithful replacement: Deforum's own settings
  (`use_init`, `strength: 0.65`, `hybrid_composite: true`) show it was
  already diffusing real source frames into painted style, not generating
  from scratch — `start_image` is the same mechanism. Slower (316s
  predict time for a 5s/720p/standard/no-audio clip) and pricier (~$0.84
  for that clip per third-party pricing comparisons — Replicate doesn't
  expose per-prediction cost via the API — roughly ~$2.50/scene at 15s).

  **Grok Imagine** (`xai/grok-imagine-r2v`, `reference_images` only — its
  own docs say these are "style and content references, not starting
  frames"): a clean, independently-generated painterly landscape, strong
  prompt/style fidelity, subtle ambient motion (drifting light, shimmering
  water), no unwanted people — closer to a flat illustration than Kling's
  textured watercolor, and doesn't use the literal source footage as a
  starting point. Much faster (32s predict time) and cheaper (~$0.25 for
  the same clip, ~10x faster and ~3x cheaper than Kling).

  **Decision: Kling 3.0 Omni as the primary/default**, on the strength of
  its `start_image` mechanism matching what Deforum was actually doing and
  its closer visual match to the original hand-crafted aesthetic — the
  per-scene cost difference is trivial either way against the old
  GPU-time-plus-manual-curation cost. Keep Grok Imagine available as a
  cheaper/faster option, worth revisiting if per-scene cost or generation
  time becomes a real constraint at full-catalogue scale, or for scenes
  that don't need literal continuity with the source footage.
- **Cost/concurrency budget**: dreaming is confirmed as one Replicate call
  per scene either way (not per-frame), so its cost is a rounding error
  regardless of which model — the actual remaining unknown is the per-frame
  steps (artwork/background/matte/depth/upscale/outline) at up to 60fps;
  still worth a rough estimate before committing to full frame rate, but not
  done as part of phase 2 since it didn't block either model decision.
- **The `output-outro` matte run**: purpose unconfirmed (a special extra
  scene outside the normal per-song set?) — low priority, only worth
  chasing if something in the final video doesn't reproduce cleanly during
  Phase 5.
