# Injury Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live injury tracking — report via chat or form, visible to all coaches, excusing affected missed sessions, and injury-gating progress analysis.

**Architecture:** New `injuries` table (lifecycle rows, backdatable onset) + a small pure module `lib/coach/injuries.ts` consumed by five existing seams: constraints-summary (coach visibility), adherence (excused `injury` day status), trends/compose-strength + plateau nudge (injury-gating), blocks summary secondaries (injury chip), morning-brief flags. Chat tools are fire-and-confirm writes.

**Tech Stack:** Next.js 15 App Router, Supabase RLS, vitest.

**Spec:** [docs/superpowers/specs/2026-07-13-injury-lifecycle-design.md](../specs/2026-07-13-injury-lifecycle-design.md)

## Global Constraints

- Branch `feat/injury-lifecycle`; single PR at the end.
- Migration file MUST be `supabase/migrations/0052_injuries.sql` (uniform-width prefix; next free slot per CLAUDE.md is 0052). Apply with `supabase db push`.
- New chat write tools MUST get: explicit default-mode allows in `modeAllowsTool` ([lib/coach/chat-stream.ts](lib/coach/chat-stream.ts)) AND `PERSIST_RESULT_TOOLS` entries — both documented silent-fail traps.
- `fmtNum()` for user-visible numbers; no `new Date().toISOString().slice(0,10)` date keys (use `todayInUserTz`/callers' todayIso).
- Verify each task: `npm run typecheck` && `npx vitest run`; `npm run build` additionally whenever client components change.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migration 0052 + Injury type + pure injury module

**Files:**
- Create: `supabase/migrations/0052_injuries.sql`
- Modify: `lib/data/types.ts`
- Create: `lib/coach/injuries.ts`
- Test: `lib/coach/__tests__/injuries.test.ts`

**Interfaces:**
- Produces: `Injury` row type; `fetchActiveInjuries(supabase, userId): Promise<Injury[]>`; pure `injuryActiveOn(injury, dateIso): boolean`; pure `liftInjuryFor(injuries, lift, fromIso, toIso): Injury | null` (returns the injury when `lift ∈ affected_lifts` and the injury overlaps ≥ 50% of [fromIso, toIso]).

- [ ] **Step 1: Migration** — exactly the spec's SQL (table `injuries` with the CHECK constraints, RLS owner select/insert/update, NO delete policy, `updated_at` default now()). Add an index `injuries_user_status_idx on injuries (user_id, status)`. Apply: `supabase db push`. Expected: `Applying migration 0052_injuries.sql... Finished`.

- [ ] **Step 2: Type mirror** — in `lib/data/types.ts` near the other row types:

```ts
export type InjurySeverity = "mild" | "moderate" | "severe";
export type InjuryStatus = "active" | "resolved";
export type Injury = {
  id: string;
  user_id: string;
  area: string;
  side: string | null;
  cause: string | null;
  severity: InjurySeverity;
  onset_date: string;               // YYYY-MM-DD, backdatable
  status: InjuryStatus;
  resolved_at: string | null;       // timestamptz
  affected_session_types: string[]; // e.g. ["Legs","Back"] — session_plan strings
  affected_lifts: PrimaryLift[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 3: Failing tests for the pure helpers**

```ts
// lib/coach/__tests__/injuries.test.ts
import { describe, expect, test } from "vitest";
import { injuryActiveOn, liftInjuryFor } from "@/lib/coach/injuries";
import type { Injury } from "@/lib/data/types";

const hip: Injury = {
  id: "i1", user_id: "u1", area: "hip", side: null, cause: "padel",
  severity: "moderate", onset_date: "2026-06-29", status: "active",
  resolved_at: null, affected_session_types: ["Legs", "Back"],
  affected_lifts: ["deadlift", "squat"], notes: null,
  created_at: "2026-06-29T10:00:00Z", updated_at: "2026-06-29T10:00:00Z",
};

describe("injuryActiveOn", () => {
  test("active from onset onward while unresolved", () => {
    expect(injuryActiveOn(hip, "2026-06-28")).toBe(false);
    expect(injuryActiveOn(hip, "2026-06-29")).toBe(true);
    expect(injuryActiveOn(hip, "2026-07-13")).toBe(true);
  });
  test("resolved injuries stop at resolved_at's date (inclusive)", () => {
    const resolved = { ...hip, status: "resolved" as const, resolved_at: "2026-07-10T08:00:00Z" };
    expect(injuryActiveOn(resolved, "2026-07-10")).toBe(true);
    expect(injuryActiveOn(resolved, "2026-07-11")).toBe(false);
  });
});

describe("liftInjuryFor", () => {
  test("returns the injury when overlap ≥ half the window", () => {
    expect(liftInjuryFor([hip], "deadlift", "2026-06-22", "2026-07-13")?.area).toBe("hip");
  });
  test("null when overlap < half the window or lift unaffected", () => {
    expect(liftInjuryFor([hip], "deadlift", "2026-04-01", "2026-07-01")).toBeNull();
    expect(liftInjuryFor([hip], "bench", "2026-06-22", "2026-07-13")).toBeNull();
  });
});
```

- [ ] **Step 4: Run** `npx vitest run lib/coach/__tests__/injuries.test.ts` → FAIL (module not found).

- [ ] **Step 5: Implement `lib/coach/injuries.ts`**

```ts
// lib/coach/injuries.ts
// Live injury lifecycle helpers (spec 2026-07-13). Pure date math takes ISO
// strings — callers own timezone resolution.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Injury, PrimaryLift } from "@/lib/data/types";

export async function fetchActiveInjuries(supabase: SupabaseClient, userId: string): Promise<Injury[]> {
  const { data, error } = await supabase
    .from("injuries").select("*")
    .eq("user_id", userId).eq("status", "active")
    .order("onset_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Injury[];
}

/** Was this injury active on the given day? Onset-inclusive; a resolved
 *  injury covers days up to and including its resolved_at DATE. */
export function injuryActiveOn(injury: Injury, dateIso: string): boolean {
  if (dateIso < injury.onset_date) return false;
  if (injury.status === "active" || injury.resolved_at == null) return true;
  return dateIso <= injury.resolved_at.slice(0, 10);
}

function daysBetweenIso(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000);
}

/** The injury gating `lift` over [fromIso, toIso], if its active span covers
 *  at least half the window. Ties broken by most recent onset. */
export function liftInjuryFor(
  injuries: Injury[], lift: PrimaryLift, fromIso: string, toIso: string,
): Injury | null {
  const windowDays = Math.max(1, daysBetweenIso(fromIso, toIso));
  for (const inj of injuries) {
    if (!inj.affected_lifts.includes(lift)) continue;
    const activeFrom = inj.onset_date > fromIso ? inj.onset_date : fromIso;
    const activeTo = inj.status === "resolved" && inj.resolved_at != null && inj.resolved_at.slice(0, 10) < toIso
      ? inj.resolved_at.slice(0, 10) : toIso;
    const overlap = daysBetweenIso(activeFrom, activeTo);
    if (overlap * 2 >= windowDays) return inj;
  }
  return null;
}
```

- [ ] **Step 6: Run** tests → PASS; `npm run typecheck` clean; `npx vitest run` all green.
- [ ] **Step 7: Commit** — `git add supabase/migrations/0052_injuries.sql lib/data/types.ts lib/coach/injuries.ts lib/coach/__tests__/injuries.test.ts && git commit -m "feat(injury): migration 0052, Injury type, pure lifecycle helpers"`

---

### Task 2: API routes + Active Injuries card on /health?tab=log

**Files:**
- Create: `app/api/injuries/route.ts` (POST create, GET list)
- Create: `app/api/injuries/[id]/route.ts` (PATCH — resolve or edit)
- Create: `components/health/ActiveInjuriesCard.tsx`
- Modify: the /health log tab container (find where the symptom journal renders: `grep -rn "symptom" components/health app/health` — mount the card directly above it)

**Interfaces:**
- Consumes: `Injury` type, Task 1.
- Produces: `POST /api/injuries` body `{area, side?, cause?, severity?, onset_date?, affected_session_types?, affected_lifts?, notes?}` → `{ok, injury}` (422 on bad severity/lift/date shapes); `PATCH /api/injuries/[id]` body `{status?: "resolved", ...editable fields}` → `{ok, injury}`; GET → `{ok, injuries}` (active first).

- [ ] **Step 1: Routes.** Follow the repo idiom exactly (see `app/api/blocks/route.ts`): `createSupabaseServerClient` → `auth.getUser()` → 401 → service-role writes scoped by the session user id. Validation: `area` trimmed non-empty ≤ 40 chars; `severity ∈ {mild,moderate,severe}` (default moderate); `onset_date` matches `/^\d{4}-\d{2}-\d{2}$/` and is ≤ today in the user's tz (`getUserTimezone` + `todayInUserTz`), default today; `affected_lifts ⊆ {squat,bench,deadlift,ohp}`; `affected_session_types` strings ≤ 20 chars each. PATCH: ownership check; setting `status: "resolved"` stamps `resolved_at: now()`; un-resolving clears it.
- [ ] **Step 2: Card.** `ActiveInjuriesCard` (client): list active injuries (area · since `onset_date` · severity chip) with per-row Resolve button (PATCH + optimistic removal), a collapsed "+ Report injury" form (area, side select, cause, severity select, onset date input, session-type checkboxes Legs/Chest/Back/Arms/Mobility, lift checkboxes, notes). Fetch via `GET /api/injuries` in a `useQuery` keyed `["injuries", userId]` — add `injuries: { all: (userId) => ["injuries", userId] as const }` to `lib/query/keys.ts`. All hooks above early returns.
- [ ] **Step 3: Gates** — `npm run typecheck && npx vitest run && npm run build` all green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(injury): CRUD routes + Active Injuries card on /health log tab"`

---

### Task 3: Chat tools log_injury / resolve_injury

**Files:**
- Modify: `lib/coach/tools.ts` (2 tool schemas + 2 executors + registration in PETER_TOOLS, CARTER_TOOLS, REMI_TOOLS)
- Modify: `lib/coach/chat-stream.ts` (executor map entries; `PERSIST_RESULT_TOOLS` += both; default-mode allows for both)
- Modify: `components/chat/ChatMessage.tsx` (`renderToolReceiptChip`: add both to `RECEIPT_TOOLS`, render "Injury logged: hip (padel, since Jun 29)" / "Injury resolved: hip" chips from `call.result`)

**Interfaces:**
- Consumes: Task 1's validation rules (share by exporting `validateInjuryInput(input): {ok:true; value:...}|{ok:false; error:string}` from `lib/coach/injuries.ts` and using it in BOTH the API route and the executor — refactor Task 2's route to import it if Task 2 inlined validation).
- Produces: `executeLogInjury({supabase, userId, input})` / `executeResolveInjury({supabase, userId, input})` returning the repo's standard `ToolResult` shape with `result` carrying `{injury: {id, area, side, cause, severity, onset_date, affected_session_types, affected_lifts}}` for the chip.

- [ ] **Step 1: Schemas.** `log_injury` description teaches the model: infer `affected_session_types` and `affected_lifts` from the conversation (hip → Legs+Back, deadlift+squat), backdate `onset_date` when the athlete says "two weeks ago", and narrate the inferred fields back so the athlete can correct. `resolve_injury` takes `{injury_id?, area?}` — resolve by id, else by unique active-area match (case-insensitive); error `ambiguous_area` when multiple actives match, `not_found` when none.
- [ ] **Step 2: Executors** — thin wrappers over the same service-role writes as the API routes (insert / update-resolve). Standard `ToolResult` with `meta.ms`.
- [ ] **Step 3: Wiring** — executor map entries in chat-stream; `PERSIST_RESULT_TOOLS.add("log_injury")` and `"resolve_injury"`; default-mode allows next to the close-block allows with a one-line comment; register in the three tool partitions (NOT NORA_TOOLS).
- [ ] **Step 4: Receipt chips** in `renderToolReceiptChip` — success chip text as in Interfaces; error path renders the existing error-style chip.
- [ ] **Step 5: Gates** — typecheck + vitest + build (ChatMessage changed).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(injury): log_injury/resolve_injury chat tools with receipt chips"`

---

### Task 4: Constraints block merge

**Files:**
- Modify: `lib/coach/intelligence/constraints-summary.ts` (`composeConstraints` gains a `liveInjuries: Injury[]` param)
- Modify: the caller in `lib/coach/intelligence/index.ts` (fetch active injuries alongside the profile — find where `composeConstraints(profile)` is invoked)
- Modify: `lib/coach/system-prompts.ts` SCHEMA_EXPLAINER `### Constraints` line: append "Injuries may be live-reported mid-block via log_injury — treat them identically to profile injuries."
- Test: extend `lib/coach/intelligence/__tests__/types.test.ts` or add `constraints-live-injuries.test.ts`

**Interfaces:**
- Consumes: `Injury`, `fetchActiveInjuries` (Task 1).
- Produces: `composeConstraints(profile, liveInjuries: Injury[])` — same `ConstraintPayload` return. Merge rule: live rows map to the payload's injury item shape (area, status from weeks-since-onset: <4wk acute else chronic — reuse the existing mapping helper; weeks from `onset_date` to today is NOT computable purely here, so the caller passes `todayIso` too: final signature `composeConstraints(profile, liveInjuries, todayIso)`); `affected_lifts` map to exercise exclusions using `PRIMARY_LIFT_NAME_PATTERNS[lift]` names; dedup: live row and profile item with same lowercased `area` → keep the live row.

- [ ] **Step 1: Failing test** — fixture profile with a profile-declared "shoulder" injury + live hip Injury (Task 1's fixture): assert payload contains both, hip status "acute" for todayIso 2026-07-13 (2 weeks), exclusions include "Deadlift (Barbell)" and "Squat (Barbell)", and a live "shoulder" row would supersede the profile one.
- [ ] **Step 2: Run** → FAIL (arity). **Step 3: Implement** merge + update caller(s) (grep `composeConstraints(` — every call site gets `await fetchActiveInjuries(...)` + todayIso; the intelligence orchestrator already has supabase/userId/today in scope). **Step 4: Run** → PASS, full suite green. **Step 5: Commit** — `feat(injury): live injuries flow into the coaches' Constraints block`

---

### Task 5: Adherence `injury` status + weekly review rendering

**Files:**
- Modify: `lib/coach/adherence.ts` (`AdherenceDayStatus` union += `"injury"`; classification + denominator)
- Modify: weekly review recap composer (`lib/coach/weekly-review/compose-recap.ts` — grep for where day statuses render) + the review UI cell that renders day statuses (grep `swapped` in components/coach)
- Test: `lib/coach/__tests__/adherence-injury.test.ts` (pure classification helper extracted if classification is inline — extract `classifyDay(...)` ONLY if adherence.ts doesn't already expose a testable seam; otherwise fixture-test through the existing exported pure paths)

**Interfaces:**
- Consumes: `fetchActiveInjuries`, `injuryActiveOn` (Task 1). `computeAdherence(supabase, userId, weekStart)` fetches injuries once (all rows with `onset_date ≤ weekEnd`, including resolved — resolved injuries still excuse the days they covered).
- Produces: day entries may carry `status: "injury"` + `injury_area: string`; `AdherenceResult` totals: `sessions_planned` EXCLUDES injury days (excused denominator), a new `injury_excused: number` count. `compute_adherence` chat tool output includes the per-day statuses it already returns — verify the tool serializes the new fields.

- [ ] **Step 1: Failing test** — week fixture: Mon Legs missed while hip active (→ `injury`), Tue Chest missed (→ `missed`, Chest ∉ affected), Wed Back done (→ `as_planned` even though affected — a completed session is never re-classified), Fri Legs missed with injury resolved Thursday (→ `missed`). Assert denominator excludes exactly the one injury day.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — classification order: existing logic first; only a would-be `missed` day is checked against injuries (`session type ∈ affected_session_types` AND `injuryActiveOn(injury, dayIso)`). **Step 4: Run** → PASS + full suite (weekly-review composers consume AdherenceResult — fix type fallout). **Step 5: Weekly review render** — recap cell shows "skipped — {area} injury" with a muted/amber style distinct from missed; `WeeklyReviewPayload.schema_version` unchanged (additive optional fields only). **Step 6: Gates** incl. build. **Step 7: Commit** — `feat(injury): adherence classifies injury-excused days; weekly review renders them`

---

### Task 6: Injury-gated progress analysis + plateau nudge suppression

**Files:**
- Modify: `lib/coach/trends/compose-strength.ts` (per-lift payload += `injury_gated: boolean`, `injury_area: string | null`; prose template)
- Modify: `lib/coach/proactive/check-plateau.ts` (skip lifts with `injury_gated`)
- Modify: the trends orchestrator `lib/coach/trends/index.ts` (fetch injuries once, thread into composeStrength)
- Test: extend the existing compose-strength test file (grep `compose-strength` in lib/coach/trends/__tests__/)

**Interfaces:**
- Consumes: `liftInjuryFor(injuries, lift, windowFromIso, todayIso)` (Task 1) — window = the same 8w/12w span compose-strength already uses for slopes.
- Produces: per-lift trend entries carry `injury_gated`/`injury_area`; plateau prose switches to "flat — injury-gated ({area} since {onset})" when gated; `checkPlateau` emits no event for gated lifts.

- [ ] **Step 1: Failing tests** — (a) lift with `plateau_active` + gating injury → `injury_gated: true` and checkPlateau returns no event for it; (b) same lift without injury → unchanged behavior. **Step 2: RED → implement → GREEN.** **Step 3: Full suite + commit** — `feat(injury): trends and plateau nudge respect injury gating`

---

### Task 7: Blocks monitor chip + brief flags + docs + PR

**Files:**
- Modify: `lib/coach/blocks/summary.ts` (secondaries += `injuryArea: string | null` — active injury whose `affected_lifts` includes the lift as of todayIso)
- Modify: `components/strength/blocks/CurrentBlockCard.tsx` (secondaries tile: injury chip — area label on `warningSoft`, replaces the plain staleness marker when `injuryArea != null`)
- Modify: `lib/morning/brief/flags.ts` (`FlagInputs` += `liveInjuries: Injury[]`; `has_active_injuries` ORs profile + live; add `active_injury_areas: string[]`) + its caller (grep `computeAdviceFlags(` — thread `fetchActiveInjuries`)
- Modify: `CLAUDE.md` (migration 0052 entry; next free slot → 0053; one line in the coach section for the injury loop)
- Test: extend `lib/coach/blocks/__tests__/summary.test.ts` with a `computeSecondary`-adjacent pure test only if a pure seam is added; otherwise rely on Task 1's helpers already being tested.

- [ ] **Step 1: Implement all four files.** Monitor: fetch active injuries inside `assembleBlockSummary` (one extra query, same Promise.all). Flags: additive fields only — the advice prompt template reads flags generically.
- [ ] **Step 2: Gates** — typecheck + vitest + build.
- [ ] **Step 3: Commit + PR**

```bash
git add -A && git commit -m "feat(injury): blocks monitor chip, brief flags, docs"
gh pr create --title "Injury lifecycle: report → coach context → excused adherence → gated progress" --body "Per docs/superpowers/specs/2026-07-13-injury-lifecycle-design.md. Migration 0052, chat tools + /health card, constraints merge, adherence injury status, trend gating, monitor chip, brief flags."
```

---

## Post-merge

- Seed the live injury via chat: "log my hip injury — padel, started around June 29, affects Legs and Back days, deadlift and squat" → verify receipt chip, Constraints block, weekly-review re-read of last week, deadlift secondaries chip.
- Follow-up arcs (explicitly out): engine-level exercise exclusion; soreness auto-detect.
