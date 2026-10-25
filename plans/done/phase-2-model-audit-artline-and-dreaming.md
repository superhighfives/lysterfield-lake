---
title: "Phase 2: model audit — outline (ArtLine) hosting and dreaming-model prototype"
status: Complete
created: 2026-08-17
updated: 2026-08-18
---

# Phase 2: model audit — outline (ArtLine) hosting and dreaming-model prototype

## Goal

Resolve the two model decisions the rest of the pipeline rebuild depends on:
where the outline/sketch step runs (ArtLine has no known public Replicate
port), and what replaces the old Deforum + manual-curation + RIFE/Enhancr
dreaming lane. Per the parent plan, this is "the highest-leverage decision in
the whole plan" — if a modern video model holds up visually, it collapses a
whole messy manual lane into one Replicate call per scene.

This is phase 2 of
[`rebuild-pipeline-as-replicate-cli.md`](rebuild-pipeline-as-replicate-cli.md)
(currently in-progress) — see that document for full project context,
architecture, and the model inventory table. Don't duplicate that context
here; this spec only covers phase 2's own scope and execution detail.

## Context

- **Outline model**: no public Replicate deployment of
  [ArtLine](https://github.com/vijishmadhavan/ArtLine) turned up in the
  parent plan's search. The original pipeline loaded a local fastai
  checkpoint (`video-artline/torch_650.pkl`, one of four checkpoints on the
  external drive — `torch_650.pkl`, `torch_920.pkl`, `ArtLine_650.pkl`,
  `ArtLine_920.pkl`) inside `other.py`. `cog` is already installed locally
  (confirmed via `which cog`), so packaging one of these as a private Cog
  model is straightforward if no community port is good enough.
- **Dreaming model**: the real per-scene prompts and settings (not
  `dreams.json`'s display-caption `prompt` field) live on the external drive
  at `/Volumes/HDD/lysterfield-lake-pipeline/video-final/dreaming/<id>/
  {prompt.txt,<id>_settings.txt}` — confirmed present for all ten scene IDs
  (e.g. `20230808103741`). `<id>_settings.txt` also has a `colormatch_image`
  field, Deforum's own colour-coherence reference, which doubles as the
  style-reference candidate. Candidates to prototype: **Kling 3.0 Omni** and
  **Grok Imagine**, both on Replicate today, both supporting an
  image + prompt + style-reference input shape.
- **No `REPLICATE_API_TOKEN` configured yet** — `apps/pipeline` doesn't
  exist (that's phase 3), so there's nowhere for a `.env` to live yet. This
  phase needs a token to run any live prototype calls; get one before
  starting the dreaming-model comparison.
- **Real Replicate spend**: prototyping is a small, bounded number of calls
  (a handful of scenes × two candidate models), unlike the per-frame steps
  later phases will run at scale — but it's still real money against a live
  API. Confirm with the user before firing the first paid call, not after.

## Approach

### Outline model

1. Search Replicate (replicate.com search + a general web search) for an
   existing ArtLine port or a close equivalent line-art/sketch model.
   Evaluate any candidate against `video-artline/res.jpg`/`test.jpg` (sample
   outputs already on the external drive) for a rough visual gut-check.
2. If nothing public is good enough: package `video-artline/torch_650.pkl`
   (the checkpoint `other.py` actually loads today) as a private Cog model,
   using `video-artline/torch_test.py` and `covert2torch.py` as the existing
   inference reference. Push to Replicate under the user's account. This
   needs a GPU-capable `cog predict` test pass before pushing — flag if
   local hardware can't run it and a Replicate-hosted build/test is needed
   instead.
3. Record the decision (which model, why, any visual trade-off vs. the
   original ArtLine output) back in the parent plan's open questions.

### Dreaming model

1. Pick one already-published scene as ground truth for comparison — reuse
   whichever scene has the clearest before/after material (`video-final/
   output/<id>/` for the original composited result, `video-final/dreaming/
   <id>/` for the real prompt/settings/colormatch reference, `main.mov` for
   a source frame to feed the new models).
2. Extract one representative frame from that scene's `main.mov` as the
   image input.
3. Confirm `REPLICATE_API_TOKEN` is available (ask the user for one if not),
   then confirm before spending against it.
4. Call Kling 3.0 Omni and Grok Imagine on Replicate with
   {frame, real prompt from `prompt.txt`, style/colormatch reference image}
   for the chosen scene. Capture cost and generation time for each.
5. Compare both outputs side by side against the scene's original Deforum
   output (`video-final/dreaming/<id>/` or the compiled scene video) for
   visual quality and prompt/style fidelity.
6. Decide: does either replace Deforum + manual frame curation + RIFE/
   Enhancr outright? If neither holds up, the fallback (per the parent
   plan) is porting the original Deforum + curation + interpolation lane
   as-is — note that as a real possible outcome, not just a formality.
7. Record the decision, sample outputs, and the cost/time-per-scene figures
   back in the parent plan (open questions + the "Cost/concurrency budget"
   question, at least for this one step).

### Out of scope for this phase

No `apps/pipeline` code yet (phase 3). This phase produces decisions and
recorded evidence (sample outputs, cost figures), not shipped step modules —
`outline.ts` and `dream.ts` get written in phase 3 once these are resolved.

## Tasks

- [x] Search for an existing ArtLine Replicate port; evaluate against sample
      outputs on the external drive
- [x] If none is good enough, package `video-artline/torch_650.pkl` as a
      private Cog model — validated locally via `cog predict`; pushing to
      Replicate itself deferred to phase 3 (see Architecture)
- [x] Record the outline-model decision in the parent plan
- [x] Get a `REPLICATE_API_TOKEN` in place for prototyping
- [x] Pick a ground-truth scene; extract a source frame; gather its real
      prompt + colormatch reference from the external drive
- [x] Confirm with the user before spending against the Replicate API
- [x] Run the Kling 3.0 Omni and Grok Imagine prototypes for that scene
- [x] Compare outputs against the original Deforum result; note cost/time
      per scene for each candidate
- [x] Record the dreaming-model decision (or the Deforum-fallback decision)
      in the parent plan

## Open questions

None outstanding for the phase itself — the ArtLine hosting decision and the
dreaming model choice are exactly what this phase exists to resolve, not
prerequisites for starting it.

## Overview

Both model decisions are resolved. The outline step will run on a private
Cog model wrapping the project's own already-converted ArtLine checkpoint —
no public port exists anywhere, confirmed by direct search. The dreaming
step will run on Kling 3.0 Omni, prototyped side by side against Grok
Imagine using a real scene's actual generation prompt (not `dreams.json`'s
display caption) and colour reference pulled from the external drive; both
candidates produced results good enough to retire the whole Deforum +
manual-curation + RIFE/Enhancr lane, so the plan's Deforum-fallback branch
is now moot. Full detail (sample outputs, cost/time figures, the reasoning
behind picking Kling over Grok) lives in the parent plan's Open Questions
section rather than duplicated here.

## Architecture

`models/outline/` in the `lysterfield` repo holds the packaged outline
model: `cog.yaml` (CPU-only for local validation; needs `gpu: true` before
any real push), `predict.py` (ports `torch_test.py`'s inference almost
verbatim), and a `README.md` documenting where to get the gitignored
`.pkl` weights. `fastai` is a build dependency purely so `torch.load` can
resolve the checkpoint's pickled `DynamicUnet` classes — nothing calls
fastai's API.

**Deviation from the spec**: the spec's outline-model task said "package ...
and push to Replicate." Actual scope narrowed to packaging + local
validation only — pushing a GPU-enabled model to Replicate is real
infrastructure work (image build, hosting, a model slug/naming decision)
that's more naturally phase 3's job, when `outline.ts` exists and actually
needs a live endpoint to call. Local `cog predict` (CPU) already proves the
checkpoint loads and produces correct output, which is all this phase
needed to commit to the "package it ourselves" decision with confidence.

No repo changes for the dreaming-model side — that decision lives entirely
in the parent plan's Open Questions, backed by two Replicate predictions
(`replicate.com/p/ack0g1v2pxrmr0d02c9sqjvx7w` for Kling,
`replicate.com/p/c7n6qeez59rmt0d02ca9hf7np0` for Grok — both against scene
`20230808103741`). Sample stills were inspected directly during the session
and not saved to the repo, per the "don't commit generated frames/videos"
rule in `CLAUDE.md`.
