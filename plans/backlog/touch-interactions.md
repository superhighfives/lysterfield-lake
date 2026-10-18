---
title: Work out the pointer effects for mobile and touch
status: Backlog
created: 2026-10-16
updated: 2026-10-16
---

# Work out the pointer effects for mobile and touch

## Goal

Decide how the effects built around a mouse pointer on the `polaroid-swap`
branch should look and behave on phones and other touch devices, where
there's no hover and no cursor, and the scene is steered by device tilt
instead.

## Context

The `polaroid-swap` branch added several effects that assume a pointer
moving freely over the page:

- **Liquid wake** (`components/wake-pass.tsx`, `utils/liquid-trail.ts`):
  the whole scene is pulled along the pointer's recent path, more the
  faster it moves. It listens to `pointermove`, so on touch it currently
  only reacts while a finger is dragging — which is also how you swipe
  between dreams — and does nothing otherwise.
- **Custom cursor** (`components/cursor.tsx`): only on devices with a
  precise, hovering pointer; touch keeps none. Its drag preview (the
  incoming dream and the release ring) has no touch equivalent yet.
- **Avatar hashing** (`uHash` in `materials/video-material.tsx`): the avatar
  breaks into stipple as the pointer nears it. On mobile, the "pointer" is
  driven by device tilt, so this follows tilt rather than a finger.
- **Welcome-screen ripples** (`components/water-video.tsx`): dropped by
  pointer movement over the title loop, so they need a touch on touch.
- **Audio**: swap fades go through Web Audio so they work on iOS, but this
  hasn't been tried on a device.

None of it has been tried on a real phone.

## Approach (rough, not scoped)

To work out, rather than settled:

- **Wake on touch:** stir it from the swipe only (as now), from taps (a
  splash where the finger lands), from device tilt (a slow drift as the
  phone moves), or a mix. The speed curve may need retuning for finger
  speeds and phone pixel densities.
- **Drag feedback without a cursor:** show the incoming dream and the
  release point somewhere other than under the finger (it covers it) —
  at the polaroid's edge, or in the control pill.
- **Performance:** the wake renders the whole scene to an offscreen texture
  every frame (with 4x MSAA). Check it holds up on mid-range phones; drop
  the MSAA or the wake there if not.

## Tasks

- [ ] Try the current branch on an iPhone and an Android phone, and note
      what each effect does now
- [ ] Decide what the wake responds to on touch
- [ ] Design touch drag feedback
- [ ] Check frame rate on a mid-range phone with the wake pass on

## Open questions

- Should touch get the wake at all, or is it a desktop-only flourish?
- Does tilt already make the scene feel alive enough on mobile?
