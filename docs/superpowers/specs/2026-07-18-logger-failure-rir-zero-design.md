# Logger: F badge auto-sets RIR to 0

**Date:** 2026-07-18 · **Status:** Approved · **Area:** [components/logger/SetRow.tsx](../../../components/logger/SetRow.tsx)

## Rationale

RIR 0 means "to failure" by definition ([lib/logger/types.ts:17](../../../lib/logger/types.ts#L17)).
Auto-filling RIR 0 when the athlete marks a set as failure (F badge):
- gives the engine strictly better data (null RIR degrades clean/strain checks to reps-only);
- makes the contradictory state F + RIR > 0 unreachable by default;
- is consistent with `isStrained` (`failure || rir < prescribed`) and the
  effort-aware e1RM (`epley(kg, reps + rir)` → evaluates at actual reps).

## Behavior

In BOTH badge-menu instances in `SetRow.tsx`:

1. Tap **F** → `onChange({ warmup: false, failure: true, rir: 0 })` and sync the
   local RIR draft state to `"0"` (draft is `useState`-local; without the sync
   the input displays stale).
2. Tap **W** or the working-set number while `failure` is set → include
   `rir: null` in the `onChange` payload and clear the draft, **only if the
   current `set.rir === 0`** — undo the auto-fill, never wipe a hand-typed
   value (>0). When the badge changes between non-F states, RIR is untouched.
3. RIR input stays editable while F is active; a manual overtype wins.

## Out of scope

Voice parsing ("to failure" → failure+rir), engine/API/schema (per-set `rir`
already flows through `commit_logger_session`), warmup RIR display rules.

## Verification

No component test harness (vitest is node-env, `lib/**` only). Gate:
`npm run typecheck` + `npm run build` + dev-server smoke of the badge cycle
(F → RIR shows 0; F → working → RIR cleared; manual RIR 1 → F → 0 → un-F → stays cleared-only-if-0 rule as specified).
