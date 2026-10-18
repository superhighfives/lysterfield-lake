/**
 * Pinned Replicate model versions. Pinning is required, not just best
 * practice — the "owner/name" latest-version shorthand 404s on every model
 * this pipeline uses (confirmed against the live API), so every call must
 * go through the explicit "owner/name:version" form.
 *
 * Re-check these against `https://api.replicate.com/v1/models/<owner>/<name>`
 * (`latest_version.id`) periodically; a model owner publishing a new
 * version doesn't change these until bumped here deliberately.
 */
export const MODELS = {
  /**
   * Portrait step (panel 2, previously called "artwork") — went through
   * nano-banana-2 and flux-kontext-dev after the original public
   * `gwang-kim/diffusionclip` listing turned out to have an unreliable,
   * sometimes multi-hour cold boot (phase 3's plan). Both replacements were
   * cheaper/more reliable, but neither reproduced DiffusionCLIP's actual
   * look — flux-kontext-dev in particular resisted being pushed toward a
   * looser, more painterly style via prompting no matter how hard (see
   * phase 5's plan). Landed back on DiffusionCLIP itself, now self-hosted
   * at `superhighfives/diffusionclip` (`models/diffusionclip/`) instead of
   * depending on the abandoned public listing — same real style,
   * $0.02/call, and (with the deployment's min instances set to 1) no cold
   * boot either.
   */
  portrait:
    'superhighfives/diffusionclip:67ec618b47194f7d6776ebadd6985c851ecab8d9b2399cb335a0f86e773ce93d',
  zoedepth: 'cjwbw/zoedepth:6375723d97400d3ac7b88e3022b738bf6f433ae165c4a2acd1955eaa6b8fcb62',
  realEsrgan: 'cjwbw/real-esrgan:d0ee3d708c9b911f122a4ad90046c5d26a0293b99476d697f6bb7f2e251ce2d4',
  robustVideoMatting:
    'arielreplicate/robust_video_matting:73d2128a371922d5d1abf0712a1d974be0e4e2358cc1218e4e34714767232bac',
  /**
   * Per-frame image inpainting for the background-plate step. Originally
   * tried `jd7h/propainter` (temporally-consistent video inpainting) — its
   * Cog wrapper's mask-extension validation fails against every
   * Replicate-hosted file URL, reproduced via raw API calls with clean
   * URLs, so it's a bug in that model, not fixable from our side. Fell back
   * to prompt-free `allenhooo/lama`, but its fill hallucinated a
   * woven-fabric texture over the subject instead of continuing the
   * meadow. Swapped for prompt-guided `black-forest-labs/flux-fill-pro`
   * after a side-by-side against flux-fill-dev and stable-diffusion-
   * inpainting — the only candidate that fully removed the subject with a
   * seamless, photorealistic result. Same mask convention as LaMa (white =
   * inpaint region), so no change needed on the caller side.
   */
  backgroundInpaint: 'black-forest-labs/flux-fill-pro:41c767bcbfffe54ef8f05eb4d0100f9314790f7fc43a7b88d73ec06839deddb9',
  /**
   * Panel 3 as video (`background-video`): Bria's object eraser, given panel 2
   * and a mask of the person, in clips of up to 5s and 750p. $0.05 per output
   * second. Picked for `.jobs/full-video` over MiniMax and flux; see
   * plans/done/phase-4e-full-video-source-prep.md. It only reads public URLs
   * (r2.ts).
   */
  backgroundVideo: 'bria/video-erase-object:cbecc9042f041609a958facb1396732166d03ebf5eddd20738b449d22ab9f463',
  /**
   * Dream step — replaced `kwaivgi/kling-v3-omni-video` (phase 2's pick
   * over Grok Imagine) after live-testing showed it doesn't actually do
   * what the legacy pipeline's dreaming lane did. Checked the real
   * Deforum output on the external drive frame-by-frame: contrary to this
   * file's earlier assumption, `hybrid_composite` locks the animation's
   * structure/layout tightly to the real footage after the first few
   * frames (a boardwalk stays a boardwalk, a treeline stays a treeline)
   * while the diffusion still fully reimagines it as a painting — genuine
   * "same structure, new style," not a filter. Kling's `start_image` +
   * `reference_images` doesn't reproduce that: across three prompt/
   * reference variations, it either left frames almost untouched or
   * cross-dissolved the whole frame into the reference image's own
   * content, erasing the person rather than reimagining them.
   *
   * `black-forest-labs/flux-kontext-dev` — a prompt-driven image *editor*,
   * not a generic img2img model — reproduces the real pattern almost
   * exactly when called per real frame (not per scene): same pose,
   * composition, and background, fully repainted. This is the same model
   * that lost the portrait-step comparison to DiffusionCLIP (see
   * `portrait` above) — but that comparison was about matching
   * DiffusionCLIP's specific watercolor look, which it resisted; here
   * there's no fixed look to match, so its actual strength (structure-
   * locked, prompt-driven reimagining) is exactly what's needed. Called
   * once per *kept* frame at a reduced step-fps (see `dream.ts`), not
   * once per scene — Kling's one-call-per-scene shape is why it could
   * never track real per-frame motion, no matter the prompt.
   */
  dream: 'black-forest-labs/flux-kontext-dev:85723d503c17da3f9fd9cecfb9987a8bf60ef747fd8f68a25d7636f88260eb59',
  /**
   * Outline step — cleaned coarse line art, the private Cog model in
   * `models/lineart/` (replaced ArtLine, `models/outline/`, after the outline
   * bake-off; see plans/done/phase-4g-outline-coarse-lineart.md).
   * CPU, like ArtLine before it: ~6s per 1024px frame, and CPU avoids the
   * GPU boot problems ArtLine hit on Replicate.
   */
  outline:
    'superhighfives/lysterfield-lineart:025736d04810b15b36ecc601992303a24df7880554a52b1c7bbac1ac9156cc81',
  /**
   * Dream directions brainstorm (`dream-directions`) — Claude via Replicate,
   * so the pipeline needs no separate Anthropic key. Opus 4.7 is the most
   * capable Opus Replicate hosts. An official model, so it runs by name
   * (Replicate keeps it on its latest version) rather than a pinned version.
   */
  directions: 'anthropic/claude-opus-4.7',
  /**
   * Dream takes the legacy way (`dream-deforum.ts`): Deforum 0.7.1 with the legacy render.py,
   * settings, negative prompt and colour reference — `models/deforum/`, private, L40S (about 8s a render with
   * xformers, and about 40% cheaper per frame than the A100's 10s; 2026-10-16). The same build runs on the 4090 PC
   * (gpu-server.ts). See plans/done/own-deforum-dream-model.md.
   */
  deforum: 'superhighfives/lysterfield-deforum:c874cd192ac419fb736be755ad148ff7b512bc8ae0d7a4d7b1c5cb9fa91e1f1e',
} as const satisfies Record<string, `${string}/${string}` | `${string}/${string}:${string}`>
