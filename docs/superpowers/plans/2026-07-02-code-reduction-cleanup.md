# Code Reduction Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved Tiers 0–3 of the code-reduction spec — delete dead files, consolidate duplicated micro-helpers/types, collapse the chat-stream dispatch chain into a registry, and factor the 31 server/browser fetcher pairs — with zero behavior change.

**Architecture:** Pure refactor arc. Tier 0 is repo maintenance done directly on `main`'s working tree (no commit). Tiers 1–3 are risk-ordered commits on branch `chore/code-reduction-audit`. Every commit is gated by `npm run typecheck` + `npm run build`; touched test dirs additionally run vitest and the relevant `audit-*.mjs` scripts.

**Tech Stack:** Next.js 15, TypeScript strict, Supabase, vitest 4, node `--experimental-strip-types` audit scripts via `scripts/alias-loader.mjs`.

**Spec:** `docs/superpowers/specs/2026-07-02-code-reduction-cleanup-design.md`

## Global Constraints

- Zero behavior change anywhere. When old code and a "cleaner" version differ in any edge case, preserve the old behavior exactly (documented cases below: `olsSlope` returns `0` on zero x-variance; snapshot's `daysBetween` NaN comparison).
- The canonical daily-log row type is `DailyLog` in `lib/data/types.ts`. There is NO `DailyLogRow` there — do not add one. Local subsets become `Pick<DailyLog, …>`.
- Never run `git worktree remove --force` or `git branch -D`. Anything dirty/unmerged gets reported to the user, not deleted.
- All verification commands run from repo root `/Users/abdelouahedelbied/Health app`.
- Audit scripts run via: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/<name>.mjs`
- New date helpers must not introduce `new Date()` (argless) patterns — `node scripts/audit-timezone-usage.mjs` must stay green. Helpers that operate on passed-in ISO strings are fine.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 0: Tier 0 repo hygiene (no branch, no commit)

**Files:** none (git metadata + `.claude/worktrees/` only)

**Interfaces:**
- Consumes: nothing
- Produces: nothing code-visible; frees ~1.8 GB and deletes merged local branches

- [ ] **Step 1: Check every registered worktree for dirt**

```bash
cd "/Users/abdelouahedelbied/Health app"
git worktree list
for wt in .claude/worktrees/agent-a6e30b9783288deba .claude/worktrees/agent-abc5bf9a977aa3c7d ".claude/worktrees/feat+workout-logger" .claude/worktrees/feat-morning-intake-remi-carter-peter; do
  echo "== $wt =="; git -C "$wt" status --porcelain | head -5; echo "dirty-count: $(git -C "$wt" status --porcelain | wc -l | tr -d ' ')"
done
```

Expected: `dirty-count: 0` for each. **If any worktree is dirty: skip removing that one, list it in the final report to the user, and continue.** Note: only worktrees under `.claude/worktrees/` are in scope — do NOT touch `~/health-app-nora` or `~/Health-app-session-structure`.

- [ ] **Step 2: Remove clean registered worktrees**

```bash
for wt in .claude/worktrees/agent-a6e30b9783288deba .claude/worktrees/agent-abc5bf9a977aa3c7d ".claude/worktrees/feat+workout-logger" .claude/worktrees/feat-morning-intake-remi-carter-peter; do
  git worktree remove "$wt" && echo "removed $wt"
done
git worktree prune
```

Expected: `removed <path>` ×4 (minus any skipped as dirty). `git worktree list` afterwards shows only the main tree + the two external worktrees.

- [ ] **Step 3: Remove orphaned (unregistered) worktree dirs**

`happy-payne-f2f437` and `frosty-wozniak-98a3bd` exist in `.claude/worktrees/` but are NOT in `git worktree list` (orphaned). Verify each has no uncommitted work relative to its own HEAD, then delete:

```bash
for d in .claude/worktrees/happy-payne-f2f437 .claude/worktrees/frosty-wozniak-98a3bd; do
  if [ -d "$d" ]; then
    echo "== $d =="; git -C "$d" status --porcelain 2>/dev/null | wc -l
  fi
done
# Only for dirs reporting 0 (or where git status errors because the admin link is already gone
# AND `find $d -name '*.ts' -newer package.json` shows nothing newer than the main repo):
rm -rf .claude/worktrees/happy-payne-f2f437 .claude/worktrees/frosty-wozniak-98a3bd
git worktree prune
```

Expected: dirs gone; if either showed uncommitted changes, leave it and report.

- [ ] **Step 4: Delete local branches merged into main**

```bash
git branch --merged main | grep -vE '^\*|^\+|  main$' | xargs -n1 git branch -d
git branch | wc -l
```

Expected: ~44 `Deleted branch …` lines. `git branch -d` (not `-D`) refuses anything unmerged — if it refuses one, leave it and report. Branches checked out in the two external worktrees are prefixed `+` and excluded by the grep.

- [ ] **Step 5: Report disk reclaimed**

```bash
du -sh .claude/worktrees 2>/dev/null || echo ".claude/worktrees empty/gone"
```

Expected: dramatically below 1.8G (only skipped-dirty worktrees remain, if any).

---

### Task 1: Branch + Tier 1 whole-file deletions + CLAUDE.md fixes

**Files:**
- Delete: `_prototype.jsx`
- Delete: `components/trends/TrendsClient.tsx` (and the then-empty `components/trends/` dir)
- Modify: `CLAUDE.md:16` (test-suite claim), `CLAUDE.md:99` (prototype mention)

**Interfaces:**
- Consumes: nothing
- Produces: nothing (dead files by evidence; re-verify before deleting)

- [ ] **Step 1: Create the branch**

```bash
cd "/Users/abdelouahedelbied/Health app"
git checkout -b chore/code-reduction-audit
```

- [ ] **Step 2: Re-verify deletion evidence (must reproduce at execution time)**

```bash
grep -rn "_prototype" app lib components middleware.ts next.config.ts --include="*.ts*" ; echo "prototype refs exit: $?"
grep -rn "trends/TrendsClient" app lib components --include="*.ts*" ; echo "TrendsClient refs exit: $?"
```

Expected: no output, both exits `1` (no matches). **If either greps a real import, STOP this task and report — evidence changed since audit.** (Hits on `HealthTrendsClient` in `components/health/` do not count — different file; the path-qualified grep above excludes them.)

- [ ] **Step 3: Delete the files**

```bash
git rm _prototype.jsx
git rm components/trends/TrendsClient.tsx
rmdir components/trends 2>/dev/null; ls components/ | grep -c trends
```

Expected: `0` (dir gone).

- [ ] **Step 4: Fix CLAUDE.md line 16 (stale test-suite claim)**

Replace the sentence at line 16:

Old:
```
There is no test suite and no working linter (`npm run lint` invokes `next lint`, which is unconfigured and hangs on first-run interactive setup — treat it as a no-op). Verify changes with `typecheck` and exercise affected pages locally.
```

New:
```
Unit tests run via vitest (`npx vitest run`, config in [vitest.config.ts](vitest.config.ts) — node environment, `lib/**/__tests__/**/*.test.ts` glob only; components are not covered). There is no working linter (`npm run lint` invokes `next lint`, which is unconfigured and hangs on first-run interactive setup — treat it as a no-op). Verify changes with `typecheck` + `npx vitest run`, and exercise affected pages locally.
```

- [ ] **Step 5: Fix CLAUDE.md line 99 (prototype mention)**

Old:
```
**Single-user Next.js 15 (App Router) + Supabase + Vercel.** Originally a localStorage prototype (`_prototype.jsx`, retained for reference only — do not import). Every row is scoped to `auth.users.user_id` and protected by RLS.
```

New:
```
**Single-user Next.js 15 (App Router) + Supabase + Vercel.** Originally a localStorage prototype (removed 2026-07-02; see git history for `_prototype.jsx`). Every row is scoped to `auth.users.user_id` and protected by RLS.
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck && npm run build 2>&1 | tail -5
```

Expected: typecheck exits 0; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: delete dead files (_prototype.jsx, TrendsClient.tsx); fix stale CLAUDE.md claims

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: DailyLogRow → Pick<DailyLog, …> consolidation

**Files:**
- Modify: `lib/coach/snapshot.ts:72-95` (local `type DailyLogRow`)
- Modify: `lib/coach/intelligence/recovery-readiness.ts:20-29` (exported `DailyLogRow`)
- Modify: `lib/coach/intelligence/coach-history.ts:22-37` (local `DailyLogRow`)
- Modify: `lib/coach/intelligence/nutrition-performance-linker.ts:23-30` (exported `DailyLogRow`)

**Interfaces:**
- Consumes: `DailyLog` from `lib/data/types.ts` (canonical row type — verify each picked key exists on it before writing; if a key is missing from `DailyLog`, STOP and report rather than adding it)
- Produces: unchanged public API — `recovery-readiness.ts` and `nutrition-performance-linker.ts` keep exporting `DailyLogRow` (tests import it: `__tests__/recovery-readiness.test.ts:10`, `__tests__/nutrition-performance-linker.test.ts:10`)

- [ ] **Step 1: snapshot.ts — replace the literal type**

Replace the `type DailyLogRow = { … }` block (lines 72–95) with:

```typescript
/** Narrow daily_logs projection used by the snapshot. `calories_eaten` is
 *  nutrition intake (Yazio) — deliberately excludes the `calories` (energy
 *  burned) column, which surfaces elsewhere via strain/active metrics. */
type DailyLogRow = Pick<
  DailyLog,
  | "date" | "hrv" | "resting_hr" | "recovery" | "sleep_hours" | "sleep_score"
  | "deep_sleep_hours" | "strain" | "steps" | "calories_eaten" | "weight_kg"
  | "protein_g" | "carbs_g" | "fat_g" | "body_battery_low" | "body_battery_peak"
  | "stress_avg" | "stress_qualifier"
>;
```

Add to the existing imports: `import type { DailyLog } from "@/lib/data/types";` (merge into an existing import from that module if one exists).

- [ ] **Step 2: recovery-readiness.ts — same treatment, keep the export**

```typescript
export type DailyLogRow = Pick<
  DailyLog,
  | "date" | "hrv" | "resting_hr" | "recovery" | "sleep_hours" | "sleep_score"
  | "deep_sleep_hours" | "strain"
>;
```

- [ ] **Step 3: coach-history.ts — same treatment (stays local)**

```typescript
type DailyLogRow = Pick<
  DailyLog,
  | "date" | "hrv" | "resting_hr" | "recovery" | "sleep_hours" | "sleep_score"
  | "deep_sleep_hours" | "strain" | "steps" | "calories_eaten" | "weight_kg"
  | "protein_g" | "carbs_g" | "fat_g"
>;
```

- [ ] **Step 4: nutrition-performance-linker.ts — same treatment, keep the export**

```typescript
export type DailyLogRow = Pick<
  DailyLog,
  "date" | "calories_eaten" | "protein_g" | "carbs_g" | "fat_g" | "weight_kg"
>;
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npx vitest run lib/coach/intelligence
```

Expected: typecheck 0 errors (this is the proof the picked keys and nullability match `DailyLog` exactly); all intelligence tests pass. If typecheck reports a key missing on `DailyLog` or a nullability mismatch, STOP and report — do not widen either side.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/snapshot.ts lib/coach/intelligence/recovery-readiness.ts lib/coach/intelligence/coach-history.ts lib/coach/intelligence/nutrition-performance-linker.ts
git commit -m "refactor: derive local DailyLogRow subsets from canonical DailyLog via Pick

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Micro-helper consolidation (dates, grid rounding, OLS)

**Files:**
- Create: `lib/time/dates.ts`
- Create: `lib/time/__tests__/dates.test.ts`
- Modify: `lib/coach/prescription/calibrate-target.ts` (add `roundToStep` export next to `gridRoundDown`/`gridRoundUp`)
- Modify: `lib/coach/trends/linear-regression.ts` (add `olsSlope` export)
- Modify: `lib/coach/prescription/block-phase-rule.ts:136-138`, `lib/coach/prescription/autoregulation-rule.ts:85-87`, `lib/coach/block-outcomes/recalibrate-target.ts:44-46` (delete local rounders, import)
- Modify: `lib/coach/peter-dashboard/compose-energy.ts:126-129`, `compose-fatigue.ts:114-117`, `compose-plan-adherence.ts:121-124` (delete local `isoDaysAgo`, import)
- Modify: `lib/coach/snapshot.ts:132-141`, `lib/coach/peter-dashboard/compose-goal-distance.ts:179-184` (delete local `daysBetween`, import)
- Modify: `lib/coach/intelligence/body-comp-direction.ts:117-126`, `lib/coach/intelligence/nutrition-performance-linker.ts:103-112` (delete local `olsSlope`, import)

**Interfaces:**
- Consumes: existing `linearRegression(points)` in `lib/coach/trends/linear-regression.ts`
- Produces:
  - `isoDaysAgo(today: string, days: number): string` and `daysBetweenIso(fromIso: string, toIso: string): number | null` from `lib/time/dates.ts`
  - `roundToStep(kg: number, step: number): number` from `lib/coach/prescription/calibrate-target.ts`
  - `olsSlope(points: readonly { x: number; y: number }[]): number | null` from `lib/coach/trends/linear-regression.ts`

**Behavior-preservation notes (read before coding):**
1. The local `olsSlope` copies return `0` when x-variance is zero; `linearRegression` returns `null` in that case. The shared `olsSlope` must return `0` there.
2. `snapshot.ts`'s `daysBetween` returns plain `number` (NaN on garbage, which comparison-fails silently); the shared helper returns `number | null`. At snapshot's single call site (line 171), coalesce null to `0` so "unparseable date" still doesn't break the loop — identical observable behavior for valid DB dates.
3. `lib/coach/activity/sequence-week.ts:82-85` has a `daysBetween` that computes **circular week distance** — different math, DO NOT touch it.

- [ ] **Step 1: Write failing tests for the new shared helpers**

Create `lib/time/__tests__/dates.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { daysBetweenIso, isoDaysAgo } from "@/lib/time/dates";

describe("isoDaysAgo", () => {
  it("subtracts days from a YYYY-MM-DD anchor", () => {
    expect(isoDaysAgo("2026-07-02", 7)).toBe("2026-06-25");
  });
  it("crosses month boundaries", () => {
    expect(isoDaysAgo("2026-03-01", 1)).toBe("2026-02-28");
  });
  it("day 0 is identity", () => {
    expect(isoDaysAgo("2026-07-02", 0)).toBe("2026-07-02");
  });
});

describe("daysBetweenIso", () => {
  it("counts forward days", () => {
    expect(daysBetweenIso("2026-07-01", "2026-07-02")).toBe(1);
  });
  it("is negative when to < from", () => {
    expect(daysBetweenIso("2026-07-02", "2026-07-01")).toBe(-1);
  });
  it("returns null on unparseable input", () => {
    expect(daysBetweenIso("garbage", "2026-07-02")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/time`
Expected: FAIL — cannot resolve `@/lib/time/dates`.

- [ ] **Step 3: Implement `lib/time/dates.ts`**

```typescript
// lib/time/dates.ts
//
// Pure ISO-date (YYYY-MM-DD) arithmetic on PASSED-IN dates. Nothing here may
// read the wall clock — "today" always arrives as an argument, per the
// timezone single-source rule (see scripts/audit-timezone-usage.mjs).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO date `days` before `today` (a YYYY-MM-DD string). UTC-safe. */
export function isoDaysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (negative when toIso is earlier).
 *  Returns null when either input fails to parse. */
export function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / MS_PER_DAY);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/time`
Expected: 6 tests PASS.

- [ ] **Step 5: Add `roundToStep` to calibrate-target.ts**

Insert directly below the existing `gridRoundUp` function:

```typescript
/** Round to the NEAREST multiple of `step`. The shared implementation behind
 *  the per-lift equipment-grid rounding in block-phase-rule, autoregulation-
 *  rule, and block-outcomes/recalibrate-target. */
export function roundToStep(kg: number, step: number): number {
  return Math.round(kg / step) * step;
}
```

- [ ] **Step 6: Add `olsSlope` to linear-regression.ts**

Append to `lib/coach/trends/linear-regression.ts`:

```typescript
/** Slope-only OLS. NOTE the deliberate semantic difference from
 *  linearRegression: when all x values are identical (zero x-variance),
 *  this returns 0 — matching the intelligence composers' historical
 *  behavior — whereas linearRegression returns null. Returns null only
 *  when fewer than 2 points. */
export function olsSlope(points: readonly Point[]): number | null {
  if (points.length < 2) return null;
  const reg = linearRegression(points);
  return reg === null ? 0 : reg.slope;
}
```

- [ ] **Step 7: Point the nine consumer sites at the shared helpers**

For each file: delete the local helper function, add the import, leave call sites untouched unless noted.

1. `lib/coach/prescription/block-phase-rule.ts` — delete local `roundToStep` (lines 136–138); add `import { roundToStep } from "@/lib/coach/prescription/calibrate-target";` (merge if it already imports from that module).
2. `lib/coach/prescription/autoregulation-rule.ts` — delete local `roundToStep` (lines 85–87); same import.
3. `lib/coach/block-outcomes/recalibrate-target.ts` — delete local `roundToGrid` (lines 44–46); add the same import and rename its call site `roundToGrid(raw, STEP_FOR_LIFT[lift])` → `roundToStep(raw, STEP_FOR_LIFT[lift])`.
4. `lib/coach/peter-dashboard/compose-energy.ts` — delete local `isoDaysAgo`; add `import { isoDaysAgo } from "@/lib/time/dates";`
5. `lib/coach/peter-dashboard/compose-fatigue.ts` — same.
6. `lib/coach/peter-dashboard/compose-plan-adherence.ts` — same.
7. `lib/coach/peter-dashboard/compose-goal-distance.ts` — delete local `daysBetween` (lines 179–184); add `import { daysBetweenIso } from "@/lib/time/dates";` and rename its call sites `daysBetween(` → `daysBetweenIso(` (signature and null-return semantics are identical to the deleted local).
8. `lib/coach/snapshot.ts` — delete local `daysBetween` (the function at lines 132–141, keep its doc comment context if any); add `import { daysBetweenIso } from "@/lib/time/dates";` and change the single call site at line 171 from
   `if (daysBetween(asOf, w.date) > CURRENT_LIFT_WINDOW_DAYS) break;` to
   `if ((daysBetweenIso(asOf, w.date) ?? 0) > CURRENT_LIFT_WINDOW_DAYS) break;`
   (`?? 0` preserves the old NaN-comparison behavior: unparseable dates never trigger the break.)
9. `lib/coach/intelligence/body-comp-direction.ts` and `lib/coach/intelligence/nutrition-performance-linker.ts` — delete each local `olsSlope`; add `import { olsSlope } from "@/lib/coach/trends/linear-regression";`. Call sites take `{x, y}[]` which satisfies `readonly Point[]` — no changes.

- [ ] **Step 8: Verify — typecheck, tests, audits**

```bash
npm run typecheck
npx vitest run lib/time lib/coach/intelligence
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
node scripts/audit-timezone-usage.mjs
```

Expected: typecheck 0 errors; all vitest suites pass; prescription audit prints its full pass count (83 assertions, 0 failed); timezone audit green.

- [ ] **Step 9: Commit**

```bash
git add lib/time lib/coach/prescription lib/coach/block-outcomes lib/coach/peter-dashboard lib/coach/snapshot.ts lib/coach/trends/linear-regression.ts lib/coach/intelligence
git commit -m "refactor: consolidate duplicated micro-helpers (isoDaysAgo, daysBetweenIso, roundToStep, olsSlope)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Test-helper consolidation (`daysAgo`)

**Files:**
- Modify: `lib/coach/intelligence/__tests__/fixtures.ts:18` (export the existing `daysAgo`)
- Modify: `lib/coach/intelligence/__tests__/orchestrator.test.ts:22`, `nutrition-performance-linker.test.ts:20`, `body-comp-direction.test.ts:21`, `interference-checker.test.ts:21` (delete locals, import)

**Interfaces:**
- Consumes: nothing new
- Produces: `daysAgo(n: number, base?: string): string` exported from `lib/coach/intelligence/__tests__/fixtures.ts`

- [ ] **Step 1: Widen and export the fixtures copy**

In `fixtures.ts`, replace the local `daysAgo` (line 18) with:

```typescript
/** ISO date N days before `base` (defaults to 2026-06-26, "today" in these fixtures). */
export function daysAgo(n: number, base = "2026-06-26"): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
```

(The optional `base` param matches `orchestrator.test.ts`'s superset signature; the other three call it with one arg — identical output.)

- [ ] **Step 2: Replace the four local copies with imports**

In each of `orchestrator.test.ts`, `nutrition-performance-linker.test.ts`, `body-comp-direction.test.ts`, `interference-checker.test.ts`: delete the local `function daysAgo…` and add `daysAgo` to the existing `import … from "./fixtures"` (or add that import line if the file doesn't import fixtures yet).

- [ ] **Step 3: Verify**

Run: `npx vitest run lib/coach/intelligence`
Expected: all tests pass, same counts as Task 3's run.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/intelligence/__tests__
git commit -m "refactor(tests): share daysAgo via intelligence fixtures

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Audit-script reporter consolidation (pure scripts only)

**Files:**
- Create: `scripts/audit-utils.mjs`
- Modify: `scripts/audit-prescription-rules.mjs`, `scripts/audit-block-outcomes-rules.mjs`, `scripts/audit-endurance-pure.mjs`, `scripts/audit-time-helpers.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `createAuditReporter(): { assert(name: string, cond: boolean, detail?: string): void; summary(label?: string): { pass: number; fail: number } }` from `scripts/audit-utils.mjs`

Scope guard: ONLY these four no-DB scripts. DB-bound audit scripts (`audit-food-aggregation`, `audit-endurance-ingest`, etc.) are untouched in this arc.

- [ ] **Step 1: Record each script's current output as baseline**

```bash
for s in audit-prescription-rules audit-block-outcomes-rules audit-endurance-pure audit-time-helpers; do
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/$s.mjs > "/private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/$s.before.txt" 2>&1; echo "$s exit=$?"
done
grep -hE 'pass|fail|✓|✗' /private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/*.before.txt | grep -cE '✓'
```

Expected: all four exit 0; note the total ✓ count.

- [ ] **Step 2: Write `scripts/audit-utils.mjs`**

```javascript
// scripts/audit-utils.mjs
//
// Shared reporter for the fixture-based (no-DB) audit scripts. Each script
// creates its own reporter; `summary()` prints totals and sets a non-zero
// exit code on any failure so CI/manual runs surface red.

export function createAuditReporter() {
  let pass = 0;
  let fail = 0;

  function assert(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  }

  function summary(label = "audit") {
    console.log(`\n${label}: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
    return { pass, fail };
  }

  return { assert, summary };
}
```

- [ ] **Step 3: Migrate the four scripts**

In each script: delete the local `let pass = 0; let fail = 0;` and `function assert(...) {...}` block; add at the top of the imports:

```javascript
import { createAuditReporter } from "./audit-utils.mjs";

const { assert, summary } = createAuditReporter();
```

At the end of each script, replace its hand-rolled final tally (whatever prints pass/fail counts and sets the exit code — read each script's tail before editing) with a single `summary("<script name>")` call. Preserve any extra epilogue output the script prints beyond the tally.

- [ ] **Step 4: Verify — identical assertion counts**

```bash
for s in audit-prescription-rules audit-block-outcomes-rules audit-endurance-pure audit-time-helpers; do
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/$s.mjs > "/private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/$s.after.txt" 2>&1; echo "$s exit=$?"
  diff <(grep -c '✓' "/private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/$s.before.txt") <(grep -c '✓' "/private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/$s.after.txt") && echo "$s: counts identical"
done
```

Expected: all exit 0, `counts identical` ×4. Any drop in ✓ count = a lost assertion — fix before committing.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit-utils.mjs scripts/audit-prescription-rules.mjs scripts/audit-block-outcomes-rules.mjs scripts/audit-endurance-pure.mjs scripts/audit-time-helpers.mjs
git commit -m "refactor(scripts): shared createAuditReporter for pure audit scripts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: chat-stream executor dispatch → registry

**Files:**
- Modify: `lib/coach/chat-stream.ts:586-1004` (the 75-branch `if (block.name === …)` chain)

**Interfaces:**
- Consumes: every `execute*` import already at the top of chat-stream.ts (unchanged)
- Produces: module-private `TOOL_EXECUTORS: Record<string, (a: ToolExecArgs) => Promise<ToolResult<unknown>>>` — nothing exported; external behavior identical

**Rules (non-negotiable):**
- Each registry entry's body is the OLD branch body copied verbatim — only the identifiers change (`opts.sr` → `a.sr` is NOT done; instead the ctx carries `opts` whole, see below). No "improvements."
- `modeAllowsTool`, `PERSIST_RESULT_TOOLS`, the invocation counter, `tool_call_start`/`tool_call_end` yields, and error handling stay exactly where they are in the loop.
- The chain's final `else` (unknown tool) body is preserved verbatim as the registry-miss path.

- [ ] **Step 1: Read the full dispatch region and catalog branch shapes**

Read `lib/coach/chat-stream.ts:560-1035`. Confirm: (a) the exact type of the function's `opts` parameter and the `speaker` variable, (b) which branches use anything beyond `opts.sr` / `opts.userId` / `block.input` / `speaker` (known: `query_daily_logs` uses `colsForSpeaker(speaker)`; the intake cluster at lines ~866-885 is one grouped branch — note what it calls), (c) the final `else` body.

- [ ] **Step 2: Define the ctx type and registry above the loop's enclosing function**

```typescript
/** Everything a tool executor closure may reference. `opts` is passed whole so
 *  entries can read the same fields the old if/else branches did. */
type ToolExecArgs = {
  opts: <the existing opts parameter type — reuse its real name>;
  speaker: <the existing Speaker type>;
  input: Record<string, unknown>;
};

const TOOL_EXECUTORS: Record<
  string,
  (a: ToolExecArgs) => Promise<ToolResult<unknown>>
> = {
  query_daily_logs: (a) =>
    executeQueryDailyLogs({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
      allowedColumns: colsForSpeaker(a.speaker),
    }),
  query_workouts: (a) =>
    executeQueryWorkouts({ supabase: a.opts.sr, userId: a.opts.userId, input: a.input }),
  query_food_log: (a) =>
    executeQueryFoodLog({ supabase: a.opts.sr, userId: a.opts.userId, input: a.input }),
  // …one entry per remaining branch, body copied verbatim with
  // opts→a.opts, speaker→a.speaker, block.input→a.input substitutions…
};
```

For the grouped intake-cluster branch (`apply_goal_target | apply_bedtime_correction | … | propose_plan | commit_plan | set_glp1_status`): create one shared arrow function const and assign it to each of those keys, e.g.

```typescript
const runIntakeTool = (a: ToolExecArgs) => /* verbatim old grouped-branch body */;
// in the registry:
apply_goal_target: runIntakeTool,
apply_bedtime_correction: runIntakeTool,
// …etc for every name in the old grouped condition.
```

If any branch turns out to reference a loop-local variable that isn't `opts`/`speaker`/`block.input` (discovered in Step 1), add that field to `ToolExecArgs` and thread it at the call site — do NOT restructure the loop to avoid it.

- [ ] **Step 3: Replace the chain with the lookup**

Inside the loop's `try`, the entire `if/else if` chain becomes:

```typescript
const exec = TOOL_EXECUTORS[block.name];
if (exec) {
  result = await exec({
    opts,
    speaker,
    input: (block.input ?? {}) as Record<string, unknown>,
  });
} else {
  // verbatim old final-else body (unknown tool result shape)
}
```

- [ ] **Step 4: Cross-check branch coverage mechanically**

```bash
git show HEAD:lib/coach/chat-stream.ts | grep -oE 'block\.name === "[a-z_]+"' | grep -oE '"[a-z_]+"' | sort > /private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/branches.before.txt
grep -oE '^  [a-z_]+:' lib/coach/chat-stream.ts | tr -d ' :' | sort > /private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/registry.after.txt
wc -l /private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/branches.before.txt /private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/3c8a7dbf-a685-45d4-8392-8379bdcc9cb4/scratchpad/registry.after.txt
```

Expected: every quoted name from the old chain (75, after dedup of the grouped names) appears as a registry key. Manually diff the two lists — zero missing names. (The grep patterns may need adjusting to the final formatting; the requirement is the list comparison, not the exact command.)

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run build 2>&1 | tail -5
```

Expected: clean. Then a manual smoke: `npm run dev`, open `/coach`, send Peter a message that triggers a tool (e.g. "what was my HRV this week?") and confirm a normal tool-using reply streams back.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "refactor(chat): collapse 75-branch tool dispatch into executor registry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Server/browser fetcher factory

**Files:**
- Create: `lib/query/fetchers/create-fetcher.ts`
- Modify (proof-of-concept trio): `lib/query/fetchers/dailyLogs.ts`, `lib/query/fetchers/workouts.ts`, `lib/query/fetchers/checkin.ts`
- Modify (rollout): every remaining file in `lib/query/fetchers/` that exports a `…Server`/`…Browser` pair whose bodies are identical modulo client origin

**Interfaces:**
- Consumes: `createSupabaseBrowserClient` from `lib/supabase/client.ts`; `SupabaseClient` type from `@supabase/supabase-js`
- Produces: `createFetcher<Args, T>(queryFn): { server; browser }` — AND every existing `fetch*Server` / `fetch*Browser` export name preserved exactly (hooks and pages import them by name; zero call-site churn is the acceptance bar)

**Skip rules:** `peterDashboard.server.ts`/`peterDashboard.ts` and `todayTargets.server.ts`/`todayTargets.ts` are deliberate single-variant split files — skip. Any pair whose two bodies genuinely differ beyond client origin — skip and list in the commit message.

- [ ] **Step 1: Implement the factory**

```typescript
// lib/query/fetchers/create-fetcher.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Collapses the server/browser fetcher pair pattern. The server variant is
 * the query function itself (caller supplies the cookie-bound SSR client);
 * the browser variant self-constructs the browser client and delegates.
 * Both variants therefore share ONE query body — the select string and
 * error handling can no longer drift between them.
 *
 * Both variants throw on Supabase errors (the query body must `throw error`)
 * so TanStack Query lights up `isError` — same contract as before.
 */
export function createFetcher<Args extends unknown[], T>(
  queryFn: (supabase: SupabaseClient, ...args: Args) => Promise<T>,
): {
  server: (supabase: SupabaseClient, ...args: Args) => Promise<T>;
  browser: (...args: Args) => Promise<T>;
} {
  return {
    server: queryFn,
    browser: (...args: Args) => queryFn(createSupabaseBrowserClient(), ...args),
  };
}
```

- [ ] **Step 2: Convert dailyLogs.ts (both pairs) as the canonical example**

The wide-projection pair becomes:

```typescript
const dailyLogs = createFetcher(
  async (supabase: SupabaseClient, userId: string, from: string, to: string): Promise<DailyLog[]> => {
    const { data, error } = await supabase
      .from("daily_logs")
      .select(COLS)
      .eq("user_id", userId)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true });
    if (error) throw error;
    return (data ?? []) as DailyLog[];
  },
);

/** Server-side variant — uses the SSR Supabase client (cookie-bound, RLS). */
export const fetchDailyLogsServer = dailyLogs.server;
/** Browser-side variant — uses the browser Supabase client (cookie-bound, RLS). */
export const fetchDailyLogsBrowser = dailyLogs.browser;
```

Same treatment for the `TREND_COLS` pair → `fetchDailyLogsTrendServer` / `fetchDailyLogsTrendBrowser`. Keep `COLS`, `TREND_COLS`, `TrendLog`, and all doc comments (the COLS drift warning comment is load-bearing).

- [ ] **Step 3: Convert workouts.ts and checkin.ts the same way, then verify the trio**

```bash
npm run typecheck && npm run build 2>&1 | tail -5
```

Expected: clean — proves preserved export names satisfy every hook/page import.

- [ ] **Step 4: Roll out to the remaining pair files**

Work through `lib/query/fetchers/` alphabetically (`athleteProfile.ts`, `blockHistory.ts`, `blockProgress.ts`, `bodyMeasurements.ts`, `checkinsRange.ts`, `coachRecent.ts`, `coachTrends.ts`, `enduranceActivities.ts`, `foodEntries.ts`, `foodHistory.ts`, `foodItemFavorites.ts`, `foodLibrary.ts`, `healthTrend.ts`, `ingestToken.ts`, `intakeState.ts`, `labAcknowledgments.ts`, `last7.ts`, `latestWeight.ts`, `loadWorkouts.ts`, `muscleVolume.ts`, `previousSet.ts`, `profile.ts`, `recentE1RMs.ts`, `recoveryIntelligence.ts`, `strengthInsights.ts`, `symptomLog.ts`, `todayBrief.ts`, `trainingWeek.ts`, `userFoodItems.ts`, `userSessionTemplates.ts`, `weeklyReview.ts`, `whoopTokens.ts`, `withingsTokens.ts`). For each: if it contains a Server/Browser pair identical modulo client → convert exactly like Step 2 (preserve export names + doc comments); otherwise skip and note. Run `npm run typecheck` after every 5 files so a mistake is localized.

- [ ] **Step 5: Final verify**

```bash
npm run typecheck && npm run build 2>&1 | tail -5 && npx vitest run
```

Expected: all clean. Then dev-server smoke: load `/` (dashboard tiles populate) and `/health?tab=trends` (charts render) — both exercise converted fetchers through hydration + browser refetch paths.

- [ ] **Step 6: Commit**

```bash
git add lib/query/fetchers
git commit -m "refactor(query): single-body fetchers via createFetcher factory (skipped: <list any non-pair files skipped>)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Final verification, line-count receipt, PR

**Files:** none new

- [ ] **Step 1: Full gate run**

```bash
npm run typecheck && npm run build 2>&1 | tail -5 && npx vitest run
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs | tail -3
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs | tail -3
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs | tail -3
node scripts/audit-timezone-usage.mjs
```

Expected: everything green, 0 failed assertions anywhere.

- [ ] **Step 2: Produce the reduction receipt**

```bash
git diff --stat main...HEAD | tail -3
```

Expected: net negative on the order of −2,500 to −3,000 lines. Include the actual numbers in the PR body.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin chore/code-reduction-audit
gh pr create --title "chore: code reduction cleanup (tiers 1-3)" --body "$(cat <<'EOF'
Executes docs/superpowers/specs/2026-07-02-code-reduction-cleanup-design.md (Tiers 1–3; Tier 0 hygiene done directly).

- Delete `_prototype.jsx` (2,302 lines) + orphaned `components/trends/TrendsClient.tsx` (134); fix stale CLAUDE.md claims (vitest exists)
- `DailyLogRow` locals → `Pick<DailyLog, …>` (4 files)
- Shared `isoDaysAgo` / `daysBetweenIso` (lib/time/dates.ts, tested), `roundToStep`, `olsSlope` — 9 duplicate helpers deleted, behavior-preserving (olsSlope keeps 0-on-zero-variance)
- Shared `createAuditReporter` across the 4 pure audit scripts (identical assertion counts verified)
- chat-stream: 75-branch tool dispatch → executor registry (verbatim bodies, mechanical coverage diff)
- lib/query/fetchers: server/browser pairs → `createFetcher` factory, export names preserved (zero call-site churn)

Gates: typecheck, prod build, vitest, audit-prescription-rules (83), audit-block-outcomes-rules, audit-endurance-pure, audit-timezone-usage — all green.

Net: <insert git diff --stat numbers>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Report to user** — PR link, reduction numbers, disk reclaimed in Task 0, and any items skipped-and-surfaced (dirty worktrees, unmergeable branches, non-pair fetchers, evidence mismatches).
