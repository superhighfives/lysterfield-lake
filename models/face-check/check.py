# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["ultralytics>=8.3", "torch", "pillow"]
# ///
"""Face score for dream (panel 7) frames. Local and free: no Replicate calls.

A second check beside models/person-check, and independent of it. The
person probe learned 2023's judgement, where a painted face on an ink-wash
bust was kept, and the Deforum reroll searched against that same probe, so
Sharp Edges shipped with painted faces both passed
(plans/in-progress/dreams.md, "The check misses painted faces"). This looks
only for faces, painted or photographed: Bingsu/adetailer's face_yolov8m, a
YOLOv8 trained on real and illustrated faces.

Never use this score to reroll or re-render until it passes: a search
against a detector finds the faces it misses. It reports; a person decides.

Usage: uv run check.py --out faces.json < paths.txt   (one image path per line)
Output: { "model", "scores": { "<path>": 0..1 }, "boxes": { "<path>": [x1, y1, x2, y2] } }
  score = the most confident face box that passes the box rule (0 when none);
  boxes are that box, as fractions of the frame's width and height.
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REVISION = "53cc19de382014514d9d4038601d261a7faa9b7b"
WEIGHTS = os.path.join(HERE, "face_yolov8m.pt")
WEIGHTS_SHA256 = "717923c19b3f4bbf5250b728f1fa6b2cb72a33aed1d236ea9caf0e21ad943e5f"
WEIGHTS_URL = f"https://huggingface.co/Bingsu/adetailer/resolve/{REVISION}/face_yolov8m.pt"

# The box rule: a face box 6-50% of the frame wide, its centre 15-85% of the
# way across. Boxes outside it in the clean dreams were all clouds, corners
# and texture; it halves their false alarms and keeps every Sharp Edges face.
MIN_WIDTH, MAX_WIDTH = 0.06, 0.50
MIN_CENTRE, MAX_CENTRE = 0.15, 0.85


def weights() -> str:
    if not os.path.exists(WEIGHTS):
        print(f"Downloading face_yolov8m to {WEIGHTS}...", file=sys.stderr)
        urllib.request.urlretrieve(WEIGHTS_URL, WEIGHTS + ".part")
        with open(WEIGHTS + ".part", "rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        if digest != WEIGHTS_SHA256:
            os.remove(WEIGHTS + ".part")
            raise RuntimeError("Face weights failed their checksum")
        os.rename(WEIGHTS + ".part", WEIGHTS)
    return WEIGHTS


def device() -> str:
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    return "cuda" if torch.cuda.is_available() else "cpu"


def passes(box) -> bool:
    x1, _, x2, _ = box
    width, centre = x2 - x1, (x1 + x2) / 2
    return MIN_WIDTH <= width <= MAX_WIDTH and MIN_CENTRE <= centre <= MAX_CENTRE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--batch", type=int, default=16)
    args = parser.parse_args()
    paths = [line.strip() for line in sys.stdin if line.strip()]

    from ultralytics import YOLO

    model = YOLO(weights())
    dev = device()
    scores, boxes = {}, {}
    for i in range(0, len(paths), args.batch):
        chunk = paths[i : i + args.batch]
        for path, result in zip(chunk, model.predict(chunk, conf=0.05, imgsz=640, device=dev, verbose=False)):
            found = [
                (conf, box)
                for conf, box in zip(result.boxes.conf.cpu().tolist(), result.boxes.xyxyn.cpu().tolist())
                if passes(box)
            ]
            if found:
                conf, box = max(found, key=lambda f: f[0])
                scores[path] = round(conf, 5)
                boxes[path] = [round(v, 4) for v in box]
            else:
                scores[path] = 0.0
        print(f"{min(i + args.batch, len(paths))}/{len(paths)}", file=sys.stderr)

    with open(args.out, "w") as f:
        json.dump({"model": f"Bingsu/adetailer@{REVISION[:7]}/face_yolov8m", "scores": scores, "boxes": boxes}, f)


if __name__ == "__main__":
    main()
