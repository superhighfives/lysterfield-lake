---
title: Release the polaroids as their own site, made in batches on the 4090
status: Backlog
created: 2026-10-10
updated: 2026-10-21
---

# Release the polaroids as their own site, made in batches on the 4090

## Goal

Release the generative polaroids separately from the music video: a site
where anyone can record or upload a 5-second clip and later get back a
looping 3D polaroid of themselves, and a gallery of the approved ones.
Submissions are queued online. The artist approves them, and the 4090 makes
the approved ones in batches, so making them costs next to nothing and
nobody has to pay per loop or keep a hosted GPU warm.

Today the whole thing works end to end, but only in the dev-only `/admin`
(`/admin/record` → `/admin/polaroid`, `done/polaroid-admin-flow.md`), one
clip at a time, on Replicate.

## Decisions

From the artist (2026-10-21), replacing the 2026-10-16 "fully hosted" plan:

- **Its own release,** not part of the music video site.
- **Made on the 4090, in batches.** Submissions wait in a queue. The artist
  runs a batch on the PC when it suits them, and the polaroids appear as
  they finish. Turnaround is a batch, not minutes.
- **The artist approves every clip before it's made.** That was already
  how `/admin` works (submitted → approved → shown, or rejected). It also
  stands in for an automatic input gate: a person has looked before any
  GPU time or Bria call is spent.

Still holding from 2026-10-16:

- **Panels 2-6 only** (portrait, background, matte, depth, outline). No
  dream, so no Deforum, person check or `NO_PEOPLE_SUFFIX`: the visitor's
  likeness is the point.
- **A 3D object in the client,** rendered from a per-submission 5-panel
  atlas (`materials/polaroid-loop-material.tsx`). A flattened MP4 and still
  for sharing (the `polaroid` step already writes `loop.mp4`).
- **Gallery:** a pannable grid of looping polaroids with a music loop.
- **Moderation:** nothing joins the gallery until the artist approves
  showing it. The owner sees theirs at a private link as soon as it's made.
- **Retention:** the source clip and intermediate frames are deleted once a
  polaroid is made or rejected; the atlas stays until its owner or the
  artist deletes it.

No longer needed with a free GPU and a human approving each clip: the daily
spend cap and kill switch, the per-account limits, the automatic input-gate
models, and the Replicate cold-start question. Accounts (Clerk) become
optional; see Open questions.

## Context

**What's built** (on `main`, from `done/polaroid-admin-flow.md`):

- `/admin/record`: webcam or file, square crop, "Make job" → a `.jobs/<name>/`
  job with `"kind": "polaroid"` (`views/admin-record.tsx`, `steps/init.ts --crop`).
- `models/polaroid`: one Cog image for panels 2, 4, 5 and 6 (RVM,
  DiffusionCLIP + Real-ESRGAN, ZoeDepth, lineart). It builds and runs on the
  4090: **122 frames in 1,015s (8.3s a frame) plus 24s setup, free**. On
  Replicate (`lysterfield-polaroid` deployment, L40S) the same clip is about
  9 minutes cold and ~$2.
- `polaroid-run` (Replicate only today), `background-video` (Bria, panel 3,
  ~$0.25, needs `R2_*`), `polaroid` (the 5-panel atlas and `loop.mp4`).
- Moderation in `job.json`'s `review`, and the admin refuses paid stages
  unless approved. Delete works on polaroid jobs only.
- `/admin/polaroid`: the job list, stages with costs, and the 3D viewer
  (the photo as a window into a tub, the person wrapped round its walls).

**What changes for the PC to make them:**

- The polaroid container has to run on the PC as a standing service, like
  Deforum's: always up on its own port, reachable over Tailscale, with the
  WSL `libcuda.so` mount (`models/polaroid/README.md`). Its address goes in
  `apps/pipeline/.env` as `POLAROID_URL`, never in code (CLAUDE.md). This
  was the deferred "later" task in the admin plan.
- `polaroid-run` gains its PC path: one prediction against the container's
  Cog HTTP API, one frame at a time (`portrait_batch` 1, since Deforum holds
  8GB of the 4090), as `gpu-server.ts` does for Deforum.
- **CLAUDE.md says polaroid generation runs on Replicate only, never on
  the PC.** That rule reflects the 2026-10-18 decision; this plan reverses
  it for batches, so update CLAUDE.md when the PC path lands (Replicate
  stays as a fallback).
- Panel 3 is still Bria on Replicate (~$0.25 a polaroid). For it to be
  free too, panel 3 needs a local equivalent; see Open questions.

## Approach

1. **A separate app,** `apps/polaroids` in this repo: its own Vite/React
   site and Pages project, on its own domain. The polaroid card, its
   material and the tub viewer move into a shared workspace package
   (`packages/polaroid`) that both it and `/admin` use, rather than being
   copied.
2. **Submit** (public): record 5s with the camera or upload a clip, crop it
   square in the browser (the `/admin/record` UI, made public), agree to
   the terms, and leave an email for "it's ready". Turnstile against bots.
   A Pages Function (or Worker) checks it, issues a signed upload URL to a
   private R2 bucket, and records the submission in D1 as `submitted`. The
   visitor gets a private link, `/p/<id>`, that says "waiting" until it's
   made.
3. **Approve** (the artist): a hosted admin page behind Cloudflare Access,
   listing submissions with their clips: approve to make, reject, and
   later approve to show. Same states as today's `review`, now in D1.
4. **Batch** (the PC, or the Mac driving it): a new pipeline command,
   `polaroid-batch`, that pulls every approved, unmade submission from the
   API, downloads its clip, and for each one runs `init --crop`,
   `polaroid-run` against `POLAROID_URL`, panel 3, and `polaroid`. It
   uploads the atlas, `loop.mp4` and a still to a public R2 bucket, marks
   the submission `made` in D1, deletes the clip, and emails the owner.
   Skip-if-exists at every step, and no automatic retries (CLAUDE.md): a
   failed one is marked `failed` with its log, to retry from the admin.
5. **The polaroid page and gallery:** `/p/<id>` plays the atlas on the 3D
   card, with download and share (an OG image from the still). The gallery
   is a grid of `shown` polaroids: stills or tiny loops by default, full
   video only for the few near the centre, so a phone isn't decoding
   dozens at once.

## Measurements

### Prototype run: `park-party` (2026-10-17)

A 5s handheld iPhone selfie in a park (sky and grass swinging behind,
two strangers in the first frames), recorded with `/admin/record`, run
through panels 2-6 locally with the existing steps and defaults (24fps,
stepFps 6, concurrency 4). 122 frames.

| Step | Calls | GPU time | Wall clock | Cost (est.) |
| --- | --- | --- | --- | --- |
| matte (RVM) | 1 | 35s | 50s | ~$0.01-0.05 |
| portrait (DiffusionCLIP, T4) | 126 | 9,098s (72s/frame) | 37m, plus a ~3m cold start | ~$2.05 |
| upscale (real-esrgan) | 122 | 221s | 3.6m | ~$0.05-0.30 |
| background plate (flux-fill-pro) | 31 | 539s | 2.6m | $1.55 |
| background stabilize | local | – | 18s | free |
| depth (zoedepth) | 122 | 226s | 9.2m (one ~6m cold start) | ~$0.05-0.30 |
| outline (lineart, CPU) | 122 | 737s | 4.6m | ~$0.07 |
| **Total** | 524 | | **~64m** | **~$4-4.50** |

- **Cost is fine; time isn't.** About $4 a loop, half of it the
  portrait. But at concurrency 4 a loop takes an hour, almost all of it
  DiffusionCLIP at 72s a frame on a T4. Faster hardware (an L40S is
  several times faster for about 4x the per-second price) and more
  parallelism should get this down to minutes for a similar cost. Measure
  it before choosing.
- **Cold starts are real.** DiffusionCLIP's first predictions waited
  ~3m and zoedepth's ~6m. `models.ts` says DiffusionCLIP has no cold boot
  (a deployment with min instances 1), but the pipeline calls the model
  version, not the deployment. Hosted, either point at warm deployments
  (a fixed monthly cost) or accept minutes of start-up after a quiet
  spell.
- **Replicate's API 502'd once** (Cloudflare `http_response_incomplete`)
  mid-portrait and killed the step. Resumed by hand, and skip-if-exists
  meant only 4 portrait frames were paid twice. A hosted worker needs to
  survive this without a retry loop: fail the job cleanly, resume it on
  a manual admin retry.
- **Matte and outline are good.** The matte follows the subject through
  heavy camera motion and leaves the background people out; only frame 1
  has a smudge (RVM settling), which is a reason to trim the first few
  frames anyway. Depth is coarse but usable.
- **Portrait is good on wide frames, smeared on close-ups:** the face
  turns to mush in some mid-clip frames.
- **Background (panel 3) isn't usable for polaroids as it is.**
  - Its prompt is the music video's scene, so every keyframe becomes a
    boardwalk (sometimes with mountains), not a continuation of the
    visitor's own background, and it jumps between quite different scenes
    every 4 frames.
  - flux-fill invented people (a walker in 0109 and 0117, small figures in
    0021 and 0097/0101).
  - `leak-detection.ts` got it backwards: it flagged 17 of 31 keyframes,
    all sunlit grass with no person, and missed every invented figure,
    then "repaired" 0089-0097 by copying 0101, which has one in it. The
    skin-tone heuristic can't gate a stranger's footage.
  - Likely fix: Bria video-erase (`port-bria-background-step.md`), which
    is temporally consistent, continues the real scene and costs ~$0.25
    for 5s. Or a single still plate held for the whole loop.

### Bria for panel 3 (2026-10-17)

One `bria/video-erase-object` run on `park-party`: 720px portrait clip
(frames 1-120) plus a mask of the matte (>127) unioned over ±2 frames and
dilated 24px. 30s of GPU, 33s wall clock, $0.25. Inputs went on a
temporary public R2 bucket (`lysterfield-polaroid-temp`, random path),
deleted straight after along with the bucket.

- **Much better than flux-fill:** it continues the visitor's actual scene
  (grass, sky, the treeline) with a painterly fill that holds together
  frame to frame. No boardwalk, no mountains, no invented people.
- One weak spot: the first frames, where the head fills most of the
  picture, leave a yellow-green smear where Bria had little real
  background to go on. The `polaroid` step's trim hides some of it.
- **Cheaper and faster:** $0.25 and half a minute, replacing flux-fill's
  $1.55 and 2.6m, and no leak detection to get wrong. A loop is now about
  **$2.70**, most of it the portrait.
- Hosted, the inputs need public URLs: a short-lived signed R2 URL per
  job would do, rather than a public bucket.
- `park-party`'s `3-background/frames` now points at the Bria frames
  (`frames-bria`). The flux-fill frames are kept in `frames-flux`, and
  their atlas in `polaroid/atlas-flux.mp4`.

### Faster portrait, and one model for panels 2, 4, 5 and 6 (2026-10-18)

- **Where the portrait's 72s went:** DiffusionCLIP rebuilt both multi-GB models from disk on every frame,
  then ran 51 fp32 U-Net passes at 512px on a T4. `models/diffusionclip/run.py` now loads them once per
  boot (same output: 72dB PSNR from the old model's frame) and takes `n_inv_step` and `fp16` as inputs.
- **Per portrait frame:** old model on T4 72s; on an L40S 20.5s; optimised on the 4090 11.9s at 40
  inversion steps, 7.9s at 20 (35.7dB over the whole clip, no visible change), 7.0s at 10 (a softer, visibly
  different brush). fp16 was slower (autocast overhead). Use 20.
- **`models/polaroid`:** one Cog image with RVM, DiffusionCLIP + Real-ESRGAN, ZoeDepth and the lineart
  network, so a loop is one prediction with one boot. Each panel's raw output feeds the pipeline's existing
  post-processing (`polaroid-panels`). It takes a frame range, so a job can split across several
  predictions at once, with one of them doing the matte.
- **Measured on the 4090 (free):** all 122 frames of `park-party`, every panel, 20 inversion steps:
  1,015s (8.3s a frame), plus 24s setup. Against the earlier per-model run: matte 45.9dB, depth 45.1dB,
  portrait 35.7dB, outline 26.7dB (thin lines; the same by eye).
- **The PC is a free test bench and build machine:** 891GB free, `cog` 0.23, models in
  `~/lysterfield-models`. Under WSL, cuDNN 8.5 can't find the driver and segfaults; `run-local.py` there
  mounts a `libcuda.so` link. Deforum holds 8GB of VRAM, so the portrait runs one frame at a time there.
- **Measured on Replicate (2026-10-18):** `lysterfield-polaroid` deployment (L40S, 0-4 instances), the
  clip split four ways (31 frames each, `portrait_batch` 4, 20 inversion steps), from cold: **9 minutes**
  wall clock. Each range took 130-207s to queue and boot (a 33GB image) and ~322s to run (10.4s a frame:
  batching 4 on the L40S was no faster than the 4090 one at a time). GPU time 1,288s ≈ $1.26, plus the four
  boots (~650s, billed on a private model) ≈ $0.65, plus idle until scale-down: about **$2 a loop cold**,
  ~$1.25 with warm instances, against the per-model run's ~$4. Bria adds $0.25. The output matches the
  PC's (portrait 51dB, depth 54-56dB). Boot is now the biggest share of the wait, which a warm instance or
  a smaller image would cut.
- **Split-job bugs found by that test, fixed in `polaroid-split-fixes`:** the model stopped the matte at
  its own range's end, so a split job's later ranges had none, and `polaroid-panels` assumed every frame
  had arrived. Now the matte always covers the whole clip, and each range post-processes as it's unpacked
  (checked out of order: 94, 32, 63, 1).
- **Lost and rebuilt:** `park-party` was deleted from `.jobs` while freeing disk space (2026-10-17). Its
  source was rebuilt from `_recordings/park-party.mov` with the same crop (38.7dB from the original), and
  panels 2, 4, 5 and 6 now come from the polaroid model. Panel 3 (Bria) and the atlas are gone.

## Tasks

- [x] Prototype a 5s clip through panels 2-6, with cost, time and cold
      starts (`park-party`, above)
- [x] Bria for panel 3 (above)
- [x] The loop seam (the `polaroid` step: cut where the ends match,
      crossfade 6 frames)
- [x] The R3F polaroid (`/admin/polaroid`)
- [x] One model for panels 2, 4, 5 and 6, built and measured on the 4090
- [ ] The polaroid container as a standing service on the PC
      (`POLAROID_URL`), and `polaroid-run`'s PC path; then update CLAUDE.md
- [ ] Run `background-video` against a real bucket (the R2 API token for
      `lysterfield-bria-temp` doesn't exist yet), or replace panel 3 with a
      local step
- [ ] Settle the open questions below, then split into ready plans:
      shared polaroid package and the new app; submit and approve (D1, R2,
      Access); `polaroid-batch`; polaroid page and gallery
- [ ] Gallery performance spike: N looping polaroids on a phone
- [ ] Check the matte and portrait across a range of skin tones and
      lighting before strangers' clips go through (the leak detector is out
      of the picture now: Bria replaced flux-fill)

## Open questions

- **Name and domain:** a subdomain (`polaroids.lysterfieldlake.com`) or
  its own?
- **Accounts or just email?** With a person approving each clip and no
  spend to protect, an email plus a private link may be enough. Clerk
  accounts would add a "my polaroids" page and self-serve deletion.
- **How often to batch,** and what a visitor is told about the wait.
- **Panel 3 on the PC too?** Bria is ~$0.25 each on Replicate. Free
  alternatives: a local video-inpainting model in the polaroid container
  (ProPainter, say), or one still background plate held for the loop.
- **Where the batch runs from:** `polaroid-batch` on the Mac, driving the
  PC over Tailscale like the dream lane does, or on the PC itself (then it
  needs the pipeline and ffmpeg there).
- **Legal and privacy:** terms and consent wording, minors, where the data
  lives, and what "delete" removes (atlas, still, OG image, caches).
- **Gallery music:** a stem or loop from the song, or something new?
- **Link from the music video?** A credit or a link back, or kept apart.
