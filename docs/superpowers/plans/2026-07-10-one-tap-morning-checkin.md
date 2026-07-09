# One-Tap Morning Check-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 8-turn sequential morning intake chat with a single check-in card — 1 tap on baseline mornings ("Same as usual"), ~3 taps on off mornings (Adjust → toggle chips → Submit).

**Architecture:** The card is delivered as one assistant `chat_messages` turn whose `ui` jsonb carries a new `morning_form` variant with server-computed personal defaults embedded. Two new route body kinds (`all_good`, `batch`) write the whole `checkins` row in one shot; the sequential slot loop, the forced free-text tail, and the unused energy/mood questions are deleted. The card renders in ChatPanel's bottom slot (where `ChatChips` renders today), interactive only while it is the latest message.

**Tech Stack:** Next.js 15 App Router, Supabase (service-role writes), zod v4, Anthropic SDK (non-streaming ack call), vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-one-tap-morning-checkin-design.md`

## Global Constraints

- Branch: `feat/one-tap-morning-checkin` (already created; commits auto-push — never commit to main).
- Migration slot **0050**, filename `supabase/migrations/0050_intake_source.sql` — version prefixes must stay unique and uniform-width; apply via `supabase db push`.
- `IntakeState` values do NOT change. `decideIntakeAction` in `lib/morning/state.ts` is untouched.
- Untouched flows (verify no behavior change): `declare_sick`, `handleSicknessNotes`, still-sick chip handling (except its "No" branch now inserts the card), `UPDATE_INTAKE_SLOTS_TOOL`, recovery-gate `SYNC_RECOVERY_PROMPT` parking, recommendation auto-fire, brief assembly, the manual Log form (`components/log/LogForm.tsx`).
- Defaults: median readiness + modal fatigue over last 28 days of explicit rows (`intake_source != 'all_good'`), minimum 7 rows, fallback `{readiness: 7, fatigue: 'some'}`. Soreness/bloating/sick always default none/false.
- Verification per CLAUDE.md: `npm run typecheck` + `npx vitest run` + `npm run build` (no render-test harness — hooks bugs only surface in prod build). No linter.
- Two spec amendments are folded into Task 4 (the plan deviates deliberately): (1) the notes ack is a **non-streaming** Anthropic call (the SSE feel-tail path dies with the forced tail; a 1–2 sentence ack doesn't need streaming); (2) the card renders in **ChatPanel's bottom slot**, not ChatThread (that is where the morning intake UI actually lives today).

---

### Task 1: Migration 0050 + type updates

**Files:**
- Create: `supabase/migrations/0050_intake_source.sql`
- Modify: `lib/data/types.ts` (CheckinRow ~line 316-335, MorningUI ~line 347-355)

**Interfaces:**
- Produces: `CheckinRow.intake_source: IntakeSource | null`, `IntakeSource = 'legacy_chips' | 'all_good' | 'form'`, `MorningUI.morning_form?: { defaults: { readiness: number; fatigue: FatigueLevel } }`. Later tasks import `IntakeSource` and read/write `ui.morning_form`.

- [ ] **Step 1: Write the migration**

```sql
-- 0050_intake_source.sql
--
-- One-tap morning check-in (spec 2026-07-10): provenance marker for how the
-- day's checkin row was reported. Used by the defaults engine to exclude
-- one-tap ('all_good') days from the personal-baseline median/mode — without
-- this exclusion, defaults would feed the median that feeds the defaults.
--
-- NULL (all historical rows) counts as explicitly answered.
-- 'legacy_chips' is reserved for completeness; new writes use 'all_good'/'form'.

alter table checkins add column intake_source text
  check (intake_source is null or intake_source in ('legacy_chips','all_good','form'));

comment on column checkins.intake_source is
  'How the row was reported: all_good = one-tap defaults, form = adjusted form, legacy_chips = pre-0050 sequential chat. NULL = historical (counts as explicit for defaults).';
```

- [ ] **Step 2: Apply it**

Run: `cd "/Users/abdelouahedelbied/Health app" && supabase db push`
Expected: `0050_intake_source.sql` listed and applied without error.

- [ ] **Step 3: Update types**

In `lib/data/types.ts`, above `CheckinRow`:

```ts
export type IntakeSource = "legacy_chips" | "all_good" | "form";
```

Inside `CheckinRow`, after `intake_state: IntakeState;`:

```ts
  /** 0050: how the row was reported. NULL = historical / manual Log form
   *  (counts as explicit for the defaults engine). */
  intake_source: IntakeSource | null;
```

Inside `MorningUI` (after `allow_text?`):

```ts
  /** One-tap morning check-in card (spec 2026-07-10). Present on the single
   *  assistant turn that carries the form; defaults are embedded at card
   *  creation so what the athlete sees is exactly what all_good writes. */
  morning_form?: { defaults: { readiness: number; fatigue: FatigueLevel } };
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean (additive changes only).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0050_intake_source.sql lib/data/types.ts
git commit -m "feat(morning): migration 0050 intake_source + morning_form ui type"
```

---

### Task 2: Defaults engine (`lib/morning/defaults.ts`)

**Files:**
- Create: `lib/morning/defaults.ts`
- Test: `lib/morning/__tests__/defaults.test.ts` (new directory — vitest glob `lib/**/__tests__/**/*.test.ts` picks it up)

**Interfaces:**
- Produces:
  - `export type MorningDefaults = { readiness: number; fatigue: FatigueLevel }`
  - `export type DefaultsInputRow = { readiness: number | null; fatigue: FatigueLevel | null; intake_source: string | null }`
  - `export function computeMorningDefaults(rows: DefaultsInputRow[]): MorningDefaults`
  - `export const DEFAULTS_FALLBACK: MorningDefaults` (`{ readiness: 7, fatigue: "some" }`)
- Task 4's route calls `computeMorningDefaults` with the last 28 days of checkins.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/morning/__tests__/defaults.test.ts
import { describe, it, expect } from "vitest";
import {
  computeMorningDefaults,
  DEFAULTS_FALLBACK,
  type DefaultsInputRow,
} from "@/lib/morning/defaults";

function row(
  readiness: number | null,
  fatigue: DefaultsInputRow["fatigue"] = "some",
  intake_source: string | null = null,
): DefaultsInputRow {
  return { readiness, fatigue, intake_source };
}

describe("computeMorningDefaults", () => {
  it("falls back below 7 explicit rows", () => {
    expect(computeMorningDefaults([])).toEqual(DEFAULTS_FALLBACK);
    expect(
      computeMorningDefaults([row(3), row(3), row(3), row(3), row(3), row(3)]),
    ).toEqual(DEFAULTS_FALLBACK);
  });

  it("returns median readiness (odd count)", () => {
    const rows = [row(4), row(5), row(6), row(7), row(8), row(9), row(10)];
    expect(computeMorningDefaults(rows).readiness).toBe(7);
  });

  it("returns rounded mid-average readiness (even count)", () => {
    const rows = [row(4), row(5), row(6), row(7), row(8), row(9), row(9), row(10)];
    // middles are 7 and 8 → round(7.5) = 8
    expect(computeMorningDefaults(rows).readiness).toBe(8);
  });

  it("returns modal fatigue", () => {
    const rows = [
      row(7, "none"), row(7, "none"), row(7, "heavy"),
      row(7, "some"), row(7, "some"), row(7, "some"), row(7, "some"),
    ];
    expect(computeMorningDefaults(rows).fatigue).toBe("some");
  });

  it("tie-breaks fatigue toward some, then none, then heavy", () => {
    const tied = [
      row(7, "none"), row(7, "none"), row(7, "none"),
      row(7, "some"), row(7, "some"), row(7, "some"),
      row(7, "heavy"),
    ];
    expect(computeMorningDefaults(tied).fatigue).toBe("some");
    const noneVsHeavy = [
      row(7, "none"), row(7, "none"), row(7, "none"),
      row(7, "heavy"), row(7, "heavy"), row(7, "heavy"),
      row(7, "some"),
    ];
    // none: 3, heavy: 3, some: 1 → tie between none/heavy → 'none'
    expect(computeMorningDefaults(noneVsHeavy).fatigue).toBe("none");
  });

  it("excludes all_good rows (feedback-loop guard)", () => {
    const rows = [
      // 7 explicit rows around 5
      row(5), row(5), row(5), row(5), row(5), row(5), row(5),
      // 20 one-tap rows at 9 — must not drag the median
      ...Array.from({ length: 20 }, () => row(9, "none", "all_good")),
    ];
    const d = computeMorningDefaults(rows);
    expect(d.readiness).toBe(5);
    expect(d.fatigue).toBe("some");
  });

  it("excludes rows with null readiness from the explicit count", () => {
    const rows = [
      row(null), row(null), row(null), row(null),
      row(6), row(6), row(6), row(6), row(6), row(6),
    ];
    // only 6 rows with readiness → fallback
    expect(computeMorningDefaults(rows)).toEqual(DEFAULTS_FALLBACK);
  });

  it("treats null intake_source (historical) and 'form' as explicit", () => {
    const rows = [
      row(6, "heavy", null), row(6, "heavy", "form"), row(6, "heavy", null),
      row(6, "heavy", "form"), row(6, "heavy", null), row(6, "heavy", "form"),
      row(6, "heavy", "legacy_chips"),
    ];
    expect(computeMorningDefaults(rows)).toEqual({ readiness: 6, fatigue: "heavy" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/morning/__tests__/defaults.test.ts`
Expected: FAIL — cannot resolve `@/lib/morning/defaults`.

- [ ] **Step 3: Implement**

```ts
// lib/morning/defaults.ts
//
// Pure defaults engine for the one-tap morning check-in (spec 2026-07-10).
// "Same as usual" writes the athlete's personal baseline, computed from the
// last 28 days of EXPLICITLY answered checkins. One-tap ('all_good') rows are
// excluded so defaults never feed the median that feeds the defaults.

import type { FatigueLevel } from "@/lib/data/types";

export type MorningDefaults = { readiness: number; fatigue: FatigueLevel };

export type DefaultsInputRow = {
  readiness: number | null;
  fatigue: FatigueLevel | null;
  intake_source: string | null;
};

export const DEFAULTS_FALLBACK: MorningDefaults = { readiness: 7, fatigue: "some" };

const MIN_EXPLICIT_ROWS = 7;

/** Tie-break order for the fatigue mode. 'some' first: it is the observed
 *  baseline for this athlete class and the middle of the scale — a 'none'
 *  default would systematically overstate freshness on one-tap days. */
const FATIGUE_TIE_ORDER: FatigueLevel[] = ["some", "none", "heavy"];

export function computeMorningDefaults(rows: DefaultsInputRow[]): MorningDefaults {
  const explicit = rows.filter(
    (r) => r.intake_source !== "all_good" && r.readiness != null,
  );
  if (explicit.length < MIN_EXPLICIT_ROWS) return DEFAULTS_FALLBACK;

  const sorted = explicit.map((r) => r.readiness as number).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const readiness =
    sorted.length % 2 === 1
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

  const counts = new Map<FatigueLevel, number>();
  for (const r of explicit) {
    if (r.fatigue) counts.set(r.fatigue, (counts.get(r.fatigue) ?? 0) + 1);
  }
  let fatigue: FatigueLevel = DEFAULTS_FALLBACK.fatigue;
  let best = -1;
  for (const level of FATIGUE_TIE_ORDER) {
    const c = counts.get(level) ?? 0;
    if (c > best) {
      best = c;
      fatigue = level;
    }
  }

  return { readiness, fatigue };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/morning/__tests__/defaults.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/morning/defaults.ts lib/morning/__tests__/defaults.test.ts
git commit -m "feat(morning): pure defaults engine for one-tap check-in"
```

---

### Task 3: Batch schema + helpers (`lib/morning/batch.ts`)

**Files:**
- Create: `lib/morning/batch.ts`
- Test: `lib/morning/__tests__/batch.test.ts`

**Interfaces:**
- Consumes: `SORENESS_AREAS` from `lib/morning/script.ts` (exists, unchanged).
- Produces:
  - `export const BatchBodySchema` — zod schema for `{kind:'batch', values, notes?}`
  - `export type BatchValues` — inferred values shape
  - `export function columnsFromBatch(values: BatchValues): Partial<CheckinRow>` — maps values → checkin columns (dedupes areas; does NOT set `sick`/`intake_state`/`intake_source` — the route owns those)
  - `export function formatBatchReply(values: BatchValues, notes: string | null): string` — deterministic user-reply summary

- [ ] **Step 1: Write the failing tests**

```ts
// lib/morning/__tests__/batch.test.ts
import { describe, it, expect } from "vitest";
import {
  BatchBodySchema,
  columnsFromBatch,
  formatBatchReply,
  type BatchValues,
} from "@/lib/morning/batch";

const base: BatchValues = {
  readiness: 7,
  fatigue: "some",
  soreness_areas: [],
  soreness_severity: null,
  bloating: false,
  sick: false,
};

describe("BatchBodySchema", () => {
  it("accepts a valid clean-day body", () => {
    const r = BatchBodySchema.safeParse({ kind: "batch", values: base });
    expect(r.success).toBe(true);
  });

  it("accepts soreness with severity", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: { ...base, soreness_areas: ["legs", "back"], soreness_severity: "mild" },
      notes: "tight from Tuesday",
    });
    expect(r.success).toBe(true);
  });

  it("rejects soreness areas without severity", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: { ...base, soreness_areas: ["legs"], soreness_severity: null },
    });
    expect(r.success).toBe(false);
  });

  it("rejects severity without areas", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: { ...base, soreness_severity: "sharp" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range readiness and unknown areas", () => {
    expect(
      BatchBodySchema.safeParse({ kind: "batch", values: { ...base, readiness: 11 } }).success,
    ).toBe(false);
    expect(
      BatchBodySchema.safeParse({
        kind: "batch",
        values: { ...base, soreness_areas: ["neck"], soreness_severity: "mild" },
      }).success,
    ).toBe(false);
  });

  it("rejects notes over 2000 chars", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: base,
      notes: "x".repeat(2001),
    });
    expect(r.success).toBe(false);
  });
});

describe("columnsFromBatch", () => {
  it("maps and dedupes", () => {
    const cols = columnsFromBatch({
      ...base,
      readiness: 5,
      fatigue: "heavy",
      soreness_areas: ["legs", "legs", "back"],
      soreness_severity: "sharp",
      bloating: true,
    });
    expect(cols).toEqual({
      readiness: 5,
      fatigue: "heavy",
      soreness_areas: ["legs", "back"],
      soreness_severity: "sharp",
      bloating: true,
    });
    expect("sick" in cols).toBe(false);
    expect("intake_state" in cols).toBe(false);
  });
});

describe("formatBatchReply", () => {
  it("renders a clean day", () => {
    expect(formatBatchReply(base, null)).toBe("Feel 7 · some fatigue");
  });

  it("renders deviations and notes", () => {
    const s = formatBatchReply(
      {
        ...base,
        readiness: 5,
        fatigue: "heavy",
        soreness_areas: ["legs", "back"],
        soreness_severity: "sharp",
        bloating: true,
        sick: true,
      },
      "rough night",
    );
    expect(s).toBe(
      "Feel 5 · heavy fatigue · sore: legs, back (sharp) · bloated · feeling sick — rough night",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/morning/__tests__/batch.test.ts`
Expected: FAIL — cannot resolve `@/lib/morning/batch`.

- [ ] **Step 3: Implement**

```ts
// lib/morning/batch.ts
//
// Zod schema + pure helpers for the one-shot morning check-in form submit
// (spec 2026-07-10). The route validates with BatchBodySchema, writes columns
// via columnsFromBatch, and renders the visible user reply via formatBatchReply.

import { z } from "zod";
import type { CheckinRow } from "@/lib/data/types";
import { SORENESS_AREAS } from "@/lib/morning/script";

const BatchValuesSchema = z
  .object({
    readiness: z.number().int().min(1).max(10),
    fatigue: z.enum(["none", "some", "heavy"]),
    soreness_areas: z.array(z.enum(SORENESS_AREAS)).max(SORENESS_AREAS.length),
    soreness_severity: z.enum(["mild", "sharp"]).nullable(),
    bloating: z.boolean(),
    sick: z.boolean(),
  })
  .refine(
    (v) =>
      v.soreness_areas.length === 0
        ? v.soreness_severity === null
        : v.soreness_severity !== null,
    { message: "soreness_severity is required iff soreness_areas is non-empty" },
  );

export type BatchValues = z.infer<typeof BatchValuesSchema>;

export const BatchBodySchema = z.object({
  kind: z.literal("batch"),
  values: BatchValuesSchema,
  notes: z.string().max(2000).optional(),
});

/** Maps validated form values → checkin columns. Deliberately excludes
 *  `sick`, `intake_state`, `intake_source`, and notes — the route owns the
 *  sick short-circuit and state transitions. */
export function columnsFromBatch(values: BatchValues): Partial<CheckinRow> {
  const areas = Array.from(new Set(values.soreness_areas));
  return {
    readiness: values.readiness,
    fatigue: values.fatigue,
    soreness_areas: areas,
    soreness_severity: areas.length > 0 ? values.soreness_severity : null,
    bloating: values.bloating,
  };
}

/** Deterministic user-reply line for the chat thread, e.g.
 *  "Feel 5 · heavy fatigue · sore: legs, back (sharp) · bloated — rough night" */
export function formatBatchReply(values: BatchValues, notes: string | null): string {
  const parts = [`Feel ${values.readiness}`, `${values.fatigue} fatigue`];
  const areas = Array.from(new Set(values.soreness_areas));
  if (areas.length > 0) parts.push(`sore: ${areas.join(", ")} (${values.soreness_severity})`);
  if (values.bloating) parts.push("bloated");
  if (values.sick) parts.push("feeling sick");
  const head = parts.join(" · ");
  return notes ? `${head} — ${notes}` : head;
}
```

Note: `z.enum(SORENESS_AREAS)` accepts the `as const` readonly tuple in zod v4. If the typecheck complains, use `z.enum([...SORENESS_AREAS])`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/morning/__tests__/batch.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/morning/batch.ts lib/morning/__tests__/batch.test.ts
git commit -m "feat(morning): batch submit schema + reply formatting helpers"
```

---

### Task 4: Server route rework + sequential-flow deletion + spec amendment

**Files:**
- Modify: `app/api/chat/morning/intake/route.ts` (major rework)
- Modify: `lib/morning/script.ts` (delete `SLOTS`, `SLOT_BY_KEY`, `SlotDef`, `SlotChip` usage there, `FREE_TEXT_TAIL_PROMPT`; add `MORNING_FORM_PROMPT`; keep `SORENESS_AREAS`, `STILL_SICK_*`, `SICKNESS_NOTES_PROMPT`, `REST_DAY_*`, `SYNC_RECOVERY_*`)
- Modify: `lib/morning/state.ts` (delete `nextSlot`, `nextIntakeState`, `SlotProgress`; keep `decideIntakeAction` and `IntakeAction` unchanged)
- Modify: `docs/superpowers/specs/2026-07-10-one-tap-morning-checkin-design.md` (amendments)

**Interfaces:**
- Consumes: `computeMorningDefaults`/`DEFAULTS_FALLBACK`/`MorningDefaults` (Task 2), `BatchBodySchema`/`columnsFromBatch`/`formatBatchReply`/`BatchValues` (Task 3), `IntakeSource` + `MorningUI.morning_form` (Task 1).
- Produces (HTTP contract for Task 5):
  - POST `{kind:'start'}` — unchanged response shape; fresh path now inserts the card turn.
  - POST `{kind:'all_good'}` → `{ok:true}` JSON; 409 `{ok:false, reason:'not_awaiting'}` when today's row is missing or past `awaiting_feel`.
  - POST `{kind:'batch', values, notes?}` → `{ok:true}` / `{ok:true, delivered:true}` JSON; 400 `{ok:false, reason:'bad_batch'}` on schema failure; same 409 as all_good.
  - POST `{slot:'still_sick', value}` — kept. Any other slot → 400.
  - POST `{kind:'free_text', value}` — only valid in `awaiting_sickness_notes`; otherwise 409 `{ok:false, reason:'unexpected_free_text'}`.

- [ ] **Step 1: script.ts — retire the question list, add the card prompt**

Delete from `lib/morning/script.ts`: the `SLOTS` array, `SLOT_BY_KEY`, `SlotDef` type, `FREE_TEXT_TAIL_PROMPT`. Keep `SlotKey` deleted too — it only exists for the question walk. Keep `SlotChip` ONLY if still referenced (`STILL_SICK_CHIPS` uses it — keep `SlotChip`). Add:

```ts
export const MORNING_FORM_PROMPT = "Morning. How are you today?";

export const STILL_SICK_RECOVERED_PREFIX = "Good to hear. ";
```

Resulting exports of script.ts: `SORENESS_AREAS`, `SlotChip`, `MORNING_FORM_PROMPT`, `STILL_SICK_RECOVERED_PREFIX`, `STILL_SICK_PROMPT`, `STILL_SICK_CHIPS`, `SICKNESS_NOTES_PROMPT`, `REST_DAY_MESSAGE_HEALTHY_TO_SICK`, `REST_DAY_MESSAGE_STILL_SICK`, `SYNC_RECOVERY_PROMPT`, `SYNC_RECOVERY_FAILED_PROMPT`.

- [ ] **Step 2: state.ts — delete the question-walking machine**

Delete `nextSlot`, `SlotProgress`, `nextIntakeState` (and the now-unused `SlotKey` import). Keep `decideIntakeAction` + `IntakeAction` byte-identical. Update the file header comment to say the state machine is now: card outstanding (`awaiting_feel`) → one-shot submit → `awaiting_whoop` → recommendation flips to `delivered`.

- [ ] **Step 3: Rewrite the route**

Replace `app/api/chat/morning/intake/route.ts` with the following. What survives verbatim from the old file: `upsertCheckin`, `insertUserReply`, `insertAssistantTurn`, `applyToolUpdate`, `isoMinusDays`, `handleDeclareSick`, `handleSicknessNotes`, and the still-sick branch structure. What is new: `handleAllGood`, `handleBatch`, `runNotesAck` (non-streaming replacement for `handleFeelTail`), `fetchMorningDefaults`, `readCardDefaults`, `insertMorningFormTurn`, `parkWhoopSyncIfNeeded`. What is gone: `handleFeelTail`, `handleSlotAnswer`'s scripted-slot walk, `chipsForSlot`, `mapSlotToColumn`, `formatChipReply`, the SSE/`ReadableStream` machinery, the `formatSseEvent` import.

```ts
// app/api/chat/morning/intake/route.ts
//
// Morning intake endpoint — one-tap check-in card (spec 2026-07-10). POST:
//   {kind: 'start'}                    — begin or resume the day; inserts the card turn
//   {kind: 'all_good'}                 — write personal-baseline defaults, advance to awaiting_whoop
//   {kind: 'batch', values, notes?}    — one-shot form write (zod-validated)
//   {kind: 'declare_sick'}             — flip sick=true, ask for notes
//   {kind: 'free_text', value}         — sickness notes ONLY (409 otherwise)
//   {slot: 'still_sick', value}        — yesterday-was-sick morning gate
//
// The card's defaults are computed server-side at card creation and embedded
// in ui.morning_form; all_good re-reads them from the displayed card so the
// write matches exactly what the athlete saw.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import {
  MORNING_FORM_PROMPT,
  STILL_SICK_RECOVERED_PREFIX,
  STILL_SICK_PROMPT,
  STILL_SICK_CHIPS,
  SICKNESS_NOTES_PROMPT,
  REST_DAY_MESSAGE_HEALTHY_TO_SICK,
  REST_DAY_MESSAGE_STILL_SICK,
  SYNC_RECOVERY_PROMPT,
} from "@/lib/morning/script";
import {
  computeMorningDefaults,
  type DefaultsInputRow,
  type MorningDefaults,
} from "@/lib/morning/defaults";
import {
  BatchBodySchema,
  columnsFromBatch,
  formatBatchReply,
  type BatchValues,
} from "@/lib/morning/batch";
import { UPDATE_INTAKE_SLOTS_TOOL } from "@/lib/morning/tools";
import type { CheckinRow, MorningUI } from "@/lib/data/types";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHAT_MODEL as MODEL } from "@/lib/anthropic/models";

export const dynamic = "force-dynamic";

type Body =
  | { kind: "start" }
  | { kind: "all_good" }
  | { kind: "batch"; values: unknown; notes?: unknown }
  | { kind: "declare_sick" }
  | { kind: "free_text"; value: string }
  | { slot: string; value: string | number | string[] };

type SR = SupabaseClient;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as Body;
  const tz = await getUserTimezone(user.id);
  const today = todayInUserTz(new Date(), tz);
  const sr = createSupabaseServiceRoleClient();

  const { data: todayRow } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();

  if ("kind" in body && body.kind === "start") {
    return handleStart({ sr, userId: user.id, today, todayRow });
  }
  if ("kind" in body && body.kind === "all_good") {
    return handleAllGood({ sr, userId: user.id, today, todayRow });
  }
  if ("kind" in body && body.kind === "batch") {
    return handleBatch({ sr, userId: user.id, today, todayRow, body });
  }
  if ("kind" in body && body.kind === "declare_sick") {
    return handleDeclareSick({ sr, userId: user.id, today, todayRow });
  }
  if ("kind" in body && body.kind === "free_text") {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    if (todayRow.intake_state === "awaiting_sickness_notes") {
      return handleSicknessNotes({ sr, userId: user.id, today, value: body.value });
    }
    return NextResponse.json({ ok: false, reason: "unexpected_free_text" }, { status: 409 });
  }
  if ("slot" in body) {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    if (body.slot !== "still_sick") {
      return NextResponse.json({ ok: false, reason: "bad_slot" }, { status: 400 });
    }
    return handleStillSick({ sr, userId: user.id, today, value: body.value });
  }

  return NextResponse.json({ ok: false, reason: "bad_body" }, { status: 400 });
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleStart(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today, todayRow } = args;

  if (todayRow?.intake_state === "delivered") {
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  // Mid-flow resume: the card (or a later turn) is already the latest
  // assistant message in the thread; the client re-renders it on its own.
  if (todayRow && todayRow.intake_state !== "pending") {
    return NextResponse.json({ ok: true, resumed: true });
  }

  const yesterday = isoMinusDays(today, 1);
  const { data: yRow } = await sr
    .from("checkins")
    .select("sick, sickness_notes")
    .eq("user_id", userId)
    .eq("date", yesterday)
    .maybeSingle<Pick<CheckinRow, "sick" | "sickness_notes">>();

  if (yRow?.sick) {
    await upsertCheckin(sr, userId, today, {
      intake_state: "awaiting_feel",
      sick: false, // flipped back to true if the user answers Yes
      sickness_notes: yRow.sickness_notes ?? null,
    });
    await insertAssistantTurn(sr, userId, {
      content: STILL_SICK_PROMPT,
      ui: { chips: STILL_SICK_CHIPS.map((c) => ({ ...c, slot: "still_sick" })) },
    });
    return NextResponse.json({ ok: true, resumed: false, mode: "still_sick_check" });
  }

  await upsertCheckin(sr, userId, today, { intake_state: "awaiting_feel" });
  const defaults = await fetchMorningDefaults(sr, userId, today);
  await insertMorningFormTurn(sr, userId, MORNING_FORM_PROMPT, defaults);
  return NextResponse.json({ ok: true, resumed: false, mode: "fresh" });
}

async function handleAllGood(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today, todayRow } = args;
  if (!todayRow || (todayRow.intake_state !== "pending" && todayRow.intake_state !== "awaiting_feel")) {
    return NextResponse.json({ ok: false, reason: "not_awaiting" }, { status: 409 });
  }

  // Prefer the defaults embedded in the displayed card — the write must match
  // what the athlete saw, not a recomputation on possibly-newer data.
  const defaults =
    (await readCardDefaults(sr, userId)) ??
    (await fetchMorningDefaults(sr, userId, today));

  await insertUserReply(sr, userId, "Same as usual");
  await upsertCheckin(sr, userId, today, {
    readiness: defaults.readiness,
    fatigue: defaults.fatigue,
    soreness_areas: [],
    soreness_severity: null,
    bloating: false,
    sick: false,
    intake_source: "all_good",
    intake_state: "awaiting_whoop",
  });
  await parkWhoopSyncIfNeeded(sr, userId, today);
  return NextResponse.json({ ok: true });
}

async function handleBatch(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null; body: unknown;
}) {
  const { sr, userId, today, todayRow, body } = args;
  const parsed = BatchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "bad_batch", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (!todayRow || (todayRow.intake_state !== "pending" && todayRow.intake_state !== "awaiting_feel")) {
    return NextResponse.json({ ok: false, reason: "not_awaiting" }, { status: 409 });
  }

  const { values } = parsed.data;
  const notes = (parsed.data.notes ?? "").trim();

  await insertUserReply(sr, userId, formatBatchReply(values, notes || null));

  if (values.sick) {
    // Sick short-circuit — mirrors declare_sick semantics. Form notes are
    // sickness notes here (spec: not feel_notes).
    if (notes) {
      await upsertCheckin(sr, userId, today, {
        ...columnsFromBatch(values),
        intake_source: "form",
        sick: true,
        sickness_notes: notes,
        intake_state: "delivered",
      });
      await insertAssistantTurn(sr, userId, {
        content: REST_DAY_MESSAGE_HEALTHY_TO_SICK,
        ui: null,
      });
      return NextResponse.json({ ok: true, delivered: true });
    }
    await upsertCheckin(sr, userId, today, {
      ...columnsFromBatch(values),
      intake_source: "form",
      sick: true,
      intake_state: "awaiting_sickness_notes",
    });
    await insertAssistantTurn(sr, userId, {
      content: SICKNESS_NOTES_PROMPT,
      ui: { allow_text: true },
    });
    return NextResponse.json({ ok: true });
  }

  await upsertCheckin(sr, userId, today, {
    ...columnsFromBatch(values),
    intake_source: "form",
    sick: false,
    feel_notes: notes || null,
    intake_state: "awaiting_whoop",
  });
  if (notes) {
    await runNotesAck(sr, userId, today, values, notes);
  }
  await parkWhoopSyncIfNeeded(sr, userId, today);
  return NextResponse.json({ ok: true });
}

async function handleStillSick(args: {
  sr: SR; userId: string; today: string; value: string | number | string[];
}) {
  const { sr, userId, today, value } = args;
  await insertUserReply(sr, userId, String(value));

  if (value === "yes") {
    await upsertCheckin(sr, userId, today, {
      sick: true,
      intake_state: "delivered",
    });
    await insertAssistantTurn(sr, userId, {
      content: REST_DAY_MESSAGE_STILL_SICK,
      ui: null,
    });
    return NextResponse.json({ ok: true, delivered: true });
  }

  // Recovered — proceed to the check-in card.
  await upsertCheckin(sr, userId, today, {
    sick: false,
    sickness_notes: null,
    intake_state: "awaiting_feel",
  });
  const defaults = await fetchMorningDefaults(sr, userId, today);
  await insertMorningFormTurn(
    sr, userId, STILL_SICK_RECOVERED_PREFIX + MORNING_FORM_PROMPT, defaults,
  );
  return NextResponse.json({ ok: true });
}

async function handleDeclareSick(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today } = args;
  await insertUserReply(sr, userId, "I'm coming down with something");
  await upsertCheckin(sr, userId, today, {
    sick: true,
    intake_state: "awaiting_sickness_notes",
  });
  await insertAssistantTurn(sr, userId, {
    content: SICKNESS_NOTES_PROMPT,
    ui: { allow_text: true },
  });
  return NextResponse.json({ ok: true });
}

async function handleSicknessNotes(args: {
  sr: SR; userId: string; today: string; value: string;
}) {
  const { sr, userId, today, value } = args;
  const trimmed = value.trim();
  if (trimmed) {
    await insertUserReply(sr, userId, trimmed);
  }
  await upsertCheckin(sr, userId, today, {
    sickness_notes: trimmed || null,
    sick: true,
    intake_state: "delivered",
  });
  await insertAssistantTurn(sr, userId, {
    content: REST_DAY_MESSAGE_HEALTHY_TO_SICK,
    ui: null,
  });
  return NextResponse.json({ ok: true, delivered: true });
}

// ── card + defaults helpers ──────────────────────────────────────────────────

async function fetchMorningDefaults(
  sr: SR, userId: string, today: string,
): Promise<MorningDefaults> {
  const { data } = await sr
    .from("checkins")
    .select("readiness, fatigue, intake_source")
    .eq("user_id", userId)
    .gte("date", isoMinusDays(today, 28))
    .lt("date", today);
  return computeMorningDefaults((data ?? []) as DefaultsInputRow[]);
}

/** Defaults embedded in the most recent displayed card, if any. */
async function readCardDefaults(sr: SR, userId: string): Promise<MorningDefaults | null> {
  const { data } = await sr
    .from("chat_messages")
    .select("ui")
    .eq("user_id", userId)
    .eq("kind", "morning_intake")
    .eq("role", "assistant")
    .not("ui->morning_form", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ ui: MorningUI }>();
  return data?.ui?.morning_form?.defaults ?? null;
}

async function insertMorningFormTurn(
  sr: SR, userId: string, content: string, defaults: MorningDefaults,
): Promise<void> {
  await insertAssistantTurn(sr, userId, {
    content,
    ui: { morning_form: { defaults } },
  });
}

/** If last night's recovery hasn't landed, insert the parked sync turn with
 *  Recheck / Skip chips (same copy + chips as the pre-card flow). */
async function parkWhoopSyncIfNeeded(sr: SR, userId: string, today: string): Promise<void> {
  const { data: log } = await sr
    .from("daily_logs")
    .select("recovery")
    .eq("user_id", userId)
    .eq("date", today)
    .maybeSingle<{ recovery: number | null }>();

  if (!log || log.recovery == null) {
    await insertAssistantTurn(sr, userId, {
      content: SYNC_RECOVERY_PROMPT,
      ui: {
        chips: [
          { label: "Recheck", action: "recheck" },
          { label: "Skip — feel-only plan", action: "skip_whoop" },
        ],
      },
    });
  }
}

/** Non-streaming Remi ack for form notes. Best-effort: the check-in row is
 *  already committed before this runs; an API failure must never block the
 *  morning flow, so errors are swallowed and the thread simply has no ack. */
async function runNotesAck(
  sr: SR, userId: string, today: string, values: BatchValues, notes: string,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  try {
    const client = new Anthropic({ apiKey });
    const sys = `You are Remi — the user's recovery and morning-health coach. The user has just submitted their morning check-in form, including a free-text note. Their structured answers are already saved.

Your job:
1. If the note mentions a symptom that maps to {sick, soreness_areas, fatigue, bloating} and is clearly stated, call update_intake_slots ONCE to record it. Do not guess. Do not call the tool if nothing maps cleanly.
2. Reply briefly (1-2 short sentences) acknowledging what they shared. Voice: warm, focused on body signals and recovery — not training tactics, not nutrition. Do not ask follow-up questions. Do not moralize.

Today's structured answers: ${JSON.stringify(values)}`;

    const final = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: sys,
      tools: [UPDATE_INTAKE_SLOTS_TOOL],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: notes }],
    });

    let text = "";
    for (const block of final.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use" && block.name === "update_intake_slots") {
        await applyToolUpdate(sr, userId, today, block.input as Record<string, unknown>);
      }
    }
    if (text.trim()) {
      await insertAssistantTurn(sr, userId, { content: text.trim(), ui: null });
    }
  } catch {
    // Best-effort ack — never block the morning flow.
  }
}

// ── low-level helpers (unchanged from the pre-card route) ────────────────────

async function upsertCheckin(
  sr: SR, userId: string, date: string, patch: Partial<CheckinRow>,
): Promise<void> {
  const { error } = await sr
    .from("checkins")
    .upsert({ user_id: userId, date, ...patch }, { onConflict: "user_id,date" });
  if (error) throw error;
}

async function insertUserReply(sr: SR, userId: string, content: string): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "user",
    thread: "remi",
    content,
    status: "done",
    kind: "morning_intake",
    ui: null,
  });
  if (error) throw error;
}

async function insertAssistantTurn(
  sr: SR, userId: string, args: { content: string; ui: MorningUI | null },
): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "assistant",
    speaker: "remi",
    thread: "remi",
    content: args.content,
    status: "done",
    kind: "morning_intake",
    ui: args.ui,
  });
  if (error) throw error;
}

async function applyToolUpdate(
  sr: SR, userId: string, today: string, input: Record<string, unknown>,
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

Note the still-sick behavior change vs the old route: the "no" branch inserts the card turn instead of the readiness question, and the still-sick handler now inserts the user reply itself (the old code did it in `handleSlotAnswer` for all slots).

- [ ] **Step 4: Hunt stale references**

Run: `grep -rn "nextSlot\|nextIntakeState\|SLOT_BY_KEY\|FREE_TEXT_TAIL_PROMPT\|handleFeelTail\|SlotProgress" app lib components --include="*.ts" --include="*.tsx"`
Expected: no hits outside this plan's own deletions. `SlotKey` references in `components/` (if any) get resolved in Task 5.

- [ ] **Step 5: Typecheck + full test run**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck may fail ONLY in `components/chat/ChatPanel.tsx` if it imports a deleted symbol — check with the grep above; if so, note it and fix in Task 5 before committing this task... Actually verify first: `grep -n "morning/script\|morning/state" components/chat/ChatPanel.tsx components/chat/ChatChips.tsx`. If ChatPanel imports nothing deleted, both commands must pass clean here.

- [ ] **Step 6: Amend the spec**

In `docs/superpowers/specs/2026-07-10-one-tap-morning-checkin-design.md`:
- In "Server changes", replace the sentence "`notes` non-empty → `handleFeelTail` path (which already writes `feel_notes`, streams the Remi ack, applies tool extraction, and advances to `awaiting_whoop`); else JSON response + `awaiting_whoop`." with: "`notes` non-empty → a **non-streaming** Anthropic call (`runNotesAck`) inserts the Remi ack turn and applies `update_intake_slots` extraction, best-effort after the row is already committed; the response is JSON in all cases. (Amended 2026-07-10 during planning: with the forced tail gone, the morning SSE path had exactly one remaining consumer — a 1–2 sentence ack doesn't justify keeping a streaming protocol.)"
- In "Client changes", replace "dispatched from `ChatThread` the same way `ProactiveNudgeCard` is (keyed on the `ui.morning_form` shape)" and the "hands off to the existing SSE consumer" clause with: "rendered from ChatPanel's bottom slot (both layout variants) where `ChatChips` renders today, interactive only while the card is the latest assistant message; all submits are plain JSON posts. (Amended 2026-07-10: the morning intake UI lives in the panel's bottom slot, not the thread.)"
- In "Testing & verification", drop "resume mid-card" ambiguity if present (unchanged semantics) — no other edits.

- [ ] **Step 7: Commit**

```bash
git add app/api/chat/morning/intake/route.ts lib/morning/script.ts lib/morning/state.ts docs/superpowers/specs/2026-07-10-one-tap-morning-checkin-design.md
git commit -m "feat(morning): one-shot all_good/batch intake route; retire sequential slot walk"
```

---

### Task 5: Client — MorningCheckinCard + ChatPanel wiring

**Files:**
- Create: `components/morning/MorningCheckinCard.tsx`
- Modify: `components/chat/ChatPanel.tsx` (two render sites ~line 1213 and ~1415, `hideComposer` in two places ~1232 and ~1435, new `postMorningAndRefresh` callback near `onSlotAnswer` ~1008)

**Interfaces:**
- Consumes: HTTP contract from Task 4 (`{kind:'all_good'}`, `{kind:'batch', values, notes?}` → JSON), `MorningUI.morning_form` (Task 1), `BatchValues` type + `SORENESS_AREAS` (Task 3 / script.ts), `COLOR` from `@/lib/ui/theme`.
- Produces: `<MorningCheckinCard defaults={...} onSubmit={(body) => Promise<void>} />` where `body` is the exact POST body.

- [ ] **Step 1: Write the card component**

```tsx
// components/morning/MorningCheckinCard.tsx
//
// One-tap morning check-in card (spec 2026-07-10). Renders in ChatPanel's
// bottom slot while the morning_form assistant turn is the latest message.
// Collapsed: "Same as usual" (writes server-computed personal defaults) or
// "Adjust" (expands an inline form prefilled with those defaults).

"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { SORENESS_AREAS } from "@/lib/morning/script";
import type { BatchValues } from "@/lib/morning/batch";
import type { FatigueLevel, SorenessSeverity } from "@/lib/data/types";

type Defaults = { readiness: number; fatigue: FatigueLevel };

export type MorningIntakeBody =
  | { kind: "all_good" }
  | { kind: "batch"; values: BatchValues; notes?: string };

export function MorningCheckinCard({
  defaults,
  onSubmit,
}: {
  defaults: Defaults;
  onSubmit: (body: MorningIntakeBody) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [readiness, setReadiness] = useState<number>(defaults.readiness);
  const [fatigue, setFatigue] = useState<FatigueLevel>(defaults.fatigue);
  const [areas, setAreas] = useState<Set<string>>(new Set());
  const [severity, setSeverity] = useState<SorenessSeverity>("mild");
  const [bloating, setBloating] = useState(false);
  const [sick, setSick] = useState(false);
  const [notes, setNotes] = useState("");

  const submit = async (body: MorningIntakeBody) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
    // On success the thread refetch replaces the last message; this card
    // unmounts. Only reset busy on error so the buttons can't double-fire.
  };

  const submitBatch = () => {
    const values: BatchValues = {
      readiness,
      fatigue,
      soreness_areas: Array.from(areas) as BatchValues["soreness_areas"],
      soreness_severity: areas.size > 0 ? severity : null,
      bloating,
      sick,
    };
    const trimmed = notes.trim();
    void submit(trimmed ? { kind: "batch", values, notes: trimmed } : { kind: "batch", values });
  };

  const fatigueLabel = { none: "no", some: "some", heavy: "heavy" }[defaults.fatigue];

  if (!expanded) {
    return (
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit({ kind: "all_good" })}
          style={{ ...btnStyle(true), opacity: busy ? 0.6 : 1 }}
        >
          ✓ Same as usual
          <span style={{ display: "block", fontSize: "11px", fontWeight: 400, opacity: 0.8 }}>
            feel {defaults.readiness} · {fatigueLabel} fatigue · no soreness
          </span>
        </button>
        <button type="button" disabled={busy} onClick={() => setExpanded(true)} style={btnStyle(false)}>
          Adjust →
        </button>
        {error && <ErrorLine text={error} />}
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <FieldRow label="Feel">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <Chip key={n} on={readiness === n} onTap={() => setReadiness(n)} label={String(n)} compact />
        ))}
      </FieldRow>
      <FieldRow label="Fatigue">
        {(["none", "some", "heavy"] as const).map((f) => (
          <Chip key={f} on={fatigue === f} onTap={() => setFatigue(f)} label={f} />
        ))}
      </FieldRow>
      <FieldRow label="Sore">
        {SORENESS_AREAS.map((a) => (
          <Chip
            key={a}
            on={areas.has(a)}
            onTap={() =>
              setAreas((s) => {
                const next = new Set(s);
                if (next.has(a)) next.delete(a);
                else next.add(a);
                return next;
              })
            }
            label={a}
          />
        ))}
      </FieldRow>
      {areas.size > 0 && (
        <FieldRow label="Severity">
          {(["mild", "sharp"] as const).map((s) => (
            <Chip key={s} on={severity === s} onTap={() => setSeverity(s)} label={s} />
          ))}
        </FieldRow>
      )}
      <FieldRow label="Bloated">
        <Chip on={!bloating} onTap={() => setBloating(false)} label="no" />
        <Chip on={bloating} onTap={() => setBloating(true)} label="yes" />
      </FieldRow>
      <FieldRow label="Sick">
        <Chip on={!sick} onTap={() => setSick(false)} label="no" />
        <Chip on={sick} onTap={() => setSick(true)} label="yes" />
      </FieldRow>
      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={2000}
        placeholder="Anything else? (optional)"
        style={{
          padding: "8px 12px",
          borderRadius: "10px",
          border: `1px solid ${COLOR.divider}`,
          background: COLOR.surfaceAlt,
          color: COLOR.textStrong,
          fontSize: "13px",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", gap: "6px" }}>
        <button type="button" disabled={busy} onClick={() => setExpanded(false)} style={btnStyle(false)}>
          ← Back
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={submitBatch}
          style={{ ...btnStyle(true), flex: 1, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Saving…" : "Submit"}
        </button>
      </div>
      {error && <ErrorLine text={error} />}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      <span
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: COLOR.textDim,
          width: "58px",
          flexShrink: 0,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  on, onTap, label, compact,
}: {
  on: boolean; onTap: () => void; label: string; compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      style={{
        padding: compact ? "6px 9px" : "6px 12px",
        borderRadius: "999px",
        background: on ? COLOR.accent : COLOR.surfaceAlt,
        color: on ? "#fff" : COLOR.textStrong,
        border: "none",
        fontSize: "12px",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: "12px",
    background: primary ? COLOR.accent : COLOR.surfaceAlt,
    color: primary ? "#fff" : COLOR.textStrong,
    border: "none",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
  };
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div style={{ fontSize: "11px", color: "#f87171" }}>
      Couldn&apos;t save — {text}. Tap again to retry.
    </div>
  );
}
```

Check `COLOR` keys used (`accent`, `surfaceAlt`, `textStrong`, `textDim`, `divider`) exist in `lib/ui/theme.ts` — they are all used by `ChatChips`/`ChatPanel` today except possibly `textDim`; substitute the theme's actual dim-text key if named differently.

- [ ] **Step 2: Wire ChatPanel**

In `components/chat/ChatPanel.tsx`:

(a) Import the card:

```ts
import { MorningCheckinCard } from "@/components/morning/MorningCheckinCard";
import type { MorningIntakeBody } from "@/components/morning/MorningCheckinCard";
```

(b) Add a shared JSON-post-then-refresh callback next to `onSlotAnswer` (~line 1008), and refactor `onSlotAnswer` to use it:

```ts
const postMorningAndRefresh = useCallback(
  async (body: unknown) => {
    const res = await fetch("/api/chat/morning/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let reason = `http_${res.status}`;
      try {
        const json = (await res.json()) as { reason?: string };
        if (json.reason) reason = json.reason;
      } catch { /* ignore */ }
      throw new Error(reason);
    }
    const refresh = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
    const histJson = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
    if (histJson.ok && histJson.messages) {
      dispatch({
        type: "loaded",
        messages: scopeForMode(histJson.messages.slice().reverse(), currentMode, today, tz),
      });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
  },
  [currentMode, queryClient, today, userId, tz],
);

const onSlotAnswer = useCallback(
  async (slot: string, value: string | number | string[]) => {
    try {
      await postMorningAndRefresh({ slot, value });
    } catch {
      // Server may still have inserted turns; the refetch above already ran
      // on the happy path, and chips have no error surface — swallow, matching
      // the pre-card behavior.
    }
  },
  [postMorningAndRefresh],
);

const onMorningForm = useCallback(
  (body: MorningIntakeBody) => postMorningAndRefresh(body),
  [postMorningAndRefresh],
);
```

(Preserve the old `onSlotAnswer` semantics: it ignored response status but always refetched. The `try/catch` above keeps chips fire-and-forget; the card, by contrast, surfaces errors via the thrown `Error`.) Note `tz` must be in the dependency array — check whether the existing `onSlotAnswer` deps included it; `scopeForMode` uses it.

(c) At BOTH morning bottom-slot render sites (~1213 overlay variant and ~1415 page variant), add the card branch before the chips branch:

```tsx
{currentMode === "morning_intake" &&
  (() => {
    const last = state.messages[state.messages.length - 1];
    if (!last || last.role !== "assistant" || last.status !== "done") return null;
    const morningUi = morningUiOf(last);
    if (morningUi?.morning_form) {
      return (
        <MorningCheckinCard
          key={last.id}
          defaults={morningUi.morning_form.defaults}
          onSubmit={onMorningForm}
        />
      );
    }
    if (!morningUi || !morningUi.chips || morningUi.chips.length === 0) return null;
    return (
      <ChatChips key={last.id} ui={morningUi} onSlotAnswer={onSlotAnswer} onAction={onAction} />
    );
  })()}
```

(d) At BOTH `hideComposer` computations (~1232 and ~1435), hide the composer while the card is up:

```ts
const hideComposer =
  currentMode === "morning_intake" &&
  ((!!morningUi?.chips && morningUi.chips.length > 0 && !morningUi.allow_text) ||
    !!morningUi?.morning_form);
```

(e) Leave `sendMorningFreeText` (the `postSse` handler ~line 820) untouched — it still serves the sickness-notes `allow_text` turn (the server returns JSON there; the client's post-loop thread refetch renders the result, same as today).

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean. Build matters here — hooks bugs don't surface in vitest (no render harness).

- [ ] **Step 4: Commit**

```bash
git add components/morning/MorningCheckinCard.tsx components/chat/ChatPanel.tsx
git commit -m "feat(morning): one-tap check-in card in ChatPanel bottom slot"
```

---

### Task 6: End-to-end verification + docs

**Files:**
- Modify: `CLAUDE.md` (migrations list + morning-brief architecture bullet)

- [ ] **Step 1: Full test + build sweep**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all clean.

- [ ] **Step 2: Manual flow check against dev**

`npm run dev`, open http://localhost:3000 logged in.
- If today has NO checkin row: the morning overlay opens with the card (not the old readiness question). Verify: collapsed state shows "Same as usual" with the personal defaults line (expect "feel 7 · some fatigue" given current data); "Adjust →" expands the form; severity row appears only after picking a soreness area; composer is hidden while the card is up.
- CAUTION: this is the production DB (single-user app). Submitting writes the athlete's real check-in for today. If today's check-in hasn't been done yet, a real submit is acceptable (it IS the check-in — tell the user afterwards); otherwise stop at visual verification. To reset a test submit: delete today's `checkins` row and today's `kind='morning_intake'` chat rows via service role, but note the brief may already have fired.
- Verify after a submit: `checkins` row has `intake_source` set, `intake_state='awaiting_whoop'` (or parked sync turn visible when recovery is null), recommendation auto-fires when recovery lands.

- [ ] **Step 3: Update CLAUDE.md**

In the migrations list, after entry 42, add:

```markdown
43. [supabase/migrations/0050_intake_source.sql](supabase/migrations/0050_intake_source.sql) — adds `checkins.intake_source` (`legacy_chips|all_good|form`, nullable) marking how the day's check-in was reported. Powers the one-tap morning check-in card's defaults engine ([lib/morning/defaults.ts](lib/morning/defaults.ts)): personal-baseline median/mode computed over explicit rows only (`all_good` rows excluded to prevent default-feedback drift).
```

Update the trailing "Next free slot" line to **0051**.

In the "Morning brief (post-intake daily card)" bullet, insert before "State machine extends 0007":

```markdown
The intake itself is a one-tap card (spec 2026-07-10): a single assistant turn (`ui.morning_form` with embedded personal defaults) replaces the old 8-question sequential chat. `{kind:'all_good'}` writes the athlete's baseline (28d median readiness + modal fatigue via [lib/morning/defaults.ts](lib/morning/defaults.ts), `intake_source='all_good'`); `{kind:'batch'}` one-shot-writes the adjusted form ([lib/morning/batch.ts](lib/morning/batch.ts), `intake_source='form'`); form notes get a best-effort non-streaming Remi ack with `update_intake_slots` extraction. The energy_label/mood questions are gone (columns remain, manual Log form still writes them).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md for one-tap morning check-in (migration 0050)"
```

- [ ] **Step 5: Finish the branch**

Use the superpowers:finishing-a-development-branch skill — run the full verification one more time, then offer merge/PR options (this repo's convention: PR to `main`).

---

## Self-review notes (already applied)

- **Spec coverage:** migration 0050 (Task 1), defaults engine + tests (Task 2), batch schema (Task 3), route kinds + deletions + still-sick card handoff + sick-in-form semantics (Task 4), card + panel wiring + composer hiding (Task 5), CLAUDE.md + manual flow (Task 6). Spec amendments (non-streaming ack, panel-slot rendering) are explicit in Task 4 Step 6.
- **Types:** `MorningIntakeBody` produced in Task 5 matches Task 4's HTTP contract; `BatchValues`/`columnsFromBatch`/`formatBatchReply` names consistent across Tasks 3–5; `MorningDefaults` consistent across Tasks 2/4/5 (Task 5 re-declares the shape locally as `Defaults` to avoid a server-module import — fine, it's structural).
- **Known judgment calls for the executor:** `COLOR.textDim` key name (verify against `lib/ui/theme.ts`), zod v4 readonly-tuple `z.enum` acceptance, and whether ChatPanel's `onSlotAnswer` deps already include `tz`.
