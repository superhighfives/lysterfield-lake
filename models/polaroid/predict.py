"""
A polaroid's per-frame panels in one prediction (plans/backlog/user-polaroid-loops.md). Each panel's raw output
matches what the pipeline got from that panel's own Replicate model; the pipeline still does its own
post-processing (matte repairs, depth's gamma and masking, outline's masking), so it keeps one place for that.

In: the job's cropped source video (`0-source/video.mov`). Out: a tar with
  0-source/frames/NNNN.jpg     the frames every per-frame panel ran on (as the pipeline's init extracts them)
  4-matte/raw.mp4              RVM alpha at the source's own frame rate     (arielreplicate/robust_video_matting)
  2-portrait/raw/NNNN.jpg      DiffusionCLIP watercolour, 512px            (superhighfives/diffusionclip)
  2-portrait/upscaled/NNNN.jpg Real-ESRGAN 2x of raw, 1024px               (cjwbw/real-esrgan, upscale 2)
  5-depth/raw/NNNN.png         ZoeDepth, colourised, before gamma/masking  (cjwbw/zoedepth, ZoeD_N)
  6-outline/raw/NNNN.jpg       coarse lineart, cleaned, not yet masked     (superhighfives/lysterfield-lineart)
"""
import os
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace

import cv2
import numpy as np
import torch
import yaml
from cog import BasePredictor, Input, Path
from PIL import Image

os.environ["TORCH_HOME"] = "/src/torch-cache"
sys.path[:0] = ["/src/rvm", "/src/zoedepth"]

from basicsr.archs.rrdbnet_arch import RRDBNet  # noqa: E402
from model import MattingNetwork  # noqa: E402  (RVM)
from realesrgan import RealESRGANer  # noqa: E402
from zoedepth.utils.misc import colorize  # noqa: E402

from vendor.diffusionclip.models.improved_ddpm.script_util import i_DDPM  # noqa: E402
from vendor.diffusionclip.utils.diffusion_utils import denoising_step, get_beta_schedule  # noqa: E402
from vendor.lineart import Generator  # noqa: E402

W = "/src/weights"
PANELS = ["matte", "portrait", "depth", "outline"]
T_0 = 601  # DiffusionCLIP's edit depth, as models/diffusionclip/run.py


def namespace(d):
    return SimpleNamespace(**{k: namespace(v) if isinstance(v, dict) else v for k, v in d.items()})


class Predictor(BasePredictor):
    def setup(self):
        self.device = torch.device("cuda")

        self.rvm = MattingNetwork("resnet50").eval().to(self.device)
        self.rvm.load_state_dict(torch.load(f"{W}/rvm_resnet50.pth", map_location="cpu"))

        with open("vendor/diffusionclip/configs/imagenet.yml") as f:
            self.dclip_config = namespace(yaml.safe_load(f))
        d = self.dclip_config.diffusion
        betas = get_beta_schedule(beta_start=d.beta_start, beta_end=d.beta_end, num_diffusion_timesteps=d.num_diffusion_timesteps)
        self.betas = torch.from_numpy(betas).float().to(self.device)
        self.logvar = np.log(np.maximum(betas, 1e-20))  # unused by DDIM at eta 0, but denoising_step takes it
        self.dclip = []  # [base ImageNet model, watercolour fine-tune]
        for path in [f"{W}/512x512_diffusion.pt", f"{W}/imagenet_watercolor_t601.pth"]:
            model = i_DDPM("IMAGENET")
            model.load_state_dict(torch.load(path, map_location="cpu"))
            self.dclip.append(model.to(self.device).eval())

        rrdb = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
        self.esrgan = RealESRGANer(scale=4, model_path=f"{W}/RealESRGAN_x4plus.pth", model=rrdb, tile=0, pre_pad=0, half=False, device=self.device)

        self.zoe = torch.hub.load("/src/zoedepth", "ZoeD_N", source="local", pretrained=True).to(self.device).eval()

        self.lineart = Generator()
        self.lineart.load_state_dict(torch.load(f"{W}/sk_model2.pth", map_location="cpu"))
        self.lineart.to(self.device).eval()

    def predict(
        self,
        video: Path = Input(description="The job's cropped square source video (0-source/video.mov)."),
        fps: int = Input(default=24, ge=1, le=60, description="Frame rate the per-frame panels run at."),
        panels: str = Input(default="matte,portrait,depth,outline", description="Comma-separated: matte, portrait, depth, outline."),
        start_frame: int = Input(default=1, ge=1, description="First frame (1-based) for the per-frame panels. A job can be split across several predictions by frame range, with only one of them asking for the matte, which always covers the whole clip."),
        max_frames: int = Input(default=0, ge=0, description="At most N frames from start_frame (0 = to the end)."),
        portrait_inv_steps: int = Input(default=40, ge=5, le=100, description="DiffusionCLIP inversion steps (40 as before)."),
        portrait_gen_steps: int = Input(default=12, ge=5, le=100, description="DiffusionCLIP generative steps (12 as before)."),
        portrait_fp16: bool = Input(default=False, description="Run DiffusionCLIP in half precision."),
        portrait_batch: int = Input(default=4, ge=1, le=16, description="Frames DiffusionCLIP edits at once."),
    ) -> Path:
        wanted = [p.strip() for p in panels.split(",") if p.strip()]
        unknown = set(wanted) - set(PANELS)
        if unknown:
            raise ValueError(f"Unknown panels: {', '.join(sorted(unknown))}")

        out = tempfile.mkdtemp()
        frames_dir = os.path.join(out, "0-source", "frames")
        os.makedirs(frames_dir)
        # The pipeline's own extraction (job.ts extractFrames), so these are the frames it would have sent.
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-r", str(fps), "-q:v", "2", os.path.join(frames_dir, "%04d.jpg")], check=True)
        frames = sorted(os.listdir(frames_dir))
        # Frame names keep their place in the whole clip (0061.jpg is still frame 61), so ranges merge back together.
        keep = frames[start_frame - 1 : start_frame - 1 + max_frames] if max_frames else frames[start_frame - 1 :]
        for extra in set(frames) - set(keep):
            os.remove(os.path.join(frames_dir, extra))
        paths = [os.path.join(frames_dir, f) for f in keep]

        if "matte" in wanted:
            # Always the whole clip, whatever the frame range: RVM carries state from frame to frame, and the
            # prediction that does the matte does it for every range of a split job. (It used to stop at the
            # range's end, which left a split job's later ranges with no matte.) RVM takes ~35s for 5s.
            self.matte(str(video), os.path.join(out, "4-matte", "raw.mp4"))
        if "portrait" in wanted:
            self.portrait(paths, out, portrait_inv_steps, portrait_gen_steps, portrait_fp16, portrait_batch)
        if "depth" in wanted:
            self.depth(paths, os.path.join(out, "5-depth", "raw"))
        if "outline" in wanted:
            self.outline(paths, os.path.join(out, "6-outline", "raw"))

        tar_path = Path(tempfile.mkdtemp()) / "panels.tar"
        with tarfile.open(tar_path, "w") as tar:
            for name in sorted(os.listdir(out)):
                tar.add(os.path.join(out, name), arcname=name)
        return tar_path

    def matte(self, video, out_path):
        """RVM over the whole video, as arielreplicate's wrapper: resnet50, automatic downsample ratio, 12-frame chunks."""
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video], capture_output=True, text=True, check=True).stdout.strip()
        w, h = (int(v) for v in probe.split(",")[:2])
        rate = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video], capture_output=True, text=True, check=True).stdout.strip()
        reader = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        writer = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", rate, "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", out_path],
            stdin=subprocess.PIPE,
        )
        downsample = min(512 / max(w, h), 1)  # RVM's auto_downsample_ratio
        rec = [None] * 4
        size = w * h * 3
        with torch.no_grad():
            while True:
                chunk = []
                for _ in range(12):
                    buf = reader.stdout.read(size)
                    if len(buf) < size:
                        break
                    chunk.append(np.frombuffer(buf, np.uint8).reshape(h, w, 3))
                if not chunk:
                    break
                src = torch.from_numpy(np.stack(chunk)).to(self.device).permute(0, 3, 1, 2).float().div(255).unsqueeze(0)
                _, pha, *rec = self.rvm(src, *rec, downsample)
                writer.stdin.write(pha[0, :, 0].mul(255).byte().cpu().numpy().tobytes())
        reader.wait()
        writer.stdin.close()
        if writer.wait() != 0:
            raise RuntimeError("Encoding the matte failed")

    def portrait(self, paths, out, inv_steps, gen_steps, fp16, batch):
        """DiffusionCLIP's edit (as models/diffusionclip/run.py), then Real-ESRGAN 2x, as the pipeline's portrait and upscale steps."""
        raw_dir = os.path.join(out, "2-portrait", "raw")
        up_dir = os.path.join(out, "2-portrait", "upscaled")
        os.makedirs(raw_dir)
        os.makedirs(up_dir)
        size = self.dclip_config.data.image_size
        seq_inv = [int(s) for s in np.linspace(0, 1, inv_steps) * T_0]
        seq_gen = [int(s) for s in np.linspace(0, 1, gen_steps) * T_0]
        for start in range(0, len(paths), batch):
            group = paths[start : start + batch]
            imgs = [np.array(Image.open(p).convert("RGB").resize((size, size), Image.ANTIALIAS)) / 255 for p in group]
            x0 = (torch.from_numpy(np.stack(imgs)).float().permute(0, 3, 1, 2).to(self.device) - 0.5) * 2.0
            with torch.no_grad():
                x = self.ddim(x0, seq_inv, ratio=0.0, fp16=fp16, inverse=True)
                x = self.ddim(x, seq_gen, ratio=1.0, fp16=fp16, inverse=False)
            # tvu.save_image's rounding, as the single-image model wrote its PNGs; the pipeline then saved them as JPEG 90.
            pixels = ((x + 1) * 0.5).mul(255).add(0.5).clamp(0, 255).permute(0, 2, 3, 1).to(torch.uint8).cpu().numpy()
            for p, rgb in zip(group, pixels):
                name = os.path.basename(p)
                Image.fromarray(rgb).save(os.path.join(raw_dir, name), quality=90)
                upscaled, _ = self.esrgan.enhance(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), outscale=2)
                Image.fromarray(cv2.cvtColor(upscaled, cv2.COLOR_BGR2RGB)).save(os.path.join(up_dir, name), quality=90)

    def ddim(self, x, seq, ratio, fp16, inverse):
        seq_next = [-1] + list(seq[:-1])
        pairs = zip(seq_next[1:], seq[1:]) if inverse else zip(reversed(seq), reversed(seq_next))
        n = x.shape[0]
        for i, j in pairs:
            t = (torch.ones(n) * i).to(self.device)
            t_next = (torch.ones(n) * j).to(self.device)
            with torch.autocast("cuda", dtype=torch.float16, enabled=fp16):
                x = denoising_step(x, t=t, t_next=t_next, models=self.dclip, logvars=self.logvar, sampling_type="ddim", b=self.betas, eta=0.0, learn_sigma=True, ratio=ratio)
            x = x.float()
        return x

    def depth(self, paths, out_dir):
        """ZoeD_N on the 1024px frame, colourised (cjwbw/zoedepth). The pipeline sent an RGBA composite, but the wrapper
        converted it to RGB, so the model only ever saw the frame itself."""
        os.makedirs(out_dir)
        for p in paths:
            image = Image.open(p).convert("RGB").resize((1024, 1024), Image.LANCZOS)
            with torch.no_grad():
                depth = self.zoe.infer_pil(image, output_type="tensor")
            Image.fromarray(colorize(depth)).save(os.path.join(out_dir, os.path.basename(p).replace(".jpg", ".png")))

    def outline(self, paths, out_dir):
        """models/lineart's defaults (cleanup on, floor 50, gain 1.3, 1024px), without the mask: the pipeline masks it
        with its repaired matte."""
        os.makedirs(out_dir)
        floor, gain = 50, 1.3
        for p in paths:
            rgb = np.asarray(Image.open(p).convert("RGB").resize((1024, 1024), Image.LANCZOS))
            rgb = cv2.edgePreservingFilter(rgb, flags=1, sigma_s=15, sigma_r=0.12)
            with torch.no_grad():
                x = torch.from_numpy(rgb).float().div(255).permute(2, 0, 1)[None].to(self.device)
                line = self.lineart(x)[0][0].cpu().numpy()
            ink = 255.0 - (line * 255.0).clip(0, 255).astype(np.uint8)
            ink = np.clip((ink - floor) / (255 - floor) * 255 * gain, 0, 255)
            Image.fromarray((255 - ink).astype(np.uint8)).save(os.path.join(out_dir, os.path.basename(p)), quality=90)
