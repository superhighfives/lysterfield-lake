---
title: "Dreams: make, check, repair and publish panel 7 takes"
status: In Progress
created: 2026-10-12
updated: 2026-10-12
---

# Dreams: make, check, repair and publish panel 7 takes

## Goal

One plan for everything about dream (panel 7) takes: making a new one from
`/admin`, getting people out of it without reviewing every frame by hand,
publishing it, and later trying methods that hold together better than
Deforum.

It replaces four plans:

- `frame-preview-approval-tool.md` and `own-deforum-dream-model.md` (both
  built; now in `done/`, with their open tasks moved here)
- `phase-4f-regenerate-and-publish-dreams.md` (now the Publish stage)
- `temporally-consistent-dreams.md` (now the Other methods track)

## Context

**What exists.** `superhighfives/lysterfield-deforum` on Replicate is the
legacy Deforum 0.7.1 setup (`models/deforum/`). `/admin` runs a take through
describe a look → 5 samples → 15s clip → full song, each stage gated on the
one before in `take.json`. Clips and full songs are chains of 48-frame runs
that pick up where they stopped. A full song is ~2,580 dream frames, ~6h of
GPU, roughly $20. Details: `done/own-deforum-dream-model.md`,
`done/frame-preview-approval-tool.md`.

**The problem.** Takes keep showing a person: `neon-dream`'s "after the cut"
sample is a red-haired figure from behind in a sweater, and the chain test
drew a walker from its third frame. The negative prompt (which already lists
person, waifu, hair, back of head, sweater...) reduces this but does not stop
it.

**The legacy dreams leaked just as much** (checked 2026-10-12 on the HDD,
`video-final/dreaming/<datestamp>/`). The published dreams were clean
because bad frames were deleted by hand and the gaps filled by
`interpolator.py`: RIFE (`rife-ncnn-vulkan`, `rife-v4.6`) between the good
frames on either side. Frames replaced that way have later file dates, which
gives a count per dream:

| Dream (datestamp) | Prompt style | Frames replaced | Stretches | Longest |
| --- | --- | --- | --- | --- |
| 20230808103741 | watercolour | 103 (4.8%) | 52 | 7 |
| 20230809134901 | pencil illustration | 277 (12.9%) | 108 | 28 |
| 20230810222655 | Ghibli landscape | 8 (0.4%) | 6 | 3 |
| 20230811110431 | watercolour on white paper | 68 (3.2%) | 32 | 5 |
| 20230812000902 | watercolour, paint dripping | 245 (11.4%) | 100 | 17 |
| 20230812145711 | Ghibli landscape with lake (lush-and-light) | 361 (16.8%) | 131 | 22 |
| 20230816110119 | velvet poster | 21 (1.0%) | 16 | 3 |
| 20230817131418 | velvet poster | 239 (11.1%) | 104 | 14 |
| 20230818151910 | ink / Japanese painting | 0 | 0 | 0 |
| 20230819073500 | gouache | 0 | 0 | 0 |

What this says:

- So the open question in the Deforum plan ("why do back views come through
  when the legacy run's didn't") is answered: the legacy run's did too. The
  rebuild is faithful; the missing piece is the repair step.
- Leaks are short. About half are one frame, almost all are five or fewer
  (half a second), and the run recovers by itself afterwards. A leaked frame
  does not poison the frames after it, so repair can be local.
- The rate swings from 0% to 17% between takes with the same settings and
  negative prompt, so prompt, seed and colour reference all matter. The two
  clean dreams are the two least photographic or anime-like styles.
- Each dream folder also has Deforum's own `<datestamp>.mp4` (1024px, 2,148
  frames), written before the repair. For lush-and-light its frames 99-103
  and 105 show the person, exactly the frames that were replaced. That makes
  ~1,300 known-bad frames across eight dreams to tune a detector on.
  Confirmed: frame n of the mp4 is PNG n for frames that were kept.

**Other methods tried** (`.jobs/spikes/`, 2026-10-11): flux-kontext and
low-strength img2img keep the person; depth/canny control invents a new
person in the pose; a hand-rolled SDXL feedback loop collapses into noise
after one frame.

## Approach

### The loop

| Stage | What runs | Cost | Gate |
| --- | --- | --- | --- |
| 1. Look | New dream form in `/admin` | free | landscape-only prompt check |
| 2. Samples | 5 warm-up runs | ~$0.50 | user approves |
| 3. Clip | 15s chain + composite | ~$1.50 | **person check**, then user approves |
| 4. Full song | ~54 chained runs | ~$20 | confirm dialog |
| 5. Check | Score every dream frame for a person | free | none |
| 6. Repair | Re-render flagged stretches with Deforum | ~$0.008 a frame | user approves flagged stretches and the cost |
| 7. Publish | `compose`, `deploy-dreams`, client deploy | free | user's go-ahead for R2 |

Stages 1-4 exist. Stages 5 and 6 are new and are what makes this
manageable: most leaks are rerolled away as the frame is made, and the
review becomes "confirm the stretches the detector still flags" instead of
"look at 2,580 frames".

### 5. Check: a person score for every dream frame

- **`dream-check --job J --take T`** writes `7-dreams/<take>/check.json`:
  a score per dream frame and the flagged stretches (first frame, last
  frame, peak score). Local, no Replicate calls, safe to rerun.
- **What counts as a bad frame** (user, 2026-10-12): a literal person,
  hands, or a paper cut-out of the subject with a picture in it. Looking
  *like* a person is fine: ink-flight's and charcoal's ink-wash bust and
  lush-and-light's rock where the head was are the intended look, because
  they can't be confused with the portrait overlaid on them.
- **Detector:** a small linear classifier over CLIP ViT-L/14 embeddings
  (the whole frame and its central half), run locally with `uv`
  (`models/person-check/`). It is trained on the 2023 decisions: every frame
  of the ten pre-repair mp4s (21,480), with the 1,322 replaced frames as
  bad and everything kept as good, ink-flight and charcoal included.
  Zero-shot CLIP was tried first and can't draw the line above: it flagged
  half of ink-flight.
- **Cross-validated at the chosen threshold, 0.35:** 1,278 of the 1,322
  replaced frames are flagged (97%), and 203 of the 20,158 kept frames
  (1%). 140 of those are in paper-planes, where people from behind were
  missed in 2023 and are in the published video. Ink-flight and charcoal:
  5 frames between them.
- **On unseen styles:** `neon-dream`'s back-view person scores 1.00 and its
  four clean samples 0.04 or less; the rejected `test-hazy-summer` samples
  that show the person score 0.89 to 0.98. Two takes is thin evidence. A new
  look is a new style, so a reviewed take's keep/replace decisions should be
  fed back as training data (`train.py`).
- **On a published dream:** `lush-and-light`'s final frames get 5 flags in
  2,147: a clear person from behind (job frame 1735, score 1.00), two frames
  at 934, and two bust-shaped rocks that are false alarms.
- A full song takes about 6 minutes to check on the Mac. Sample sheets from
  the tuning: `.jobs/spikes/person-check/`.
- The check also runs on the 15s clip and on each sample's warm-up run, so a
  take that leaks heavily is seen before the full song is paid for. The
  clip's leak rate is shown on the take card next to the cost of the song.

### 6. Repair: re-render, never interpolate

No RIFE (user, 2026-10-12): the interpolated morph loses the stop-motion
look, where every dream frame is its own picture. A replaced frame is always
a real Deforum frame.

- **At the source: reroll in the model.** `predict.py` scores each frame as
  it is made, with the CLIP model it already has loaded. A frame over the
  threshold is rendered again with another seed before it is saved or fed
  forward, at most twice; if it still fails, the lowest-scoring attempt is
  kept and flagged. The run's zip gains `scores.json` (score, attempts and
  flag per frame). This is the 2023 "delete and rebuild", done at the moment
  the frame is made. It is bounded GPU time inside one run, not a new
  Replicate call: ~10s a reroll, so a 10% leak rate adds ~10% to a take.
- **Afterwards: `dream-repair --job J --take T`** re-renders each approved
  stretch as a short Deforum run that continues from the last good frame
  before it (`previous_frame`, as a chain does), with the take's own
  settings and the reroll on. It ends on a cut to the next good frame, the
  same kind of step as between any two dream frames. Originals move to
  `7-dreams/<take>/replaced/`, never deleted. Paid, so it shows its frame
  count and cost first, and each stretch is skipped once done.
- **Free option for one-frame leaks:** hold the frame before it. A held
  frame is true to stop motion, and about half of all leaks are one frame.
- **In `/admin`:** a review strip per flagged stretch (the frames, one good
  frame either side, and the matching panel 2 frames), with "re-render",
  "hold" and "keep". Plus a scrubber over the whole take, so a missed frame
  can be flagged by hand. A take can't be published with unreviewed flags.

### Results (2026-10-12)

- **Repair.** `dream-repair --frames 1735` on the published
  `lush-and-light` replaced its one clear person frame with a lake and a
  tree in the dream's own palette, clean on the first attempt (score 0.005).
  It sits between its neighbours like any other step; the cut back to the
  next good frame doesn't show. 2m47s including the cold start. Strip:
  `.jobs/spikes/person-check/repair-1735.jpg`.
- **Reroll.** The walk-away stretch (12 dream frames cold from job frame
  2901, lush-and-light's settings), which drew a walker from its third frame
  on 2026-10-11, now comes out with no person in any kept frame: a boat at
  the end of a jetty stands where he was.
  - First version: every frame from the fifth on failed its first attempt
    (0.97-0.99) and needed one or two retries, 21 renders for 11 frames, and
    the second retry (repainting more) made the sky jump.
  - So a seed that gets a frame through is now kept for the frames after
    it. Same stretch: 13 renders for 11 frames, two retries in all, both
    seed-only. There is still a small shift in the sky where the seed
    changes.
  - Strips: `.jobs/spikes/reroll-test/`.
- Model version `a3f807d0…` is pinned in `models.ts`.

### The ten existing dreams

They get the same treatment, so no published dream keeps a RIFE morph:

- The frames to replace are known exactly: the 1,322 with later file dates
  (the table above), in ~550 stretches. Add anything `dream-check` flags
  that was missed in 2023.
- Each dream re-renders with its own preset, prompt, seed and colour
  reference (`7-dreams/<id>/original/deforum-settings.txt`).
- Timing: the legacy dreams are 10 frames per second of song from the 60fps
  init, not this job's 12 from 24fps. The repair has to feed the init and
  mask at the legacy timing (the HDD's `inputframes/`, or panel 2 through
  the legacy frame map) so replaced frames sit where the old ones did.
- Cost: ~1,900 frame renders (each stretch plus its lead-in), ~11h of GPU,
  roughly $55 for all ten before rerolls. One dream first (the Ghibli
  landscape: 8 frames, about $0.50) to judge the joins before the rest.

### Fewer leaks to begin with (experiments)

Each is judged on one fixed leak-prone stretch (the walk-away, from job
frame 2901) by the detector's leak rate, so results are comparable and
cheap:

1. **Reroll in the model** (specced under Repair): measure how often two
   rerolls are enough.
2. **Take the person's texture out of the init.** The init video is panel 2,
   so hair and sweater are right there to be kept. Try blurring or
   flat-filling panel 2 inside the matte so only the silhouette steers.
3. **Style guidance in the form.** The legacy table says style matters as
   much as anything. Show each preset's legacy leak rate next to it, and
   warn on anime-leaning words.
4. **Push CLIP guidance away from people.** The legacy `conditioning.py`
   takes weighted CLIP prompts; try a negative-weight "person" target.

### 7. Publish

From phase 4f, for a new take and for the ten legacy dreams alike:

1. `bun run src/cli.ts compose --job .jobs/full-video --take <id>` (local,
   ~25 minutes a dream). Publishes videos to `apps/client/dreams/<id>/` and
   stills to `apps/client/public/assets/<id>/`.
2. Review: panel 7 against the old video at exact frame numbers, and one
   full watch for stray frames in matte, depth or outline.
3. `bun run --cwd apps/client deploy-dreams` (an `rclone sync` to the
   `lysterfield-lake-dreams` R2 bucket; uploads the readable-id folders and
   deletes the datestamp ones). **Needs the user's go-ahead.**
4. Deploy the client.

The ten legacy dreams still need this: R2 holds them under datestamp ids,
and `lush-and-light`'s one composite predates the stray-frame fixes.

### Our own GPU (2026-10-14)

Deforum can run on the RTX 4090 PC (`superuniverse`, Windows 11) instead of
Replicate: free per frame, no cold starts, and at least as fast as the A100
for this model. One GPU, so one run at a time.

- **On the PC:** WSL2 (Ubuntu 24.04) with Docker and NVIDIA's container
  toolkit, running the same image Replicate runs
  (`r8.im/superhighfives/lysterfield-deforum`), which serves Cog's HTTP API
  on port 5000. WSL's mirrored networking puts that port on the PC's
  Tailscale address; a Windows firewall rule allows it from Tailscale
  addresses (100.64.0.0/10) only. A startup task keeps WSL and the container
  running after a reboot. SSH (Windows OpenSSH, key auth) is how it is
  managed.
- **On the Mac:** `DEFORUM_URL` in `apps/pipeline/.env` (never in the code,
  per CLAUDE.md) sends Deforum runs there (`gpu-server.ts`); unset, they go
  to Replicate as before, and `--on replicate` sends one command there
  anyway. Runs from one process take turns, and one that finds the GPU busy
  waits for it.
- **One build for both** (`models/deforum/cog.yaml`): the Deforum image
  now includes xformers, with PyTorch 1.13.1 to match it. Without xformers a
  1024x1024 frame with CLIP guidance needs more than the 4090's 24 GB,
  spills into system memory, and one frame took over 12 minutes; with it,
  about 7 GB. It made the A100 faster too: on Replicate the same six frames
  rendered in 58 seconds, about 10 seconds a render against 22 before
  (2026-10-15), so a Replicate frame costs less than half what it did. The
  frames look the same. On the PC it is built with `cog build -t
  lysterfield-deforum:gpu-pc`, or pulled from Replicate.
- **L40S over A100 (2026-10-16):** the same six frames on an L40S rendered
  in 48 seconds against the A100's 58, at $0.000975 a second against
  $0.0014: about $0.008 a frame against $0.014, and a quicker boot. Frames
  look the same. The model's hardware is set to L40S in its settings on
  Replicate.
- **Weights** are downloaded once into `/opt/deforum-weights` on the PC and
  mounted into the container (the model's own downloader left them
  truncated there), so a new container doesn't fetch them again.
- **Measured (2026-10-15):** six dream frames of the walk-away stretch
  (seven renders, one retry) in 75 seconds, upload and download included:
  about 10 seconds a render, the same as the A100 with xformers (~21
  without), with no cold start and no charge. The frames match Replicate's
  for the same stretch, and the same frame needed a retry on both.
- **Open:** WSL doesn't yet start at boot (the startup task needs
  registering from the PC's desktop with a password); the Mac reaches the
  PC through Tailscale's relay rather than directly, which slows uploads; a
  run lost to a dropped connection starts over; `/admin` doesn't choose per
  task, and repairs take turns on the one GPU.

### Style reference (IP-Adapter, 2026-10-16)

The colour reference only matches each frame's palette. A style reference
carries over an image's look and imagery too: IP-Adapter's SD 1.5 weights,
ported onto Deforum 0.7.1's ldm UNet (`models/deforum/ip_adapter.py`). Its
image tokens are added beside the prompt in all 16 cross-attention layers,
mapped in diffusers' order and checked by shape. Without a style image the
model renders exactly as before.

Tested on the 4090 with the walk-away frames and a timber-pagoda reference:
at strength 0.6 the reference's world (timber roofs, autumn trees, its sky)
grows out of the footage and the lake and the subject's shape still lead;
at 1.0 the reference takes over. No person at either strength. The form has
a Style picker (the same image library as Colours) with a strength slider,
default 0.6.

**Look only (2026-10-16).** Fed to all 16 layers, the reference's content
came through too: both test dreams (0.6 and 1.5) turned the footage into its
timber towers. Fed only to the up blocks (layers 6-14), as style-transfer
work suggests, the landscape stayed and took on the reference's palette and
painterly look, with almost no buildings (`.jobs/spikes/style-grid/`). That
is now the default ("its look", strength 1.0); "its look and content" (all
layers, 0.6) stays as an option.

### Other methods (later)

Deforum is the baseline. A candidate replaces it only if it keeps "the
subject's shape without the subject", flickers less, and scores a lower leak
rate on the same stretch. Candidates: Wan VACE with the matte as a mask;
Difforum (Deforum-style feedback on newer models, ComfyUI); ComfyUI Feedback
Sampler; hosted video-to-video only if one can remove the subject and keep
the shape.

## Tasks

Check and repair:

- [x] Confirm the legacy `<datestamp>.mp4` files are the pre-repair runs
      (frame n of the mp4 is PNG n; replaced frames differ)
- [x] `dream-check` (`models/person-check/`, `dream-check.ts`), trained
      and cross-validated on the 2023 keep/replace decisions
- [ ] Feed a reviewed take's decisions back into `train.py`
- [x] Reroll in the model, with `scores.json` (`predict.py`: up to two
      retries, a new seed and then repainting more)
- [x] Measure the reroll on the walk-away stretch (see Results)
- [x] `dream-repair`: re-render a stretch from the last good frame, or hold
      it; originals kept in `replaced/`. Works on legacy dreams too: it
      reads the dream frames and their source frames off the frames folder
- [x] `/admin`: a People check section listing every dream with a full
      song (published ones included): run the check, review each flagged
      stretch (re-render, hold, or keep), go through every frame by hand.
      The clip's check shows on its take card. `/admin#check-<take>` opens a
      take's review directly
- [x] `/admin` task queue (`apps/client/admin-queue.ts`): every pipeline
      command the page starts is a task in `.jobs/_queue/`, run as its own
      detached process. Up to three Replicate runs and one person check at a
      time, one task per dream; a Tasks panel shows what is running, waiting
      and finished, with logs and stop. Local on purpose: the pipeline works
      on frames on this machine, so a hosted queue (Cloudflare Queues) could
      only hand the work back to a consumer running here
- [ ] Refuse to publish a take with unreviewed flags
- [ ] Run the check automatically when a clip or song finishes, and on sample runs

Existing dreams:

- [x] Legacy-timing init and mask for a repair run (a run now takes an
      explicit list of source frames)
- [x] First repair: `lush-and-light` frame 1735 (see Results)
- [ ] Repair the Ghibli landscape dream's 8 frames
- [x] Tell people and 2023 morphs apart (`scripts/legacy-morphs.ts` writes
      each published dream's `morphs.json`: legacy frames filled in after the
      run, found by file date and mapped to job frames as the import did, and
      checked against the pixels). /admin counts them separately and has a
      button to re-render a dream's morphs
- [ ] Repair the other nine, with the user's go-ahead on cost

Fewer leaks:

- [ ] Silhouette-only init (experiment 2)
- [ ] Legacy leak rates and style warnings in the new-dream form

Make and publish:

- [ ] Try the whole loop on one new take for `full-video` (a real clip, a
      real full song, check, repair)
- [x] Compose all ten legacy dreams (re-compose `lush-and-light`): done
      2026-10-16, 24 to 38 minutes each, about 5½ hours in all, one at a
      time. Videos in `apps/client/dreams/<id>/` (gitignored, for R2);
      stills, hero and loop in `public/assets/<id>/` (committed). The 2023
      stills and loops that sat beside the videos, unused by the client,
      moved to `.jobs/spikes/legacy-client-dream-extras/` so the R2 sync
      doesn't upload them
- [x] Blank depth panel, checked 2026-10-17 and left as is (user's call):
      132 frames (about 5½s, almost all the walk-away at 1:59-2:08, plus
      15 near 3:30) have a black panel 5 while the matte shows the person.
      The depth look keeps only the top brightness band (235-255 after
      gamma), so a subject far from the camera drops out entirely. The 2023
      depth frames on the HDD are black at the same moments, so the
      published videos always had it. Fixing it would mean re-running
      ZoeDepth on those frames with a per-frame range, then composing all
      ten again
- [ ] Review: panel 7 timing per dream, plus a full watch of at least one
- [ ] Sync R2 (`deploy-dreams`), with the user's go-ahead; deploy the client
- [ ] Optional: review `repairGlitchedFrames`'s 80 flagged matte frames on
      this job (see phase 4e's Other fixes)

Other methods:

- [ ] Try Wan VACE with the matte as a mask
- [ ] Try Difforum with the legacy prompt, negative prompt and colour
      reference
- [ ] Side-by-side clips against the Deforum baseline; record cost, time and
      leak rate

## Open questions

- Is the cut from a re-rendered stretch back to the next good frame
  invisible, or does it need the stretch run a few frames longer? Answered
  by the first repair.
- Do old shared links with datestamp ids matter? If so, add an old-id →
  new-id lookup in `use-history-sync.ts`.
- Keep the 2023 originals anywhere besides the HDD's `output/final/`?
- Where to run ComfyUI workflows for the other methods: a runner on
  Replicate, our own Cog image, or a rented GPU?
