#!/usr/bin/env bash
# Starts the polaroid model (models/polaroid) as a standing service on this PC: Cog's HTTP API on port
# 5001 (Deforum keeps 5000), restarted with Docker. The pipeline reaches it at POLAROID_URL.
# Under WSL, cuDNN 8.5 in this image opens the unversioned libcuda.so, which only exists here as
# libcuda.so.1 in a versioned driver folder, so a link to it goes first on the library path. The folder's
# name changes with the NVIDIA driver, so the link is re-made each time this runs.
set -euo pipefail
image=${1:-polaroid:gpu-pc}
link_dir="$HOME/lysterfield-models/wsl-cuda"
mkdir -p "$link_dir"
# The drivers folder is a 9p view of Windows' driver store: older NVIDIA folders linger there, and files
# inside it don't always show up to a lookup, so take the folder with a matching .ini (the active one).
ini=$(ls -d /usr/lib/wsl/drivers/nv_dispi.inf_amd64_*.ini 2>/dev/null | head -1)
[ -n "$ini" ] || { echo "no NVIDIA driver under /usr/lib/wsl/drivers" >&2; exit 1; }
drv="${ini%.ini}/libcuda.so.1"
ln -sfn "$drv" "$link_dir/libcuda.so"
ldp=$(docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^LD_LIBRARY_PATH=//p')
docker rm -f polaroid >/dev/null 2>&1 || true
docker run -d --name polaroid --restart unless-stopped --gpus all -p 5001:5000 \
  -v "$link_dir:/wsl-cuda" -e "LD_LIBRARY_PATH=/wsl-cuda${ldp:+:$ldp}" "$image"
