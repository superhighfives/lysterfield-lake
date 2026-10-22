#!/usr/bin/env bash
# Uploads dreams' split files from dreams/ to the next app's bucket
# (lysterfield-lake-next-dreams, served at next-dreams.lysterfieldlake.com):
# the files the player loads, `dream{,-small}.{mp4,webm}` per dream and
# `main{,-small}.{mp4,webm}` for main. Additive: nothing in the bucket is
# deleted, and a file already there at the same size is skipped.
#
#   scripts/upload-next-dreams.sh <id>...      # e.g. lake-light, or main
#   scripts/upload-next-dreams.sh --dry-run <id>...
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET=lysterfield-lake-next-dreams
PUBLIC=https://next-dreams.lysterfieldlake.com
dry=false
[ "${1:-}" = --dry-run ] && { dry=true; shift; }
[ $# -gt 0 ] || { echo "usage: $0 [--dry-run] <id>..." >&2; exit 1; }

for id in "$@"; do
  base=$([ "$id" = main ] && echo main || echo dream)
  for file in "$base.mp4" "$base-small.mp4" "$base.webm" "$base-small.webm"; do
    local_path="dreams/$id/$file"
    [ -f "$local_path" ] || { echo "skip $id/$file: not in dreams/"; continue; }
    size=$(stat -f %z "$local_path" 2>/dev/null || stat -c %s "$local_path")
    remote=$(curl -sI "$PUBLIC/$id/$file" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')
    if [ "$remote" = "$size" ]; then echo "same $id/$file"; continue; fi
    type=$([ "${file##*.}" = webm ] && echo video/webm || echo video/mp4)
    echo "put  $id/$file ($size bytes)"
    $dry || bunx wrangler r2 object put --remote "$BUCKET/$id/$file" --file "$local_path" \
      --content-type "$type" --cache-control "public, max-age=604800" >/dev/null
  done
done
