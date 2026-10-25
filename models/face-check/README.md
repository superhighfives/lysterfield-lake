# face-check

Local face score for dream (panel 7) frames, the second half of the
pipeline's `dream-check` step beside [`person-check`](../person-check). Not a
Cog model and never deployed: it runs on this machine with `uv`, so it is
free and can be rerun at will. See
[`plans/in-progress/dreams.md`](../../plans/in-progress/dreams.md), "The
check misses painted faces".

```sh
ls /path/to/frames/*.jpg | uv run check.py --out faces.json
```

## Why a second check

`person-check` learned 2023's decisions, and in 2023 a face painted on an
ink-wash bust was kept. Sharp Edges shipped with painted faces in about half
its frames because of that: the probe scored them under its threshold, and
the Deforum reroll, searching against the same probe, kept the faces it
missed. This one looks only for faces, painted or photographed, and shares
nothing with the probe. `dream-check` flags a frame when either score is
over its threshold.

**Never reroll or re-render against this score.** A search until a
detector stops firing finds exactly the faces it can't see. The reroll and
`dream-repair`'s rounds decide on the Deforum model's own verdict; the face
score is only written into `check.json` for a person to review.

## Model

[Bingsu/adetailer](https://huggingface.co/Bingsu/adetailer)'s
`face_yolov8m.pt` (52MB, pinned to revision `53cc19d`, SHA-256 checked;
weights Apache-2.0), a YOLOv8 trained on real and illustrated faces, run
with `ultralytics` (AGPL-3.0, fine for a local tool). `check.py` downloads
the weights on first use. About 95 seconds for a full song on an M4.

A face box only counts if it's 6-50% of the frame wide with its centre
15-85% of the way across: boxes outside that in the clean dreams were all
clouds, corners and texture.

## How it was chosen (2026-10-25)

A hand-labelled set of 327 frames from the published dreams: 72 with a
person (62 with a readable face), 255 without, 83 of those hard (Sharp
Edges' torn silhouettes, Ink Flight's red busts, Clouds of Air's rock
head). Against OWLv2, an anime face detector, a WIDER-face YOLO, COCO's
person class and a small local VLM (qwen2.5-vl 3B), adetailer's face model
caught the most faces at the fewest false alarms, and at 0.04s a frame
the VLM's 5s couldn't compete. Together with the person score at 0.18:
57 of 72 with a person, 51 of 62 faces, 5 of 255 false alarms, none of the
hard ones.

Known gap: faint watercolour faces (Ink Flight around frame 400) score low
on every detector tried, so a full watch of panel 7 before publishing is
still part of the loop.
