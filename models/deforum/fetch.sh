#!/bin/sh
# Fetches Deforum 0.7.1 at the exact commit the legacy dreams were made with, and applies the
# legacy render.py on top (custom Random/Specific/Sticky colour modes). Run before `cog build`.
set -e
cd "$(dirname "$0")"
COMMIT=58a6c93e1c
[ -d deforum ] || git clone -q -b 0.7.1 https://github.com/deforum-art/deforum-stable-diffusion.git deforum
git -C deforum checkout -q "$COMMIT"
cp legacy/render.py deforum/helpers/render.py
echo "deforum @ $(git -C deforum rev-parse --short HEAD) with legacy render.py"
