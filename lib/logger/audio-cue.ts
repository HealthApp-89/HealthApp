// lib/logger/audio-cue.ts
//
// Session-scoped audio/haptic cue for the workout logger.
//
// Why this module exists: the original cue (rest-timer.ts, commit 5111bf0)
// constructed a new AudioContext at fire time, inside the countdown's 250ms
// interval. iOS only permits audio from a context created or resumed
// synchronously within a user-gesture handler, so a context born in a timer
// starts `suspended` and emits silence. The cue never worked on iPhone.
//
// The fix splits the cue in two:
//   unlockCue()  — called from a real tap (any pointerdown inside the logger
//                  sheet, or the Test button on /profile). Builds ONE
//                  AudioContext and ONE primed <audio> element per session.
//   fireCue()    — called from timers. Constructs nothing; it only replays
//                  what unlockCue already built.
//
// Two details that are load-bearing on iOS:
//
//  1. The <audio> element is the PRIMARY output. WebAudio on iOS routes to
//     the RINGER channel, so the phone's physical mute switch silences it —
//     the default state for most people in a gym. A media element plays on
//     the media channel. WebAudio remains the fallback.
//
//  2. Priming plays the element UNMUTED. iOS permits muted playback without
//     a gesture, so a muted play() may never register as the user-initiated
//     unlock this whole module depends on. Instead the beep opens with
//     LEAD_SILENCE_MS of digital silence: priming plays that silence and
//     pauses before the tone starts, so the unlock is real and inaudible.
//
// Vibration is best-effort: iOS Safari has never implemented the Vibration
// API, so `navigator.vibrate` is simply absent there and the call is skipped.

const BEEP_HZ = 880;
const BEEP_MS = 250;
const SAMPLE_RATE = 8000;
/** Digital silence prepended to the beep so priming can play-then-pause
 *  without anything audible escaping. */
const LEAD_SILENCE_MS = 60;

type MinimalAudioContext = {
  state: string;
  currentTime: number;
  destination: unknown;
  resume: () => Promise<void>;
  close: () => Promise<void>;
  createOscillator: () => {
    frequency: { value: number };
    connect: (dest: unknown) => void;
    start: () => void;
    stop: (when: number) => void;
  };
  createGain: () => {
    gain: {
      setValueAtTime: (v: number, t: number) => void;
      exponentialRampToValueAtTime: (v: number, t: number) => void;
    };
    connect: (dest: unknown) => void;
  };
  createBuffer: (channels: number, length: number, sampleRate: number) => unknown;
  createBufferSource: () => {
    buffer: unknown;
    connect: (dest: unknown) => void;
    start: (when: number) => void;
  };
};

type MinimalAudioEl = {
  src: string;
  muted: boolean;
  playsInline: boolean;
  preload: string;
  volume: number;
  currentTime: number;
  play: () => Promise<void> | undefined;
  pause: () => void;
};

let ctx: MinimalAudioContext | null = null;
let el: MinimalAudioEl | null = null;
let objectUrl: string | null = null;

/** Which output actually carried the last fireCue, and why it failed if it
 *  did. Surfaced by the Test button on /profile so a silent phone produces a
 *  readable report instead of a mystery. */
let lastPath: "media" | "oscillator" | "none" = "none";
let lastError: string | null = null;

export type CueDiagnostics = {
  unlocked: boolean;
  /** AudioContext.state, or null when no context could be built. */
  contextState: string | null;
  /** True when the media element was created and primed. */
  mediaReady: boolean;
  vibrateSupported: boolean;
  lastPath: "media" | "oscillator" | "none";
  lastError: string | null;
};

export function cueDiagnostics(): CueDiagnostics {
  let vibrateSupported = false;
  try {
    vibrateSupported =
      typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
  } catch {
    vibrateSupported = false;
  }
  return {
    unlocked: isCueUnlocked(),
    contextState: ctx?.state ?? null,
    mediaReady: el !== null,
    vibrateSupported,
    lastPath,
    lastError,
  };
}

/**
 * Render a short sine beep as a 16-bit mono PCM WAV, preceded by
 * `leadSilenceMs` of digital silence.
 *
 * Built in JS rather than shipped as a base64 literal so the tone stays
 * tweakable and the bundle stays small. An exponential envelope mirrors the
 * decay of the original oscillator cue and avoids a click on cutoff.
 */
export function buildBeepWav(
  freqHz: number,
  ms: number,
  sampleRate: number = SAMPLE_RATE,
  leadSilenceMs: number = LEAD_SILENCE_MS,
): Uint8Array {
  const leadSamples = Math.round((sampleRate * leadSilenceMs) / 1000);
  const toneSamples = Math.round((sampleRate * ms) / 1000);
  const numSamples = leadSamples + toneSamples;
  const dataBytes = numSamples * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);

  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  // Lead-in stays at zero — the DataView is already zero-filled.
  const decay = 5 / Math.max(1, toneSamples);
  for (let i = 0; i < toneSamples; i++) {
    const envelope = Math.exp(-decay * i);
    const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * envelope;
    view.setInt16(44 + (leadSamples + i) * 2, Math.round(sample * 0x6000), true);
  }
  return buf;
}

/** True once a gesture has built the session's audio objects. */
export function isCueUnlocked(): boolean {
  return ctx !== null || el !== null;
}

/** The canonical iOS WebAudio unlock: play one silent sample through the
 *  context inside the gesture. resume() alone is not always sufficient. */
function playSilentBuffer(context: MinimalAudioContext): void {
  try {
    const buffer = context.createBuffer(1, 1, 22050);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
  } catch {
    /* older engines without createBuffer — resume() is the best we can do */
  }
}

/**
 * Prepare the cue. MUST be called synchronously from a user gesture handler
 * (tap/click) — that is the entire point of this module. Idempotent: repeat
 * taps resume the existing context instead of stacking new ones.
 */
export function unlockCue(): void {
  if (typeof window === "undefined") return;

  if (ctx) {
    try {
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      /* context already closed by the OS; released on next releaseCue */
    }
    return;
  }

  try {
    const w = window as unknown as {
      AudioContext?: new () => MinimalAudioContext;
      webkitAudioContext?: new () => MinimalAudioContext;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (Ctor) {
      ctx = new Ctor();
      void ctx.resume();
      playSilentBuffer(ctx);
    }
  } catch (e) {
    ctx = null;
    lastError = e instanceof Error ? e.message : String(e);
  }

  try {
    const wav = buildBeepWav(BEEP_HZ, BEEP_MS);
    // Copy into a fresh ArrayBuffer — Blob rejects a Uint8Array view whose
    // buffer is larger than the view in some engines.
    const blob = new Blob([wav.slice()], { type: "audio/wav" });
    objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl) as unknown as MinimalAudioEl;
    audio.playsInline = true;
    audio.preload = "auto";
    // NOTE: iOS ignores assignment to HTMLMediaElement.volume. The lead-in
    // silence, not the volume, is what keeps priming inaudible.
    audio.volume = 1;
    el = audio;

    // Prime UNMUTED inside the gesture, then stop before the tone begins.
    const primed = audio.play();
    const settle = () => {
      audio.pause();
      audio.currentTime = 0;
    };
    if (primed && typeof primed.then === "function") {
      void primed.then(settle).catch((e: unknown) => {
        lastError = e instanceof Error ? e.message : String(e);
      });
    } else {
      settle();
    }
  } catch (e) {
    el = null;
    lastError = e instanceof Error ? e.message : String(e);
  }
}

/** WebAudio fallback for browsers where the media element cannot play. */
function oscillatorBeep(): void {
  if (!ctx) {
    lastPath = "none";
    return;
  }
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = BEEP_HZ;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + BEEP_MS / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination as never);
    osc.start();
    osc.stop(ctx.currentTime + BEEP_MS / 1000);
    lastPath = "oscillator";
  } catch (e) {
    lastPath = "none";
    lastError = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Fire the cue. Safe to call from a timer — it constructs nothing. Silent
 * no-op when the session was never unlocked by a gesture.
 */
export function fireCue(): void {
  try {
    const nav = typeof navigator === "undefined" ? undefined : navigator;
    nav?.vibrate?.(200);
  } catch {
    /* unsupported or blocked by permissions policy */
  }

  // Keep the context warm even when the media element is the audible path:
  // iOS suspends contexts while the tab is backgrounded.
  if (ctx) {
    try {
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      /* closed; oscillatorBeep re-checks before use */
    }
  }

  if (el) {
    try {
      el.currentTime = 0;
      el.muted = false;
      const played = el.play();
      lastPath = "media";
      if (played && typeof played.catch === "function") {
        void played.catch((e: unknown) => {
          lastError = e instanceof Error ? e.message : String(e);
          oscillatorBeep();
        });
      }
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      /* fall through to the oscillator */
    }
  }

  oscillatorBeep();
}

/** Tear down at logger close so a long-lived PWA does not leak contexts. */
export function releaseCue(): void {
  try {
    void ctx?.close();
  } catch {
    /* already closed */
  }
  try {
    el?.pause();
  } catch {
    /* detached */
  }
  try {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  } catch {
    /* no URL support in this environment */
  }
  ctx = null;
  el = null;
  objectUrl = null;
  lastPath = "none";
  lastError = null;
}
