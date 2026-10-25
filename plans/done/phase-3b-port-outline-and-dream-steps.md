---
title: "Phase 3b: port outline and dream steps"
status: Complete
created: 2026-08-18
updated: 2026-08-27
---

# Phase 3b: port outline and dream steps

## Goal

Finish phase 3 by porting the two model-audit-dependent steps that phase 3a
deliberately left out: `outline.ts` (the packaged ArtLine Cog model) and
`dream.ts` (Kling 3.0 Omni). Both decisions were resolved in phase 2; this
phase wires them into `apps/pipeline` the same way phase 3a wired the six
already-on-Replicate steps.

This is the second "Phase 3" bullet in
[`rebuild-pipeline-as-replicate-cli.md`](rebuild-pipeline-as-replicate-cli.md)
— see that document and
[`plans/done/phase-3-port-frame-steps.md`](../done/phase-3-port-frame-steps.md)
for full architecture, the model inventory, and the infra (`replicate.ts`,
`job.ts`, `models.ts`) this phase builds on directly. Don't duplicate that
context here.

## Context

**Outline model isn't live on Replicate yet.** `models/outline/` (phase 2)
is validated locally via `cog predict` (CPU) but never pushed. Pushing
needs: `gpu: true` in `cog.yaml` (local validation ran CPU-only — real
per-frame throughput needs GPU), a `cog login` (separate token from
`REPLICATE_API_TOKEN`, at replicate.com/auth/token — not yet configured in
this environment), and a target model slug under the user's own Replicate
namespace (unconfirmed — the current `REPLICATE_API_TOKEN` resolves to the
`replicate` org account via `/v1/account`, not a personal username, so
don't guess one). **Blocked on the user for both the login and the target
slug — ask before starting this half of the phase.**

**The real preprocessing pipeline for outline isn't just "call the model."**
Per `other.py` (see phase 2's Cog packaging work and the parent plan's
context section): matte-cutout the frame onto a white background using the
alpha mask, resize 1024×1024, blend with the corresponding depth-panel
frame via `soft_light` at 0.5 opacity, enhance brightness ×1.4 (contrast
×1.0, i.e. a no-op — don't bother porting it), resize to 300×300, **then**
call the model. `blend_modes`' `soft_light` has no npm equivalent to reach
for — same situation `depth.ts` was already in with `skimage`, hand-roll it
(standard soft-light blend formula, operate on the same raw-buffer/`sharp`
pattern `depth.ts` established). This step depends on `depth.ts`'s output,
not just `matte.ts`'s — sequence accordingly.

**Dream step needs no legacy port at all.** `generate-dreaming.sh` (frame
extraction + `minterpolate` frame-doubling to fake 60fps from Deforum's
sparse output) is entirely superseded — Kling produces a real smooth video
directly. `dream.ts` is: pick a source frame (default the job's first
`frames/source/` frame, matching `--input`/`--id` from the parent plan's
CLI signature; allow an explicit override), call
`kwaivgi/kling-v3-omni-video` with `start_image` + user-supplied `--prompt`
+ `--style-ref` as a `reference_images` entry, download the output video.
No frame-rate/resize normalization here — that's `compose.ts`'s job in
phase 4, same boundary `upscale.ts` already respects (its 2048×2048 output
isn't resized down either).

**Model parameters already proven in phase 2's prototyping** (scene
`20230808103741`, see the parent plan's Open Questions): `mode: "standard"`,
`aspect_ratio: "16:9"`, `duration: 5` for a quick smoke test — production
duration is an open call for phase 4/5, not this phase. `generate_audio:
false` (client has no audio contract for this panel — lyrics/song audio is
muxed separately in `compose.ts`).

## Approach

### Outline

1. **Ask the user first**: Replicate login (run `cog login` themselves, or
   provide a login token) and the target model slug
   (`r8.im/<username>/<name>`) to push under.
2. Flip `models/outline/cog.yaml` to `gpu: true`.
3. `cog push r8.im/<username>/<name>` from `models/outline/`.
4. Add the pinned `owner/name:version` to `apps/pipeline/src/models.ts`
   (`outline: '...'`) — same pattern as every other model, pinning is
   confirmed required project-wide (phase 3a finding), not just for the
   five Replicate-hosted models.
5. `src/steps/outline.ts`: per-frame, depends on `matte.ts` and `depth.ts`
   output frames (not just source frames) — composite matte-cutout on
   white, blend with matching depth frame (`soft_light`, opacity 0.5),
   brightness ×1.4, resize 300×300, call the model, resize result to
   1024×1024. Add an `outline` case to `cli.ts` taking `--source`,
   `--depth`, and the usual `--job`/`--output`/`--concurrency`.
6. Smoke-test against a few real frames (not full-clip) before considering
   this step done — check the blend actually reads like the reference
   examples in `models/outline/test.jpg`/`reference-res.jpg`, not just that
   the call succeeds.

### Dream

1. `src/steps/dream.ts`: takes a job, an explicit or default source-frame
   path, `prompt`, and `styleRef` path. Calls `MODELS.dream` (add to
   `models.ts`) with `start_image` (via `readFileAsInput`), `prompt`,
   `reference_images: [readFileAsInput(styleRef)]`, `duration: 5`,
   `mode: 'standard'`, `aspect_ratio: '16:9'`, `generate_audio: false`.
   Downloads the output `.mp4` into `<job>/video/dream.mp4`.
2. Add a `dream` case to `cli.ts`: `--job`, `--prompt`, `--style-ref`,
   optional `--frame` (defaults to the job's first source frame).
3. Smoke-test against the same scene/prompt/style-ref phase 2 already
   validated (`20230808103741`, its real prompt from the external drive,
   its `colormatch_image` reference) so this is a confirmation of the
   wiring, not a fresh unknown — the visual result is already known-good
   from phase 2.

## Tasks

- [x] Confirm Replicate login + target model slug with the user — user ran
      `cog login` as `superhighfives`
- [x] Flip `models/outline/cog.yaml` to `gpu: true` and `cog push`
- [x] Pin the outline model version in `models.ts`
- [x] `outline.ts` — matte-cutout + depth soft-light blend + brightness
      preprocessing, model call, resize postprocessing
- [x] Add `outline` case to `cli.ts`
- [x] Smoke-test `outline.ts` against real frames — resolved by switching
      `models/outline/cog.yaml` from `gpu: true` to `gpu: false`; see
      Architecture for the diagnosis and why CPU fixed it
- [x] Add `MODELS.dream` (`kwaivgi/kling-v3-omni-video`, pinned)
- [x] `dream.ts` — source frame + prompt + style-ref → Kling call → download
- [x] Add `dream` case to `cli.ts`
- [x] Smoke-test `dream.ts` against the phase-2-validated scene/prompt —
      matches phase 2's result (person fully dissolves into a watercolor
      landscape by the end of the clip)
- [x] Tick the second "Phase 3" box in the parent plan's task list

## Open questions

- **Resolved — the model itself isn't the problem** (2026-08-19): the exact
  error Replicate gives is `model container failed to boot and complete
  setup within 615 seconds`, not an infinite hang. Ran the actual pushed
  image locally (`docker run -p 5001:5000 r8.im/superhighfives/
  lysterfield-outline:latest`, plus a real prediction against it) — `setup()`
  completes in ~2.5 seconds and the prediction succeeds, correct line-art
  output, even under QEMU amd64-on-arm64 emulation on a laptop. So the
  image, the `python` symlink fix, the checkpoint, and `predict.py` are all
  confirmed fine. The 615s timeout is happening somewhere in Replicate's own
  GPU worker provisioning/boot path (image pull time, CUDA driver init on
  their actual hardware, scheduling) — outside what's diagnosable or fixable
  from this repo.
- **Redeploy didn't clear it** (2026-08-19): pushed again (same `cog.yaml`,
  fresh digest `57ee741c...`) on the chance it was transient — a new
  prediction against the new version sat in `starting` for 12+ minutes
  (past the 615s mark the earlier failure reported) before being manually
  cancelled; Replicate's own auto-timeout never fired within that window
  either. Ruling out "just retry" as a fix. Next step is genuinely
  Replicate support — this repo's side of the problem is done and verified.
- **Still stuck a week later** (2026-08-25): retried at the user's request
  after a week's gap, on the chance it was a transient platform issue that
  would have cleared. Pushed a completely fresh version (digest
  `500b3259...`) and ran a new prediction — same symptom, stuck in
  `starting` for 15+ minutes with zero logs, manually cancelled. Time alone
  doesn't fix this.
- **Resolved — dropped GPU, boots and predicts correctly** (2026-08-27):
  the image was 6.97GB, almost entirely CUDA/GPU-torch (a 2.81GB CUDA/cuDNN
  base layer + a 4.07GB GPU-torch install layer) for a model that's a
  300×300 U-Net — never actually compute-heavy enough to need a GPU. Phase
  2's very first local validation, before any GPU work, ran this same
  checkpoint on CPU in ~2.5s. Rebuilt with `gpu: false` (kept the harmless
  `python` symlink line as insurance) — the resulting image builds and
  pushes in a fraction of the time, and a live prediction against the
  hosted endpoint succeeded on the first try: 20.6s total (most of that
  cold-start), 0.77s actual predict time, correct output. Confirmed the
  full `outline.ts` step (not just the raw model) end to end via the CLI
  too. GPU was never load-bearing for this model; it was the entire cause
  of the boot failure.

## Overview

Both steps are fully shipped and verified end to end against live
Replicate endpoints.

`dream.ts`: one `kwaivgi/kling-v3-omni-video` call per scene, taking a
source frame + prompt + style-reference image, downloading the resulting
video. Confirmed working via the CLI against the same scene/prompt/
style-ref phase 2 already validated.

`outline.ts`: matte-cutout onto white, soft-light blend with the matching
depth frame, brightness enhancement, then the packaged ArtLine model call.
The model (`superhighfives/lysterfield-outline` on Replicate) runs on CPU,
not GPU — the `gpu: true` build was correct code but never booted on
Replicate's actual GPU infrastructure (see Open Questions for the week-long
diagnosis); switching to CPU fixed it outright, and CPU predict time
(~0.8s/frame) is fine for a model this size. Confirmed via both a direct
model call and the full `outline.ts` step through the CLI.

## Architecture

Four `cog push` attempts before landing a build that at least *pushes*
cleanly:

1. `gpu: true`, cog 0.21.0, default CUDA base image — pip install fails
   with `externally-managed-environment` (a real, currently-open upstream
   bug: `uv`-managed Python + CUDA base image + PEP 668, see
   `replicate/cog#2994`).
2. Upgraded to cog 0.22.0 (brew's `cog` formula shadowed the pre-existing
   `/opt/homebrew/bin/cog` binary — invoked the Cellar path directly rather
   than fight the user's `PATH`/symlinks) — pip install succeeds, but the
   container fails at `cog`'s own post-push verification step:
   `[FATAL tini] exec python failed: No such file or directory` (the CUDA
   base image only provides `python3`, not `python`).
3. `--use-cuda-base-image=false` to sidestep both — builds and pushes
   cleanly, but Replicate auto-disabled the resulting version:
   `"Version disabled ... consistently fails to complete setup"` — almost
   certainly because a `gpu: true` model needs actual CUDA in the image,
   which this flag removes entirely.
4. Reverted to the default CUDA base image, added an explicit
   `run: ln -sf $(which python3) /usr/bin/python` to `cog.yaml` to fix
   attempt 2's real problem without attempt 3's regression. This build
   pushes cleanly *and* passes cog's own local post-push verification
   (which actually boots the image) — but predictions against it still
   hang in `starting` forever on Replicate's actual GPU workers, confirmed
   on both T4 and L40S hardware tiers.

That last hang wasn't a code bug: a missing-hardware-tier issue (checked,
both tiers configured), the `externally-managed-environment` bug (fixed,
build 4 gets past pip install), and the missing-`python`-symlink bug
(fixed, confirmed by `cog push`'s own local boot-and-verify step
succeeding) were all ruled out. What actually fixed it — attempt 5, a week
after attempt 4 — was dropping GPU entirely: `docker history` on the
pushed image showed 6.97GB total, with a 2.81GB CUDA/cuDNN base layer and
a 4.07GB layer installing GPU-enabled torch accounting for nearly all of
it, for a model that's a 300×300 U-Net doing sub-second CPU inference.
Rebuilding with `gpu: false` produces a dramatically smaller image with no
CUDA base, no CUDA driver initialization, and no GPU-torch wheel — and it
booted and predicted correctly on the very first live attempt (20.6s cold
start, 0.77s predict). The exact mechanism on Replicate's side (image pull
time against a boot budget, GPU worker provisioning/scheduling, CUDA
driver init cost) is still a hypothesis, not confirmed from their end —
but the fix works regardless of which of those it actually was, and GPU
was never load-bearing for a model this small in the first place.
