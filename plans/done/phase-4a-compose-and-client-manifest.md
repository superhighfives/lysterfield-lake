---
title: "Phase 4: compose.ts (fixed 7-panel hstack) and client manifest writing"
status: Done
created: 2026-08-27
updated: 2026-08-28
---

# Phase 4: compose.ts (fixed 7-panel hstack) and client manifest writing

## Goal

Port `generate-videos.sh`'s compositing (7-panel hstack + audio mux + loop/
preview generation) into `apps/pipeline/src/compose.ts`, and have the CLI
write its output directly into the shapes `apps/client` actually reads —
retiring `scripts/generate-dreams.js`'s manual bookkeeping role. This is
the fourth phase bullet in
[`rebuild-pipeline-as-replicate-cli.md`](rebuild-pipeline-as-replicate-cli.md)
— see that document for full project architecture and the model inventory.
This spec covers phase 4's own scope and the exact technical detail pulled
from the legacy script and the live client source. Builds directly on
[`plans/done/phase-3-port-frame-steps.md`](../done/phase-3-port-frame-steps.md)
and
[`plans/done/phase-3b-port-outline-and-dream-steps.md`](../done/phase-3b-port-outline-and-dream-steps.md)
— all seven step modules (`init`, `matte`, `background-plate`, `artwork`,
`depth`, `upscale`, `outline`, `dream`) already exist and are individually
verified.

## Context

**Exact legacy compositing command**, from `generate-videos.sh` (still
present, tracked, in `lysterfield-lake-pipeline`):

```
ffmpeg -y \
  -i resources/words/words.mov \
  -i $output/main-compiled-resized-images.mov \
  -i $output/main-compiled-resized-background.mov \
  -i $output/main-compiled-alpha.mov \
  -i $output/main-compiled-depth.mov \
  -i $output/main-compiled-sketch.mov \
  -i $f  # per-scene dreaming.mov \
  -i resources/audio/lysterfield-lake.wav \
  -shortest -map 7:a:0 \
  -filter_complex "[0:v]hstack=inputs=7" \
  -t $OUTPUT_AUDIO_LENGTH -r $frames $crf $duration \
  $output/compiled/$file_name/$file_name-video.mov
```

`[0:v]hstack=inputs=7` looks like it only references input 0, but ffmpeg's
filtergraph auto-links unconnected filter pads to the next unused main
input in order — so this genuinely hstacks inputs 0 through 6 (the 7
videos), with input 7 (the audio) pulled in separately via `-map 7:a:0`.
Confirms the exact panel order the parent plan already documented from the
client shader side: **0=words, 1=artwork (upscaled), 2=background artwork
(upscaled), 3=alpha/matte, 4=depth, 5=outline/sketch, 6=dream**.
`$OUTPUT_AUDIO_LENGTH` comes from `ffprobe`-ing
`resources/audio/lysterfield-lake.wav`; the whole composite is clipped to
that duration (`-shortest -t $OUTPUT_AUDIO_LENGTH`).

**Panels must be pixel-identical width AND height, not just height.**
`hstack` itself only requires equal height, but the client's shader
(`apps/client/src/materials/video-material.tsx`) samples the atlas as
`(vUv.x + (uFrameSelected - 1.0)) / uFrameTotal` — meaning every panel is
assumed to occupy an exactly equal `1/7` fraction of the total texture
width, with `vUv.y` used unmodified across the whole panel. If panels have
different widths, every texture lookup past panel 1 samples the wrong
pixels. The legacy pipeline achieved this by compiling every frame-folder
step into a **1024-wide** reference video first (`-vf scale=1024:-1`,
already `job.ts`'s `compileFramesToVideo` convention from phase 3) — but
the *new* pipeline's step outputs don't already share one resolution the
way the legacy per-frame steps did:

| Panel | Source | Native size |
| --- | --- | --- |
| words | `resources/words/words.mov` (fixed asset) | already 1024×1024 (era-matched, not per-scene) |
| artwork | `upscale.ts` output (Real-ESRGAN ×4 on DiffusionCLIP's 512×512) | 2048×2048 |
| background | `upscale.ts` output (same, on background-plate frames) | 2048×2048 |
| matte | `matte.ts` output | 1024×1024 |
| depth | `depth.ts` output | 1024×1024 |
| outline | `outline.ts` output | 1024×1024 |
| dream | `dream.ts` output (Kling) | 1280×720, **16:9**, not square |

Everything needs normalizing to one square resolution before hstacking.
**1024×1024** matches the legacy compiled-reference convention and doesn't
waste bytes upscaling beyond what any panel already natively provides.
Square panels (artwork/background/matte/depth/outline) are a plain
`scale=1024:1024`. The dream panel is 16:9 and needs a center-crop to
square *before* scaling, or it distorts — same
`crop='min(iw\,ih)':'min(iw\,ih)'` pattern `init.ts` already uses for the
source video's own square crop (phase 3).

**`resources/words/words.mov` and `resources/audio/lysterfield-lake.wav`
aren't per-scene** — one fixed asset pair, shared across every scene,
matching the parent plan's "lyrics/artwork/artwork-background can just be
supplied as PNGs" framing (words specifically is pre-rendered video, not
AI-generated, confirmed in the parent plan's model inventory table). These
need to live somewhere in `apps/pipeline` — `resources/` at the package
root, mirroring the legacy repo's own top-level `resources/` folder,
copied in from `lysterfield-lake-pipeline/resources/` (words.mov,
lysterfield-lake.wav) since they're small, static, and not per-scene
generated output.

**Loop clip is a crop of the dream panel alone, not the composite.** From
`generate-videos.sh`'s loop block: `ffmpeg -ss 00:00:03 -t 00:00:05 -i
$f` where `$f` is the *per-scene dreaming.mov* (pre-hstack) — 3 seconds
in, 5 seconds long. This becomes `apps/client/public/assets/<id>/loop.mov`
(confirmed live in `choose.tsx`: `useVideoTexture(`/assets/${id}/loop.mov`)`).
Compress with `-c:v libx264 -pix_fmt yuv420p -crf 28` matching the legacy
`final/<id>/loop.mov` pass — no separate low-res variant needed (unlike
the main video, which does need one; see below).

**Compression passes**, from the same script: the composite master
(`$file_name-video.mov`) is recompressed to `video.mov` (`libx264,
yuv420p, crf 28`) and a half-resolution `video-small.mov`
(`-vf scale=iw/2:ih/2`, same crf) — matching the client's real fetch
(`apps/client/src/components/playhead.tsx`: `${VITE_APP_DREAMS}/${id}/
video${isMobile || isTouch ? '-small' : ''}.{webm,mov}`). `.webm`
(`libvpx-vp9, crf 35, b:v 0`) variants exist in the legacy script gated
behind an `-a`/`all` flag — the client's `<source>` tags list `.webm`
before `.mov` (browser picks whichever it supports first), so both must
be produced, not just `.mov`.

**`00.jpg`–`03.jpg` polaroid thumbnails are dead weight — don't port.**
The legacy `generate-videos.sh` loop that produces them has a real bug: its
`find ... -prune -o -name ..._00000.png` pattern always resolves to the
exact same single frame (`_00000.png`) for all four `shuf -n 1` picks, so
every scene's four "random" thumbnails were actually identical copies of
frame 0. Worse, grep across the live client's `src/` confirms **nothing
reads `00.jpg`–`03.jpg` anywhere** — `polaroid-material.tsx` samples a
single `uTexture`, fed from `hero.jpg` (`choose.tsx`:
`useTexture(`/assets/${dream.id}/hero.jpg`)`), not four separate images.
Confirmed dead in both the generator and the consumer; no reason to
reimplement it.

**`hero.jpg` has no legacy generator — new design decision.** Grepped both
the tracked pipeline repo and the external drive's fuller copy for `hero` —
no script produces it. It exists in the currently-committed
`apps/client/public/assets/<id>/hero.jpg` files but was evidently a manual
or one-off step, not part of any `generate-*.sh`. For the new pipeline:
derive it from the artwork panel's own first frame (already 1024×1024
after `upscale.ts`, or scale down for a smaller choose-screen asset —
1024 is fine, matches `hero.jpg`'s real committed dimensions closely
enough not to matter), JPEG-encoded via `sharp` at quality ~85 (matching
the legacy `convert -strip -quality 85%` convention used for the dead
00-03.jpg thumbnails — same compression target, applied to a real asset
instead). `loop.webm` (present in the real committed assets folder) isn't
referenced anywhere in `src/` either (`choose.tsx` only calls
`useVideoTexture` on `loop.mov`, a Three.js texture source with no HTML
`<source>` fallback list) — skip it, same reasoning as the 00-03.jpg drop.

**Two distinct output locations, not one "dreams/ folder."** The parent
plan's summary ("write directly into `apps/client/dreams/<id>/...` plus
update `dreams.json`") undersells this — there are genuinely two separate
destinations with different purposes:

1. `apps/client/dreams/<id>/{video,video-small}.{mov,webm}` — full-quality
   playback assets. Gitignored, not part of the Vite build; the client's
   real production deploy syncs this folder to a **separate R2 bucket**
   (`npm run deploy-dreams` → `rclone sync dreams r2:lysterfield-lake-dreams`),
   fetched at runtime via `VITE_APP_DREAMS=/dreams` (an absolute path the
   deployed site resolves against that R2 bucket, not the Vite dev
   server — there's no local dev proxy for this, a pre-existing gap in the
   original repo, not something phase 4 needs to fix).
2. `apps/client/public/assets/<id>/{hero.jpg,loop.mov}` — choose-screen
   assets. Tracked... except they're not: checked `apps/client/.gitignore`
   and confirmed `public/assets` isn't excluded, so these files as they
   exist today (10 real scenes' worth) **are** committed to the repo
   directly (verified: `git ls-files` shows them under `apps/client/
   public/assets/`). New scenes written by the CLI land in the same place
   and get committed the normal way — no separate deploy step, this is
   just part of the client's static build.

`dreams.json` (`src/dreams.json`, `{id, title, link, prompt}[]`) is
imported at **build time** (`apps/client/src/routes/root.tsx`:
`import dreams from '../dreams.json'`), not fetched at runtime — the CLI
writing a new scene needs to append/update an entry here too, same shape
`scripts/generate-dreams.js` already produces (`id`, plus placeholder
`title: 'TBA'`, `link`, `prompt: ''` for anything new — a human fills
those in by hand afterward, matching the existing workflow this script
already establishes).

## Approach

### `resources/`

Copy `words.mov` and `lysterfield-lake.wav` from
`lysterfield-lake-pipeline/resources/{words,audio}/` into
`apps/pipeline/resources/{words,audio}/` — small, static, not
gitignored (unlike per-scene generated output).

### `compose.ts`

```
apps/pipeline/src/compose.ts
```

One function, `compose(job, dreamVideoPath, opts)`, doing in order:

1. Normalize all 7 panels to 1024×1024 `.mov` clips in the job's `video/`
   dir: `words` (copy/re-encode the fixed asset, no scaling needed — it's
   already 1024×1024), `artwork`/`background`/`matte`/`depth`/`outline`
   (each already a frame folder from an earlier step — use `job.ts`'s
   `compileFramesToVideo` with `scale: '1024:1024'`), `dream` (square-crop
   + scale the Kling output, then `-stream_loop` it to at least the audio's
   duration — resolved in Open Questions: loop rather than hold/regenerate
   longer, accepting a visible seam for now. A new small ffmpeg helper, not
   `compileFramesToVideo`, since the input is already a video, not a frame
   folder).
2. `ffprobe` `resources/audio/lysterfield-lake.wav` for its duration
   (matches `$OUTPUT_AUDIO_LENGTH`).
3. hstack the 7 normalized clips + mux the audio, clipped to the audio's
   duration, at the job's fps — the composite master
   (`<job>/video/composite.mov`).
4. Compress to `video.mov`/`video.webm` (crf 28 / crf 35 vp9) and
   `video-small.mov`/`video-small.webm` (same, `+scale=iw/2:ih/2`).
5. Loop clip: 3s-in/5s-long crop of the *dream* panel alone (not the
   composite — matches the legacy behavior exactly), compressed the same
   way as `video.mov`, to `loop.mov`.
6. `hero.jpg`: `sharp`, first frame of the artwork panel's frame folder,
   quality 85.

Return paths for all of the above — `writeClientAssets` (below) is a
separate function that copies them into place, keeping `compose.ts`
itself free of any `apps/client`-specific path knowledge.

### Client manifest writing

```
apps/pipeline/src/client-manifest.ts
```

Takes a scene id + `compose()`'s output paths + a workspace-relative path
to `apps/client` (don't hardcode `../../apps/client` — resolve it the same
way a monorepo-aware tool would, e.g. from a `--client-dir` CLI flag with
a sensible default). Does two things:

1. Copies `video.{mov,webm}`/`video-small.{mov,webm}` into
   `apps/client/dreams/<id>/`, and `hero.jpg`/`loop.mov` into
   `apps/client/public/assets/<id>/`.
2. Reads `apps/client/src/dreams.json`, upserts an entry for this scene id
   (new entries get `title: 'TBA'`, `link: 'https://youtube.com/watch?v='`,
   `prompt: ''` — same placeholder shape `generate-dreams.js` already
   uses; existing entries are left untouched, matching that script's
   find-and-preserve behavior), writes it back.

### CLI

Add a `compose` case to `cli.ts`: `--job`, `--id` (the scene id, used for
the client manifest paths), optional `--client-dir` (default
`../client`, i.e. the sibling workspace package), optional `--skip-client`
(compose only, don't touch `apps/client` — useful for testing the ffmpeg
side against a job that doesn't correspond to a real scene id yet).

### Testing shape

Smoke-test against the same short test clip phase 3's steps were already
validated on (or a fresh short clip) run through the full step chain —
`init → matte → background-plate → artwork ×2 → upscale ×2 → depth →
outline → dream → compose` — end to end via the CLI, one step at a time.
Confirm: all 7 panels visibly present and correctly ordered in the hstack
(the words panel especially — easy to get an off-by-one wrong), the loop
clip is a Kling dream-panel crop not the full composite, and `hero.jpg`
looks like a real artwork frame. Don't write into the *real* `dreams.json`/
`public/assets` during this smoke test — use `--client-dir` pointed at a
scratch copy, or `--skip-client`, and only wire against the real
`apps/client` once satisfied the ffmpeg side is correct.

## Tasks

- [x] Copy `resources/{words,audio}` into `apps/pipeline/resources/`
- [x] `compose.ts` — normalize 7 panels to 1024×1024, hstack + audio mux
      + compress (`video`/`video-small`, `.mov`+`.webm`), loop clip from
      the dream panel, `hero.jpg` from the artwork panel
- [x] `client-manifest.ts` — copy assets into `apps/client/dreams/<id>/`
      and `apps/client/public/assets/<id>/`, upsert `dreams.json`
- [x] Add `compose` case to `cli.ts`
- [x] Smoke-test the full step chain end to end against a short test clip,
      writing to a scratch client dir first, not the real one — ran the
      full chain (`init` → `matte` → `background-plate` → `artwork` ×2 →
      `upscale` ×2 → `depth` → `outline` → `compose`) against a synthetic
      4-frame clip, verified the composite's 7168×1024 dimensions and
      214.8s duration match the audio track exactly, and visually
      confirmed all 7 panels are correctly aligned per the client shader's
      layout contract. Used a synthesized dummy clip for the dream panel
      instead of a real Kling generation — `dream.ts` itself was already
      smoke-tested with real spend in phase 3b, so this phase only needed
      to confirm compose.ts's panel-normalization/hstack/mux mechanics.
- [x] Once satisfied, run once against the real `apps/client` with a throwaway
      scene id to confirm the real-path wiring, then decide with the user
      whether to keep or discard that test scene before committing — ran
      `compose` once against the real `apps/client` dir with id
      `phase4-smoketest-throwaway`; confirmed the write paths and
      `dreams.json` upsert worked correctly, then discarded the throwaway
      output per the user's call (synthetic 4-frame test footage, not
      worth keeping as a real example scene)
- [x] Tick Phase 4 in the parent plan's task list

## Open questions

- **Words panel exact source**: `resources/words/words.mov` is one fixed
  asset for *all* scenes (not per-scene) — confirmed from the legacy
  script's literal path. Worth a quick sanity check against the real file
  once copied in (dimensions, duration ≥ every scene's audio-clipped
  length) before wiring it into the hstack, since a too-short loop would
  need handling `generate-videos.sh` doesn't obviously do (no visible
  `-stream_loop` flag) — if the legacy pipeline never handled this, the
  words asset was presumably always long enough; carry that assumption
  forward rather than adding new handling.
- **Resolved — `-t $OUTPUT_AUDIO_LENGTH` vs. `dream.ts`'s fixed 5-second
  output** (2026-08-27): the real `lysterfield-lake.wav` track is much
  longer than `dream.ts`'s 5-second Kling clip. Per the user: loop the 5s
  clip to fill the audio's full length (`ffmpeg -stream_loop`), accepting
  a visible seam for now — cheap, no extra Replicate spend, revisit later
  if the loop reads badly in the real composite. `compose.ts`'s panel-1
  normalization step (dream: crop+scale to 1024×1024) is where this
  loop-fill belongs, before the hstack, not as a separate step.

## Overview

`apps/pipeline` can now go from a completed set of per-step frame folders
all the way to `apps/client`-ready assets in one command:
`compose --job <dir> --id <scene-id>`. It builds the fixed 7-panel
composite (words, artwork, background artwork, matte, depth, outline,
dream), produces the `video`/`video-small` × `.mov`/`.webm` compressed
variants, a 5-second choose-screen loop, and a `hero.jpg` thumbnail, then
writes everything into the two places `apps/client` actually reads from
and upserts `src/dreams.json` — retiring `scripts/generate-dreams.js`'s
manual bookkeeping role, per the Goal. Verified end to end (all seven
frame steps → compose → client-manifest write) against synthetic test
footage, both into a scratch client directory and, once that passed, once
for real into `apps/client` with a throwaway scene id to confirm the real
write paths before discarding that test output.

## Architecture

`compose.ts` normalizes each of the six frame-folder panels
(artwork/background/matte/depth/outline, each via `job.ts`'s
`compileFramesToVideo` scaled to 1024×1024, plus the fixed `words.mov`
asset) and the one video panel (`dream.ts`'s raw Kling clip — center-
cropped to square, looped with `ffmpeg -stream_loop` to cover the full
audio length per the resolved open question above) into seven
pixel-identical 1024×1024 clips, then hstacks all seven plus the shared
`resources/audio/lysterfield-lake.wav` track into one composite, clipped
to the audio's exact duration. From that composite it derives the
compressed client deliverables (`compress()`, H.264/VP9 × full/half-size),
a 5-second loop cropped from the dream panel (matching the legacy script's
3s-in, 5s-long window), and a `hero.jpg` thumbnail from the artwork
panel's first frame.

`client-manifest.ts`'s `writeClientAssets()` is a thin copy layer on top
of `compose()`'s output — it doesn't do any media work itself. It copies
into two genuinely separate destinations: `apps/client/dreams/<id>/`
(gitignored, full-quality playback video, synced to R2 separately via
`deploy-dreams`) and `apps/client/public/assets/<id>/` (committed,
choose-screen `hero.jpg` + `loop.mov`, part of the normal Vite build) —
then upserts `dreams.json`, matching `generate-dreams.js`'s existing
find-and-preserve shape (new scenes get placeholder
title/link/prompt for a human to fill in by hand, existing entries are
left untouched).

**Deviation from the spec, discovered by smoke-testing:** the spec assumed
a real Kling dream clip would be used for end-to-end testing. Since
`dream.ts` itself was already smoke-tested with real Replicate spend in
phase 3b, this phase's testing instead used a synthesized dummy clip
(passed via `compose`'s `--dream` flag override) to validate `compose.ts`'s
own mechanics — panel normalization, the hstack/audio-mux filtergraph, and
the compression/loop/hero passes — without spending on a second real
Kling generation that wouldn't have tested anything new.
