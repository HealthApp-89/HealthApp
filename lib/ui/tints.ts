import type { CSSProperties } from "react";

import { FIELDS, WCOLORS } from "./colors";

export type TintKey =
  | "recovery"
  | "strain"
  | "sleep"
  | "deep_sleep"
  | "rem_sleep"
  | "nutrition"
  | "steps"
  | "heart"
  | "weight"
  | "body_fat"
  | "coach"
  | "neutral";

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(HEX);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Soft diagonal gradient + matching hairline border that picks up the tint hue. */
export function tintStyle(
  color: string,
  opts: { strength?: number; border?: boolean } = {},
): CSSProperties {
  const rgb = hexToRgb(color);
  if (!rgb) return {};
  const [r, g, b] = rgb;
  const s = opts.strength ?? 1;
  const a1 = (0.10 * s).toFixed(3);
  const a2 = (0.02 * s).toFixed(3);
  const style: CSSProperties = {
    background: `linear-gradient(135deg, rgba(${r},${g},${b},${a1}), rgba(${r},${g},${b},${a2}))`,
  };
  if (opts.border !== false) {
    style.borderColor = `rgba(${r},${g},${b},${(0.18 * s).toFixed(3)})`;
  }
  return style;
}

const TINT_COLORS: Record<TintKey, string> = {
  recovery: "#30d158",
  strain: "#ff9f0a",
  sleep: "#5e5ce6",
  deep_sleep: "#0a84ff",
  rem_sleep: "#bf5af2",
  nutrition: "#ffd60a",
  steps: "#30d158",
  heart: "#ff453a",
  weight: "#af52de",
  body_fat: "#ff9500",
  coach: "#5e5ce6",
  neutral: "#ffffff",
};

/** Look up a tint by semantic key (recovery, strain, sleep, …). */
export function tintByKey(key: TintKey, opts?: { strength?: number; border?: boolean }): CSSProperties {
  return tintStyle(TINT_COLORS[key], opts);
}

/** Resolve the canonical color for a daily-log field key, e.g. "hrv" → "#0a84ff". */
export function fieldColor(key: string): string | undefined {
  return FIELDS.find((f) => f.k === key)?.c;
}

/** Tint helper for muscle groups used on the strength page. */
export function tintByMuscle(muscle: string, opts?: { strength?: number; border?: boolean }): CSSProperties {
  const c = WCOLORS[muscle] ?? WCOLORS.Other;
  return tintStyle(c, opts);
}
