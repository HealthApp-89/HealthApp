// lib/logger/__tests__/hook-order.test.ts
//
// Regression guard for React error #310 (changed hook order) in the workout
// logger. The 2026-06-26 perf refactor added four `useCallback` hooks AFTER
// the component's `if (!draft) return <Loading/>` early return. Because `draft`
// starts null and loads asynchronously, the first render took the early return
// (skipping those hooks) and the post-load render ran them — changing the hook
// count between renders and crashing the logger on "Start session".
//
// This project has no jsdom/RTL render harness (vitest runs in `node` env), so
// this is a static guard: it asserts no React hook is invoked after the first
// guard `return` in the LoggerSheet component body. The Rules of Hooks require
// every hook to run on every render, i.e. before any early return.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const FILE = path.resolve(
  __dirname,
  "../../../components/logger/LoggerSheet.tsx",
);

/** Strip `//` line comments and `/* *\/` block comments so hook-like tokens in
 *  prose (e.g. "React.memo on ExerciseCard") never trip the scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const HOOK_CALL = /\buse[A-Z]\w*\s*\(/g;

describe("LoggerSheet hook order (React #310 regression)", () => {
  const raw = readFileSync(FILE, "utf8");
  const src = stripComments(raw);

  it("declares every React hook before the component's first early return", () => {
    // Scope to the LoggerSheet component function body (helpers/nested
    // components like ElapsedTimer appear earlier and are out of scope).
    const compStart = src.indexOf("export function LoggerSheet");
    expect(compStart).toBeGreaterThan(-1);
    const body = src.slice(compStart);

    // The first guard return in the component: `if (!draft)` (loading) or the
    // resume-prompt return. Anchor on the earliest of the two.
    const guardIdxs = [
      body.indexOf("if (resumePrompt && !draft)"),
      body.indexOf("if (!draft) {"),
    ].filter((i) => i > -1);
    expect(guardIdxs.length).toBeGreaterThan(0);
    const firstGuard = Math.min(...guardIdxs);

    const afterGuard = body.slice(firstGuard);
    const offending = afterGuard.match(HOOK_CALL) ?? [];

    // setX state setters are not hooks; HOOK_CALL only matches `useXxx(` so
    // those are already excluded. Any match here is a real Rules-of-Hooks bug.
    expect(
      offending,
      `Found ${offending.length} React hook call(s) after the first early return in LoggerSheet: ${offending.join(", ")}. ` +
        `Hooks must be declared before any conditional return (React error #310). Move them above the early returns.`,
    ).toEqual([]);
  });
});
