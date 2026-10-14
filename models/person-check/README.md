# person-check

Local person score for dream (panel 7) frames, used by the pipeline's
`dream-check` step. Not a Cog model and never deployed: it runs on this
machine with `uv`, so it is free and can be rerun at will. See
[`plans/in-progress/dreams.md`](../../plans/in-progress/dreams.md).

```sh
ls /path/to/frames/*.jpg | uv run check.py --out scores.json
```

## Weights

CLIP ViT-L/14 (`ViT-L-14.pt`, 890MB), not committed. `check.py` downloads
it from OpenAI's host on first use and checks its SHA-256.

## What it scores

A literal person, hands, or a paper cut-out of the subject with a picture in
it: the frames that were thrown out by hand in 2023. A shape that only looks
like a person (ink-flight's and charcoal's ink-wash bust, lush-and-light's
rock where the head was) is the intended look and scores low.

The score is a linear classifier (`probe.json`) over CLIP embeddings of the
whole frame and its central half.

## Retraining

```sh
uv run train.py ../../apps/pipeline/.jobs/spikes/person-check/embeddings
```

The embeddings folder (not committed) has one `.npz` per legacy dream:
every frame of its pre-repair video, labelled by whether the frame was
replaced in 2023. Add a reviewed take as another `.npz` to teach it that
take's style. `train.py` prints how many bad and kept frames each threshold
flags on held-out data; check `PERSON_SCORE_THRESHOLD` in
`apps/pipeline/src/steps/dream-check.ts` against that.
