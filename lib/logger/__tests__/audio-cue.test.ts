// lib/logger/__tests__/audio-cue.test.ts
//
// Regression tests for the rest-done cue. The original implementation
// (rest-timer.ts fireRestDoneCue, shipped 5111bf0) constructed a fresh
// AudioContext *inside the 250ms countdown interval* — minutes after the last
// tap. iOS only permits audio from a context created or resumed synchronously
// within a user-gesture handler, so that context started suspended and emitted
// silence. The cue never worked on iPhone.
//
// The load-bearing assertion here is `fireCue()` must NEVER construct an
// AudioContext: the context is built once, inside a gesture, by unlockCue().

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildBeepWav,
  unlockCue,
  fireCue,
  releaseCue,
  isCueUnlocked,
} from "@/lib/logger/audio-cue";

class FakeGain {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class FakeOsc {
  frequency = { value: 0 };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeCtx {
  static instances: FakeCtx[] = [];
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  destination = {};
  resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });
  createOscillator = vi.fn(() => new FakeOsc());
  createGain = vi.fn(() => new FakeGain());
  constructor() {
    FakeCtx.instances.push(this);
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  muted = false;
  playsInline = false;
  preload = "";
  volume = 1;
  currentTime = 0;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
}

function installBrowserFakes(opts: { vibrate?: boolean } = {}) {
  FakeCtx.instances = [];
  FakeAudio.instances = [];
  vi.stubGlobal("window", { AudioContext: FakeCtx });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal(
    "navigator",
    opts.vibrate === false ? {} : { vibrate: vi.fn(() => true) },
  );
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:beep"),
    revokeObjectURL: vi.fn(),
  });
}

beforeEach(() => {
  installBrowserFakes();
});

afterEach(() => {
  releaseCue();
  vi.unstubAllGlobals();
});

describe("buildBeepWav", () => {
  it("emits a valid 16-bit mono PCM RIFF/WAVE container", () => {
    const wav = buildBeepWav(880, 250, 8000);
    const ascii = (o: number, n: number) =>
      String.fromCharCode(...wav.slice(o, o + n));
    const u32 = (o: number) =>
      wav[o] | (wav[o + 1] << 8) | (wav[o + 2] << 16) | (wav[o + 3] << 24);
    const u16 = (o: number) => wav[o] | (wav[o + 1] << 8);

    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");

    expect(u16(20)).toBe(1); // PCM
    expect(u16(22)).toBe(1); // mono
    expect(u32(24)).toBe(8000); // sample rate
    expect(u16(34)).toBe(16); // bits per sample

    // 250ms @ 8kHz mono 16-bit = 2000 samples = 4000 data bytes + 44 header.
    const dataBytes = 2000 * 2;
    expect(u32(40)).toBe(dataBytes);
    expect(u32(4)).toBe(36 + dataBytes);
    expect(wav.length).toBe(44 + dataBytes);
  });

  it("produces an audible (non-silent) waveform", () => {
    const wav = buildBeepWav(880, 250, 8000);
    const peak = Math.max(...Array.from(wav.slice(44, 244)));
    expect(peak).toBeGreaterThan(0);
  });
});

describe("unlockCue", () => {
  it("is a no-op outside the browser", () => {
    vi.stubGlobal("window", undefined);
    expect(() => unlockCue()).not.toThrow();
    expect(isCueUnlocked()).toBe(false);
  });

  it("builds and resumes exactly one AudioContext", () => {
    unlockCue();
    expect(FakeCtx.instances).toHaveLength(1);
    expect(FakeCtx.instances[0].resume).toHaveBeenCalled();
    expect(isCueUnlocked()).toBe(true);
  });

  it("primes a playsinline media element muted, so later plays need no gesture", () => {
    unlockCue();
    expect(FakeAudio.instances).toHaveLength(1);
    const el = FakeAudio.instances[0];
    expect(el.src).toBe("blob:beep");
    expect(el.playsInline).toBe(true);
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — repeat gestures never stack contexts or elements", () => {
    unlockCue();
    unlockCue();
    unlockCue();
    expect(FakeCtx.instances).toHaveLength(1);
    expect(FakeAudio.instances).toHaveLength(1);
  });
});

describe("fireCue", () => {
  it("NEVER constructs an AudioContext — the iOS regression", () => {
    unlockCue();
    expect(FakeCtx.instances).toHaveLength(1);
    fireCue();
    fireCue();
    fireCue();
    expect(FakeCtx.instances).toHaveLength(1);
  });

  it("replays the primed media element from the start", async () => {
    unlockCue();
    const el = FakeAudio.instances[0];
    await Promise.resolve(); // let the priming pause/reset settle
    el.play.mockClear();
    el.currentTime = 9;
    fireCue();
    expect(el.currentTime).toBe(0);
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it("unmutes before the first real play — priming must not silence the cue", async () => {
    unlockCue();
    const el = FakeAudio.instances[0];
    await Promise.resolve();
    fireCue();
    expect(el.muted).toBe(false);
  });

  it("resumes a context the OS suspended while backgrounded", async () => {
    unlockCue();
    const ctx = FakeCtx.instances[0];
    await Promise.resolve();
    ctx.state = "suspended";
    ctx.resume.mockClear();
    fireCue();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it("vibrates where supported", () => {
    unlockCue();
    fireCue();
    expect(navigator.vibrate).toHaveBeenCalledWith(200);
  });

  it("does not throw on iOS, where navigator.vibrate does not exist", () => {
    installBrowserFakes({ vibrate: false });
    unlockCue();
    expect(() => fireCue()).not.toThrow();
  });

  it("stays silent and safe when never unlocked", () => {
    expect(() => fireCue()).not.toThrow();
    expect(FakeCtx.instances).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(0);
  });
});

describe("releaseCue", () => {
  it("closes the context and revokes the blob so sessions do not leak", () => {
    unlockCue();
    const ctx = FakeCtx.instances[0];
    releaseCue();
    expect(ctx.close).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:beep");
    expect(isCueUnlocked()).toBe(false);
  });

  it("is safe to call twice", () => {
    unlockCue();
    releaseCue();
    expect(() => releaseCue()).not.toThrow();
  });
});
