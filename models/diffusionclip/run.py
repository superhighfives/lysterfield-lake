import os
import tempfile
import warnings

import numpy as np
import torch
import torchvision.utils as tvu
import yaml
from PIL import Image

warnings.filterwarnings(action="ignore")
from cog import BaseRunner, Path, Input

from configs.paths_config import MODEL_PATHS
from main import dict2namespace
from models.improved_ddpm.script_util import i_DDPM
from utils.diffusion_utils import get_beta_schedule, denoising_step

MODEL_PATH = "checkpoint/imagenet_watercolor_t601.pth"
T_0 = 601


class Runner(BaseRunner):
    """
    The same edit as DiffusionCLIP's edit_one_image (deterministic DDIM inversion through the base ImageNet
    model, then generation through the watercolour fine-tune), with the per-frame overhead taken out:

    - Both checkpoints are loaded onto the GPU once, in setup, instead of from disk on every prediction
      (edit_one_image rebuilt both multi-GB models each call).
    - `fp16` runs the U-Net under autocast, using the GPU's tensor cores.
    - `n_inv_step` (was fixed at 40) trades inversion accuracy for speed.

    With fp16 off and n_inv_step at 40 the output matches the previous version's.
    """

    def setup(self):
        with open(os.path.join("configs", "imagenet.yml"), "r") as f:
            self.config = dict2namespace(yaml.safe_load(f))
        self.device = torch.device("cuda:0")
        self.config.device = self.device

        betas = get_beta_schedule(
            beta_start=self.config.diffusion.beta_start,
            beta_end=self.config.diffusion.beta_end,
            num_diffusion_timesteps=self.config.diffusion.num_diffusion_timesteps,
        )
        self.betas = torch.from_numpy(betas).float().to(self.device)
        # Unused by DDIM with learned sigma, but denoising_step takes it.
        self.logvar = np.log(np.maximum(betas, 1e-20))

        # [base, fine-tune], as edit_one_image's model_paths = [None, MODEL_PATH].
        self.models = []
        for path in [MODEL_PATHS["IMAGENET"], MODEL_PATH]:
            model = i_DDPM("IMAGENET")
            model.load_state_dict(torch.load(path, map_location="cpu"))
            model.to(self.device).eval()
            self.models.append(model)

    def _steps(self, x, seq, ratio, fp16, inverse):
        seq_next = [-1] + list(seq[:-1])
        pairs = zip(seq_next[1:], seq[1:]) if inverse else zip(reversed(seq), reversed(seq_next))
        n = x.shape[0]
        for i, j in pairs:
            t = (torch.ones(n) * i).to(self.device)
            t_next = (torch.ones(n) * j).to(self.device)
            with torch.autocast("cuda", dtype=torch.float16, enabled=fp16):
                x = denoising_step(
                    x,
                    t=t,
                    t_next=t_next,
                    models=self.models,
                    logvars=self.logvar,
                    sampling_type="ddim",
                    b=self.betas,
                    eta=0.0,
                    learn_sigma=True,
                    ratio=ratio,
                )
            x = x.float()
        return x

    def run(
        self,
        image: Path = Input(description="Input image."),
        degree_of_change: float = Input(default=1.0, ge=0.0, le=1.0),
        n_test_step: int = Input(default=12, ge=5, le=100),
        n_inv_step: int = Input(default=40, ge=5, le=100, description="DDIM inversion steps (was fixed at 40)."),
        fp16: bool = Input(default=False, description="Run the U-Net in half precision: faster, very slightly different output."),
    ) -> Path:
        size = self.config.data.image_size
        img = Image.open(str(image)).convert("RGB").resize((size, size), Image.ANTIALIAS)
        img = torch.from_numpy(np.array(img) / 255).float().permute(2, 0, 1).unsqueeze(0).to(self.device)
        x0 = (img - 0.5) * 2.0

        with torch.no_grad():
            seq_inv = [int(s) for s in np.linspace(0, 1, n_inv_step) * T_0]
            x_lat = self._steps(x0.clone(), seq_inv, ratio=0.0, fp16=fp16, inverse=True)
            seq_test = [int(s) for s in np.linspace(0, 1, n_test_step) * T_0]
            x = self._steps(x_lat, seq_test, ratio=degree_of_change, fp16=fp16, inverse=False)

        out_path = Path(tempfile.mkdtemp()) / "output.png"
        tvu.save_image((x + 1) * 0.5, str(out_path))
        return out_path
