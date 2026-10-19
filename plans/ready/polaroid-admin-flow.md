---
title: Polaroid loops end to end in /admin
status: Ready
created: 2026-10-18
updated: 2026-10-18
---

# Polaroid loops end to end in /admin

## Goal

Go from `/admin/record` to a finished, looping 3D polaroid in `/admin/polaroid` in one flow, with every
paid step behind a button that shows its cost. Get the prototype work off its branch and onto `main`, so
the polaroid, the dreams and the player stop living in separate worktrees.

Still dev-only `/admin`, as the dreams tooling is. The public, hosted version (accounts, gallery, budget)
stays in `backlog/user-polaroid-loops.md`.

## Context

**What exists, on `polaroid-prototype`** (9 commits ahead of where it branched, not merged):

- `/admin/record`: webcam or file, drag and zoom a square crop, "Make job" saves to `.jobs/_recordings/`
  and runs `init` with `--crop` (`views/admin-record.tsx`, `vite-plugin-admin.ts`).
- `init --crop x,y,zoom`, recorded in `job.json` (`steps/init.ts`, `job.ts`).
- `models/polaroid`: one Cog model for panels 2, 4, 5 and 6 (RVM, DiffusionCLIP + Real-ESRGAN, ZoeDepth,
  lineart). It takes a frame range, so a job can split across predictions. Built and tested on the 4090
  PC (8.3s a frame at 20 inversion steps). It's a private Replicate model,
  `superhighfives/lysterfield-polaroid`, with a version being pushed (2026-10-18). See its README.
- `models/diffusionclip/run.py`: loads once per boot. Same output, and 40% faster per frame before
  counting the inversion-step saving.
- Pipeline: `polaroid-panels --tar` (unpack the model's output and run the existing matte, depth and
  outline post-processing) and `polaroid` (stack panels 2-6 into a looping 5-panel atlas,
  `polaroid/atlas.mp4`).
- `/admin/polaroid`: the atlas on the player's polaroid model, with the person as a depth-displaced
  cut-out in front of the background (`materials/polaroid-loop-material.tsx`). Drag to turn.
- Measurements and decisions: `backlog/user-polaroid-loops.md`.

**What `main` has since gained** that this builds on or must fit with:

- `steps/background-video.ts` and `r2.ts` (PR #32): panel 3 from Bria via a public R2 bucket, upload,
  run, delete. A 5s polaroid is one chunk, $0.25. Needs the `R2_*` settings in `apps/pipeline/.env`. Not
  yet run against a real bucket; the polaroid flow will be its first real run.
- `ready/split-dream-video-client.md`: the player's atlas becomes six panels plus a separate dream video.
  It doesn't touch the polaroid's own 5-panel atlas or material.

**Other open branches that touch the same files:**

- `polaroid-swap` (23 commits): a large player rework that changes `models/polaroid.tsx` (+194/−57),
  `polaroid-material.tsx` and `video-material.tsx`. `/admin/polaroid` renders through `models/polaroid.tsx`
  (its `passthroughMaterial` prop), so whichever lands second has to reconcile with it.
- `split-dream-video`, `depth-walk-away`: no overlap with the polaroid files.

## Approach

### 1. Consolidate onto `main` first

1. Rebase `polaroid-prototype` onto `main`. Expect conflicts only in `vite-plugin-admin.ts`, `main.tsx`,
   `.eslintrc.json` and `backlog/user-polaroid-loops.md`.
2. Land it as two PRs, so the risky one is small:
   - **Pipeline and models:** `init --crop`, `models/diffusionclip/run.py`, `models/polaroid`, `polaroid`
     and `polaroid-panels`. Nothing calls these by default, so it changes no existing run.
   - **Admin:** `/admin/record` and `/admin/polaroid`.
3. Land `polaroid-swap` before the admin PR if it's close, then adapt `/admin/polaroid` to its
   `models/polaroid.tsx`. If it isn't close, land the admin PR first: the viewer only uses
   `passthroughMaterial`, so `polaroid-swap` keeps one call site working.
4. Then build steps 2-5 below on `main`, in a fresh worktree.

### 2. One pipeline command per stage

Each is skip-if-exists and makes no retries (CLAUDE.md). Each prints its cost before spending, like
`background-video`'s plan-only run.

| Stage | Command | Where it runs | Cost |
| --- | --- | --- | --- |
| Source | `init --crop` (exists) | local | free |
| Panels 2, 4, 5, 6 | `polaroid-run` (new) | the PC if `POLAROID_URL` is set, else the Replicate deployment | free / ~$1 |
| Panel 3 | `background-video` (on main) | Replicate (Bria) | $0.25 |
| Atlas | `polaroid` (exists) | local | free |

`polaroid-run`:

- **On the PC:** one prediction against the polaroid container's Cog HTTP API at `POLAROID_URL`, as
  `gpu-server.ts` does for Deforum. It runs one frame at a time (`portrait_batch` 1), because Deforum holds
  8GB of the 4090.
- **On Replicate:** the deployment `superhighfives/lysterfield-polaroid`, split into 4 frame ranges run at
  once, only the first with the matte. Prediction ids are saved as they start (the
  `runModelToFileResumable` pattern), so a dropped connection picks the same predictions back up instead
  of paying twice.
- Each output tar goes through `polaroidPanels()`, which already merges ranges by skipping frames that
  exist.
- Defaults: 20 inversion steps (no visible change from 40, a third faster), 24fps, the whole clip.

Add `kind: "polaroid"` to `job.json` (set by `/admin/record`). The dreams page lists song jobs, and the
polaroid page lists polaroid jobs.

### 3. Admin actions

In `vite-plugin-admin.ts`, three new actions mapped in `actionArgs` and `LANES`, queued with the take
fixed as `polaroid`, so the queue's one-task-per-take rule keeps a job's stages in order:

- `polaroid-panels` → `polaroid-run`. Lane `pc` when `POLAROID_URL` is set, else `replicate`; the same
  per-task override as dreams' run-on switch.
- `polaroid-background` → `background-video`. Lane `replicate`.
- `polaroid-atlas` → `polaroid`. Lane `local`.

Plus a `GET /__admin/api/polaroids/<job>` detail: each stage done or not, from the files on disk
(`2-portrait/upscaled`, `4-matte/frames`, `5-depth/frames`, `6-outline/frames`, `3-background/frames`,
`polaroid/atlas.mp4`), and the job's tasks.

### 4. `/admin/polaroid` becomes the whole flow

- **List:** polaroid jobs, newest first, each with its source's first frame and how far it has got.
- **Job view:** the four stages as a checklist. Each paid stage has a Run button showing its cost and where
  it runs, with the same confirm-before-spend pattern as dreams' full-song button. The atlas runs on its
  own once panels 2-6 exist. The queue's `Tasks` component (`admin-tasks.tsx`) shows progress and logs.
- **Done:** the 3D viewer that's there now, with its depth and outline sliders.
- `/admin/record`'s "Make job" goes straight to `/admin/polaroid?job=<name>`.
- **"Run everything":** queues panels and background together (they're independent), then the atlas.
  One confirm shows the total.

### 5. A flattened MP4

"A finished video" also means one to download and share. Add a `polaroid-video` step: ffmpeg composites the
portrait over the background through the matte, at 1080², looping, into `polaroid/loop.mp4`, and the job
view gets a download link. A render of the 3D card itself (turning, with depth) is a later step.

### 6. The PC as a standing service

Run the polaroid container on the PC like Deforum's: always up, port 5001, reachable over Tailscale. It
needs the WSL `libcuda.so` mount (`models/polaroid/README.md`). Add it to the PC's startup task. Note the
address as `POLAROID_URL` in `apps/pipeline/.env` (never in code). Both containers share one GPU, and the
`pc` lane already runs one task at a time.

## Tasks

- [x] Rebase `polaroid-prototype` onto `main` and land it (#37, as one PR, after `polaroid-swap` #36)
- [x] Replicate deployment test (L40S, 4-way split): 9 minutes cold, about $2 (`backlog/user-polaroid-loops.md`)
- [ ] `polaroid-run` (PC and Replicate), with cost printed first and resumable predictions
- [ ] `kind: "polaroid"` in `job.json`, from `/admin/record`
- [ ] First real run of `background-video` on a polaroid job (needs `R2_*` in `.env`)
- [ ] Admin actions, lanes and the polaroid job detail API
- [ ] `/admin/polaroid` list, job view with stages, costs and tasks; record → polaroid hand-off
- [ ] `polaroid-video` (flattened MP4) and its download link
- [ ] Polaroid container as a standing service on the PC; `POLAROID_URL`
- [ ] CLAUDE.md: `models/polaroid`, the polaroid atlas layout (separate from the player's 7 panels), PC notes
- [ ] Switch `models.ts`'s portrait to the optimised DiffusionCLIP version `fd60b4d9…` (pushed 2026-10-18;
      same output at 40 inversion steps, faster song runs too)

## Choices made (say if any are wrong)

- **The PC is the default runner when it's up:** free, and about 17 minutes a loop. Replicate is the
  fallback: about $2.25 a loop from cold including Bria, and 9 minutes split four ways (measured
  2026-10-18), most of the wait being four 2-3 minute boots.
- **20 inversion steps** by default, with 40 available as an option.
- **The atlas trims 3 frames and crossfades 12**, as the prototype does.
- **No automatic checks yet** (the leak detector failed on `park-party`); the person looks at the result.
  Automated checks belong to the hosted plan.
