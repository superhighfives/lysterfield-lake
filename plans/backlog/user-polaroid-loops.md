---
title: Visitors upload or record a 5-second loop and get their own looping polaroid
status: Backlog
created: 2026-10-10
updated: 2026-10-10
---

# Visitors upload or record a 5-second loop and get their own looping polaroid

## Goal

Let anyone visiting the site upload or record a 5-second clip of themselves,
run it through the same pipeline as the music video, and get back a looping
"polaroid" of the result at its own shareable URL. An admin section reviews,
moderates and manages submissions.

## Context

Today the pipeline is a local CLI that the artist runs by hand on one song's
footage, with review at every step (see
`plans/done/frame-preview-approval-tool.md` for the review loop being built
now). Making it public turns it into a hosted, paid-per-use, unattended
service, which changes almost every constraint:

- **Cost per loop, rough** (5s at 24fps = 120 frames; panels stepped at 6fps
  where the pipeline allows): matte 1 call; portrait ~30-120 flux-kontext
  calls ($0.90-$3.60); background one 5s Bria call ($0.25); depth and
  outline ~120 cheap calls (cents); dream ~30 calls ($0.90). Roughly **$2-5
  per loop**, before storage and compute. Someone has to pay for that, and
  abuse limits are essential.
- **People in the frame:** the whole point is the visitor's own likeness in
  panels 2-6. Panel 7 must still never show a person (`NO_PEOPLE_SUFFIX`).
- **Unattended:** no one reviews each frame. The known failure modes (matte
  glitches, Bria passing through bad input, models inventing people) need
  automatic checks or an acceptable failure path.
- **Hosting:** the client is a static Vite site on Cloudflare (Pages + R2).
  The pipeline needs ffmpeg and long-running jobs, which a Worker can't do on
  its own.

## Approach (rough, not scoped)

1. **Capture:** a page to record 5s from the camera (MediaRecorder) or
   upload a clip, trimmed to 5s and cropped square in the browser; consent
   and terms before upload.
2. **Submit:** upload straight to R2 (signed URL), create a submission
   record, put a job on a queue.
3. **Run:** a hosted worker (container or a long-running service that has
   ffmpeg) runs the pipeline steps for the job, writing outputs to R2. It
   reuses `apps/pipeline`'s steps with a "short loop" profile, and the
   preview tool's direction stage could pick or vary the dream style.
4. **Polaroid:** compose the result as a looping polaroid (format to be
   designed: which panels show, the frame and caption, seamless looping of
   a 5s clip).
5. **Share:** `/p/<id>` page and social preview image; optional gallery of
   approved loops.
6. **Admin:** moderation queue (approve, hide, delete), per-submission
   cost and status, failed-job retries (manual only, per CLAUDE.md), spend
   dashboard and kill switch.

## Tasks

- [ ] Work through the open questions and scope a v1
- [ ] Prototype: run one 5s clip through the pipeline locally end to end and
      cost it

## Open questions

- **Who pays, and how is abuse capped?** Free with a daily budget, invite
  codes, a queue with limits per person, or paid?
- **Accounts:** anonymous with a private link, or sign-in (needed for
  "delete my loop", limits, and admin)?
- **Moderation:** pre-moderation (nothing public until approved) or
  post-moderation? Automated checks for unsafe uploads?
- **Privacy and legal:** consent, faces of other people in the clip,
  minors, retention period, deletion requests, data location.
- **Hosting the pipeline:** Cloudflare Containers, a small VPS, Replicate
  for everything (wrapping ffmpeg steps as a model), or something else?
- **Polaroid design:** single panel, a strip of panels, or all seven? Still
  frame plus loop? Audio?
- **Turnaround:** minutes per loop is likely; email or "come back later"
  link, or wait on the page?
- **Relation to the song:** does a polaroid use the lyrics/words panel or
  the music at all?
