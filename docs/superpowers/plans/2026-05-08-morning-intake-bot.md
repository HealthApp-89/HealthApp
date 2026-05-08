# Morning Intake Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual morning-feel form on `/log` with a chat-driven intake that pops on first app-open, scripts slot-fill questions, and delivers a coach recommendation once WHOOP data lands — all inside the existing ChatPanel surface.

**Architecture:** Per-day server-side state machine on `checkins.intake_state` (`pending → awaiting_feel → awaiting_sickness_notes → awaiting_whoop → delivered`). Client never decides "next question" — it POSTs the user's answer and the server transitions state and streams the next assistant turn. Sickness short-circuits to REST without WHOOP. Existing ChatPanel gains `mode: 'coach' | 'morning_intake'` and a `ui.chips` rendering path; existing free-form chat is untouched (default `kind='coach'` on `chat_messages`).

**Tech Stack:** Next.js 15 App Router, Supabase (RLS-respecting server client + service-role for state-machine writes), Anthropic SDK with tool-use for the LLM tail and recommendation rendering, TanStack Query for client cache invalidation, SSE for streaming.

**Spec:** [docs/superpowers/specs/2026-05-08-morning-intake-bot-design.md](../specs/2026-05-08-morning-intake-bot-design.md)

**Verification posture:** This codebase has no test runner (`npm run lint` is unconfigured per CLAUDE.md). Each task ends with `npm run typecheck` plus targeted manual checks. The pure functions in `lib/morning/` would benefit from tests later but ship without one for now — they are deliberately small and side-effect-free so a unit test can be added trivially when test infra arrives.

---

## File Structure

**New files (10):**
- `supabase/migrations/0007_morning_intake.sql` — schema additions
- `lib/morning/script.ts` — pure data: question definitions
- `lib/morning/state.ts` — pure functions: state-machine decisions
- `lib/morning/tools.ts` — Anthropic tool def for the LLM tail's `update_intake_slots`
- `app/api/chat/morning/intake/route.ts` — slot-fill state-machine endpoint
- `app/api/chat/morning/recommendation/route.ts` — coach plan generator
- `components/morning/MorningTrigger.tsx` — invisible auto-open trigger
- `components/chat/ChatChips.tsx` — chip-rendering subcomponent (extracted from ChatPanel for clarity)

**Modified files (10):**
- `lib/data/types.ts` — promote/extend `Checkin`, extend `ChatMessageRow`
- `lib/chat/types.ts` — extend `ChatMessage` with `kind` and `ui`
- `lib/query/fetchers/checkin.ts` — add new columns to SELECT, re-export from types
- `lib/coach/readiness.ts` — extend `FeelInput`, rewrite `getIntensityMode`, add energy nudge
- `components/log/LogForm.tsx` — editable fields for new structured slots
- `app/log/actions.ts` — write new fields, set `intake_state='delivered'` when full
- `app/api/chat/messages/route.ts` — accept `kind` query param on history GET
- `components/chat/ChatPanel.tsx` — `mode` prop, kind-filtered history, chip rendering, mode tabs, sickness link
- `components/layout/TopNav.tsx` — `chatState` shape, mount `MorningTrigger`
- `components/layout/Fab.tsx` — `chatState` shape (mobile FAB stays on `'coach'` mode)
- `components/dashboard/TodayClient.tsx` — pass new feel fields into `buildDailyPlan`
- `components/strength/StrengthClient.tsx` — pass new feel fields into `buildDailyPlan`
- `CLAUDE.md` — add migration 0007 to the list

---

### Task 1: DB migration — `0007_morning_intake.sql`

**Files:**
- Create: `supabase/migrations/0007_morning_intake.sql`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the migration file**

Write `supabase/migrations/0007_morning_intake.sql`:

```sql
-- 0007_morning_intake.sql — morning intake bot
--
-- Adds structured slots (sick, fatigue, soreness areas/severity, bloating,
-- sickness_notes), the per-day state-machine column intake_state, plus
-- chat_messages.kind discriminator and ui jsonb for chip-rendering turns.

-- ── checkins: structured slots + state machine ────────────────────────────────
alter table public.checkins
  add column if not exists sick              boolean not null default false,
  add column if not exists sickness_notes    text,
  add column if not exists fatigue           text,            -- 'none' | 'some' | 'heavy'
  add column if not exists bloating          boolean,         -- nullable: not asked = null
  add column if not exists soreness_areas    text[],          -- ['chest','back','legs','shoulders','arms','core']
  add column if not exists soreness_severity text,            -- 'mild' | 'sharp'
  add column if not exists intake_state      text not null default 'pending';

-- Drop and re-add the check constraint so re-applies are idempotent (the
-- constraint name is auto-generated; we name it explicitly here so the
-- migration is replay-safe).
alter table public.checkins
  drop constraint if exists checkins_intake_state_check;

alter table public.checkins
  add constraint checkins_intake_state_check
  check (intake_state in (
    'pending',
    'awaiting_feel',
    'awaiting_sickness_notes',  -- transient: between declare_sick chip tap and the user's text reply
    'awaiting_whoop',
    'delivered'
  ));

-- ── chat_messages: discriminator + chip jsonb ─────────────────────────────────
alter table public.chat_messages
  add column if not exists kind text not null default 'coach',
  add column if not exists ui   jsonb;

alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table public.chat_messages
  add constraint chat_messages_kind_check
  check (kind in ('coach', 'morning_intake'));

-- Index for kind-filtered history queries (per-user, ordered by time desc).
create index if not exists chat_messages_user_kind_created_idx
  on public.chat_messages (user_id, kind, created_at desc);
```

- [ ] **Step 2: Apply the migration**

Per CLAUDE.md, the Supabase CLI is linked. Run:

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db push
```

Expected: a single migration applies. If `supabase db push` complains about migration history mismatch, run `supabase migration repair --status applied <hash>` for the past migrations and retry. If it asks to confirm a destructive change, say no — the migration is purely additive.

- [ ] **Step 3: Add migration 0007 to CLAUDE.md**

In `CLAUDE.md`, find the "Database migrations" section (around line 33). Add the new entry after migration 6:

```diff
 5. [supabase/migrations/0005_chat.sql](supabase/migrations/0005_chat.sql) — also requires the `chat-images` private Storage bucket created beforehand (Storage RLS policies attach to it)
 6. [supabase/migrations/0006_chat_settings.sql](supabase/migrations/0006_chat_settings.sql) — adds `profiles.system_prompt` (user-editable coach prompt; NULL = use code default) and `chat_messages.tool_calls` (jsonb of tool invocations per assistant turn for observability)
+7. [supabase/migrations/0007_morning_intake.sql](supabase/migrations/0007_morning_intake.sql) — adds structured morning-feel slots (`sick`, `sickness_notes`, `fatigue`, `bloating`, `soreness_areas`, `soreness_severity`), per-day state machine on `checkins.intake_state`, and `chat_messages.kind` + `ui` for the morning intake bot
```

- [ ] **Step 4: Verify the schema**

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db diff
```

Expected: no diff (migration applied cleanly).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_morning_intake.sql CLAUDE.md
git commit -m "feat(db): morning intake schema (0007)

Adds structured feel slots + state-machine column to checkins, plus
chat_messages.kind discriminator and ui jsonb for chip-rendering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Type updates — `Checkin`, `ChatMessage`, fetcher

**Files:**
- Modify: `lib/data/types.ts` — promote `Checkin`, extend `ChatMessageRow`
- Modify: `lib/chat/types.ts` — extend `ChatMessage`
- Modify: `lib/query/fetchers/checkin.ts` — extend `COLS`, re-export from types

The current `Checkin` row shape lives inline in [lib/query/fetchers/checkin.ts](lib/query/fetchers/checkin.ts:8). Promote it to `lib/data/types.ts` so server endpoints (e.g. the new intake route) can import a single canonical type. Same convention as `DailyLog`, `Profile`, `ChatMessageRow`.

- [ ] **Step 1: Add `CheckinRow`, `IntakeState`, `Fatigue`, `SorenessSeverity`, `MorningChip`, `MorningUI` to `lib/data/types.ts`**

Append below `ChatMessageRow`:

```ts
// ── checkins ─────────────────────────────────────────────────────────────────

export type IntakeState =
  | "pending"
  | "awaiting_feel"
  | "awaiting_sickness_notes"
  | "awaiting_whoop"
  | "delivered";

export type Fatigue = "none" | "some" | "heavy";
export type SorenessSeverity = "mild" | "sharp";

export type CheckinRow = {
  user_id: string;
  date: string; // YYYY-MM-DD
  readiness: number | null;        // 1-10 (subjective body feel)
  energy: number | null;           // legacy int, unused — kept for back-compat
  energy_label: string | null;     // 'low' | 'medium' | 'high'
  mood: string | null;             // emoji
  soreness: string | null;         // legacy free-text — preserved, but readiness math reads soreness_areas
  feel_notes: string | null;
  notes: string | null;
  // 0007 additions
  sick: boolean;
  sickness_notes: string | null;
  fatigue: Fatigue | null;
  bloating: boolean | null;        // nullable: not asked = null
  soreness_areas: string[] | null; // ['chest','back','legs','shoulders','arms','core']
  soreness_severity: SorenessSeverity | null;
  intake_state: IntakeState;
  created_at: string;
};

// ── chat_messages.ui (chip rendering) ────────────────────────────────────────

export type MorningChip =
  // Slot answer — POST {slot, value} to /api/chat/morning/intake
  | { label: string; value: string | number; slot: string }
  // Action chip — client dispatches a side-effect (whoop_sync, skip_whoop, retry_recommendation)
  | { label: string; action: "whoop_sync" | "skip_whoop" | "retry_recommendation" };

export type MorningUI = {
  chips?: MorningChip[];
  /** When true, chips form a multi-select; client renders an "Apply" button that
   *  submits the array. Used for soreness-area picker. */
  multi_select?: boolean;
  /** When true, the composer text input remains visible (e.g. for the LLM tail
   *  step). Default: false (composer hidden when chips are present). */
  allow_text?: boolean;
};
```

Then extend `ChatMessageRow`:

```diff
 export type ChatMessageRow = {
   id: string;
   user_id: string;
   role: "user" | "assistant";
   content: string;
   status: "streaming" | "done" | "error";
   error: string | null;
   model: string | null;
   /** [{name, input, ms, result_rows, range_days, truncated, error}] */
   tool_calls: ToolCallLog[] | null;
+  /** Default 'coach' for the existing free-form chat thread; 'morning_intake'
+   *  segregates the daily check-in conversation in ChatPanel. */
+  kind: "coach" | "morning_intake";
+  /** Chip definitions / rendering hints for the morning intake bot. NULL on
+   *  free-form coach turns. */
+  ui: MorningUI | null;
   created_at: string;
   updated_at: string;
 };
```

- [ ] **Step 2: Extend `ChatMessage` in `lib/chat/types.ts`**

Edit `lib/chat/types.ts`:

```diff
+import type { MorningUI } from "@/lib/data/types";
+
 export type ChatMessage = {
   id: string;
   role: ChatRole;
   content: string;
   status: ChatStatus;
   error: string | null;
   model: string | null;
   created_at: string;
   updated_at: string;
   images: ChatMessageImage[];
+  /** Default 'coach'. ChatPanel filters its render by this. */
+  kind: "coach" | "morning_intake";
+  /** Chips / rendering hints for morning_intake turns. */
+  ui: MorningUI | null;
 };
```

- [ ] **Step 3: Update `lib/query/fetchers/checkin.ts` to use the canonical type and SELECT new columns**

Replace the file body:

```ts
// lib/query/fetchers/checkin.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { CheckinRow } from "@/lib/data/types";

const COLS =
  "readiness, energy_label, mood, soreness, feel_notes, " +
  "sick, sickness_notes, fatigue, bloating, soreness_areas, soreness_severity, intake_state";

/** Narrow shape returned by the dashboard / log fetchers — only the columns
 *  we render or feed into readiness math. The full row lives on the server. */
export type Checkin = Pick<
  CheckinRow,
  | "readiness"
  | "energy_label"
  | "mood"
  | "soreness"
  | "feel_notes"
  | "sick"
  | "sickness_notes"
  | "fatigue"
  | "bloating"
  | "soreness_areas"
  | "soreness_severity"
  | "intake_state"
>;

export async function fetchCheckinServer(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<Checkin | null> {
  const { data, error } = await supabase
    .from("checkins")
    .select(COLS)
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();
  if (error) throw error;
  return (data as Checkin | null) ?? null;
}

export async function fetchCheckinBrowser(
  userId: string,
  date: string,
): Promise<Checkin | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("checkins")
    .select(COLS)
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();
  if (error) throw error;
  return (data as Checkin | null) ?? null;
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. (Consumers of the old `Checkin` type still get the same fields plus a few new ones — `Pick` is a strict superset.)

- [ ] **Step 5: Commit**

```bash
git add lib/data/types.ts lib/chat/types.ts lib/query/fetchers/checkin.ts
git commit -m "feat(types): morning intake schema mirrored in TS

CheckinRow + IntakeState + chip UI types in data/types.ts.
ChatMessage gains kind + ui. Checkin fetcher selects new columns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Readiness math — extend `FeelInput`, rewrite `getIntensityMode`, energy nudge

**Files:**
- Modify: `lib/coach/readiness.ts`
- Modify: `components/dashboard/TodayClient.tsx` — extend feel construction
- Modify: `components/strength/StrengthClient.tsx` — extend feel construction

- [ ] **Step 1: Extend `FeelInput` and add new mode constants in `lib/coach/readiness.ts`**

Replace the `FeelInput` type and add new shared constants near the top:

```ts
export type FeelInput = {
  readiness: number | null; // 1-10
  energyLabel: string | null; // 'low' | 'medium' | 'high'
  mood: string | null;
  soreness: string | null;          // legacy free-text; readiness math no longer reads this
  notes: string | null;
  // 0007 additions
  sick: boolean;
  fatigue: "none" | "some" | "heavy" | null;
  sorenessAreas: string[] | null;
  sorenessSeverity: "mild" | "sharp" | null;
};

const MODE_REST: IntensityMode = {
  label: "⚫ REST DAY",
  color: "#6b7280",
  multiplier: 0,
  desc: "Body needs rest. Skip training or do gentle mobility only.",
};
const MODE_LIGHT: IntensityMode = {
  label: "🔴 LIGHT / RECOVERY",
  color: "#ff453a",
  multiplier: 0.7,
  desc: "Low readiness — keep it light, high reps, no failure. Mobility priority.",
};
const MODE_MODERATE: IntensityMode = {
  label: "🟡 MODERATE",
  color: "#ffd60a",
  multiplier: 0.85,
  desc: "Moderate readiness — reduce working weight by 10–15%, focus on form.",
};
const MODE_FULL: IntensityMode = {
  label: "🟢 FULL SESSION",
  color: "#86efac",
  multiplier: 0.95,
  desc: "Good readiness — train at full intensity, stop 1 rep shy of failure.",
};
const MODE_PUSH: IntensityMode = {
  label: "⚡ PUSH HARD",
  color: "#30d158",
  multiplier: 1.0,
  desc: "Peak readiness — go for PRs on your primary lifts today.",
};
```

- [ ] **Step 2: Add the energy nudge to `computeDailyReadiness`**

Replace the body of `computeDailyReadiness`:

```ts
export function computeDailyReadiness(
  log: Pick<DailyLog, "hrv" | "sleep_score" | "recovery"> | null,
  feel: FeelInput | null,
  hrvBaseline = HRV_BASELINE_DEFAULT,
): ReadinessSummary {
  const hrv = log?.hrv ?? 0;
  const sleep = log?.sleep_score ?? 0;
  const whoopRecovery = log?.recovery ?? 0;
  const feelScore = feel?.readiness ?? 0;

  const hrvScore = hrv > 0 ? Math.min(100, (hrv / hrvBaseline) * 80) : 0;
  const whoopScore = hrvScore * 0.4 + whoopRecovery * 0.4 + sleep * 0.2;

  // Energy nudge: ±5% to feelPct based on self-reported energy. Capped at 100.
  // Lets "felt 8/10 with low energy" diverge from "felt 8/10 with high energy".
  const energyFactor =
    feel?.energyLabel === "low"  ? 0.9 :
    feel?.energyLabel === "high" ? 1.05 :
    1.0;
  const feelPctRaw = feelScore > 0 ? (feelScore / 10) * 100 : null;
  const feelPct = feelPctRaw !== null ? Math.min(100, feelPctRaw * energyFactor) : null;

  const combined = feelPct !== null ? whoopScore * 0.65 + feelPct * 0.35 : whoopScore;

  return {
    score: Math.round(combined),
    whoopScore: Math.round(whoopScore),
    feelScore: feelPct !== null ? Math.round(feelPct) : null,
    hrv,
    whoopRecovery,
    sleep,
    feelRaw: feelScore,
    hasFeel: feelScore > 0,
  };
}
```

- [ ] **Step 3: Rewrite `getIntensityMode`**

Replace the function body:

```ts
export function getIntensityMode(readiness: ReadinessSummary, feel: FeelInput | null): IntensityMode {
  // Hard overrides — applied before any score band.
  if (feel?.sick) return MODE_REST;
  if (feel?.sorenessSeverity === "sharp") return MODE_LIGHT;
  if (feel?.fatigue === "heavy") return MODE_MODERATE;
  const mildAreas = feel?.sorenessAreas?.length ?? 0;
  if (feel?.sorenessSeverity === "mild" && mildAreas >= 3) return MODE_MODERATE;

  // Score-banded logic (unchanged from before — same thresholds).
  const s = readiness.score;
  if (s >= 80) return MODE_PUSH;
  if (s >= 65) return MODE_FULL;
  if (s >= 50) return MODE_MODERATE;
  if (s >= 35) return MODE_LIGHT;
  return MODE_REST;
}
```

The old function returned freshly-allocated mode objects each call; using shared constants is fine because callers don't mutate them. If any caller does, switch to spread `{ ...MODE_X }` later — for now this matches current behavior in every consumer I traced.

- [ ] **Step 4: Update `components/dashboard/TodayClient.tsx` feel construction**

In `components/dashboard/TodayClient.tsx`, find the `feelInput` const (around line 136) and extend:

```ts
const feelInput = checkin
  ? {
      readiness: checkin.readiness ?? null,
      energyLabel: checkin.energy_label ?? null,
      mood: checkin.mood ?? null,
      soreness: checkin.soreness ?? null,
      notes: checkin.feel_notes ?? null,
      sick: checkin.sick ?? false,
      fatigue: checkin.fatigue ?? null,
      sorenessAreas: checkin.soreness_areas ?? null,
      sorenessSeverity: checkin.soreness_severity ?? null,
    }
  : null;
```

- [ ] **Step 5: Update `components/strength/StrengthClient.tsx` feel construction**

In `components/strength/StrengthClient.tsx`, find the `feel` const (around line 83) and extend:

```ts
const feel = todayCheckin
  ? {
      readiness: todayCheckin.readiness,
      energyLabel: todayCheckin.energy_label,
      mood: todayCheckin.mood,
      soreness: todayCheckin.soreness,
      notes: todayCheckin.feel_notes,
      sick: todayCheckin.sick ?? false,
      fatigue: todayCheckin.fatigue ?? null,
      sorenessAreas: todayCheckin.soreness_areas ?? null,
      sorenessSeverity: todayCheckin.soreness_severity ?? null,
    }
  : null;
```

- [ ] **Step 6: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Manual smoke test (existing dashboard)**

Start the dev server and load `/`. Mode label and score should be unchanged for any current `checkins` row (sick=false, no new fields populated). The new overrides only activate when the new fields are non-default.

```bash
npm run dev
```

Open `http://localhost:3000`. Verify the readiness donut and intensity-mode pill render as before. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add lib/coach/readiness.ts components/dashboard/TodayClient.tsx components/strength/StrengthClient.tsx
git commit -m "feat(readiness): structured feel signals drive intensity overrides

FeelInput gains sick, fatigue, sorenessAreas, sorenessSeverity.
getIntensityMode applies hard overrides before score bands:
- sick → REST
- sharp soreness → LIGHT
- heavy fatigue → MODERATE
- mild soreness in 3+ areas → MODERATE

Energy nudge (±5% to feelPct) lets self-reported energy diverge
from raw 1-10 readiness in the headline number.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Pure morning logic — `script.ts` and `state.ts`

**Files:**
- Create: `lib/morning/script.ts`
- Create: `lib/morning/state.ts`

These are pure modules with zero IO. The state module is the single source of truth for "what's the next slot" — both server (intake route) and client (resume detection in MorningTrigger) call into it.

- [ ] **Step 1: Create `lib/morning/script.ts`**

```ts
// lib/morning/script.ts
//
// Pure data: the scripted question list for the morning intake. Each entry
// describes one slot — its prompt copy, the chip values it accepts, and how
// it renders. Order matters: nextSlot() in state.ts walks this list and
// returns the first slot whose checkin column is null.
//
// Slot shapes are intentionally narrow — chip values map 1:1 to DB column
// values (e.g. fatigue chips emit 'none' | 'some' | 'heavy', not free text).
// Any new slot here must be paired with a CheckinRow column.

import type { Fatigue, SorenessSeverity } from "@/lib/data/types";

export type SlotKey =
  | "readiness"
  | "energy_label"
  | "mood"
  | "soreness_gate"
  | "soreness_areas"
  | "soreness_severity"
  | "fatigue"
  | "bloating";

export type SlotChip = { label: string; value: string | number };

export type SlotDef = {
  key: SlotKey;
  prompt: string;
  chips: SlotChip[];
  multi_select?: boolean;
  /** When true, this slot only appears if the gate-condition (the soreness Y/N
   *  gate) was answered "yes". Resolved by nextSlot() in state.ts. */
  conditional_on_soreness?: boolean;
};

export const SOREN_AREAS = ["chest", "back", "legs", "shoulders", "arms", "core"] as const;

export const SLOTS: SlotDef[] = [
  {
    key: "readiness",
    prompt: "Good morning. How does your body feel today?",
    chips: Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), value: i + 1 })),
  },
  {
    key: "energy_label",
    prompt: "Energy level?",
    chips: [
      { label: "Low",    value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High",   value: "high" },
    ],
  },
  {
    key: "mood",
    prompt: "Mood?",
    chips: [
      { label: "😔", value: "😔" },
      { label: "😐", value: "😐" },
      { label: "😊", value: "😊" },
      { label: "🔥", value: "🔥" },
    ],
  },
  {
    key: "soreness_gate",
    prompt: "Any muscle soreness?",
    chips: [
      { label: "No",  value: "no" },
      { label: "Yes", value: "yes" },
    ],
  },
  {
    key: "soreness_areas",
    prompt: "Where are you sore? (tap all that apply)",
    chips: SOREN_AREAS.map((a) => ({ label: a[0].toUpperCase() + a.slice(1), value: a })),
    multi_select: true,
    conditional_on_soreness: true,
  },
  {
    key: "soreness_severity",
    prompt: "How sore?",
    chips: [
      { label: "Mild",  value: "mild" satisfies SorenessSeverity },
      { label: "Sharp", value: "sharp" satisfies SorenessSeverity },
    ],
    conditional_on_soreness: true,
  },
  {
    key: "fatigue",
    prompt: "Any extra fatigue beyond normal?",
    chips: [
      { label: "None", value: "none" satisfies Fatigue },
      { label: "Some", value: "some" satisfies Fatigue },
      { label: "Heavy", value: "heavy" satisfies Fatigue },
    ],
  },
  {
    key: "bloating",
    prompt: "Feeling bloated?",
    chips: [
      { label: "No",  value: "no" },
      { label: "Yes", value: "yes" },
    ],
  },
];

/** Lookup table for the route handler. */
export const SLOT_BY_KEY: Record<SlotKey, SlotDef> = Object.fromEntries(
  SLOTS.map((s) => [s.key, s]),
) as Record<SlotKey, SlotDef>;

export const STILL_SICK_PROMPT = "Still feeling sick?";
export const STILL_SICK_CHIPS: SlotChip[] = [
  { label: "Yes", value: "yes" },
  { label: "No",  value: "no" },
];

export const SICKNESS_NOTES_PROMPT = "Sorry to hear it. What's going on?";

export const REST_DAY_MESSAGE_HEALTHY_TO_SICK =
  "Take it easy today. REST mode locked in. I'll check in tomorrow. (To undo, edit on the Log page.)";

export const REST_DAY_MESSAGE_STILL_SICK =
  "Got it — REST again today. Hope you bounce back soon.";

export const FREE_TEXT_TAIL_PROMPT =
  "Anything else worth flagging? (or just hit send if you're good)";

export const SYNC_WHOOP_PROMPT =
  "WHOOP hasn't synced yet — usually arrives within 30 min of waking. Tap below to pull it now, or I'll deliver the plan when it lands.";

export const SYNC_WHOOP_FAILED_PROMPT =
  "WHOOP sync failed. Try again, or skip and I'll give you a feel-only plan based on the last 7 days.";
```

- [ ] **Step 2: Create `lib/morning/state.ts`**

```ts
// lib/morning/state.ts
//
// Pure state-machine functions for the morning intake bot. Both the server
// (api/chat/morning/intake) and the client (MorningTrigger) call into these.
// Zero IO, zero clocks (clock injected) — fully deterministic, easy to test.

import type { CheckinRow, IntakeState } from "@/lib/data/types";
import { SLOTS, type SlotKey } from "./script";

/**
 * Decide what the morning bot should do on app-open.
 *
 * - `'fresh'` — no row for today; start from question 1 (or "still sick?" if
 *   yesterday was sick — resolved separately).
 * - `'resume_feel'` — today's row exists in awaiting_feel /
 *   awaiting_sickness_notes; reopen the panel to whatever the latest assistant
 *   message dictates.
 * - `'resume_whoop'` — Phase 1 done; plan parked waiting on WHOOP.
 * - `'still_sick_check'` — yesterday `sick=true`, no row yet today; first
 *   question is "still feeling sick?".
 * - `'skip'` — already delivered for today; bot stays closed.
 */
export type IntakeAction =
  | { action: "open"; mode: "fresh" | "resume_feel" | "resume_whoop" | "still_sick_check" }
  | { action: "skip" };

export function decideIntakeAction(
  yesterdayRow: Pick<CheckinRow, "sick"> | null,
  todayRow: Pick<CheckinRow, "intake_state"> | null,
): IntakeAction {
  if (!todayRow) {
    if (yesterdayRow?.sick) return { action: "open", mode: "still_sick_check" };
    return { action: "open", mode: "fresh" };
  }
  switch (todayRow.intake_state) {
    case "delivered":
      return { action: "skip" };
    case "awaiting_whoop":
      return { action: "open", mode: "resume_whoop" };
    case "pending":
    case "awaiting_feel":
    case "awaiting_sickness_notes":
      return { action: "open", mode: "resume_feel" };
    default: {
      // Exhaustiveness guard. If a new state is added, the type system flags
      // this branch.
      const _exhaustive: never = todayRow.intake_state;
      void _exhaustive;
      return { action: "open", mode: "resume_feel" };
    }
  }
}

/**
 * Given a partial today row, return the next un-answered slot or 'tail' if
 * all chip slots are filled (LLM tail step) or 'done' if the LLM tail has
 * also been completed (caller then transitions to recommendation).
 *
 * Rules:
 * - readiness, energy_label, mood are required in order.
 * - soreness_gate is required next; if 'no', skip soreness_areas + severity.
 * - soreness_areas is required if soreness_gate=yes; severity follows.
 * - fatigue, bloating last.
 * - 'tail' returned when all chip slots above are populated and
 *   feel_notes is null. Tail is the free-text "anything else?" turn.
 * - 'done' returned when feel_notes is non-null (tail completed).
 *
 * The "soreness_gate" slot is virtual — there is no DB column for it. We
 * derive its answered-ness from the first non-null of {soreness_areas[0],
 * soreness_severity, soreness}. If the user said 'no', we record that by
 * setting soreness_areas=[] (empty array) so subsequent calls skip the
 * conditional slots.
 */
export type SlotProgress =
  | { kind: "slot"; key: SlotKey }
  | { kind: "tail" }
  | { kind: "done" };

export function nextSlot(
  row: Pick<
    CheckinRow,
    | "readiness"
    | "energy_label"
    | "mood"
    | "soreness_areas"
    | "soreness_severity"
    | "fatigue"
    | "bloating"
    | "feel_notes"
  >,
): SlotProgress {
  if (row.readiness == null)    return { kind: "slot", key: "readiness" };
  if (row.energy_label == null) return { kind: "slot", key: "energy_label" };
  if (row.mood == null)         return { kind: "slot", key: "mood" };

  // Gate: soreness_areas null → not asked yet. Empty array → user said 'no'.
  if (row.soreness_areas == null) return { kind: "slot", key: "soreness_gate" };

  if (row.soreness_areas.length > 0) {
    if (row.soreness_severity == null) return { kind: "slot", key: "soreness_severity" };
  }

  if (row.fatigue == null)  return { kind: "slot", key: "fatigue" };
  if (row.bloating == null) return { kind: "slot", key: "bloating" };

  if (row.feel_notes == null) return { kind: "tail" };
  return { kind: "done" };
}

/**
 * Given the current state and what the user just answered, return the next
 * intake_state value. Called by the route after persisting the slot value.
 * Never goes backwards.
 */
export function nextIntakeState(
  current: IntakeState,
  rowAfterUpdate: Pick<
    CheckinRow,
    | "sick"
    | "readiness"
    | "energy_label"
    | "mood"
    | "soreness_areas"
    | "soreness_severity"
    | "fatigue"
    | "bloating"
    | "feel_notes"
  >,
): IntakeState {
  if (rowAfterUpdate.sick) return "delivered"; // sick path short-circuits
  if (current === "delivered" || current === "awaiting_whoop") return current;
  const next = nextSlot(rowAfterUpdate);
  if (next.kind === "done") return "awaiting_whoop"; // tail completed; recommendation route flips to delivered
  return "awaiting_feel";
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/morning/script.ts lib/morning/state.ts
git commit -m "feat(morning): pure script + state-machine functions

script.ts: question definitions, chip values, copy strings.
state.ts: decideIntakeAction (open/skip/resume), nextSlot (which
question is next), nextIntakeState (state transitions). All pure,
no IO.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: LogForm + saveDailyLog action — manual edit path for new fields

**Files:**
- Modify: `components/log/LogForm.tsx` — add structured chip pickers for new slots
- Modify: `app/log/actions.ts` — write new fields, set `intake_state='delivered'` when full

The `/log` form remains the read-back/edit surface. After this task, the user can manually fill the new structured fields — proves the data model end-to-end before any chat work.

- [ ] **Step 1: Extend `CheckinState` and inputs in `LogForm.tsx`**

Find the existing `CheckinState` type (around line 78) and the `MOOD_OPTIONS`/`ENERGY_OPTIONS`/`READINESS_NUMS` constants. Replace `CheckinState` and add new constants:

```ts
const ENERGY_OPTIONS = ["low", "medium", "high"] as const;
const MOOD_OPTIONS = ["😔", "😐", "😊", "🔥"] as const;
const READINESS_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const FATIGUE_OPTIONS = ["none", "some", "heavy"] as const;
const SORENESS_AREAS = ["chest", "back", "legs", "shoulders", "arms", "core"] as const;
const SORENESS_SEVERITY_OPTIONS = ["mild", "sharp"] as const;

type CheckinState = {
  readiness: number | null;
  energy_label: string;
  mood: string;
  soreness: string;
  feel_notes: string;
  sick: boolean;
  sickness_notes: string;
  fatigue: string;            // '' | 'none' | 'some' | 'heavy'
  bloating: boolean | null;
  soreness_areas: string[];
  soreness_severity: string;  // '' | 'mild' | 'sharp'
};
```

Note: `energy_label` values lowercased to match DB convention (the existing form wrote "Low"/"Medium"/"High" — change to lowercase here, and in the `getIntensityMode` energy nudge we already match on lowercase).

- [ ] **Step 2: Extend the Props.initialCheckin shape**

Replace the `Props` type:

```ts
type Props = {
  date: string;
  initialLog: Partial<DailyLog> | null;
  initialCheckin: {
    readiness: number | null;
    energy_label: string | null;
    mood: string | null;
    soreness: string | null;
    feel_notes: string | null;
    sick: boolean | null;
    sickness_notes: string | null;
    fatigue: string | null;
    bloating: boolean | null;
    soreness_areas: string[] | null;
    soreness_severity: string | null;
  } | null;
};
```

- [ ] **Step 3: Initialize new fields in the `useState` call**

Replace the `useState` initializer:

```ts
const [feel, setFeel] = useState<CheckinState>({
  readiness: initialCheckin?.readiness ?? null,
  energy_label: initialCheckin?.energy_label ?? "",
  mood: initialCheckin?.mood ?? "",
  soreness: initialCheckin?.soreness ?? "",
  feel_notes: initialCheckin?.feel_notes ?? "",
  sick: initialCheckin?.sick ?? false,
  sickness_notes: initialCheckin?.sickness_notes ?? "",
  fatigue: initialCheckin?.fatigue ?? "",
  bloating: initialCheckin?.bloating ?? null,
  soreness_areas: initialCheckin?.soreness_areas ?? [],
  soreness_severity: initialCheckin?.soreness_severity ?? "",
});
```

- [ ] **Step 4: Render new chip pickers in the Morning Feel card**

Find the existing "Morning Feel" Card block (the one rendering readiness/energy/mood/soreness/feel_notes). Append these field blocks after the existing `feel_notes` textarea:

```tsx
{/* Sickness */}
<div style={{ marginTop: "14px" }}>
  <div
    style={{
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: COLOR.textMuted,
      fontWeight: 600,
      marginBottom: "8px",
    }}
  >
    Sickness
  </div>
  <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: COLOR.textStrong }}>
    <input
      type="checkbox"
      checked={feel.sick}
      onChange={(e) => setFeel((f) => ({ ...f, sick: e.target.checked }))}
    />
    I'm sick today
  </label>
  {feel.sick && (
    <textarea
      placeholder="What's going on? (optional)"
      value={feel.sickness_notes}
      onChange={(e) => setFeel((f) => ({ ...f, sickness_notes: e.target.value }))}
      style={{ ...inputStyle, marginTop: "8px", minHeight: "60px", resize: "vertical" }}
    />
  )}
</div>

{/* Fatigue */}
<div style={{ marginTop: "14px" }}>
  <div
    style={{
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: COLOR.textMuted,
      fontWeight: 600,
      marginBottom: "8px",
    }}
  >
    Fatigue
  </div>
  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
    {FATIGUE_OPTIONS.map((o) => (
      <button
        type="button"
        key={o}
        onClick={() => setFeel((f) => ({ ...f, fatigue: f.fatigue === o ? "" : o }))}
        style={{
          padding: "6px 12px",
          borderRadius: "999px",
          background: feel.fatigue === o ? COLOR.accent : COLOR.surfaceAlt,
          color: feel.fatigue === o ? "#fff" : COLOR.textMuted,
          border: "none",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          textTransform: "capitalize",
        }}
      >
        {o}
      </button>
    ))}
  </div>
</div>

{/* Bloating */}
<div style={{ marginTop: "14px" }}>
  <div
    style={{
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: COLOR.textMuted,
      fontWeight: 600,
      marginBottom: "8px",
    }}
  >
    Bloating
  </div>
  <div style={{ display: "flex", gap: "6px" }}>
    {[
      { label: "No",  value: false },
      { label: "Yes", value: true  },
    ].map((opt) => (
      <button
        type="button"
        key={opt.label}
        onClick={() => setFeel((f) => ({ ...f, bloating: f.bloating === opt.value ? null : opt.value }))}
        style={{
          padding: "6px 12px",
          borderRadius: "999px",
          background: feel.bloating === opt.value ? COLOR.accent : COLOR.surfaceAlt,
          color: feel.bloating === opt.value ? "#fff" : COLOR.textMuted,
          border: "none",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {opt.label}
      </button>
    ))}
  </div>
</div>

{/* Soreness areas + severity */}
<div style={{ marginTop: "14px" }}>
  <div
    style={{
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: COLOR.textMuted,
      fontWeight: 600,
      marginBottom: "8px",
    }}
  >
    Soreness areas
  </div>
  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
    {SORENESS_AREAS.map((a) => {
      const on = feel.soreness_areas.includes(a);
      return (
        <button
          type="button"
          key={a}
          onClick={() =>
            setFeel((f) => ({
              ...f,
              soreness_areas: on
                ? f.soreness_areas.filter((x) => x !== a)
                : [...f.soreness_areas, a],
            }))
          }
          style={{
            padding: "6px 12px",
            borderRadius: "999px",
            background: on ? COLOR.accent : COLOR.surfaceAlt,
            color: on ? "#fff" : COLOR.textMuted,
            border: "none",
            fontSize: "12px",
            fontWeight: 600,
            cursor: "pointer",
            textTransform: "capitalize",
          }}
        >
          {a}
        </button>
      );
    })}
  </div>
  {feel.soreness_areas.length > 0 && (
    <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
      {SORENESS_SEVERITY_OPTIONS.map((sev) => (
        <button
          type="button"
          key={sev}
          onClick={() => setFeel((f) => ({ ...f, soreness_severity: f.soreness_severity === sev ? "" : sev }))}
          style={{
            padding: "6px 12px",
            borderRadius: "999px",
            background: feel.soreness_severity === sev ? COLOR.accent : COLOR.surfaceAlt,
            color: feel.soreness_severity === sev ? "#fff" : COLOR.textMuted,
            border: "none",
            fontSize: "12px",
            fontWeight: 600,
            cursor: "pointer",
            textTransform: "capitalize",
          }}
        >
          {sev}
        </button>
      ))}
    </div>
  )}
</div>
```

Add hidden inputs for the new fields (find the existing block of hidden `feel_*` inputs and add):

```tsx
<input type="hidden" name="feel_sick" value={feel.sick ? "1" : ""} />
<input type="hidden" name="feel_sickness_notes" value={feel.sickness_notes} />
<input type="hidden" name="feel_fatigue" value={feel.fatigue} />
<input
  type="hidden"
  name="feel_bloating"
  value={feel.bloating === null ? "" : feel.bloating ? "1" : "0"}
/>
<input type="hidden" name="feel_soreness_areas" value={feel.soreness_areas.join(",")} />
<input type="hidden" name="feel_soreness_severity" value={feel.soreness_severity} />
```

- [ ] **Step 5: Update `app/log/actions.ts` to persist new fields and flip `intake_state`**

Replace the `saveDailyLog`'s checkin block (currently around lines 70–90):

```ts
// Save the morning-feel checkin in the same submit
const sickRaw = formData.get("feel_sick");
const sick = typeof sickRaw === "string" && sickRaw === "1";
const bloatingRaw = formData.get("feel_bloating");
const bloating: boolean | null =
  typeof bloatingRaw === "string" && bloatingRaw !== ""
    ? bloatingRaw === "1"
    : null;
const sorenessAreasRaw = formData.get("feel_soreness_areas");
const sorenessAreas: string[] | null =
  typeof sorenessAreasRaw === "string" && sorenessAreasRaw.trim() !== ""
    ? sorenessAreasRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

const checkinRow = {
  user_id: user.id,
  date,
  readiness: intOrNull(formData.get("feel_readiness")),
  energy_label: str(formData.get("feel_energy")),
  mood: str(formData.get("feel_mood")),
  soreness: str(formData.get("feel_soreness")),
  feel_notes: str(formData.get("feel_notes")),
  sick,
  sickness_notes: str(formData.get("feel_sickness_notes")),
  fatigue: str(formData.get("feel_fatigue")),
  bloating,
  soreness_areas: sorenessAreas,
  soreness_severity: str(formData.get("feel_soreness_severity")),
};

// Auto-mark intake_state='delivered' when the user fills in enough via the
// form for the bot to be redundant for the day. "Enough" = readiness + the
// gate fields needed by readiness math (energy, sick OR all three of
// {fatigue, bloating, soreness gate answered}).
const requiredFilled =
  checkinRow.readiness !== null &&
  checkinRow.energy_label !== null &&
  (checkinRow.sick || (
    checkinRow.fatigue !== null &&
    checkinRow.bloating !== null &&
    checkinRow.soreness_areas !== null
  ));

const hasFeelInput = Object.entries(checkinRow).some(([k, v]) => {
  if (k === "user_id" || k === "date") return false;
  if (v === null || v === false || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
});

if (hasFeelInput) {
  const finalRow = {
    ...checkinRow,
    ...(requiredFilled ? { intake_state: "delivered" as const } : {}),
  };
  const { error: cErr } = await supabase
    .from("checkins")
    .upsert(finalRow, { onConflict: "user_id,date" });
  if (cErr) throw cErr;
}
```

- [ ] **Step 6: Update LogClient to pass new fields to LogForm**

In `components/log/LogClient.tsx`, find the `initialCheckin={...}` JSX and extend:

```tsx
initialCheckin={
  checkin
    ? {
        readiness: checkin.readiness,
        energy_label: checkin.energy_label,
        mood: checkin.mood,
        soreness: checkin.soreness,
        feel_notes: checkin.feel_notes,
        sick: checkin.sick,
        sickness_notes: checkin.sickness_notes,
        fatigue: checkin.fatigue,
        bloating: checkin.bloating,
        soreness_areas: checkin.soreness_areas,
        soreness_severity: checkin.soreness_severity,
      }
    : null
}
```

- [ ] **Step 7: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Manual smoke test**

```bash
npm run dev
```

Open `/log`. Fill in: readiness=8, energy=Medium, mood=😊, soreness areas=back,chest, severity=mild, fatigue=some, bloating=No. Click Save.

Expected: form posts; success flash. Reopen `/log` for today; the values are pre-filled. Check Supabase `checkins` row: new columns populated; `intake_state='delivered'`.

Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add components/log/LogForm.tsx components/log/LogClient.tsx app/log/actions.ts
git commit -m "feat(log): editable structured feel fields, intake_state on full save

LogForm gains chip pickers for sick/fatigue/bloating/soreness areas+severity.
saveDailyLog persists new fields and flips intake_state='delivered' when
the form has enough info to make the morning bot redundant for the day.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Server endpoint — `/api/chat/morning/intake`

**Files:**
- Create: `app/api/chat/morning/intake/route.ts`
- Create: `lib/morning/tools.ts` — Anthropic tool def for the LLM tail

This is the workhorse — single POST handler that owns the state machine. Sub-handlers per body shape: `start`, `slot`, `declare_sick`, `free_text`.

- [ ] **Step 1: Create `lib/morning/tools.ts`**

```ts
// lib/morning/tools.ts
//
// Anthropic tool def for the morning intake LLM tail step. Claude can call
// this once per turn to promote symptoms it heard in the user's free text
// into structured columns (e.g. user typed "back is killing me" → emit
// {soreness_areas: ['back'], soreness_severity: 'sharp'}).

import type Anthropic from "@anthropic-ai/sdk";

export const UPDATE_INTAKE_SLOTS_TOOL: Anthropic.Tool = {
  name: "update_intake_slots",
  description:
    "Promote symptoms mentioned in the user's free-text reply into structured " +
    "checkin columns. Only emit slots that are clearly stated. Never guess. " +
    "If the user mentions illness, set sick=true. If they mention a body area " +
    "and intensity, set soreness_areas + soreness_severity. If they mention " +
    "fatigue, set fatigue. Do not call this tool if no symptoms map cleanly.",
  input_schema: {
    type: "object",
    properties: {
      sick: { type: "boolean" },
      sickness_notes: { type: "string" },
      fatigue: { type: "string", enum: ["none", "some", "heavy"] },
      soreness_areas: {
        type: "array",
        items: { type: "string", enum: ["chest", "back", "legs", "shoulders", "arms", "core"] },
      },
      soreness_severity: { type: "string", enum: ["mild", "sharp"] },
      bloating: { type: "boolean" },
    },
  },
};
```

- [ ] **Step 2: Create `app/api/chat/morning/intake/route.ts`**

This is large; structured below into sub-handlers. The route is dispatch-only — actual transitions live in pure functions or sub-handlers.

```ts
// app/api/chat/morning/intake/route.ts
//
// Morning intake state-machine endpoint. POST one of:
//   {kind: 'start'}                               — begin or resume the day
//   {kind: 'declare_sick'}                        — flip sick=true, ask for notes
//   {kind: 'free_text', value: string}            — LLM tail OR sickness_notes (dispatch on intake_state)
//   {slot: SlotKey, value: string|number|string[]} — chip answer
//
// Server is the single source of truth for "what's the next question".
// Each call upserts the matching checkin column, advances intake_state via
// nextIntakeState(), inserts the next assistant chat_messages row (with
// ui.chips when scripted, streamed with Claude when free-text tail), and
// returns SSE for the streaming case or JSON for the scripted case.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import {
  SLOT_BY_KEY,
  STILL_SICK_PROMPT,
  STILL_SICK_CHIPS,
  SICKNESS_NOTES_PROMPT,
  REST_DAY_MESSAGE_HEALTHY_TO_SICK,
  REST_DAY_MESSAGE_STILL_SICK,
  FREE_TEXT_TAIL_PROMPT,
  type SlotKey,
} from "@/lib/morning/script";
import { nextSlot, nextIntakeState } from "@/lib/morning/state";
import { UPDATE_INTAKE_SLOTS_TOOL } from "@/lib/morning/tools";
import type { CheckinRow, IntakeState, MorningUI } from "@/lib/data/types";
import { formatSseEvent } from "@/lib/chat/sse";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-5";

type Body =
  | { kind: "start" }
  | { kind: "declare_sick" }
  | { kind: "free_text"; value: string }
  | { slot: SlotKey | "soreness_gate"; value: string | number | string[] };

type SR = SupabaseClient;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as Body;
  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  // Always read today's row first; many handlers need it.
  const { data: todayRow } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();

  // ── start: bootstrap the day ────────────────────────────────────────────────
  if ("kind" in body && body.kind === "start") {
    return handleStart({ sr, userId: user.id, today, todayRow });
  }

  // ── declare_sick: user tapped "I'm coming down with something" ──────────────
  if ("kind" in body && body.kind === "declare_sick") {
    return handleDeclareSick({ sr, userId: user.id, today, todayRow });
  }

  // ── free_text: dispatch on current state ────────────────────────────────────
  if ("kind" in body && body.kind === "free_text") {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    if (todayRow.intake_state === "awaiting_sickness_notes") {
      return handleSicknessNotes({ sr, userId: user.id, today, value: body.value });
    }
    return handleFeelTail({ sr, userId: user.id, today, todayRow, value: body.value });
  }

  // ── slot answer ─────────────────────────────────────────────────────────────
  if ("slot" in body) {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    return handleSlotAnswer({ sr, userId: user.id, today, todayRow, body });
  }

  return NextResponse.json({ ok: false, reason: "bad_body" }, { status: 400 });
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleStart(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today, todayRow } = args;

  // Already delivered → return 409 so client closes panel.
  if (todayRow?.intake_state === "delivered") {
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  // Resume: today row already exists in some non-delivered state. Just return
  // the latest assistant message so the client can render — no insert.
  if (todayRow && todayRow.intake_state !== "pending") {
    return NextResponse.json({ ok: true, resumed: true });
  }

  // Fresh: was yesterday sick?
  const yesterday = isoMinusDays(today, 1);
  const { data: yRow } = await sr
    .from("checkins")
    .select("sick, sickness_notes")
    .eq("user_id", userId)
    .eq("date", yesterday)
    .maybeSingle<Pick<CheckinRow, "sick" | "sickness_notes">>();

  if (yRow?.sick) {
    // Still-sick check-in path.
    await upsertCheckin(sr, userId, today, {
      intake_state: "awaiting_feel",
      sick: false, // will be flipped back to true if user answers Yes
      sickness_notes: yRow.sickness_notes ?? null, // carry forward as default
    });
    await insertAssistantTurn(sr, userId, today, {
      content: STILL_SICK_PROMPT,
      ui: { chips: STILL_SICK_CHIPS.map((c) => ({ ...c, slot: "still_sick" })) },
    });
    return NextResponse.json({ ok: true, resumed: false, mode: "still_sick_check" });
  }

  // Healthy fresh start — first slot is readiness.
  await upsertCheckin(sr, userId, today, { intake_state: "awaiting_feel" });
  const firstSlot = SLOT_BY_KEY.readiness;
  await insertAssistantTurn(sr, userId, today, {
    content: firstSlot.prompt,
    ui: chipsForSlot(firstSlot.key),
  });
  return NextResponse.json({ ok: true, resumed: false, mode: "fresh" });
}

async function handleDeclareSick(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today } = args;
  await upsertCheckin(sr, userId, today, {
    sick: true,
    intake_state: "awaiting_sickness_notes",
  });
  await insertAssistantTurn(sr, userId, today, {
    content: SICKNESS_NOTES_PROMPT,
    ui: { allow_text: true },
  });
  return NextResponse.json({ ok: true });
}

async function handleSicknessNotes(args: {
  sr: SR; userId: string; today: string; value: string;
}) {
  const { sr, userId, today, value } = args;
  await upsertCheckin(sr, userId, today, {
    sickness_notes: value.trim() || null,
    sick: true,
    intake_state: "delivered",
  });
  await insertAssistantTurn(sr, userId, today, {
    content: REST_DAY_MESSAGE_HEALTHY_TO_SICK,
    ui: null,
  });
  return NextResponse.json({ ok: true, delivered: true });
}

async function handleSlotAnswer(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow; body: Extract<Body, { slot: string }>;
}) {
  const { sr, userId, today, todayRow, body } = args;
  const slot = body.slot;
  const value = body.value;

  // Special: still_sick chip (yes/no). Only valid when the latest assistant
  // turn was the still-sick prompt. We detect by checking sickness_notes
  // existence and intake_state.
  if (slot === "still_sick") {
    if (value === "yes") {
      await upsertCheckin(sr, userId, today, {
        sick: true,
        intake_state: "delivered",
      });
      await insertAssistantTurn(sr, userId, today, {
        content: REST_DAY_MESSAGE_STILL_SICK,
        ui: null,
      });
      return NextResponse.json({ ok: true, delivered: true });
    }
    // No — flip sick=false (already done in handleStart) and proceed with
    // first scripted slot.
    await upsertCheckin(sr, userId, today, {
      sick: false,
      sickness_notes: null,
      intake_state: "awaiting_feel",
    });
    const firstSlot = SLOT_BY_KEY.readiness;
    await insertAssistantTurn(sr, userId, today, {
      content: "Good — let's run through the morning check-in. " + firstSlot.prompt,
      ui: chipsForSlot(firstSlot.key),
    });
    return NextResponse.json({ ok: true });
  }

  // Soreness gate (virtual slot)
  if (slot === "soreness_gate") {
    if (value === "no") {
      await upsertCheckin(sr, userId, today, {
        soreness_areas: [],
        soreness_severity: null,
      });
    }
    // 'yes' falls through; soreness_areas stays null so nextSlot returns
    // soreness_areas next.
  } else {
    // Map chip slot → DB column
    const update = mapSlotToColumn(slot as SlotKey, value);
    if (!update) {
      return NextResponse.json({ ok: false, reason: "bad_slot" }, { status: 400 });
    }
    await upsertCheckin(sr, userId, today, update);
  }

  // Re-read row, decide next.
  const { data: row } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", userId)
    .eq("date", today)
    .single<CheckinRow>();
  if (!row) {
    return NextResponse.json({ ok: false, reason: "row_lost" }, { status: 500 });
  }

  const next = nextSlot(row);
  const nextState = nextIntakeState(row.intake_state, row);

  if (nextState !== row.intake_state) {
    await upsertCheckin(sr, userId, today, { intake_state: nextState });
  }

  if (next.kind === "slot") {
    const def = SLOT_BY_KEY[next.key];
    await insertAssistantTurn(sr, userId, today, {
      content: def.prompt,
      ui: chipsForSlot(next.key),
    });
    return NextResponse.json({ ok: true, next: next.key });
  }

  if (next.kind === "tail") {
    await insertAssistantTurn(sr, userId, today, {
      content: FREE_TEXT_TAIL_PROMPT,
      ui: { allow_text: true },
    });
    return NextResponse.json({ ok: true, next: "tail" });
  }

  // Already 'done' (shouldn't happen mid-slot-answer; defensive).
  return NextResponse.json({ ok: true, next: "done" });
}

async function handleFeelTail(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow; value: string;
}) {
  const { sr, userId, today, value } = args;
  const trimmed = value.trim();

  // Save the user text first.
  await upsertCheckin(sr, userId, today, {
    feel_notes: trimmed || null,
  });

  // Insert user message into chat_messages so the thread shows it.
  await sr.from("chat_messages").insert({
    user_id: userId,
    role: "user",
    content: trimmed || "(no extra notes)",
    status: "done",
    kind: "morning_intake",
    ui: null,
  });

  // Stream Claude reply with the update_intake_slots tool available.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, reason: "no_api_key" }, { status: 500 });
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  // Pre-create assistant stub so we have an id to stream into.
  const { data: stub, error: stubErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: userId,
      role: "assistant",
      content: "",
      status: "streaming",
      kind: "morning_intake",
      ui: null,
      model: MODEL,
    })
    .select("id")
    .single();
  if (stubErr || !stub) {
    return NextResponse.json({ ok: false, reason: "stub_failed" }, { status: 500 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const sys = `You are an athlete's coach reviewing their morning notes. The user has just answered a free-text "anything else?" prompt during a structured morning check-in. Their structured slot answers are already saved.

Your job:
1. If the user's text mentions a symptom that maps to one of {sick, soreness_areas, fatigue, bloating} and is clearly stated, call update_intake_slots ONCE to record it. Do not guess. Do not call the tool if nothing maps cleanly.
2. Reply briefly (1-2 short sentences) acknowledging what they said. Don't ask more questions. Don't moralize.

Today's structured answers so far: ${JSON.stringify({
          readiness: args.todayRow.readiness,
          energy_label: args.todayRow.energy_label,
          mood: args.todayRow.mood,
          fatigue: args.todayRow.fatigue,
          bloating: args.todayRow.bloating,
          soreness_areas: args.todayRow.soreness_areas,
          soreness_severity: args.todayRow.soreness_severity,
        })}`;

        const apiStream = client.messages.stream({
          model: MODEL,
          max_tokens: 400,
          system: sys,
          tools: [UPDATE_INTAKE_SLOTS_TOOL],
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
          messages: [{ role: "user", content: trimmed || "(no notes)" }],
        });

        let assembled = "";
        for await (const ev of apiStream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            assembled += ev.delta.text;
            controller.enqueue(encoder.encode(formatSseEvent({
              event: "delta",
              data: { text: ev.delta.text },
            })));
          }
        }

        // Tool call?
        const final = await apiStream.finalMessage();
        for (const block of final.content) {
          if (block.type === "tool_use" && block.name === "update_intake_slots") {
            await applyToolUpdate(sr, userId, today, block.input as Record<string, unknown>);
          }
        }

        // Finalize stub
        await sr.from("chat_messages").update({
          content: assembled,
          status: "done",
        }).eq("id", stub.id);

        // Auto-advance to recommendation phase
        await upsertCheckin(sr, userId, today, { intake_state: "awaiting_whoop" });

        controller.enqueue(encoder.encode(formatSseEvent({
          event: "done",
          data: { message_id: stub.id },
        })));
        controller.close();
      } catch (e) {
        await sr.from("chat_messages").update({
          status: "error",
          error: String(e),
        }).eq("id", stub.id);
        controller.enqueue(encoder.encode(formatSseEvent({
          event: "error",
          data: { message: String(e) },
        })));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function upsertCheckin(
  sr: SR,
  userId: string,
  date: string,
  patch: Partial<CheckinRow>,
): Promise<void> {
  const { error } = await sr
    .from("checkins")
    .upsert({ user_id: userId, date, ...patch }, { onConflict: "user_id,date" });
  if (error) throw error;
}

async function insertAssistantTurn(
  sr: SR,
  userId: string,
  _date: string,
  args: { content: string; ui: MorningUI | null },
): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "assistant",
    content: args.content,
    status: "done",
    kind: "morning_intake",
    ui: args.ui,
  });
  if (error) throw error;
}

function chipsForSlot(key: SlotKey): MorningUI {
  const def = SLOT_BY_KEY[key];
  return {
    chips: def.chips.map((c) => ({ ...c, slot: key })),
    multi_select: def.multi_select ?? false,
  };
}

function mapSlotToColumn(
  slot: SlotKey,
  value: string | number | string[],
): Partial<CheckinRow> | null {
  switch (slot) {
    case "readiness":
      return typeof value === "number" ? { readiness: value } : null;
    case "energy_label":
      return typeof value === "string" ? { energy_label: value } : null;
    case "mood":
      return typeof value === "string" ? { mood: value } : null;
    case "soreness_areas":
      return Array.isArray(value) ? { soreness_areas: value } : null;
    case "soreness_severity":
      return typeof value === "string" && (value === "mild" || value === "sharp")
        ? { soreness_severity: value }
        : null;
    case "fatigue":
      return typeof value === "string" && (value === "none" || value === "some" || value === "heavy")
        ? { fatigue: value }
        : null;
    case "bloating":
      return typeof value === "string"
        ? { bloating: value === "yes" }
        : null;
    default:
      return null;
  }
}

async function applyToolUpdate(
  sr: SR, userId: string, today: string,
  input: Record<string, unknown>,
): Promise<void> {
  const update: Partial<CheckinRow> = {};
  if (typeof input.sick === "boolean") update.sick = input.sick;
  if (typeof input.sickness_notes === "string") update.sickness_notes = input.sickness_notes;
  if (input.fatigue === "none" || input.fatigue === "some" || input.fatigue === "heavy") {
    update.fatigue = input.fatigue;
  }
  if (Array.isArray(input.soreness_areas)) {
    update.soreness_areas = input.soreness_areas.filter(
      (a): a is string => typeof a === "string",
    );
  }
  if (input.soreness_severity === "mild" || input.soreness_severity === "sharp") {
    update.soreness_severity = input.soreness_severity;
  }
  if (typeof input.bloating === "boolean") update.bloating = input.bloating;
  if (Object.keys(update).length === 0) return;
  await upsertCheckin(sr, userId, today, update);
}

function isoMinusDays(iso: string, days: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test with curl**

```bash
npm run dev
```

In another shell, get your auth cookie from devtools (or use the Supabase auth helpers). Then:

```bash
# Replace ${COOKIE} with your full session cookie.
curl -s -X POST http://localhost:3000/api/chat/morning/intake \
  -H "Content-Type: application/json" \
  -H "Cookie: ${COOKIE}" \
  -d '{"kind":"start"}' | jq
```

Expected: `{"ok":true,"resumed":false,"mode":"fresh"}` (or `still_sick_check` if yesterday's sick=true).

Check Supabase: `checkins` row for today exists, `intake_state='awaiting_feel'`, and a new `chat_messages` row with `kind='morning_intake'`, `ui.chips` populated.

Then:

```bash
curl -s -X POST http://localhost:3000/api/chat/morning/intake \
  -H "Content-Type: application/json" \
  -H "Cookie: ${COOKIE}" \
  -d '{"slot":"readiness","value":8}' | jq
```

Expected: `{"ok":true,"next":"energy_label"}`.

Continue through energy_label, mood, soreness_gate (no), fatigue, bloating. Final response: `{"ok":true,"next":"tail"}`.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/morning/intake/route.ts lib/morning/tools.ts
git commit -m "feat(api): morning intake state-machine endpoint

POST /api/chat/morning/intake handles {kind:start|declare_sick|free_text}
and {slot,value} chip answers. Server upserts checkins, advances
intake_state via lib/morning/state, inserts the next assistant turn with
ui.chips. Free-text tail streams Claude with update_intake_slots tool
to promote symptoms into structured columns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Server endpoint — `/api/chat/morning/recommendation`

**Files:**
- Create: `app/api/chat/morning/recommendation/route.ts`

Generates the coach plan for today. Sick path: templated REST message. Healthy path: Claude streams a conversational rendering of `buildDailyPlan()`'s output.

- [ ] **Step 1: Create `app/api/chat/morning/recommendation/route.ts`**

```ts
// app/api/chat/morning/recommendation/route.ts
//
// POST: deliver today's coach recommendation as the next assistant message
// in the morning_intake thread. Idempotent on (user, date) — if state is
// already 'delivered', returns 409.
//
// Body: {} | {skip_whoop: true}  -- skip_whoop generates a feel-only plan.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import { buildDailyPlan, type FeelInput } from "@/lib/coach/readiness";
import type { CheckinRow, DailyLog } from "@/lib/data/types";
import { formatSseEvent } from "@/lib/chat/sse";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-5";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { skip_whoop?: boolean };
  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  const { data: row } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();
  if (!row) return NextResponse.json({ ok: false, reason: "no_row" }, { status: 409 });
  if (row.intake_state === "delivered") {
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  const { data: log } = await sr
    .from("daily_logs")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<DailyLog>();

  // ── sick path: templated REST, no LLM ───────────────────────────────────────
  if (row.sick) {
    return await deliverTemplated(sr, user.id,
      "REST mode locked in. Hydrate, eat clean, get extra sleep tonight. " +
      "I'll check on you in the morning.");
  }

  // ── feel-only fallback (skip_whoop) ─────────────────────────────────────────
  const useSkipPath = body.skip_whoop || !log || log.recovery == null;

  // For awaiting_whoop with no log/recovery and no skip flag, return 425
  // (Too Early) so the client knows to park and retry.
  if (!body.skip_whoop && (!log || log.recovery == null)) {
    // Mark intake_state='awaiting_whoop' if not already.
    if (row.intake_state !== "awaiting_whoop") {
      await sr.from("checkins").upsert(
        { user_id: user.id, date: today, intake_state: "awaiting_whoop" },
        { onConflict: "user_id,date" },
      );
    }
    return NextResponse.json({ ok: false, reason: "awaiting_whoop" }, { status: 425 });
  }

  // ── healthy path: Claude renders the plan ───────────────────────────────────
  const feel: FeelInput = {
    readiness: row.readiness,
    energyLabel: row.energy_label,
    mood: row.mood,
    soreness: row.soreness,
    notes: row.feel_notes,
    sick: row.sick,
    fatigue: row.fatigue,
    sorenessAreas: row.soreness_areas,
    sorenessSeverity: row.soreness_severity,
  };
  const plan = buildDailyPlan(log, feel);

  return await deliverWithClaude(sr, user.id, {
    plan,
    feel,
    log,
    skipWhoop: useSkipPath,
  });
}

async function deliverTemplated(
  sr: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  content: string,
) {
  const today = todayInUserTz();
  const { data: msg } = await sr
    .from("chat_messages")
    .insert({
      user_id: userId,
      role: "assistant",
      content,
      status: "done",
      kind: "morning_intake",
      ui: null,
    })
    .select("id")
    .single();
  await sr.from("checkins").upsert(
    { user_id: userId, date: today, intake_state: "delivered" },
    { onConflict: "user_id,date" },
  );
  return NextResponse.json({ ok: true, message_id: msg?.id ?? null });
}

async function deliverWithClaude(
  sr: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  args: {
    plan: ReturnType<typeof buildDailyPlan>;
    feel: FeelInput;
    log: DailyLog | null;
    skipWhoop: boolean;
  },
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, reason: "no_api_key" }, { status: 500 });

  const client = new Anthropic({ apiKey });
  const today = todayInUserTz();
  const encoder = new TextEncoder();

  const { data: stub } = await sr
    .from("chat_messages")
    .insert({
      user_id: userId,
      role: "assistant",
      content: "",
      status: "streaming",
      kind: "morning_intake",
      ui: null,
      model: MODEL,
    })
    .select("id")
    .single();
  if (!stub) return NextResponse.json({ ok: false, reason: "stub_failed" }, { status: 500 });

  const planJson = JSON.stringify({
    readiness_score: args.plan.readiness.score,
    mode: args.plan.mode.label,
    mode_desc: args.plan.mode.desc,
    multiplier: args.plan.mode.multiplier,
    session_type: args.plan.sessionType,
    exercises: args.plan.exercises.map((e) => ({
      name: e.name,
      target: e.target,
      adjusted: e.adjusted,
      isPRAttempt: e.isPRAttempt,
    })),
  });

  const sys = `You are the athlete's coach delivering today's morning recommendation. Plan was computed from WHOOP + their morning check-in:

${planJson}

Their feel: ${JSON.stringify(args.feel)}
Today's WHOOP: ${args.log ? `recovery=${args.log.recovery}, hrv=${args.log.hrv}, sleep_score=${args.log.sleep_score}, strain=${args.log.strain}` : "not synced"}
${args.skipWhoop ? "NOTE: WHOOP data unavailable — use feel + last 7 days for the plan. Mention this caveat once." : ""}

Render the plan conversationally as 3-5 short lines:
1. Open with a 1-line readiness summary tied to a specific number (HRV, recovery, or feel score).
2. State the intensity mode in plain words.
3. Call out 1-2 specific exercise adjustments from the plan (use exact numbers from "exercises").
4. End with one actionable cue.

Speak in concrete numbers — kg, reps, %, ms. No "around"/"roughly". Don't repeat the JSON; reference fields naturally.`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const apiStream = client.messages.stream({
          model: MODEL,
          max_tokens: 600,
          system: sys,
          messages: [{ role: "user", content: "Give me today's plan." }],
        });

        let assembled = "";
        for await (const ev of apiStream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            assembled += ev.delta.text;
            controller.enqueue(encoder.encode(formatSseEvent({
              event: "delta", data: { text: ev.delta.text },
            })));
          }
        }

        await sr.from("chat_messages").update({
          content: assembled,
          status: "done",
        }).eq("id", stub.id);

        await sr.from("checkins").upsert(
          { user_id: userId, date: today, intake_state: "delivered" },
          { onConflict: "user_id,date" },
        );

        controller.enqueue(encoder.encode(formatSseEvent({
          event: "done", data: { message_id: stub.id },
        })));
        controller.close();
      } catch (e) {
        await sr.from("chat_messages").update({
          status: "error", error: String(e),
        }).eq("id", stub.id);
        controller.enqueue(encoder.encode(formatSseEvent({
          event: "error", data: { message: String(e) },
        })));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Manual smoke test**

Continuing from Task 6's curl walkthrough — after `next:tail`, send the free-text:

```bash
curl -s -X POST http://localhost:3000/api/chat/morning/intake \
  -H "Content-Type: application/json" \
  -H "Cookie: ${COOKIE}" \
  -d '{"kind":"free_text","value":"feeling solid"}'
```

Expected: SSE stream with deltas + done event. Then call recommendation:

```bash
curl -s -X POST http://localhost:3000/api/chat/morning/recommendation \
  -H "Content-Type: application/json" \
  -H "Cookie: ${COOKIE}" \
  -d '{}'
```

Expected: SSE stream with the coach's plan. After done, `checkins.intake_state='delivered'`.

If WHOOP recovery is null today, recommendation returns 425. Test the skip path:

```bash
curl -s -X POST http://localhost:3000/api/chat/morning/recommendation \
  -H "Content-Type: application/json" \
  -H "Cookie: ${COOKIE}" \
  -d '{"skip_whoop":true}'
```

Expected: SSE stream with feel-only plan.

- [ ] **Step 4: Commit**

```bash
git add app/api/chat/morning/recommendation/route.ts
git commit -m "feat(api): morning recommendation endpoint

Sick path: templated REST message. Healthy path: Claude streams a
conversational rendering of buildDailyPlan output. Returns 425
(Too Early) when WHOOP recovery is null and skip_whoop is unset,
so the client can park and retry on focus / WHOOP sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: ChatPanel — kind filter on history GET

**Files:**
- Modify: `app/api/chat/messages/route.ts` — accept `kind` query param
- Modify: `components/chat/ChatPanel.tsx` — `mode` prop, pass kind to history GET, also include `kind`/`ui` in the SELECT

- [ ] **Step 1: Extend `/api/chat/messages` GET to accept `kind`**

In `app/api/chat/messages/route.ts`, find the GET handler. Update the SELECT and add the filter:

```ts
const url = new URL(req.url);
const before = url.searchParams.get("before");
const kindRaw = url.searchParams.get("kind") ?? "coach";
const kind = kindRaw === "morning_intake" ? "morning_intake" : "coach";
const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT);

let q = supabase
  .from("chat_messages")
  .select("id, role, content, status, error, model, kind, ui, created_at, updated_at")
  .eq("user_id", user.id)
  .eq("kind", kind)
  .order("created_at", { ascending: false })
  .limit(limit);
```

The output `ChatMessage[]` already has the new fields per Task 2's type extension; just include `kind` and `ui` from the row in the response mapping. Find where rows are mapped to the response and add:

```ts
const messages: ChatMessage[] = (rows ?? []).map((r) => ({
  id: r.id,
  role: r.role as ChatRole,
  content: r.content,
  status: r.status as ChatStatus,
  error: r.error,
  model: r.model,
  kind: (r.kind as "coach" | "morning_intake") ?? "coach",
  ui: (r.ui as MorningUI | null) ?? null,
  created_at: r.created_at,
  updated_at: r.updated_at,
  images: imagesByMessage[r.id] ?? [],
}));
```

Add the import at the top of the file:

```ts
import type { MorningUI } from "@/lib/data/types";
```

- [ ] **Step 2: Add `mode` prop to ChatPanel and thread kind into the history fetch**

In `components/chat/ChatPanel.tsx`, change the export signature:

```tsx
export default function ChatPanel({
  onClose,
  mode = "coach",
}: {
  onClose: () => void;
  mode?: "coach" | "morning_intake";
}) {
  // ...existing reducer setup...

  // Replace the load-history fetch (~line 100):
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/chat/messages?limit=50&kind=${mode}`);
      const json = (await res.json()) as { ok: boolean; messages?: ChatMessage[] };
      if (cancelled) return;
      if (json.ok && json.messages) {
        dispatch({ type: "loaded", messages: json.messages.slice().reverse() });
      } else {
        dispatch({ type: "loaded", messages: [] });
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [mode]);
```

And update the `loadOlder` URL similarly:

```tsx
const loadOlder = useCallback(async (beforeIso: string) => {
  if (!state.hasMoreOlder) return { added: 0 };
  const res = await fetch(`/api/chat/messages?limit=50&kind=${mode}&before=${encodeURIComponent(beforeIso)}`);
  // ...rest unchanged
}, [state.hasMoreOlder, mode]);
```

The optimistic stubs in `append_assistant_stub` need `kind` and `ui` fields now — extend the reducer's stub object:

```tsx
case "append_assistant_stub":
  return {
    ...state,
    inFlightAssistantId: action.id,
    messages: [
      ...state.messages,
      {
        id: action.id,
        role: "assistant",
        content: "",
        status: "streaming",
        error: null,
        model: null,
        kind: "coach",  // optimistic stub for free-form chat path; morning intake doesn't use this codepath
        ui: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        images: [],
      },
    ],
  };
```

Same fix for the `append_user` action's `tempMsg` and any other stub literals — add `kind: "coach", ui: null` to satisfy the type.

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Open `/`, click "Ask coach" — ChatPanel opens. Free-form chat history should load as before (no morning_intake messages bleed in). Send a message — works as before.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/messages/route.ts components/chat/ChatPanel.tsx
git commit -m "feat(chat): kind filter on history, mode prop on ChatPanel

GET /api/chat/messages accepts ?kind=coach|morning_intake (default: coach).
ChatPanel takes a mode prop and threads it through history fetches.
No UI changes yet for chips — that lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: ChatPanel — chip rendering + chip POST + WHOOP sync action

**Files:**
- Create: `components/chat/ChatChips.tsx` — chip-rendering component
- Modify: `components/chat/ChatPanel.tsx` — wire chips, add `useDailyLogs` polling for awaiting_whoop, add WHOOP-sync action handler

- [ ] **Step 1: Create `components/chat/ChatChips.tsx`**

```tsx
// components/chat/ChatChips.tsx
"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import type { MorningChip, MorningUI } from "@/lib/data/types";

export function ChatChips({
  ui,
  onSlotAnswer,
  onAction,
}: {
  ui: MorningUI;
  onSlotAnswer: (slot: string, value: string | number | string[]) => void;
  onAction: (action: "whoop_sync" | "skip_whoop" | "retry_recommendation") => void;
}) {
  const chips = ui.chips ?? [];
  const [selected, setSelected] = useState<Set<string | number>>(new Set());

  if (chips.length === 0) return null;

  // Multi-select: collect, then "Apply" button.
  if (ui.multi_select) {
    const slot = (chips[0] as { slot?: string }).slot ?? "";
    return (
      <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {chips.map((c) => {
          if (!isSlotChip(c)) return null;
          const on = selected.has(c.value);
          return (
            <button
              key={String(c.value)}
              type="button"
              onClick={() =>
                setSelected((s) => {
                  const next = new Set(s);
                  if (on) next.delete(c.value);
                  else next.add(c.value);
                  return next;
                })
              }
              style={chipStyle(on)}
            >
              {c.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onSlotAnswer(slot, Array.from(selected) as string[])}
          disabled={selected.size === 0}
          style={{
            ...chipStyle(true),
            background: selected.size === 0 ? COLOR.surfaceAlt : COLOR.accent,
            opacity: selected.size === 0 ? 0.5 : 1,
            marginLeft: "auto",
          }}
        >
          Apply
        </button>
      </div>
    );
  }

  // Single-select.
  return (
    <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
      {chips.map((c, i) => {
        if (isActionChip(c)) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => onAction(c.action)}
              style={chipStyle(false)}
            >
              {c.label}
            </button>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSlotAnswer(c.slot, c.value)}
            style={chipStyle(false)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: "999px",
    background: active ? COLOR.accent : COLOR.surfaceAlt,
    color: active ? "#fff" : COLOR.textStrong,
    border: "none",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
  };
}

function isActionChip(c: MorningChip): c is Extract<MorningChip, { action: string }> {
  return "action" in c;
}

function isSlotChip(c: MorningChip): c is Extract<MorningChip, { slot: string }> {
  return "slot" in c;
}
```

- [ ] **Step 2: Wire `ChatChips` into ChatPanel + add chip handlers**

In `components/chat/ChatPanel.tsx`, add imports:

```tsx
import { ChatChips } from "./ChatChips";
import { postSse } from "./sseClient";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { todayInUserTz } from "@/lib/time";
```

Add prop `userId: string` so the panel can hit user-scoped queries:

```tsx
export default function ChatPanel({
  onClose,
  mode = "coach",
  userId,
}: {
  onClose: () => void;
  mode?: "coach" | "morning_intake";
  userId: string;
}) {
```

Add the chip-answer handler inside the component (after existing `send` definition):

```tsx
const queryClient = useQueryClient();
const today = todayInUserTz();
const { data: todayLog } = useDailyLogs(userId, today, today, { enabled: mode === "morning_intake" });
const { data: todayCheckin } = useCheckin(userId, today);

// When morning intake mode mounts and there are no messages yet, kick off
// /start so the bot inserts the first scripted question.
useEffect(() => {
  if (mode !== "morning_intake") return;
  if (!state.loaded) return;
  if (state.messages.length > 0) return;
  void fetch("/api/chat/morning/intake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "start" }),
  }).then(async (res) => {
    // After start, refetch messages.
    if (res.ok) {
      const refresh = await fetch(`/api/chat/messages?limit=50&kind=${mode}`);
      const json = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
      if (json.ok && json.messages) {
        dispatch({ type: "loaded", messages: json.messages.slice().reverse() });
      }
    }
  });
}, [mode, state.loaded, state.messages.length]);

const onSlotAnswer = useCallback(
  async (slot: string, value: string | number | string[]) => {
    const res = await fetch("/api/chat/morning/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, value }),
    });
    const json = (await res.json()) as { ok: boolean; next?: string };
    // Refetch thread to pick up server's inserted assistant turn.
    const refresh = await fetch(`/api/chat/messages?limit=50&kind=${mode}`);
    const histJson = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
    if (histJson.ok && histJson.messages) {
      dispatch({ type: "loaded", messages: histJson.messages.slice().reverse() });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
    if (json.next === "tail") {
      // No-op: the latest assistant message will have allow_text:true; the
      // composer becomes visible automatically.
    }
  },
  [mode, queryClient, today, userId],
);

const onAction = useCallback(
  async (action: "whoop_sync" | "skip_whoop" | "retry_recommendation") => {
    if (action === "whoop_sync") {
      try {
        const res = await fetch("/api/whoop/sync", { method: "GET" });
        if (!res.ok) throw new Error(`http_${res.status}`);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.dailyLogs.range(userId, today, today),
        });
        // After invalidate, fire recommendation.
        await runRecommendation({ skip_whoop: false });
      } catch (e) {
        // Insert a server-side failure assistant turn for visibility.
        await fetch("/api/chat/morning/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "free_text", value: `(client: WHOOP sync failed: ${String(e)})` }),
        });
        const refresh = await fetch(`/api/chat/messages?limit=50&kind=${mode}`);
        const histJson = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
        if (histJson.ok && histJson.messages) {
          dispatch({ type: "loaded", messages: histJson.messages.slice().reverse() });
        }
      }
      return;
    }
    if (action === "skip_whoop") {
      await runRecommendation({ skip_whoop: true });
      return;
    }
    if (action === "retry_recommendation") {
      await runRecommendation({ skip_whoop: false });
      return;
    }
  },
  [mode, queryClient, today, userId],
);

const runRecommendation = useCallback(
  async (body: { skip_whoop: boolean }) => {
    // Stream via postSse. Reuses the same delta/done/error wire format.
    const tempId = `stub-${crypto.randomUUID()}`;
    dispatch({ type: "append_assistant_stub", id: tempId });
    try {
      for await (const ev of postSse("/api/chat/morning/recommendation", body)) {
        if (ev.type === "delta") {
          dispatch({ type: "append_delta", id: tempId, text: ev.text });
        } else if (ev.type === "done") {
          dispatch({ type: "replace_id", tempId, serverId: ev.message_id });
          dispatch({ type: "finalize_assistant", id: ev.message_id, status: "done" });
        } else if (ev.type === "error") {
          dispatch({ type: "finalize_assistant", id: tempId, status: "error", error: ev.message });
        }
      }
    } catch (e) {
      dispatch({ type: "finalize_assistant", id: tempId, status: "error", error: String(e) });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
  },
  [queryClient, today, userId],
);

// Auto-fire recommendation when state transitions to awaiting_whoop and
// today's log has recovery (cron arrived in background, or sync just landed).
useEffect(() => {
  if (mode !== "morning_intake") return;
  if (todayCheckin?.intake_state !== "awaiting_whoop") return;
  const log = todayLog?.[0];
  if (!log || log.recovery == null) return;
  void runRecommendation({ skip_whoop: false });
  // The recommendation route flips intake_state to 'delivered' so this
  // effect won't re-fire after success.
}, [mode, todayCheckin?.intake_state, todayLog, runRecommendation]);
```

- [ ] **Step 3: Render chips below the latest assistant message**

In ChatPanel's JSX, find where `<ChatThread>` is rendered. Wrap it with a sibling that renders the latest assistant message's `ui.chips`:

```tsx
{(() => {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant" || last.status !== "done") return null;
  if (!last.ui || (!last.ui.chips && !last.ui.allow_text)) return null;
  if (!last.ui.chips) return null; // allow_text without chips → composer handles it
  return <ChatChips ui={last.ui} onSlotAnswer={onSlotAnswer} onAction={onAction} />;
})()}
```

Hide the composer when `last.ui.chips` exists and `last.ui.allow_text` is false. Find where `<ChatComposer>` is rendered and wrap:

```tsx
{(() => {
  const last = state.messages[state.messages.length - 1];
  const hideComposer =
    mode === "morning_intake" &&
    last?.ui?.chips &&
    !last?.ui?.allow_text;
  if (hideComposer) return null;
  return <ChatComposer ... existing props ... />;
})()}
```

- [ ] **Step 4: useDailyLogs hook flag**

Open `lib/query/hooks/useDailyLogs.ts` and confirm it accepts an `enabled` option. If not, extend:

```ts
export function useDailyLogs(
  userId: string,
  from: string,
  to: string,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.range(userId, from, to),
    queryFn: () => fetchDailyLogsBrowser(userId, from, to),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}
```

(If the hook already takes options in a different shape, adapt to existing convention. The relevant call site only needs to gate the query when ChatPanel is in `coach` mode to avoid a wasted query.)

- [ ] **Step 5: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Manual smoke test**

```bash
npm run dev
```

Manually open ChatPanel in `morning_intake` mode (we don't have a UI trigger yet — temporarily edit TopNav to pass `mode="morning_intake"` for quick testing, or hit the start endpoint via curl first then open the panel). Tap chips through the full flow. Verify:
- Chips render below assistant turns.
- Tapping a chip POSTs and the next assistant turn appears.
- After the tail step, the composer becomes visible.
- After tail submission, the recommendation streams in.

Revert any temporary debugging changes before committing.

- [ ] **Step 7: Commit**

```bash
git add components/chat/ChatChips.tsx components/chat/ChatPanel.tsx lib/query/hooks/useDailyLogs.ts
git commit -m "feat(chat): chip rendering + WHOOP-sync action in ChatPanel

ChatChips renders ui.chips below the latest assistant turn (single-select
or multi-select with Apply). Slot taps POST to /api/chat/morning/intake
and refetch the thread. WHOOP-sync chip calls existing /api/whoop/sync
then auto-fires /api/chat/morning/recommendation. Auto-recommendation
also fires when intake_state=awaiting_whoop and todayLog.recovery arrives.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: ChatPanel — mode tab switcher + sickness link

**Files:**
- Modify: `components/chat/ChatPanel.tsx`

- [ ] **Step 1: Add tab switcher at the top of the panel**

In the panel JSX, find the header area (where the panel title and close button live). Add a tab switcher next to (or below) the title:

```tsx
{/* Mode tabs */}
<div style={{ display: "flex", gap: "4px", padding: "4px 12px 0" }}>
  {(["coach", "morning_intake"] as const).map((m) => {
    const label = m === "coach" ? "Coach" : "Morning";
    const active = currentMode === m;
    return (
      <button
        key={m}
        type="button"
        onClick={() => setCurrentMode(m)}
        style={{
          padding: "6px 14px",
          borderRadius: "999px",
          background: active ? COLOR.accentSoft : "transparent",
          color: active ? COLOR.accent : COLOR.textMid,
          border: "none",
          fontSize: "12px",
          fontWeight: active ? 700 : 500,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  })}
</div>
```

Convert the `mode` prop into local state with the prop as initial value (so the tab switcher works while the prop still pre-selects on first open):

```tsx
const [currentMode, setCurrentMode] = useState<"coach" | "morning_intake">(mode);
```

Replace all references to `mode` *inside the component* with `currentMode` (the existing `useEffect` deps, the history fetch URL, the chip auto-start, etc.). The prop `mode` is now just a default.

- [ ] **Step 2: Add the sickness link below the composer**

Find the composer area. Render the link only when `currentMode === "morning_intake"` and the user is not currently sick:

```tsx
{currentMode === "morning_intake" && !todayCheckin?.sick && (
  <div style={{ padding: "8px 14px 10px", textAlign: "center" }}>
    <button
      type="button"
      onClick={async () => {
        const ok = window.confirm(
          "Flag yourself as sick? This locks today's plan to REST. (Undo on the Log page.)",
        );
        if (!ok) return;
        const res = await fetch("/api/chat/morning/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "declare_sick" }),
        });
        if (res.ok) {
          const refresh = await fetch(`/api/chat/messages?limit=50&kind=morning_intake`);
          const json = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
          if (json.ok && json.messages) {
            dispatch({ type: "loaded", messages: json.messages.slice().reverse() });
          }
          queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
        }
      }}
      style={{
        background: "none",
        border: "none",
        color: COLOR.textFaint,
        fontSize: "11px",
        textDecoration: "underline",
        cursor: "pointer",
      }}
    >
      I'm coming down with something
    </button>
  </div>
)}
```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Open ChatPanel. Verify:
- Two tabs at top: "Coach" / "Morning".
- Switching tabs reloads the thread for that kind.
- "I'm coming down with something" link visible only in Morning tab when not sick.
- Tap link → confirm dialog → bot asks for notes → reply → REST message + intake_state='delivered'.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add components/chat/ChatPanel.tsx
git commit -m "feat(chat): mode tabs + I'm-sick link in ChatPanel

Tab switcher between Coach / Morning threads. Sickness link below
composer in morning mode posts {kind:'declare_sick'} after confirm,
flipping today to REST.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: TopNav + Fab `chatState` refactor

**Files:**
- Modify: `components/layout/TopNav.tsx` — `chatState` shape, pass `userId`/`mode` to ChatPanel
- Modify: `components/layout/Fab.tsx` — same shape, FAB tap opens `'coach'` mode

- [ ] **Step 1: TopNav — replace `chatOpen: boolean` with `chatState`**

In `components/layout/TopNav.tsx`, replace the `chatOpen` state:

```tsx
type ChatState = { open: boolean; mode: "coach" | "morning_intake" };
const [chatState, setChatState] = useState<ChatState>({ open: false, mode: "coach" });
```

Update the FAB sheet "Ask coach" button:

```tsx
onClick={() => {
  setMenuOpen(false);
  setChatState({ open: true, mode: "coach" });
}}
```

Update the conditional render at the bottom:

```tsx
{chatState.open && (
  <ChatPanel
    mode={chatState.mode}
    userId={userId}
    onClose={() => setChatState((s) => ({ ...s, open: false }))}
  />
)}
```

The component now needs `userId` to pass to ChatPanel. Promote it via props:

```tsx
export function TopNav({ userId }: { userId: string }) {
  // ...existing body...
}
```

Find the parent that mounts `<TopNav />` (likely `app/layout.tsx`) and update to pass `userId`. If layout already fetches the user via `createSupabaseServerClient()`, just add `userId={user?.id ?? ""}`. If not, fetch it:

```tsx
// app/layout.tsx — only if not already fetching user
import { createSupabaseServerClient } from "@/lib/supabase/server";
// ...
const supabase = await createSupabaseServerClient();
const { data: { user } } = await supabase.auth.getUser();
// ...
<TopNav userId={user?.id ?? ""} />
```

If `userId` is empty (logged-out state), TopNav still renders but ChatPanel won't open meaningfully — login redirects in pages handle the auth gating.

- [ ] **Step 2: Fab — same `chatState` shape**

Apply the equivalent change in `components/layout/Fab.tsx`. FAB-driven open uses `mode: "coach"`. Add `userId` prop, threaded down from the parent.

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/layout/TopNav.tsx components/layout/Fab.tsx app/layout.tsx
git commit -m "refactor(layout): chatState shape, userId threading

TopNav and Fab carry {open, mode} for ChatPanel. userId flows from
layout down so ChatPanel can use TanStack Query hooks (useCheckin,
useDailyLogs) for the morning mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: `MorningTrigger` — auto-open on first app-open of day

**Files:**
- Create: `components/morning/MorningTrigger.tsx`
- Modify: `components/layout/TopNav.tsx` — mount trigger, wire its callback to `setChatState`

- [ ] **Step 1: Create `components/morning/MorningTrigger.tsx`**

```tsx
// components/morning/MorningTrigger.tsx
//
// Invisible client component. On mount, queries today + yesterday checkins
// and decides whether to auto-open ChatPanel in morning_intake mode. Uses
// sessionStorage to suppress re-pop on intra-session navigation.

"use client";

import { useEffect } from "react";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { todayInUserTz } from "@/lib/time";
import { decideIntakeAction } from "@/lib/morning/state";

const SUPPRESS_KEY_PREFIX = "morningHandled-";

function isoMinusDays(iso: string, days: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

export function MorningTrigger({
  userId,
  onShouldOpen,
}: {
  userId: string;
  onShouldOpen: () => void;
}) {
  const today = todayInUserTz();
  const yesterday = isoMinusDays(today, 1);

  const { data: todayCheckin, isLoading: tLoading } = useCheckin(userId, today);
  const { data: yesterdayCheckin, isLoading: yLoading } = useCheckin(userId, yesterday);

  useEffect(() => {
    if (!userId) return;
    if (tLoading || yLoading) return;

    const supKey = SUPPRESS_KEY_PREFIX + today;
    if (typeof window !== "undefined" && window.sessionStorage.getItem(supKey)) {
      return; // already handled this session
    }

    const decision = decideIntakeAction(
      yesterdayCheckin ? { sick: yesterdayCheckin.sick } : null,
      todayCheckin ? { intake_state: todayCheckin.intake_state } : null,
    );

    if (decision.action === "skip") {
      // Mark suppressed so further nav doesn't even consider re-checking.
      window.sessionStorage.setItem(supKey, "1");
      return;
    }

    // Open and mark suppressed for the rest of the session.
    window.sessionStorage.setItem(supKey, "1");
    onShouldOpen();
  }, [userId, today, tLoading, yLoading, todayCheckin, yesterdayCheckin, onShouldOpen]);

  return null;
}
```

- [ ] **Step 2: Mount in TopNav**

In `components/layout/TopNav.tsx`, import:

```tsx
import { MorningTrigger } from "@/components/morning/MorningTrigger";
```

Mount inside the header (anywhere; it returns null):

```tsx
<MorningTrigger
  userId={userId}
  onShouldOpen={() => setChatState({ open: true, mode: "morning_intake" })}
/>
```

Mobile devices that don't render TopNav (the existing `hidden md:flex` class) — mount the trigger from `Fab.tsx` too with the same callback shape, so phones still get the auto-open.

In `components/layout/Fab.tsx`:

```tsx
import { MorningTrigger } from "@/components/morning/MorningTrigger";
// ...
<MorningTrigger
  userId={userId}
  onShouldOpen={() => setChatState({ open: true, mode: "morning_intake" })}
/>
```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test — full happy path**

```bash
npm run dev
```

In Supabase, manually delete today's `checkins` row (or set `intake_state='pending'`) and clear browser sessionStorage. Refresh `/`.

Expected:
- ChatPanel auto-opens in Morning mode within ~1 second.
- First scripted question appears with chips.
- Tap through all chip slots.
- Composer opens for the free-text tail.
- After submitting tail, recommendation streams in (or parks with WHOOP-sync chip if recovery is null).
- After delivery, refreshing the page does NOT reopen the panel (sessionStorage suppression + intake_state='delivered').

Bonus: clear sessionStorage and reload — also does not reopen because intake_state is delivered.

Bonus: in another browser, clear cookies, log in, do the same flow but tap "I'm coming down with something". Verify the sickness path.

- [ ] **Step 5: Commit**

```bash
git add components/morning/MorningTrigger.tsx components/layout/TopNav.tsx components/layout/Fab.tsx
git commit -m "feat(morning): auto-open ChatPanel on first app-open of day

MorningTrigger mounts in TopNav + Fab. On mount, queries today and
yesterday checkins, calls decideIntakeAction, opens the panel in
morning_intake mode if the decision is 'open'. sessionStorage suppresses
re-pop on intra-session navigation; intake_state='delivered' suppresses
across sessions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Polish — recommendation retry, awaiting-WHOOP polling, copy

**Files:**
- Modify: `app/api/chat/morning/recommendation/route.ts` — emit retry chip on error
- Modify: `components/chat/ChatPanel.tsx` — 5-min polling while awaiting_whoop
- Modify: `lib/morning/script.ts` — copy refinements

- [ ] **Step 1: Server emits a retry chip when Claude streaming errors**

In `app/api/chat/morning/recommendation/route.ts`, in the `deliverWithClaude` catch block, after marking the stub as error, also insert a follow-up assistant turn with a `retry_recommendation` chip:

```ts
} catch (e) {
  await sr.from("chat_messages").update({
    status: "error", error: String(e),
  }).eq("id", stub.id);

  // Insert a retry chip so the user has a path forward.
  await sr.from("chat_messages").insert({
    user_id: userId,
    role: "assistant",
    content: "Recommendation generation failed. Tap to retry.",
    status: "done",
    kind: "morning_intake",
    ui: { chips: [{ label: "Retry", action: "retry_recommendation" }] },
  });

  controller.enqueue(encoder.encode(formatSseEvent({
    event: "error", data: { message: String(e) },
  })));
  controller.close();
}
```

- [ ] **Step 2: ChatPanel — poll dailyLogs every 5 min while awaiting_whoop**

In `components/chat/ChatPanel.tsx`, the `useDailyLogs` call should refetch periodically when `intake_state='awaiting_whoop'`. Add a `refetchInterval` option:

```tsx
const { data: todayLog } = useDailyLogs(userId, today, today, {
  enabled: currentMode === "morning_intake",
  refetchInterval: todayCheckin?.intake_state === "awaiting_whoop" ? 5 * 60 * 1000 : false,
});
```

Update `lib/query/hooks/useDailyLogs.ts` to forward this option:

```ts
export function useDailyLogs(
  userId: string,
  from: string,
  to: string,
  opts: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.range(userId, from, to),
    queryFn: () => fetchDailyLogsBrowser(userId, from, to),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval ?? false,
  });
}
```

(If the hook signature already differs, follow the existing convention.)

- [ ] **Step 3: Tighten copy**

Open `lib/morning/script.ts` and tighten any prompts that read clunkily after the smoke test. (Examples: change "Good morning. How does your body feel today?" if it lands on a phrasing you prefer; reword `FREE_TEXT_TAIL_PROMPT` etc.)

This is taste-driven; treat it as the catch-all for prompt edits surfaced during manual testing.

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: End-to-end smoke test (full coverage)**

Run through each path manually:

1. **Healthy fresh day, WHOOP synced**: delete today checkins, clear sessionStorage, open app → bot pops → fill chips → free-text tail → recommendation streams.
2. **Healthy fresh day, WHOOP not synced**: same setup but ensure today's `daily_logs.recovery` is null. After tail → assistant says "WHOOP hasn't synced yet" with Sync chip. Tap Sync → if successful, recommendation streams. If WHOOP backend is unavailable, tap Skip → feel-only recommendation.
3. **Sick declaration mid-flow**: open Morning tab → tap "I'm coming down with something" → confirm → bot asks "what's going on" → reply → REST message + delivered.
4. **Carry-forward sickness**: set yesterday `sick=true`, today no row. Open app → bot asks "Still feeling sick?". Tap Yes → REST + delivered. Or tap No → normal flow proceeds inline.
5. **Resume mid-intake**: complete 2 of 7 chip questions, close panel, reload page. Bot should reopen to the next pending question (latest assistant message remembers state via DB).
6. **Already delivered**: complete a flow, reload page → bot does NOT reopen. Open ChatPanel manually → Morning tab shows today's history; Coach tab is its own thread.

Document any issues in a follow-up commit; the goal of this task is to lock in retry+polling and clean copy, not to fix any latent bugs (those become their own commits).

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/morning/recommendation/route.ts components/chat/ChatPanel.tsx lib/query/hooks/useDailyLogs.ts lib/morning/script.ts
git commit -m "feat(morning): retry chip, awaiting-WHOOP polling, copy polish

On recommendation error, insert a retry chip turn so the user has
a path forward. While intake_state='awaiting_whoop', useDailyLogs
refetches every 5 min so cron-arrived WHOOP triggers the
recommendation without requiring user interaction. Misc copy edits
in the script module.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** — walking each spec section:

- ✅ State machine on `checkins.intake_state` → Tasks 1, 4, 6, 7.
- ✅ Schema migration with all new fields → Task 1.
- ✅ Type mirrors in `lib/data/types.ts` and `lib/chat/types.ts` → Task 2.
- ✅ Server-side state machine (single source of truth) → Tasks 6, 7.
- ✅ Free-text dispatch (LLM tail vs. sickness notes) — `awaiting_sickness_notes` state and dispatch logic → Task 6.
- ✅ Phase 1 scripted slots: readiness, energy, mood, soreness gate+areas+severity, fatigue, bloating → Task 4 (script.ts) + Task 6 (route).
- ✅ Phase 1 LLM tail with `update_intake_slots` tool → Task 6.
- ✅ Phase 2 recommendation: sick path templated, healthy path Claude → Task 7.
- ✅ AWAITING_WHOOP variant + Sync WHOOP chip + Skip-WHOOP fallback → Tasks 7, 9, 13.
- ✅ Sickness entry from healthy + carry-forward "still sick?" + exit → Tasks 6, 10.
- ✅ Score impact: rewritten `getIntensityMode`, energy nudge → Task 3.
- ✅ Manual form retains all new fields + auto-sets `intake_state='delivered'` when fully filled → Task 5.
- ✅ ChatPanel with `mode` prop, kind filter, chip rendering, mode tabs, sickness link → Tasks 8, 9, 10.
- ✅ MorningTrigger auto-open + sessionStorage suppression → Task 12.
- ✅ TopNav/Fab `chatState` refactor → Task 11.
- ✅ Edge cases — timezone rollover (server stamps `today` once per call), dismissal mid-intake (resume_feel mode), 409 on out-of-state-machine answers, recommendation-fail retry chip → Tasks 6, 7, 12, 13.
- ✅ Build sequence matches the spec's recommended order.

**2. Placeholder scan** — no "TBD", "TODO", "implement later" text in any task. Code blocks are complete and self-contained. Verification commands are concrete.

**3. Type consistency** — checked:
- `Checkin` (the `Pick`-narrowed view) and `CheckinRow` (full DB shape) are distinct and used appropriately.
- `IntakeState`, `Fatigue`, `SorenessSeverity` exported from `lib/data/types.ts` once.
- `MorningChip`/`MorningUI` defined in `lib/data/types.ts`, re-imported by `lib/chat/types.ts` and `components/chat/ChatChips.tsx`.
- `FeelInput` extension fields (`sick`, `fatigue`, `sorenessAreas`, `sorenessSeverity`) match across `lib/coach/readiness.ts` (Task 3), the recommendation route (Task 7), and TodayClient/StrengthClient (Task 3).
- `SlotKey` from `lib/morning/script.ts` matches the route's slot dispatch (Task 6).
- `decideIntakeAction` signature (Task 4) matches MorningTrigger's call (Task 12).

**4. Other risks flagged for the implementing engineer:**
- The two `useEffect` calls inside ChatPanel that auto-fire (one for `kind='start'`, one for awaiting_whoop) need the suppression guard — they re-run on every dependency change. The `state.messages.length > 0` guard handles the start case; the recommendation case is guarded by intake_state transitioning away after success. If either misfires, the dispatch reducer will see duplicates — verify in smoke test step 5.
- The legacy `soreness` text column is preserved per spec but no longer drives math. The LogForm step (Task 5) doesn't write to it from the new chip pickers — the legacy free-text input was already the existing form's "Soreness notes" field and stays untouched. Confirm during smoke test.
- `runChatStream` (free-form coach) and the new morning routes use different message-construction paths intentionally; no shared state. The `chat_messages.kind` column is the only thing keeping them apart.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-08-morning-intake-bot.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
