"""Panel 6 (outline): coarse line art of the subject, chosen over ArtLine in the
outline bake-off (see plans/done/phase-4g-outline-coarse-lineart.md).

The line model is the "coarse" sketch generator from ControlNet's annotators
(lllyasviel/Annotators sk_model2.pth), vendored from controlnet_aux 0.0.10's
lineart detector (Apache-2.0) so the image only needs torch, OpenCV and Pillow.

"cleanup" (the default) is the version picked in the bake-off: light
edge-preserving smoothing before the line pass flattens skin texture and
stubble without losing real edges, and faint strokes are dropped afterwards.
Without it you get the plain coarse line art (the runner-up).
"""

import cv2
import numpy as np
import torch
import torch.nn as nn
from cog import BasePredictor, Input, Path
from PIL import Image, ImageFilter


class ResidualBlock(nn.Module):
    def __init__(self, features):
        super().__init__()
        self.conv_block = nn.Sequential(
            nn.ReflectionPad2d(1),
            nn.Conv2d(features, features, 3),
            nn.InstanceNorm2d(features),
            nn.ReLU(inplace=True),
            nn.ReflectionPad2d(1),
            nn.Conv2d(features, features, 3),
            nn.InstanceNorm2d(features),
        )

    def forward(self, x):
        return x + self.conv_block(x)


class Generator(nn.Module):
    def __init__(self, input_nc=3, output_nc=1, n_residual_blocks=3):
        super().__init__()
        self.model0 = nn.Sequential(
            nn.ReflectionPad2d(3), nn.Conv2d(input_nc, 64, 7), nn.InstanceNorm2d(64), nn.ReLU(inplace=True)
        )
        model1, features = [], 64
        for _ in range(2):
            model1 += [nn.Conv2d(features, features * 2, 3, stride=2, padding=1), nn.InstanceNorm2d(features * 2), nn.ReLU(inplace=True)]
            features *= 2
        self.model1 = nn.Sequential(*model1)
        self.model2 = nn.Sequential(*[ResidualBlock(features) for _ in range(n_residual_blocks)])
        model3 = []
        for _ in range(2):
            model3 += [
                nn.ConvTranspose2d(features, features // 2, 3, stride=2, padding=1, output_padding=1),
                nn.InstanceNorm2d(features // 2),
                nn.ReLU(inplace=True),
            ]
            features //= 2
        self.model3 = nn.Sequential(*model3)
        self.model4 = nn.Sequential(nn.ReflectionPad2d(3), nn.Conv2d(64, output_nc, 7), nn.Sigmoid())

    def forward(self, x):
        return self.model4(self.model3(self.model2(self.model1(self.model0(x)))))


class Predictor(BasePredictor):
    def setup(self):
        self.model = Generator()
        self.model.load_state_dict(torch.load("sk_model2.pth", map_location="cpu"))
        self.model.eval()

    def ink(self, rgb: np.ndarray) -> np.ndarray:
        """Line strength 0-255 (255 = solid line) for a square RGB uint8 image."""
        with torch.no_grad():
            x = torch.from_numpy(rgb).float().div(255).permute(2, 0, 1)[None]
            line = self.model(x)[0][0].numpy()
        return 255.0 - (line * 255.0).clip(0, 255).astype(np.uint8)

    def predict(
        self,
        image: Path = Input(description="Source frame (the raw photo, not a stylised panel)"),
        mask: Path = Input(description="Subject matte (white = subject). Lines outside it are removed.", default=None),
        cleanup: bool = Input(description="Smooth skin texture first and drop faint strokes (the bake-off pick)", default=True),
        floor: int = Input(description="Cleanup: line strength below this is dropped", default=50, ge=0, le=254),
        gain: float = Input(description="Cleanup: boost for the remaining lines", default=1.3, ge=0.1, le=4.0),
        smooth_sigma_s: float = Input(description="Cleanup: edge-preserving filter spatial size", default=15, ge=1, le=200),
        smooth_sigma_r: float = Input(description="Cleanup: edge-preserving filter range (higher smooths more)", default=0.12, ge=0.01, le=1.0),
        size: int = Input(description="Working and output resolution (square)", default=1024, ge=256, le=2048),
    ) -> Path:
        size = size // 64 * 64
        rgb = np.asarray(Image.open(image).convert("RGB").resize((size, size), Image.LANCZOS))

        if cleanup:
            rgb = cv2.edgePreservingFilter(rgb, flags=1, sigma_s=smooth_sigma_s, sigma_r=smooth_sigma_r)
        ink = self.ink(rgb)
        if cleanup:
            ink = np.clip((ink - floor) / (255 - floor) * 255 * gain, 0, 255)

        if mask is not None:
            # A few px of dilation keeps the silhouette's own edge line.
            alpha = Image.open(mask).convert("L").resize((size, size), Image.LANCZOS).filter(ImageFilter.MaxFilter(9))
            ink = ink * (np.asarray(alpha, dtype=np.float64) / 255)

        out = Path("/tmp/out.jpg")
        Image.fromarray((255 - ink).astype(np.uint8)).save(out, quality=90)
        return out
