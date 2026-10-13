# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["torch", "open_clip_torch", "numpy", "pillow"]
# ///
"""Person score for dream (panel 7) frames. Local and free: no Replicate calls.

Panel 7 must never show a person (CLAUDE.md), and Deforum leaks one into a
few percent of frames whatever the negative prompt says. This scores how
person-like each frame is so the leaks can be found without looking at every
frame (plans/in-progress/dreams.md).

What counts (user, 2026-10-12): a literal person, hands, or a paper cut-out
of the subject with a picture in it. A shape that only looks like a person
(an ink-wash bust, a rock where the head was) is the intended look and
should score low.

Zero-shot CLIP can't draw that line, so the score is a small linear
classifier (probe.json) over CLIP ViT-L/14 embeddings of the whole frame and
its central half (the person appears where the subject is). It was trained
by train.py on the ten legacy dreams' pre-repair videos: frames replaced by
hand in 2023 against frames that were kept.

Usage: uv run check.py --out scores.json < paths.txt   (one image path per line)
Output: { "model", "scores": { "<path>": 0..1 } }
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.request

import numpy as np
import torch
from open_clip.openai import load_openai_model
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.path.join(HERE, "ViT-L-14.pt")
WEIGHTS_SHA256 = "b8cca3fd41ae0c99ba7e8951adf17d267cdb84cd88be6f7c2e0eca1737a03836"
WEIGHTS_URL = f"https://openaipublic.azureedge.net/clip/models/{WEIGHTS_SHA256}/ViT-L-14.pt"

PROBE = os.path.join(HERE, "probe.json")

SIZE = 448
MEAN = (0.48145466, 0.4578275, 0.40821073)
STD = (0.26862954, 0.26130258, 0.27577711)


def weights() -> str:
    if not os.path.exists(WEIGHTS):
        print(f"Downloading CLIP ViT-L/14 to {WEIGHTS}...", file=sys.stderr)
        urllib.request.urlretrieve(WEIGHTS_URL, WEIGHTS + ".part")
        with open(WEIGHTS + ".part", "rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        if digest != WEIGHTS_SHA256:
            os.remove(WEIGHTS + ".part")
            raise RuntimeError("CLIP weights failed their checksum")
        os.rename(WEIGHTS + ".part", WEIGHTS)
    return WEIGHTS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--batch", type=int, default=32)
    args = parser.parse_args()
    paths = [line.strip() for line in sys.stdin if line.strip()]

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    model = load_openai_model(weights(), precision="fp32", device=device)
    mean = torch.tensor(MEAN, device=device).view(1, 3, 1, 1)
    std = torch.tensor(STD, device=device).view(1, 3, 1, 1)
    with open(PROBE) as f:
        probe = json.load(f)
    coef = torch.tensor(probe["coef"], device=device)

    def embed(view):
        with torch.no_grad():
            return torch.nn.functional.normalize(model.encode_image((view - mean) / std).float(), dim=-1)

    scores = {}
    for i in range(0, len(paths), args.batch):
        batch = paths[i : i + args.batch]
        pixels = np.stack([np.asarray(Image.open(p).convert("RGB").resize((SIZE, SIZE), Image.BICUBIC)) for p in batch])
        x = torch.from_numpy(pixels).to(device).permute(0, 3, 1, 2).float() / 255
        full = torch.nn.functional.interpolate(x, size=224, mode="bicubic", antialias=True).clamp(0, 1)
        q = SIZE // 4
        centre = x[:, :, q : q + 224, q : q + 224]
        score = torch.sigmoid(torch.cat([embed(full), embed(centre)], dim=1) @ coef + probe["intercept"]).cpu().tolist()
        scores.update(zip(batch, (round(s, 5) for s in score)))
        print(f"Scored {min(i + args.batch, len(paths))} of {len(paths)}", file=sys.stderr)

    with open(args.out, "w") as f:
        json.dump({"model": "clip-vit-l-14+probe", "scores": scores}, f)


if __name__ == "__main__":
    main()
