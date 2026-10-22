---
title: "Polaroids: an endless gallery in the app, submissions made on the 4090"
status: In progress
created: 2026-10-10
updated: 2026-10-21
---

# Polaroids: an endless gallery in the app, submissions made on the 4090

## Goal

Visitors to the next app can find an "Add your own" link under the
chooser's stack, open an endless, explorable grid of everyone's looping
polaroids, and submit a 5-second clip of their own. Submissions wait in a
queue. When the artist feels like it, they switch "run the queue" on and the
4090 works through it, publishing each polaroid as it's made.

Everything sits behind an env flag, on in the next app only, until it's
ready. Today the whole loop works, but only in the dev-only `/admin`
(`/admin/record` → `/admin/polaroid`, `done/polaroid-admin-flow.md`), one
clip at a time, on Replicate.

## Decisions

From the artist, 2026-10-21:

- **In the app, not a separate site:** a link under the chooser's stack to
  `/polaroids`, behind `VITE_APP_POLAROIDS`.
- **An explorable, endless grid** of the looping polaroids, where people
  can also submit.
- **Made on the 4090, from a queue,** run when the artist chooses: a "run
  the queue" switch, on or off.
- **Cloudflare Workers, not Pages,** for the app and its API (Cloudflare's
  recommendation for new projects): one Worker serves the built site and
  the polaroid API, with D1 and R2 bound to it.
- **Approve before making.** A submission waits for the artist to approve
  it before the 4090 touches it, so a person has seen every clip first.
- **Panel 3 stays Bria** (~$0.25 a polaroid, on Replicate), whose inputs
  go through `lysterfield-bria-temp` with the `R2_*` key already in
  `apps/pipeline/.env` (checked: write, public read and delete all work).
- **The 4090 by default, Replicate when the artist chooses.** Panels 2, 4,
  5 and 6 can always run on Replicate instead (`--on replicate`, the
  switch in `/admin/polaroid`), to share out work. Bria is Replicate
  either way.
- **Email when it's ready, sent with Cloudflare** (its Email Service from the
  Worker), with the private link.
- **The gallery's music is a loop from the song.**

Still holding from earlier:

- **Panels 2-6 only.** No dream, so no Deforum, person check or
  `NO_PEOPLE_SUFFIX`: the visitor's likeness is the point.
- **A 3D object,** rendered from a per-submission 5-panel atlas
  (`materials/polaroid-loop-material.tsx`), plus `loop.mp4` and a still for
  sharing.
- **Nothing joins the gallery until the artist approves it.** The owner sees
  theirs at a private link once it's made.
- **Retention:** the source clip and intermediate frames are deleted once a
  polaroid is made or rejected. The atlas stays until its owner or the
  artist deletes it.

## Context

**What's built** (on `main`, from `done/polaroid-admin-flow.md`):

- `/admin/record`: webcam or file, square crop, "Make job" → a `.jobs/<name>/`
  job with `"kind": "polaroid"` (`views/admin-record.tsx`, `steps/init.ts --crop`).
- `models/polaroid`: one Cog image for panels 2, 4, 5 and 6 (RVM,
  DiffusionCLIP + Real-ESRGAN, ZoeDepth, lineart). It builds and runs on the
  4090: **122 frames in 1,015s (8.3s a frame) plus 24s setup, free**. On
  Replicate (`lysterfield-polaroid` deployment, L40S) the same clip is about
  9 minutes cold and ~$2.
- `polaroid-run` (the 4090 or Replicate, below), `background-video` (Bria, panel 3,
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
- Panel 3 is still Bria on Replicate (~$0.25 a polaroid). For it to be
  free too, panel 3 needs a local equivalent; see Open questions.
- The next app is a Pages project (direct upload, deployed by
  `.github/workflows/deploy-next.yml`). It has no custom domain yet.

## Approach

### 1. Polaroids on the 4090

The polaroid model (`models/polaroid`) runs on the PC as a standing service,
like Deforum's: a container on its own port, reachable over Tailscale, with
the WSL `libcuda.so` mount (`models/polaroid/README.md`), started at boot.
Its address goes in `apps/pipeline/.env` as `POLAROID_URL`, never in code.

`polaroid-run` gets a PC path: one prediction against the container's Cog
HTTP API, one frame at a time (`portrait_batch` 1: Deforum holds 8GB of the
4090), in the way `gpu-server.ts` drives Deforum. Replicate stays a choice,
not just a fallback (`--on replicate`, and a switch in `/admin/polaroid`
that remembers its setting, defaulting to the 4090). In `/admin`, polaroid
stages on the PC join the `pc` lane, so they take turns with dream runs
rather than competing for the GPU.

Done: `models/polaroid/start-polaroid.sh` runs the `polaroid` container on
port 5001 (`--restart unless-stopped`), reachable from the Mac over
Tailscale with no firewall change.

### 2. The next app becomes a Worker

Move `lysterfield-lake-next` from Pages to a Worker with static assets:
`wrangler deploy` with `assets.directory` set to `dist`, 404s handled by
`404.html` as now, and `_redirects` kept. The deploy workflow swaps
`wrangler pages deploy` for `wrangler deploy`. Then the polaroid API is
routes in the same Worker, with these bound to it:

- **D1, `lysterfield-polaroids`:** one row per submission: id, the clip's
  crop, status (`queued`, `making`, `made`, `shown`, `rejected`,
  `failed`), timestamps, a failure log, an optional email.
- **R2, a private inbox bucket** for submitted clips, uploaded straight from
  the browser with a short-lived signed URL.
- **R2, a public bucket** for finished polaroids (`atlas.mp4`, `loop.mp4`,
  `still.jpg`), on its own subdomain like the dreams.

Statuses: `submitted` → `approved` (queued to make) → `making` → `made` →
`shown`, or `rejected` / `failed`.

Routes:

- `POST /api/polaroids`: Turnstile check, create the row (`submitted`),
  return a signed upload URL and the private id.
- `GET /api/polaroids`: the shown ones, for the gallery.
- `GET /api/polaroids/<id>`: one polaroid's status, for its private link.
- `/api/admin/...`: the queue for the worker (next, claim, done, failed)
  and moderation (show, reject, delete), behind Cloudflare Access, with a
  service token for the Mac.

### 3. The queue in `/admin/polaroid`

An inbox listing the D1 queue: approve or reject each submitted clip
(playing it), and a "run the queue" switch. While it's on, the Mac claims
the next approved submission and, through the existing task queue:

1. downloads the clip and runs `init --crop`,
2. runs panels 2, 4, 5 and 6 on the 4090 (`polaroid-run`, about 17 minutes
   for a 5s clip),
3. runs panel 3 (Bria, `background-video`, ~$0.25),
4. runs `polaroid` for the atlas and loop,
5. uploads the outputs to the public bucket, marks it `made`, deletes the
   clip, emails the owner their private link, and claims the next.

Switching it off finishes the one in progress, then stops. Skip-if-exists
at every step, and no automatic retries (CLAUDE.md): a failure marks the
submission `failed` with its log, to retry from the inbox. Show, reject and
delete live there too.

### 4. The gallery, the link and submitting

- **The link:** under the chooser's stack, a quiet "Add your own", only
  when `VITE_APP_POLAROIDS` is set.
- **`/polaroids`:** an endless grid you drag or scroll around, wrapping in
  every direction, of polaroid cards (the player's polaroid, with the
  tub viewer from `/admin/polaroid`). Stills by default; only the few
  nearest the centre play their loops, so a phone isn't decoding dozens of
  videos. A loop from the song plays underneath.
- **"Add yours":** the `/admin/record` recorder, made public: camera or
  upload, square crop, 5 seconds, consent. Then a private link, `/p/<id>`,
  that says where it is in the queue until it's made.

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
- [ ] 1. The polaroid container as a standing service on the PC
      (`POLAROID_URL`), `polaroid-run`'s PC path, and the `pc` lane in
      `/admin`; then update CLAUDE.md's Replicate-only rule
- [ ] 2. The next app as a Worker with static assets; D1, the two buckets,
      the routes, Access
- [ ] 3. The inbox and "run the queue" in `/admin/polaroid`
- [ ] 4. The gallery, the link under the stack, and submitting, behind
      `VITE_APP_POLAROIDS`
- [ ] Gallery performance on a phone: how many playing loops it holds
- [ ] Check the matte and portrait across a range of skin tones and
      lighting before strangers' clips go through

## Open questions

- **Legal and privacy:** terms and consent wording, minors, and what
  "delete" removes (atlas, still, caches).
- **Which stretch of the song** loops under the gallery.
- **Cloudflare's email sending:** the Worker binding from Email Routing
  only sends to verified addresses; sending to any visitor needs
  Cloudflare's newer Email Service. Check it's available on the account
  before building on it.
