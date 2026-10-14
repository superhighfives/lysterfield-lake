# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["numpy", "scikit-learn"]
# ///
"""Trains probe.json, check.py's classifier, from labelled CLIP embeddings.

Usage: uv run train.py <embeddings dir>

Each <name>.npz in the directory holds `full` and `centre` (CLIP ViT-L/14
embeddings of every frame and of its central half, normalised, as check.py
computes them) and `replaced` (true where the frame was thrown out). The
first set is the ten legacy dreams' pre-repair videos, with the frames
replaced by hand in 2023 as the bad ones
(apps/pipeline/.jobs/spikes/person-check/embeddings, not committed). Adding
a reviewed take's frames as another .npz teaches it that take's style.

Prints a cross-validated check first (six contiguous blocks per file, so
neighbouring frames never straddle train and test), then fits on everything.
"""

import glob
import json
import os
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression

FOLDS = 6


def fit(x, y):
    return LogisticRegression(C=1.0, max_iter=3000, class_weight="balanced").fit(x, y)


def main():
    files = sorted(glob.glob(os.path.join(sys.argv[1], "*.npz")))
    data = {os.path.basename(f)[:-4]: np.load(f) for f in files}
    x = {d: np.concatenate([z["full"], z["centre"]], axis=1) for d, z in data.items()}
    y = {d: z["replaced"].astype(bool) for d, z in data.items()}
    fold = {d: np.arange(len(y[d])) * FOLDS // len(y[d]) for d in data}

    held_out = {d: np.zeros(len(y[d])) for d in data}
    for k in range(FOLDS):
        clf = fit(np.concatenate([x[d][fold[d] != k] for d in data]), np.concatenate([y[d][fold[d] != k] for d in data]))
        for d in data:
            held_out[d][fold[d] == k] = clf.predict_proba(x[d][fold[d] == k])[:, 1]
    for threshold in (0.2, 0.35, 0.5):
        caught = sum(int(((held_out[d] > threshold) & y[d]).sum()) for d in data)
        kept_flagged = sum(int(((held_out[d] > threshold) & ~y[d]).sum()) for d in data)
        print(f"threshold {threshold}: {caught} of {sum(int(v.sum()) for v in y.values())} bad frames flagged, {kept_flagged} kept frames flagged")

    clf = fit(np.concatenate(list(x.values())), np.concatenate(list(y.values())))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe.json")
    with open(out, "w") as f:
        json.dump({"coef": [round(float(c), 5) for c in clf.coef_[0]], "intercept": float(clf.intercept_[0])}, f)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
