---
title: Make and publish an eleventh dream
status: In Progress
created: 2026-10-21
updated: 2026-10-25
---

# Make and publish an eleventh dream

## Goal

Take one new dream from an approved set of samples all the way to the next
app (lysterfieldlake.com): a full-song take with no people in it,
composed, split, uploaded and in the chooser.

This is the "try the whole loop on one new take" task in
`in-progress/dreams.md`, which holds the tooling and the person check. This
plan is the run itself, plus the publishing steps that changed when the next
app got its own bucket and automatic deploys.

## Outcome so far (2026-10-25)

The whole loop ran once: `sharp-edges` (the take of that name) went from
samples to the next app, first in the chooser, on 2026-10-22, with 219
repair stretches along the way. Then it failed review: it shows a painted
face or figure in about half its frames, and `dream-check` passed every
one. Why, and what changes, is in `in-progress/dreams.md` ("The check
misses painted faces"). So the plan's goal, a take with no people in it,
isn't met yet. The redo waits for the new face check.

## Context

**Where it starts.** Five takes on `full-video` already have approved samples
(`7-dreams/<id>/take.json` status `samples-approved`, made from `/admin`):

| Take | Prompt | Preset | Style image |
| --- | --- | --- | --- |
| `lake-side-light-two` | a beautiful landscape, detailed, soft light | – | yes |
| `oil-painting` | a beautiful landscape, detailed, soft light | – | yes |
| `oil-painting-lake` | Abstract depth of field, playful shapes made of intersecting… | – | yes |
| `sharp-edges` | a beautiful landscape, detailed, soft light | lush-and-light | yes |
| `township` | a beautiful landscape, detailed, soft light | lush-and-light | yes |

Twelve more are rejected or never got past samples. Any of the five can go
straight to its 15-second clip.

**What it costs** (`COST` in `views/admin.tsx`, and `dreams.md`):

| Stage | Command (from `/admin`, or `bun run src/cli.ts … --job .jobs/full-video --take <id>` in `apps/pipeline`) | Cost | Time |
| --- | --- | --- | --- |
| Clip | `dream-clip`, then `take-status --status clip-approved` | ~$1.50 | ~26 min |
| Full song | `dream` (`/admin` adds `--skip-client true`) | ~$20 | ~6 h, 2,580 frames in restartable 48-frame chains |
| Check | `dream-check` | free | ~6 min |
| Repair | `dream-repair --frames … --action rerender\|hold --confirm true` | ~$0.008 a frame | minutes |
| Compose | `compose --take <id> --id <client-id>` | free | 25-38 min |
| Split | `compose-split --takes <client-id>` | free | minutes |

About $22 for a take that goes through, more if the clip shows it needs a
second try. Every paid stage needs the user's go-ahead (CLAUDE.md:
Replicate calls cost money). The Deforum path relies on the negative prompt
and the in-model reroll to keep people out; `NO_PEOPLE_SUFFIX` only applies
on the flux-kontext path. `dream-repair` is capped at `MAX_REPAIR_ROUNDS`
(10).

**What publishing writes** (since 2026-10-25):

- `compose` writes the 7-panel `7-dreams/<take>/final/video*` and the
  take's `video/panel.mov` in the job, and the chooser's
  `public/assets/<id>/{hero.jpg,loop.mov}` (committed) plus a
  `src/dreams.json` entry with title `TBA` and an empty prompt.
- `compose-split` writes the dream-only `7-dreams/<take>/split/dream{,-small}.{mp4,webm}`
  from `video/panel.mov`, and rewrites the shared `main/main*` in the job.
- The app plays only the split files, from the `lysterfield-lake-dreams`
  bucket at dreams.lysterfieldlake.com, in development too. Before
  they're uploaded, `/admin`'s "Watch the song in the player"
  (`?preview=<job>/<take>/song`) plays the take's split files from the job.
  The site deploys itself when `main` changes (`.github/workflows/deploy.yml`),
  building from the committed `dreams.json`.

**The shared main video stays as it is.** Panels 1-6 are the same for
every dream, so a new dream only adds its own `dream*` files.
`compose-split` skips `main/` while its outputs exist, and the main video
on the next bucket already has the depth fix (`done/depth-walk-away-gaps.md`).

## Approach

1. **Pick the take.** Watch the five sets of samples in `/admin` and choose
   one. Give it a client id (readable, like the others: `lake-light`), a
   title and a prompt line for the polaroid.
2. **Clip.** `dream-clip` (~$1.50). Watch it, run `dream-check --clip true`,
   and approve it or adjust and re-run.
3. **Full song.** `dream` (~$20). It can be stopped and restarted without
   paying twice.
4. **Check and repair.** `dream-check`, then go through the flagged stretches
   in `/admin#check-<take>`: re-render, hold or keep. Then one watch of the
   whole of panel 7.
5. **Compose.** `compose --take <take> --id <client-id>`, then
   `compose-split --takes <client-id>`. Fill in the `dreams.json` entry's
   title and prompt (the `link` is unused now: every dream links to the one
   YouTube video, `utils/youtube.ts`).
6. **Upload** the dream's split files to the bucket with
   `apps/client/scripts/upload-dreams.sh <id>` (from the job's `split/`): additive, skipping any
   already there at the same size. The player loads `dream{,-small}.mp4`
   (H.264 in every browser: `utils/dream-video.ts` says why). Check the URLs
   on dreams.lysterfieldlake.com before going on.
7. **Ship.** A PR with `public/assets/<id>/` and `src/dreams.json`. Merging
   deploys it. Then play it on lysterfieldlake.com, desktop and phone, including a
   swap into and out of it.

## Tasks

First run (`sharp-edges`):

- [x] Choose the take, its client id, title and prompt (user)
- [x] Clip, check, approve
- [x] Full song
- [x] Check, repair (219 stretches)
- [ ] One full watch: not done before publishing, and it would have caught
      the faces
- [x] `compose`, `compose-split`, fill in `dreams.json`
- [x] A small upload script for a dream's split files, so step 6 isn't
      typed by hand: `apps/client/scripts/upload-dreams.sh <id>`,
      skipping files already there at the same size
- [x] Upload, check the URLs, PR, merge
- [ ] Play it on lysterfieldlake.com (desktop and phone): not recorded

Redo:

- [ ] Pull `sharp-edges` from the chooser while it shows faces (user)
- [ ] The new face check (`in-progress/dreams.md`), then decide: repair
      `sharp-edges` or make a new take
- [ ] Check, repair, and one full watch of panel 7 before anything ships
- [ ] Compose, split, upload, PR (user merges), play it

## Open questions

- Which of the five? Or a new prompt or style image, starting from samples
  (~$0.50)?
- Where in the chooser should it sit? `dreams.json` order is the stack's
  order, and `generate` appends new folders in directory order.
