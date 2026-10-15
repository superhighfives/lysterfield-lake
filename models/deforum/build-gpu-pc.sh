#!/bin/sh
# Builds the Deforum model for our own GPU (the RTX 4090 PC; plans/in-progress/dreams.md, Our own GPU),
# not for Replicate: the same model, settings and code, plus xformers. Without it, a 1024x1024 frame with
# CLIP guidance needs more than the 4090's 24 GB and spills into system memory (one frame took over 12
# minutes). xformers' memory-efficient attention, which Deforum uses when it's installed, keeps it on the
# GPU. xformers ships wheels for PyTorch 1.13.1, so this build uses that (CUDA 11.7) instead of 1.12.1.
# Run from this folder after fetch.sh, on a machine with Docker and an NVIDIA GPU: ./build-gpu-pc.sh
set -e
cd "$(dirname "$0")"
sed \
  -e 's/"torch==1.12.1+cu116" "torchvision==0.13.1+cu116"/"torch==1.13.1+cu117" "torchvision==0.14.1+cu117" "xformers==0.0.16"/' \
  -e 's#whl/cu116#whl/cu117#' \
  cog.yaml > cog.gpu-pc.yaml
grep -q 'xformers==0.0.16' cog.gpu-pc.yaml || { echo "cog.yaml changed; update build-gpu-pc.sh to match" >&2; exit 1; }
cog build -f cog.gpu-pc.yaml -t lysterfield-deforum:gpu-pc
