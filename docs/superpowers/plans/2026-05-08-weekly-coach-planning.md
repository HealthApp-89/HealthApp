# Weekly Coach Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `WEEKLY_SESSIONS` map with per-week training plans committed via a Sunday `plan_week` chat ritual, anchored in 5-week mesocycle blocks created via a `setup_block` ritual. Surface body-composition-aware progress metrics so flat e1RM during a cut reads as a recomp win, not a plateau.

**Architecture:** Two new tables (`training_blocks`, `training_weeks`) and one column on `chat_messages` (`mode`). Eight new coach tools with propose-then-commit pattern gated by HMAC approval tokens. Conversation modes (`plan_week`, `setup_block`) determine system-prompt assembly server-side. `TodayPlanCard` reads from `training_weeks` first, falls back to `WEEKLY_SESSIONS`. New `<BlockProgressCard>` shows absolute (e1RM) + relative (per-LBM, allometric, IPF GL) metrics computed on demand.

**Tech Stack:** Next.js 15 App Router, Supabase (RLS-respecting server client + service-role for tool executors), Anthropic SDK with tool use, TanStack Query for client cache, SSE for streaming chat. No new runtime dependencies — `crypto.subtle` for HMAC, existing `@anthropic-ai/sdk`, existing `@supabase/supabase-js`.

**Spec:** [docs/superpowers/specs/2026-05-08-weekly-coach-planning-design.md](../specs/2026-05-08-weekly-coach-planning-design.md)

**Verification posture:** This codebase has no test runner (`npm run lint` is unconfigured per CLAUDE.md). Each task ends with `npm run typecheck` plus targeted manual checks. Pure functions in `lib/coach/progress-metrics.ts`, `lib/coach/approval-token.ts`, `lib/coach/adherence.ts`, and `lib/coach/autoregulation.ts` are exercised via one-shot verification scripts (`scripts/probe-*.mjs`) that print known-input/known-output pairs for visual confirmation; these scripts are deleted after verification (not committed) since the codebase doesn't have a tests directory yet.

**Migration number caveat:** This plan uses `0008_weekly_planning.sql` because `feat/morning-intake-bot` (currently in flight) owns `0007`. If that branch is abandoned, the implementer renumbers to 0007.

---

## File Structure

**New files (24):**
- `supabase/migrations/0008_weekly_planning.sql` — schema additions
- `lib/coach/approval-token.ts` — HMAC sign/verify for propose→commit gating
- `lib/coach/progress-metrics.ts` — pure functions: strengthPerLbm, allometric, ipfGl
- `lib/coach/adherence.ts` — pure-ish: planned-vs-actual matching, volume deltas
- `lib/coach/autoregulation.ts` — pure-ish: HRV/e1RM/sleep signal computation
- `lib/coach/planning-prompts.ts` — `plan_week` and `setup_block` mode prompt assemblers
- `lib/query/fetchers/trainingWeek.ts` — dual fetcher (server+browser)
- `lib/query/fetchers/blockProgress.ts` — server fetcher for /api/coach/block-progress payload
- `lib/query/hooks/useTrainingWeek.ts` — TanStack Query hook
- `lib/query/hooks/useBlockProgress.ts` — TanStack Query hook
- `app/api/coach/block-progress/route.ts` — GET endpoint
- `app/api/coach/training-weeks/[week_start]/route.ts` — GET single week (used by useTrainingWeek browser fetcher)
- `components/coach/BlockProgressCard.tsx` — active block status + metrics
- `components/coach/WeekPlanCard.tsx` — read-only committed-plan view
- `components/coach/SetupBlockCTA.tsx` — first-time block CTA card
- `components/coach/PlanWeekCTA.tsx` — Sunday/Mon-Tue plan CTA card
- `components/chat/WeekPlanProposalCard.tsx` — inline proposal preview in chat bubble
- `components/chat/BlockProposalCard.tsx` — inline proposal preview in chat bubble
- `components/chat/ModeBanner.tsx` — top-of-ChatPanel banner when in plan_week / setup_block

**Modified files (12):**
- `lib/data/types.ts` — add `TrainingBlock`, `TrainingWeek`, `ChatMode`, extend `ChatMessageRow`
- `lib/query/keys.ts` — add `trainingWeeks` and `blockProgress` key factories
- `lib/coach/week.ts` — add `planningTargetMonday(today)` helper
- `lib/coach/tools.ts` — add 8 new tool definitions + executors
- `lib/coach/system-prompts.ts` — append `plan_week` / `setup_block` mode prompt sections
- `app/api/chat/messages/route.ts` — accept `mode` on POST, persist it, resolve mode for new turns, route to mode-specific prompt
- `app/strength/page.tsx` — prefetch `trainingWeek` for current week
- `components/strength/StrengthClient.tsx` — read `useTrainingWeek` first, fall back to `WEEKLY_SESSIONS`
- `components/strength/TodayPlanCard.tsx` — accept `committedFromPlan`, `weekN`, `rirTarget`, `researchPhase`; render new pill text
- `app/coach/page.tsx` — prefetch `useBlockProgress`
- `components/coach/CoachClient.tsx` — restructure NextWeekView with new cards
- `components/chat/ChatPanel.tsx` — accept `mode`, render `<ModeBanner>`, mode-aware composer placeholder, `[exit-mode]` handling
- `components/chat/ChatMessage.tsx` — render `<WeekPlanProposalCard>` / `<BlockProposalCard>` when `tool_calls` includes `propose_*`
- `components/layout/FabGate.tsx` — listen for `open-chat` custom event with `mode` payload
- `CLAUDE.md` — add migration 0008 to list

**Env additions:**
- `COACH_TOOL_SECRET` (server-only, used by `lib/coach/approval-token.ts`)

---

## Task index (18 tasks)

- Task 1: DB migration + CLAUDE.md
- Task 2: TS types — `TrainingBlock`, `TrainingWeek`, `ChatMode`
- Task 3: Approval token utility + `COACH_TOOL_SECRET` env
- Task 4: Progress metrics pure module
- Task 5: `planningTargetMonday` helper
- Task 6: Adherence module
- Task 7: Autoregulation module
- Task 8: TrainingWeek fetcher + hook + query keys
- Task 9: Strength tab fix — `TodayPlanCard` reads `training_weeks` with fallback
- Task 10: Coach tools — 4 read tools (block, weeks, autoreg, adherence)
- Task 11: Coach tools — 4 write tools (propose/commit pairs for block + week)
- Task 12: Chat API mode resolution + persistence
- Task 13: Mode-specific system prompts (`planning-prompts.ts`)
- Task 14: Block progress endpoint + fetcher/hook
- Task 15: BlockProgressCard component
- Task 16: WeekPlanCard component + CTAs
- Task 17: Chat preview cards (WeekPlanProposalCard, BlockProposalCard, ModeBanner) + ChatPanel mode wiring
- Task 18: End-to-end smoke + CLAUDE.md polish

---

### Task 1: DB migration — `0008_weekly_planning.sql`

**Files:**
- Create: `supabase/migrations/0008_weekly_planning.sql`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the migration file**

Write `supabase/migrations/0008_weekly_planning.sql`:

```sql
-- 0008_weekly_planning.sql — weekly coach planning v1
--
-- Two new tables (training_blocks, training_weeks) plus a mode column on
-- chat_messages for the plan_week / setup_block conversation modes.

-- ── training_blocks ──────────────────────────────────────────────────────────
create table if not exists public.training_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'completed', 'abandoned')),
  start_date date not null,
  end_date date not null,
  goal_text text not null,
  primary_lift text
    check (primary_lift in ('squat','bench','deadlift','ohp') or primary_lift is null),
  target_metric text
    check (target_metric in ('e1rm','working_weight') or target_metric is null),
  target_value numeric,
  target_unit text default 'kg',
  diet_goal jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  check ((target_metric is null) = (target_value is null))
);

create unique index if not exists training_blocks_one_active_per_user
  on public.training_blocks (user_id) where status = 'active';

create index if not exists training_blocks_user_status_idx
  on public.training_blocks (user_id, status);

alter table public.training_blocks enable row level security;

drop policy if exists "training_blocks self" on public.training_blocks;
create policy "training_blocks self" on public.training_blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── training_weeks ───────────────────────────────────────────────────────────
create table if not exists public.training_weeks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  block_id uuid references public.training_blocks on delete set null,
  week_start date not null,
  session_plan jsonb not null,
  weekly_focus text,
  intensity_modifier jsonb default '{}'::jsonb,
  rir_target int
    check (rir_target between 1 and 4 or rir_target is null),
  research_phase text
    check (research_phase in ('accumulate','deload') or research_phase is null),
  proposed_by text not null default 'coach'
    check (proposed_by in ('coach', 'user')),
  chat_message_id uuid references public.chat_messages on delete set null,
  committed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists training_weeks_user_week_idx
  on public.training_weeks (user_id, week_start);

alter table public.training_weeks enable row level security;

drop policy if exists "training_weeks self" on public.training_weeks;
create policy "training_weeks self" on public.training_weeks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── chat_messages: mode discriminator ────────────────────────────────────────
alter table public.chat_messages
  add column if not exists mode text not null default 'default';

alter table public.chat_messages
  drop constraint if exists chat_messages_mode_check;

alter table public.chat_messages
  add constraint chat_messages_mode_check
  check (mode in ('default','plan_week','setup_block'));

create index if not exists chat_messages_user_mode_created_idx
  on public.chat_messages (user_id, mode, created_at desc);

-- ── Comments (load-bearing context for future contributors) ──────────────────
comment on column public.training_blocks.diet_goal is
  'Reserved-null in v1. v2 populates with calorie/macro targets.';

comment on column public.training_blocks.status is
  'Auto-flips to ''completed'' at read time when today > end_date — see /api/coach/block-progress and query_training_blocks executor.';

comment on column public.training_weeks.session_plan is
  'jsonb {Mon:"Chest", Tue:"Legs", ...} — values are session-type strings keyed in lib/coach/sessionPlans.ts:SESSION_PLANS plus "REST".';

comment on column public.training_weeks.intensity_modifier is
  'jsonb {squat: 0.95, bench: 1.0, ...} — multipliers applied to baseKg in SESSION_PLANS for the named primary_lift. Missing keys default to 1.0.';

comment on column public.chat_messages.mode is
  'Conversation mode: ''default'' (free-form Q&A), ''plan_week'' (Sunday weekly planning), ''setup_block'' (block creation). Resolved server-side from request param OR inherited from prior turn.';
```

- [ ] **Step 2: Apply the migration**

Per CLAUDE.md, the Supabase CLI is linked. Run:

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db push
```

Expected: a single migration applies. If `supabase db push` complains about migration history mismatch, run `supabase migration repair --status applied <hash>` for the past migrations and retry. If it asks to confirm a destructive change, say no — the migration is purely additive.

- [ ] **Step 3: Verify schema applied**

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db diff
```

Expected: no diff (migration applied cleanly).

Then visually confirm in Supabase Dashboard → Table Editor that `training_blocks` and `training_weeks` exist with RLS enabled (lock icon on table).

- [ ] **Step 4: Add migration 0008 to CLAUDE.md**

Find the "Database migrations" section. Add the new entry after migration 7 (or 6 if morning-intake was renumbered). The exact diff depends on the state of CLAUDE.md when this task runs — match the existing list pattern:

```diff
+8. [supabase/migrations/0008_weekly_planning.sql](supabase/migrations/0008_weekly_planning.sql) — adds `training_blocks` (5-week mesocycle goals), `training_weeks` (committed Sunday plans), and `chat_messages.mode` (`default`|`plan_week`|`setup_block`) for the weekly planning ritual
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add supabase/migrations/0008_weekly_planning.sql CLAUDE.md
git commit -m "feat(db): weekly planning schema (0008)

Adds training_blocks (5-week mesocycle goals) and training_weeks
(committed Sunday plans) plus chat_messages.mode discriminator for the
plan_week / setup_block conversation modes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: TS types — `TrainingBlock`, `TrainingWeek`, `ChatMode`

**Files:**
- Modify: `lib/data/types.ts`

The types mirror the schema exactly so `lib/query/fetchers/*` and the coach tool executors can share canonical shapes.

- [ ] **Step 1: Append types to `lib/data/types.ts`**

Open `lib/data/types.ts`. After the existing `ChatMessageRow` type, append:

```ts
// ── training_blocks ──────────────────────────────────────────────────────────

export type BlockStatus = "active" | "completed" | "abandoned";
export type PrimaryLift = "squat" | "bench" | "deadlift" | "ohp";
export type TargetMetric = "e1rm" | "working_weight";

export type TrainingBlock = {
  id: string;
  user_id: string;
  status: BlockStatus;
  /** YYYY-MM-DD, always a Monday. */
  start_date: string;
  /** YYYY-MM-DD, always start + 34 days (week-5 Sunday). */
  end_date: string;
  goal_text: string;
  primary_lift: PrimaryLift | null;
  target_metric: TargetMetric | null;
  target_value: number | null;
  target_unit: string;
  /** Reserved-null in v1. v2 populates with calorie/macro targets. */
  diet_goal: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
};

// ── training_weeks ───────────────────────────────────────────────────────────

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
/** Session-type strings keyed in SESSION_PLANS, plus the literal "REST". */
export type SessionPlan = Partial<Record<Weekday, string>>;
/** Per-primary-lift intensity multipliers; missing keys default to 1.0. */
export type IntensityModifier = Partial<Record<PrimaryLift, number>>;

export type ResearchPhase = "accumulate" | "deload";
export type ProposedBy = "coach" | "user";

export type TrainingWeek = {
  id: string;
  user_id: string;
  block_id: string | null;
  /** YYYY-MM-DD, always a Monday (UTC). */
  week_start: string;
  session_plan: SessionPlan;
  weekly_focus: string | null;
  intensity_modifier: IntensityModifier;
  rir_target: number | null;
  research_phase: ResearchPhase | null;
  proposed_by: ProposedBy;
  chat_message_id: string | null;
  committed_at: string;
  created_at: string;
  updated_at: string;
};

// ── chat mode (extends existing ChatMessageRow) ──────────────────────────────

export type ChatMode = "default" | "plan_week" | "setup_block";
```

- [ ] **Step 2: Extend `ChatMessageRow` with `mode`**

Find the existing `ChatMessageRow` type in the same file. Add `mode` field:

```diff
 export type ChatMessageRow = {
   id: string;
   user_id: string;
   role: "user" | "assistant";
   content: string;
   status: "streaming" | "done" | "error";
   error: string | null;
   model: string | null;
+  mode: ChatMode;
   tool_calls: unknown[] | null;
   created_at: string;
   updated_at: string;
 };
```

- [ ] **Step 3: Typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: passes. If it fails because some existing fetcher constructs a `ChatMessageRow` without `mode`, update that fetcher's SELECT to include `mode` and the callers will compile.

- [ ] **Step 4: Commit**

```bash
git add lib/data/types.ts
git commit -m "feat(types): TrainingBlock, TrainingWeek, ChatMode

Mirrors schema 0008 in TS. Used by coach tool executors, query fetchers,
and the strength/coach UI. ChatMessageRow gains mode discriminator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Approval token utility + `COACH_TOOL_SECRET`

**Files:**
- Create: `lib/coach/approval-token.ts`
- Modify: `.env.example`

The approval token gates every `commit_*` tool: the matching `propose_*` tool emits a signed token, the user clicks Approve in the chat preview, the chat client sends a hidden `[approve:<token>]` follow-up, the coach calls `commit_*` with the token, the server verifies it, then writes. Token bound to (user_id, action, payload_hash, timestamp) with 10-min expiry.

- [ ] **Step 1: Create the module**

Write `lib/coach/approval-token.ts`:

```ts
// lib/coach/approval-token.ts
//
// HMAC-signed short-lived tokens that gate "this changes the user's plan"
// tool calls. Every propose_* tool emits a token; the matching commit_*
// tool requires it. Bounded validity prevents replay; payload-bound hash
// prevents drift between propose/commit phases.
//
// Server-only — uses process.env.COACH_TOOL_SECRET. Importing this module
// from a Client Component will throw at module-eval time.

import { createHmac } from "node:crypto";

const TOKEN_VERSION = "v1";
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function getSecret(): string {
  const s = process.env.COACH_TOOL_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "COACH_TOOL_SECRET must be set to a 32+ char random string. " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return s;
}

function payloadHash(payload: unknown): string {
  // Stable JSON: sort keys so {a:1,b:2} and {b:2,a:1} hash identically.
  const stable = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHmac("sha256", "salt").update(stable).digest("hex").slice(0, 16);
}

/** Sign a token for a propose_* call. Caller hands the returned string back
 *  to the model in the tool_result. The chat UI later passes it to the
 *  matching commit_* call. */
export function signApprovalToken(args: {
  userId: string;
  action: "block" | "week";
  payload: unknown;
}): string {
  const ts = Date.now();
  const ph = payloadHash(args.payload);
  const body = `${TOKEN_VERSION}.${args.userId}.${args.action}.${ph}.${ts}`;
  const mac = createHmac("sha256", getSecret()).update(body).digest("hex").slice(0, 24);
  return `${body}.${mac}`;
}

/** Verify a token. Returns the validated payload-hash + action; throws on
 *  any failure (bad shape, wrong user, wrong action, expired, bad MAC). */
export function verifyApprovalToken(args: {
  token: string;
  userId: string;
  action: "block" | "week";
  payload: unknown;
}): { ok: true; payloadHash: string } {
  const parts = args.token.split(".");
  if (parts.length !== 6) throw new Error("approval-token: malformed token");
  const [version, uid, action, ph, tsRaw, mac] = parts;
  if (version !== TOKEN_VERSION) throw new Error("approval-token: version mismatch");
  if (uid !== args.userId) throw new Error("approval-token: user mismatch");
  if (action !== args.action) throw new Error("approval-token: action mismatch");
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) throw new Error("approval-token: bad timestamp");
  if (Date.now() - ts > TTL_MS) throw new Error("approval-token: expired");
  if (Date.now() - ts < 0) throw new Error("approval-token: future timestamp");

  const expectPh = payloadHash(args.payload);
  if (ph !== expectPh) throw new Error("approval-token: payload drift since propose");

  const body = `${version}.${uid}.${action}.${ph}.${ts}`;
  const expectMac = createHmac("sha256", getSecret()).update(body).digest("hex").slice(0, 24);
  if (mac !== expectMac) throw new Error("approval-token: signature mismatch");

  return { ok: true, payloadHash: ph };
}
```

- [ ] **Step 2: Add env var to `.env.example`**

In `.env.example`, append (next to the other server-only secrets like `CRON_SECRET`):

```diff
 CRON_SECRET=
+# 32+ char random string used to sign coach plan/block approval tokens
+# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
+COACH_TOOL_SECRET=
```

Then locally, generate a secret and add to `.env.local`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# copy the output, then:
echo "COACH_TOOL_SECRET=<paste-output>" >> .env.local
```

Set the same secret in Vercel project env (Production + Preview).

- [ ] **Step 3: Verify the module via a one-shot probe script**

Create a temp file `scripts/probe-approval-token.mjs` (this file is NOT committed; deleted after probing):

```js
// One-shot diagnostic: round-trip an approval token, then assert tampering fails.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const { signApprovalToken, verifyApprovalToken } = await import("../lib/coach/approval-token.ts");

const userId = "00000000-0000-0000-0000-000000000001";
const payload = { week_start: "2026-05-11", session_plan: { Mon: "Chest" } };
const token = signApprovalToken({ userId, action: "week", payload });
console.log("token:", token.slice(0, 60) + "...");

// Round-trip
const ok = verifyApprovalToken({ token, userId, action: "week", payload });
console.log("round-trip:", ok);

// Tamper checks
function expectFail(label, fn) {
  try { fn(); console.log(`FAIL (no error): ${label}`); }
  catch (e) { console.log(`OK (rejected): ${label} — ${e.message}`); }
}
expectFail("wrong user",    () => verifyApprovalToken({ token, userId: "x", action: "week", payload }));
expectFail("wrong action",  () => verifyApprovalToken({ token, userId, action: "block", payload }));
expectFail("payload drift", () => verifyApprovalToken({ token, userId, action: "week", payload: { ...payload, weekly_focus: "drift" } }));
expectFail("malformed",     () => verifyApprovalToken({ token: "garbage", userId, action: "week", payload }));
```

Run with the TS loader (the project uses `tsx` indirectly — but we don't have it installed; instead, run via Next's TS-aware Node):

```bash
cd "/Users/abdelouahedelbied/Health app"
npx --yes tsx scripts/probe-approval-token.mjs
```

Expected output (5 lines):
```
token: v1.00000000-0000-0000-0000-000000000001.week.<16 hex>.<13 digits>.<24 hex>...
round-trip: { ok: true, payloadHash: '<16 hex>' }
OK (rejected): wrong user — approval-token: user mismatch
OK (rejected): wrong action — approval-token: action mismatch
OK (rejected): payload drift — approval-token: payload drift since propose
OK (rejected): malformed — approval-token: malformed token
```

If any line says `FAIL (no error)`, the verifier is broken — fix and re-run.

- [ ] **Step 4: Delete the probe script**

```bash
rm scripts/probe-approval-token.mjs
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/approval-token.ts .env.example
git commit -m "feat(coach): HMAC approval-token utility for propose/commit gating

Signs short-lived (10-min) tokens binding userId+action+payloadHash. Used
by the propose_block/propose_week_plan tools to emit a token that the
matching commit_* tool requires before writing. Prevents hallucinated
commits, payload drift between propose/commit, and replay.

Requires COACH_TOOL_SECRET (32+ char) in env.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Progress metrics pure module

**Files:**
- Create: `lib/coach/progress-metrics.ts`

Three pure functions: `strengthPerLbm`, `allometric`, `ipfGl`. No IO. The only place body-comp formulas live in v1.

- [ ] **Step 1: Create the module**

Write `lib/coach/progress-metrics.ts`:

```ts
// lib/coach/progress-metrics.ts
//
// Pure functions for body-composition-aware strength metrics. Used by
// /api/coach/block-progress and the coach plan_week prompt template.
//
// Per the spec (docs/superpowers/specs/2026-05-08-weekly-coach-planning-design.md
// section "Body-comp-aware metric computation"), these are the v1 set:
//
//   strengthPerLbm  — load / lean body mass; most sensitive recomp metric
//   allometric      — load / bw^0.67; surface-area-to-volume scaling (Ødland 2023)
//   ipfGl           — IPF GoodLift, official 2020 powerlifting total formula
//
// All three return null for missing/zero inputs rather than NaN/Infinity.

/** e1RM (kg) divided by lean body mass (kg). Most sensitive recomp metric:
 *  rises when load holds and LBM holds, when load rises and LBM is flat,
 *  or when load is flat and fat is lost (LBM holds while body weight drops). */
export function strengthPerLbm(
  e1rm_kg: number | null | undefined,
  lbm_kg: number | null | undefined,
): number | null {
  if (e1rm_kg == null || lbm_kg == null) return null;
  if (e1rm_kg <= 0 || lbm_kg <= 0) return null;
  return e1rm_kg / lbm_kg;
}

/** Allometric strength: load (kg) divided by bodyweight^0.67. Less sensitive
 *  to fat loss than strength-per-LBM but available whenever weight is known
 *  (LBM data from Withings is sometimes missing for days). */
export function allometric(
  load_kg: number | null | undefined,
  bw_kg: number | null | undefined,
): number | null {
  if (load_kg == null || bw_kg == null) return null;
  if (load_kg <= 0 || bw_kg <= 0) return null;
  return load_kg / Math.pow(bw_kg, 0.67);
}

/** IPF GoodLift score for a 3-lift powerlifting total. Formula:
 *
 *    GL = total × 100 / (A − B·exp(−C·BW))
 *
 *  Constants from the IPF official 2020 formula evaluation:
 *    Powerlifting Total (M): A=1199.72839, B=1025.18162, C=0.00921
 *    Powerlifting Total (F): A=610.32796,  B=1045.59282, C=0.03048
 *
 *  Returns null if any of squat/bench/dead is missing or non-positive,
 *  or if BW is missing/non-positive. */
export function ipfGl(
  squat_kg: number | null | undefined,
  bench_kg: number | null | undefined,
  dead_kg: number | null | undefined,
  bw_kg: number | null | undefined,
  sex: "M" | "F" = "M",
): number | null {
  if (squat_kg == null || bench_kg == null || dead_kg == null || bw_kg == null) return null;
  if (squat_kg <= 0 || bench_kg <= 0 || dead_kg <= 0 || bw_kg <= 0) return null;

  const total = squat_kg + bench_kg + dead_kg;
  const c = sex === "M"
    ? { A: 1199.72839, B: 1025.18162, C: 0.00921 }
    : { A: 610.32796, B: 1045.59282, C: 0.03048 };

  const denom = c.A - c.B * Math.exp(-c.C * bw_kg);
  if (denom <= 0) return null; // formula breakdown for absurd BW; defensive
  return (total * 100) / denom;
}

/** Proportional delta (e.g., 0.026 = +2.6%) between two values. Returns
 *  null when either value is null or when `from` is zero (undefined ratio). */
export function deltaPct(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return (to - from) / from;
}
```

- [ ] **Step 2: Verify the formulas via a one-shot probe script**

Create temp `scripts/probe-progress-metrics.mjs` (NOT committed):

```js
import { strengthPerLbm, allometric, ipfGl, deltaPct } from "../lib/coach/progress-metrics.ts";

// Fixture: 36yo male, 76kg, ~64kg LBM (16% bf), squat e1RM 75, bench 60, dead 120
const cases = [
  { label: "spLBM 75/64",            fn: () => strengthPerLbm(75, 64),            expect: 1.171875 },
  { label: "spLBM nulls",            fn: () => strengthPerLbm(null, 64),          expect: null },
  { label: "spLBM zero LBM",         fn: () => strengthPerLbm(75, 0),             expect: null },
  { label: "allometric 120/76^.67",  fn: () => allometric(120, 76),               expect: 6.578 },  // approx
  { label: "allometric nulls",       fn: () => allometric(120, null),             expect: null },
  { label: "ipfGl M 75+60+120 @76kg", fn: () => ipfGl(75, 60, 120, 76, "M"),      expect: 36.86 }, // approx
  { label: "ipfGl missing dead",     fn: () => ipfGl(75, 60, null, 76, "M"),      expect: null },
  { label: "deltaPct 1.94→1.99",     fn: () => deltaPct(1.94, 1.99),              expect: 0.0258 }, // approx
  { label: "deltaPct null from",     fn: () => deltaPct(null, 1.99),              expect: null },
];

for (const c of cases) {
  const got = c.fn();
  const ok =
    c.expect === null ? got === null
    : got === null ? false
    : Math.abs(got - c.expect) < 0.01;
  console.log(`${ok ? "✓" : "✗"} ${c.label}: got=${got} expected≈${c.expect}`);
}
```

Run:

```bash
cd "/Users/abdelouahedelbied/Health app"
npx --yes tsx scripts/probe-progress-metrics.mjs
```

Expected: all 9 lines start with `✓`. The exact numerical values depend on the formulas — for `allometric(120, 76)`, recompute: 76^0.67 = exp(0.67 * ln(76)) ≈ exp(0.67 * 4.3307) ≈ exp(2.9016) ≈ 18.20; 120/18.20 ≈ 6.59. The probe's `expect: 6.578` is loose (`< 0.01` tolerance) — adjust if needed.

For `ipfGl`: at BW=76, exp(-0.00921 * 76) = exp(-0.6999) ≈ 0.4965; A − B·0.4965 = 1199.72839 − 1025.18162 × 0.4965 ≈ 1199.73 − 508.99 = 690.74; total=255; GL = 255 × 100 / 690.74 ≈ 36.92. Adjust expect if your manual computation differs from `36.86`.

If the formulas don't match the spec, the issue is most likely a constant typo — re-check against [the IPF 2020 evaluation report](https://www.powerlifting.sport/fileadmin/ipf/data/ipf-formula/Models_Evaluation-I-2020.pdf).

- [ ] **Step 3: Delete the probe script**

```bash
rm scripts/probe-progress-metrics.mjs
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add lib/coach/progress-metrics.ts
git commit -m "feat(coach): body-comp-aware progress metric formulas

strengthPerLbm, allometric (bw^0.67 per Ødland 2023), and ipfGl (IPF
2020 official). Pure functions, null-tolerant. Used by block-progress
endpoint and coach plan_week prompt to surface recomp wins during cuts
where raw e1RM stays flat.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `planningTargetMonday` helper

**Files:**
- Modify: `lib/coach/week.ts`

Already has `recommendationWeekStart` with similar Sunday-flip semantics. Add a new export with the v1 spec's exact semantics: most recent Monday on or before today if Mon-Sat; next Monday if Sunday.

- [ ] **Step 1: Add the helper**

Open `lib/coach/week.ts`. After `recommendationWeekStart`, append:

```ts
/** Monday that the planning CTA targets when the user opens /coach.
 *
 *  Mon-Sat → the most recent Monday on or before today (current calendar week).
 *  Sun     → next Monday (the upcoming calendar week).
 *
 *  Distinct from `recommendationWeekStart` (which has identical semantics today
 *  but is a separate concept — recommendations vs. plan targeting; keeping them
 *  separate avoids accidental coupling when one's policy changes).
 *
 *  Distinct from `currentWeekMonday(today)` (used by the strength tab) which
 *  always returns the most recent Monday on or before today regardless of
 *  weekday — strength reads "this week's plan", not "next week's". */
export function planningTargetMonday(today: Date = new Date()): string {
  const t = utc(today);
  const monday = startOfWeekMonday(t);
  if (t.getUTCDay() === 0) {
    const nextMon = new Date(monday);
    nextMon.setUTCDate(monday.getUTCDate() + 7);
    return fmt(nextMon);
  }
  return fmt(monday);
}

/** Monday of the week containing today (no Sunday flip). Used by the strength
 *  tab to look up the *current* week's training_weeks row. */
export function currentWeekMonday(today: Date = new Date()): string {
  return fmt(startOfWeekMonday(utc(today)));
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add lib/coach/week.ts
git commit -m "feat(coach): planningTargetMonday + currentWeekMonday helpers

planningTargetMonday: Sun → next Mon; Mon-Sat → this Mon. Used by /coach
to target which week the planning CTA opens.

currentWeekMonday: this Mon always (no Sunday flip). Used by the strength
tab to look up *this* week's plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Adherence module

**Files:**
- Create: `lib/coach/adherence.ts`

Joins `training_weeks.session_plan` with `workouts` for the same Mon-Sun window. Implements the lenient string-overlap matching from the spec. Used by `compute_adherence` tool, `<BlockProgressCard>`, `/api/coach/block-progress`.

- [ ] **Step 1: Create the module**

Write `lib/coach/adherence.ts`:

```ts
// lib/coach/adherence.ts
//
// Computes planned-vs-actual session adherence for a Mon-Sun window plus
// per-muscle-group volume deltas vs the prior 28-day average. Pure SELECT
// against existing tables — no schema dependency beyond training_weeks +
// workouts + exercise_sets.
//
// Matching is lenient string-overlap, not strict equality, because the user's
// workouts.type values are free-form (history shows "Lower Body", "Legs And
// Arms", "Chest Triceps", etc., not always matching plan strings exactly).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Weekday } from "@/lib/data/types";
import { categorize, type ExerciseCategory } from "@/lib/coach/exercise-categories";
import { workingVolume, type SetRow } from "@/lib/coach/derived";

const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** UTC weekday from YYYY-MM-DD. Returns one of WEEKDAYS. Mirrors the Mon-first
 *  ordering used everywhere else in the app. */
function weekdayOf(ymd: string): Weekday {
  const d = new Date(ymd + "T00:00:00Z");
  // getUTCDay: 0=Sun..6=Sat. Map to Mon-first index.
  const idx = (d.getUTCDay() + 6) % 7;
  return WEEKDAYS[idx];
}

/** Strip punctuation, lowercase, split on whitespace. */
function tokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Lenient match: planned matches actual if any token of `planned` appears as
 *  a substring of any token of `actual` (or vice-versa for plurals). Mobility
 *  / REST require exact-token match (no fuzzy). */
function matches(planned: string | null, actual: string | null): boolean {
  if (!planned || !actual) return false;
  const p = tokens(planned);
  const a = tokens(actual);
  if (p.includes("rest") || a.includes("rest")) {
    return p.includes("rest") && a.includes("rest");
  }
  if (p.includes("mobility") || a.includes("mobility")) {
    return p.includes("mobility") && a.includes("mobility");
  }
  for (const pt of p) {
    for (const at of a) {
      if (at.includes(pt) || pt.includes(at)) return true;
    }
  }
  return false;
}

export type AdherenceResult = {
  week_start: string;
  planned: Partial<Record<Weekday, string>>;
  actual: Partial<Record<Weekday, string>>;
  sessions_planned: number;
  sessions_done: number;
  sessions_on_plan: number;
  adherence_pct: number;     // sessions_on_plan / sessions_planned * 100
  done_pct: number;          // sessions_done / sessions_planned * 100
  muscle_volume_vs_4w_avg: Record<ExerciseCategory, number>; // proportional delta, e.g. -0.12 = -12%
};

/** Compute adherence for a single Mon-Sun window. */
export async function computeAdherence(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string, // YYYY-MM-DD, must be a Monday
): Promise<AdherenceResult> {
  // Range bounds (Mon..Sun inclusive)
  const start = new Date(weekStart + "T00:00:00Z");
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const endStr = end.toISOString().slice(0, 10);

  // 1. Plan
  const { data: weekRow, error: weekErr } = await supabase
    .from("training_weeks")
    .select("session_plan")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (weekErr) throw weekErr;
  const planned = (weekRow?.session_plan ?? {}) as Partial<Record<Weekday, string>>;

  // 2. Actual workouts in window with sets for volume math
  const { data: workouts, error: woErr } = await supabase
    .from("workouts")
    .select("date, type, exercises(name, exercise_sets(kg, reps, warmup, set_index))")
    .eq("user_id", userId)
    .gte("date", weekStart)
    .lte("date", endStr);
  if (woErr) throw woErr;

  // Build actual per-day map (first workout per day wins; rare edge: 2 sessions same day)
  const actual: Partial<Record<Weekday, string>> = {};
  for (const w of workouts ?? []) {
    const wd = weekdayOf(w.date);
    if (!actual[wd]) actual[wd] = w.type ?? "Workout";
  }

  // 3. Adherence counts
  let sessions_planned = 0;
  let sessions_done = 0;
  let sessions_on_plan = 0;
  for (const wd of WEEKDAYS) {
    const p = planned[wd] ?? null;
    const a = actual[wd] ?? null;
    const pIsRest = p && tokens(p).includes("rest");
    if (p && !pIsRest) sessions_planned += 1;
    if (a) sessions_done += 1;
    if (p && a && matches(p, a)) sessions_on_plan += 1;
  }
  const adherence_pct = sessions_planned === 0 ? 0 : Math.round((sessions_on_plan / sessions_planned) * 100);
  const done_pct      = sessions_planned === 0 ? 0 : Math.round((sessions_done / sessions_planned) * 100);

  // 4. Volume per muscle group, this week vs prior-28d average
  const thisWeekVol = bucketVolume(workouts ?? []);

  const priorEnd = new Date(start);
  priorEnd.setUTCDate(start.getUTCDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setUTCDate(priorEnd.getUTCDate() - 27);
  const { data: priorWorkouts, error: pwErr } = await supabase
    .from("workouts")
    .select("date, type, exercises(name, exercise_sets(kg, reps, warmup, set_index))")
    .eq("user_id", userId)
    .gte("date", priorStart.toISOString().slice(0, 10))
    .lte("date", priorEnd.toISOString().slice(0, 10));
  if (pwErr) throw pwErr;
  const priorVol = bucketVolume(priorWorkouts ?? []);
  // Convert sum-over-28d to weekly average
  const priorWeeklyAvg: Record<ExerciseCategory, number> = Object.fromEntries(
    Object.entries(priorVol).map(([k, v]) => [k, v / 4]),
  ) as Record<ExerciseCategory, number>;

  const muscle_volume_vs_4w_avg = Object.fromEntries(
    Object.keys(thisWeekVol).map((cat) => {
      const c = cat as ExerciseCategory;
      const avg = priorWeeklyAvg[c] ?? 0;
      const cur = thisWeekVol[c] ?? 0;
      const delta = avg === 0 ? (cur > 0 ? 1 : 0) : (cur - avg) / avg;
      return [cat, delta];
    }),
  ) as Record<ExerciseCategory, number>;

  return {
    week_start: weekStart,
    planned,
    actual,
    sessions_planned,
    sessions_done,
    sessions_on_plan,
    adherence_pct,
    done_pct,
    muscle_volume_vs_4w_avg,
  };
}

/** Sum working volume per muscle category across a workout list. Warmups
 *  excluded by `workingVolume`. Uses categorize() for muscle-group mapping. */
function bucketVolume(
  workouts: Array<{
    type: string | null;
    exercises:
      | Array<{
          name: string;
          exercise_sets: Array<{ kg: number | null; reps: number | null; warmup: boolean; set_index: number }>;
        }>
      | null;
  }>,
): Record<ExerciseCategory, number> {
  const out: Record<ExerciseCategory, number> = {} as Record<ExerciseCategory, number>;
  for (const w of workouts) {
    for (const e of w.exercises ?? []) {
      const cat = categorize(e.name);
      if (cat === "uncategorized") continue;
      const vol = workingVolume((e.exercise_sets ?? []) as SetRow[]);
      out[cat] = (out[cat] ?? 0) + vol;
    }
  }
  return out;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

If `categorize` or `workingVolume` import paths don't exist, run `grep -rn "export function categorize\|export function workingVolume" lib/` and fix the imports.

- [ ] **Step 3: Verify against the user's actual data**

Create temp `scripts/probe-adherence.mjs` (NOT committed):

```js
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const sr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: users } = await sr.auth.admin.listUsers();
const userId = users.users[0].id;

// Manually INSERT a training_weeks row so adherence has something to compare
await sr.from("training_weeks").upsert({
  user_id: userId,
  week_start: "2026-05-04",
  session_plan: { Mon: "Chest", Tue: "Legs", Wed: "Mobility", Thu: "Back", Fri: "Arms", Sat: "REST", Sun: "REST" },
  proposed_by: "user",
}, { onConflict: "user_id,week_start" });

const { computeAdherence } = await import("../lib/coach/adherence.ts");
const result = await computeAdherence(sr, userId, "2026-05-04");
console.log(JSON.stringify(result, null, 2));

// Clean up the test row so it doesn't pollute later tasks
await sr.from("training_weeks").delete().eq("user_id", userId).eq("week_start", "2026-05-04");
```

Run:

```bash
npx --yes tsx scripts/probe-adherence.mjs
```

Expected: a JSON object showing planned + actual for week of 2026-05-04. Per probe data from spec brainstorming, the user did Mon Chest, Tue Legs, Thu Back. Verify:
- `planned.Mon = "Chest"`, `actual.Mon = "Chest"`, matched ✓
- `planned.Fri = "Arms"`, `actual.Fri = undefined` → not matched, sessions_done less than sessions_planned
- `sessions_on_plan` should be 3 (Chest, Legs, Back)
- `sessions_done` should also be 3 (no Friday/no Sunday workouts)

If `sessions_on_plan === 0`, the matching logic is broken. Inspect `actual.Mon` — if it's `"Chest"` but the matcher rejects, debug `matches()`.

Then delete the probe:

```bash
rm scripts/probe-adherence.mjs
```

- [ ] **Step 4: Commit**

```bash
git add lib/coach/adherence.ts
git commit -m "feat(coach): adherence engine — planned vs actual + volume deltas

Lenient string-overlap matching of planned session types vs free-form
workouts.type (handles 'Legs' vs 'Legs And Arms' etc). Computes
sessions_on_plan, sessions_done, and per-muscle-group volume deltas vs
the prior 28-day weekly average. Pure SELECT, no schema dependency
beyond training_weeks + workouts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Autoregulation module

**Files:**
- Create: `lib/coach/autoregulation.ts`

Computes the 4-signal autoregulation panel. Triangulation rule: ≥2 signals → suggest deload. Pure SELECT against `daily_logs` + `workouts`. RPE signal returns `null` when data sparse (degraded gracefully).

- [ ] **Step 1: Create the module**

Write `lib/coach/autoregulation.ts`:

```ts
// lib/coach/autoregulation.ts
//
// Four fatigue signals computed on demand:
//   1. HRV outside SWC band (±0.5 SD of 7d rolling mean) for 3 of last 4 days
//   2. e1RM drop ≥5% on the active block's primary_lift (last 2 sessions vs
//      4w rolling mean)
//   3. RPE drift +2 at fixed load (degraded in v1; returns null when data sparse)
//   4. Sleep <6h for 3+ nights in last 4
//
// Deload trigger: ≥2 signals fired concurrently. Single-signal triggers
// produce false alarms per Bell et al. 2023 Delphi consensus.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift } from "@/lib/data/types";
import { epley, topSet, type SetRow } from "@/lib/coach/derived";

export type SignalReport<T> = T & { breached: boolean };

export type AutoregSignals = {
  hrv: SignalReport<{
    days_outside_swc: number;
    swc_lower: number | null;
    swc_upper: number | null;
    today: number | null;
    sample_days: number; // how many of last 7 had non-null hrv
  }>;
  e1rm: SignalReport<{
    lift: PrimaryLift | null;
    drop_pct: number | null; // proportional, e.g. -0.06 = -6%
    sessions_compared: number;
  }> | null;
  rpe: SignalReport<{
    lift: PrimaryLift | null;
    drift: number | null;
    sessions_compared: number;
  }> | null;
  sleep: SignalReport<{
    short_nights: number; // count in last 4
    threshold_hours: 6;
  }>;
  count: number;            // 0..4 (signals with breached:true; null signals omitted from count)
  should_deload: boolean;   // count >= 2
  computed_at: string;      // YYYY-MM-DD
};

const SLEEP_SHORT_THRESHOLD_HOURS = 6;
const SLEEP_NIGHTS_TO_CHECK = 4;
const SLEEP_BREACH_NIGHTS = 3;
const HRV_DAYS_OUTSIDE_THRESHOLD = 3; // of last 4
const E1RM_DROP_THRESHOLD = -0.05;     // -5% (proportional)

export async function getAutoregulationSignals(
  supabase: SupabaseClient,
  userId: string,
  asOf: string, // YYYY-MM-DD
  primaryLift: PrimaryLift | null,
): Promise<AutoregSignals> {
  // Pull last 7 days of daily_logs + last 90 days of workouts in parallel
  const asOfDate = new Date(asOf + "T00:00:00Z");
  const wk7Start = new Date(asOfDate); wk7Start.setUTCDate(asOfDate.getUTCDate() - 6);
  const d90Start = new Date(asOfDate); d90Start.setUTCDate(asOfDate.getUTCDate() - 89);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [dailyRes, woRes] = await Promise.all([
    supabase
      .from("daily_logs")
      .select("date, hrv, sleep_hours")
      .eq("user_id", userId)
      .gte("date", fmt(wk7Start))
      .lte("date", asOf)
      .order("date", { ascending: true }),
    primaryLift
      ? supabase
          .from("workouts")
          .select("date, exercises(name, exercise_sets(kg, reps, warmup, set_index))")
          .eq("user_id", userId)
          .gte("date", fmt(d90Start))
          .lte("date", asOf)
          .order("date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (dailyRes.error) throw dailyRes.error;
  if (woRes.error) throw woRes.error;
  const daily = dailyRes.data ?? [];
  const workouts = woRes.data ?? [];

  // ── HRV signal ─────────────────────────────────────────────────────────
  const hrvVals = daily.map((d) => d.hrv).filter((v): v is number => typeof v === "number");
  const hrvMean = hrvVals.length > 0 ? hrvVals.reduce((a, b) => a + b, 0) / hrvVals.length : null;
  const hrvSd =
    hrvVals.length > 1 && hrvMean !== null
      ? Math.sqrt(hrvVals.map((v) => (v - hrvMean) ** 2).reduce((a, b) => a + b, 0) / (hrvVals.length - 1))
      : null;
  const swcLower = hrvMean !== null && hrvSd !== null ? hrvMean - 0.5 * hrvSd : null;
  const swcUpper = hrvMean !== null && hrvSd !== null ? hrvMean + 0.5 * hrvSd : null;

  // Look at last 4 days
  const last4 = daily.slice(-4);
  let daysOutside = 0;
  for (const d of last4) {
    if (d.hrv == null || swcLower === null || swcUpper === null) continue;
    if (d.hrv < swcLower || d.hrv > swcUpper) daysOutside += 1;
  }
  const hrvBreached = swcLower !== null && daysOutside >= HRV_DAYS_OUTSIDE_THRESHOLD;
  const todayHrv = daily[daily.length - 1]?.hrv ?? null;

  // ── e1RM signal ────────────────────────────────────────────────────────
  // Find sessions that contain the primary lift, take top working set,
  // compute e1RM, compare last 2 sessions' max to rolling 4w mean.
  let e1rmSignal: AutoregSignals["e1rm"] = null;
  if (primaryLift) {
    const liftSeries: { date: string; e1rm: number }[] = [];
    for (const w of workouts) {
      for (const e of w.exercises ?? []) {
        if (matchesPrimaryLift(e.name, primaryLift)) {
          const sets = (e.exercise_sets ?? []) as SetRow[];
          const top = topSet(sets);
          if (top && top.kg && top.reps) {
            liftSeries.push({ date: w.date, e1rm: epley(top.kg, top.reps) });
          }
        }
      }
    }
    // workouts sorted desc; liftSeries follows that order
    if (liftSeries.length >= 2) {
      const recent2Max = Math.max(liftSeries[0].e1rm, liftSeries[1].e1rm);
      // 4-week mean: take entries from last 28 days
      const cutoff = new Date(asOfDate); cutoff.setUTCDate(asOfDate.getUTCDate() - 27);
      const w4 = liftSeries.filter((p) => p.date >= fmt(cutoff));
      const w4Mean = w4.length > 0 ? w4.reduce((a, b) => a + b.e1rm, 0) / w4.length : null;
      const dropPct = w4Mean !== null ? (recent2Max - w4Mean) / w4Mean : null;
      e1rmSignal = {
        breached: dropPct !== null && dropPct <= E1RM_DROP_THRESHOLD,
        lift: primaryLift,
        drop_pct: dropPct,
        sessions_compared: w4.length,
      };
    }
  }

  // ── RPE signal ─────────────────────────────────────────────────────────
  // v1 has no numeric RPE column — Strong app exposes failure:true only.
  // Per spec: if <3 sessions in last 14d have RPE annotation, return null.
  // For v1 we always return null (no numeric RPE source yet).
  const rpeSignal: AutoregSignals["rpe"] = null;

  // ── Sleep signal ───────────────────────────────────────────────────────
  const last4Sleep = daily.slice(-SLEEP_NIGHTS_TO_CHECK);
  const shortNights = last4Sleep.filter(
    (d) => typeof d.sleep_hours === "number" && d.sleep_hours < SLEEP_SHORT_THRESHOLD_HOURS,
  ).length;
  const sleepBreached = shortNights >= SLEEP_BREACH_NIGHTS;

  // ── Compose ────────────────────────────────────────────────────────────
  const count =
    (hrvBreached ? 1 : 0) +
    (e1rmSignal?.breached ? 1 : 0) +
    (rpeSignal?.breached ? 1 : 0) +
    (sleepBreached ? 1 : 0);

  return {
    hrv: {
      breached: hrvBreached,
      days_outside_swc: daysOutside,
      swc_lower: swcLower,
      swc_upper: swcUpper,
      today: todayHrv,
      sample_days: hrvVals.length,
    },
    e1rm: e1rmSignal,
    rpe: rpeSignal,
    sleep: {
      breached: sleepBreached,
      short_nights: shortNights,
      threshold_hours: SLEEP_SHORT_THRESHOLD_HOURS,
    },
    count,
    should_deload: count >= 2,
    computed_at: asOf,
  };
}

/** True if exercise name belongs to the named primary lift family.
 *  Conservative — matches the obvious variants only. */
function matchesPrimaryLift(name: string, lift: PrimaryLift): boolean {
  const n = name.toLowerCase();
  switch (lift) {
    case "squat":    return n.includes("squat");
    case "bench":    return n.includes("bench") && n.includes("press");
    case "deadlift": return n.includes("deadlift");
    case "ohp":      return (n.includes("overhead") || n.includes("ohp")) && n.includes("press");
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Smoke probe against real data**

Create temp `scripts/probe-autoreg.mjs` (NOT committed):

```js
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const sr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: users } = await sr.auth.admin.listUsers();
const userId = users.users[0].id;

const { getAutoregulationSignals } = await import("../lib/coach/autoregulation.ts");
const today = new Date().toISOString().slice(0, 10);

for (const lift of ["deadlift", "squat", "bench", "ohp", null]) {
  const r = await getAutoregulationSignals(sr, userId, today, lift);
  console.log(`\n=== primary_lift=${lift ?? "(none)"} ===`);
  console.log("HRV breached:", r.hrv.breached, "swc:", r.hrv.swc_lower, "→", r.hrv.swc_upper, "today:", r.hrv.today);
  console.log("e1RM:", r.e1rm);
  console.log("Sleep:", r.sleep);
  console.log("Count:", r.count, "should_deload:", r.should_deload);
}
```

Run:

```bash
npx --yes tsx scripts/probe-autoreg.mjs
```

Expected: a panel for each lift. HRV signal should populate (real data). e1RM should populate for deadlift (per probe in spec brainstorming, user has 5 deadlift sessions in last 28d). RPE always null in v1. Sleep should populate.

If `count >= 2` for any panel, that's currently a real deload alert for the user — that's not a bug, just signal data.

- [ ] **Step 4: Delete probe & commit**

```bash
rm scripts/probe-autoreg.mjs
git add lib/coach/autoregulation.ts
git commit -m "feat(coach): autoregulation 4-signal panel (HRV/e1RM/RPE/sleep)

Computes signals on demand from daily_logs + workouts. Triangulation
rule: should_deload = count >= 2. RPE returns null in v1 (no numeric
RPE source yet — Strong app exposes failure:true only). HRV uses
±0.5 SD SWC band on 7d rolling mean per Addleman 2024.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: TrainingWeek fetcher + hook + query keys

**Files:**
- Create: `lib/query/fetchers/trainingWeek.ts`
- Create: `lib/query/hooks/useTrainingWeek.ts`
- Modify: `lib/query/keys.ts`

Dual-fetcher pattern per CLAUDE.md. Server fetcher takes a `SupabaseClient`; browser fetcher uses `createSupabaseBrowserClient`. Both share the same SELECT and return type.

- [ ] **Step 1: Add query keys**

In `lib/query/keys.ts`, append a new section under the existing exports:

```diff
   recommendations: {
     week: (userId: string, weekStart: string) =>
       ["recommendations", userId, weekStart] as const,
   },
+  trainingWeeks: {
+    one: (userId: string, weekStart: string) =>
+      ["training-weeks", userId, "one", weekStart] as const,
+    range: (userId: string, from: string, to: string) =>
+      ["training-weeks", userId, "range", from, to] as const,
+  },
+  blockProgress: {
+    active: (userId: string) => ["block-progress", userId, "active"] as const,
+  },
 } as const;
```

- [ ] **Step 2: Create the fetcher**

Write `lib/query/fetchers/trainingWeek.ts`:

```ts
// lib/query/fetchers/trainingWeek.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { TrainingWeek } from "@/lib/data/types";

const COLS =
  "id, user_id, block_id, week_start, session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";

/** Server-side: fetch the single training_week row for `weekStart`, or null
 *  if not committed. Throws on supabase errors so TanStack Query lights up
 *  isError. */
export async function fetchTrainingWeekServer(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string,
): Promise<TrainingWeek | null> {
  const { data, error } = await supabase
    .from("training_weeks")
    .select(COLS)
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;
  return (data as TrainingWeek | null) ?? null;
}

export async function fetchTrainingWeekBrowser(
  userId: string,
  weekStart: string,
): Promise<TrainingWeek | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("training_weeks")
    .select(COLS)
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;
  return (data as TrainingWeek | null) ?? null;
}
```

- [ ] **Step 3: Create the hook**

Write `lib/query/hooks/useTrainingWeek.ts`:

```ts
// lib/query/hooks/useTrainingWeek.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchTrainingWeekBrowser } from "@/lib/query/fetchers/trainingWeek";

/** Single committed training_week row (or null). Used by the strength tab to
 *  resolve TodayPlanCard.session_plan and by /coach to render WeekPlanCard. */
export function useTrainingWeek(userId: string, weekStart: string) {
  return useQuery({
    queryKey: queryKeys.trainingWeeks.one(userId, weekStart),
    queryFn: () => fetchTrainingWeekBrowser(userId, weekStart),
    staleTime: 60_000,
    refetchOnMount: false,
  });
}
```

- [ ] **Step 4: Typecheck & commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/query/keys.ts lib/query/fetchers/trainingWeek.ts lib/query/hooks/useTrainingWeek.ts
git commit -m "feat(query): trainingWeek dual fetcher + hook + query keys

Follows the hybrid SSR-hydrate pattern in CLAUDE.md. Used by the strength
tab to resolve current-week session_plan and by /coach to render
WeekPlanCard. Adds trainingWeeks + blockProgress key factories.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Strength tab — read `training_weeks` first, fall back to `WEEKLY_SESSIONS`

**Files:**
- Modify: `app/strength/page.tsx`
- Modify: `components/strength/StrengthClient.tsx`
- Modify: `components/strength/TodayPlanCard.tsx`

Kills the original Friday=Legs bug independently of the chat flow. After this task, you can manually `INSERT` a `training_weeks` row in the Supabase SQL editor and confirm the strength tab respects it.

- [ ] **Step 1: Prefetch training_week in `app/strength/page.tsx`**

Open `app/strength/page.tsx`. At the top, add the import:

```ts
import { fetchTrainingWeekServer } from "@/lib/query/fetchers/trainingWeek";
import { currentWeekMonday } from "@/lib/coach/week";
```

In the `Promise.all` prefetch block (around line 37 of the existing file), add the new prefetch:

```diff
   const queryClient = makeServerQueryClient();
+  const currentWeekStart = currentWeekMonday();
   await Promise.all([
     queryClient.prefetchQuery({
       queryKey: queryKeys.profile.one(user.id),
       queryFn: () => fetchProfileServer(supabase, user.id),
     }),
     queryClient.prefetchQuery({
       queryKey: queryKeys.workouts.all(user.id),
       queryFn: () => fetchAllWorkoutsServer(supabase, user.id),
     }),
     queryClient.prefetchQuery({
       queryKey: queryKeys.insights.strength(user.id),
       queryFn: () => fetchStrengthInsightsServer(supabase, user.id),
     }),
     queryClient.prefetchQuery({
       queryKey: queryKeys.dailyLogs.range(user.id, todayIso, todayIso),
       queryFn: () => fetchDailyLogsServer(supabase, user.id, todayIso, todayIso),
     }),
     queryClient.prefetchQuery({
       queryKey: queryKeys.checkin.one(user.id, todayIso),
       queryFn: () => fetchCheckinServer(supabase, user.id, todayIso),
     }),
+    queryClient.prefetchQuery({
+      queryKey: queryKeys.trainingWeeks.one(user.id, currentWeekStart),
+      queryFn: () => fetchTrainingWeekServer(supabase, user.id, currentWeekStart),
+    }),
   ]);
```

Pass `currentWeekStart` to `<StrengthClient>`:

```diff
       <StrengthClient
         userId={user.id}
         todayIso={todayIso}
+        currentWeekStart={currentWeekStart}
         initialView={initialView}
         initialDate={initialDate}
         selectedExercise={selectedExercise}
       />
```

- [ ] **Step 2: Use `useTrainingWeek` in `StrengthClient`**

Open `components/strength/StrengthClient.tsx`. Add the import and the new prop:

```diff
 import { useFullWorkouts } from "@/lib/query/hooks/useFullWorkouts";
 import { useStrengthInsights } from "@/lib/query/hooks/useStrengthInsights";
 import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
 import { useCheckin } from "@/lib/query/hooks/useCheckin";
 import { useProfile } from "@/lib/query/hooks/useProfile";
+import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
+import { weekdayInUserTz } from "@/lib/time";
+import type { Weekday } from "@/lib/data/types";
```

Update the props block:

```diff
 export function StrengthClient({
   userId,
   todayIso,
+  currentWeekStart,
   initialView,
   initialDate,
   selectedExercise,
 }: {
   userId: string;
   todayIso: string;
+  currentWeekStart: string;
   initialView: View;
   initialDate: string | null;
   selectedExercise: string | undefined;
 }) {
```

After the existing hook calls, add:

```ts
const { data: committedWeek = null } = useTrainingWeek(userId, currentWeekStart);

// Map en-US weekday names to our Weekday keys ("Mon" | "Tue" | ...)
const WEEKDAY_MAP: Record<string, Weekday> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
  Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};
const todayWeekdayKey = WEEKDAY_MAP[weekdayInUserTz()];
const committedSessionType = committedWeek?.session_plan?.[todayWeekdayKey] ?? null;
const committedRirTarget   = committedWeek?.rir_target ?? null;
const committedPhase       = committedWeek?.research_phase ?? null;
const weekN                = committedWeek ? null /* set below if block_id present — wire in Task 14 */ : null;
```

Now find where `dailyPlan` is computed (around line 92 in the current file: `const dailyPlan = buildDailyPlan(todayLog, feel, hrvBaseline);`). The session-type override needs to flow through `buildDailyPlan`. The simplest path is to thread the override into that call.

Open `lib/coach/readiness.ts`. Update `buildDailyPlan` signature:

```diff
 export function buildDailyPlan(
   log: Pick<DailyLog, "hrv" | "sleep_score" | "recovery"> | null,
   feel: FeelInput | null,
   hrvBaseline?: number,
+  override?: {
+    sessionType?: string | null;
+    intensityMultiplier?: number | null;
+  },
 ): DailyPlan {
   const readiness = computeDailyReadiness(log, feel, hrvBaseline);
   const mode = getIntensityMode(readiness, feel);
-  const sessionType = getTodaySession();
+  const sessionType = override?.sessionType ?? getTodaySession();
+  const effectiveMult = override?.intensityMultiplier ?? mode.multiplier;
   const exercises = (SESSION_PLANS[sessionType] ?? []).map((ex) => {
     if (!ex.baseKg) {
       return { ...ex, target: ex.reps ?? "—", adjusted: false };
     }
     const adjKg =
-      mode.multiplier === 0 ? 0 : Math.round(ex.baseKg * mode.multiplier * 2) / 2;
+      effectiveMult === 0 ? 0 : Math.round(ex.baseKg * effectiveMult * 2) / 2;
     const adjReps =
-      mode.multiplier >= 0.85
+      effectiveMult >= 0.85
         ? ex.baseReps!
         : Math.round((ex.baseReps ?? 8) * 1.2);
-    const target = mode.multiplier === 0 ? "Skip" : `${adjKg}kg × ${adjReps} × ${ex.sets ?? 3}`;
-    const isPRAttempt = mode.multiplier >= 1.0;
+    const target = effectiveMult === 0 ? "Skip" : `${adjKg}kg × ${adjReps} × ${ex.sets ?? 3}`;
+    const isPRAttempt = effectiveMult >= 1.0;
     return {
       ...ex,
       target,
       adjKg,
       adjReps,
       adjusted: adjKg !== ex.baseKg,
       isPRAttempt,
     };
   });
   return { readiness, mode, sessionType, exercises };
 }
```

Then in `StrengthClient.tsx`, call with the override:

```diff
-const dailyPlan = buildDailyPlan(todayLog, feel, hrvBaseline);
+// Pick the first key in committed intensity_modifier that has a value;
+// for v1 each block has a single primary_lift so there's at most one entry.
+const firstIntensityValue =
+  committedWeek?.intensity_modifier
+    ? Object.values(committedWeek.intensity_modifier)[0] ?? null
+    : null;
+const dailyPlan = buildDailyPlan(todayLog, feel, hrvBaseline, {
+  sessionType: committedSessionType,
+  intensityMultiplier: firstIntensityValue,
+});
```

- [ ] **Step 3: Update `TodayPlanCard` to surface "WEEK N · ACCUMULATE · RIR 2" pill**

Pass two new props through `StrengthClient` → `TodayPlanCard`:

In `StrengthClient.tsx`, the existing render:

```diff
-{activeView === "today" ? (
-  <TodayPlanCard plan={dailyPlan} />
+{activeView === "today" ? (
+  <TodayPlanCard
+    plan={dailyPlan}
+    committedFromPlan={committedSessionType !== null}
+    rirTarget={committedRirTarget}
+    researchPhase={committedPhase}
+  />
 ) : ...
```

In `components/strength/TodayPlanCard.tsx`, extend the props and replace the existing intensity-mode pill:

```diff
 type Props = {
   plan: DailyPlan;
+  committedFromPlan?: boolean;
+  rirTarget?: number | null;
+  researchPhase?: "accumulate" | "deload" | null;
 };

 export function TodayPlanCard({ plan }: Props) {
+export function TodayPlanCard({ plan, committedFromPlan, rirTarget, researchPhase }: Props) {
   const accent = modeColorLight(plan.mode.color);
+
+  // Pill text: prefer committed plan info if present.
+  const pillText = committedFromPlan
+    ? [
+        researchPhase ? researchPhase.toUpperCase() : null,
+        rirTarget != null ? `RIR ${rirTarget}` : null,
+      ].filter(Boolean).join(" · ")
+    : "DEFAULT — PLAN ON COACH ↗";
+  const pillIsLink = !committedFromPlan;
```

Then in the JSX, replace the existing pill (the `<span>` showing `plan.mode.label.replace(/^[^\s]+\s/, "")`) with:

```tsx
{pillIsLink ? (
  <a
    href="/coach?mode=plan_week"
    style={{
      fontSize: "10px",
      padding: "4px 8px",
      background: "rgba(255,255,255,0.18)",
      borderRadius: "9999px",
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      color: "#fff",
      textDecoration: "none",
    }}
  >
    {pillText}
  </a>
) : (
  <span
    style={{
      fontSize: "10px",
      padding: "4px 8px",
      background: "rgba(255,255,255,0.18)",
      borderRadius: "9999px",
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
    }}
  >
    {pillText}
  </span>
)}
```

- [ ] **Step 4: Typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

- [ ] **Step 5: Manual smoke test**

Start the dev server:

```bash
npm run dev
```

In another terminal, INSERT a test row:

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
for (const l of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const sr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sr.auth.admin.listUsers().then(r => {
  const userId = r.data.users[0].id;
  // Friday's slot is 'Arms', overriding WEEKLY_SESSIONS=Legs
  const today = new Date();
  const day = today.getUTCDay() || 7;
  const monday = new Date(today); monday.setUTCDate(today.getUTCDate() - (day - 1)); monday.setUTCHours(0,0,0,0);
  return sr.from('training_weeks').upsert({
    user_id: userId,
    week_start: monday.toISOString().slice(0,10),
    session_plan: { Mon: 'Chest', Tue: 'Legs', Wed: 'Mobility', Thu: 'Back', Fri: 'Arms', Sat: 'REST', Sun: 'REST' },
    rir_target: 2,
    research_phase: 'accumulate',
    proposed_by: 'user',
  }, { onConflict: 'user_id,week_start' });
}).then(r => console.log(r.error || 'ok'));
"
```

Visit `http://localhost:3000/strength?view=today`. Expected:
- Card title shows the day's session per the inserted plan (Friday → "Arms", not "Legs")
- Pill at top right shows `ACCUMULATE · RIR 2` (not the readiness-mode label)

Also clear the test row and reload — pill should switch to `DEFAULT — PLAN ON COACH ↗` and the session type should fall back to `WEEKLY_SESSIONS`.

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
for (const l of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const sr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sr.auth.admin.listUsers().then(r => sr.from('training_weeks').delete().eq('user_id', r.data.users[0].id));
"
```

- [ ] **Step 6: Commit**

```bash
git add app/strength/page.tsx components/strength/StrengthClient.tsx components/strength/TodayPlanCard.tsx lib/coach/readiness.ts
git commit -m "feat(strength): TodayPlanCard reads training_weeks first, falls back to WEEKLY_SESSIONS

Kills the Friday=Legs bug independently of the chat flow. New override
in buildDailyPlan() lets the strength tab inject a session-type +
intensity multiplier from the committed plan; absent that, behavior is
unchanged.

New pill on TodayPlanCard: 'WEEK N · ACCUMULATE · RIR 2' when reading
from a committed plan, 'DEFAULT — PLAN ON COACH ↗' (link to /coach) as
fallback. The 'WEEK N' part wires up in Task 15 (BlockProgressCard).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Coach tools — 4 read tools

**Files:**
- Modify: `lib/coach/tools.ts`

Adds `query_training_blocks`, `query_training_weeks`, `get_autoregulation_signals`, `compute_adherence` to the existing tool registry. Each follows the existing security invariants: no `user_id` in input schema, executor receives `userId` from the route, every query has `.eq("user_id", userId)`.

- [ ] **Step 1: Add tool schemas**

Open `lib/coach/tools.ts`. Find where the existing `WORKOUTS_TOOL` and `DAILY_LOGS_TOOL` constants are exported. Append four new tool schema constants:

```ts
export const TRAINING_BLOCKS_TOOL = {
  name: "query_training_blocks",
  description:
    "Fetch the athlete's training blocks. Default returns the active block (or 0 rows if none). status='all' returns full history. Use when planning a week or recapping block-level progress.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: {
        type: "string",
        enum: ["active", "completed", "abandoned", "all"],
        default: "active",
      },
    },
  },
};

export const TRAINING_WEEKS_TOOL = {
  name: "query_training_weeks",
  description:
    "Fetch committed weekly plans (training_weeks rows) in a date range. Range cap: 90 days. Use when recapping a recent week or referencing what was committed.",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date", description: "YYYY-MM-DD inclusive lower bound." },
      end_date: { type: "string", format: "date", description: "YYYY-MM-DD inclusive upper bound." },
    },
  },
};

export const AUTOREGULATION_TOOL = {
  name: "get_autoregulation_signals",
  description:
    "Compute the 4 fatigue signals (HRV vs SWC band, e1RM drop on primary lift, RPE drift, sleep<6h nights) for an as-of date. Returns count of signals fired and should_deload boolean (count>=2). Call before proposing a week plan to surface deload alerts.",
  input_schema: {
    type: "object" as const,
    properties: {
      as_of: { type: "string", format: "date", description: "Defaults to today (user TZ)." },
    },
  },
};

export const ADHERENCE_TOOL = {
  name: "compute_adherence",
  description:
    "Compute planned-vs-actual session adherence and per-muscle volume deltas vs prior-4w-avg for a Mon-Sun window. Use during the RECAP beat of plan_week mode to ground the recap in concrete numbers.",
  input_schema: {
    type: "object" as const,
    required: ["week_start"],
    properties: {
      week_start: { type: "string", format: "date", description: "Monday (UTC) of the week to recap." },
    },
  },
};
```

- [ ] **Step 2: Add executors**

Still in `lib/coach/tools.ts`, find where the existing executors live (`executeQueryDailyLogs`, `executeQueryWorkouts` or similar). Add four new executor functions:

```ts
import { computeAdherence } from "@/lib/coach/adherence";
import { getAutoregulationSignals } from "@/lib/coach/autoregulation";
import { todayInUserTz } from "@/lib/time";
import type { PrimaryLift } from "@/lib/data/types";

export async function executeQueryTrainingBlocks(
  supabase: SupabaseClient,
  userId: string,
  input: { status?: "active" | "completed" | "abandoned" | "all" },
): Promise<unknown> {
  const status = input.status ?? "active";
  let q = supabase.from("training_blocks").select("*").eq("user_id", userId);
  if (status !== "all") q = q.eq("status", status);
  q = q.order("start_date", { ascending: false });
  const { data, error } = await q;
  if (error) throw error;

  // Lazy-flip 'active' blocks past their end_date to 'completed'
  const today = todayInUserTz();
  const out = [];
  for (const row of data ?? []) {
    if (row.status === "active" && row.end_date < today) {
      const upd = await supabase
        .from("training_blocks")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", row.id)
        .select()
        .single();
      if (upd.error) throw upd.error;
      out.push(upd.data);
    } else {
      out.push(row);
    }
  }
  return out;
}

export async function executeQueryTrainingWeeks(
  supabase: SupabaseClient,
  userId: string,
  input: { start_date: string; end_date: string },
): Promise<unknown> {
  // 90-day cap
  const start = new Date(input.start_date + "T00:00:00Z");
  const end = new Date(input.end_date + "T00:00:00Z");
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (days > 90) {
    return { error: "range > 90 days; narrow your query" };
  }
  const { data, error } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", userId)
    .gte("week_start", input.start_date)
    .lte("week_start", input.end_date)
    .order("week_start", { ascending: true });
  if (error) throw error;
  return data;
}

export async function executeGetAutoregulationSignals(
  supabase: SupabaseClient,
  userId: string,
  input: { as_of?: string },
): Promise<unknown> {
  const asOf = input.as_of ?? todayInUserTz();

  // Find primary_lift from active block (if any)
  const { data: activeBlock, error } = await supabase
    .from("training_blocks")
    .select("primary_lift")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  const primaryLift = (activeBlock?.primary_lift as PrimaryLift | null) ?? null;

  return await getAutoregulationSignals(supabase, userId, asOf, primaryLift);
}

export async function executeComputeAdherence(
  supabase: SupabaseClient,
  userId: string,
  input: { week_start: string },
): Promise<unknown> {
  return await computeAdherence(supabase, userId, input.week_start);
}
```

- [ ] **Step 3: Register the tools**

Find the existing tool registry / router in `lib/coach/tools.ts` (or wherever the chat API route imports tools from). Add the new tools to whatever array drives the Anthropic `tools` parameter and add cases to whatever switch dispatches `tool_use` blocks. The exact shape depends on the existing code — match it.

If there is no central registry yet, add one:

```ts
export const ALL_COACH_TOOLS = [
  DAILY_LOGS_TOOL,
  WORKOUTS_TOOL,
  TRAINING_BLOCKS_TOOL,
  TRAINING_WEEKS_TOOL,
  AUTOREGULATION_TOOL,
  ADHERENCE_TOOL,
  // (Task 11 will append the 4 propose/commit tools here)
];

export async function executeCoachTool(
  supabase: SupabaseClient,
  userId: string,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  switch (toolName) {
    case "query_daily_logs":            return executeQueryDailyLogs(supabase, userId, input as ...);
    case "query_workouts":              return executeQueryWorkouts(supabase, userId, input as ...);
    case "query_training_blocks":       return executeQueryTrainingBlocks(supabase, userId, input as ...);
    case "query_training_weeks":        return executeQueryTrainingWeeks(supabase, userId, input as ...);
    case "get_autoregulation_signals":  return executeGetAutoregulationSignals(supabase, userId, input as ...);
    case "compute_adherence":           return executeComputeAdherence(supabase, userId, input as ...);
    default: throw new Error(`unknown tool: ${toolName}`);
  }
}
```

If the registry pattern in this file already exists with different naming, follow it instead.

- [ ] **Step 4: Typecheck & smoke**

```bash
npm run typecheck
```

The chat API route is wired up in Task 12; you can't end-to-end test these tools yet. Smoke test by calling the executors directly via a temp script if you want extra confidence — otherwise typecheck-only is acceptable here.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(coach): 4 read tools — training_blocks, training_weeks, autoreg, adherence

Anthropic tool schemas + executors. Lazy-flips active blocks to completed
when today > end_date during query_training_blocks. Other executors are
thin wrappers over lib/coach/{adherence,autoregulation}.ts.

Tools not yet wired into the chat route; Task 12 wires them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Coach tools — 4 write tools (propose/commit pairs)

**Files:**
- Modify: `lib/coach/tools.ts`

Adds `propose_block`, `commit_block`, `propose_week_plan`, `commit_week_plan`. Each `propose_*` returns a preview + signed approval token without writing. Each `commit_*` requires the token to write.

- [ ] **Step 1: Add tool schemas**

Append in `lib/coach/tools.ts`:

```ts
export const PROPOSE_BLOCK_TOOL = {
  name: "propose_block",
  description:
    "Generate a preview of a new 5-week training block. Does NOT write to the database. Returns a preview object plus an approval_token that the matching commit_block call must include after the user explicitly approves the proposal.",
  input_schema: {
    type: "object" as const,
    required: ["goal_text", "start_date", "end_date"],
    properties: {
      goal_text:     { type: "string", minLength: 4, maxLength: 200 },
      primary_lift:  { type: "string", enum: ["squat","bench","deadlift","ohp"] },
      target_metric: { type: "string", enum: ["e1rm","working_weight"] },
      target_value:  { type: "number", minimum: 0 },
      target_unit:   { type: "string", default: "kg" },
      start_date:    { type: "string", format: "date", description: "Must be a Monday." },
      end_date:      { type: "string", format: "date", description: "Must be exactly start_date + 34 days." },
    },
  },
};

export const COMMIT_BLOCK_TOOL = {
  name: "commit_block",
  description:
    "Commit a previously proposed block. Requires the approval_token returned by propose_block. Idempotent on the user's active-block partial unique index — fails if the user already has an active block.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export const PROPOSE_WEEK_PLAN_TOOL = {
  name: "propose_week_plan",
  description:
    "Generate a preview of a weekly training plan. Does NOT write. Returns preview + approval_token. Call after deriving RIR target from week-of-block (1-4 = accumulate, 5 = deload) and consulting get_autoregulation_signals.",
  input_schema: {
    type: "object" as const,
    required: ["week_start", "session_plan"],
    properties: {
      week_start:         { type: "string", format: "date", description: "Must be a Monday." },
      session_plan:       {
        type: "object",
        description: "Mon-Sun map of session-type strings (or 'REST').",
        additionalProperties: { type: "string" },
      },
      weekly_focus:       { type: "string", maxLength: 200 },
      intensity_modifier: {
        type: "object",
        description: "Per-primary-lift multipliers, e.g. {squat: 0.95}.",
        additionalProperties: { type: "number" },
      },
      rir_target:         { type: "integer", minimum: 1, maximum: 4 },
      research_phase:     { type: "string", enum: ["accumulate","deload"] },
      rationale:          { type: "string", maxLength: 500, description: "Surfaced to the user in the proposal preview card." },
    },
  },
};

export const COMMIT_WEEK_PLAN_TOOL = {
  name: "commit_week_plan",
  description:
    "Commit a previously proposed week plan. Requires the approval_token from propose_week_plan. Idempotent on (user_id, week_start) — re-committing UPDATEs the existing row.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};
```

- [ ] **Step 2: Add executors**

```ts
import { signApprovalToken, verifyApprovalToken } from "@/lib/coach/approval-token";

type ProposeBlockInput = {
  goal_text: string;
  primary_lift?: PrimaryLift;
  target_metric?: "e1rm" | "working_weight";
  target_value?: number;
  target_unit?: string;
  start_date: string;
  end_date: string;
};

type ProposeWeekPlanInput = {
  week_start: string;
  session_plan: Record<string, string>;
  weekly_focus?: string;
  intensity_modifier?: Record<string, number>;
  rir_target?: number;
  research_phase?: "accumulate" | "deload";
  rationale?: string;
};

/** In-memory map (per-request, not persisted) of token → payload, so commit
 *  can reconstruct the exact payload. Lives on a per-route module global —
 *  request handlers use one executor instance per request, so cross-request
 *  leakage is impossible. */
const _proposalCache = new Map<string, { kind: "block" | "week"; payload: unknown }>();

export function executeProposeBlock(
  userId: string,
  input: ProposeBlockInput,
): { preview: ProposeBlockInput; approval_token: string } {
  // Validate start = Monday and end = start + 34 days
  const start = new Date(input.start_date + "T00:00:00Z");
  const end = new Date(input.end_date + "T00:00:00Z");
  if (start.getUTCDay() !== 1) throw new Error("propose_block: start_date must be a Monday");
  const expectedEnd = new Date(start); expectedEnd.setUTCDate(start.getUTCDate() + 34);
  if (end.toISOString().slice(0,10) !== expectedEnd.toISOString().slice(0,10)) {
    throw new Error("propose_block: end_date must be exactly start_date + 34 days (5 weeks)");
  }
  // target_value/target_metric must come together
  if ((input.target_metric == null) !== (input.target_value == null)) {
    throw new Error("propose_block: target_metric and target_value must both be set or both be null");
  }
  const token = signApprovalToken({ userId, action: "block", payload: input });
  _proposalCache.set(token, { kind: "block", payload: input });
  return { preview: input, approval_token: token };
}

export async function executeCommitBlock(
  supabase: SupabaseClient,
  userId: string,
  input: { approval_token: string },
): Promise<unknown> {
  const cached = _proposalCache.get(input.approval_token);
  if (!cached || cached.kind !== "block") throw new Error("commit_block: no matching proposal in cache");
  verifyApprovalToken({ token: input.approval_token, userId, action: "block", payload: cached.payload });
  const p = cached.payload as ProposeBlockInput;

  const { data, error } = await supabase
    .from("training_blocks")
    .insert({
      user_id: userId,
      status: "active",
      start_date: p.start_date,
      end_date: p.end_date,
      goal_text: p.goal_text,
      primary_lift: p.primary_lift ?? null,
      target_metric: p.target_metric ?? null,
      target_value: p.target_value ?? null,
      target_unit: p.target_unit ?? "kg",
    })
    .select()
    .single();
  if (error) throw error;
  _proposalCache.delete(input.approval_token);
  return data;
}

export function executeProposeWeekPlan(
  userId: string,
  input: ProposeWeekPlanInput,
): { preview: ProposeWeekPlanInput; approval_token: string } {
  // Validate week_start = Monday
  const ws = new Date(input.week_start + "T00:00:00Z");
  if (ws.getUTCDay() !== 1) throw new Error("propose_week_plan: week_start must be a Monday");
  const token = signApprovalToken({ userId, action: "week", payload: input });
  _proposalCache.set(token, { kind: "week", payload: input });
  return { preview: input, approval_token: token };
}

export async function executeCommitWeekPlan(
  supabase: SupabaseClient,
  userId: string,
  input: { approval_token: string; chat_message_id?: string },
): Promise<unknown> {
  const cached = _proposalCache.get(input.approval_token);
  if (!cached || cached.kind !== "week") throw new Error("commit_week_plan: no matching proposal in cache");
  verifyApprovalToken({ token: input.approval_token, userId, action: "week", payload: cached.payload });
  const p = cached.payload as ProposeWeekPlanInput;

  // Find active block to set block_id (nullable)
  const { data: active } = await supabase
    .from("training_blocks")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  const { data, error } = await supabase
    .from("training_weeks")
    .upsert(
      {
        user_id: userId,
        block_id: active?.id ?? null,
        week_start: p.week_start,
        session_plan: p.session_plan,
        weekly_focus: p.weekly_focus ?? null,
        intensity_modifier: p.intensity_modifier ?? {},
        rir_target: p.rir_target ?? null,
        research_phase: p.research_phase ?? null,
        proposed_by: "coach",
        chat_message_id: input.chat_message_id ?? null,
        committed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,week_start" },
    )
    .select()
    .single();
  if (error) throw error;
  _proposalCache.delete(input.approval_token);
  return data;
}
```

- [ ] **Step 3: Register the new tools**

Append to `ALL_COACH_TOOLS` and the `executeCoachTool` switch:

```diff
 export const ALL_COACH_TOOLS = [
   DAILY_LOGS_TOOL,
   WORKOUTS_TOOL,
   TRAINING_BLOCKS_TOOL,
   TRAINING_WEEKS_TOOL,
   AUTOREGULATION_TOOL,
   ADHERENCE_TOOL,
+  PROPOSE_BLOCK_TOOL,
+  COMMIT_BLOCK_TOOL,
+  PROPOSE_WEEK_PLAN_TOOL,
+  COMMIT_WEEK_PLAN_TOOL,
 ];
```

```diff
 export async function executeCoachTool(...) {
   switch (toolName) {
     ...
+    case "propose_block":         return executeProposeBlock(userId, input as ...);
+    case "commit_block":          return executeCommitBlock(supabase, userId, input as ...);
+    case "propose_week_plan":     return executeProposeWeekPlan(userId, input as ...);
+    case "commit_week_plan":      return executeCommitWeekPlan(supabase, userId, { ...(input as object), chat_message_id });
   }
 }
```

(Note: `chat_message_id` isn't a tool input — it's the assistant turn's id, passed in by the caller.)

- [ ] **Step 4: Typecheck & commit**

```bash
npm run typecheck
git add lib/coach/tools.ts
git commit -m "feat(coach): 4 write tools — propose/commit for block + week plan

Propose tools return a preview + signed approval_token without writing.
Commit tools require the token (HMAC-verified) before writing. In-memory
per-request proposal cache lets commit reconstruct the exact payload
without a round-trip back through the model.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Chat API mode resolution + persistence

**Files:**
- Modify: `app/api/chat/messages/route.ts` (and whichever chat-streaming route exists; see existing structure)
- Modify: `app/api/chat/messages/route.ts` POST handler

The chat API needs to:
1. Accept an optional `mode` field on the POST request (sent from URL `?mode=...` flow)
2. If absent, look up the most recent `chat_messages` row for this user; inherit its `mode` if non-default
3. Stamp both the user turn and the assistant turn with the resolved mode

- [ ] **Step 1: Find the chat send/stream route**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -rn "chat_send_user_message\|status: 'streaming'\|chat_messages.*insert" app/api/chat/ 2>/dev/null
```

This identifies whichever route inserts the user turn and assistant stub.

- [ ] **Step 2: Add `mode` to the request body type and pass it through**

Locate the POST handler. The existing flow uses the `chat_send_user_message` RPC (per [migration 0005](supabase/migrations/0005_chat.sql)) which inserts both the user message and the assistant stub atomically.

We need to add a `mode` parameter. Two paths:

**Path A (preferred):** Update the RPC to take an additional `p_mode` param and stamp both rows. Requires a small migration.

**Path B (no-migration):** After the RPC returns the two row ids, do an `update` on those rows to set `mode`. One extra round-trip but no schema change.

Use **Path B** for v1 since it's a tiny perf cost and avoids touching the existing migration's RPC contract. Implement:

In the POST handler, after the existing RPC call returns `{ user_message_id, assistant_message_id }`, before streaming starts:

```ts
import type { ChatMode } from "@/lib/data/types";

// 1. Parse mode from request body (default null = inherit/default)
const requestedMode: ChatMode | null = (body.mode === "plan_week" || body.mode === "setup_block") ? body.mode : null;

// 2. Resolve effective mode
let effectiveMode: ChatMode = "default";
if (requestedMode) {
  effectiveMode = requestedMode;
} else {
  // Inherit from the most recent message
  const { data: prior } = await sr
    .from("chat_messages")
    .select("mode")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prior?.mode === "plan_week" || prior?.mode === "setup_block") {
    effectiveMode = prior.mode;
  }
}

// 3. Stamp both rows with the resolved mode
await sr
  .from("chat_messages")
  .update({ mode: effectiveMode, updated_at: new Date().toISOString() })
  .in("id", [user_message_id, assistant_message_id]);
```

- [ ] **Step 3: Pass `effectiveMode` to the system-prompt builder**

The streaming code that calls Anthropic needs the mode so it can prepend the right mode-specific prompt. Find where the system prompt is currently assembled (likely in the same route handler or in a helper). Add a `mode` parameter:

```ts
import { buildSystemPrompt } from "@/lib/coach/planning-prompts"; // created in Task 13

const systemPrompt = await buildSystemPrompt({
  supabase: sr,
  userId,
  mode: effectiveMode,
  userPromptOverride: profile?.system_prompt ?? null,
});
```

(The exact replacement depends on how the existing route assembles the prompt; match the pattern.)

- [ ] **Step 4: Pass `effectiveMode` to the tool list**

The Anthropic SDK call needs different `tools` arrays based on mode. Default mode might exclude the propose/commit tools to keep cost down (the model can't accidentally write a plan from a casual conversation):

```ts
import { ALL_COACH_TOOLS } from "@/lib/coach/tools";

// In default mode, hide the planning-write tools to discourage accidental
// invocation. plan_week and setup_block expose the full set.
const toolsForMode = effectiveMode === "default"
  ? ALL_COACH_TOOLS.filter(t => !t.name.startsWith("propose_") && !t.name.startsWith("commit_"))
  : ALL_COACH_TOOLS;
```

Pass `toolsForMode` to the Anthropic call.

- [ ] **Step 5: Wire `executeCoachTool` to receive the assistant message id**

When the SDK fires a `tool_use` block and we dispatch to our executor, the `commit_week_plan` executor wants the assistant message id (so it can be saved on `training_weeks.chat_message_id`). Pass it through:

```ts
const result = await executeCoachTool(sr, userId, toolUse.name, toolUse.input, {
  chat_message_id: assistant_message_id,
});
```

Update `executeCoachTool` signature in `lib/coach/tools.ts` to accept the optional context object and forward it to `executeCommitWeekPlan` only.

- [ ] **Step 6: Typecheck & commit**

```bash
npm run typecheck
git add app/api/chat/messages/route.ts lib/coach/tools.ts
git commit -m "feat(chat): mode resolution, persistence, mode-aware tool list

POST accepts mode ('plan_week'|'setup_block'); falls back to inheriting
the prior turn's mode. Both user and assistant messages stamped with
resolved mode. Default mode hides propose_*/commit_* tools to prevent
accidental plan writes from casual conversation. Assistant message id
threaded into tool executor so commit_week_plan can populate
training_weeks.chat_message_id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Mode-specific system prompts (`planning-prompts.ts`)

**Files:**
- Create: `lib/coach/planning-prompts.ts`
- Modify: `lib/coach/system-prompts.ts`

Builds the mode-specific system prompt: prepends the existing `SCHEMA_EXPLAINER` + user's saved prompt (or `DEFAULT_SYSTEM_PROMPT`), then appends the mode-specific section. For `plan_week`, also injects current block context + autoregulation alert if signals fire.

- [ ] **Step 1: Create the module**

Write `lib/coach/planning-prompts.ts`:

```ts
// lib/coach/planning-prompts.ts
//
// Mode-specific system-prompt assembler. Composes:
//   SCHEMA_EXPLAINER (always)
//   + user's saved coaching prompt or DEFAULT_SYSTEM_PROMPT (always)
//   + mode-specific prompt section (default = none)
//   + active block context (plan_week / setup_block only)
//   + autoregulation alert (plan_week only, when count >= 2)

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SYSTEM_PROMPT,
  SCHEMA_EXPLAINER,
} from "@/lib/coach/system-prompts";
import { getAutoregulationSignals } from "@/lib/coach/autoregulation";
import { todayInUserTz } from "@/lib/time";
import type { ChatMode, PrimaryLift, TrainingBlock } from "@/lib/data/types";

const PLAN_WEEK_PROMPT = `## You are running a weekly planning session

Follow this 4-beat structure:

1. **RECAP** last week. Call \`compute_adherence\` for the prior Mon-Sun window and \`query_workouts\` for color. Tell the story in 1-2 sentences anchored in concrete numbers (sessions on plan, volume deltas, e1RM trajectory if rising). Be honest about misses.

2. **CHECK-IN.** Ask ONE question about how the user is feeling and any constraints (travel, soreness, schedule, sleep). Wait for the response. Do not propose anything yet.

3. **PROPOSE** the next week. Derive RIR target from week-of-block:
   - Week 1 of block: RIR 4, intensity ~0.85×
   - Week 2: RIR 3, ~0.90×
   - Week 3: RIR 2, ~0.95×
   - Week 4: RIR 1, ~1.0×
   - Week 5: deload. research_phase='deload'. Volume −50%, intensity ~0.80×, frequency held.

   Consult \`get_autoregulation_signals\`. If \`should_deload === true\` (≥2 signals firing), surface the alert in plain language and recommend deloading even if it's not week 5. Do NOT impose; the user decides.

   Call \`propose_week_plan\` with: \`week_start\` (next Monday), \`session_plan\` (Mon-Sun map of session types — use the same vocabulary the user trains in: Chest, Legs, Back, Mobility, Arms, REST), \`weekly_focus\` (1-2 sentences), \`intensity_modifier\` (e.g. {squat: 0.95}), \`rir_target\`, \`research_phase\`, and \`rationale\` (1-3 sentences explaining the choice — surfaced to the user in the proposal card).

4. **COMMIT.** Wait for user approval. The chat UI surfaces an Approve button; on approval, the user sends a message containing \`[approve:<token>]\`. When you see that, call \`commit_week_plan\` with the token. On tweaks (e.g., "make Friday Arms instead"), call \`propose_week_plan\` again with the changed payload.

## Honest progress framing rules (RECAP beat)

When narrating last week's results from compute_adherence + query_workouts + the body-comp metrics in the active block context:

- Rising e1RM → call it strength progress directly: "deadlift e1RM up 2kg this block."
- Flat e1RM during a cut (LBM dropped or weight dropped) → frame as a recomp win: "deadlift e1RM held while you dropped 0.8pp body fat — that's 2.6% stronger per kg of muscle, not a plateau."
- Flat e1RM with LBM also flat or rising → call it a plateau honestly: "deadlift e1RM hasn't moved in two weeks, LBM steady — we should change something."
- Falling e1RM with falling LBM → say it plainly: "you're losing strength faster than expected. Either deficit too aggressive or recovery short."
- Never call rising strength-per-LBM "PR-equivalent" — relative gains are real progress but not the same as absolute strength PRs.

## Concision

2-4 sentences per beat. Never commit without explicit user approval. Never propose without first running the RECAP and CHECK-IN beats unless the user says "skip the recap, just propose".`;

const SETUP_BLOCK_PROMPT = `## You are running a training block setup

We run **5-week blocks** ending in a deload week — research consensus for an intermediate lifter (Rogerson 2024). Each block has one primary-lift target. Follow this 4-beat structure:

1. **EXPLAIN** the structure: 5 weeks total, weeks 1-4 accumulate (RIR step-down 4→3→2→1, intensity 0.85→1.0×), week 5 is a deload (volume −50%, intensity ~0.80×). Mention the user can re-plan any week mid-block.

2. **ELICIT** the user's primary-lift focus and target. Single primary lift only (squat / bench / deadlift / ohp). Target metric is e1RM or working_weight in kg. Also ask for free-form goal_text (1-2 sentences) for any nuance the structure can't capture.

3. **PROPOSE** the block. Call \`propose_block\` with start_date = next Monday (UTC), end_date = start + 34 days. Surface the preview to the user.

4. **COMMIT** on explicit approval via \`[approve:<token>]\`. Then send a brief follow-up: "Block set. Come back Sunday to plan week 1." After this turn the conversation auto-flips to default mode (the route handles that).

## Concision

2-4 sentences per beat. Never commit without approval.`;

export async function buildSystemPrompt(args: {
  supabase: SupabaseClient;
  userId: string;
  mode: ChatMode;
  userPromptOverride: string | null;
}): Promise<string> {
  const userPrompt = args.userPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
  const sections: string[] = [SCHEMA_EXPLAINER, userPrompt];

  if (args.mode === "plan_week") {
    const blockCtx = await fetchActiveBlockContext(args.supabase, args.userId);
    const autoregCtx = await fetchAutoregContext(args.supabase, args.userId, blockCtx?.primary_lift ?? null);
    sections.push(PLAN_WEEK_PROMPT);
    if (blockCtx) sections.push(blockCtx.text);
    if (autoregCtx) sections.push(autoregCtx);
  } else if (args.mode === "setup_block") {
    sections.push(SETUP_BLOCK_PROMPT);
  }

  return sections.join("\n\n---\n\n");
}

async function fetchActiveBlockContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ primary_lift: PrimaryLift | null; text: string } | null> {
  const { data } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;

  const block = data as TrainingBlock;
  const today = todayInUserTz();
  const weeksElapsed = Math.max(
    0,
    Math.floor(
      (new Date(today).getTime() - new Date(block.start_date).getTime()) / (7 * 86_400_000),
    ),
  );
  const currentWeekN = Math.min(5, weeksElapsed + 1);
  const rirByWeek: Record<number, number | null> = { 1: 4, 2: 3, 3: 2, 4: 1, 5: null };
  const phaseByWeek: Record<number, "accumulate" | "deload"> = {
    1: "accumulate", 2: "accumulate", 3: "accumulate", 4: "accumulate", 5: "deload",
  };
  const targetText = block.target_metric && block.target_value
    ? ` (target: ${block.primary_lift ?? "lift"} ${block.target_metric} ${block.target_value}${block.target_unit})`
    : "";

  const text =
    `## Active block context\n\n` +
    `Block runs ${block.start_date} → ${block.end_date}. Goal: "${block.goal_text}"${targetText}.\n` +
    `This is **week ${currentWeekN} of 5**, research_phase='${phaseByWeek[currentWeekN]}'` +
    (rirByWeek[currentWeekN] !== null ? `, target RIR ${rirByWeek[currentWeekN]}` : ` (deload — no RIR target)`) +
    `.\n\n` +
    `When proposing the upcoming week, target the NEXT Monday and use the next week-number's RIR (e.g., if today is week 3, propose week 4 with RIR 1).`;

  return { primary_lift: block.primary_lift, text };
}

async function fetchAutoregContext(
  supabase: SupabaseClient,
  userId: string,
  primaryLift: PrimaryLift | null,
): Promise<string | null> {
  const today = todayInUserTz();
  const sig = await getAutoregulationSignals(supabase, userId, today, primaryLift);
  if (!sig.should_deload) return null;

  const fired: string[] = [];
  if (sig.hrv.breached) fired.push(`HRV outside SWC band ${sig.hrv.days_outside_swc}/4 days`);
  if (sig.e1rm?.breached && sig.e1rm.drop_pct != null)
    fired.push(`${sig.e1rm.lift} e1RM down ${(Math.abs(sig.e1rm.drop_pct) * 100).toFixed(1)}%`);
  if (sig.sleep.breached) fired.push(`sleep <6h on ${sig.sleep.short_nights}/4 nights`);

  return (
    `## ⚠ Autoregulation alert — ${sig.count} signals fired\n\n` +
    fired.map((f) => `- ${f}`).join("\n") + `\n\n` +
    `Recommend the user deload this week even if it's not week 5. Explain which signals fired and what they mean. The user decides — if they want to push through, propose the originally-planned week but flag the risk.`
  );
}
```

- [ ] **Step 2: Wire it from the chat route**

This is referenced in Task 12 step 3. Verify the import and call site:

```ts
import { buildSystemPrompt } from "@/lib/coach/planning-prompts";
const systemPrompt = await buildSystemPrompt({
  supabase: sr,
  userId,
  mode: effectiveMode,
  userPromptOverride: profile?.system_prompt ?? null,
});
```

- [ ] **Step 3: Typecheck & commit**

```bash
npm run typecheck
git add lib/coach/planning-prompts.ts
git commit -m "feat(coach): mode-specific system prompts for plan_week and setup_block

plan_week: 4-beat script (RECAP → CHECK-IN → PROPOSE → COMMIT) with
honest progress framing rules, active-block context, autoregulation
alert injection when signals.count >= 2.

setup_block: 4-beat script (EXPLAIN → ELICIT → PROPOSE → COMMIT) for
new-block creation, locks 5w length and the RIR step-down policy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Block progress endpoint + fetcher + hook

**Files:**
- Create: `app/api/coach/block-progress/route.ts`
- Create: `lib/query/fetchers/blockProgress.ts`
- Create: `lib/query/hooks/useBlockProgress.ts`

The endpoint that powers `<BlockProgressCard>`. Computes everything inline: e1RM rolling means, body-comp metrics, adherence aggregates, on-pace, status auto-flip.

- [ ] **Step 1: Create the route handler**

Write `app/api/coach/block-progress/route.ts`:

```ts
// app/api/coach/block-progress/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const payload = await computeBlockProgress(supabase, user.id);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Create the fetcher with all the math**

Write `lib/query/fetchers/blockProgress.ts`:

```ts
// lib/query/fetchers/blockProgress.ts
//
// Computes the full BlockProgressCard payload on demand. Single source of
// truth for: current week of block, RIR target, e1RM rolling means,
// body-comp-aware relative metrics, adherence aggregates, on-pace boolean.
//
// Used by:
//   - /api/coach/block-progress (GET) for the browser fetcher path
//   - directly by app/coach/page.tsx Server Component for prefetch

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { epley, topSet, type SetRow } from "@/lib/coach/derived";
import { computeAdherence } from "@/lib/coach/adherence";
import {
  allometric,
  deltaPct,
  ipfGl,
  strengthPerLbm,
} from "@/lib/coach/progress-metrics";
import { todayInUserTz } from "@/lib/time";
import type { PrimaryLift, TrainingBlock } from "@/lib/data/types";

export type BlockProgressPayload = {
  block: TrainingBlock;
  current_week: number;          // 1..5
  total_weeks: 5;
  research_phase: "accumulate" | "deload";
  rir_target: number | null;     // null on week 5 (deload)

  // Absolute strength
  e1rm_at_block_start: number | null;
  e1rm_now: number | null;
  e1rm_delta: number | null;
  e1rm_remaining_to_goal: number | null;
  on_pace: boolean | null;

  // Relative metrics — null when source data missing
  strength_per_lbm_at_start: number | null;
  strength_per_lbm_now: number | null;
  strength_per_lbm_delta_pct: number | null;
  allometric_at_start: number | null;
  allometric_now: number | null;
  allometric_delta_pct: number | null;
  ipf_gl_at_start: number | null;
  ipf_gl_now: number | null;
  ipf_gl_delta_pct: number | null;

  // Body comp context
  lbm_now_kg: number | null;
  bf_pct_now: number | null;
  weight_now_kg: number | null;

  // Adherence aggregates across the block-to-date
  sessions_planned_to_date: number;
  sessions_done: number;
  adherence_pct: number;
} | { active: false };

const RIR_BY_WEEK: Record<number, number | null> = { 1: 4, 2: 3, 3: 2, 4: 1, 5: null };
const PHASE_BY_WEEK: Record<number, "accumulate" | "deload"> = {
  1: "accumulate", 2: "accumulate", 3: "accumulate", 4: "accumulate", 5: "deload",
};

export async function computeBlockProgress(
  supabase: SupabaseClient,
  userId: string,
): Promise<BlockProgressPayload> {
  // 1. Active block (with lazy auto-flip)
  const today = todayInUserTz();
  const { data: rawBlock, error: blockErr } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (blockErr) throw blockErr;
  if (!rawBlock) return { active: false };

  let block = rawBlock as TrainingBlock;
  if (block.end_date < today) {
    const { data: flipped, error: flipErr } = await supabase
      .from("training_blocks")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", block.id)
      .select()
      .single();
    if (flipErr) throw flipErr;
    block = flipped as TrainingBlock;
    return { active: false };
  }

  // 2. Week-of-block
  const start = new Date(block.start_date + "T00:00:00Z");
  const todayD = new Date(today + "T00:00:00Z");
  const weeksElapsed = Math.floor((todayD.getTime() - start.getTime()) / (7 * 86_400_000));
  const currentWeek = Math.min(5, Math.max(1, weeksElapsed + 1));
  const rirTarget = RIR_BY_WEEK[currentWeek];
  const phase = PHASE_BY_WEEK[currentWeek];

  // 3. e1RM streams: 28d-before-block-start ("at start") + last 28d ("now")
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startMinus28 = new Date(start); startMinus28.setUTCDate(start.getUTCDate() - 28);
  const todayMinus28 = new Date(todayD); todayMinus28.setUTCDate(todayD.getUTCDate() - 28);

  const e1rmAtStart = block.primary_lift
    ? await rolling4wE1rmMean(supabase, userId, block.primary_lift, fmt(startMinus28), block.start_date)
    : null;
  const e1rmNow = block.primary_lift
    ? await rolling4wE1rmMean(supabase, userId, block.primary_lift, fmt(todayMinus28), today)
    : null;
  const e1rmDelta = e1rmAtStart !== null && e1rmNow !== null ? e1rmNow - e1rmAtStart : null;
  const e1rmRemaining =
    block.target_metric === "e1rm" && block.target_value && e1rmNow !== null
      ? block.target_value - e1rmNow
      : null;
  const onPace = computeOnPace(block, e1rmAtStart, e1rmNow, weeksElapsed);

  // 4. Body comp at block-start and now
  const lbmAtStart = await mostRecentColumnNear(supabase, userId, "fat_free_mass_kg", block.start_date, 14);
  const bwAtStart  = await mostRecentColumnNear(supabase, userId, "weight_kg", block.start_date, 14);
  const lbmNow     = await mostRecentColumnNear(supabase, userId, "fat_free_mass_kg", today, 7);
  const bwNow      = await mostRecentColumnNear(supabase, userId, "weight_kg", today, 7);
  const bfNow      = await mostRecentColumnNear(supabase, userId, "body_fat_pct", today, 7);

  // 5. Relative metrics
  const sPerLbmStart = strengthPerLbm(e1rmAtStart, lbmAtStart);
  const sPerLbmNow   = strengthPerLbm(e1rmNow, lbmNow);
  const allomStart   = allometric(e1rmAtStart, bwAtStart);
  const allomNow     = allometric(e1rmNow, bwNow);

  // 6. IPF GL — needs SBD totals in 4w windows
  const ipfStart = await maybeIpfGl(supabase, userId, fmt(startMinus28), block.start_date, bwAtStart);
  const ipfNow   = await maybeIpfGl(supabase, userId, fmt(todayMinus28), today, bwNow);

  // 7. Adherence aggregated across all weeks of the block to date
  const adh = await aggregateBlockAdherence(supabase, userId, block.start_date, today);

  return {
    block,
    current_week: currentWeek,
    total_weeks: 5,
    research_phase: phase,
    rir_target: rirTarget,
    e1rm_at_block_start: e1rmAtStart,
    e1rm_now: e1rmNow,
    e1rm_delta: e1rmDelta,
    e1rm_remaining_to_goal: e1rmRemaining,
    on_pace: onPace,
    strength_per_lbm_at_start: sPerLbmStart,
    strength_per_lbm_now: sPerLbmNow,
    strength_per_lbm_delta_pct: deltaPct(sPerLbmStart, sPerLbmNow),
    allometric_at_start: allomStart,
    allometric_now: allomNow,
    allometric_delta_pct: deltaPct(allomStart, allomNow),
    ipf_gl_at_start: ipfStart,
    ipf_gl_now: ipfNow,
    ipf_gl_delta_pct: deltaPct(ipfStart, ipfNow),
    lbm_now_kg: lbmNow,
    bf_pct_now: bfNow,
    weight_now_kg: bwNow,
    sessions_planned_to_date: adh.planned,
    sessions_done: adh.done,
    adherence_pct: adh.pct,
  };
}

async function rolling4wE1rmMean(
  supabase: SupabaseClient,
  userId: string,
  lift: PrimaryLift,
  fromDate: string,
  toDate: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, set_index))")
    .eq("user_id", userId)
    .gte("date", fromDate)
    .lte("date", toDate);
  if (error) throw error;

  const e1rms: number[] = [];
  for (const w of data ?? []) {
    for (const e of w.exercises ?? []) {
      if (!liftMatches(e.name, lift)) continue;
      const top = topSet((e.exercise_sets ?? []) as SetRow[]);
      if (top && top.kg && top.reps) e1rms.push(epley(top.kg, top.reps));
    }
  }
  if (e1rms.length === 0) return null;
  return e1rms.reduce((a, b) => a + b, 0) / e1rms.length;
}

function liftMatches(name: string, lift: PrimaryLift): boolean {
  const n = name.toLowerCase();
  switch (lift) {
    case "squat":    return n.includes("squat");
    case "bench":    return n.includes("bench") && n.includes("press");
    case "deadlift": return n.includes("deadlift");
    case "ohp":      return (n.includes("overhead") || n.includes("ohp")) && n.includes("press");
  }
}

async function mostRecentColumnNear(
  supabase: SupabaseClient,
  userId: string,
  column: string,
  asOf: string,
  windowDays: number,
): Promise<number | null> {
  const asOfD = new Date(asOf + "T00:00:00Z");
  const lowerD = new Date(asOfD); lowerD.setUTCDate(asOfD.getUTCDate() - windowDays);
  const upperD = new Date(asOfD); upperD.setUTCDate(asOfD.getUTCDate() + windowDays);
  const { data, error } = await supabase
    .from("daily_logs")
    .select(`date, ${column}`)
    .eq("user_id", userId)
    .gte("date", lowerD.toISOString().slice(0, 10))
    .lte("date", upperD.toISOString().slice(0, 10))
    .not(column, "is", null)
    .order("date", { ascending: false });
  if (error) throw error;
  // Pick the entry closest to asOf
  if (!data || data.length === 0) return null;
  let best: { d: number; v: number } | null = null;
  for (const row of data as Array<Record<string, unknown>>) {
    const dist = Math.abs(new Date((row.date as string) + "T00:00:00Z").getTime() - asOfD.getTime());
    const v = row[column] as number;
    if (typeof v === "number" && Number.isFinite(v)) {
      if (!best || dist < best.d) best = { d: dist, v };
    }
  }
  return best?.v ?? null;
}

async function maybeIpfGl(
  supabase: SupabaseClient,
  userId: string,
  fromDate: string,
  toDate: string,
  bw: number | null,
): Promise<number | null> {
  if (bw === null) return null;
  const sq = await rolling4wE1rmMean(supabase, userId, "squat", fromDate, toDate);
  const bp = await rolling4wE1rmMean(supabase, userId, "bench", fromDate, toDate);
  const dl = await rolling4wE1rmMean(supabase, userId, "deadlift", fromDate, toDate);
  if (sq === null || bp === null || dl === null) return null;
  return ipfGl(sq, bp, dl, bw, "M");
}

function computeOnPace(
  block: TrainingBlock,
  e1rmAtStart: number | null,
  e1rmNow: number | null,
  weeksElapsed: number,
): boolean | null {
  if (
    !block.primary_lift ||
    block.target_metric !== "e1rm" ||
    block.target_value === null ||
    e1rmAtStart === null ||
    e1rmNow === null ||
    weeksElapsed <= 0
  ) {
    return null;
  }
  const targetDelta = block.target_value - e1rmAtStart;
  if (targetDelta <= 0) return true; // already past target
  const requiredPerWeek = targetDelta / 5;
  const actualPerWeek = (e1rmNow - e1rmAtStart) / weeksElapsed;
  return actualPerWeek >= requiredPerWeek;
}

async function aggregateBlockAdherence(
  supabase: SupabaseClient,
  userId: string,
  blockStart: string,
  today: string,
): Promise<{ planned: number; done: number; pct: number }> {
  // Fetch every committed week_start between block start and today (inclusive)
  const { data, error } = await supabase
    .from("training_weeks")
    .select("week_start")
    .eq("user_id", userId)
    .gte("week_start", blockStart)
    .lte("week_start", today);
  if (error) throw error;

  let planned = 0;
  let done = 0;
  for (const row of (data ?? []) as { week_start: string }[]) {
    const r = await computeAdherence(supabase, userId, row.week_start);
    planned += r.sessions_planned;
    done += r.sessions_on_plan;
  }
  return {
    planned,
    done,
    pct: planned === 0 ? 0 : Math.round((done / planned) * 100),
  };
}

/** Browser fetcher used by the TanStack Query hook. */
export async function fetchBlockProgressBrowser(): Promise<BlockProgressPayload> {
  const res = await fetch("/api/coach/block-progress", { method: "GET" });
  if (!res.ok) throw new Error(`block-progress: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 3: Create the hook**

Write `lib/query/hooks/useBlockProgress.ts`:

```ts
// lib/query/hooks/useBlockProgress.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchBlockProgressBrowser } from "@/lib/query/fetchers/blockProgress";

export function useBlockProgress(userId: string) {
  return useQuery({
    queryKey: queryKeys.blockProgress.active(userId),
    queryFn: fetchBlockProgressBrowser,
    staleTime: 60_000,
    refetchOnMount: false,
  });
}
```

- [ ] **Step 4: Prefetch in `/coach` page**

In `app/coach/page.tsx`, add to the prefetch block:

```ts
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";

queryClient.prefetchQuery({
  queryKey: queryKeys.blockProgress.active(user.id),
  queryFn: () => computeBlockProgress(supabase, user.id),
}),
```

- [ ] **Step 5: Typecheck & commit**

```bash
npm run typecheck
git add app/api/coach/block-progress/route.ts lib/query/fetchers/blockProgress.ts lib/query/hooks/useBlockProgress.ts app/coach/page.tsx
git commit -m "feat(coach): /api/coach/block-progress endpoint + fetcher + hook

Computes the full BlockProgressCard payload: current week of block, RIR
target, e1RM trajectory, body-comp-aware relative metrics (per-LBM,
allometric, IPF GL), adherence aggregates, on-pace boolean. Lazy-flips
expired active blocks to completed at read time. Prefetched on /coach.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: BlockProgressCard component

**Files:**
- Create: `components/coach/BlockProgressCard.tsx`
- Modify: `components/coach/CoachClient.tsx`

Renders the active block status + body-comp-aware metrics. Shows "Set up first block" CTA when no block.

- [ ] **Step 1: Create the component**

Write `components/coach/BlockProgressCard.tsx`:

```tsx
// components/coach/BlockProgressCard.tsx
"use client";

import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { useBlockProgress } from "@/lib/query/hooks/useBlockProgress";

export function BlockProgressCard({ userId }: { userId: string }) {
  const { data } = useBlockProgress(userId);

  if (!data) return null;
  if ("active" in data && data.active === false) {
    return (
      <Card>
        <SectionLabel>NEW BLOCK</SectionLabel>
        <p style={{ fontSize: "14px", color: COLOR.textMuted, lineHeight: 1.5, marginTop: "8px" }}>
          You don&apos;t have an active training block. Tap below to set one up — 5 weeks
          ending in a deload, with one strength goal.
        </p>
        <Link
          href="/coach?mode=setup_block"
          style={{
            display: "inline-block",
            marginTop: "12px",
            padding: "10px 14px",
            background: COLOR.accent,
            color: "#fff",
            borderRadius: "9999px",
            fontWeight: 700,
            fontSize: "13px",
            textDecoration: "none",
          }}
        >
          Set up your first block →
        </Link>
      </Card>
    );
  }

  const p = data; // active block payload
  const phaseLabel = p.research_phase.toUpperCase();
  const rirLabel = p.rir_target !== null ? `RIR ${p.rir_target}` : "DELOAD";

  return (
    <Card>
      <SectionLabel>ACTIVE BLOCK</SectionLabel>
      <div style={{ marginTop: "8px" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: COLOR.textStrong }}>
          {p.block.goal_text}
        </div>
        <div style={{ fontSize: "11px", color: COLOR.textMuted, marginTop: "2px" }}>
          Week {p.current_week} of {p.total_weeks} · {phaseLabel} · {rirLabel}
        </div>
      </div>

      <div style={{ height: 1, background: COLOR.divider, margin: "12px 0" }} />

      <MetricRow
        label="e1RM"
        from={p.e1rm_at_block_start}
        to={p.e1rm_now}
        unit="kg"
        deltaAbsolute
      />
      <MetricRow
        label="/LBM"
        from={p.strength_per_lbm_at_start}
        to={p.strength_per_lbm_now}
        deltaPct={p.strength_per_lbm_delta_pct}
      />
      <MetricRow
        label="/BW^.67"
        from={p.allometric_at_start}
        to={p.allometric_now}
        deltaPct={p.allometric_delta_pct}
      />
      <MetricRow
        label="IPF GL"
        from={p.ipf_gl_at_start}
        to={p.ipf_gl_now}
        deltaPct={p.ipf_gl_delta_pct}
      />

      <div style={{ height: 1, background: COLOR.divider, margin: "12px 0" }} />

      <div style={{ fontSize: "12px", color: COLOR.textMuted }}>
        Adherence: <strong style={{ color: COLOR.textStrong }}>{p.adherence_pct}%</strong>{" "}
        ({p.sessions_done}/{p.sessions_planned_to_date} sessions on plan)
        {p.on_pace !== null && (
          <span style={{ marginLeft: "10px", color: p.on_pace ? "#16a34a" : "#dc2626" }}>
            · {p.on_pace ? "On pace" : "Off pace"}
            {p.e1rm_remaining_to_goal !== null && ` · ${fmtNum(p.e1rm_remaining_to_goal)}kg from goal`}
          </span>
        )}
      </div>
    </Card>
  );
}

function MetricRow({
  label,
  from,
  to,
  unit,
  deltaPct,
  deltaAbsolute,
}: {
  label: string;
  from: number | null;
  to: number | null;
  unit?: string;
  deltaPct?: number | null;
  deltaAbsolute?: boolean;
}) {
  if (from === null || to === null) return null;

  const delta = to - from;
  const pct = deltaPct ?? (from !== 0 ? delta / from : null);
  const sign = pct === null ? "" : pct > 0 ? "+" : "";
  const color = pct === null ? COLOR.textMuted : pct > 0 ? "#16a34a" : pct < 0 ? "#dc2626" : COLOR.textMuted;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: "4px 0",
        fontSize: "12px",
        fontFamily: "var(--font-dm-mono), monospace",
      }}
    >
      <span style={{ color: COLOR.textMuted, width: "70px" }}>{label}:</span>
      <span style={{ flex: 1, color: COLOR.textStrong }}>
        {fmtNum(from)} → {fmtNum(to)}{unit ? ` ${unit}` : ""}
      </span>
      <span style={{ color, fontWeight: 600, marginLeft: "8px" }}>
        {deltaAbsolute && unit
          ? `(${sign}${fmtNum(delta)}${unit}${pct !== null ? `, ${sign}${fmtNum(pct * 100)}%` : ""})`
          : pct !== null
          ? `(${sign}${fmtNum(pct * 100)}%)`
          : ""}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Mount in `CoachClient` next-week view**

In `components/coach/CoachClient.tsx`, find the `NextWeekView` function. Add the card at the top:

```diff
+import { BlockProgressCard } from "@/components/coach/BlockProgressCard";

 function NextWeekView({ userId, targetWeek }: { userId: string; targetWeek: string }) {
   const { data } = useRecommendations(userId, targetWeek);
   const items = (data?.items ?? []) as Recommendation[];
   const weekShown = data?.weekShown ?? null;

   return (
     <>
+      <BlockProgressCard userId={userId} />
+      {/* WeekPlanCard + CTAs added in Task 16 */}
       <div>
         ...existing 'Next week' header...
       </div>
       <RecommendationsList initial={items} weekStart={weekShown} />
     </>
   );
 }
```

- [ ] **Step 3: Typecheck & manual smoke**

```bash
npm run typecheck
npm run dev
```

Visit `http://localhost:3000/coach?view=next-week`. With no active block: should show the "Set up your first block →" CTA. INSERT a block via SQL (use the same probe pattern as Task 9, on `training_blocks`) — the card should switch to the active-block view with metric rows. Each metric row should be hidden if its `from` or `to` is null. Adherence shows "0% (0/0 sessions on plan)" when no `training_weeks` rows yet.

- [ ] **Step 4: Commit**

```bash
git add components/coach/BlockProgressCard.tsx components/coach/CoachClient.tsx
git commit -m "feat(coach): BlockProgressCard with body-comp-aware metrics

Renders active-block status (week N of 5, phase, RIR target), absolute
e1RM trajectory, and relative-strength metrics (per-LBM, allometric, IPF
GL). Each metric row collapses if source data is null. Falls back to a
'Set up first block' CTA when no active block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: WeekPlanCard component + CTAs

**Files:**
- Create: `components/coach/WeekPlanCard.tsx`
- Create: `components/coach/PlanWeekCTA.tsx`
- Modify: `components/coach/CoachClient.tsx`

`<WeekPlanCard>` shows the committed plan for the current/upcoming week (read-only). `<PlanWeekCTA>` shows the "Plan week N" tap target when active block + no committed plan + (Sun OR Mon-Tue).

- [ ] **Step 1: WeekPlanCard component**

Write `components/coach/WeekPlanCard.tsx`:

```tsx
"use client";

import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import type { Weekday } from "@/lib/data/types";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekPlanCard({
  userId,
  weekStart,
}: {
  userId: string;
  weekStart: string;
}) {
  const { data: week } = useTrainingWeek(userId, weekStart);
  if (!week) return null;

  return (
    <Card>
      <SectionLabel>NEXT WEEK · planned</SectionLabel>
      <div style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "2px" }}>
        Week of {weekStart}
      </div>

      <div style={{ marginTop: "10px" }}>
        {ORDER.map((d) => {
          const t = week.session_plan[d] ?? "—";
          const isRest = t.toLowerCase().includes("rest") || t === "—";
          return (
            <div
              key={d}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "5px 0",
                borderBottom: `1px solid ${COLOR.divider}`,
                fontSize: "12px",
              }}
            >
              <span style={{ width: "44px", color: COLOR.textMuted, fontWeight: 600 }}>{d}</span>
              <span
                style={{
                  flex: 1,
                  color: isRest ? COLOR.textFaint : COLOR.textStrong,
                  fontStyle: isRest ? "italic" : "normal",
                }}
              >
                {t}
              </span>
              {week.rir_target !== null && !isRest && (
                <span style={{ color: COLOR.textMuted, fontFamily: "var(--font-dm-mono), monospace" }}>
                  RIR {week.rir_target}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {week.weekly_focus && (
        <p style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "12px", lineHeight: 1.5 }}>
          <strong style={{ color: COLOR.textStrong }}>Focus:</strong> {week.weekly_focus}
        </p>
      )}

      <Link
        href="/coach?mode=plan_week"
        style={{
          display: "inline-block",
          marginTop: "10px",
          fontSize: "11px",
          color: COLOR.accent,
          textDecoration: "none",
        }}
      >
        Re-open planning chat →
      </Link>
    </Card>
  );
}
```

- [ ] **Step 2: PlanWeekCTA component**

Write `components/coach/PlanWeekCTA.tsx`:

```tsx
"use client";

import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

export function PlanWeekCTA({
  weekStart,
  weekN,
  isLate,
}: {
  weekStart: string;
  weekN: number | null;
  isLate?: boolean;
}) {
  const headline = weekN
    ? `Plan week ${weekN} of your block`
    : `Plan the week of ${weekStart}`;
  const sub = isLate
    ? "Late but still useful — committing now respects what you've already done."
    : "5-min conversation. Coach reviews last week, asks how you feel, proposes the schedule.";

  return (
    <Card>
      <SectionLabel>{isLate ? "MID-WEEK PLANNING" : "PLAN NEXT WEEK"}</SectionLabel>
      <div style={{ fontSize: "16px", fontWeight: 700, color: COLOR.textStrong, marginTop: "6px" }}>
        {headline}
      </div>
      <p style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "6px", lineHeight: 1.5 }}>
        {sub}
      </p>
      <Link
        href="/coach?mode=plan_week"
        style={{
          display: "inline-block",
          marginTop: "10px",
          padding: "10px 14px",
          background: COLOR.accent,
          color: "#fff",
          borderRadius: "9999px",
          fontWeight: 700,
          fontSize: "13px",
          textDecoration: "none",
        }}
      >
        {isLate ? "Plan this week →" : "Open planning chat →"}
      </Link>
    </Card>
  );
}
```

- [ ] **Step 3: Wire decision logic into CoachClient**

In `components/coach/CoachClient.tsx`, replace the `NextWeekView` body with the full state-machine:

```tsx
import { BlockProgressCard } from "@/components/coach/BlockProgressCard";
import { WeekPlanCard } from "@/components/coach/WeekPlanCard";
import { PlanWeekCTA } from "@/components/coach/PlanWeekCTA";
import { useBlockProgress } from "@/lib/query/hooks/useBlockProgress";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { planningTargetMonday } from "@/lib/coach/week";
import { weekdayInUserTz } from "@/lib/time";

function NextWeekView({ userId, targetWeek }: { userId: string; targetWeek: string }) {
  const { data: blockProgress } = useBlockProgress(userId);
  const { data: existing } = useTrainingWeek(userId, planningTargetMonday(new Date()));

  const hasActiveBlock = blockProgress && !("active" in blockProgress);
  const planExists = existing !== null && existing !== undefined;
  const today = weekdayInUserTz(); // "Monday" .. "Sunday"

  // Decision table per spec section "Mode triggering"
  const showSetupCTA = !hasActiveBlock;
  const showPlanCTA = hasActiveBlock && !planExists && (
    today === "Sunday" || today === "Monday" || today === "Tuesday"
  );
  const showWeekCard = hasActiveBlock && planExists;

  // Derived weekN for CTA — known only when block is active
  const weekN = hasActiveBlock && blockProgress && !("active" in blockProgress)
    ? blockProgress.current_week + (today === "Sunday" ? 1 : 0)
    : null;
  const isLatePlanning = today === "Monday" || today === "Tuesday";

  return (
    <>
      <BlockProgressCard userId={userId} />
      {!showSetupCTA && showPlanCTA && (
        <PlanWeekCTA
          weekStart={planningTargetMonday(new Date())}
          weekN={weekN}
          isLate={isLatePlanning}
        />
      )}
      {showWeekCard && (
        <WeekPlanCard userId={userId} weekStart={planningTargetMonday(new Date())} />
      )}

      {/* Existing recommendations stay below */}
      <div style={{ marginTop: "12px" }}>
        <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.12em", color: COLOR.textFaint }}>
          🎯 Recommendations
        </div>
        <div style={{ fontSize: "10px", color: COLOR.textFaint, marginTop: "2px" }}>
          Coach-seeded action items. Check them off as you go.
        </div>
      </div>
      {/* … existing RecommendationsList code … */}
    </>
  );
}
```

(Leave the existing `useRecommendations` + `<RecommendationsList>` rendering in place; it stays below the new cards.)

- [ ] **Step 4: Prefetch the planning-target training_week on /coach**

In `app/coach/page.tsx`:

```ts
import { fetchTrainingWeekServer } from "@/lib/query/fetchers/trainingWeek";
import { planningTargetMonday } from "@/lib/coach/week";

const targetMonday = planningTargetMonday();
queryClient.prefetchQuery({
  queryKey: queryKeys.trainingWeeks.one(user.id, targetMonday),
  queryFn: () => fetchTrainingWeekServer(supabase, user.id, targetMonday),
}),
```

- [ ] **Step 5: Typecheck & smoke**

```bash
npm run typecheck
npm run dev
```

Visit `/coach?view=next-week`. Cycle through all states:
- No active block → SetupBlock CTA shown (via BlockProgressCard fallback)
- Active block + no plan + Sunday → PlanWeekCTA shown
- Active block + no plan + Mon/Tue → PlanWeekCTA with "MID-WEEK PLANNING" subtitle
- Active block + no plan + Wed-Sat → no CTA shown (week mostly over)
- Active block + plan committed → WeekPlanCard shown with the schedule

Use SQL to INSERT/DELETE rows on `training_blocks` and `training_weeks` to drive each state.

- [ ] **Step 6: Commit**

```bash
git add components/coach/WeekPlanCard.tsx components/coach/PlanWeekCTA.tsx components/coach/CoachClient.tsx app/coach/page.tsx
git commit -m "feat(coach): WeekPlanCard + PlanWeekCTA + CoachClient decision logic

Wires the spec's decision table for the next-week view: no block →
setup CTA; active block + no plan + Sun/Mon-Tue → plan CTA; active block
+ plan → read-only WeekPlanCard. Existing RecommendationsList stays
below the new cards.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Chat preview cards + ChatPanel mode wiring

**Files:**
- Create: `components/chat/WeekPlanProposalCard.tsx`
- Create: `components/chat/BlockProposalCard.tsx`
- Create: `components/chat/ModeBanner.tsx`
- Modify: `components/chat/ChatMessage.tsx` — render preview cards when tool_calls includes propose_*
- Modify: `components/chat/ChatPanel.tsx` — accept mode, render banner, mode-aware composer
- Modify: `components/layout/FabGate.tsx` — listen for `open-chat` event, pass mode through
- Modify: `app/coach/page.tsx` — read `?mode=...` and dispatch `open-chat` event on mount

This is the final piece tying chat to the planning UI. After this, the full Sunday loop works.

- [ ] **Step 1: WeekPlanProposalCard**

Write `components/chat/WeekPlanProposalCard.tsx`:

```tsx
"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import type { Weekday } from "@/lib/data/types";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type WeekProposal = {
  week_start: string;
  session_plan: Record<string, string>;
  weekly_focus?: string;
  intensity_modifier?: Record<string, number>;
  rir_target?: number;
  research_phase?: "accumulate" | "deload";
  rationale?: string;
};

export function WeekPlanProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: WeekProposal;
  approvalToken: string;
  onApprove: (token: string) => void;
  onTweak: () => void;
  committed?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (committed) {
    return (
      <div style={previewStyle}>
        <div style={{ color: "#16a34a", fontWeight: 700, fontSize: "13px" }}>
          ✓ Plan committed for {proposal.week_start}
        </div>
      </div>
    );
  }

  return (
    <div style={previewStyle}>
      <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 700, letterSpacing: "0.06em" }}>
        PROPOSED PLAN · {proposal.week_start}
      </div>
      <div style={{ marginTop: "8px" }}>
        {ORDER.map((d) => {
          const t = proposal.session_plan[d] ?? "—";
          const isRest = t.toLowerCase().includes("rest") || t === "—";
          return (
            <div
              key={d}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "3px 0",
                fontSize: "12px",
                color: isRest ? COLOR.textFaint : COLOR.textStrong,
                fontStyle: isRest ? "italic" : "normal",
              }}
            >
              <span style={{ width: "44px", fontWeight: 600 }}>{d}</span>
              <span style={{ flex: 1 }}>{t}</span>
              {proposal.rir_target !== undefined && !isRest && (
                <span style={{ color: COLOR.textMuted }}>RIR {proposal.rir_target}</span>
              )}
            </div>
          );
        })}
      </div>

      {proposal.weekly_focus && (
        <p style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "10px", lineHeight: 1.4 }}>
          <strong style={{ color: COLOR.textStrong }}>Focus:</strong> {proposal.weekly_focus}
        </p>
      )}
      {proposal.rationale && (
        <p style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "4px", lineHeight: 1.4, fontStyle: "italic" }}>
          Why: {proposal.rationale}
        </p>
      )}

      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
        <button
          disabled={busy}
          onClick={() => { setBusy(true); onApprove(approvalToken); }}
          style={btnPrimary}
        >
          Approve
        </button>
        <button onClick={onTweak} style={btnSecondary}>
          Tweak in chat
        </button>
      </div>
    </div>
  );
}

const previewStyle: React.CSSProperties = {
  background: COLOR.surfaceAlt,
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "12px",
  padding: "12px 14px",
  marginTop: "8px",
};
const btnPrimary: React.CSSProperties = {
  flex: 1, padding: "8px 12px", border: "none",
  borderRadius: "9999px", background: COLOR.accent,
  color: "#fff", fontWeight: 700, fontSize: "12px", cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  flex: 1, padding: "8px 12px", border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px", background: COLOR.surface,
  color: COLOR.textStrong, fontWeight: 600, fontSize: "12px", cursor: "pointer",
};
```

- [ ] **Step 2: BlockProposalCard**

Write `components/chat/BlockProposalCard.tsx` mirroring the same shape:

```tsx
"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";

export type BlockProposal = {
  goal_text: string;
  primary_lift?: string;
  target_metric?: string;
  target_value?: number;
  target_unit?: string;
  start_date: string;
  end_date: string;
};

export function BlockProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: BlockProposal;
  approvalToken: string;
  onApprove: (token: string) => void;
  onTweak: () => void;
  committed?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (committed) {
    return (
      <div style={previewStyle}>
        <div style={{ color: "#16a34a", fontWeight: 700, fontSize: "13px" }}>
          ✓ Block created. Come back Sunday to plan week 1.
        </div>
      </div>
    );
  }

  return (
    <div style={previewStyle}>
      <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 700, letterSpacing: "0.06em" }}>
        PROPOSED BLOCK · 5 weeks
      </div>
      <div style={{ marginTop: "8px", fontSize: "14px", fontWeight: 700, color: COLOR.textStrong }}>
        {proposal.goal_text}
      </div>
      <div style={{ marginTop: "6px", fontSize: "12px", color: COLOR.textMuted, lineHeight: 1.5 }}>
        {proposal.start_date} → {proposal.end_date}
        {proposal.primary_lift && ` · primary: ${proposal.primary_lift}`}
        {proposal.target_metric && proposal.target_value && (
          ` · target: ${proposal.target_value}${proposal.target_unit ?? "kg"} ${proposal.target_metric}`
        )}
      </div>

      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
        <button
          disabled={busy}
          onClick={() => { setBusy(true); onApprove(approvalToken); }}
          style={btnPrimary}
        >
          Approve
        </button>
        <button onClick={onTweak} style={btnSecondary}>
          Tweak in chat
        </button>
      </div>
    </div>
  );
}

const previewStyle: React.CSSProperties = {
  background: COLOR.surfaceAlt,
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "12px",
  padding: "12px 14px",
  marginTop: "8px",
};
const btnPrimary: React.CSSProperties = {
  flex: 1, padding: "8px 12px", border: "none",
  borderRadius: "9999px", background: COLOR.accent,
  color: "#fff", fontWeight: 700, fontSize: "12px", cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  flex: 1, padding: "8px 12px", border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px", background: COLOR.surface,
  color: COLOR.textStrong, fontWeight: 600, fontSize: "12px", cursor: "pointer",
};
```

- [ ] **Step 3: ModeBanner**

Write `components/chat/ModeBanner.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import type { ChatMode } from "@/lib/data/types";

export function ModeBanner({
  mode,
  context,
  onExit,
}: {
  mode: ChatMode;
  context?: string;
  onExit: () => void;
}) {
  if (mode === "default") return null;
  const label = mode === "plan_week" ? "Planning" : "Block setup";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 12px",
        background: COLOR.accent,
        color: "#fff",
        fontSize: "12px",
        fontWeight: 600,
      }}
    >
      <span>📅 {label}{context ? ` · ${context}` : ""}</span>
      <button
        onClick={onExit}
        style={{
          background: "transparent",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "16px",
          fontWeight: 700,
        }}
        aria-label="Exit planning"
      >
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Render preview cards in `ChatMessage`**

Open `components/chat/ChatMessage.tsx`. Find where the assistant message body is rendered. After the rendered text/markdown, check `tool_calls` for `propose_*` invocations and render the appropriate card:

```tsx
import { WeekPlanProposalCard } from "@/components/chat/WeekPlanProposalCard";
import { BlockProposalCard } from "@/components/chat/BlockProposalCard";

// inside the assistant-bubble JSX, after the text:
{message.tool_calls?.map((call, i) => {
  if (call.name === "propose_week_plan" && call.result?.preview && call.result?.approval_token) {
    return (
      <WeekPlanProposalCard
        key={i}
        proposal={call.result.preview}
        approvalToken={call.result.approval_token}
        committed={message.tool_calls?.some((c) => c.name === "commit_week_plan" && c.success)}
        onApprove={(token) => onSendUserMessage?.(`[approve:${token}]`)}
        onTweak={() => onFocusComposer?.("e.g., 'make Friday Arms instead'")}
      />
    );
  }
  if (call.name === "propose_block" && call.result?.preview && call.result?.approval_token) {
    return (
      <BlockProposalCard
        key={i}
        proposal={call.result.preview}
        approvalToken={call.result.approval_token}
        committed={message.tool_calls?.some((c) => c.name === "commit_block" && c.success)}
        onApprove={(token) => onSendUserMessage?.(`[approve:${token}]`)}
        onTweak={() => onFocusComposer?.("e.g., 'change the goal to bench instead'")}
      />
    );
  }
  return null;
})}
```

`onSendUserMessage` and `onFocusComposer` are existing-or-new callback props on `ChatMessage` — pass them through from `ChatPanel`. The `[approve:<token>]` text is a sentinel the user-message renderer hides (small CSS override in `ChatMessage` to hide bodies starting with `[approve:`) so it doesn't visually clutter the thread.

- [ ] **Step 5: ChatPanel mode plumbing**

Open `components/chat/ChatPanel.tsx`. Add `mode` prop and the ModeBanner:

```diff
+import { ModeBanner } from "@/components/chat/ModeBanner";
+import type { ChatMode } from "@/lib/data/types";

-export default function ChatPanel({ onClose }: { onClose: () => void }) {
+export default function ChatPanel({
+  onClose,
+  initialMode = "default",
+  initialModeContext,
+}: {
+  onClose: () => void;
+  initialMode?: ChatMode;
+  initialModeContext?: string;
+}) {
+  const [mode, setMode] = useState<ChatMode>(initialMode);
   ...
   return (
     <div style={...}>
+      <ModeBanner
+        mode={mode}
+        context={initialModeContext}
+        onExit={() => {
+          setMode("default");
+        }}
+      />
       <ChatThread ... />
       <ChatComposer
         disabled={...}
-        onSend={send}
+        onSend={(text) => send(text, { mode })}
         placeholder={
           mode === "plan_week" ? "Tell the coach how you're feeling…"
           : mode === "setup_block" ? "What do you want to focus on this block?"
           : undefined
         }
       />
```

The `send` function needs to take a `mode` and pass it to the POST body. Update the existing send-message function accordingly.

After a successful `commit_*` tool call, reset `mode` to `"default"` (the route already stamps the next turn correctly via inheritance, but the banner should disappear). Wire this via the existing tool-call handling — when an assistant turn comes in with `tool_calls.some(c => c.name === "commit_block" || c.name === "commit_week_plan")`, call `setMode("default")`.

- [ ] **Step 6: Hook /coach to open chat in mode**

In `app/coach/page.tsx` (Server Component), this is tricky because mode is in URL params and the chat panel is client. We need a client wrapper. Add to `CoachClient`:

```tsx
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

// Inside CoachClient body, near the top:
const search = useSearchParams();
useEffect(() => {
  const m = search.get("mode");
  if (m === "plan_week" || m === "setup_block") {
    window.dispatchEvent(new CustomEvent("open-chat", { detail: { mode: m } }));
    // Strip the param so the dispatch doesn't fire on every re-render
    const url = new URL(window.location.href);
    url.searchParams.delete("mode");
    window.history.replaceState({}, "", url.toString());
  }
}, [search]);
```

In `components/layout/FabGate.tsx`, listen for the event:

```tsx
useEffect(() => {
  function onOpenChat(e: Event) {
    const detail = (e as CustomEvent).detail as { mode?: ChatMode } | undefined;
    setChatOpen(true);
    setInitialMode(detail?.mode ?? "default");
  }
  window.addEventListener("open-chat", onOpenChat);
  return () => window.removeEventListener("open-chat", onOpenChat);
}, []);
```

Pass `initialMode` to `<ChatPanel>`.

- [ ] **Step 7: Hide `[approve:...]` user messages in the thread**

Tiny CSS in `ChatMessage`:

```tsx
if (message.role === "user" && message.content.startsWith("[approve:")) {
  return null; // approve sentinels don't render in the visible thread
}
```

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add components/chat/WeekPlanProposalCard.tsx components/chat/BlockProposalCard.tsx components/chat/ModeBanner.tsx components/chat/ChatMessage.tsx components/chat/ChatPanel.tsx components/layout/FabGate.tsx components/coach/CoachClient.tsx
git commit -m "feat(chat): inline proposal cards + mode banner + URL-driven chat opening

WeekPlanProposalCard / BlockProposalCard render inside assistant bubbles
when tool_calls includes propose_*. Approve sends a hidden
[approve:<token>] user message that the route routes to commit_*.
Tweak focuses the composer with a hint placeholder.

ModeBanner sits above ChatThread when mode != 'default', with an exit
button. /coach reads ?mode=plan_week|setup_block, dispatches
'open-chat' to FabGate which mounts ChatPanel with the right mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: End-to-end smoke + CLAUDE.md polish

**Files:**
- Modify: `CLAUDE.md`

Final task: real end-to-end run through the whole user flow, then doc updates.

- [ ] **Step 1: Clean state**

```bash
cd "/Users/abdelouahedelbied/Health app"
node -e "
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
for (const l of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const sr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sr.auth.admin.listUsers().then(async (r) => {
  const userId = r.data.users[0].id;
  await sr.from('training_weeks').delete().eq('user_id', userId);
  await sr.from('training_blocks').delete().eq('user_id', userId);
  console.log('cleaned');
});
"
```

- [ ] **Step 2: Run dev server and walk the full flow**

```bash
npm run dev
```

Open `http://localhost:3000/coach?view=next-week`. You should see:
- BlockProgressCard showing "Set up your first block →" CTA
- No PlanWeekCTA, no WeekPlanCard

Tap the CTA. Chat panel opens with ModeBanner reading "📅 Block setup". Coach starts the EXPLAIN beat. Walk through:
1. Coach explains 5w structure
2. You say "primary lift deadlift, target e1RM 110, goal: build base for spring meet"
3. Coach calls `propose_block`, BlockProposalCard renders
4. Tap Approve. Coach calls `commit_block`. Card switches to "✓ Block created"
5. ModeBanner disappears

Reload `/coach?view=next-week`. Now:
- BlockProgressCard shows the active block (week 1 of 5, accumulate, RIR 4)
- No e1RM trajectory yet (no workouts since block start, just baseline)
- PlanWeekCTA visible (since today is most likely not a Sunday and no plan exists; if today is Wed-Sat the spec says no CTA — verify the decision logic matches today's weekday)

If today is Sun or Mon-Tue, tap "Plan this week →". Walk through plan_week:
1. Coach RECAPs (with no workouts yet, the recap is short — "first week of block")
2. CHECK-IN
3. Coach calls `propose_week_plan` with RIR 4, accumulate, intensity {deadlift: 0.85}
4. WeekPlanProposalCard renders
5. Tap Approve. Coach commits. Card becomes "✓ Plan committed for ..."

Reload `/strength`. The Today tab should now read from the committed plan. Pill shows `ACCUMULATE · RIR 4`. Friday should show whatever you committed (not Legs, the static fallback).

- [ ] **Step 3: Test the deload-alert path**

To force the path: temporarily INSERT some short-sleep daily_logs to trigger the sleep signal, AND lower an HRV value, then re-open `?mode=plan_week`. The system prompt should now include the autoregulation alert section. Coach should mention deload in the conversation and surface a deload-style proposal (RIR null, research_phase='deload', volume cut).

After test: revert the daily_logs changes.

- [ ] **Step 4: Update CLAUDE.md**

Find the "Coach / AI" section. Add to the bullet list:

```diff
 - [lib/anthropic/client.ts](lib/anthropic/client.ts) — server-side Anthropic SDK. The key is `ANTHROPIC_API_KEY` (never `NEXT_PUBLIC_*`); the prototype exposed it to the browser, the port intentionally moves it server-side.
 - [lib/coach/](lib/coach/) — `readiness.ts` (daily plan), `impact.ts` (per-metric +/− contributions to readiness), `week.ts`, `sessionPlans.ts`, `prompts.ts`. Pure functions; UI consumes the outputs.
+- **Weekly planning v1**: `training_blocks` (5-week mesocycles) + `training_weeks` (committed Sunday plans) drive the strength tab via [lib/coach/planning-prompts.ts](lib/coach/planning-prompts.ts) and the chat `mode` discriminator (`default|plan_week|setup_block`). Conversation produces structured plans via propose_*/commit_* tools gated by HMAC approval tokens (`COACH_TOOL_SECRET` env). Body-comp-aware progress metrics (strength-per-LBM, allometric, IPF GL) computed on demand in [lib/coach/progress-metrics.ts](lib/coach/progress-metrics.ts) — no `progress_metrics` table in v1.
```

Also under the Environment section, add:

```diff
 Copy [.env.example](.env.example) → `.env.local`. Required for any backend work: Supabase URL + anon key + service role; for OAuth: WHOOP/Withings client id/secret/redirect; for coach: `ANTHROPIC_API_KEY`; for cron: `CRON_SECRET`; `NEXT_PUBLIC_APP_URL` controls callback URLs.
+
+Coach planning tools require `COACH_TOOL_SECRET` (32+ char random; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). The same value must be set in Vercel env (Production + Preview).
```

- [ ] **Step 5: Final typecheck and commit**

```bash
npm run typecheck
git add CLAUDE.md
git commit -m "docs(claude-md): document weekly planning v1 architecture

Block + week tables, planning_prompts mode assembly, propose/commit tool
gate, body-comp-aware progress metrics, COACH_TOOL_SECRET env. Updates
the Coach/AI and Environment sections.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Push the branch and prepare PR**

```bash
git push -u origin feat/weekly-coach-planning
gh pr create --title "feat: weekly coach planning v1 (kills WEEKLY_SESSIONS Friday=Legs bug)" --body "$(cat <<'EOF'
Implements [the v1 spec](docs/superpowers/specs/2026-05-08-weekly-coach-planning-design.md) for the Sunday weekly-planning ritual.

## What changed

- New schema: `training_blocks` (5-week mesocycles) + `training_weeks` (committed Sunday plans) + `chat_messages.mode` discriminator
- New chat modes: `plan_week` (Sunday recap + propose) and `setup_block` (block creation), both via existing ChatPanel surface with a ModeBanner
- 8 new coach tools (read: blocks/weeks/autoregulation/adherence; write: propose/commit pairs gated by HMAC tokens)
- `<BlockProgressCard>` shows block status + body-comp-aware metrics (strength-per-LBM, allometric, IPF GL) — only when source data exists
- `<TodayPlanCard>` reads from `training_weeks` first; static `WEEKLY_SESSIONS` becomes pure fallback. Friday=Legs bug killed.

## What's deferred to v2

Body-comp-driven block goals, time-series metric charts, cut velocity warnings, diet prescription, mid-week swap UI, real 1RM testing, push notifications, RPE auto-fill — all called out in the spec's Open Questions section.

## Verification

Manual end-to-end smoke test in Task 18 step 2: set up first block, plan week 1, verify strength tab respects the committed plan, force the deload-alert path. No automated tests (codebase has no test runner).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

Before finishing, walk the spec section by section:

- [ ] **Goals 1-8** — every goal in the spec has at least one task implementing it
- [ ] **Schema** — Task 1 covers all three changes (training_blocks, training_weeks, chat_messages.mode)
- [ ] **Conversation flow** — Tasks 12, 13, 17 cover mode resolution, system prompts, UI banner
- [ ] **Coach tools** — Tasks 10, 11 cover all 8 new tools
- [ ] **UI surface** — Tasks 9 (strength tab), 15 (BlockProgressCard), 16 (WeekPlanCard + CTAs), 17 (chat preview cards)
- [ ] **Adherence + block progress** — Tasks 6 (adherence), 14 (block progress endpoint)
- [ ] **Body-comp metrics** — Task 4 (formulas), Task 14 (computation in endpoint), Task 15 (rendering)
- [ ] **Approval token gate** — Task 3 (utility), Task 11 (use in commit tools)
- [ ] **CLAUDE.md** — Tasks 1 and 18 update it

If any unchecked item exists, the missing task gets added before declaring the plan complete.
