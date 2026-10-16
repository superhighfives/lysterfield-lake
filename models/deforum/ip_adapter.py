"""IP-Adapter for Deforum 0.7.1: steer every frame towards a style reference image.

The colour reference only matches each frame's palette to an image. IP-Adapter
(Tencent AI Lab, https://github.com/tencent-ailab/IP-Adapter) carries over its
look and imagery too: the reference is encoded by CLIP ViT-H/14, projected to
four extra "image tokens", and every cross-attention layer of the UNet attends
to those tokens beside the prompt's text tokens, through its own small key and
value layers. Its SD 1.5 weights work with SD 1.5 fine-tunes such as Protogen.

Deforum 0.7.1 predates IP-Adapter and uses the original ldm UNet rather than
diffusers, so this ports the decoupled cross-attention onto ldm's attention
modules: each cross-attention layer's forward is wrapped to add

    to_out(attention(q, k_ip, v_ip)) * scale

to its usual output. to_out is linear, so adding the image attention after it
(without its bias) is the same as adding it before, which is how IP-Adapter
combines the two; the ldm code stays as it is.

IP-Adapter's weights are keyed by diffusers' attention processor order: every
transformer block's self-attention then cross-attention, through the down
blocks, the up blocks, then the middle block. ldm's input, output and middle
blocks are walked in that same order, and each layer's shape is checked against
its weights, so a mapping mistake fails loudly rather than drawing nonsense.
"""

import torch
from einops import rearrange

# Set by predict.py for a run with a style image, cleared otherwise. Read by every wrapped layer.
state = {"tokens": None, "uncond_tokens": None, "scale": 0.0}


class ImageProj(torch.nn.Module):
    """IP-Adapter's projection from the CLIP image embedding to four context tokens."""

    def __init__(self, clip_dim=1024, context_dim=768, tokens=4):
        super().__init__()
        self.tokens, self.context_dim = tokens, context_dim
        self.proj = torch.nn.Linear(clip_dim, tokens * context_dim)
        self.norm = torch.nn.LayerNorm(context_dim)

    def forward(self, embeds):
        return self.norm(self.proj(embeds).reshape(-1, self.tokens, self.context_dim))


def _cross_attention_layers(unet):
    """The UNet's cross-attention (attn2) modules, in diffusers' processor order: down, up, middle."""
    layers = []
    for blocks in (unet.input_blocks, unet.output_blocks, [unet.middle_block]):
        for block in blocks:
            for module in block.modules():
                if module.__class__.__name__ == "BasicTransformerBlock":
                    layers.append(module.attn2)
    return layers


def _attend(layer, x, k, v):
    """Attention of x's queries over the given keys and values, through the layer's own to_q."""
    h = layer.heads
    q = layer.to_q(x)
    q, k, v = (rearrange(t, "b n (h d) -> (b h) n d", h=h) for t in (q, k, v))
    sim = torch.einsum("b i d, b j d -> b i j", q.float(), k.float()) * (q.shape[-1] ** -0.5)
    out = torch.einsum("b i j, b j d -> b i d", sim.softmax(dim=-1), v.float()).to(x.dtype)
    return rearrange(out, "(b h) n d -> b n (h d)", h=h)


def install(unet, weights, device):
    """Adds IP-Adapter's key/value layers to the UNet's cross-attention. Does nothing until state has tokens."""
    image_proj = {k[len("image_proj."):]: v for k, v in weights.items() if k.startswith("image_proj.")}
    adapter = {k[len("ip_adapter."):]: v for k, v in weights.items() if k.startswith("ip_adapter.")}
    proj = ImageProj(clip_dim=image_proj["proj.weight"].shape[1])
    proj.load_state_dict(image_proj)
    proj = proj.to(device).half().eval()

    layers = _cross_attention_layers(unet)
    # One set of weights per cross-attention layer, keyed by its odd processor index.
    indices = {k.split(".")[0] for k in adapter}
    if len(layers) != len(indices):
        raise RuntimeError(f"IP-Adapter has weights for {len(indices)} cross-attention layers; this UNet has {len(layers)}")
    for i, layer in enumerate(layers):
        index = 2 * i + 1  # every processor's attn1 is even, its attn2 odd
        k_w, v_w = adapter[f"{index}.to_k_ip.weight"], adapter[f"{index}.to_v_ip.weight"]
        if k_w.shape != layer.to_k.weight.shape:
            raise RuntimeError(f"IP-Adapter layer {index} is {tuple(k_w.shape)}, the UNet's is {tuple(layer.to_k.weight.shape)}: the layer order doesn't match")
        layer.to_k_ip = torch.nn.Linear(k_w.shape[1], k_w.shape[0], bias=False).to(device).half()
        layer.to_v_ip = torch.nn.Linear(v_w.shape[1], v_w.shape[0], bias=False).to(device).half()
        layer.to_k_ip.weight.data.copy_(k_w)
        layer.to_v_ip.weight.data.copy_(v_w)
        layer.forward = _wrap(layer, layer.forward)
    return proj


def _wrap(layer, forward):
    def wrapped(x, context=None, mask=None):
        out = forward(x, context=context, mask=mask)
        tokens = state["tokens"]
        if tokens is None or state["scale"] == 0:
            return out
        # Deforum runs the unconditional and conditional passes as one batch, in that order
        # (helpers/model_wrap.py); the unconditional half gets IP-Adapter's "no image" tokens.
        b = x.shape[0]
        ip = torch.cat([state["uncond_tokens"]] * (b // 2) + [tokens] * (b - b // 2)) if b > 1 else tokens
        ip = ip.to(x.dtype)
        image = _attend(layer, x, layer.to_k_ip(ip), layer.to_v_ip(ip))
        return out + torch.nn.functional.linear(image, layer.to_out[0].weight) * state["scale"]

    return wrapped


@torch.no_grad()
def encode(image, encoder, processor, proj, device):
    """The style image's four context tokens, and the "no image" tokens for the unconditional pass."""
    pixels = processor(images=image.convert("RGB"), return_tensors="pt").pixel_values.to(device, dtype=torch.float16)
    embeds = encoder(pixels).image_embeds
    return proj(embeds), proj(torch.zeros_like(embeds))
