#!/bin/sh
# Fetches Deforum at the exact upstream commit the legacy dreams were made on (main @ 40f5c2e,
# 2023-06-02, "Merge 0.7.1"; found in the legacy PC's checkout in the HDD's Linux backup), and
# applies the legacy edits on top: render.py (Random/Specific/Sticky colour modes) and
# conditioning.py (weighted CLIP prompts split on "=" instead of ":"). Run before `cog build`.
set -e
cd "$(dirname "$0")"
COMMIT=40f5c2e
[ -d deforum ] || git clone -q https://github.com/deforum-art/deforum-stable-diffusion.git deforum
git -C deforum checkout -q "$COMMIT"
git -C deforum checkout -q -- helpers
cp legacy/render.py deforum/helpers/render.py
cp legacy/conditioning.py deforum/helpers/conditioning.py
# The person classifier predict.py scores each frame with: one copy, owned by models/person-check.
cp ../person-check/probe.json probe.json
echo "deforum @ $(git -C deforum rev-parse --short HEAD) with the legacy render.py and conditioning.py"
