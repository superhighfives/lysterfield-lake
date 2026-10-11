---
title: Explore more temporally consistent dream methods against the Deforum baseline
status: Backlog
created: 2026-10-11
updated: 2026-10-11
---

# Explore more temporally consistent dream methods against the Deforum baseline

## Goal

Find a way to make dream (panel 7) takes that keeps what makes the legacy
dreams work (the subject's shape without the subject) but flickers less and
holds together over time better than Deforum's per-frame feedback loop.

## Context

The baseline is the legacy Deforum 0.7.1 setup, being rebuilt as our own
model in [`own-deforum-dream-model.md`](../ready/own-deforum-dream-model.md).
Every experiment here is judged side by side with it on the same stretch and
the same `job.json` sample frames.

What not to repeat (`.jobs/spikes/`, 2026-10-11): editing models
(flux-kontext) and low-strength img2img keep the person; depth/canny control
invents a new person in his pose; a hand-rolled SDXL feedback loop collapsed
into noise after one frame.

Deforum itself is no longer maintained (upstream notice); the baseline is
frozen in a Cog image so that doesn't matter for it, but it does mean no
newer models.

## Candidates (rough)

- **Wan VACE** (open weights): video-to-video with a mask and control video.
  The idea: mask = the matte, and ask it to fill the silhouette (or the whole
  frame) with landscape, so the shape survives but the person doesn't.
  Modern video models are built to keep the subject, so the risk is the same
  as flux-kontext's; the mask is what might make the difference.
- **Difforum** (ComfyUI): a Deforum-style feedback system on newer models
  (SDXL, Flux, SD3.5, Wan 2.2), with keyframe schedules and camera warp. The
  closest successor to the legacy look.
- **ComfyUI Feedback Sampler**: a lighter feedback-loop node with LAB colour
  coherence, anti-blur and noise injection.
- Hosted video-to-video (Runway Aleph, Luma Ray3 Modify, Kling O1) only if
  one turns out to support a "remove the subject, keep the shape" edit;
  their restyle modes keep the person.

## Tasks

- [ ] Pick a fixed 5s comparison stretch and the sample frames (reuse
      `full-video`'s `samples` and part of its `clip`)
- [ ] Try Wan VACE with the matte as a mask
- [ ] Try Difforum with the legacy prompt, negative prompt and colour reference
- [ ] Side-by-side clips against the Deforum baseline; record cost and time

## Open questions

- Where to run ComfyUI workflows: a ComfyUI runner on Replicate, our own
  Cog image, or a rented GPU?
- Does a method need the colour-reference trick, or can it take a palette
  another way?
