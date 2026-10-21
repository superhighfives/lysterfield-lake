# polaroid

Every per-frame model behind a visitor's polaroid (panels 2, 4, 5 and 6) in one Cog image, so a whole loop is
one prediction with one boot instead of five models' worth of boots, uploads and per-call overhead. See
`plans/backlog/release-polaroids.md`. Panel 3 (background) stays on Bria, an official model billed by the
second with no boot.

| Panel | Model | Was |
| --- | --- | --- |
| 4 matte | RVM resnet50, auto downsample, 12-frame chunks | `arielreplicate/robust_video_matting` |
| 2 portrait | DiffusionCLIP watercolour, then Real-ESRGAN x4plus at 2x | `superhighfives/diffusionclip`, `cjwbw/real-esrgan` |
| 5 depth | ZoeD_N, colourised | `cjwbw/zoedepth` |
| 6 outline | coarse lineart, cleaned, unmasked | `superhighfives/lysterfield-lineart` |

Each panel's raw output matches what the pipeline got from that model, and the pipeline keeps its own
post-processing (matte repairs, depth's gamma and masking, outline's masking with the repaired matte).

## Build

```sh
./fetch.sh            # copies DiffusionCLIP's and lineart's code in from their own folders (gitignored)
cog build -t polaroid
```

The image is about 33GB, and a build needs room for roughly twice that, more than the Mac usually has. Build
it on the 4090 PC (`~/lysterfield-models/polaroid` there), which is natively x86 and can test it on its GPU
for free.

## Testing on the PC

`~/lysterfield-models/run-local.py <image> <out> key=value...` runs one prediction on the PC's GPU (port 5001,
since Deforum keeps 5000). Under WSL, cuDNN 8.5 in this image can't find the driver (only `libcuda.so.1`
exists there) and the first conv segfaults; the script mounts a `libcuda.so` link to fix that. Replicate's
machines don't need it.

The Deforum container holds about 8GB of the 4090's 24GB, so keep `portrait_batch` at 1 there: at 4 the GPU
ran out of memory, spilled into system memory and slowed to a crawl.

## Measured (2026-10-18, RTX 4090)

- Matches the old models: DiffusionCLIP's frame at the old settings is 72dB PSNR from the old model's
  (models/diffusionclip/run.py, same code), and the other panels match the `park-party` run by eye.
- 8 frames, every panel: 103s (about 13s a frame, nearly all of it the portrait at 40 inversion steps).
- DiffusionCLIP, one frame: 11.9s at 40 inversion steps, 7.9s at 20 (34.5dB from 40, no visible change),
  7.0s at 10 (softer, a visibly different brush texture). fp16 was slower (13.5s at 40): autocast's casts cost
  more than this U-Net gains.

## Measured (2026-10-18, Replicate)

Deployment `superhighfives/lysterfield-polaroid` (L40S, 0-4 instances). `park-party` split four ways,
from cold: 9 minutes wall clock, each range 130-207s queued and booting, then ~322s running (10.4s a frame
at `portrait_batch` 4, so batching was no faster than the 4090 one at a time). About $2 with the boots,
~$1.25 warm. Output matches the PC's (portrait 51dB, depth 54-56dB).

Pushing this image to r8.im times out finalising large layers (`timeout awaiting response headers`) from
both the Mac and the PC. Retrying works, since each attempt only sends what's missing: the first push took
five tries.
