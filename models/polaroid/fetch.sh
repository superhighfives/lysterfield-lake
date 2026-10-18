#!/bin/sh
# Copies in the code this model shares with the per-step models, so each lives in one place: DiffusionCLIP's
# U-Net and sampling step (models/diffusionclip) and the coarse lineart network (models/lineart).
# Run before `cog build`. The copies are gitignored.
set -e
cd "$(dirname "$0")"
rm -rf vendor && mkdir -p vendor/diffusionclip/models vendor/diffusionclip/utils vendor/diffusionclip/configs
cp -R ../diffusionclip/models/improved_ddpm vendor/diffusionclip/models/
cp ../diffusionclip/utils/diffusion_utils.py vendor/diffusionclip/utils/
cp ../diffusionclip/configs/imagenet.yml vendor/diffusionclip/configs/
touch vendor/__init__.py vendor/diffusionclip/__init__.py vendor/diffusionclip/models/__init__.py vendor/diffusionclip/utils/__init__.py
cp ../lineart/predict.py vendor/lineart.py
echo "vendored diffusionclip and lineart into $(pwd)/vendor"
