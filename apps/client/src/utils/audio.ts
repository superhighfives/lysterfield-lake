// The player's audio, routed through Web Audio: a gain node for the swap
// fades (utils/swap-dream.ts) — el.volume is read-only on iOS, so fading it
// did nothing there, and fading it elsewhere flickered the mute icon — and
// an analyser for the music's low end, which the scene breathes with.
//
// The context has to start inside a user gesture (Safari), so it's created
// by the welcome button's click (startAudio), and the video element is
// connected once it exists (connectAudio). Anything failing here leaves
// playback as plain <video> audio, with no fades or pulse.

// Pulse: the analyser bins (of FFT_SIZE / 2) averaged for the low end. The
// pulse is that level rising above its own slow average (AVERAGE_EASE per
// frame) — the beats, not the steady bass under them — scaled by
// ONSET_GAIN, then eased up at ATTACK and down at RELEASE per frame.
const FFT_SIZE = 512
const LOW_BINS = 6
const AVERAGE_EASE = 0.02
const ONSET_GAIN = 4
const ATTACK = 0.5
const RELEASE = 0.08

let context: AudioContext | null = null
let gain: GainNode | null = null
let analyser: AnalyserNode | null = null
let bins: Uint8Array<ArrayBuffer> | null = null
const connected = new WeakSet<HTMLMediaElement>()
let pulse = 0
let average = 0

// An element routed into a suspended context plays silence, so the video
// is only connected once the context is actually running — until then it
// plays as plain <video> audio. And a context the browser suspends later
// (iOS does, around interruptions) is resumed on the next interaction.
let pending: HTMLMediaElement | null = null

export function startAudio() {
  if (context) return
  try {
    context = new AudioContext()
    context.resume()
    context.addEventListener('statechange', () => {
      if (context?.state === 'running' && pending) connectAudio(pending)
    })
    const resume = () => {
      if (context?.state === 'suspended') context.resume()
    }

    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)
  } catch (error) {
    console.warn(`Web Audio unavailable: ${error}`)
    context = null
  }
}

export function connectAudio(el: HTMLMediaElement) {
  if (!context || connected.has(el)) return
  if (context.state !== 'running') {
    pending = el
    return
  }

  pending = null
  try {
    const source = context.createMediaElementSource(el)
    gain = context.createGain()
    analyser = context.createAnalyser()
    analyser.fftSize = FFT_SIZE
    bins = new Uint8Array(analyser.frequencyBinCount)
    source.connect(gain).connect(analyser).connect(context.destination)
    connected.add(el)
  } catch (error) {
    console.warn(`Couldn't route audio through Web Audio: ${error}`)
  }
}

/** Fades the player's audio to `to` (0-1) over `ms`. Returns false if
 *  there's no gain node to fade, so the caller can fall back. */
export function fadeGain(to: number, ms: number) {
  if (!context || !gain) return false
  const now = context.currentTime
  gain.gain.cancelScheduledValues(now)
  gain.gain.setValueAtTime(gain.gain.value, now)
  gain.gain.linearRampToValueAtTime(to, now + ms / 1000)
  return true
}

/** The music's low end, 0-1, eased — call once per frame. */
export function readPulse() {
  if (!analyser || !bins) return 0
  analyser.getByteFrequencyData(bins)
  let sum = 0
  for (let i = 1; i <= LOW_BINS; i++) sum += bins[i]
  const level = sum / LOW_BINS / 255
  average += (level - average) * AVERAGE_EASE
  const onset = Math.min(Math.max((level - average) * ONSET_GAIN, 0), 1)
  pulse += (onset - pulse) * (onset > pulse ? ATTACK : RELEASE)
  return pulse
}

/** The pulse as of the last readPulse(), for readers other than the scene
 *  (which advances it) — reading it doesn't ease it again. */
export const latestPulse = () => pulse
