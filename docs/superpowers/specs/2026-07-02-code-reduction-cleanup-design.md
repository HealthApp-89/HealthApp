# Code Reduction Cleanup — Design

**Date:** 2026-07-02
**Status:** Approved scope: Tiers 0–3. Tier 4 (big decompositions) explicitly deferred to a future spec.

## Background

An independent four-dimension audit (dead code, duplication, oversized files, dependency/config bloat) of the ~208k-line codebase found it **concentrated, not bloated**: near-zero dead code, all dependencies used, config minimal. The reducible weight sits in two whole-file deletions, a set of duplicated micro-helpers, one 450-line dispatch chain, and 31 near-identical fetcher pairs — plus 1.8 GB of stale git worktrees.

Baseline at audit time: `tsc --noEmit` clean, all documented audit scripts assumed green.

## Scope

### Tier 0 — Repo hygiene (direct, no PR)

1. **Remove stale worktrees** under `.claude/worktrees/` (6 entries, ~1.8 GB total, two ~835 MB with their own `node_modules`). Procedure per worktree: `git -C <worktree> status --porcelain` — if clean, `git worktree remove <path>`; if dirty, STOP and surface to the user (never `--force`). Follow with `git worktree prune`.
2. **Delete local branches already merged into `main`** (44 at audit time): `git branch --merged main`, exclude `main`, delete. Remote branches untouched.

### Tier 1 — Whole-file deletions (branch, commit 1)

| File | Evidence | Lines |
|---|---|---|
| `_prototype.jsx` | Zero imports anywhere; port complete; git history preserves it | 2,302 |
| `components/trends/TrendsClient.tsx` (+ now-empty `components/trends/` dir) | Only grep hits for "TrendsClient" are the differently-named `HealthTrendsClient` in `components/health/`; sole file in its directory | 134 |

Also in this commit: **fix stale CLAUDE.md claims** —
- "There is no test suite" → vitest 4.x is installed with ~30 real test files under `lib/**/__tests__/` (`vitest.config.ts` globs `lib/**/__tests__/**/*.test.ts`). Document how to run them.
- Remove the CLAUDE.md sentence describing `_prototype.jsx` as retained (it is being deleted).

### Tier 2 — Easy consolidations (branch, commit 2)

1. **`DailyLogRow` deduplication** — ~5 local redeclarations (in `lib/coach/snapshot.ts`, `lib/coach/intelligence/coach-history.ts`, `lib/coach/intelligence/nutrition-performance-linker.ts`, `lib/coach/intelligence/recovery-readiness.ts`, +1) replaced by imports from `lib/data/types.ts`. Caveat: local types may be *narrower* than the canonical row; where a local type is a deliberate subset, use `Pick<DailyLogRow, ...>` from the canonical type rather than forcing the full row. ~80 lines + kills schema-drift risk.
2. **Micro-helper consolidation** (~40 lines):
   - `gridRound` family: `roundToStep` in `lib/coach/prescription/block-phase-rule.ts` and `autoregulation-rule.ts`, `roundToGrid` in `lib/coach/block-outcomes/recalibrate-target.ts` → consolidate into `lib/coach/prescription/calibrate-target.ts` (already exports `gridRoundDown`/`gridRoundUp`; add nearest-rounding export).
   - `isoDaysAgo` ×3 (peter-dashboard `compose-energy` / `compose-fatigue` / `compose-plan-adherence`) → one shared helper in `lib/time/`.
   - `daysBetween` ×2 (`lib/coach/snapshot.ts`, `lib/coach/peter-dashboard/compose-goal-distance.ts`) → shared `daysBetweenIso` in `lib/time/`. The circular-distance `daysBetween` in `lib/coach/activity/sequence-week.ts` is different math — stays local.
   - `olsSlope` ×2 (`lib/coach/intelligence/body-comp-direction.ts`, `nutrition-performance-linker.ts`) → thin `olsSlope` export added to `lib/coach/trends/linear-regression.ts` (the authoritative implementation).
   - Timezone rule applies: any consolidated date helper must not introduce `new Date().toISOString().slice(0,10)`-style patterns — `scripts/audit-timezone-usage.mjs` is the gate. Helpers operating on *passed-in* ISO dates are fine.
3. **Test-helper consolidation** — `daysAgo`/`approx` repeated across `lib/coach/intelligence/__tests__/` → `__tests__/test-utils.ts`.
4. **Audit-script boilerplate** — create `scripts/audit-utils.mjs` (`assert`, pass/fail counters, report). Migrate **only the pure fixture-based scripts** (no-DB: e.g. `audit-prescription-rules.mjs`, `audit-block-outcomes-rules.mjs`, `audit-endurance-pure.mjs`, `audit-time-helpers.mjs`) and run each after migration to prove identical assertion counts. DB-bound audit scripts are NOT touched in this arc.

### Tier 3 — Structural wins (branch, commits 3 and 4)

1. **`lib/coach/chat-stream.ts` executor dispatch → registry** (commit 3). The ~450-line `if (block.name === …)` chain becomes an `EXECUTOR_REGISTRY: Record<string, (ctx, input) => Promise<ToolResult>>` of one-line closure entries (executors have heterogeneous signatures, so entries are wrappers, not bare references). Unknown tool names return the same error shape as today. `modeAllowsTool` filtering and the `PERSIST_RESULT_TOOLS` set are untouched. Behavior-identical by construction; low risk.
2. **Server/browser fetcher factory** (commit 4). `lib/query/fetchers/` has 31 files each hand-writing a server variant (takes supabase client) and browser variant (creates its own) around an identical query. Introduce a `createFetcher` helper that takes the shared query function and returns both variants. **Existing export names are preserved** as the factory's outputs — zero call-site churn in hooks/pages. Roll out to 3 fetchers first (including `dailyLogs.ts`, the canonical example), verify, then the remainder. ~200 lines.

## Explicitly out of scope (deferred / skipped)

- **Tier 4 decompositions** — `tools.ts` (6,622 lines) split into 8 modules, `ChatPanel.tsx` hooks extraction, `messages/route.ts` phase split. Genuine complexity wins but zero line reduction and the highest blast radius in the app; each deserves its own spec. The chat-stream registry in this arc delivers a taste of the same benefit at ~5% of the risk.
- `snapshot.ts` / `LoggerSheet.tsx` splits — auditor verdict: already cohesive; splitting is cosmetic.
- Dependency removal — all deps verified in use.
- Script archival — one-shots are documented, lightweight, don't ship to build.
- Proactive `check-*` and `compose-*` abstraction — high semantic variance; abstraction risks obscuring domain logic. Pattern documented, not refactored.
- Proposal-card shell extraction — visual variance makes a generic shell risky; revisit if more cards are added.

## Error handling / rollback

- Each tier is its own commit; a failed verification reverts one commit, not the arc.
- Dirty worktrees and any file whose deletion evidence doesn't reproduce at execution time are surfaced, not forced.

## Verification

After every commit on the branch:
1. `npm run typecheck` (baseline is clean — must stay clean).
2. `npm run build` (hooks/render bugs only surface in prod build — see repo memory).
3. `npx vitest run` for the touched `__tests__` dirs (Tier 2).
4. `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs` after the gridRound consolidation (83 assertions must pass).
5. Migrated pure audit scripts re-run with identical pass counts.
6. `node scripts/audit-timezone-usage.mjs` after any `lib/time/` addition.

## Expected outcome

~2,800 source lines deleted or consolidated, 1.8 GB disk reclaimed, 44 stale branches gone, one 450-line dispatch chain collapsed, 31 fetcher pairs behind one factory — with zero behavior change, enforced by the existing typecheck/build/audit gates.
