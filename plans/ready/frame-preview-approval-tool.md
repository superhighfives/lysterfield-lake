---
title: Cheap pre-production preview/approval loop for dream art direction
status: Ready
created: 2026-09-30
updated: 2026-10-10
---

# Cheap pre-production preview/approval loop for dream art direction

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
- **`dream-directions`**: one Claude API call (`@anthropic-ai/sdk`, model
  `claude-opus-5-5`, adaptive thinking, server-side refusal fallbacks
  `fallbacks: "default"`). Input: the user's brief, plus two or three sample
  source frames as base64 images (downscaled to 1024px). Output via
  structured outputs (`output_config.format` JSON schema): 3-5 directions,
  each `{ name, prompt, palette: [hex], rationale }`. The system prompt states
  the panel 7 rule (abstract shapes, light and colour, never a person) so the
  directions don't fight `NO_PEOPLE_SUFFIX`, which `dream.ts` still appends
  regardless. Writes `7-dreams/_directions/<timestamp>.json`. Picking one
  creates `7-dreams/<take>/take.json` with status `proposed`. Needs
  `ANTHROPIC_API_KEY` in `apps/pipeline/.env` (or an `ant auth login`
  profile).
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

- [ ] Pick `full-video`'s sample frames and clip range with the user; add
      `samples` and `clip` to its `job.json`
- [ ] `take.json` status, brief, direction, notes; gate `dream` on
      `clip-approved`
- [ ] `dream-directions` (Claude API, structured output)
- [ ] `dream-samples`
- [ ] Range support in `dream` and `compose`; `dream-clip`
- [ ] Vite dev plugin with the `/__admin` endpoints
- [ ] `/admin` view: directions, film strip, approvals
- [ ] `?preview=` mode in the player
- [ ] Try the whole loop on one new take for `full-video`

## Open questions

None blocking. To settle during the first task: the exact sample frames and
clip range for `full-video`.
