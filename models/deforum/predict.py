"""Panel 7 (dream): Deforum 0.7.1 the way the ten published dreams were made.

Deforum (deforum/, fetched by fetch.sh at the pinned 0.7.1 commit) with the
legacy PC's render.py (legacy/: custom Random/Specific/Sticky colour modes).
Every setting starts from a legacy dream's saved settings (settings/<id>.json,
default lush-and-light), then the take's inputs are applied on top: prompt,
negative prompt, the panel 2 init video and matte mask video, the colour
reference, seed and frame count. See plans/done/own-deforum-dream-model.md.

Output: a zip of the rendered frames (<timestring>_NNNNN.png, one per
extracted init frame) plus settings.json with exactly what was run and
scores.json, each frame's person score.

Panel 7 must never show a person, and Deforum draws one into a few percent of
frames whatever the negative prompt says. So each frame is scored as it is
made (person_score, the same classifier as the pipeline's dream-check), and
one that fails is rendered again before it is saved or fed forward into the
next frame: what was done by hand in 2023, deleting bad frames and rebuilding.

A long take is rendered as a chain of runs. Each frame grows out of the one
before it, so a run can continue another: pass the earlier run's last frame as
previous_frame, with an init video that starts on that same frame.
"""

import gc
import json
import os
import random
import shutil
import subprocess
import sys
import time
import zipfile
from types import SimpleNamespace
from typing import Optional

from cog import BasePredictor, Input, Path

HERE = os.path.dirname(os.path.abspath(__file__))
DEFORUM = os.path.join(HERE, "deforum")
SETTINGS = os.path.join(HERE, "settings")
COLOURS = "/tmp/colours"
os.environ["DEFORUM_COLOURS_DIR"] = COLOURS + "/"

WEIGHTS = {
    "diffusion_models_cache/Protogen_V2.2.ckpt": "https://huggingface.co/darkstorm2150/Protogen_v2.2_Official_Release/resolve/main/Protogen_V2.2.ckpt",
    "models/dpt_large-midas-2f21e586.pt": "https://huggingface.co/deforum/MiDaS/resolve/main/dpt_large-midas-2f21e586.pt",
    "models/AdaBins_nyu.pt": "https://huggingface.co/deforum/AdaBins/resolve/main/AdaBins_nyu.pt",
}

with open(os.path.join(SETTINGS, "negative-prompt.txt")) as f:
    LEGACY_NEGATIVE_PROMPT = f.read().strip()

# The person classifier's weights (models/person-check/probe.json, copied in by fetch.sh).
with open(os.path.join(HERE, "probe.json")) as f:
    PROBE = json.load(f)
# How much less of the previous frame each retry keeps (Deforum's strength), on top of a new seed.
# The first retry only changes the seed; later ones repaint more, since the same init tends to
# lead back to the same person.
RETRY_STRENGTH_STEP = 0.15

# Settings that describe the legacy PC's files and session rather than the look; never taken from a preset.
NOT_FROM_PRESET = {
    "video_init_path", "video_mask_path", "outdir", "timestring", "init_image", "mask_file", "batch_name",
    "colormatch_image", "init_mse_image", "resume_from_timestring", "resume_timestring", "max_frames",
    "cond_prompts", "uncond_prompts", "cond_prompt", "uncond_prompt", "prompts", "models_path",
    "output_path", "seed_internal", "init_latent", "init_sample", "init_sample_raw", "mask_sample", "init_c",
    "save_settings", "save_samples", "display_samples", "show_sample_per_step", "save_sample_per_step",
    "overwrite_extracted_frames", "specific_image",
}


class Predictor(BasePredictor):
    def setup(self):
        os.chdir(DEFORUM)
        sys.path[:0] = [DEFORUM, os.path.join(DEFORUM, "src")]
        for rel, url in WEIGHTS.items():
            if not os.path.exists(rel):
                os.makedirs(os.path.dirname(rel), exist_ok=True)
                subprocess.check_call(["pget", url, rel])

        import torch
        from omegaconf import OmegaConf

        self.torch = torch
        self.device = torch.device("cuda")
        config = OmegaConf.load("configs/v1-inference.yaml")
        self.model = load_model_from_config(config, "diffusion_models_cache/Protogen_V2.2.ckpt")
        self.model.to(self.device)

        # The legacy settings use CLIP and aesthetics guidance (clip_scale/aesthetics_scale 50), which
        # need CLIP loaded; ViT-L/14 (the legacy clip_name) is loaded once here.
        import clip

        self.clip_models = {"ViT-L/14": clip.load("ViT-L/14", jit=False)[0].eval().requires_grad_(False).to(self.device)}

    def predict(
        self,
        init_video: Path = Input(description="Panel 2 (painted portrait) as a video: the shape the dream grows from"),
        mask_video: Optional[Path] = Input(description="The subject matte as a video (white = subject)", default=None),
        prompt: str = Input(description="Landscape-only prompt; never describe the person"),
        negative_prompt: str = Input(description="Extra negative prompt, added to the legacy dreams' own (no people, faces, bodies...), which always applies", default=""),
        colour_image: Optional[Path] = Input(description="Colour reference: every frame's palette is matched to it (legacy 'Specific' mode)", default=None),
        colour_mode: str = Input(
            description="Specific = match colour_image; Sticky = match the first frame; others are Deforum's own",
            choices=["Specific", "Sticky", "Match Frame 0 LAB", "Match Frame 0 HSV", "Match Frame 0 RGB", "Video Input", "None"],
            default="Specific",
        ),
        preset: str = Input(
            description="Legacy dream whose settings to start from",
            choices=["charcoal", "clouds-of-air", "dirty-palette", "ghiblis-dream", "horizon-storm", "ink-flight", "lush-and-light", "mood-lighting", "paper-planes", "watercolour"],
            default="lush-and-light",
        ),
        settings_overrides: str = Input(description="JSON object of Deforum setting overrides, applied after the preset", default="{}"),
        extract_nth_frame: int = Input(description="Use every Nth init frame (legacy: 6 on a 60fps init = 10 dream frames/s)", default=6, ge=1),
        max_frames: int = Input(description="Dream frames to render (capped by the init video's length)", default=60, ge=1, le=3000),
        seed: Optional[int] = Input(description="Default: the preset's seed", default=None),
        previous_frame: Optional[Path] = Input(
            description="Continue an earlier run: its last rendered frame. The init and mask videos must start on that frame's source frame; it is not rendered again or returned",
            default=None,
        ),
        max_rerolls: int = Input(description="Times a frame that shows a person is rendered again (new seed, then repainting more) before the best attempt is kept and flagged. 0 only scores", default=2, ge=0, le=4),
        person_threshold: float = Input(description="Person score above which a frame is rendered again", default=0.35, ge=0, le=1),
    ) -> Path:
        torch = self.torch
        from helpers.model_load import make_linear_decode
        from helpers.prompts import Prompts
        from helpers.render import render_animation

        # Upstream 0.7.1's predict.py defaults, then the preset, then this take's inputs.
        args = upstream_args()
        anim = upstream_anim_args()
        with open(os.path.join(SETTINGS, f"{preset}.json")) as f:
            for key, value in json.load(f).items():
                if key in NOT_FROM_PRESET:
                    continue
                if key in anim:
                    anim[key] = value
                elif key in args:
                    args[key] = value
                else:  # legacy-only keys: render.py may read them from either namespace
                    anim[key] = args[key] = value
        for key, value in json.loads(settings_overrides).items():
            if key in NOT_FROM_PRESET:  # prompts and paths come from this run's inputs only
                continue
            (anim if key in anim else args)[key] = value

        # Deforum fails if asked for more frames than it extracts from the init video.
        init_frames = int(subprocess.check_output([
            "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
            "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(init_video),
        ]).decode().strip())
        available = -(-init_frames // extract_nth_frame)
        anim.update(
            animation_mode=anim.get("animation_mode") or "3D",
            max_frames=min(max_frames, available),
            video_init_path=str(init_video),
            extract_nth_frame=extract_nth_frame,
            overwrite_extracted_frames=True,
            use_mask_video=mask_video is not None,
            video_mask_path=str(mask_video) if mask_video else "",
            color_coherence=colour_mode,
            resume_from_timestring=False,
            resume_timestring="",
        )
        if seed is not None:
            args["seed"] = seed
        if args.get("seed") in (None, -1):
            args["seed"] = random.randint(0, 2**32 - 1)

        shutil.rmtree(COLOURS, ignore_errors=True)
        os.makedirs(COLOURS)
        if colour_mode == "Specific":
            if colour_image is None:
                raise ValueError("colour_mode Specific needs a colour_image")
            ext = os.path.splitext(str(colour_image))[1] or ".png"
            shutil.copy(str(colour_image), os.path.join(COLOURS, f"reference{ext}"))
            args["specific_image"] = f"reference{ext}"

        outdir = "/tmp/deforum-out"
        shutil.rmtree(outdir, ignore_errors=True)
        os.makedirs(outdir)
        args.update(outdir=outdir, timestring=time.strftime("%Y%m%d%H%M%S"), save_settings=False, save_samples=True)
        if previous_frame is not None:
            # A continued run restarts Deforum's frame count at 0, which is only the same as one long
            # run when nothing is keyframed over time. True of every legacy preset; refuse otherwise.
            keyframed = [k for k, v in anim.items() if is_keyframed(v) and (k != "sampler_schedule" or anim.get("enable_schedule_samplers"))]
            if keyframed:
                raise ValueError(f"previous_frame can't continue a run with keyframed settings: {', '.join(keyframed)}")
            if colour_mode in ("Sticky", "Match Frame 0 LAB", "Match Frame 0 HSV", "Match Frame 0 RGB"):
                raise ValueError(f"previous_frame can't continue a run with colour_mode {colour_mode}: it matches the take's first frame, which this run doesn't have")
            # Deforum's own resume: it counts this timestring's files (frames plus the settings file),
            # loads the last frame as the previous sample and carries on from the next one.
            from PIL import Image

            Image.open(str(previous_frame)).convert("RGB").resize((args["W"], args["H"]), Image.LANCZOS).save(os.path.join(outdir, f"{args['timestring']}_00000.png"))
            open(os.path.join(outdir, f"{args['timestring']}_settings.txt"), "w").close()
            anim.update(resume_from_timestring=True, resume_timestring=args["timestring"])
        args["strength"] = max(0.0, min(1.0, args.get("strength", 0.65)))
        if args.get("sampler") != "ddim":
            args["ddim_eta"] = 0

        root = SimpleNamespace(device="cuda", models_path="models", configs_path="configs", model=self.model)
        root.model.linear_decode = make_linear_decode("sd-v1", self.device)
        ns_args, ns_anim = SimpleNamespace(**args), SimpleNamespace(**anim)
        if ns_args.clip_scale > 0 or ns_args.aesthetics_scale > 0:
            if ns_args.clip_name not in self.clip_models:
                import clip

                self.clip_models[ns_args.clip_name] = clip.load(ns_args.clip_name, jit=False)[0].eval().requires_grad_(False).to(self.device)
            root.clip_model = self.clip_models[ns_args.clip_name]
            if ns_args.aesthetics_scale > 0:
                from helpers.aesthetics import load_aesthetics_model

                root.aesthetics_model = load_aesthetics_model(ns_args, root)

        gc.collect()
        torch.cuda.empty_cache()
        # Panel 7 must never show a person (CLAUDE.md). The legacy negative prompt is what excludes
        # people, so it is always applied; a take's own negative prompt is added to it, never instead.
        extra = negative_prompt.strip()
        negative_prompt = f"{LEGACY_NEGATIVE_PROMPT}, {extra}" if extra else LEGACY_NEGATIVE_PROMPT
        cond, uncond = Prompts(prompt={0: prompt}, neg_prompt=negative_prompt).as_dict()

        # Score every frame as Deforum makes it, and make it again if it shows a person. render.py
        # calls generate() once per frame and feeds what it returns into the next one, so wrapping
        # generate() is enough: a rejected attempt is never saved and never fed forward.
        import helpers.render as render

        scores = {}
        generate = render.generate
        # A run that doesn't continue another paints frame 0 from the prompt alone; it is never used.
        unused_frame = None if previous_frame is not None else 0

        # The seed that last got a frame through. A stretch where the subject keeps coming through as a
        # person fails on the same seed frame after frame, so the seed that worked is kept for the
        # frames after it rather than paying for the same retry each time.
        working_seed = None

        def checked_generate(gen_args, gen_root, frame_idx=0, **kwargs):
            nonlocal working_seed
            seed, strength = gen_args.seed, gen_args.strength
            if frame_idx == unused_frame:
                return generate(gen_args, gen_root, frame_idx, **kwargs)
            first_seed = seed if working_seed is None else working_seed
            gen_args.seed = first_seed
            best = generate(gen_args, gen_root, frame_idx, **kwargs)
            attempts = [self.person_score(best[-1])]
            while min(attempts) > person_threshold and len(attempts) <= max_rerolls:
                gen_args.seed = (first_seed + 7919 * len(attempts)) % 2**32
                gen_args.strength = max(0.0, strength - RETRY_STRENGTH_STEP * (len(attempts) - 1))
                again = generate(gen_args, gen_root, frame_idx, **kwargs)
                attempts.append(self.person_score(again[-1]))
                if attempts[-1] == min(attempts):
                    best = again
                    if attempts[-1] <= person_threshold:
                        working_seed = gen_args.seed
                print(f"Frame {frame_idx}: person scores {attempts}")
            gen_args.seed, gen_args.strength = seed, strength
            scores[f"{gen_args.timestring}_{frame_idx:05}.png"] = {
                "score": round(min(attempts), 5),
                "attempts": [round(a, 5) for a in attempts],
                "flagged": min(attempts) > person_threshold,
            }
            return best

        render.generate = checked_generate
        try:
            render_animation(root, ns_anim, ns_args, cond, uncond)
        finally:
            render.generate = generate

        frames = sorted(f for f in os.listdir(outdir) if f.startswith(ns_args.timestring) and f.endswith(".png"))
        if previous_frame is not None:
            frames = frames[1:]  # frame 0 is the previous run's frame, handed in
        if not frames:
            raise RuntimeError("Deforum produced no frames")
        used = {
            "preset": preset, "prompt": prompt, "negative_prompt": negative_prompt, "colour_mode": colour_mode,
            "continued": previous_frame is not None,
            "args": {k: v for k, v in args.items() if is_json(v)}, "anim_args": {k: v for k, v in anim.items() if is_json(v)},
            "frames": len(frames),
            "max_rerolls": max_rerolls, "person_threshold": person_threshold,
        }
        out = "/tmp/frames.zip"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
            for f in frames:
                z.write(os.path.join(outdir, f), f)
            z.writestr("settings.json", json.dumps(used, indent=2))
            z.writestr("scores.json", json.dumps({f: scores[f] for f in frames if f in scores}, indent=2))
        return Path(out)

    def person_score(self, image):
        """0..1: how sure the classifier is that a frame (a PIL image) shows a person. The same score as models/person-check/check.py, which this must stay in step with."""
        import numpy as np
        from PIL import Image

        torch = self.torch
        clip_model = self.clip_models["ViT-L/14"]
        size = 448
        pixels = np.asarray(image.convert("RGB").resize((size, size), Image.BICUBIC))
        x = torch.from_numpy(pixels.copy()).to(self.device).permute(2, 0, 1).unsqueeze(0).float() / 255
        full = torch.nn.functional.interpolate(x, size=224, mode="bicubic", antialias=True).clamp(0, 1)
        centre = x[:, :, size // 4 : size // 4 + 224, size // 4 : size // 4 + 224]
        mean = torch.tensor((0.48145466, 0.4578275, 0.40821073), device=self.device).view(1, 3, 1, 1)
        std = torch.tensor((0.26862954, 0.26130258, 0.27577711), device=self.device).view(1, 3, 1, 1)
        with torch.no_grad():
            embedded = [
                torch.nn.functional.normalize(clip_model.encode_image(((view - mean) / std).to(clip_model.dtype)).float(), dim=-1)
                for view in (full, centre)
            ]
            coef = torch.tensor(PROBE["coef"], device=self.device)
            return float(torch.sigmoid(torch.cat(embedded, dim=1) @ coef + PROBE["intercept"]))


def load_model_from_config(config, ckpt):
    """upstream 0.7.1 predict.py's loader (half precision on CUDA). Inlined: Cog imports this file as `predict`, so upstream's can't be imported by that name."""
    import torch
    from ldm.util import instantiate_from_config

    pl_sd = torch.load(ckpt, map_location="cuda")
    sd = pl_sd.get("state_dict", pl_sd)
    torch.set_default_dtype(torch.float16)
    model = instantiate_from_config(config.model)
    torch.set_default_dtype(torch.float32)
    model.load_state_dict(sd, strict=False)
    model = model.half().to("cuda")
    model.eval()
    return model


def is_keyframed(value):
    """True for a Deforum schedule string with more than one key, e.g. "0:(1), 30:(2)"."""
    return isinstance(value, str) and len([part for part in value.split(",") if ":" in part]) > 1


def is_json(value):
    try:
        json.dumps(value)
        return True
    except TypeError:
        return False


def upstream_args():
    """upstream 0.7.1 predict.py's args_dict defaults (per-input values are set from the preset)."""
    return {
        "W": 1024, "H": 1024, "bit_depth_output": 8, "seed": None, "sampler": "euler_ancestral", "steps": 50, "scale": 7,
        "ddim_eta": 0.0, "dynamic_threshold": None, "static_threshold": None, "save_samples": True, "save_settings": False,
        "display_samples": False, "save_sample_per_step": False, "show_sample_per_step": False, "prompt_weighting": True,
        "normalize_prompt_weights": True, "log_weighted_subprompts": False, "n_batch": 1, "batch_name": "dream",
        "filename_format": "{timestring}_{index}_{prompt}.png", "seed_behavior": "fixed", "seed_iter_N": 1,
        "make_grid": False, "grid_rows": 2, "outdir": "", "use_init": False, "strength": 0.65, "strength_0_no_init": True,
        "init_image": None, "use_mask": False, "use_alpha_as_mask": False, "mask_file": "", "invert_mask": False,
        "mask_brightness_adjust": 1.0, "mask_contrast_adjust": 1.0, "overlay_mask": True, "mask_overlay_blur": 5,
        "mean_scale": 0, "var_scale": 0, "exposure_scale": 0, "exposure_target": 0.5, "colormatch_scale": 0,
        "colormatch_image": "", "colormatch_n_colors": 4, "ignore_sat_weight": 0, "clip_name": "ViT-L/14",
        "clip_scale": 0, "aesthetics_scale": 0, "cutn": 1, "cut_pow": 0.0001, "init_mse_scale": 0, "init_mse_image": "",
        "blue_scale": 0, "gradient_wrt": "x0_pred", "gradient_add_to": "both", "decode_method": "linear",
        "grad_threshold_type": "dynamic", "clamp_grad_threshold": 0.2, "clamp_start": 0.2, "clamp_stop": 0.01,
        "grad_inject_timing": [1, 2, 3, 4, 5, 6, 7, 8, 9], "cond_uncond_sync": True, "n_samples": 1,
        "precision": "autocast", "C": 4, "f": 8, "prompt": "", "timestring": "", "init_latent": None,
        "init_sample": None, "init_sample_raw": None, "mask_sample": None, "init_c": None, "seed_internal": 0,
    }


def upstream_anim_args():
    """upstream 0.7.1 predict.py's anim_args_dict keys and defaults (the preset fills in the legacy values)."""
    return {
        "animation_mode": "3D", "max_frames": 60, "border": "replicate", "angle": "0:(0)", "zoom": "0:(1.0)",
        "translation_x": "0:(0)", "translation_y": "0:(0)", "translation_z": "0:(0)", "rotation_3d_x": "0:(0)",
        "rotation_3d_y": "0:(0)", "rotation_3d_z": "0:(0)", "flip_2d_perspective": False,
        "perspective_flip_theta": "0:(0)", "perspective_flip_phi": "0:(0)", "perspective_flip_gamma": "0:(0)",
        "perspective_flip_fv": "0:(53)", "noise_schedule": "0: (0.04)", "strength_schedule": "0: (0.5)",
        "contrast_schedule": "0: (1.0)", "hybrid_comp_alpha_schedule": "0:(1.0)",
        "hybrid_comp_mask_blend_alpha_schedule": "0:(0.65)", "hybrid_comp_mask_contrast_schedule": "0:(1)",
        "hybrid_comp_mask_auto_contrast_cutoff_high_schedule": "0:(100)",
        "hybrid_comp_mask_auto_contrast_cutoff_low_schedule": "0:(0)", "enable_schedule_samplers": False,
        "sampler_schedule": "0:('euler')", "kernel_schedule": "0: (5)", "sigma_schedule": "0: (1.0)",
        "amount_schedule": "0: (0.2)", "threshold_schedule": "0: (0.0)", "color_coherence": "Specific",
        "color_coherence_video_every_N_frames": 1, "color_force_grayscale": False, "diffusion_cadence": "1",
        "use_depth_warping": True, "midas_weight": 0.3, "near_plane": 200, "far_plane": 10000, "fov": 40,
        "padding_mode": "reflection", "sampling_mode": "bicubic", "save_depth_maps": False, "video_init_path": "",
        "extract_nth_frame": 6, "overwrite_extracted_frames": True, "use_mask_video": True, "video_mask_path": "",
        "hybrid_generate_inputframes": True, "hybrid_use_first_frame_as_init_image": False,
        "hybrid_motion": "Perspective", "hybrid_flow_method": "DIS Medium", "hybrid_composite": True,
        "hybrid_comp_mask_type": "None", "hybrid_comp_mask_inverse": False, "hybrid_comp_mask_equalize": "None",
        "hybrid_comp_mask_auto_contrast": True, "hybrid_comp_save_extra_frames": False,
        "hybrid_use_video_as_mse_image": False, "interpolate_key_frames": False, "interpolate_x_frames": 4,
        "resume_from_timestring": False, "resume_timestring": "",
    }
