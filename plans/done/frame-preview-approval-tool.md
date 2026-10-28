---
title: Cheap pre-production preview/approval loop for dream art direction
status: Complete
created: 2026-09-30
updated: 2026-10-27
---

# Cheap pre-production preview/approval loop for dream art direction

## Overview

Shipped 2026-10-11: the staged loop (directions, samples, 15s clip, full
song) gated by `take.json` status, the dev-only `/__admin` API and `/admin`
page, and `?preview=` in the player. The page was redesigned as one flow for
Deforum takes; the directions and flux-kontext commands remain on the CLI.
The sections below are the record of how it was built.

Closed 2026-10-12 with one task moved to
[`dreams.md`](../in-progress/dreams.md): trying the whole loop on a new
take. The automatic person check proposed in Findings is specced there.

## Goal

Validate a dream (panel 7) art direction cheaply before paying for a full
take: brainstorm directions, judge them on a handful of fixed sample frames,
then on a 15-second clip in the real player, and only then run the full song.
All of it driven from a dev-only `/admin` page in `apps/client`.

## Context

Motivated by `real-15s-60fps`: two full dream takes were run to completion
(~$2.73) before anyone could see they showed a person (see
`plans/done/phase-5-end-to-end-parity-check.md` and `NO_PEOPLE_SUFFIX` in
`dream.ts`). A full-song take on `.jobs/full-video` is now ~1,290
`flux-kontext-dev` keyframe calls at 6fps, about $39, so a cheap gate before
that spend matters more than it did.

Panels 1-6 are shared by every take; this tool is only about panel 7. The ten
legacy Deforum dreams in `full-video/7-dreams/` predate it (no `take.json`)
and are unaffected.

Decisions (user, 2026-10-10):

- **UI:** a dev-only route in `apps/client`, not an Artifact or plain files.
- **Directions:** a pipeline command that calls the Claude API.
- **Sample frames:** a fixed, hand-picked set per job, stored in `job.json`.
- **v1 scope:** samples and the 15s test clip.

## Approach

### The loop, per take

| Stage | Command | Replicate calls | Cost |
| --- | --- | --- | --- |
| 1. Directions | `dream-directions --job J --brief "..."` | none (Claude API) | ~$0.05 |
| 2. Samples | `dream-samples --job J --take T` | 5 | ~$0.15 |
| 3. Test clip | `dream-clip --job J --take T` | ~90 (15s at 6fps) | ~$2.70 |
| 4. Full take | `dream --job J --take T` (existing) | ~1,290 minus the clip's | ~$36 |

Each stage needs the previous one approved. Approval lives in the take's
`take.json` (below), so the gate holds whether a stage is started from the
admin page or the CLI.

### Pipeline (`apps/pipeline`)

- **`job.json` gains `samples`**: the fixed frames every direction is judged
  on, e.g. for `full-video`:
  `[{ "frame": 4033, "label": "shouting close-up" }, { "frame": 2023, "label": "fast arms" }, { "frame": 2900, "label": "walk-away" }, { "frame": 4500, "label": "after the cut" }, { "frame": 300, "label": "wide intro" }]`
  (final list picked with the user).
- **`take.json` gains `status`, `brief`, `direction` and `notes`.** Status is
  one of `proposed` → `samples-approved` → `clip-approved` → `generated`, or
  `rejected`. The existing settings guard (`dream.ts` refuses frames made
  with different prompt/seed/stepFps) still applies.
- **`dream-directions`**: one Claude call **on Replicate**
  (`anthropic/claude-opus-4.7`, the most capable Opus Replicate hosts), so
  the pipeline needs no separate Anthropic key (user decision, 2026-10-10).
  Replicate's Claude takes one image and returns text, so the first three
  sample frames are stitched into one strip and the reply is asked for as
  JSON and validated with Zod: 3-5 directions, each
  `{ name, prompt, palette: [hex], rationale }`. One call, no retries. The system prompt states
  the panel 7 rule (abstract shapes, light and colour, never a person) so the
  directions don't fight `NO_PEOPLE_SUFFIX`, which `dream.ts` still appends
  regardless. Writes `7-dreams/_directions/<timestamp>.json`. Picking one
  creates `7-dreams/<take>/take.json` with status `proposed`.
- **`dream-samples`**: runs the existing dream keyframe call (same model,
  prompt + `NO_PEOPLE_SUFFIX`, the take's seed) on the job's `samples`
  frames only, writing `7-dreams/<take>/samples/NNNN.jpg`. Skip-if-exists,
  no retries (CLAUDE.md).
- **`dream-clip`**: runs `dream` on a frame range only (default the 15s
  around the job's most demanding stretch, configurable as
  `job.json.clip: { start, frames }`), writing into the take's real
  `frames/` folder, so the full run later skips those keyframes instead of
  paying twice. Then a range-aware compose writes a short composite with the
  matching slice of audio to `7-dreams/<take>/preview/video.mp4`. That needs
  `compose` to accept a frame range (today it always composes the whole
  song).
- **`dream` (full take)** refuses to start unless the take is
  `clip-approved`, unless `--force true` is passed.

### Admin page (`apps/client`)

- **Dev only, by construction.** A Vite plugin with `apply: 'serve'` adds
  `/__admin/*` endpoints to the dev server, so they never exist in a build.
  `main.tsx` lazily imports the admin view only when `import.meta.env.DEV` and
  the path is `/admin`, so production bundles drop it.
- **Endpoints:** list jobs; read a job's `job.json`, takes and
  `_directions`; serve job files (sample frames, preview clips) read-only
  from `apps/pipeline/.jobs`; and actions: run directions, create a take from
  a direction, run samples, run the clip, set status and notes. Actions spawn
  the pipeline CLI (`bun run --cwd apps/pipeline src/cli.ts ...`) and stream
  its log back.
- **Spend guard:** any action that calls Replicate or Claude shows its
  estimated cost and needs an explicit confirm; the server checks the take's
  status before spawning anything (the pipeline checks again).
- **UI:**
  - a brief box and the returned directions, each with prompt, palette
    swatches and rationale, and "make a take";
  - per take, a film strip of the sample frames next to the matching source
    frames, with approve, reject and notes;
  - the clip opened in the real player view via `?preview=<job>/<take>`,
    which loads the preview video from the dev endpoints instead of
    `dreams.json`, then approve or reject.

### Not in v1

Running the full take from the page (stays a deliberate CLI command), auth,
hosting it anywhere but local dev, and reviewing panels 1-6.

## Tasks

- [x] `full-video`'s sample frames (1, 2025, 2901, 4033, 4501, all on 6fps
      keyframes) and clip range (3701-4060) in its `job.json`
- [x] `take.json` status, brief, direction, notes; gate `dream` on
      `clip-approved`
- [x] `dream-directions` (Claude on Replicate, JSON validated with Zod)
- [x] `dream-samples` (tested on `test-hazy-summer`; see Findings)
- [x] Range support in `dream` and `compose`; `dream-clip` (not yet run for real)
- [x] Vite dev plugin with the `/__admin` endpoints
- [x] `/admin` view. Redesigned 2026-10-11 as one flow for Deforum takes (describe a look, samples, clip, full song); the directions and flux-kontext forms were dropped from the page, their commands remain
- [x] `?preview=` mode in the player
- [ ] Try the whole loop on one new take for `full-video`

## Findings (2026-10-10)

- **A photographic prompt lets the person straight through.** The test take
  `test-hazy-summer` ("1970s film photograph", hand-written) came back with
  the subject fully recognisable in all four samples that contain him,
  despite `NO_PEOPLE_SUFFIX`: flux-kontext treated it as a colour grade.
  Rejected. The directions prompt now requires a medium that rebuilds the
  frame (impasto, woodcut, mosaic...) and forbids photo, film or grade
  looks. An automatic person check on samples would catch this before
  review (proposed, not built).

## Open questions

None blocking. To settle during the first task: the exact sample frames and
clip range for `full-video`.

## Architecture

- **Gate.** `take.json`'s `status` (`proposed` → `samples-approved` →
  `clip-approved` → `generated`, or `rejected`) is checked in the pipeline
  CLI (`apps/pipeline/src/cli.ts`): `dream-samples` needs `proposed`,
  `dream-clip` needs `samples-approved`, and the full `dream` run needs
  `clip-approved` unless `--force true`. Takes from before the loop have no
  status and aren't gated. The admin server checks again before spawning.
- **Pipeline steps.** `steps/dream-directions.ts` (Claude on Replicate, one
  stitched image, Zod-validated JSON), `dream-samples` and `dream-clip`
  (`cli.ts`), and `composePreview` in `compose.ts`. The sample frames and
  clip range live in the job's `job.json` (`samples`, `clip`).
- **Admin.** `apps/client/vite-plugin-admin.ts` is a Vite plugin with
  `apply: 'serve'` that adds the `/__admin` endpoints and spawns the CLI.
  `src/main.tsx` lazily imports `views/admin.tsx` behind
  `import.meta.env.DEV`, so neither reaches a build.

Deviations:

- **Deforum, not flux-kontext.** The redesign of 2026-10-11 (commit
  `686aa6b`, alongside `own-deforum-dream-model.md`) made the page one flow
  for Deforum takes. The directions and flux-kontext forms left the page;
  their commands remain on the CLI.
- **A Deforum clip is its own chain.** Each Deforum frame depends on the
  ones before it, so a clip from the middle of the song isn't what the full
  run makes there. Its frames go in `7-dreams/<take>/preview/dream/frames`,
  apart from the full song's, and the full run pays for them again. The
  plan's "the full run skips the clip's keyframes" holds only for
  flux-kontext takes.
- **The page grew past v1.** Later work added the person check and review
  of flagged frames, repairs, a task queue, retry and stop
  (`git log -- apps/client/vite-plugin-admin.ts`, from 2026-10-12). Those
  are recorded in `in-progress/dreams.md`, not here.

Superseded since:

- **Previews play split.** The 7-panel video was dropped on 2026-10-25
  (PR #62). A test clip is no longer a short 7-panel composite with audio:
  `composePreview` makes a dream video of the clip, padded to the song's
  length by holding its first and last frames, and the player plays it
  against the shared main video from where the clip starts
  (`?preview=<job>/<take>&t=`). `clip-preview` remakes one from the clip's
  frames without rendering anything.
- **No local dreams folder.** `apps/client/dreams/` is gone; dev plays the
  published dreams from the bucket (PR #60). Previews still come from the
  job through the dev endpoints.
