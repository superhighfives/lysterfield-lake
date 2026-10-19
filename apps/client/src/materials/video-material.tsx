import { shaderMaterial } from '@react-three/drei'
import { extend, ThreeElement } from '@react-three/fiber'
import { ShaderMaterial, Texture, Vector2, Vector3 } from 'three'

const uniforms = {
  uOpacity: 0,
  uTexture: new Texture(),
  // The split layout (plans/in-progress/split-dream-video-client.md): uTexture
  // is the shared main video, panels 1-6 (uFrameTotal 6), and panel 7, the
  // dream, comes from its own videos — uDream and uDreamNext, crossfaded
  // by uDreamMix (0 = uDream). uSplit 0 is the 7-panel layout, panel 7
  // read from uTexture like the rest.
  // Null, not an empty Texture, when unset (the avatar never reads panel
  // 7): drei clones default uniforms, and a cloned empty Texture is flagged
  // for upload with no image, which three.js warns about every frame.
  uDream: null as Texture | null,
  uDreamNext: null as Texture | null,
  uDreamMix: 0,
  uSplit: 0,
  uFrameSelected: 0,
  uFrameMask: 0,
  uFrameTotal: 0,
  uMaskIntensity: 0,
  uInvert: 0,
  uFrameDepth: 0,
  uFrameOverlay: 0,
  uPointerPos: new Vector2(0, 0),
  uPointerRelative: new Vector2(0, 0),
  uTime: 0,
  uAvatar: 0,
  uFrameSketch: 0,
  uIdle: 0,
  // How far the avatar's depth-map relief pushes toward the camera, in
  // world units at full depth (depth panel = 1.0) and full fade-in.
  uDepthStrength: 0,
  // Panel-UV radii for the avatar's depth shaping: how far the depth map is
  // blurred into rounded forms, and how wide the roll-off at the matte's
  // edge is. See the vertex shader.
  uShapeRadius: 0,
  uEdgeRadius: 0,
  // Unsharp-mask amount for the avatar's portrait (0 = off).
  uSharpen: 0,
  // 0 = light, 1 = dark. Drives the intro/outro fade colour and the
  // background that uBackgroundMix blends toward.
  uDark: 0,
  // Permanent blend of `image` toward a flat colour that contrasts with
  // the page (black in light mode, white in dark mode) — 0 leaves the
  // sampled colour alone. Only the lyrics mesh sets this, so its
  // dream-video fill reads against the page and polaroid in either mode.
  uBackgroundMix: 0,
  // 1 = fully shown. Below 1 the mesh dissolves through an ordered dither
  // (the same 8x8 matrix as the sketch) and its UVs ripple, rather than
  // fading flat — used to clear the avatar during a dream swap.
  uFade: 1,
  // The mesh's motion, in panel UV per frame-ish (see main.tsx). Smears
  // the image back along it and splits its colour channels, so a moving
  // polaroid streaks and a still one is untouched.
  uVelocity: new Vector2(0, 0),
  // How much of the avatar's pointer-driven fade (it clears as the pointer
  // nears it) breaks up through the dissolve's dither rather than fading
  // smoothly. 0 = smooth, 1 = all stipple.
  uHash: 0,
  // 1 = show the avatar at full strength whatever the pointer is doing (its
  // pointer fade, and so the hashing, held off); eased back to 0. Used
  // just after a dream swap, so the new dream's avatar arrives whole.
  uReveal: 0,
  // The polaroid developing after it lands (see main.tsx): 0 = a blank,
  // milky print, 1 = fully developed.
  uDevelop: 1,
  // The blank print's water (utils/water-sim.ts): a height field over the
  // photo, red = height, that the print refracts through and catches the
  // light on. Null when there's none.
  uWater: null as Texture | null,
  // A landing ripple through the photo: xy = origin in UV, z = seconds
  // since it started (negative = none).
  uRipple: new Vector3(0.5, 0.5, -1),
  // The polaroid flexing like card as it moves: z offset per squared
  // normalised x (x) and y (y) of the model. See BEND_* in main.tsx.
  uBend: new Vector2(0, 0),
  // The music's low end, 0-1 (see utils/audio.ts).
  uPulse: 0,
}

export const VideoMaterial = shaderMaterial(
  uniforms,

  /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float uFrameSelected;
    uniform float uFrameDepth;
    uniform float uFrameMask;
    uniform float uFrameTotal;
    uniform float uOpacity;
    uniform float uFrameOverlay;
    uniform vec2 uPointerPos;
    uniform vec2 uPointerRelative;
    varying vec2 texCoord;
    uniform float uTime;
    uniform float uDepthStrength;
    uniform float uShapeRadius;
    uniform float uEdgeRadius;
    uniform vec2 uBend;
    // Half the polaroid model's width and height, to normalise the bend.
    const vec2 BEND_EXTENT = vec2(1.83, 2.3);

    // Samples one panel of the atlas (uFrameTotal panels: 7, or the split
    // layout's main video, 6 — only the matte and depth are read here, both
    // in the main video), clamped (like the fragment shader's localX) so a
    // lookup never bleeds into the neighbouring panel.
    float samplePanel(float panel, vec2 uv) {
      float x = clamp(uv.x, 1.0 / 512.0, 1.0 - 1.0 / 512.0);
      return texture2D(uTexture, vec2((x + (panel - 1.0)) / uFrameTotal, clamp(uv.y, 0.0, 1.0))).r;
    }

    // A panel's average over a 5x5 neighbourhood spanning +/-radius.
    float blurPanel(float panel, vec2 uv, float radius) {
      float sum = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          sum += samplePanel(panel, uv + vec2(float(x), float(y)) * (radius / 2.0));
        }
      }
      return sum / 25.0;
    }

    void main(){
        vUv = uv;
        float intensity = 0.0;

        float fadeAmount = clamp((uTime / 4.0) - 1.25, 0.0, 1.0);

        if(uFrameDepth != 0.0) {
          // The whole plane leans back toward the bottom and sits a little
          // forward — a flat offset, unaffected by the matte.
          float lean = (0.1875 * vUv.y) * fadeAmount + 0.05;

          // The depth panel is coarse — bright is near, but a head comes
          // through as one flat plateau, and pushing that forward as-is
          // extrudes the head like a block. Blurring it heavily turns each
          // plateau into a rounded hill (and blends the neck smoothly into
          // the shoulders, rather than pinching it), which reads as a
          // head's actual shape.
          float shape = blurPanel(uFrameDepth, vUv, uShapeRadius);

          // Then a narrow roll-off right at the matte's edge, so the
          // silhouette curves away rather than ending in a cliff. Smoothstep,
          // not a quarter circle: a circle's profile goes vertical at the
          // edge, and those near-vertical triangles stretched the outline's
          // pixels into streaks (an ear smeared sideways) at ordinary tilt
          // angles; smoothstep eases to a flat edge instead.
          // Matte coverage over the neighbourhood is ~0.5 on the edge and
          // 1.0 once fully inside, remapped to 0..1. Outside the matte the
          // relief is 0, which also drops the depth model's corner
          // flutter on the hidden part of the plane.
          float inside = clamp((blurPanel(uFrameMask, vUv, uEdgeRadius) - 0.5) * 2.0, 0.0, 1.0);
          float rolloff = smoothstep(0.0, 1.0, inside);

          float relief = shape * rolloff * uDepthStrength * fadeAmount;

          intensity = lean + relief;
        }

        vec2 bendUv = position.xy / BEND_EXTENT;
        float bend = dot(uBend, bendUv * bendUv);
        vec3 newPosition = vec3(position.x, position.y, position.z + intensity + bend);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
    }
  `,
  /* glsl */ `
    varying vec2 vUv;
    varying vec2 texCoord;
    uniform sampler2D uTexture;
    uniform sampler2D uDream;
    uniform sampler2D uDreamNext;
    uniform float uDreamMix;
    uniform float uSplit;
    uniform float uOpacity;
    uniform float uFrameSelected;
    uniform float uFrameTotal;
    uniform float uFrameMask;
    uniform float uFrameSketch;
    uniform float uMaskIntensity;
    uniform float uInvert;
    uniform float uFrameOverlay;
    uniform vec2 uPointerPos;
    uniform vec2 uPointerRelative;
    uniform float uTime;
    uniform float uAvatar;
    uniform float uIdle;
    uniform float uDark;
    uniform float uBackgroundMix;
    uniform float uSharpen;
    uniform float uFade;
    uniform vec2 uVelocity;
    const float SHARPEN_TEXELS = 1.5;
    // Pixel size of the dissolve's dither cells.
    const float DISSOLVE_CELL = 2.0;
    // Ripple while dissolving: UV amplitude at fully dissolved, and its
    // spatial frequency and speed.
    const float RIPPLE_AMOUNT = 0.02;
    const float RIPPLE_FREQUENCY = 18.0;
    const float RIPPLE_SPEED = 5.0;
    // Motion smear: taps along the velocity, and how far the red and blue
    // channels split either side of it.
    const int SMEAR_TAPS = 10;
    const float SPLIT_AMOUNT = 0.15;
    uniform float uDevelop;
    uniform float uReveal;
    uniform float uHash;
    uniform sampler2D uWater;
    // One texel of the water's height field (utils/water-sim.ts's SIZE).
    const float WATER_TEXEL = 1.0 / 192.0;
    uniform vec3 uRipple;
    uniform float uPulse;
    // Landing ripple: ring speed (UV/s), wavelength, peak UV displacement,
    // ring width and how long it rings for (s).
    const float LANDING_SPEED = 0.9;
    const float LANDING_FREQUENCY = 40.0;
    const float LANDING_AMOUNT = 0.012;
    const float LANDING_WIDTH = 0.12;
    const float LANDING_SECONDS = 1.4;

    vec3 blendMultiply(vec3 base, vec3 blend) {
      return base*blend;
    }
    
    vec3 blendMultiply(vec3 base, vec3 blend, float opacity) {
      return (blendMultiply(base, blend) * opacity + base * (1.0 - opacity));
    }

    const int dither_matrix_2x2[4] = int[](
        0,  3,  
        2,  1
    );

    const int dither_matrix_8x8[64] = int[](
      24, 10, 12, 26, 35, 47, 49, 37,
      8,  0,  2,  14, 45, 59, 61, 51,
      22, 6,  4,  16, 43, 57, 63, 53,
      30, 20, 18, 28, 33, 41, 55, 39,
      34, 46, 48, 36, 25, 11, 13, 27,
      44, 58, 60, 50, 9,  1,  3,  15,
      42, 56, 62, 52, 23, 7,  5,  17,
      32, 40, 54, 38, 31, 21, 19, 29
    );

    float dither2x2(vec2 uv, float luma) {
      float dither_amount = 2.0;
      int x = int(mod(uv.x, dither_amount));
      int y = int(mod(uv.y, dither_amount));
      int index = x + y * int(dither_amount);
      float limit = (float(dither_matrix_2x2[index]) + 1.0) / (1.0 + 4.0);
      return luma < limit ? 0.0 : 1.0;
    }

    float dither8x8(vec2 uv, float luma) {
      float dither_amount = 8.0;
      int x = int(mod(uv.x, dither_amount));
      int y = int(mod(uv.y, dither_amount));
      int index = x + y * int(dither_amount);
      float limit = (float(dither_matrix_8x8[index]) + 1.0) / (1.0 + 64.0);
      return luma < limit ? 0.0 : 1.0;
    }

    // The ordered-dither threshold (0-1) for this pixel's cell.
    // One panel's colour at a panel-local uv (x already kept a texel inside
    // the panel, see localX). Every fragment lookup goes through this, so
    // the dream panel can come from its own videos in the split layout.
    vec4 panel(float p, vec2 uv) {
      if (uSplit > 0.5 && p == 7.0) {
        vec2 d = clamp(uv, 0.0, 1.0);
        return mix(texture2D(uDream, d), texture2D(uDreamNext, d), uDreamMix);
      }
      return texture2D(uTexture, vec2((uv.x + (p - 1.0)) / uFrameTotal, uv.y));
    }

    // Smooth value noise, 0-1, for the blank print's drifting emulsion.
    float emulsionHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float emulsionNoise(vec2 p) {
      vec2 cell = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(emulsionHash(cell), emulsionHash(cell + vec2(1.0, 0.0)), u.x),
        mix(emulsionHash(cell + vec2(0.0, 1.0)), emulsionHash(cell + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float ditherLimit() {
      vec2 cell = gl_FragCoord.xy / DISSOLVE_CELL;
      int index = int(mod(cell.x, 8.0)) + int(mod(cell.y, 8.0)) * 8;
      return (float(dither_matrix_8x8[index]) + 1.0) / 65.0;
    }

    void main() {
      // Rippling UVs while dissolving (uFade < 1); untouched otherwise.
      // The music's pulse adds a breath of the same ripple.
      float dissolve = 1.0 - uFade;
      float rippleAmount = dissolve * RIPPLE_AMOUNT + uPulse * RIPPLE_AMOUNT * 0.15;
      vec2 st = vUv + rippleAmount * vec2(
        sin(vUv.y * RIPPLE_FREQUENCY + uTime * RIPPLE_SPEED),
        cos(vUv.x * RIPPLE_FREQUENCY + uTime * RIPPLE_SPEED * 0.8)
      );

      // Landing ripple: one ring spreading out from where it landed,
      // pushing the image outward along it, dying away as it goes.
      if(uRipple.z >= 0.0 && uRipple.z < LANDING_SECONDS) {
        vec2 fromOrigin = vUv - uRipple.xy;
        float dist = length(fromOrigin);
        float front = dist - uRipple.z * LANDING_SPEED;
        float ring = exp(-(front * front) / (LANDING_WIDTH * LANDING_WIDTH));
        float decay = 1.0 - uRipple.z / LANDING_SECONDS;
        st += normalize(fromOrigin + 1e-5) * sin(front * LANDING_FREQUENCY) * ring * decay * LANDING_AMOUNT;
      }

      float offsetX = 0.0;
      float offsetY = 0.0;
      if(uFrameSelected == 7.0) {
        offsetX = -uPointerRelative.x / 40.0;
        offsetY = -uPointerRelative.y / 40.0;
      }

      // st.x - offsetX can land outside [0, 1] once offsetX (the pointer
      // parallax nudge, up to +/-0.05) pushes it past this frame's own
      // sub-range within the 7-frame atlas — clamped here so a frame lookup
      // never crosses into the neighbouring frame's pixels. Unclamped, that
      // showed up as a thin vertical strip of a neighbouring frame's raw
      // (unmasked) content bleeding in along the mesh's edge. Clamping to
      // exactly [0, 1] isn't quite enough on its own: bilinear filtering
      // samples a texel either side of wherever it lands, so a value sitting
      // right on the 0/1 boundary still blends in half a texel's worth of
      // the next frame over. Pulling the clamp in by one texel's width
      // keeps the sample, and its filter footprint, fully inside this frame.
      // 1/512 is one texel of the touch devices' video-small atlas (512px
      // frames); desktop's full-size atlas has 1024px frames, where it's a
      // conservative two.
      float localX = clamp(st.x - offsetX, 1.0 / 512.0, 1.0 - 1.0 / 512.0);

      vec4 image = panel(uFrameSelected, vec2(localX, uInvert == 1.0 ? 1.0 - st.y : st.y - offsetY));

      // Unsharp mask: push each pixel away from the average of its four
      // neighbours (SHARPEN_TEXELS atlas texels away). The portrait panel
      // is soft at source — stylised, then VP9-compressed — so this
      // recovers some edge definition rather than adding real detail.
      if(uSharpen != 0.0) {
        vec2 uv = vec2((localX + (uFrameSelected - 1.0)) / uFrameTotal, st.y - offsetY);
        vec2 texel = SHARPEN_TEXELS / vec2(textureSize(uTexture, 0));
        vec3 blur = (
          texture2D(uTexture, uv + vec2(texel.x, 0.0)).rgb +
          texture2D(uTexture, uv - vec2(texel.x, 0.0)).rgb +
          texture2D(uTexture, uv + vec2(0.0, texel.y)).rgb +
          texture2D(uTexture, uv - vec2(0.0, texel.y)).rgb
        ) / 4.0;
        image.rgb = clamp(image.rgb + (image.rgb - blur) * uSharpen, 0.0, 1.0);
      }
      // Motion smear and colour split, along uVelocity. Each tap is
      // clamped inside this panel, like localX above.
      if(uVelocity != vec2(0.0)) {
        vec2 local = vec2(localX, st.y - offsetY);
        vec3 smear = vec3(0.0);
        for (int i = 0; i < SMEAR_TAPS; i++) {
          float t = float(i) / float(SMEAR_TAPS - 1);
          vec2 tap = local - uVelocity * t;
          float r = panel(uFrameSelected, vec2(clamp(tap.x + uVelocity.x * SPLIT_AMOUNT, 1.0 / 512.0, 1.0 - 1.0 / 512.0), clamp(tap.y + uVelocity.y * SPLIT_AMOUNT, 0.0, 1.0))).r;
          float g = panel(uFrameSelected, vec2(clamp(tap.x, 1.0 / 512.0, 1.0 - 1.0 / 512.0), clamp(tap.y, 0.0, 1.0))).g;
          float b = panel(uFrameSelected, vec2(clamp(tap.x - uVelocity.x * SPLIT_AMOUNT, 1.0 / 512.0, 1.0 - 1.0 / 512.0), clamp(tap.y - uVelocity.y * SPLIT_AMOUNT, 0.0, 1.0))).b;
          smear += vec3(r, g, b);
        }
        image.rgb = smear / float(SMEAR_TAPS);
      }

      vec4 mask = panel(uFrameMask, vec2(localX, st.y - offsetY));

      float mixValue = uMaskIntensity;
      float shortenedFadeAmount = 1.0 - clamp((uTime / 4.0) - 0.75, 0.0, 1.0);
      float fadeAmount = 1.0 - clamp((uTime / 4.0) - 1.0, 0.0, 1.0);
      float extendedFadeAmount = 1.0 - clamp((uTime / 4.0), 0.25, 1.0);

      // The intro/outro fade colour — a soft gradient close to the page
      // background in each mode, so the scene fades in from (and out to)
      // the page rather than flashing white in dark mode. Still called
      // "white" since that's what it is in the light-mode default.
      vec3 colorA = mix(vec3(0.912, 0.921, 0.929), vec3(0.047, 0.039, 0.035), uDark);
      vec3 colorB = mix(vec3(0.95, 0.95, 0.92), vec3(0.11, 0.098, 0.09), uDark);
      vec3 color = mix(colorA, colorB, st.y);
      vec4 white = vec4(vec3(color), 1.0);

      if(uBackgroundMix != 0.0) {
        vec3 background = mix(vec3(0.0), vec3(1.0), uDark);
        image = vec4(mix(image.rgb, background, uBackgroundMix), image.a);
      }

      if(uFrameOverlay != 0.0) {
        fadeAmount = extendedFadeAmount;

        vec4 overlay = panel(uFrameOverlay, vec2(localX, st.y - offsetY));

        float minRadius = 0.15;
        float maxRadius = 0.5;
        float dist = distance(clamp(uPointerRelative / 2.0, 0.15, 0.85), st.xy);
        float range = maxRadius - minRadius;
        float mixAmount = clamp((dist - minRadius) / range, 0.0, 1.0);
        
        float gray = dot(overlay.rgb, vec3(0.299, 0.587, 0.114));
        overlay = vec4(mix(vec3(gray), overlay.rgb, 0.0), overlay.a);

        image = mix(image, overlay, mixAmount);
        image = mix(image, overlay, fadeAmount);
        image = mix(image, white, 1.0 - clamp(uTime - 1.0, 0.0, 1.0));
      }

      float opacityOverride = 0.0;

      if(uAvatar == 1.0) {
        fadeAmount = extendedFadeAmount;

        vec4 sketch = panel(uFrameSketch, vec2(localX, st.y - offsetY));

        vec4 luma = vec4(0.299, 0.587, 0.114, 0.0);
        float grayscale = dot(sketch, luma);

        vec4 outColor = vec4(vec3(dither2x2(gl_FragCoord.xy, grayscale)), 1.0);

        image = vec4(blendMultiply(vec3(image), vec3(outColor), 0.3), 1.0);

        float minRadius = 0.15;
        float maxRadius = 0.30;
        float dist = distance(uPointerRelative / 2.0, vec2(0.5, 0.6));
        float range = maxRadius - minRadius;
        float mixAmount = clamp((dist - minRadius) / range, 0.15, 1.0);
        float fadeIn = clamp(uTime / 4.0 - 1.5, 0.0, 1.0);
        float radial = clamp((0.5 - st.y) * 1.0 - mixAmount, 0.0, 1.0);

        opacityOverride = ((1.0 - (mixAmount - radial + (mask.r * uIdle))) * fadeIn);
        // Held off while revealed (see uReveal): as if the pointer were
        // well away from the avatar.
        opacityOverride *= 1.0 - uReveal;
      }

      image = mix(image, white, fadeAmount);


      // Developing: a blank milky print, then the tones come up, then the
      // colour — the way an instant photo develops. While it's blank
      // (waiting on the next dream), the emulsion isn't still: soft blotches
      // drift through it, and the scene's background ghosts in and out, as
      // if the picture's about to surface.
      if(uDevelop < 1.0) {
        float luma = dot(image.rgb, vec3(0.299, 0.587, 0.114));
        vec3 milky = mix(vec3(0.80, 0.82, 0.79), vec3(0.20, 0.21, 0.20), uDark);
        float blank = 1.0 - smoothstep(0.0, 0.3, uDevelop);
        if (blank > 0.0) {
          // The water over the print: its slope bends the print beneath it
          // (refraction) and catches a light from above-left.
          // Measured across a few texels, for a smooth surface.
          vec2 slope = vec2(
            texture2D(uWater, st + vec2(WATER_TEXEL * 3.0, 0.0)).r - texture2D(uWater, st - vec2(WATER_TEXEL * 3.0, 0.0)).r,
            texture2D(uWater, st + vec2(0.0, WATER_TEXEL * 3.0)).r - texture2D(uWater, st - vec2(0.0, WATER_TEXEL * 3.0)).r
          ) / 3.0;
          vec3 surface = normalize(vec3(-slope * 6.0, 1.0));
          float lit = dot(surface, normalize(vec3(-0.45, 0.55, 0.7))) - 0.7;
          float glint = pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), surface), normalize(vec3(-0.3, 0.4, 0.86))), 0.0), 60.0);
          vec2 drift = st * 2.6 + vec2(uTime * 0.05, -uTime * 0.035) - slope * 1.5;
          float warp = emulsionNoise(drift * 1.7 + uTime * 0.08);
          float blotch = emulsionNoise(drift + warp * 1.6);
          // The scene's background, seen through the water: refracted by
          // its slope, so the wake and rings bend it.
          float ghost = dot(panel(3.0, vec2(localX, st.y - offsetY) - slope * 1.2).rgb, vec3(0.299, 0.587, 0.114));
          float surfacing = 0.5 + 0.5 * sin(uTime * 0.9 + blotch * 3.0);
          vec3 tint = mix(vec3(1.0, 0.97, 0.92), vec3(0.92, 0.96, 1.0), blotch);
          vec3 emulsion = milky * tint + (blotch - 0.5) * mix(0.09, 0.05, uDark);
          // Clearly there, breathing a little with the emulsion.
          emulsion = mix(emulsion, vec3(ghost) * 0.75 + milky * 0.25, 0.4 + 0.15 * surfacing * blotch);
          emulsion += lit * mix(0.16, 0.11, uDark) + glint * mix(0.18, 0.12, uDark);
          milky = mix(milky, emulsion, blank);
        }
        vec3 tone = mix(milky, vec3(luma) * 0.85 + milky * 0.15, smoothstep(0.0, 0.55, uDevelop));
        image.rgb = mix(tone, image.rgb, smoothstep(0.35, 1.0, uDevelop));
      }

      //Calculate edge curvature
      vec2 curve = pow(abs(st * 2.0 - 1.0), vec2(1.0 / 0.005));
      //Compute distance to edge
      float edge = pow(length(curve), 1.0);
      //Compute vignette gradient and intensity
      float vignette = 1.0 - 1.0 * smoothstep(0.0,0.05,edge);

      float maskIncrease = 0.0;

      if(uFrameMask == 1.0) {
        maskIncrease = 0.1;
      }

      float baseAlpha = uOpacity - mixValue * (1.0 - mask.r + maskIncrease + opacityOverride);
      gl_FragColor = vec4(vec3(image), baseAlpha);

      //Add vignette to the resulting texture
      gl_FragColor.a *= vignette;

      // Dissolve: each dither cell drops out once uFade falls below its
      // threshold, so the mesh breaks up into the sketch's own stipple.
      if(uFade < 1.0) {
        gl_FragColor.a *= uFade >= ditherLimit() ? 1.0 : 0.0;
      }

      // The avatar's pointer fade, partly broken into the same stipple:
      // where it's half-faded, cells snap to shown or gone.
      if(uHash > 0.0 && uAvatar == 1.0) {
        float a = gl_FragColor.a;
        gl_FragColor.a = mix(a, a >= ditherLimit() ? 1.0 : 0.0, uHash);
      }

      // Nothing here: drawn, it would still write depth and hide whatever's
      // behind — the avatar's square plane hid the polaroid as it lifted
      // toward the camera mid-swap.
      if(gl_FragColor.a < 0.004) discard;
    }
  `,
  (material) => {
    if (material) {
      material.transparent = true
      material.needsUpdate = true
    }
  }
)

export type VideoMaterialProps = ShaderMaterial & typeof uniforms

declare module '@react-three/fiber' {
  interface ThreeElements {
    videoMaterial: ThreeElement<typeof VideoMaterial>
  }
}

extend({ VideoMaterial })
