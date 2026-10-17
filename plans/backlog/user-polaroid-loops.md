---
title: Visitors upload or record a 5-second loop and get their own looping polaroid
status: Backlog
created: 2026-10-10
updated: 2026-10-17
---

# Visitors upload or record a 5-second loop and get their own looping polaroid

## Goal

Let anyone visiting the site upload or record a 5-second clip of themselves,
run it through panels 2-6 of the music video pipeline, and get back a
looping 3D "polaroid" they can pick up and turn. Approved polaroids join a
big, endless gallery grid you pan around, with a music loop playing. An
admin section moderates and manages submissions.

## Decisions (2026-10-16)

- **Open to anyone, capped by a daily budget.** No invite codes or payment.
  A global daily spend cap with a kill switch, plus per-account limits and
  Turnstile.
- **Accounts with Clerk, passwordless** (email code or magic link). A "my
  polaroids" page, deletion tied to the account, and per-person limits that
  are harder to get around than per-IP ones.
- **Fully hosted.** Nothing depends on the artist's machines being on.
- **Panels 2-6 only: portrait, background, matte, depth, outline. No
  dream.** So none of the panel 7 machinery is needed: no Deforum, no
  person check, no repair rounds, and no `NO_PEOPLE_SUFFIX` concern, since
  the visitor's likeness is the point.
- **The polaroid is a 3D object in the client, not a flattened video.** It
  is rendered in R3F from a per-submission atlas, using the depth/matte
  relief that `video-material.tsx` already does for the avatar. A
  flattened still (and maybe a short MP4) is still needed for social
  previews.
- **Gallery:** a big endless grid of looping polaroids you pan around, with
  a music loop playing underneath. No audio or caption on each polaroid.
- **Moderation:** the owner sees their polaroid at a private `/p/<id>` as
  soon as it's done. Nothing joins the gallery until an admin approves it.
- **Retention:** the source clip and intermediate frames are deleted once a
  job finishes or fails. The polaroid's atlas stays until its owner or an
  admin deletes it.

## Context

Today the pipeline is a local CLI the artist runs by hand on one song's
footage, with review at every step. This turns panels 2-6 of it into a
hosted, unattended, paid-per-use service.

- **The steps are already portable.** Every panel 2-6 step calls Replicate:
  matte (`robust_video_matting`), portrait (private DiffusionCLIP), the
  background plate (flux-fill, with `leak-detection.ts`'s JS check for the
  person being redrawn), depth (`zoedepth`) and outline (private lineart).
  Apart from that, a worker needs Node and ffmpeg. Nothing needs the local
  GPU or `uv`.
- **The cost estimate in the old version of this plan is out of date.** It
  priced the portrait as flux-kontext. Panel 2 is now our own DiffusionCLIP
  deployment, and the dream (the other big cost) is gone. The prototype
  task will measure the real per-loop cost. Private Replicate models
  **cold-start**, and with sporadic public traffic that may cost more in
  time and money than the predictions themselves. Measure it.
- **The known per-frame failure modes still apply, and nobody is watching.**
  Matte glitches (CLAUDE.md), the depth model's corner flutter, and
  flux-fill redrawing the person (caught by `leak-detection.ts`, which is a
  skin-tone heuristic tuned on one person's footage, so **it needs checking
  against a range of skin tones** before it gates anyone's job).
- **The 7-panel atlas order is load-bearing for the music video player**
  (CLAUDE.md). The polaroid gets its own atlas layout and material, so the
  player and its `uFrameTotal={7}` stay untouched.
- **Cost guard (CLAUDE.md):** each step keeps its skip-if-output-exists
  check. The worker never retries a failed job automatically. Retries are a
  manual admin action.

## Prototype run: `park-party` (2026-10-17)

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

## Approach (rough, still being scoped)

1. **Capture** (client): sign in with Clerk, then record 5s from the camera
   (MediaRecorder) or upload a clip. Trim to 5s and crop square in the
   browser. Consent and terms before upload.
2. **Submit** (Worker): check auth, per-person limits and the daily budget,
   then issue a signed R2 upload URL, create a submission record (D1) and
   enqueue the job (Queues).
3. **Input gate:** a cheap check on a few frames before spending anything:
   exactly one person, no nudity, nobody who looks under age. A clip that
   fails is rejected with a reason and costs (almost) nothing.
4. **Run** (hosted worker with ffmpeg): `apps/pipeline`'s panel 2-6 steps
   with a "short loop" profile (fps, step fps, size). Automatic checks on
   each panel (leak score, matte sanity) fail the job instead of publishing
   something broken. The worker writes the polaroid atlas to R2 and deletes
   the source and intermediates.
5. **Loop:** make 5s of real footage loop seamlessly. This could be a
   crossfade of the tail into the head, a boomerang, or picking the best
   loop point. Decide in the prototype.
6. **Polaroid** (client): an R3F polaroid card playing the panel 2-6 atlas,
   with depth relief and a drag to tilt and turn. It may cycle or blend
   between panels.
7. **Gallery** (client): a pannable, endless grid of approved polaroids with
   a music loop playing. Needs a performance plan: stills or low-res
   sprite loops by default, with full video only for the few polaroids
   near the centre or under the pointer, so we don't decode hundreds of
   videos at once.
8. **Share:** `/p/<id>` page, an OG image (and maybe a short MP4) rendered
   from the atlas.
9. **Admin:** a moderation queue (approve into the gallery, hide, delete),
   per-submission cost and status, manual retries, a spend dashboard, and
   the kill switch.

## Tasks

- [x] Prototype: run one 5s clip of a new person through panels 2-6 locally
      end to end, measuring cost per step, wall-clock time and cold
      starts (`park-party`, above)
- [ ] Try Bria video-erase for panel 3 on `park-party`
- [ ] Time DiffusionCLIP on faster hardware and higher concurrency
- [ ] Prototype the loop seam on that clip
- [ ] Prototype the R3F polaroid from that clip's atlas (depth relief,
      interaction)
- [ ] Replace or retire `leak-detection.ts` for polaroids (it failed both
      ways on `park-party`), and check the matte across a range of skin
      tones and lighting
- [ ] Pick the hosted runtime and the input-gate model(s)
- [ ] Gallery performance spike: N looping polaroids on a phone
- [ ] Settle the remaining open questions, then split into ready plans
      (pipeline profile + worker, intake + accounts, polaroid + gallery,
      admin)

## Open questions

- **Hosted runtime:** Cloudflare Containers (next to R2/D1/Queues), Fly or
  a small VPS, or Replicate for the ffmpeg steps too? It depends on job
  length and on whether ffmpeg work needs more than a container's limits.
- **Daily budget numbers:** waits on the prototype's cost per loop. What
  happens when the budget is spent? A queue that carries over to tomorrow,
  or "come back tomorrow"?
- **Turnaround:** if it's minutes, does the owner get an email when it's
  done (Clerk has the address), or just come back to `/p/<id>`?
- **Input gate:** which model(s) for one-person, nudity and age checks, and
  how strict? Other people in the background of the clip?
- **Legal/privacy:** terms and consent wording, minors, data location, what
  "delete" removes (atlas, OG image, CDN caches).
- **Polaroid atlas format:** one video with 5 panels side by side (like the
  player) or separate streams? What resolution and codec for a gallery of
  many?
- **Gallery music:** an existing stem or loop from the song, or something
  new?
- **Does the music video site link into this,** or is it a separate
  section or app?
