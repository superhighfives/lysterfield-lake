# Lysterfield Lake

An interactive, AI-generated, 3D music video for Brightly's "Lysterfield Lake", made from a single video shot on an iPhone. Watch it at [lysterfieldlake.com](https://lysterfieldlake.com/).

This repo holds the whole project: the app that plays the video, the pipeline that makes it, and the models the pipeline runs. It replaces two older repos, [lysterfield-lake-client](https://github.com/superhighfives/lysterfield-lake-client) (the original app) and [lysterfield-lake-pipeline](https://github.com/superhighfives/lysterfield-lake-pipeline) (the original bash and Python pipeline). Both are still there to read, but nothing new happens in them.

This is a passion project. It's here for anyone who wants to see how the video was made, not as an example of how to build a fast React app.

You can [read more about how the project works on Medium](https://medium.com/@superhighfives/lysterfield-lake-71345aa8c016).

<a href="https://medium.com/@superhighfives/lysterfield-lake-71345aa8c016">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/making-of-dark.png">
    <img alt="How Lysterfield Lake is made: one iPhone video, split into frames, run through a set of models, and stitched back together in the browser" src=".github/readme/making-of-light.png">
  </picture>
</a>

## How it works

The video is seven panels of the same footage, each one a different take on it:

1. Lyrics
2. Portrait: the person, repainted
3. Portrait background: the scene with the person removed
4. Matte: a cut-out mask of the person
5. Depth: how far each part of the frame is from the camera
6. Outline: line art of the person
7. Dream: the whole scene reimagined as a painting, with no person in it

The app plays panels 1 to 6 as one shared video with the song, and each dream as a small video of its own beside it. In the browser, [three.js](https://threejs.org/) cuts the panels apart and puts them back together as a 3D scene. You steer it with the mouse, or by tilting your phone. You can switch dreams mid-song from the stack of cards, and the music keeps playing.

There are twelve dreams so far. Each one, at the same opening moment of the song:

| | Dream | Look |
| --- | --- | --- |
| <img src="apps/client/public/assets/oil-slick/hero.jpg" width="160" alt=""> | **Oil Slick** | Wire and folded paper in sepia |
| <img src="apps/client/public/assets/sharp-edges/hero.jpg" width="160" alt=""> | **Sharp Edges** | Torn ink landscape in pink and ochre |
| <img src="apps/client/public/assets/watercolour/hero.jpg" width="160" alt=""> | **Watercolour** | A watercolor painting |
| <img src="apps/client/public/assets/paper-planes/hero.jpg" width="160" alt=""> | **Paper Planes** | A pencil illustration of summer |
| <img src="apps/client/public/assets/clouds-of-air/hero.jpg" width="160" alt=""> | **Clouds of Air** | Breathtaking vibrant poster style |
| <img src="apps/client/public/assets/dirty-palette/hero.jpg" width="160" alt=""> | **Dirty Palette** | A lake at dawn with sunlight through trees |
| <img src="apps/client/public/assets/horizon-storm/hero.jpg" width="160" alt=""> | **Horizon Storm** | Landscape painting with paint dripping |
| <img src="apps/client/public/assets/lush-and-light/hero.jpg" width="160" alt=""> | **Lush and Light** | Vibrant detailed landscape |
| <img src="apps/client/public/assets/ghiblis-dream/hero.jpg" width="160" alt=""> | **Ghibli's Dream** | Ghibli-aesthetic landscape picture |
| <img src="apps/client/public/assets/mood-lighting/hero.jpg" width="160" alt=""> | **Mood Lighting** | Palette knives and brush strokes |
| <img src="apps/client/public/assets/ink-flight/hero.jpg" width="160" alt=""> | **Ink Flight** | Alcohol and tea ink style |
| <img src="apps/client/public/assets/charcoal/hero.jpg" width="160" alt=""> | **Charcoal** | Black and white gouache |

The newest is first, as it is in the app's chooser.

## What's in here

| Directory | What it is |
| --- | --- |
| `apps/client` | The app: Vite, React and React Three Fiber, served by a Cloudflare Worker at lysterfieldlake.com |
| `apps/pipeline` | A command-line tool that turns one video into every panel, mostly by calling models on [Replicate](https://replicate.com/) |
| `models` | The project's own [Cog](https://github.com/replicate/cog) models, and a local person check for the dreams |
| `plans` | Plans for the work, moved through `backlog`, `ready`, `in-progress` and `done` |

### The pipeline

The original pipeline was a set of bash scripts that ran Python scripts, ffmpeg, and three model servers on a PC with an RTX 3060. Making a dream meant a manual pass through Deforum and frame interpolation on that same PC.

The new one is a single TypeScript command-line tool. Each panel is a step you can run on its own against a job folder (`apps/pipeline/.jobs/<name>/`), and a step skips any output that already exists, because model calls cost money and a song is thousands of frames. The models behind each panel:

| Panel | Model |
| --- | --- |
| Portrait | [DiffusionCLIP](https://github.com/gwang-kim/DiffusionCLIP), as the project's own Cog model (`models/diffusionclip`), upscaled with [Real-ESRGAN](https://replicate.com/cjwbw/real-esrgan) |
| Portrait background | [Bria's video object eraser](https://replicate.com/bria/video-erase-object) |
| Matte | [Robust Video Matting](https://replicate.com/arielreplicate/robust_video_matting) |
| Depth | [ZoeDepth](https://replicate.com/cjwbw/zoedepth) |
| Outline | Coarse line art from ControlNet's annotators (`models/lineart`) |
| Dream | Deforum 0.7.1, set up the way the original dreams were made (`models/deforum`), with an optional style reference image |

Dreams run on Replicate, or on a local RTX 4090 for free. Every dream frame then gets a person check (`models/person-check`, a local CLIP model), because the dream panel must never show a person. Flagged stretches are rendered again with new seeds instead of being blended over.

A development-only `/admin` page in the app drives all of this: brainstorm a dream's direction, judge it on a few sample frames, then on a 15-second clip in the real player, and only then pay for the full song.

## Coming soon

- **Polaroids.** An "Add your own" link under the dream stack opens an endless grid of looping 3D polaroids, one per visitor. You record a 5-second clip, it waits in a queue until a person approves it, and then the pipeline turns it into a polaroid of you, made from panels 2 to 6. You get an email with a private link when it's ready. It works end to end in `/admin` today, behind the `VITE_APP_POLAROIDS` flag.
- **More dreams.** The person check and repair loop make a new dream much cheaper to check, so the next one is on its way.
- **Cleaner dreams.** Repairing the frames in the ten original dreams where a person leaks through, and trying video models like Wan VACE that hold together better from frame to frame than Deforum.
- **Steadier mattes and depth.** The matte sometimes glitches for a second or two, and depth can flutter in the corners. Newer models may fix both.

## Getting started

You need [Bun](https://bun.sh/). Install everything from the root:

```sh
bun install
```

Run the app:

```sh
bun run --cwd apps/client dev
```

The videos aren't in the repo. The app reads them from `VITE_APP_DREAMS`, the `lysterfield-lake-dreams` bucket at dreams.lysterfieldlake.com, in development too. The pipeline's `compose` writes them into the job (`7-dreams/<id>/split/` and `main/`), `apps/client/scripts/upload-dreams.sh <id>` uploads them, and until then `/admin` plays a take's clip or whole song from the job.

Run a pipeline step (it needs `REPLICATE_API_TOKEN` in `apps/pipeline/.env`; see `apps/pipeline/.env.example`):

```sh
bun run --cwd apps/pipeline cli init --job .jobs/my-video --source ~/Movies/my-video.mov
bun run --cwd apps/pipeline cli matte --job .jobs/my-video
```

Merging to `main` deploys the app (`.github/workflows/deploy.yml`).

### What needs an agent

Out of the box you can run the app against the published videos, and run any one pipeline step with a Replicate token. Taking a video of your own all the way through is a different job. It's more than a dozen steps in a set order, each checked before the next, plus pieces no command sets up for you:

- A public R2 bucket for Bria's inputs (`R2_*` in `apps/pipeline/.env`), for the background panel.
- A lyrics panel. This song's was hand-lettered in After Effects; `words` only extracts it.
- A bucket of your own to serve the composed videos from, in place of `dreams.lysterfieldlake.com`.
- Swapping this song out of the app: its audio, lyrics, title and dreams.

That's the part to hand to a coding agent like [Claude Code](https://claude.com/claude-code). Point it at the repo and ask it to take your video through the pipeline. [`CLAUDE.md`](CLAUDE.md) has the rules it works to, including never calling a paid model without first checking the output doesn't already exist, and `plans/` records why each step works the way it does.
