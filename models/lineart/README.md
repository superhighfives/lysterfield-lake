# lineart

Private Cog model for panel 6 (outline): coarse line art of the subject.
It replaced ArtLine (`models/outline/`) after the outline bake-off in
[`phase-4g-outline-coarse-lineart.md`](../../plans/in-progress/phase-4g-outline-coarse-lineart.md).

The line model is the "coarse" sketch generator from ControlNet's annotators,
vendored from [controlnet_aux](https://github.com/huggingface/controlnet_aux)
0.0.10 (Apache-2.0), so the image only needs torch, OpenCV and Pillow.

## Inputs

- `image`: the raw source frame (`0-source/frames/NNNN.jpg`), not a stylised panel.
- `mask`: the subject matte (`4-matte/frames/NNNN.png`). Lines outside it,
  dilated by a few px, are removed.
- `cleanup` (default on): light edge-preserving smoothing before the line
  pass, then faint strokes dropped and the rest boosted (`floor`, `gain`).
  This was the bake-off pick ("coarse, cleaned"). Off gives plain coarse
  line art, the runner-up.

## Weights

Not committed (gitignored). Download before building:

```sh
curl -L -o sk_model2.pth https://huggingface.co/lllyasviel/Annotators/resolve/main/sk_model2.pth
```

## Local test

```sh
cog predict -i image=@frame.jpg -i mask=@matte.png
```
