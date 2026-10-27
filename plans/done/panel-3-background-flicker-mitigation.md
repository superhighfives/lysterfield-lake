---
title: "Panel 3 (background) flicker mitigation on real footage"
status: Complete
created: 2026-09-17
updated: 2026-10-27
---

# Panel 3 (background) flicker mitigation on real footage

## Goal

Record the full trail of approaches tried against panel 3's real-footage
flicker problem, what was kept, what was rejected and why, and draw a line
under this thread: the current state is good enough to stop iterating on
flicker-mitigation technique for now. The next active thread is a different,
complementary idea — softening panel 3's overall style so it reads more like
the legacy pipeline's forgiving, abstract watercolor wash (see "Next up"
below) — not further flicker-chasing.

All preview clips referenced below are on `~/Desktop/` (not committed —
scratch review output, per this repo's "generated assets" rule).

## Context

Test bed throughout: `real-15s-60fps` job (misnamed — actually 24fps, 361
frames, ~15.04s), built from
`/Volumes/HDD/lysterfield-lake-pipeline/video-final/main.mov`. This is a
camera zoom-out shot with a gradual content reveal (a boardwalk becomes
visible ~7.5–9s in) that most single-fill approaches have to handle as a
special case.

**Root cause, fixed in code** (`apps/pipeline/src/steps/background-plate.ts`):
DiffusionCLIP-style stylization is deterministic and stable on real
photography, and flux-fill-pro's raw fill is stable in isolation — but
running DiffusionCLIP-style stylization *on top of* flux-fill-pro's
AI-generated fill amplified small per-frame differences into large visible
identity changes (a whole tree changing shape/species between frames). Fix:
reordered the pipeline so `background-plate` erases+fills *after* styling
(runs directly on `artwork-upscaled`, panel 2's output) instead of before.
This also removed a redundant upscale pass, since flux-fill-pro fed an
already-1024px input returns 1024px output directly. Confirmed via
side-by-side as a major, real improvement — this reorder is committed to
the pipeline's actual behavior, not just a scratch experiment.

Even after the reorder, genuine residual flicker remains, because
flux-fill-pro is still one independent API call per frame with no real
temporal conditioning. Everything below is about managing *that* residual
flicker, confirmed only after auditing full clips (not small samples — an
early mistake in this investigation was judging small 5–20 frame windows as
"fixed" when the full clip told a different story).

- `reordered-preview.mp4`, `compare-1-2.mp4` — early side-by-sides
  confirming the reorder fix itself, before residual-flicker work started.
- `artwork-background-preview.mp4` / `artwork-background-preview-v2.mp4` —
  the reorder fix compared against the original (pre-reorder) pipeline;
  v2 was flagged by the user as "the best one" at that stage of the
  investigation.

## Approaches tried (residual flicker, post-reorder)

### 1. Whole-frame `tmix` temporal smoothing — rejected
`ffmpeg tmix=frames=5` averaged over the whole panel. Looked fine in short
isolated samples, but the user caught (after full-clip review) that it
creates real blur and visible smearing/double-exposure specifically at the
boardwalk content-reveal moment — smoothing across a real scene change
doesn't work. Explicitly rejected by the user ("I want to avoid the
smoothing, cause it makes the animation look blurry too"). Removed from
`compose.ts`.

### 2. Zone-based motion-compensated crossfade — validated, not yet formalized
Two reference "master" fills (frame 100 pre-reveal, frame 300 post-reveal),
each scaled per-frame to compensate for camera zoom (tracked via a smoothed
alpha-mask bounding-box-height signal), cross-faded across the actual
reveal window (frames ~190–260).

- **Preview**: `panel3-zoned-full.mp4`, `tmix-vs-zoned.mp4` (comparison)
- **Verdict**: the cleanest result of everything tried — no visible
  artifact anywhere in a full 361-frame audit, and the reveal transition is
  smooth/continuous rather than a hard cut.
- **Caveat**: exists only as a scratch script (`/tmp/zone-compensate.ts`),
  not a real pipeline step. Hardcodes this clip's specific reference frames
  and crossfade window — generalizing to scenes with a different number of
  reveal moments (zero, one, several) is unsolved design work, not yet
  attempted.

### 3. Masked `tmix` (smoothing confined to the mask region) — rejected as a fix, validated the masking idea
Same `tmix` smoothing as #1, but composited only inside the dilated/blurred
alpha mask, with the sharp original everywhere else.

- **Preview**: `panel3-masked-tmix.mp4`
- **Verdict**: confirmed masking-to-just-the-fill-region is a sound
  technique (keeps everything outside the person-shaped region perfectly
  sharp) — but doesn't fix the underlying flicker, since the flicker *is*
  the masked content, and still smears at the boardwalk reveal. Superseded
  by the masked-stepped approach below, which reuses the masking idea.

### 4. Masked "stepped" cadence (fill only) — good, superseded by #5
Per the user's suggestion to reuse panel 7 (dream)'s stepped/held cadence
(`fps=6,minterpolate='mi_mode=dup:fps=24'`) instead of blending: the fill
content is downsampled to 6fps then held, masked into just the fill region
same as #3.

- **Preview**: `panel3-masked-stepped.mp4`
- **Verdict**: reads as deliberate stop-motion rather than random flicker,
  no smearing, stays sharp outside the mask, and needs zero per-clip tuning
  (just an fps setting — generalizes automatically, unlike #2). The
  boardwalk reveal lands as one hard pop rather than a smooth transition,
  since it happens to fall inside a single 6fps hold window — a real but
  minor tradeoff.
- **Bug found and fixed**: the mask itself was still being recomputed live
  from the real per-frame alpha (24fps) while the fill sat frozen for each
  6fps hold — meaning the blend boundary kept crawling under a static fill.
  Fixed in #5.

### 5. Masked "stepped" cadence (fill *and* mask synced) — current best generalizing candidate
Reshaped the alpha mask for all 361 frames, compiled to video, and ran the
exact same `fps=6,minterpolate=dup:fps=24` conversion used on the fill
content — so the mask now holds/steps in lockstep with the fill instead of
moving independently.

- **Preview**: `panel3-masked-stepped-v2.mp4`
- **Verdict**: confirmed via direct pixel measurement, not just visual
  inspection — frame-to-frame mean pixel diff of the mask itself dropped
  from ~0.7–1.9 (live mask, every frame) to ~0.007–0.016 within a hold
  window (essentially JPEG noise floor), changing only at genuine step
  boundaries that match the fill's own steps. Same generalizes-for-free
  property as #4, now with the edge-crawl artifact eliminated too.

### 6. Depth-based shadow/halo overlay — separate idea, parked
Not a flicker fix — a different visual treatment explored per explicit user
request: composite a soft white halo onto the background, shaped by the
depth panel's brightness and masked by the alpha matte, fading via a
hand-rolled box blur (sharp/libvips's own `.blur()` had a real reproducible
banding bug on this kind of input — confirmed via raw pixel sampling,
worked around in `steps/shadow.ts`).

- **Preview**: `shadow-preview.mp4`, `halo-preview.mp4`
- **Status**: implemented (`apps/pipeline/src/steps/shadow.ts`, wired into
  `cli.ts`'s `shadow` case) but not integrated into `compose.ts`'s real
  pipeline flow, and not decided on — set aside mid-brainstorm when the
  conversation moved to the flicker investigation above. Revisit
  separately if the halo look is still wanted.

### 7. Prompt editing to avoid discrete trees — tried, not reliable
Tested whether removing "a lone tree" from `FILL_PROMPT` (in favor of
softer, more abstract language closer to the legacy pipeline's style) would
reduce the single-object flicker that's most visible in a crisp, isolated,
hard-shadowed pine tree. Ran a 3-frame test (no saved preview — scratch
frames only).

- **Verdict**: unreliable. One frame improved (no isolated tree); another
  got worse (four scattered saplings *and* a new hallucinated fake
  signature/watermark artifact); a third was unchanged (still placed a
  solid pine in the fill region). Confirmed via the model's actual API
  schema that flux-fill-pro has no negative-prompt input, and guidance is
  already at its max (100/100) — there's no stronger lever than prompt
  wording, and prompt wording alone doesn't reliably suppress this. Not
  pursued further as a flicker-mitigation angle.

## Combining option 2 with a temporal-mitigation technique

Ran both remaining candidates (#2 zone-based, #5 masked-stepped-v2) on top
of `background-soft` instead of `background-upscaled`, to see whether the
softer style changes which one wins.

- **Masked-stepped-v2 on `background-soft`** (`panel3-soft-stepped.mp4`):
  clean. Same deliberate stepped cadence as before, now with the diffuse
  texture too — no new artifacts introduced by combining the two.
- **Zone-based crossfade on `background-soft`** (`panel3-soft-zoned.mp4`):
  **regressed**. A full-res frame pulled from inside the crossfade window
  (~9s) shows a visible ghosting/double-exposure artifact — two overlapping
  boardwalk paths crossing in an X. The crossfade's raw-pixel blend was
  relying on the sharp masters' high-frequency detail to read as a clean
  transition; against the softer, lower-contrast fill the same blend shows
  through as a double image instead. Would need rework (e.g. blending in
  mask-alpha space rather than raw pixel averaging) to combine cleanly with
  the softened style — not attempted.

**Current recommendation: masked-stepped-v2 on `background-soft`.** No
known artifacts, generalizes without per-clip tuning, and now includes the
softer/legacy-like texture. Zone-based remains the cleanest *sharp-style*
option if the softened style is ever reverted, but needs rework before it
can pair with it.

### Mask-cadence variants on masked-stepped + `background-soft`

Three ways to compute the mask that gates the stepped fill, tried and
compared:

- **Synced/dup** (`panel3-soft-stepped.mp4` — this is masked-stepped-v2):
  mask frozen in lockstep with the fill via the same
  `fps=6,minterpolate=mi_mode=dup:fps=24` conversion — fully static during
  each hold, jumps together with the fill.
- **Live** (`panel3-soft-stepped-livemask.mp4`): mask recomputed from the
  real per-frame alpha every frame (24fps), independent of the fill's
  stepping. Confirmed via direct pixel diff to still move every frame
  (~1.5–2.2), same magnitude as before — but against the soft fill's lower
  contrast the resulting composite-level diff came out close to the synced
  version anyway, so the crawl is present but far less visible than it was
  against the old sharp fill.
- **Motion-compensated** (`panel3-soft-stepped-mcimask.mp4`, new): built by
  downsampling the reshaped mask to 6fps (same 6 real sample points/sec as
  the fill) then upsampling with `minterpolate mi_mode=mci` (motion-
  compensated interpolation) instead of `mi_mode=dup`. The mask boundary
  glides continuously between real sample points — confirmed via diff
  (~0.6–1.4 every frame, no jump-cut) — tracking actual motion rather than
  either freezing or moving independently of the fill's cadence. Full-clip
  audit (including at the boardwalk reveal, where interpolation artifacts
  are most likely) found no warping/ghosting. Conceptually the best of the
  three: the cutout follows real movement naturally while the revealed
  content still holds in deliberate painterly steps.

**Final pick: motion-compensated mask (`panel3-soft-stepped-mcimask.mp4`).**
Confirmed by the user after watching all three in motion. This is the
combination going forward: `background-soft` fill (option 2, softened
style) + fill held at 6fps (`mi_mode=dup`) + mask motion-compensated at
6fps (`mi_mode=mci`).

## Person-leak detection and repair

Spotted by the user watching a preview: flux-fill-pro occasionally
reconstructs a person instead of erasing one — a real, known failure mode
(see `background-plate.ts`'s mask-reshaping comment; likely made somewhat
more likely by dropping `guidance` 100→35 for the softened style). Found
8 of 361 `background-soft` frames affected (6 severe, 1 partial/ghosted, 1
borderline), clustered around frames 7–8 and 116, 201–205.

**Detection**: a local, free, zero-API-cost heuristic — for each frame,
find the alpha mask's bounding box, take the top 22% of it (the head/neck
zone), and measure what fraction of pixels there fall in a skin-tone color
range. A naive whole-mask version of this false-positived heavily on the
wooden boardwalk's tan planks; restricting to the head zone specifically
fixed that (script logic: `/tmp/find-leaks3.ts`, not yet a real pipeline
file). Clear separation in practice: confirmed leaks scored 11.8–69.8%,
confirmed-clean frames topped out at 6.8%.

**Repair — first attempt, wrong, corrected.** Initially patched all 8
flagged real frames individually. The user caught this immediately after
watching the result ("It seems super chaotic now... only swap the frame
that gets extended, not every single individual frame") — correct call.
The masked-stepped technique only ever shows ONE representative real frame
per ~4-frame window (whichever `fps=6` samples), held via
`minterpolate=dup`; patching every real frame in a leak run, especially
with different reference targets for different frames in the same window
(e.g. frames 201–203 patched from 200, 204–205 from 206), created visible
stutter/freeze-jump artifacts in the raw 24fps video and wasted effort on
frames that never surface in the actual stepped output at all.

Fixed by tracing the *real* sampled keyframe for each affected window —
burned a visible frame number into every source frame with `drawtext`,
ran it through the exact production filter chain
(`fps=6,minterpolate=mi_mode=dup:fps=24`), and read off which source frame
each output window actually shows. (First attempt at this trace was itself
off by one — `drawtext`'s `%{frame_num}` is 0-indexed against 1-indexed
source filenames — caught by cross-checking against the still-visibly-bad
composite output rather than trusting the derivation blind.) Confirmed
actual keyframes: 202 and 206 (not 201/205), 6 (not 7/8), 114 (not 116).
Reverted the 6 unnecessary patches back to their true originals, patched
only 202 (from 200) and 206 (from 207) — the other two regions' real
keyframes (6, 114) were already clean, so needed no patch at all.

Re-verified clean afterward, both the two corrected source frames and the
actual composited output at the real keyframe positions (visually
confirmed, not just via the automated score). All downstream derived
assets (stepped fill, both mask variants) were rebuilt from the
correctly-patched `background-soft` — patching the source alone isn't
enough, anything already baked from an older version needs regenerating.

**Lesson**: for any technique that samples/holds a subset of frames,
verify which frame is actually sampled empirically (trace it through the
real filter chain) before patching — don't assume a clean arithmetic
mapping, and don't patch frames "to be safe" without confirming they're
actually load-bearing for the output.

**Adopted as a process going forward**: this detector is cheap enough
(~1 minute for 361 frames, no Replicate cost) to run as a real validation
step on every future generation — including if/when background-plate
switches to generating only 6fps-native keyframes (~90 for a 15s clip)
instead of all 361 frames, which this scales down to trivially. Worth
formalizing into a real `src/steps/*.ts` utility alongside whichever
temporal-mitigation technique ships, rather than staying a manual
post-hoc check.

## Contact shadow (WebGL, not pipeline)

Follow-on request: add a contact shadow at the person's feet, driven by
the alpha mask (not depth). Investigated where this should live first —
earlier client-side research this session found the main Avatar composite
(what most viewers actually see) is built from panel 2 (artwork) + panel 4
(matte/alpha) and **never reads panel 3 at all**; panel 3 only appears in a
small, always-desaturated "Polaroid card" hover element. So a shadow baked
into panel 3 in the pipeline would never show up in the real scene — this
has to be a WebGL/shader effect against panel 4, not a pipeline step.

Implemented in `apps/client/src/materials/video-material.tsx`, scoped to
the Avatar mesh (`uAvatar == 1.0`): for pixels outside the person's own
silhouette, march a short distance through the same alpha-mask texture
looking for a nearby person-edge, and darken/add alpha proportional to
closeness — a soft falloff hugging the bottom of the silhouette. Cheap
(14 texture samples, only on non-person pixels), needs no new pipeline
data. Builds cleanly (`bun run --cwd apps/client build`).

**Not yet visually verified** — no full 7-panel atlas video exists locally
(only a 5s loop crop + thumbnails; real per-scene video is hosted remotely
and the app also expects a local API for job data), so the shadow
direction (`FEET_DIR` constant, currently `1.0`) is an educated guess, not
a confirmed one. Needs a live check against a real scene; flip `FEET_DIR`
to `-1.0` if the shadow lands above the head instead of at the feet.
`SHADOW_MAX_DIST` (reach) and the `0.45` opacity cap are also untuned.

This separate, unresolved `steps/shadow.ts` (depth-based halo, approach #6
above) is a different, still-parked idea — worth deciding whether it's
superseded by this WebGL approach or still wanted as a distinct look.

## Line in the sand

The above is good enough to stop here for now:
- The reorder fix (root cause) is real and shipped in
  `background-plate.ts`.
- Two residual-flicker mitigations — **zone-based crossfade** (#2, cleanest
  but bespoke) and **masked-stepped, synced** (#5, slightly more visible at
  the reveal moment but generalizes for free) — are both validated as
  genuinely clean via full-clip audit. Final pick between them (or keeping
  both as options) is still open, but not blocking further work.
- The shadow/halo idea (#6) is a separate, parked creative direction, not
  part of this flicker thread.

## Option 2: soften panel 3's overall style — done, adopted

Comparing against the legacy pipeline's background
(`/Volumes/HDD/lysterfield-lake-pipeline/video-final/output/main/output/resized-background/`)
showed the real difference isn't just "no tree" — the legacy background is
softer and more abstract *everywhere* (no crisp edges or discrete objects
anywhere in frame), which is what actually makes it forgiving of
frame-to-frame variation: there's nothing sharp enough to register as an
"identity change."

Tried two routes:
- **Free local post-process blur** on the existing sharp fill — softened
  edges but still reads as "a blurred photo of a tree," not a different
  style; the object's identity stays fully legible. Not pursued further.
- **Regenerated via flux-fill-pro** with a softer prompt (loose abstract
  watercolor wash, indistinct brushstrokes, muted palette) and `guidance`
  dropped from 100→35 (less strict prompt adherence, more creative/painterly
  freedom). This is genuinely different generated content, not a filter —
  and as a side effect it also solved the discrete-tree problem from
  approach #7 above, without needing a negative prompt (which flux-fill-pro
  doesn't support anyway).

**Adopted into real code** — `background-plate.ts`'s `FILL_PROMPT` and the
`guidance` value at the call site were updated (not just a scratch test).
Full 361-frame regenerate run via the real CLI into a new `background-soft`
frame dir (kept separate from `background-upscaled` so the existing
zone/stepped experiments' source data stays intact).

- **Preview**: `panel3-soft-full.mp4`
- **Full-clip audit**: no crisp discrete object anywhere across all 361
  frames; boardwalk reveal still reads as a smooth transition. Quantified
  via mean per-pixel frame-to-frame diff at 5 sample points: roughly
  30–55% lower than the sharp version everywhere *except* right at the
  reveal transition (~frame 200), where real content change dominates
  regardless of style, as expected.
- **Conclusion**: this is a real, independent win — reduces the underlying
  per-frame noise that the temporal-mitigation techniques (#2, #5) were
  built to hide, but doesn't replace the need to handle the actual
  content-reveal moment. The two are additive, not alternatives.

## Tasks

- [x] Root-cause and fix the severe flicker (DiffusionCLIP-on-generated-
      content) via the background-plate reorder
- [x] Full-clip audit methodology established (small-sample audits gave
      false confidence earlier in this investigation)
- [x] Try and reject whole-frame tmix smoothing
- [x] Try and validate zone-based motion-compensated crossfade
- [x] Try and reject/partially-validate masked tmix
- [x] Try and validate masked-stepped (fill only), find the mask-sync bug
- [x] Fix the mask-sync bug (masked-stepped v2)
- [x] Test prompt-only tree suppression — inconclusive, not pursued
- [x] Test a softened/more-abstract overall style for panel 3 (option 2) —
      adopted into `background-plate.ts`, full clip regenerated as
      `background-soft`
- [x] Re-run the chosen temporal-mitigation technique (#2 or #5) on top of
      `background-soft` instead of `background-upscaled`, and audit the
      combined result — masked-stepped-v2 combines cleanly, zone-based
      regresses (ghosting in the crossfade window)
- [x] Final decision: **masked-stepped with motion-compensated (mci) mask,
      on `background-soft`** — confirmed by the user after watching all
      three mask-cadence variants
- [x] Detect and repair person-leak failures in `background-soft` (8/361
      frames) — local skin-tone detector + nearest-neighbor patch, all
      downstream derived assets rebuilt and re-verified clean
- [x] Formalize the leak detector into a real pipeline module
      (`src/leak-detection.ts`) — found and fixed a real bug while porting
      from the scratch script: alpha frames (2160×2160) were never resized
      to match the fill (1024×1024), so every pixel lookup was misaligned
      and the first version of the real code detected nothing. Verified
      against the exact known-good/known-bad frames from the scratch
      version before trusting it again.
- [x] Formalize the chosen technique into a real pipeline step
      (`src/steps/background-stabilize.ts`, wired into `cli.ts` as
      `background-stabilize`, `compose` now defaults to its
      `background-stable` output). Improved on the scratch version during
      formalization: keyframe selection is now deterministic own-arithmetic
      instead of relying on ffmpeg's implicit `fps=` frame-selection
      (which is what caused the earlier off-by-one repair mistake) — this
      also fixed the 361→353 frame-count drift the scratch version had,
      and leak detection/repair now runs automatically as part of the step,
      scoped correctly to only the keyframes that actually surface in the
      output. Re-ran against the real job's data end to end: reproduced the
      same two repairs (different specific frame numbers, since this
      version's keyframe phase differs, but the same underlying windows),
      confirmed clean via full-clip audit, and confirmed exactly 361 frames
      out (no drift).
- [x] Decide the fate of the parked depth-based `steps/shadow.ts` halo —
      dropped, in favor of the WebGL contact shadow.
- [x] Commit the accumulated work — pipeline (reorder fix, size
      optimization, background-stabilize, leak-detection, mask.ts
      extraction) and the client shader change, one commit.
- [x] Live-verify the WebGL contact shadow against a real scene — done
      2026-09-24, once a full-atlas video fixture became available
      locally (10 published dreams' real video pulled from the drive,
      `public/dreams` symlinked so the dev server serves them). Traced
      live against a real scene (`20230811110431`, "Dirty Palette"):
      confirmed the shader fires and computes a real, non-trivial
      shadow alpha (~28% at the boundary, verified against the actual
      sampled matte pixel data), but for this style of shot the
      person-mask runs to the bottom edge of frame with no feet-to-
      ground transition to march toward — a bust/shoulders double-
      exposure, not a standing figure on visible ground — so what the
      shader computes lands against an already-dark, busy part of the
      watercolor and isn't perceptible. Decided with the user: drop it
      rather than tune it further, since the mismatch is conceptual
      (the effect assumes a shot type this pipeline doesn't produce),
      not a parameter to dial in. Removed from `video-material.tsx`;
      `steps/shadow.ts` (the separate, already-parked depth-based halo)
      is untouched.

## Open questions

- **Deferred, not blocking** — how should zone-based crossfade's per-clip
  hardcoded reference frames/zone boundaries generalize to scenes with
  zero, one, or multiple content-reveal moments? Moot for now: the
  adopted, formalized technique is masked-stepped (motion-compensated
  mask), not zone-based — zone-based remains on record as the cleanest
  *sharp-style* option (see "Line in the sand") if that's ever revisited,
  but nothing currently depends on generalizing it.
- **Resolved** — does a softened overall style reduce the need for a
  sophisticated temporal-mitigation technique at all, or are they
  additive? Additive, confirmed via full-clip audit: the softened style
  (option 2) measurably reduces per-frame noise everywhere except right
  at genuine content-reveal moments, but doesn't remove the need for the
  masked-stepped technique to handle those moments cleanly.

## Overview

Shipped 2026-09-18 (commit `3d79189`), with the contact shadow dropped on
2026-09-24. Panel 3's flicker on real footage came mostly from running the
DiffusionCLIP style over flux-fill-pro's generated fill, so the fill now
runs after the style. The residual flicker is handled by a softer,
watercolour-like fill prompt plus a new `background-stabilize` step that
holds the fill at 6fps and moves the mask with motion-compensated
interpolation. A free local skin-tone check catches fills that bring the
person back. The record above keeps every approach tried, including the
rejected ones. The song itself later took panel 3 from a different model
(see below).

## Architecture

- `apps/pipeline/src/steps/background-plate.ts`: erases and fills the
  person on panel 2's styled output, with the softer `FILL_PROMPT` and
  `guidance` 35.
- `apps/pipeline/src/steps/background-stabilize.ts`: the held fill and the
  motion-compensated mask, giving panel 3's final frames. Keyframes are
  picked by its own arithmetic rather than ffmpeg's `fps=` selection, which
  fixed the off-by-one repairs and the 361→353 frame drift.
- `apps/pipeline/src/leak-detection.ts`: the head-zone skin-tone check.
  `background-stabilize` runs it on just the keyframes that show and
  repairs a leaked one from its nearest clean neighbour.
- `apps/pipeline/src/mask.ts`: the mask reshaping shared by both steps.

Deviations from the record above:

- "Line in the sand" left the choice between zone-based (#2) and
  masked-stepped (#5) open. It was settled later in this plan: masked-stepped
  with a motion-compensated mask, on the soft fill. Zone-based was never
  made a real step.
- The WebGL contact shadow was built, then removed from
  `video-material.tsx` after a live check showed the shot type has no feet
  on visible ground to shadow. `steps/shadow.ts`, the depth-based halo,
  was dropped in the same commit as the shadow was added, so neither
  survives.

Superseded since:

- Commit `0e8e246` (2026-10-04) cut the cost further: `background-plate`
  fills only the `stepFps` keyframes, `background-stabilize` uses panel 2
  outside the mask, the plate mask covers each keyframe's whole hold
  window, and each fill is leak-checked as it lands and regenerated at most
  once with a bumped seed.
- For the full song, `full-video`'s panel 3 is Bria video erase in 5s
  crossfaded chunks, not this path (`done/phase-4e-full-video-source-prep.md`).
  `steps/background-video.ts` (2026-10-16) brought that into the pipeline,
  and polaroid jobs use it too. `background-plate` and
  `background-stabilize` remain in the CLI; `compose` reads whatever is in
  `3-background/frames`.

