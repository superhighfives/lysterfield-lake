---
title: Work out the pointer effects for mobile and touch
status: Complete
created: 2026-10-16
updated: 2026-10-27
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

- [x] Try it on an iPhone (the artist, 2026-10-20), and fix what came up
- [x] The wake: off once a dream plays, on every device (PR #41)
- [x] Touch drag feedback
- [ ] Android, and frame rate on a mid-range phone (not done)

## Open questions

- Should touch get the wake at all, or is it a desktop-only flourish?
  Settled by PR #41: the wake runs on the welcome and choose screens and is
  off once a dream plays, the same on every device. Touch keeps it.
- Does tilt already make the scene feel alive enough on mobile? Not
  recorded as settled; the shipped tilt drives the scene, the avatar and
  the water, and the wake got no tilt drift.

## Overview

The pointer effects built on `polaroid-swap` were tried on an iPhone by the
artist on 2026-10-20 and fixed in PR #44 (merged 2026-10-21, "Mobile:
touch-friendly player, steadier tilt, and phone layout"). Touch now gets the
same cursor ring as desktop while a finger is down, a steadier tilt, an
avatar and water ripple tuned for phones, more forgiving swipes, and a phone
layout. Android and frame rate on a mid-range phone were not tried.

## Architecture

What shipped, in PR #44:

- **Cursor on touch:** the same ring as on desktop, shown while a finger's
  down, with its labels and the drag's preview above the finger. No busy
  ring on touch.
- **Tilt:** wrapped (an angle passing 180° flipped the pointer edge to
  edge), eased, held in a ref rather than React state, and only counted
  once the sensor reports. Motion is used on Android too, over HTTPS.
- **Avatar:** on a phone it holds whole against the tilt and fades only for
  a finger, as it nears.
- **Water:** the blank print's ripple runs over the playing photo too,
  stirred by the mouse, or by the tilt while a thumb's down; subtle, and it
  settles in about a second.
- **Swiping:** a drag started before a swap's possible picks up once it is,
  and one started near an edge needs only most of the room left that way.
  The chooser's toss is shorter on touch, a flick tosses, and the page holds
  still while a finger's on the top card.
- **Layout:** the title at the top on touch, the controls lower and without
  Previous, Next or YouTube, full screen behind Safari's toolbar, a smaller
  chooser pile, and no long-press selection.
- **Welcome title:** keyed out in its shader in dark mode (iOS ignores the
  SVG filter on a canvas) and no wider than the screen.

Where it lives: the cursor in `components/cursor.tsx`; tilt in
`utils/index.ts` (the orientation maths) and `utils/device.ts` (the
permission request, and on Android trusting the sensor only once it
reports, over HTTPS); the avatar in `materials/video-material.tsx`; the
water in `components/water-video.tsx` and `utils/water-sim.ts`; swipes in
`utils/swap-gesture.ts` and `components/carousels/stack.tsx`; layout in
`components/playhead.tsx`, `views/footer.tsx` and `index.css`.

Deviations from the rough approach:

- The wake wasn't given a touch scheme of its own (taps, tilt drift). PR #41
  turned it off once a dream plays, on every device, which made the
  question mostly moot.
- Drag feedback stayed with the cursor ring rather than moving to the
  polaroid's edge or the control pill: the labels and preview sit above
  the finger instead of under it.
- The MSAA and performance check on mid-range phones wasn't done, so
  whether the wake holds up there is unknown.
