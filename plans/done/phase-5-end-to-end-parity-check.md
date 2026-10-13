---
title: "Phase 5: end-to-end run + parity check against an existing published scene"
status: Complete
created: 2026-08-28
updated: 2026-10-09
---

# Phase 5: end-to-end run + parity check against an existing published scene

## Overview

**Superseded, not finished as written (2026-10-09).** This plan set out to
run the whole new chain on real footage and compare it with a published
scene. The cheap 42-frame pass did that and recorded real per-call costs
(below), but its open questions (artwork flicker against the originals,
Kling dreams keeping a recognisable face, the cost of a full-length run)
were overtaken by [phase 4e](phase-4e-full-video-source-prep.md): instead of
regenerating panels, the full-song job reuses the legacy run's portrait,
matte, depth and outline frames and its ten Deforum dreams, and generates
only panel 3 (Bria). The fixed-seed flicker test's verdict was never
recorded. Regenerating and publishing the dreams is
[phase 4f](../in-progress/dreams.md).

## Architecture

Nothing from this plan shipped beyond what earlier phases built. Still
useful: the per-call cost table, the `nano-banana-2` → `flux-kontext-dev`
artwork swap and why, and the warning about retry loops against the
Replicate API (Findings 2026-08-29).

## Goal

Run one real iPhone source video all the way through `apps/pipeline`'s full
CLI chain — `init` → `matte` → `background-plate` → `artwork` ×2 →
`upscale` ×2 → `depth` → `outline` → `dream` → `compose` — and compare the
result against an already-published `apps/client` scene for parity (visual
+ rough cost/time budget per scene). This is the fifth phase bullet in
[`rebuild-pipeline-as-replicate-cli.md`](../in-progress/rebuild-pipeline-as-replicate-cli.md)
— see that document for full project architecture. Every step has already
been individually smoke-tested (phase 3, 3b) and chain-tested against
synthetic footage (phase 4); this phase is the first real, full-length,
full-cost run of the whole thing, and the first real signal on whether the
new pipeline's output is actually comparable to what the old bash-script
pipeline produced.

## Context

**Target scene: `20230808103741` ("Watercolour").** Its `dreams.json`
prompt is `"A watercolor painting"` — the exact style `artwork.ts` already
targets by construction (its fixed style-reference image, added in the
DiffusionCLIP → `nano-banana-2` swap, *is* a real DiffusionCLIP watercolor
output — see
[`plans/done/phase-3-port-frame-steps.md`](../done/phase-3-port-frame-steps.md)'s
2026-08-28 addendum). Picking this scene means the parity check validates
both phase 4's compose/manifest wiring and the artwork-model swap in one
run, against a style the new pipeline should have its best shot at
matching. `apps/client/public/assets/20230808103741/` already has the
published `hero.jpg` + `loop.mov` to compare against; the full-quality
`video.mov`/`video.webm` aren't committed (gitignored `dreams/`), so
they'd need pulling from wherever they're actually hosted (R2, per
`client-manifest.ts`'s comment) or regenerating isn't meaningful for
parity — the comparison is against the *original* output, not a fresh
regeneration of the old pipeline.

**Blocked on the external drive.** The raw iPhone source footage for any
scene lives only on `/Volumes/HDD/lysterfield-lake-pipeline` (per this
session's repeated checks — nothing under either the `lysterfield` or
`lysterfield-lake-pipeline` repos on this machine has real, unstylized
source video; every local `.mov` is already a published/committed
choose-screen asset). Needs the drive mounted before any of this phase's
tasks can start. Once mounted, locate the scene's original source clip —
likely under a directory keyed by the same `20230808103741` timestamp, per
the old pipeline's apparent id scheme (worth confirming against
`generate-title.sh`/`generate-videos.sh`'s actual path construction, read
during phase 4's research, rather than assumed here).

**What "parity" means here, concretely:**
- **Visual**: the final composite's `artwork`/`background` panels should
  read as recognizably the same watercolor style as the published scene's
  video — not pixel-identical (different model, different frame content
  even if the same source clip), but the same aesthetic family. Also
  worth a visual sanity check that the other five panels (matte, depth,
  outline, dream, words) look sane at full length, not just on the
  4-frame synthetic clip phase 4 tested.
- **Cost/time**: rough total Replicate spend and wall-clock time for one
  full scene, at whatever fps/length the source clip actually is (real
  scenes are likely much longer than phase 4's 4-frame synthetic test, so
  this is the first real signal on whether concurrency settings and
  per-step timing are viable for regular use — see the outline/artwork
  boot-time flakiness both already surfaced mid-pipeline in phases 3b/4).
  No existing baseline number to compare against from the old pipeline
  (nothing in `lysterfield-lake-pipeline`'s scripts logs cost or timing) —
  so this is establishing a first number, not checking against a target.

## Tasks

- [x] Confirm external drive is mounted; locate scene `20230808103741`'s
      original raw source video — found `video-final/main.mov`: one
      shared raw clip (1920×1080, 165s, ~60fps) used across *every*
      scene. Per-scene identity comes entirely from the dream panel's
      Deforum prompt/`colormatch_image` (found in
      `video-final/dreaming/20230808103741/20230808103741_settings.txt` —
      real generation prompt was `"a detailed watercolor painting of a
      lake at dawn with sunlight through trees, trending on Artstation"`,
      not `dreams.json`'s display caption, plus an Unsplash
      `colormatch_image` used as the style reference) — not a separate
      source clip per scene, contrary to this doc's original assumption.
- [x] Run the full CLI chain against it, backgrounded per step. Scoped to
      a cheap first pass per the user's call: `--fps 2 --offset 0
      --length 20` (42 frames) rather than the legacy pipeline's full
      60fps/~215s — see Open Questions for why. All nine steps
      (`init`/`matte`/`background-plate`/`artwork`×2/`depth`/`outline`/
      `upscale`×2/`dream`) completed successfully; 296 total Replicate
      predictions for this one 42-frame pass.
- [x] `compose` into a scratch client dir first — succeeded, correct
      7168×1024 composite, correctly looped/clipped to the real audio's
      214.8s length from only 42 unique source frames.
- [x] Visual parity check — see Overview for the verdict; strong parity
      on 5 of 7 panels, one already-tracked pre-existing issue confirmed
      not-a-regression, one intentional (phase-2-accepted) difference.
- [x] Record rough cost per step — resolved via the user checking the
      Replicate dashboard directly (API scraping stayed blocked, see
      below): `nano-banana-2` $0.07/call, `flux-kontext-dev` $0.03/call,
      `zoedepth`/`real-esrgan`/`lama`/`outline` all <$0.01/call,
      `kling-v3-omni-video` $0.85/call, `robust_video_matting` unknown
      (outside the dashboard's 24h window when checked).
- [x] Artwork model swapped again: `nano-banana-2` → `flux-kontext-dev`
      — cost *and* quality/reliability win, see Findings below.
- [ ] Resolve the temporal-flicker gap vs. the original published
      videos — **in progress**, see Findings. Fixed-seed test done and
      handed to the user to review; verdict pending.
- [ ] Decide with the user on full-scene scope (fps/length) and whether
      to spend on a larger run, once the flicker question is resolved
- [ ] Decide with the user whether to write a real result into
      `apps/client` (as a new scene, or discard) — this scene id is
      already taken, so a real write would need a different id even if
      the output looks good enough to keep
- [ ] Write up final findings and move this doc to `plans/done/`
- [ ] Tick Phase 5 in the parent plan's task list

## Findings so far (2026-08-28 test pass)

**Call-count breakdown for the 42-frame test** (one Replicate prediction
each unless noted): `matte` ×1 (whole-video call), `background-plate`
(lama) ×42, `artwork` ×42, `background` (artwork on background-plate
output) ×42, `depth` ×42, `outline` ×42, `upscale` (artwork) ×42,
`upscale` (background) ×42, `dream` ×1 (whole-scene call). **296 total
predictions.** A full-length scene at the same 2fps (214.8s × 2 ≈ 430
frames) would scale to roughly 430×7 + 2 ≈ **3,012 predictions**; at the
legacy pipeline's full 60fps (~12,887 frames) it would be roughly
**90,211 predictions** — confirms this session's earlier back-of-envelope
number from `main-compiled-original.mov`'s actual frame count.

**Visual parity**, comparing the new composite against
`video-final/output/final/20230808103741/video.mov` (the original
published full-quality video, found on the drive) at a matched
mid-timestamp:
- **Artwork** (words idx 2): same watercolor style family as the
  original — arguably cleaner, since `nano-banana-2` doesn't reproduce
  DiffusionCLIP's color-bleed/melting artifacts. Good style-swap
  validation on real footage, not just the single-frame comparison test
  from the diffusionclip → nano-banana-2 swap.
- **Background** (idx 3): the person is still visible as a faint
  silhouette in *both* the new and the original panel — confirms the
  background-plate ghosting issue tracked in phase 3's open questions is
  a pre-existing limitation of the original pipeline too, not something
  introduced by switching ProPainter → LaMa.
- **Matte / outline** (idx 4, 6): near-identical in shape/style to the
  original in both panels.
- **Depth** (idx 5): same general concept (grayscale head/shoulders
  silhouette), slightly lower contrast than the original — minor, not
  investigated further.
- **Dream** (idx 7): visibly different from the original by design — the
  original is a fully Deforum-painted landscape with no visible person;
  the new one is Kling's more photographic `start_image`-diffused result
  that keeps the real face recognizable. This is the phase-2-accepted
  Deforum → Kling tradeoff playing out on real footage, not a bug.

## Findings (2026-08-29 cost + model investigation)

**Real per-call cost, from the Replicate dashboard** (the 42-frame pass's
296 predictions): `nano-banana-2` $0.07, `zoedepth`/`real-esrgan`/`lama`/
`outline` all <$0.01, `kling-v3-omni-video` $0.85, `robust_video_matting`
not found (outside the dashboard's 24h retention when checked). With
`nano-banana-2` called twice per frame (artwork + background panels), it
was the dominant cost line by far — roughly $0.14 of every ~$0.19
per-frame upper bound. Extrapolated: a full scene at the same 2fps
(~430 frames) would run **~$80–85**; at the legacy pipeline's full 60fps
(~12,887 frames) it would run **~$1,800 for `nano-banana-2` alone**,
confirming the earlier call-count-only estimate was directionally right
and that reproducing the legacy fps is a non-starter cost-wise.

**API cost-scraping stayed blocked, and made it worse.** Tried pivoting
from paginating the noisy `/v1/predictions` firehose (see the earlier
`falcons-ai/nsfw_image_detection` investigation) to the `?model=`+
`created_after` query params instead, mirroring the dashboard's own
filter UI. That query shape works, but hit persistent 403s — and a retry
loop bug (no backoff cap, retried the same request indefinitely on
failure) turned a rate-limit into several minutes of continuous hammering
before it got killed. Lesson: don't write retry loops against this API
without a hard attempt cap and real backoff; when blocked, stop and ask
the user to check the dashboard directly rather than escalating requests.

**Artwork model swapped a second time: `nano-banana-2` → `flux-kontext-dev`.**
Cost was the trigger (see above), but the replacement won on quality too:
- Tried `black-forest-labs/flux-dev` first (confirmed $0.025/image,
  cheaper) — failed outright. Its img2img at `prompt_strength: 0.75`
  didn't respect the input image at all; output was a different person in
  a different scene, not watercolor. Not a viable candidate as tested.
- `black-forest-labs/flux-kontext-dev` (an official, open-weights image-
  *editing* model, not a generic img2img model) worked well on the first
  try: reliably preserves the source frame's identity/composition while
  applying the watercolor look from a text prompt alone — no separate
  style-reference image needed, unlike `nano-banana-2`. Confirmed
  $0.03/call from the dashboard — less than half of `nano-banana-2`'s
  $0.07, and it only needs a single `input_image` field rather than the
  two-image `image_input` array, so `replicate.ts`'s `uploadFileOnce()`
  and `resources/style/watercolor-reference.png` were removed as
  unused — the style is now carried entirely by `artwork.ts`'s prompt.
- Real 60-frame (1s @ 60fps) full-chain re-test with `flux-kontext-dev`
  also showed **much better frame-to-frame temporal stability** than
  `nano-banana-2` on the same footage — palette, tree position, and
  lighting stayed essentially locked frame to frame, vs. `nano-banana-2`'s
  visible color/exposure flicker on the same 60 frames. Likely because
  `nano-banana-2` has no `seed` input at all (each call draws a fresh
  random seed) while kontext-dev's editing behavior is inherently closer
  to the input structure regardless.

**But neither model matched the original published videos' motion
quality**, per the user's review — comparing against a real published
scene (`lysterfieldlake.com/dreams/20230812145711/video-small.webm`)
confirmed the original artwork panel is far more temporally locked than
either replacement: sampling frames 0.1s apart shows near-frozen
composition/color with only subtle drift, not the more independent
per-frame variation both `nano-banana-2` and (to a lesser extent)
`flux-kontext-dev` show. Hypothesis: the legacy DiffusionCLIP pipeline
was effectively running with a consistent/deterministic seed, so small
input changes between adjacent real-footage frames produced correspondingly
small output changes — whereas our calls don't set a seed at all.
`flux-kontext-dev` does expose a `seed` input (confirmed in its schema;
`nano-banana-2` doesn't have one). Added an optional `seed` param to
`artwork()` and a `--seed` CLI flag, then re-ran the same 60-frame test
with a fixed seed (`42`) across every frame of both artwork panels,
composed the full video, and handed it to the user to review — **verdict
pending**. If the fixed seed doesn't fully close the gap, the remaining
flicker may be coming from the other per-frame panels (depth/outline/
matte), which also call their models independently per frame with no
seed control, or from the sheer density of 60 *unique* outputs/second
reading as busier than the original's effectively-lower novelty rate —
worth checking next if the seed test doesn't resolve it.

## Open questions

- **Resolved — which raw clip**: there isn't a per-scene clip; every
  scene shares one raw source (`video-final/main.mov`). See Findings.
- **Resolved — cost/spend authorization for this test pass**: user
  confirmed a scoped-down first pass (2fps, 20s, 42 frames) rather than
  full 60fps, specifically to get real per-call cost data before
  deciding on a full-scene run. Full-scene spend authorization is still
  open — pending the actual dashboard cost figure for this pass.
- **Resolved (worked around) — this account's `/v1/predictions` list
  can't be scraped for cost**: dominated by unrelated `falcons-ai/
  nsfw_image_detection` platform traffic; even the `?model=`+
  `created_after` filtered form hit persistent 403s. Not investigated
  further — the user checking the dashboard UI directly is fast and
  reliable, use that instead of API scraping going forward.
- **Open — does a fixed seed close the temporal-flicker gap?** Test run,
  pending the user's review. See Findings.
- **Open — if not, is the gap in the other per-frame panels, or in
  raw per-frame call density?** Not investigated yet — next step if the
  seed test doesn't resolve it.
- **Open — full-scene scope/cost authorization**: still pending on
  resolving the flicker question first; no point costing out a full run
  against a model/parameter combination that might still change.
