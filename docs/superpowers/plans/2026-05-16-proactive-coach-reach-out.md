# Proactive Coach Reach-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project #4 of the coach-as-real-coach arc — a daily cron that evaluates three deterministic triggers (plateau, off-pace weight, HRV below baseline) against Sub-project #5's `CoachTrendsPayload` and writes structured chat cards (`kind='proactive_nudge'`) with 7-day dedup. No push notifications, no HMAC action chips, no AI prose — pure templating + deep-links.

**Architecture:** New `lib/coach/proactive/` module mirrors `lib/coach/trends/` composer pattern: three pure check functions emit `ProactiveEvent[]`, an orchestrator dedups via `chat_messages` lookup, and a single template renderer produces the typed `ProactiveNudgeCard`. New cron at `/api/coach/proactive/check` runs daily at 11:00 UTC, gated by `CRON_SECRET`. Migration 0015 extends the existing `chat_messages_kind_check` constraint to include `'proactive_nudge'`. UI is one new component plugged into the existing kind-dispatch switch in `components/chat/ChatThread.tsx`.

**Tech Stack:** Next.js 15 App Router (cron routes), Supabase (service-role for cron writes), TypeScript strict, Tailwind v4. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-16-proactive-coach-reach-out-design.md](../specs/2026-05-16-proactive-coach-reach-out-design.md).

---

## Pre-flight

- [ ] **Pre-flight 1: Create feature branch off main**

  ```bash
  cd "/Users/abdelouahedelbied/Health app"
  git checkout main
  git pull origin main
  git checkout -b feat/coach-proactive
  ```

- [ ] **Pre-flight 2: Verify clean baseline**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0.

- [ ] **Pre-flight 3: Confirm Sub-project #5 outputs are available**

  Sub-project #5 (Trend Layer) is on main. Its compute is the input to this sub-project. Verify the orchestrator and audit script work:

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-coach-trends.mjs 2>&1 | head -30
  ```

  Expected: prints HEADLINE + STRENGTH per-lift + BODY + NUTRITION + RECOVERY + CROSS INSIGHTS sections. At least one `plateau_active=true` lift in the strength section is expected (Decline Bench Press in the dev fixture).

- [ ] **Pre-flight 4: Verify chat dispatch site + card pattern reference**

  ```bash
  grep -n "kind === \"weekly_review\"\|kind === \"morning_brief\"" components/chat/ChatThread.tsx
  grep -n "weekly_review\|morning_brief" components/chat/ChatMessage.tsx
  ls components/chat/WeeklyReviewCard.tsx components/morning/MorningBriefCard.tsx
  ```

  Expected: ChatThread.tsx has the kind-switch around line 194-204; ChatMessage.tsx has the kindTag around line 51-58; both reference card components exist. These are the insertion points for Slice 3.

---

## File Structure

**New files (9):**

| Path | Purpose |
|---|---|
| `supabase/migrations/0015_proactive_nudge.sql` | Extend `chat_messages_kind_check` to include `'proactive_nudge'` |
| `lib/coach/proactive/check-plateau.ts` | Pure trigger fn — emits one `ProactiveEvent` per plateaued big-four lift |
| `lib/coach/proactive/check-off-pace.ts` | Pure trigger fn — emits 0..1 event when 4w weight rate is out of band |
| `lib/coach/proactive/check-hrv.ts` | Pure trigger fn — emits 0..1 event when HRV is >5% below 30d baseline |
| `lib/coach/proactive/render-card.ts` | Pure template renderers — one per trigger flavor |
| `lib/coach/proactive/index.ts` | Orchestrator — calls trends compute, runs checks, dedups, inserts rows |
| `app/api/coach/proactive/check/route.ts` | Cron route handler — `CRON_SECRET`-gated |
| `components/chat/ProactiveNudgeCard.tsx` | UI renderer for the new kind |
| `scripts/audit-proactive-cron.mjs` | Read-only dry-run script for manual verification |

**Modified files (5):**

| Path | Change |
|---|---|
| `lib/data/types.ts` | Add `ProactiveTriggerType`, `ProactiveEvent`, `ProactiveNudgeCard`; extend `chat_messages.kind` union (line 87) |
| `lib/chat/types.ts` | Extend `ChatMessage.kind` union (line 47) + `ui` type to include `ProactiveNudgeCard` |
| `vercel.json` | Add cron entry for `/api/coach/proactive/check` at `0 11 * * *` |
| `components/chat/ChatThread.tsx` | Add `'proactive_nudge'` case to the kind-switch (line 200 area) |
| `components/chat/ChatMessage.tsx` | Add `'proactive_nudge'` kindTag (line 51 area) |
| `CLAUDE.md` | Document the proactive layer in the Coach / AI architecture section |

---

## Slice 1 — Compute module + migration

Goal: Types, migration, three trigger functions, renderer, orchestrator, and audit script all in place. Audit script exercises the full compute against the dev fixture. No cron route yet, no UI integration yet.

### Task 1.1: Migration 0015 — extend chat_messages kind constraint

**Files:**
- Create: `supabase/migrations/0015_proactive_nudge.sql`

- [ ] **Step 1: Write the migration**

  Create `supabase/migrations/0015_proactive_nudge.sql`:

  ```sql
  -- supabase/migrations/0015_proactive_nudge.sql
  --
  -- Sub-project #4: chat-side proactive coach reach-out.
  -- Extends chat_messages.kind union to include 'proactive_nudge'.
  --
  -- The 'proactive_nudge' kind is written by the /api/coach/proactive/check
  -- cron when a trigger (plateau / off-pace weight / HRV below baseline)
  -- fires. Dedup is enforced via chat_messages lookup (7-day window per
  -- ui.trigger_key); no separate dedup table.

  alter table public.chat_messages
    drop constraint if exists chat_messages_kind_check;

  alter table public.chat_messages
    add constraint chat_messages_kind_check check (
      kind in (
        'coach',
        'morning_intake',
        'morning_brief',
        'weekly_review',
        'proactive_nudge'
      )
    );

  comment on column public.chat_messages.kind is
    'Discriminator: coach (default conversational), morning_intake (chip turns), morning_brief (daily card), weekly_review (Sunday recap card), proactive_nudge (trigger-fired alert card).';
  ```

- [ ] **Step 2: Apply via Supabase CLI**

  ```bash
  supabase db push
  ```

  Expected: applies 0015 cleanly. If the CLI reports the migration as already applied (e.g., from a prior dev attempt), repair history with:

  ```bash
  supabase migration repair --status applied 0015
  ```

- [ ] **Step 3: Verify the constraint accepts the new value**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
  import { readFileSync } from 'fs';
  import { createClient } from '@supabase/supabase-js';
  const env = {};
  for (const l of readFileSync('.env.local','utf-8').split('\n')) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)\$/);
    if (m) env[m[1]] = m[2];
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: p } = await sb.from('profiles').select('user_id').limit(1).single();
  const probe = await sb.from('chat_messages').insert({ user_id: p.user_id, role: 'assistant', kind: 'proactive_nudge', content: 'migration probe', ui: { schema_version: 1 } }).select('id').single();
  console.log('insert ok:', probe.data?.id);
  if (probe.data?.id) await sb.from('chat_messages').delete().eq('id', probe.data.id);
  console.log('cleanup ok');
  "
  ```

  Expected: `insert ok: <uuid>` then `cleanup ok`. If the constraint rejects, the migration didn't apply — re-run Step 2.

- [ ] **Step 4: Commit**

  ```bash
  git add supabase/migrations/0015_proactive_nudge.sql
  git commit -m "feat(db): migration 0015 — extend chat_messages.kind for proactive_nudge"
  ```

### Task 1.2: Types in lib/data/types.ts + lib/chat/types.ts

**Files:**
- Modify: `lib/data/types.ts`
- Modify: `lib/chat/types.ts`

- [ ] **Step 1: Append new types to lib/data/types.ts**

  Open `lib/data/types.ts`. Find the section header "// ── Coach trends (lib/coach/trends/)" (added in Sub-project #5). Append a NEW section AFTER all the trend types (after the `CoachTrendsPayload` definition):

  ```ts
  // ── Coach proactive reach-out (lib/coach/proactive/) ────────────────────────

  export type ProactiveTriggerType =
    | "plateau"
    | "off_pace_weight"
    | "hrv_below_baseline";

  /** Internal event shape passed from check-* functions to the orchestrator.
   *  The `payload` field carries trigger-specific data the renderer needs. */
  export type ProactiveEvent = {
    trigger_type: ProactiveTriggerType;
    trigger_key: string;
    payload: Record<string, unknown>;
  };

  /** Persisted in chat_messages.ui when kind='proactive_nudge'. */
  export type ProactiveNudgeCard = {
    schema_version: 1;
    trigger_type: ProactiveTriggerType;
    /** Used by the 7-day dedup window — same key for the same episode. */
    trigger_key: string;
    /** Reserved as union; v1 only emits "warn". */
    severity: "warn";
    /** ≤60 chars. */
    headline: string;
    /** 1-2 sentences. */
    body_md: string;
    deep_link: { label: string; href: string };
  };
  ```

- [ ] **Step 2: Extend the chat_messages.kind union in lib/data/types.ts**

  In `lib/data/types.ts`, find the existing `chat_messages` row type around line 87 (the line that reads `kind: "coach" | "morning_intake" | "morning_brief" | "weekly_review";`). Replace with:

  ```ts
    kind: "coach" | "morning_intake" | "morning_brief" | "weekly_review" | "proactive_nudge";
  ```

  Locate the existing `ui` field type on the same row type — if it's typed as `MorningUI | WeeklyReviewCardUI | MorningBriefCard | null` or similar, append `| ProactiveNudgeCard` to the union.

- [ ] **Step 3: Extend lib/chat/types.ts**

  Open `lib/chat/types.ts`. Find the `ChatMessage` type (around line 36). Update the `kind` field (line 47) and the `ui` import + field (line 50). The import line at the top must add `ProactiveNudgeCard` to the imported names:

  Before (line 7):
  ```ts
  import type { MorningUI, WeeklyReviewCardUI } from "@/lib/data/types";
  ```

  After:
  ```ts
  import type { MorningUI, WeeklyReviewCardUI, ProactiveNudgeCard } from "@/lib/data/types";
  ```

  Then update the `kind` and `ui` fields:

  Before:
  ```ts
    kind: "coach" | "morning_intake" | "morning_brief" | "weekly_review";
    ui: MorningUI | WeeklyReviewCardUI | null;
  ```

  After:
  ```ts
    kind: "coach" | "morning_intake" | "morning_brief" | "weekly_review" | "proactive_nudge";
    ui: MorningUI | WeeklyReviewCardUI | ProactiveNudgeCard | null;
  ```

  (If the existing `ui` union already includes more types like `MorningBriefCard`, preserve those — only append `ProactiveNudgeCard`.)

- [ ] **Step 4: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: exit 0. If there are downstream `ChatMessage` consumers that exhaustively switch on `kind` (e.g., a default branch that assumes a closed union), they'll surface here — add a `case "proactive_nudge":` returning a sensible fallback (typically the same as the `default` branch). This is non-load-bearing for now since the Slice 3 dispatch site is the only render path that needs to specifically handle the new kind.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/data/types.ts lib/chat/types.ts
  git commit -m "feat(types): ProactiveTriggerType, ProactiveEvent, ProactiveNudgeCard + kind union extensions"
  ```

### Task 1.3: check-plateau.ts

**Files:**
- Create: `lib/coach/proactive/check-plateau.ts`

- [ ] **Step 1: Write the check function**

  Create the directory and file:

  ```bash
  mkdir -p lib/coach/proactive
  ```

  Create `lib/coach/proactive/check-plateau.ts`:

  ```ts
  // lib/coach/proactive/check-plateau.ts
  //
  // Emits one ProactiveEvent per big-four lift with plateau_active=true.
  // Reads only from the pre-computed CoachTrendsPayload.strength.per_lift[].
  // The plateau detection itself lives in lib/coach/trends/compose-strength.ts
  // (3+ consecutive non-deload weeks within 1.5% of each other).

  import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";

  export function checkPlateau(
    trends: CoachTrendsPayload,
  ): ProactiveEvent[] {
    const events: ProactiveEvent[] = [];
    for (const lift of trends.strength.per_lift) {
      if (!lift.plateau_active) continue;
      events.push({
        trigger_type: "plateau",
        trigger_key: `plateau:${lift.lift}`,
        payload: {
          lift: lift.lift,
          e1rm_kg_now: lift.e1rm_kg_now,
          plateau_weeks_flat: lift.plateau_weeks_flat,
        },
      });
    }
    return events;
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: exit 0.

- [ ] **Step 3: Commit**

  ```bash
  git add lib/coach/proactive/check-plateau.ts
  git commit -m "feat(coach/proactive): plateau trigger check"
  ```

### Task 1.4: check-off-pace.ts

**Files:**
- Create: `lib/coach/proactive/check-off-pace.ts`

- [ ] **Step 1: Write the check function**

  Create `lib/coach/proactive/check-off-pace.ts`:

  ```ts
  // lib/coach/proactive/check-off-pace.ts
  //
  // Emits zero or one event when the 4w weight rate is outside the target
  // band. The flavor field distinguishes "aggressive" (below the lower bound
  // — too fast a cut, LBM risk) vs "slow_or_gaining" (above the upper bound
  // — insufficient deficit if a cut is intended).
  //
  // The 4w rate is already a 4-week OLS smoothing from lib/coach/trends/
  // compose-body.ts, so single-measurement noise doesn't flip this trigger.

  import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";

  export function checkOffPace(
    trends: CoachTrendsPayload,
  ): ProactiveEvent[] {
    const w = trends.body.weight;
    if (w.in_band !== false) return [];
    if (w.rate_kg_per_wk_4w == null) return [];

    const rate = w.rate_kg_per_wk_4w;
    const flavor: "aggressive" | "slow_or_gaining" =
      rate < w.target_band.lower ? "aggressive" : "slow_or_gaining";

    return [
      {
        trigger_type: "off_pace_weight",
        trigger_key: "off_pace_weight",
        payload: {
          flavor,
          rate_kg_per_wk_4w: rate,
          target_band: w.target_band,
        },
      },
    ];
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/proactive/check-off-pace.ts
  git commit -m "feat(coach/proactive): off-pace weight trigger check"
  ```

### Task 1.5: check-hrv.ts

**Files:**
- Create: `lib/coach/proactive/check-hrv.ts`

- [ ] **Step 1: Write the check function**

  Create `lib/coach/proactive/check-hrv.ts`:

  ```ts
  // lib/coach/proactive/check-hrv.ts
  //
  // Emits zero or one event when HRV 4w avg is >5% below the user's 30-day
  // baseline. Threshold matches pickHeadline in lib/coach/trends/index.ts.

  import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";

  const HRV_BELOW_BASELINE_THRESHOLD = -0.05;

  export function checkHrv(
    trends: CoachTrendsPayload,
  ): ProactiveEvent[] {
    const h = trends.recovery.hrv;
    if (h.vs_baseline_pct_4w == null) return [];
    if (h.vs_baseline_pct_4w >= HRV_BELOW_BASELINE_THRESHOLD) return [];

    return [
      {
        trigger_type: "hrv_below_baseline",
        trigger_key: "hrv_below_baseline",
        payload: {
          vs_baseline_pct_4w: h.vs_baseline_pct_4w,
          avg_4w: h.avg_4w,
          baseline_30d: h.baseline_30d,
        },
      },
    ];
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/proactive/check-hrv.ts
  git commit -m "feat(coach/proactive): HRV-below-baseline trigger check"
  ```

### Task 1.6: render-card.ts (templates)

**Files:**
- Create: `lib/coach/proactive/render-card.ts`

- [ ] **Step 1: Write the renderer**

  Create `lib/coach/proactive/render-card.ts`:

  ```ts
  // lib/coach/proactive/render-card.ts
  //
  // Pure deterministic templates. One render function per trigger type.
  // No Anthropic calls. Headlines ≤60 chars, bodies 1-2 sentences.

  import type {
    ProactiveEvent,
    ProactiveNudgeCard,
  } from "@/lib/data/types";

  /** Strip the "(Barbell)" / "(Dumbbell)" suffix for shorter card headlines. */
  function shortLift(name: string): string {
    return name.replace(/\s*\([^)]+\)/, "");
  }

  function fmt1(n: number): string {
    return (Math.round(n * 10) / 10).toString();
  }

  export function renderCard(event: ProactiveEvent): ProactiveNudgeCard {
    switch (event.trigger_type) {
      case "plateau":
        return renderPlateau(event);
      case "off_pace_weight":
        return renderOffPace(event);
      case "hrv_below_baseline":
        return renderHrv(event);
    }
  }

  function renderPlateau(event: ProactiveEvent): ProactiveNudgeCard {
    const lift = event.payload.lift as string;
    const e1rm = event.payload.e1rm_kg_now as number | null;
    const weeks = event.payload.plateau_weeks_flat as number;
    const short = shortLift(lift);
    const e1rmTxt = e1rm != null ? `${fmt1(e1rm)} kg` : "current load";

    return {
      schema_version: 1,
      trigger_type: "plateau",
      trigger_key: event.trigger_key,
      severity: "warn",
      headline: `${short} — ${weeks} weeks flat`,
      body_md: `e1RM is stuck at ${e1rmTxt}. The next weekly review will propose a rep-shift or deload — or break it sooner by switching to a heavier triple next session.`,
      deep_link: {
        label: "See full trends →",
        href: "/coach/trends?section=performance",
      },
    };
  }

  function renderOffPace(event: ProactiveEvent): ProactiveNudgeCard {
    const flavor = event.payload.flavor as "aggressive" | "slow_or_gaining";
    const rate = event.payload.rate_kg_per_wk_4w as number;
    const band = event.payload.target_band as { lower: number; upper: number };

    if (flavor === "aggressive") {
      return {
        schema_version: 1,
        trigger_type: "off_pace_weight",
        trigger_key: event.trigger_key,
        severity: "warn",
        headline: `Weight dropping ${fmt1(Math.abs(rate))} kg/wk`,
        body_md: `Loss rate is below the target band of ${fmt1(band.lower)} to ${fmt1(band.upper)} kg/wk. Aggressive cuts risk LBM and strength loss — consider pulling the deficit back.`,
        deep_link: {
          label: "Check composition →",
          href: "/coach/trends?section=composition",
        },
      };
    }

    // slow_or_gaining
    const sign = rate >= 0 ? "+" : "";
    return {
      schema_version: 1,
      trigger_type: "off_pace_weight",
      trigger_key: event.trigger_key,
      severity: "warn",
      headline: `Weight only ${sign}${fmt1(rate)} kg/wk`,
      body_md: `Loss rate is above the target band of ${fmt1(band.lower)} to ${fmt1(band.upper)} kg/wk. If a cut is the goal, the deficit needs deepening.`,
      deep_link: {
        label: "Check composition →",
        href: "/coach/trends?section=composition",
      },
    };
  }

  function renderHrv(event: ProactiveEvent): ProactiveNudgeCard {
    const pct = event.payload.vs_baseline_pct_4w as number;
    const pctAbs = Math.abs(pct * 100);

    return {
      schema_version: 1,
      trigger_type: "hrv_below_baseline",
      trigger_key: event.trigger_key,
      severity: "warn",
      headline: `HRV ${Math.round(pctAbs)}% below baseline`,
      body_md: `Average HRV over the last 4 weeks is below your 30-day baseline. Sleep, stress, or training load are candidates.`,
      deep_link: {
        label: "Check recovery →",
        href: "/coach/trends?section=performance",
      },
    };
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/proactive/render-card.ts
  git commit -m "feat(coach/proactive): deterministic card renderers"
  ```

### Task 1.7: index.ts orchestrator

**Files:**
- Create: `lib/coach/proactive/index.ts`

- [ ] **Step 1: Write the orchestrator**

  Create `lib/coach/proactive/index.ts`:

  ```ts
  // lib/coach/proactive/index.ts
  //
  // Orchestrator: takes a CoachTrendsPayload, runs all 3 trigger checks,
  // dedups against chat_messages (7-day window per trigger_key), and either
  // inserts the rendered card or reports it as suppressed.
  //
  // Caller responsibilities:
  //   - Compute the trends payload once (single generateCoachTrends call).
  //   - Pass a service-role supabase client (this writes chat_messages).
  //
  // The dry_run flag short-circuits the dedup lookup AND the insert — it
  // returns the set of events that WOULD fire on a clean slate. Used by
  // scripts/audit-proactive-cron.mjs.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type {
    CoachTrendsPayload,
    ProactiveEvent,
    ProactiveNudgeCard,
  } from "@/lib/data/types";
  import { checkPlateau } from "./check-plateau";
  import { checkOffPace } from "./check-off-pace";
  import { checkHrv } from "./check-hrv";
  import { renderCard } from "./render-card";

  const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  export type ProactiveRunResult = {
    fired: Array<{ event: ProactiveEvent; card: ProactiveNudgeCard }>;
    suppressed: Array<{ event: ProactiveEvent; reason: "dedup_7d" }>;
  };

  export async function runProactiveChecks(args: {
    supabase: SupabaseClient;
    userId: string;
    trends: CoachTrendsPayload;
    dry_run?: boolean;
  }): Promise<ProactiveRunResult> {
    const { supabase, userId, trends, dry_run } = args;

    const events: ProactiveEvent[] = [
      ...checkPlateau(trends),
      ...checkOffPace(trends),
      ...checkHrv(trends),
    ];

    const fired: ProactiveRunResult["fired"] = [];
    const suppressed: ProactiveRunResult["suppressed"] = [];

    for (const event of events) {
      const card = renderCard(event);

      if (dry_run) {
        fired.push({ event, card });
        continue;
      }

      // Dedup query — has a card for this trigger_key landed in the last 7d?
      const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
      const { data: recent, error: lookupErr } = await supabase
        .from("chat_messages")
        .select("id")
        .eq("user_id", userId)
        .eq("kind", "proactive_nudge")
        .filter("ui->>trigger_key", "eq", event.trigger_key)
        .gte("created_at", cutoff)
        .limit(1)
        .maybeSingle();
      if (lookupErr) {
        throw new Error(
          `proactive dedup lookup failed for ${event.trigger_key}: ${lookupErr.message}`,
        );
      }
      if (recent) {
        suppressed.push({ event, reason: "dedup_7d" });
        continue;
      }

      const { error: insertErr } = await supabase.from("chat_messages").insert({
        user_id: userId,
        role: "assistant",
        kind: "proactive_nudge",
        content: card.headline,
        ui: card,
      });
      if (insertErr) {
        throw new Error(
          `proactive insert failed for ${event.trigger_key}: ${insertErr.message}`,
        );
      }
      fired.push({ event, card });
    }

    return { fired, suppressed };
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/proactive/index.ts
  git commit -m "feat(coach/proactive): orchestrator with 7-day dedup"
  ```

### Task 1.8: Audit script

**Files:**
- Create: `scripts/audit-proactive-cron.mjs`

- [ ] **Step 1: Write the audit script**

  Create `scripts/audit-proactive-cron.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/audit-proactive-cron.mjs
  //
  // Read-only exercise of the proactive cron pipeline against the live
  // dev fixture. Runs the full compute (Sub-project #5's generateCoachTrends)
  // and the orchestrator in dry-run mode — prints which triggers WOULD fire
  // and the rendered card text. Does NOT insert into chat_messages.

  import { readFileSync } from "node:fs";
  import { resolve, dirname } from "node:path";
  import { fileURLToPath } from "node:url";
  import { createClient } from "@supabase/supabase-js";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "..");
  const env = {};
  for (const line of readFileSync(resolve(repoRoot, ".env.local"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("Missing env"); process.exit(1); }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data: profile } = await sb
    .from("profiles")
    .select("user_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  const userId = profile.user_id;
  const today = new Date().toISOString().slice(0, 10);

  const { generateCoachTrends } = await import("../lib/coach/trends/index.ts");
  const { runProactiveChecks } = await import("../lib/coach/proactive/index.ts");

  const trends = await generateCoachTrends({ supabase: sb, userId, today });
  const result = await runProactiveChecks({ supabase: sb, userId, trends, dry_run: true });

  console.log("=== TRENDS HEADLINE (for context) ===");
  console.log(`  [${trends.headline.severity}] ${trends.headline.title}`);

  console.log(`\n=== WOULD FIRE (${result.fired.length}) ===`);
  for (const { event, card } of result.fired) {
    console.log(`  • [${event.trigger_type}] key=${event.trigger_key}`);
    console.log(`    "${card.headline}"`);
    console.log(`    ${card.body_md}`);
    console.log(`    → ${card.deep_link.label} ${card.deep_link.href}`);
  }

  console.log(`\n=== WOULD BE SUPPRESSED (${result.suppressed.length}) ===`);
  for (const { event, reason } of result.suppressed) {
    console.log(`  • ${event.trigger_key}: ${reason}`);
  }

  console.log("\nNote: dry-run mode skips dedup lookup. Live cron suppresses by 7d window.");
  ```

- [ ] **Step 2: Run the audit script**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-proactive-cron.mjs
  ```

  Expected: prints HEADLINE + WOULD FIRE block listing at least one plateau event (Decline Bench Press from the dev fixture). Off-pace and HRV may or may not fire depending on fixture state — both are valid outcomes. The dry-run mode means dedup is bypassed; this is purely "what would the triggers say given current data?".

  If the script throws: report BLOCKED with the error. Do not push.

- [ ] **Step 3: Commit + push Slice 1**

  ```bash
  git add scripts/audit-proactive-cron.mjs
  git commit -m "chore(coach/proactive): dry-run audit script"
  git push -u origin feat/coach-proactive
  gh pr create --title "feat(coach): proactive reach-out compute (Slice 1/3)" --body "$(cat <<'EOF'
  ## Summary
  Sub-project #4 of the coach-as-real-coach arc — chat-side proactive cards.

  This slice ships the compute layer: migration 0015 extends `chat_messages.kind`, new types under `lib/data/types.ts` (`ProactiveTriggerType`, `ProactiveEvent`, `ProactiveNudgeCard`), three pure trigger functions consuming Sub-project #5's `CoachTrendsPayload`, a deterministic card renderer, an orchestrator with 7-day dedup via `chat_messages` lookup, and a dry-run audit script.

  No cron route, no UI integration — those land in Slices 2 + 3.

  ## Test plan
  - [x] `npm run typecheck` clean
  - [x] Migration applies + accepts probe insert with `kind='proactive_nudge'`
  - [x] Audit script runs against dev fixture, lists fired triggers
  - [ ] Slices 2 + 3 will land on this branch

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Capture the PR URL for use in Slice 2's notes.

---

## Slice 2 — Cron route

Goal: A working `/api/coach/proactive/check` endpoint that, when called with `Bearer ${CRON_SECRET}`, runs the compute + orchestrator and writes any fired cards. Vercel cron config updated. Manual invocation verified against the live DB.

### Task 2.1: Route handler

**Files:**
- Create: `app/api/coach/proactive/check/route.ts`

- [ ] **Step 1: Write the route**

  Create the directory and route:

  ```bash
  mkdir -p app/api/coach/proactive/check
  ```

  Create `app/api/coach/proactive/check/route.ts`:

  ```ts
  // app/api/coach/proactive/check/route.ts
  //
  // Vercel cron entrypoint. Daily at 11:00 UTC.
  // Computes coach trends once, evaluates 3 triggers, writes chat cards
  // with 7-day dedup. Idempotent: re-running same day writes 0 new cards.

  import { NextResponse } from "next/server";
  import { revalidatePath } from "next/cache";
  import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
  import { generateCoachTrends } from "@/lib/coach/trends";
  import { runProactiveChecks } from "@/lib/coach/proactive";

  export const dynamic = "force-dynamic";
  export const maxDuration = 60;

  export async function GET(req: Request) {
    const auth = req.headers.get("authorization") ?? "";
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || !auth.startsWith("Bearer ") || auth.slice(7) !== cronSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const sb = createSupabaseServiceRoleClient();

    // Single-user app: pick the first profile (same convention as weekly-review/sync).
    const { data: profile, error: pErr } = await sb
      .from("profiles")
      .select("user_id")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();
    if (pErr || !profile) {
      return NextResponse.json(
        { error: "no user", detail: pErr?.message },
        { status: 404 },
      );
    }
    const userId = profile.user_id as string;
    const today = new Date().toISOString().slice(0, 10);

    let trends;
    try {
      trends = await generateCoachTrends({ supabase: sb, userId, today });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: "trends compute failed", detail: msg },
        { status: 500 },
      );
    }

    let result;
    try {
      result = await runProactiveChecks({ supabase: sb, userId, trends });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: "proactive run failed", detail: msg },
        { status: 500 },
      );
    }

    if (result.fired.length > 0) {
      revalidatePath("/coach");
    }

    return NextResponse.json({
      ok: true,
      fired: result.fired.length,
      suppressed: result.suppressed.length,
      fired_keys: result.fired.map((f) => f.event.trigger_key),
      suppressed_keys: result.suppressed.map((s) => s.event.trigger_key),
    });
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: exit 0.

- [ ] **Step 3: Commit**

  ```bash
  git add app/api/coach/proactive/check/route.ts
  git commit -m "feat(api): /api/coach/proactive/check cron route"
  ```

### Task 2.2: Vercel cron entry

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add the cron entry**

  Open `vercel.json`. Find the `"crons": [ ... ]` array. Append a new entry inside the array (after the existing weekly-review entries, before the closing `]`):

  ```json
  {
    "path": "/api/coach/proactive/check",
    "schedule": "0 11 * * *"
  }
  ```

  The full `crons` array after the edit should contain 5 entries (2 WHOOP, 2 weekly-review, 1 proactive). Preserve the existing entries verbatim.

- [ ] **Step 2: Verify the JSON parses**

  ```bash
  node -e "console.log(JSON.parse(require('fs').readFileSync('vercel.json','utf-8')).crons.map(c => c.path))"
  ```

  Expected output (5 paths):
  ```
  [ '/api/whoop/sync', '/api/whoop/sync', '/api/coach/weekly-review/sync', '/api/coach/weekly-review/sync', '/api/coach/proactive/check' ]
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add vercel.json
  git commit -m "chore(vercel): cron entry for proactive check at 11:00 UTC daily"
  ```

### Task 2.3: Manual cron invocation against local dev

**Files:** (none new)

- [ ] **Step 1: Start the dev server**

  ```bash
  npm run dev > /tmp/dev-proactive.log 2>&1 &
  ```

  Wait for "Ready in ...ms" by tailing `/tmp/dev-proactive.log`.

- [ ] **Step 2: Hit the cron endpoint with the secret**

  Read `CRON_SECRET` from `.env.local`:

  ```bash
  CRON_SECRET=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2-)
  curl -s -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:3000/api/coach/proactive/check | head -30
  ```

  Expected: JSON response `{ "ok": true, "fired": N, "suppressed": M, "fired_keys": [...], "suppressed_keys": [...] }` with N ≥ 1 if at least the Decline Bench plateau fixture is active.

- [ ] **Step 3: Verify a row landed in chat_messages**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
  import { readFileSync } from 'fs';
  import { createClient } from '@supabase/supabase-js';
  const env = {};
  for (const l of readFileSync('.env.local','utf-8').split('\n')) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)\$/);
    if (m) env[m[1]] = m[2];
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: rows } = await sb.from('chat_messages').select('id, kind, content, ui, created_at').eq('kind', 'proactive_nudge').order('created_at', { ascending: false }).limit(5);
  console.log('proactive_nudge rows:');
  for (const r of rows ?? []) {
    console.log('  ', r.created_at, r.content);
    console.log('     ui.trigger_key:', r.ui?.trigger_key);
  }
  "
  ```

  Expected: at least one row, showing the headline as `content` and a populated `ui.trigger_key` matching what the audit script reported.

- [ ] **Step 4: Re-run the endpoint to verify dedup**

  ```bash
  curl -s -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:3000/api/coach/proactive/check | head -10
  ```

  Expected: JSON shows `"fired": 0` and `"suppressed": N` (same N as the previous run's `fired`). All trigger keys present in the prior run are now suppressed.

- [ ] **Step 5: Stop dev server**

  ```bash
  kill %1 || true
  ```

- [ ] **Step 6: Clean up the test rows (optional but recommended)**

  The cards inserted during Step 2 are real chat rows — they'll show up in the `/coach` feed once Slice 3 lands. If you'd rather they not appear until you've eyeballed the UI, delete them:

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
  import { readFileSync } from 'fs';
  import { createClient } from '@supabase/supabase-js';
  const env = {};
  for (const l of readFileSync('.env.local','utf-8').split('\n')) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)\$/);
    if (m) env[m[1]] = m[2];
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { count } = await sb.from('chat_messages').delete({ count: 'exact' }).eq('kind', 'proactive_nudge');
  console.log('deleted', count, 'rows');
  "
  ```

  Skip this if you want to see the cards render as soon as Slice 3 ships.

### Task 2.4: Push Slice 2

- [ ] **Step 1: Push and update PR**

  ```bash
  git push
  ```

  The new commits land on the open PR from Slice 1.

---

## Slice 3 — UI integration

Goal: `proactive_nudge` rows render in the `/coach` chat feed via a new `ProactiveNudgeCard` component. The kind-switch in `ChatThread.tsx` and the kindTag in `ChatMessage.tsx` both know about the new kind. CLAUDE.md documents the new layer.

### Task 3.1: ProactiveNudgeCard component

**Files:**
- Create: `components/chat/ProactiveNudgeCard.tsx`

- [ ] **Step 1: Write the component**

  Create `components/chat/ProactiveNudgeCard.tsx`:

  ```tsx
  "use client";
  import Link from "next/link";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import type { ProactiveNudgeCard as ProactiveNudgeCardUI } from "@/lib/data/types";

  /** Card rendered for chat_messages with kind='proactive_nudge'. Visual
   *  lineage mirrors WeeklyReviewCard.tsx — same Card wrapper, same Link
   *  CTA pattern, warn-colored severity tag. */
  export function ProactiveNudgeCard({ ui }: { ui: ProactiveNudgeCardUI }) {
    const accent = "#d97706"; // warn-amber, matches lib/coach/trends/ TrendsHeader

    return (
      <div style={{ padding: "6px 12px" }}>
        <Card>
          <SectionLabel>
            <span style={{ color: accent }}>{ui.severity.toUpperCase()}</span> · COACH
          </SectionLabel>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              marginTop: 6,
              color: COLOR.textStrong,
            }}
          >
            {ui.headline}
          </div>
          <p
            style={{
              fontSize: 12,
              color: COLOR.textMuted,
              marginTop: 6,
              lineHeight: 1.5,
            }}
          >
            {ui.body_md}
          </p>
          <Link
            href={ui.deep_link.href}
            style={{
              display: "inline-block",
              marginTop: 10,
              padding: "8px 12px",
              background: COLOR.accent,
              color: "#fff",
              borderRadius: 9999,
              fontWeight: 700,
              fontSize: 12,
              textDecoration: "none",
            }}
          >
            {ui.deep_link.label}
          </Link>
        </Card>
      </div>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/chat/ProactiveNudgeCard.tsx
  git commit -m "feat(chat): ProactiveNudgeCard component"
  ```

### Task 3.2: Dispatch site in ChatThread.tsx

**Files:**
- Modify: `components/chat/ChatThread.tsx`

- [ ] **Step 1: Add the import**

  Open `components/chat/ChatThread.tsx`. Find the imports near the top of the file (around lines 4-9):

  ```ts
  import { WeeklyReviewCard } from "@/components/chat/WeeklyReviewCard";
  import type { MorningBriefCard, WeeklyReviewCardUI } from "@/lib/data/types";
  ```

  Add a new import line below the `WeeklyReviewCard` import:

  ```ts
  import { ProactiveNudgeCard } from "@/components/chat/ProactiveNudgeCard";
  ```

  Extend the type import on the next line:

  ```ts
  import type { MorningBriefCard, WeeklyReviewCardUI, ProactiveNudgeCard as ProactiveNudgeCardUI } from "@/lib/data/types";
  ```

  (Aliasing the type to `ProactiveNudgeCardUI` avoids a name clash with the component import.)

- [ ] **Step 2: Add the dispatch case**

  Find the kind-switch ternary chain in the items map (around line 194-204). The existing structure renders three card kinds before falling through to `<ChatMessageView>`:

  ```tsx
  ) : it.m.kind === "morning_brief" ? (
    <MorningBriefCardComponent ... />
  ) : it.m.kind === "weekly_review" && it.m.ui ? (
    <WeeklyReviewCard ... />
  ) : (
    <ChatMessageView ... />
  ),
  ```

  Insert a new branch between the `weekly_review` case and the `<ChatMessageView>` fallback:

  ```tsx
  ) : it.m.kind === "morning_brief" ? (
    <MorningBriefCardComponent
      key={it.m.id}
      userId={userId}
      card={it.m.ui as MorningBriefCard}
    />
  ) : it.m.kind === "weekly_review" && it.m.ui ? (
    <WeeklyReviewCard
      key={it.m.id}
      ui={it.m.ui as WeeklyReviewCardUI}
    />
  ) : it.m.kind === "proactive_nudge" && it.m.ui ? (
    <ProactiveNudgeCard
      key={it.m.id}
      ui={it.m.ui as ProactiveNudgeCardUI}
    />
  ) : (
    <ChatMessageView
      key={it.m.id}
      message={it.m}
      onRetry={it.m.status === "error" ? () => onRetry(it.m.id) : undefined}
      onSendUserMessage={onSendUserMessage}
      onFocusComposer={onFocusComposer}
    />
  ),
  ```

  (Preserve the existing prop-passing for the other branches — only the new `proactive_nudge` branch is being added.)

- [ ] **Step 3: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/chat/ChatThread.tsx
  git commit -m "feat(chat): dispatch proactive_nudge to ProactiveNudgeCard in ChatThread"
  ```

### Task 3.3: KindTag in ChatMessage.tsx

**Files:**
- Modify: `components/chat/ChatMessage.tsx`

- [ ] **Step 1: Extend the kindTag chain**

  Open `components/chat/ChatMessage.tsx`. Find the `kindTag` ternary chain (around lines 51-58):

  ```ts
  const kindTag =
    message.kind === "morning_intake"
      ? " · Morning check-in"
      : message.kind === "morning_brief"
        ? " · Morning brief"
        : message.kind === "weekly_review"
          ? " · Weekly review"
          : "";
  ```

  Add a `proactive_nudge` branch before the empty-string fallback:

  ```ts
  const kindTag =
    message.kind === "morning_intake"
      ? " · Morning check-in"
      : message.kind === "morning_brief"
        ? " · Morning brief"
        : message.kind === "weekly_review"
          ? " · Weekly review"
          : message.kind === "proactive_nudge"
            ? " · Coach"
            : "";
  ```

  Note: `ChatMessageView` is the fallback renderer used for plain conversational messages. Since `proactive_nudge` rows are intercepted by `ChatThread.tsx`'s dispatch (Task 3.2) before ever reaching `ChatMessageView`, this kindTag mostly serves as defensive labeling for any future code path that ends up here.

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/chat/ChatMessage.tsx
  git commit -m "feat(chat): proactive_nudge kindTag in ChatMessage meta row"
  ```

### Task 3.4: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a bullet to the Coach / AI section**

  Open `CLAUDE.md`. Find the bullet for **Trend Layer** (added in Sub-project #5) in the Coach / AI section. Append a new bullet immediately after it (before the `### UI conventions` heading):

  ```markdown
  - **Proactive reach-out**: chat-side proactive coach layer — a daily cron at `/api/coach/proactive/check` (11:00 UTC, `CRON_SECRET`-gated) reads `generateCoachTrends({today})`, evaluates 3 deterministic triggers (`lib/coach/proactive/check-plateau.ts`, `check-off-pace.ts`, `check-hrv.ts`), and writes one `chat_messages.kind='proactive_nudge'` row per fired trigger. Triggers read raw signals (not `payload.headline`), so concurrent fires surface as separate cards. Card prose is pure templating ([lib/coach/proactive/render-card.ts](lib/coach/proactive/render-card.ts)) — no Anthropic calls. Dedup is via `chat_messages` lookup on `ui->>'trigger_key'` within a 7-day window (no separate dedup table — the chat history is the audit trail). Migration 0015 extends `chat_messages_kind_check`. UI renders via [components/chat/ProactiveNudgeCard.tsx](components/chat/ProactiveNudgeCard.tsx) dispatched from [components/chat/ChatThread.tsx](components/chat/ChatThread.tsx). Deep-links route to `/coach/trends?section=performance|composition`. No push notifications, no HMAC action chips — both deferred. Audit script: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-proactive-cron.mjs`. Spec: [docs/superpowers/specs/2026-05-16-proactive-coach-reach-out-design.md](docs/superpowers/specs/2026-05-16-proactive-coach-reach-out-design.md).
  ```

- [ ] **Step 2: Add the migration to the migrations list**

  Earlier in `CLAUDE.md`, find the "## Database migrations" section listing migrations 1-14 (or whatever the highest currently is). Add migration 15:

  ```markdown
  14. [supabase/migrations/0015_proactive_nudge.sql](supabase/migrations/0015_proactive_nudge.sql) — extends `chat_messages_kind_check` to include `'proactive_nudge'` for the sub-project #4 chat cards.
  ```

  (Renumber to match the existing pattern in the file — the migration list there uses ordinals like "13.", "14." as section headers; mirror that style.)

- [ ] **Step 3: Commit**

  ```bash
  git add CLAUDE.md
  git commit -m "docs(claude-md): document proactive reach-out + migration 0015"
  ```

### Task 3.5: Final walkthrough + close-out

- [ ] **Step 1: Run the audit script one more time as a regression check**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-proactive-cron.mjs | head -20
  ```

  Expected: same output shape as Slice 1 — still prints headline + WOULD FIRE block. (Slice 2's manual run + dedup test may have already written rows; the dry-run skips dedup so output is consistent.)

- [ ] **Step 2: Run dev server**

  ```bash
  npm run dev > /tmp/dev-proactive-final.log 2>&1 &
  ```

  Wait for "Ready in ...ms".

- [ ] **Step 3: Browser walkthrough**

  1. Open `http://localhost:3000/coach` (log in if needed). Scroll the chat feed to the most recent rows.
  2. Confirm any `proactive_nudge` rows inserted during Slice 2's manual test are rendered with the new card UI (warn severity tag, headline, body, deep-link button).
  3. Tap the deep-link — it should navigate to `/coach/trends?section=performance` or `?section=composition` depending on the trigger type.
  4. If you cleaned up the test rows at the end of Slice 2, re-invoke the cron endpoint manually to repopulate:
     ```bash
     CRON_SECRET=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2-)
     curl -s -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:3000/api/coach/proactive/check
     ```
     Then refresh the chat feed.

  Stop dev server: `kill %1 || true`.

- [ ] **Step 4: Retitle PR + push**

  ```bash
  git push
  PR_NUM=$(gh pr list --head feat/coach-proactive --json number --jq '.[0].number')
  gh pr edit "$PR_NUM" --title "feat(coach): proactive reach-out (Slices 1-3/3)"
  ```

  The PR now reflects the complete sub-project.

---

## Self-Review

After all three slices land, walk back through the spec ([docs/superpowers/specs/2026-05-16-proactive-coach-reach-out-design.md](../specs/2026-05-16-proactive-coach-reach-out-design.md)) and verify every Goal has a task that implements it:

- [ ] Goal 1 (three triggers fire chat cards) → Tasks 1.3, 1.4, 1.5.
- [ ] Goal 2 (cron is the only writer; 11:00 UTC) → Tasks 2.1, 2.2.
- [ ] Goal 3 (deterministic prose, no AI) → Task 1.6; verify `render-card.ts` has no `callClaude` import.
- [ ] Goal 4 (new `kind` value reusing chat infra) → Tasks 1.1, 1.2.
- [ ] Goal 5 (deep-link only, no new screens) → Task 1.6 templates all link to existing `/coach/trends` sections.
- [ ] Goal 6 (Sub-project #5 is the source of truth) → Task 2.1 calls `generateCoachTrends`; trigger functions read only from the payload.

Also confirm:

- [ ] No `coach_proactive_events` table was created (spec explicitly forbids it).
- [ ] No push notification code was added — only `chat_messages` writes.
- [ ] No HMAC propose/commit tooling was wired in.
- [ ] `npm run typecheck` exits 0.
- [ ] Audit script runs cleanly against the dev fixture.

When all three slices merge, the coach-as-real-coach arc (sub-projects 1–5) is complete.
