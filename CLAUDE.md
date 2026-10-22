# lysterfield

Baseline rules live in [superhighfives/control-room](https://github.com/superhighfives/control-room/blob/main/BASELINE.md).
This file is the repo-specific part.

## Layout

Bun workspaces: `apps/client` (Vite/React/R3F player) and `apps/pipeline`
(Node/TS CLI, Replicate-driven — see
`plans/in-progress/rebuild-pipeline-as-replicate-cli.md`). Install and run
workspace scripts from the repo root with `bun run --cwd apps/<name> <script>`.
`bunfig.toml` pins the hoisted linker — bun's default isolated linker's
node_modules layout breaks `eslint-import-resolver-typescript`'s module
resolution. Don't remove that setting without re-checking lint still passes.

## Generated assets — never commit

Per-scene output (`apps/client/dreams/<id>/...`: composited videos, loop
clips, preview JPGs) and any pipeline working directories (extracted frames,
per-step Replicate outputs) are generated, not source. They're already
gitignored in `apps/client`; keep the same rule for anything `apps/pipeline`
writes.

`apps/pipeline/.jobs`, `apps/pipeline/.env` and
`apps/pipeline/resources/colours` (/admin's colour and style images) are
shared across git worktrees: `.githooks/post-checkout` symlinks a new
worktree's copies to the main checkout's on `git worktree add`.
It needs `git config core.hooksPath .githooks` set once per clone. For a
worktree that already exists, run `.githooks/post-checkout` from inside it.

## Job layout

A job (`apps/pipeline/.jobs/<name>/`) is `job.json` (fps, source, stepFps,
a per-panel provenance note), `0-source/` (`original/`, `video.mov`,
`frames/`), and one numbered folder per panel with its final frames in
`<n>-<panel>/frames`. Each dream take is `7-dreams/<id>/` with its own
`take.json` and a `final/` folder of publishable output. `<id>` is the
client's dream id (readable, e.g. `lush-and-light`), and everything in the
client keys off it. `.jobs/spikes/` holds experiment leftovers only.

`.jobs/full-video` reuses the legacy run's panels (see
`plans/done/phase-4e-full-video-source-prep.md`): the legacy `resized`
folder had stray leftover frames, so check reused frames before feeding
them to a model.

## Replicate calls cost money

Pipeline steps run over source video at up to 60fps and can mean thousands of
per-frame API calls for a single scene. Never add retry loops, "just try it
again" fallbacks, or code paths that call a Replicate model without an
idempotency check (skip-if-output-exists) guarding it first.

One deliberate, capped exception (user, 2026-10-14): a dream repair
re-renders a stretch that still shows a person with new seeds, up to
`MAX_REPAIR_ROUNDS` (10) rounds per request, and the Deforum model retries a
failing frame twice within a run. Don't raise those caps or add others like
them without asking.

## The client's panel order is load-bearing, not a convention

The client plays a shared **main video** of 6 panels side by side, in a
fixed order — 1 = lyrics, 2 = portrait, 3 = portrait background,
4 = matte, 5 = depth, 6 = outline — plus each dream's own **dream video**,
panel 7 on its own (`compose-split`, `dreams/main/` and
`dreams/<id>/dream*`). `apps/client/src/materials/video-material.tsx` reads
every panel through one `panel()` lookup (7 from the dream video, 1-6 from
the main video at `uFrameTotal={6}`), and `apps/client/src/views/main.tsx`
picks panels by those hardcoded indices. The older 7-panel files
(`dreams/<id>/video*`, panel 7 last in the same atlas) still play with
`?split=0` until the split path is checked on real devices. Don't reorder
or resize either layout without updating both those files to match.

## Dream panel (7) must never show a person

Abstract reinterpretation only — shapes, light, and colour, never a
recognisable person or face. On the flux-kontext path `dream.ts` always
appends a fixed `NO_PEOPLE_SUFFIX` to every take's prompt (`dreamFrame`)
so this can't be forgotten per-take; Deforum takes instead rely on the
legacy dreams' fixed negative prompt (no people, faces, bodies), which
always applies on top of any per-take `negativePrompt`. Don't bypass
either by calling the model directly with a raw prompt. Both dream takes in `real-15s-60fps` (`dream-styletransfer-v2`,
`dream-styletransfer-v2-fixed`) failed review for exactly this reason — a
per-take prompt alone wasn't a strong enough guarantee.

## Polaroid jobs are separate from the song's

A visitor's polaroid (`/admin/record` → `/admin/polaroid`, `plans/done/polaroid-admin-flow.md`) is a job
with `"kind": "polaroid"` in `job.json`: 5 seconds, panels 2-6 only, no dream. Its atlas is its own
5-panel layout (`apps/pipeline/src/steps/polaroid.ts`, `POLAROID_PANELS`), read by
`apps/client/src/materials/polaroid-loop-material.tsx`. It isn't the player's 7-panel atlas, so the rule
above doesn't apply to it, and changing one doesn't change the other.

- Moderation lives in `job.json`'s `review`: `submitted` → `approved` (to make) → `shown` (to show), or
  `rejected`. The admin refuses to run any polaroid stage unless it's `approved`, so a visitor's clip
  costs nothing until a person has looked at it. Delete only works on polaroid jobs, never a song's.
- Panels 2, 4, 5 and 6 come from one model, `models/polaroid`, on the `lysterfield-polaroid` Replicate
  deployment (`polaroid-run`, about $1.90 a loop). For now polaroid generation runs on Replicate only,
  not the 4090 PC. `plans/in-progress/polaroids.md` changes that: the public release makes approved
  submissions in batches on the PC (`POLAROID_URL`), with Replicate as the fallback. Update this when the
  PC path lands.
- Panel 3 is Bria (`background-video`, about $0.25), whose inputs go through the public R2 bucket
  `lysterfield-bria-temp` (objects expire after a day). It needs `R2_*` in `apps/pipeline/.env`.
- `models/polaroid` builds on the PC (`~/lysterfield-models`), not the Mac: the image is ~33GB and a
  build needs twice that. Pushing it to r8.im times out finalising large layers; retry until it lands
  (it only re-sends what's missing).

## Known per-frame artifact failure modes

- **Matte (panel 4, `robust_video_matting`)**: occasionally glitches for a
  second or two — a bad mask on a run of frames. Options being evaluated:
  pre-contrasting input frames before matting, swapping to a newer
  segmentation model, or a spot-check pass before a bad matte run feeds
  `background-plate`/`compose`. Don't assume a completed matte run is
  artifact-free.
- **Depth (panel 5, `zoedepth`)**: sometimes adds flutter/artifacts in the
  corners. Worth checking whether a newer depth model is a straightforward
  swap.

See `plans/in-progress/dreams.md` for the planned
per-scene review workflow these feed into.

## Secrets

`REPLICATE_API_TOKEN` and friends live in `apps/pipeline/.env`, never
committed. No hardcoded hostnames for local model servers (the old pipeline's
`superuniverse.local` — that pattern is retired, not ported).
