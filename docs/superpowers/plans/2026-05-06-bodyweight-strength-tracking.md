# Bodyweight Strength Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat any Strong-app set with 0 weight as bodyweight; track reps and total-reps progression in the strength tab, PR card, trend chart, coach prompts, and dashboard recent-lifts card.

**Architecture:** Read-time per-set classification (`!s.kg` ⇒ bodyweight). Exercise classification is history-wide and derived in [lib/data/workouts.ts](lib/data/workouts.ts) at load time. PR and trend types become discriminated unions on `kind: "weighted" | "bodyweight"`. No DB migration; only the Strong CSV ingest path is normalized so new imports persist `kg=null` instead of `kg=0`.

**Tech Stack:** Next.js 15 App Router, TypeScript (strict), Supabase, Anthropic SDK. **No test suite or linter exists** ([CLAUDE.md](CLAUDE.md)) — verification per task is `npm run typecheck` and a manual smoke at the end.

**Spec:** [docs/superpowers/specs/2026-05-06-bodyweight-strength-tracking-design.md](docs/superpowers/specs/2026-05-06-bodyweight-strength-tracking-design.md).

---

## Task ordering

Each task keeps `npm run typecheck` green when complete and is a single commit. Tasks that change a type union also update the consumers in the same commit, so the codebase compiles after every task.

1. Data foundation: `kind` + `bwReps` on `WorkoutExercise`/`WorkoutSession`.
2. PR discriminated union + `buildPRs` bodyweight branch + `PRList` rendering.
3. Trend discriminated union + `buildExerciseTrend` bodyweight branch + `ExerciseTrendCard` rendering.
4. `SessionTable` — BW labels, per-exercise summary, session-header reps fallback.
5. Strong CSV ingest — normalize `kg=0` → `null`.
6. Strength insights — `bw` flag in JSON + prompt update.
7. Coach snapshot — bodyweight top-set picker.
8. Dashboard recent-lifts — `bwReps` + reps fallback in `RecentLiftsCard`.

---

### Task 1: Data foundation — `kind` + `bwReps` in `loadWorkouts`

**Files:**
- Modify: [lib/data/workouts.ts](lib/data/workouts.ts)

This task only adds the new fields and populates them. PR/Trend types stay weighted-only here — they change in Tasks 2 and 3.

- [ ] **Step 1: Edit type definitions and `loadWorkouts`**

Open [lib/data/workouts.ts](lib/data/workouts.ts) and replace the `WorkoutExercise`, `WorkoutSession`, and `loadWorkouts` definitions (lines 12–103) with:

```ts
export type WorkoutExercise = {
  name: string;
  position: number;
  /** History-wide classification. "weighted" if any working set in this user's
   *  history has kg > 0; "bodyweight" otherwise. Computed in loadWorkouts. */
  kind: "weighted" | "bodyweight";
  sets: WorkoutSet[];
};

export type WorkoutSession = {
  id: string;
  date: string;
  type: string | null;
  duration_min: number | null;
  exercises: WorkoutExercise[];
  /** Total working volume in kg (kg × reps over weighted working sets). */
  vol: number;
  /** Total reps across bodyweight working sets (warmups excluded). */
  bwReps: number;
  /** Working set count (excludes warmup). */
  sets: number;
};

export type PR = {
  name: string;
  kg: number;
  reps: number;
  est1rm: number;
  date: string;
};

export type ExerciseTrendPoint = {
  date: string;
  kg: number;
  reps: number;
  est1rm: number;
};

/** Load every workout for the user, joined with exercises + sets. Newest first.
 *  Two passes over the result so each exercise gets a history-wide `kind`:
 *  exercises with at least one working weighted set anywhere in history are
 *  "weighted", otherwise "bodyweight". */
export async function loadWorkouts(userId: string): Promise<WorkoutSession[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workouts")
    .select(
      `id, date, type, duration_min,
       exercises(name, position,
         exercise_sets(kg, reps, duration_seconds, warmup, failure, set_index))`,
    )
    .eq("user_id", userId)
    .order("date", { ascending: false });

  if (error) throw error;

  type RawExercise = {
    name: string;
    position: number | null;
    exercise_sets: {
      kg: number | null;
      reps: number | null;
      duration_seconds: number | null;
      warmup: boolean;
      failure: boolean;
      set_index: number;
    }[];
  };

  const rawSessions = (data ?? []) as {
    id: string;
    date: string;
    type: string | null;
    duration_min: number | null;
    exercises: RawExercise[] | null;
  }[];

  // Pass 1: collect names of exercises that have at least one *working* set with
  // kg > 0 anywhere in the user's history. Warmups don't count — a single warmup
  // weighted row shouldn't flip an exercise to "weighted".
  const weightedNames = new Set<string>();
  for (const w of rawSessions) {
    for (const e of w.exercises ?? []) {
      for (const s of e.exercise_sets ?? []) {
        if (!s.warmup && (s.kg ?? 0) > 0) {
          weightedNames.add(e.name);
          break;
        }
      }
    }
  }

  // Pass 2: build sessions with classified exercises and split volumes.
  const sessions: WorkoutSession[] = [];
  for (const w of rawSessions) {
    const exercises: WorkoutExercise[] = (w.exercises ?? [])
      .map((e) => ({
        name: e.name,
        position: e.position ?? 0,
        kind: weightedNames.has(e.name)
          ? ("weighted" as const)
          : ("bodyweight" as const),
        sets: (e.exercise_sets ?? [])
          .slice()
          .sort((a, b) => a.set_index - b.set_index)
          .map((s) => ({
            kg: s.kg,
            reps: s.reps,
            duration_seconds: s.duration_seconds,
            warmup: s.warmup,
            failure: s.failure,
          })),
      }))
      .sort((a, b) => a.position - b.position);

    let vol = 0;
    let bwReps = 0;
    let setsCount = 0;
    for (const e of exercises) {
      for (const s of e.sets) {
        if (s.warmup) continue;
        setsCount += 1;
        if (s.kg && s.reps) vol += s.kg * s.reps;
        else if (!s.kg && s.reps) bwReps += s.reps;
      }
    }
    sessions.push({
      id: w.id,
      date: w.date,
      type: w.type,
      duration_min: w.duration_min,
      exercises,
      vol,
      bwReps,
      sets: setsCount,
    });
  }
  return sessions;
}
```

Leave `buildPRs` and `buildExerciseTrend` (lines 105–140) untouched in this task — they still consume the old shapes. They will change in Tasks 2 and 3.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors. The `kind` and `bwReps` fields are populated but no consumer reads them yet.

- [ ] **Step 3: Commit**

```bash
git add lib/data/workouts.ts
git commit -m "feat(strength): classify exercises bw/weighted in loadWorkouts

Adds history-wide kind on WorkoutExercise (set if any working set has kg>0
anywhere) and per-session bwReps total. No consumer changes yet."
```

---

### Task 2: PR discriminated union + bodyweight PRs

**Files:**
- Modify: [lib/data/workouts.ts](lib/data/workouts.ts) — `PR` type, `buildPRs`
- Modify: [components/strength/PRList.tsx](components/strength/PRList.tsx)

- [ ] **Step 1: Replace `PR` type and `buildPRs` in `lib/data/workouts.ts`**

Replace the existing `PR` type (lines 30–36) with:

```ts
export type PR =
  | {
      kind: "weighted";
      name: string;
      kg: number;
      reps: number;
      est1rm: number;
      date: string;
    }
  | {
      kind: "bodyweight";
      name: string;
      totalReps: number;
      bestSetReps: number;
      date: string;
    };
```

Replace `buildPRs` (existing lines ~105–120) with:

```ts
/** Per-exercise PR. Weighted exercises track highest est. 1RM working set;
 *  bodyweight exercises track the session with the most total working reps.
 *  Iteration is newest-first (matching loadWorkouts ordering) and uses
 *  strictly-greater comparisons so ties resolve to the newest session. */
export function buildPRs(workouts: WorkoutSession[]): PR[] {
  const prs = new Map<string, PR>();
  for (const w of workouts) {
    // Group bodyweight exercise sessions: per-exercise totals, computed once
    // per (workout, exercise) so we can compare totalReps across sessions.
    for (const e of w.exercises) {
      if (e.kind === "weighted") {
        for (const s of e.sets) {
          if (s.warmup || !s.kg || !s.reps) continue;
          const v = est1rm(s.kg, s.reps);
          const cur = prs.get(e.name);
          if (!cur || (cur.kind === "weighted" && v > cur.est1rm)) {
            prs.set(e.name, {
              kind: "weighted",
              name: e.name,
              kg: s.kg,
              reps: s.reps,
              est1rm: v,
              date: w.date,
            });
          }
        }
      } else {
        // bodyweight
        let totalReps = 0;
        let bestSetReps = 0;
        for (const s of e.sets) {
          if (s.warmup || s.kg || !s.reps) continue;
          totalReps += s.reps;
          if (s.reps > bestSetReps) bestSetReps = s.reps;
        }
        if (totalReps === 0) continue;
        const cur = prs.get(e.name);
        if (!cur || (cur.kind === "bodyweight" && totalReps > cur.totalReps)) {
          prs.set(e.name, {
            kind: "bodyweight",
            name: e.name,
            totalReps,
            bestSetReps,
            date: w.date,
          });
        }
      }
    }
  }
  // Weighted PRs first (sorted by 1RM desc), bodyweight PRs after (by total reps desc).
  const all = [...prs.values()];
  const weighted = all
    .filter((p): p is Extract<PR, { kind: "weighted" }> => p.kind === "weighted")
    .sort((a, b) => b.est1rm - a.est1rm);
  const bodyweight = all
    .filter((p): p is Extract<PR, { kind: "bodyweight" }> => p.kind === "bodyweight")
    .sort((a, b) => b.totalReps - a.totalReps);
  return [...weighted, ...bodyweight];
}
```

- [ ] **Step 2: Update `PRList` to render both variants**

Replace [components/strength/PRList.tsx](components/strength/PRList.tsx) entirely with:

```tsx
import { Card, SectionLabel } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type { PR } from "@/lib/data/workouts";
import { COLOR } from "@/lib/ui/theme";

export function PRList({ prs }: { prs: PR[] }) {
  if (!prs.length) return null;
  return (
    <Card tint="nutrition">
      <SectionLabel>🏆 PERSONAL RECORDS (best lift / most reps)</SectionLabel>
      {prs.map((pr) => (
        <div
          key={`${pr.kind}-${pr.name}`}
          className="flex justify-between items-center py-2"
          style={{ borderBottom: `1px solid ${COLOR.divider}` }}
        >
          <div>
            <div className="text-xs" style={{ color: COLOR.textStrong }}>
              {pr.name.split("(")[0].trim()}
            </div>
            <div className="text-[10px] mt-px" style={{ color: COLOR.textFaint }}>
              {pr.kind === "weighted"
                ? `${pr.kg}kg × ${pr.reps} · ${pr.date}`
                : `${pr.totalReps} reps total · ${pr.date}`}
            </div>
          </div>
          <div className="text-right flex flex-col items-end gap-1">
            <Pill tone="warning">
              {pr.kind === "weighted" ? `${pr.est1rm} kg 1RM` : `${pr.totalReps} reps`}
            </Pill>
            <div className="text-[9px]" style={{ color: COLOR.textFaint }}>
              {pr.kind === "weighted" ? "est. 1RM" : "best total reps"}
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add lib/data/workouts.ts components/strength/PRList.tsx
git commit -m "feat(strength): bodyweight PRs (best total reps per session)

PR is now a discriminated union; weighted exercises track est 1RM (today's
behavior), bodyweight exercises track the session with the most total
working reps. PRList renders both variants."
```

---

### Task 3: Trend discriminated union + bodyweight trend chart

**Files:**
- Modify: [lib/data/workouts.ts](lib/data/workouts.ts) — `ExerciseTrendPoint`, `buildExerciseTrend`
- Modify: [components/strength/ExerciseTrendCard.tsx](components/strength/ExerciseTrendCard.tsx)

- [ ] **Step 1: Replace `ExerciseTrendPoint` and `buildExerciseTrend`**

In [lib/data/workouts.ts](lib/data/workouts.ts), replace the existing `ExerciseTrendPoint` type (lines ~38–43) with:

```ts
export type ExerciseTrendPoint =
  | { kind: "weighted"; date: string; kg: number; reps: number; est1rm: number }
  | { kind: "bodyweight"; date: string; totalReps: number; bestSetReps: number };
```

Replace `buildExerciseTrend` (existing lines ~123–140) with:

```ts
/** One trend point per session for `name`, oldest → newest.
 *  Weighted exercises: heaviest working set's est. 1RM (sessions with no
 *    weighted working set are skipped).
 *  Bodyweight exercises: total reps across bodyweight working sets that day.
 *  An exercise's history-wide `kind` (set in loadWorkouts) decides which path. */
export function buildExerciseTrend(
  workouts: WorkoutSession[],
  name: string,
): ExerciseTrendPoint[] {
  // Find the exercise's history-wide kind from the first session that contains it.
  // If the exercise doesn't appear in any session, return [].
  let kind: "weighted" | "bodyweight" | null = null;
  for (const w of workouts) {
    const ex = w.exercises.find((e) => e.name === name);
    if (ex) {
      kind = ex.kind;
      break;
    }
  }
  if (!kind) return [];

  const points: ExerciseTrendPoint[] = [];
  const sorted = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of sorted) {
    const ex = w.exercises.find((e) => e.name === name);
    if (!ex) continue;
    if (kind === "weighted") {
      const working = ex.sets.filter((s) => !s.warmup && s.kg && s.reps);
      if (!working.length) continue;
      const best = working.reduce((a, b) => (b.kg! > a.kg! ? b : a));
      points.push({
        kind: "weighted",
        date: w.date,
        kg: best.kg!,
        reps: best.reps!,
        est1rm: est1rm(best.kg!, best.reps!),
      });
    } else {
      let totalReps = 0;
      let bestSetReps = 0;
      for (const s of ex.sets) {
        if (s.warmup || s.kg || !s.reps) continue;
        totalReps += s.reps;
        if (s.reps > bestSetReps) bestSetReps = s.reps;
      }
      if (totalReps === 0) continue;
      points.push({ kind: "bodyweight", date: w.date, totalReps, bestSetReps });
    }
  }
  return points;
}
```

- [ ] **Step 2: Update `ExerciseTrendCard`**

Replace [components/strength/ExerciseTrendCard.tsx](components/strength/ExerciseTrendCard.tsx) entirely with:

```tsx
import Link from "next/link";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import type { ExerciseTrendPoint } from "@/lib/data/workouts";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";

type Props = {
  name: string;
  points: ExerciseTrendPoint[];
};

export function ExerciseTrendCard({ name, points }: Props) {
  const last = points[points.length - 1];
  const display = name.split("(")[0].trim();
  const accentColor = METRIC_COLOR.strain; // amber — fits strength/1RM trend
  const isBodyweight = points.length > 0 && points[0].kind === "bodyweight";

  const chartData: LinePoint[] = points.map((p) => ({
    x: p.date.slice(5),
    y: p.kind === "weighted" ? p.est1rm : p.totalReps,
  }));

  return (
    <div
      className="rounded-[14px] px-4 py-3.5"
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        boxShadow: "0 2px 8px rgba(20,30,80,0.05)",
      }}
    >
      <div className="flex justify-between items-center mb-2.5">
        <span className="text-[10px] uppercase tracking-[0.1em]" style={{ color: accentColor }}>
          📈 {display}
        </span>
        <Link
          href="/strength"
          scroll={false}
          aria-label="Close exercise trend"
          className="p-2 -m-2 rounded-full text-lg leading-none touch-manipulation select-none"
          style={{ color: COLOR.textFaint }}
        >
          ×
        </Link>
      </div>
      {points.length >= 2 ? (
        <div>
          <LineChart data={chartData} color={accentColor} variant="mini" height={48} />
          <div className="flex justify-between mt-1.5 mb-3">
            {points.map((p) => (
              <div key={p.date} className="text-center">
                <div className="text-[8px]" style={{ color: COLOR.textFaint }}>
                  {p.date.slice(5)}
                </div>
                <div className="text-[10px] font-mono" style={{ color: accentColor }}>
                  {p.kind === "weighted" ? p.est1rm : p.totalReps}
                </div>
              </div>
            ))}
          </div>
          {last && last.kind === "weighted" && (
            <div className="flex gap-2.5">
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>BEST SET</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.kg}kg × {last.reps}
                </div>
              </div>
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>EST. 1RM</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.est1rm} kg
                </div>
              </div>
            </div>
          )}
          {last && last.kind === "bodyweight" && (
            <div className="flex gap-2.5">
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>BEST SET</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.bestSetReps} reps
                </div>
              </div>
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>TOTAL REPS</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.totalReps}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-center py-3" style={{ color: COLOR.textFaint }}>
          {isBodyweight
            ? "Only 1 session — log more to see rep progression"
            : "Only 1 session — log more to see progression"}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add lib/data/workouts.ts components/strength/ExerciseTrendCard.tsx
git commit -m "feat(strength): bodyweight exercise trend (total reps over time)

ExerciseTrendPoint becomes a discriminated union. buildExerciseTrend
dispatches on the exercise's history-wide kind. ExerciseTrendCard renders
total-reps line and BEST SET / TOTAL REPS tiles for bodyweight."
```

---

### Task 4: SessionTable — BW labels, summaries, header

**Files:**
- Modify: [components/strength/SessionTable.tsx](components/strength/SessionTable.tsx)

- [ ] **Step 1: Replace SessionTable with bodyweight-aware rendering**

Replace [components/strength/SessionTable.tsx](components/strength/SessionTable.tsx) entirely with:

```tsx
import type { WorkoutSession, WorkoutExercise } from "@/lib/data/workouts";
import { est1rm } from "@/lib/ui/score";
import { WCOLORS } from "@/lib/ui/colors";
import { Card } from "@/components/ui/Card";
import { fmtNum } from "@/lib/ui/score";
import { COLOR } from "@/lib/ui/theme";

type Props = {
  session: WorkoutSession;
};

/** Render one workout as a table: exercise headings + per-set rows.
 *  Warmup sets render dim. Failure sets get a flame tag. Bodyweight sets
 *  (kg falsy with reps present) render "BW" in the Weight column. */
export function SessionTable({ session }: Props) {
  const wc = WCOLORS[session.type ?? "Other"] ?? "#888";
  const workingSets = session.sets;
  const allBodyweight = session.vol === 0 && session.bwReps > 0;

  return (
    <Card tintColor={wc}>
      {/* Session header — type pill + date + volume + working set count */}
      <div className="flex justify-between items-baseline mb-3 flex-wrap gap-2">
        <div className="flex gap-2 items-center">
          <span
            className="rounded-full"
            style={{ width: 8, height: 8, background: wc, boxShadow: `0 0 6px ${wc}` }}
          />
          <span className="text-sm font-semibold" style={{ color: COLOR.textStrong }}>
            {session.type ?? "Workout"}
          </span>
          <span className="text-[10px]" style={{ color: COLOR.textFaint }}>{session.date}</span>
        </div>
        <div className="flex gap-3 text-[10px] font-mono" style={{ color: COLOR.textMuted }}>
          {session.duration_min != null && <span>{session.duration_min} min</span>}
          <span>
            {workingSets} working {workingSets === 1 ? "set" : "sets"}
          </span>
          {session.vol > 0 && (
            <span style={{ color: wc }}>{(session.vol / 1000).toFixed(1)}k kg vol</span>
          )}
          {allBodyweight && (
            <span style={{ color: wc }}>{session.bwReps} reps total</span>
          )}
        </div>
      </div>

      {session.exercises.length === 0 ? (
        <div className="text-xs italic py-6 text-center" style={{ color: COLOR.textMuted }}>
          No exercises in this session.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {session.exercises.map((e) => (
            <ExerciseBlock key={`${e.name}-${e.position}`} exercise={e} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ExerciseBlock({ exercise: e }: { exercise: WorkoutExercise }) {
  // Per-exercise summary line. Weighted exercises show top weighted set + kg vol;
  // bodyweight exercises show top reps in a single set + total reps for the day.
  let summary: string | null = null;
  if (e.kind === "weighted") {
    const working = e.sets.filter((s) => !s.warmup && s.kg && s.reps);
    const top = working.length
      ? working.reduce((a, b) => (est1rm(b.kg!, b.reps!) > est1rm(a.kg!, a.reps!) ? b : a))
      : null;
    const exVol = working.reduce((acc, s) => acc + (s.kg ?? 0) * (s.reps ?? 0), 0);
    if (top) summary = `top ${fmtNum(top.kg!)}×${top.reps} · ${fmtNum(exVol)} kg vol`;
  } else {
    let topReps = 0;
    let totalReps = 0;
    for (const s of e.sets) {
      if (s.warmup || s.kg || !s.reps) continue;
      totalReps += s.reps;
      if (s.reps > topReps) topReps = s.reps;
    }
    if (totalReps > 0) summary = `top ${topReps} reps · ${totalReps} reps total`;
  }

  return (
    <div>
      <div className="flex justify-between items-baseline mb-1.5 gap-2">
        <span className="text-[12px] font-semibold" style={{ color: COLOR.textStrong }}>
          {e.name}
        </span>
        {summary && (
          <span className="text-[10px] font-mono whitespace-nowrap" style={{ color: COLOR.textMuted }}>
            {summary}
          </span>
        )}
      </div>
      <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${COLOR.divider}` }}>
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr style={{ color: COLOR.textMuted, background: COLOR.surfaceAlt }}>
              <th className="text-left px-2.5 py-1 w-12 font-normal">Set</th>
              <th className="text-right px-2.5 py-1 font-normal">Weight</th>
              <th className="text-right px-2.5 py-1 font-normal">Reps</th>
              <th className="text-right px-2.5 py-1 font-normal">est 1RM</th>
              <th className="text-right px-2.5 py-1 w-14 font-normal">Flag</th>
            </tr>
          </thead>
          <tbody>
            {e.sets.map((s, i) => {
              const r1 = s.kg && s.reps ? est1rm(s.kg, s.reps) : null;
              const isBodyweight = !s.kg && s.reps != null;
              const isCardio = s.duration_seconds != null && !s.kg && !s.reps;
              return (
                <tr
                  key={i}
                  className="border-t"
                  style={{
                    borderColor: COLOR.divider,
                    opacity: s.warmup ? 0.45 : 1,
                  }}
                >
                  <td className="px-2.5 py-1" style={{ color: COLOR.textMid }}>{i + 1}</td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textStrong }}>
                    {isBodyweight ? "BW" : s.kg != null ? fmtNum(s.kg) : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textStrong }}>
                    {s.reps != null ? s.reps : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textMid }}>
                    {r1 != null ? fmtNum(r1) : isCardio ? `${s.duration_seconds}s` : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right">
                    {s.warmup && (
                      <span
                        className="text-[9px] px-1 rounded"
                        style={{ background: COLOR.surfaceAlt, color: COLOR.textMid }}
                      >
                        W
                      </span>
                    )}
                    {s.failure && (
                      <span
                        className="text-[9px] px-1 rounded ml-1"
                        style={{ background: COLOR.dangerSoft, color: COLOR.danger }}
                        title="trained to failure"
                      >
                        F
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add components/strength/SessionTable.tsx
git commit -m "feat(strength): SessionTable shows BW + bodyweight summaries

Sets with kg falsy and reps present render \"BW\" in the Weight column.
Per-exercise summary line branches on exercise kind: weighted shows top
kg×reps + kg vol (today); bodyweight shows top reps + total reps.
Session header shows \"N reps total\" for all-bodyweight sessions."
```

---

### Task 5: Strong CSV ingest — normalize `kg=0` → `null`

**Files:**
- Modify: [app/api/ingest/strong/route.ts:160](app/api/ingest/strong/route.ts#L160)

- [ ] **Step 1: Edit the CSV row mapping**

In [app/api/ingest/strong/route.ts](app/api/ingest/strong/route.ts) at line 160, change:

```ts
weightKg: iWeight >= 0 ? num(row[iWeight]) : null,
```

to:

```ts
// Strong CSV writes "0.0" for bodyweight exercises. Normalize to null so the
// CSV path matches the text-share parser (which already returns kg=null for
// bodyweight). Read paths classify with `!s.kg`, so old kg=0 rows are unaffected.
weightKg: iWeight >= 0 ? (num(row[iWeight]) || null) : null,
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/ingest/strong/route.ts
git commit -m "fix(ingest/strong): normalize kg=0 to null in CSV path

Aligns CSV ingest with the text-share parser (which already returns
kg=null for bodyweight). Read paths use !s.kg so existing kg=0 rows
still classify correctly — no migration needed."
```

---

### Task 6: Strength insights — `bw` flag in JSON + prompt update

**Files:**
- Modify: [app/api/insights/strength/route.ts](app/api/insights/strength/route.ts)

- [ ] **Step 1: Update the per-exercise compact JSON**

In [app/api/insights/strength/route.ts](app/api/insights/strength/route.ts), replace the `byEx` build (lines 53–65) with:

```ts
  // Build a compact per-exercise history. Bodyweight sets are tagged with
  // `bw: true` so the model knows to track reps rather than kg.
  const byEx = new Map<
    string,
    { date: string; sets: { kg: number | null; reps: number | null; bw: boolean; failure: boolean }[] }[]
  >();
  for (const w of workouts) {
    for (const e of w.exercises) {
      const prev = byEx.get(e.name) ?? [];
      prev.push({
        date: w.date,
        sets: e.sets
          .filter((s) => !s.warmup && (s.kg || s.reps))
          .map((s) => ({ kg: s.kg, reps: s.reps, bw: !s.kg, failure: s.failure })),
      });
      byEx.set(e.name, prev);
    }
  }
```

- [ ] **Step 2: Update the user prompt**

Replace the `userPrompt` template (existing lines ~71–87) with:

```ts
  const userPrompt = `Per-exercise history for an intermediate lifter (BW ~105kg, age 36, 2 weeks of data).
Sets with \`bw: true\` are bodyweight; track progress in reps, not kg.
${JSON.stringify(compact, null, 2)}

For EACH exercise produce a recommendation. Output JSON:
{
  "summary": {"total_sessions": <int>, "total_exercises_tracked": <int>, "weeks": <int>},
  "exercises": {
    "<name>": {
      "category": "Chest|Back|Legs|Shoulders|Arms|Core|Cardio",
      "priority": "high|medium|low",
      "sessions": <int>,
      "next_target": "<kg> × <reps>×<sets>, or '<reps>×<sets>' for bodyweight, or 'Skip' / specific cue",
      "recommendation": "2-3 sentences with numbers, comparing W1 vs W2 where possible. Reference est 1RM for weighted lifts; reference total reps for bodyweight."
    }
  }
}
Categorise compound barbell lifts as priority high. Isolation accessories medium. Bodyweight warm-ups low.`;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/insights/strength/route.ts
git commit -m "feat(coach): tag bodyweight sets in strength insights prompt

Adds bw: true on sets where kg is falsy in the compact JSON sent to
Claude, plus an instruction line and a bodyweight next_target schema
variant so recommendations reference reps for bodyweight exercises."
```

---

### Task 7: Coach snapshot — bodyweight top-set picker

**Files:**
- Modify: [lib/coach/snapshot.ts:100-105](lib/coach/snapshot.ts#L100-L105)

- [ ] **Step 1: Replace the top-set picker**

In [lib/coach/snapshot.ts](lib/coach/snapshot.ts), replace lines 100–105 (the `top:` block inside `recent`) with:

```ts
    top: w.exercises.slice(0, 4).map((e) => {
      // Prefer the heaviest weighted working set for this session. If the
      // exercise has only bodyweight working sets in this session, fall back
      // to the set with the most reps and label "BW×<reps>".
      const weighted = e.sets
        .filter((s) => !s.warmup && s.kg && s.reps)
        .sort((a, b) => b.kg! - a.kg!)[0];
      if (weighted) return `${e.name} ${weighted.kg}×${weighted.reps}`;
      const bw = e.sets
        .filter((s) => !s.warmup && !s.kg && s.reps)
        .sort((a, b) => b.reps! - a.reps!)[0];
      if (bw) return `${e.name} BW×${bw.reps}`;
      return e.name;
    }),
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/snapshot.ts
git commit -m "feat(coach): bodyweight top-set picker in snapshot

When an exercise's session has only bodyweight working sets, render
\"<name> BW×<reps>\" using the highest-rep set instead of falling back
to the bare exercise name."
```

---

### Task 8: Dashboard recent-lifts — `bwReps` + reps fallback

**Files:**
- Modify: [components/dashboard/RecentLiftsCard.tsx](components/dashboard/RecentLiftsCard.tsx)
- Modify: [app/page.tsx](app/page.tsx) (the `recentSessions` mapping, around lines 237–256)

- [ ] **Step 1: Extend `RecentSession` and the card render**

Replace [components/dashboard/RecentLiftsCard.tsx](components/dashboard/RecentLiftsCard.tsx) entirely with:

```tsx
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type RecentSession = {
  date: string;       // e.g. "MON 4"
  title: string;      // e.g. "Lower body · Squat"
  volumeKg: number;
  bwReps: number;     // total bodyweight reps for the session (working sets)
};

type RecentLiftsCardProps = {
  sessions: RecentSession[]; // pass at most 2; renders nothing if empty
};

export function RecentLiftsCard({ sessions }: RecentLiftsCardProps) {
  return (
    <Link href="/strength?view=recent" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Recent lifts
          </span>
          <span style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 600 }}>View all ›</span>
        </div>
        {sessions.length === 0 ? (
          <p style={{ fontSize: "13px", color: COLOR.textFaint, padding: "8px 0" }}>
            No recent sessions in the last 14 days.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {sessions.slice(0, 2).map((s) => (
              <div
                key={s.date}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: `1px solid ${COLOR.divider}` }}
              >
                <div>
                  <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.06em" }}>{s.date}</div>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: COLOR.textStrong, marginTop: "2px" }}>{s.title}</div>
                </div>
                <div data-tnum style={{ fontSize: "12px", color: COLOR.accent, fontWeight: 600 }}>
                  {s.volumeKg > 0 ? `${fmtNum(s.volumeKg)} kg` : `${s.bwReps} reps`}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Link>
  );
}
```

- [ ] **Step 2: Compute `bwReps` when building `recentSessions` in `app/page.tsx`**

In [app/page.tsx](app/page.tsx), find the `recentSessions` build block (lines ~237–256). The existing code is:

```ts
  const recentSessions: RecentSession[] = (recentWorkoutsRaw as RawWorkout[] | null ?? []).map((w) => {
    let vol = 0;
    for (const e of w.exercises ?? []) {
      for (const s of e.exercise_sets ?? []) {
        if (!s.warmup && s.kg && s.reps) vol += s.kg * s.reps;
      }
    }
    const firstName = (w.exercises ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.name;
    const title = w.type
      ? firstName
        ? `${w.type} · ${firstName}`
        : w.type
      : firstName ?? "Workout";
    return {
      date: formatShortDate(w.date),
      title,
```

Replace it with:

```ts
  const recentSessions: RecentSession[] = (recentWorkoutsRaw as RawWorkout[] | null ?? []).map((w) => {
    let vol = 0;
    let bwReps = 0;
    for (const e of w.exercises ?? []) {
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue;
        if (s.kg && s.reps) vol += s.kg * s.reps;
        else if (!s.kg && s.reps) bwReps += s.reps;
      }
    }
    const firstName = (w.exercises ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.name;
    const title = w.type
      ? firstName
        ? `${w.type} · ${firstName}`
        : w.type
      : firstName ?? "Workout";
    return {
      date: formatShortDate(w.date),
      title,
      bwReps,
```

(The change adds `bwReps` to the accumulator loop and to the returned object — `volumeKg: vol` is already returned a few lines below the cut. Verify that the closing return object includes `volumeKg: vol` from the existing code; the only addition needed is `bwReps`.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx components/dashboard/RecentLiftsCard.tsx
git commit -m "feat(dashboard): show reps for all-bodyweight recent sessions

Recent-lifts card now shows '{N} reps' instead of '0 kg' when a session
has no weighted working sets. RecentSession gains bwReps; app/page.tsx
sums bodyweight working reps alongside vol."
```

---

### Final smoke test

After Task 8, run a manual smoke before merging.

- [ ] **Step 1: Typecheck the whole project once more**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Boot dev**

Run: `npm run dev`
Open http://localhost:3000.

- [ ] **Step 3: Verify the strength tab**

Navigate to `/strength?view=recent`.
- 🏆 PERSONAL RECORDS card should list bodyweight exercises (e.g., Push Up, Back Extension) with rows like "Push Up — 60 reps total · YYYY-MM-DD" and a "60 reps" badge captioned "best total reps".
- Tap a bodyweight exercise row in RECENT SESSIONS. The trend card should render a mini line of total reps with date labels and tiles "BEST SET (X reps)" / "TOTAL REPS (Y)".

Navigate to `/strength?view=date&date=<a date with bodyweight sets>`.
- Each bodyweight set should show "BW" in the Weight column.
- Per-exercise summary should read "top X reps · Y reps total".
- If the entire session is bodyweight, the session header should read "N reps total" instead of "0.0k kg vol".

- [ ] **Step 4: Verify the dashboard**

Navigate to `/`.
- "Recent lifts" card: weighted/mixed sessions show "X kg"; all-bodyweight sessions show "Y reps".

- [ ] **Step 5: Verify the coach insights**

On `/strength?view=recent`, click "Run strength coach" (or "Refresh strength coach").
- Wait for completion.
- The CoachCards block should appear with `next_target` strings using rep notation (e.g., "3×25") for bodyweight exercises and "<kg>×<reps>×<sets>" for weighted.

- [ ] **Step 6: (Optional) Re-import a fresh Strong CSV**

Upload a Strong CSV from `/profile`. Confirm the import succeeds and that bodyweight rows show up in `/strength` with the bodyweight treatment described above. (This validates the kg=0 → null normalization on the new ingest path.)

---

## Self-review

1. **Spec coverage check:**
   - Decisions 1, 2 → Task 1 (set/exercise classification). ✅
   - Decision 3 → Task 2 (PRs). ✅
   - Decision 4 → Task 3 (trend chart). ✅
   - Decision 5 → Task 4 (SessionTable). ✅
   - Decision 6 → Task 5 (CSV ingest normalization). ✅
   - Decision 7 → Task 6 (insights prompt). ✅
   - Decision 8 → Task 7 (coach snapshot). ✅
   - Decision 9 → Task 8 (dashboard). ✅
   - Decision 10 (no change to est1rm / weighted-volume / weekly volume) → no task needed. ✅

2. **Edge cases covered:**
   - Cardio rows: Task 4 uses `!s.kg && s.reps != null` so cardio sets (kg & reps null) don't get the BW label. ✅
   - Warmup bodyweight sets: Task 1's pass 1 only counts non-warmup weighted sets toward `weightedNames`; Task 2/3/4 all skip warmups in bodyweight aggregations. ✅
   - Empty exercises: `kind` defaults to "bodyweight" in Task 1, and Tasks 2/3 skip bodyweight aggregations when totalReps is 0 — no PR/trend point produced. ✅
   - Tie-breaking: Tasks 2/3 iterate newest-first with strict-greater comparison. ✅

3. **Type consistency:**
   - `WorkoutExercise.kind`, `WorkoutSession.bwReps` defined in Task 1, consumed in Tasks 2/3/4. ✅
   - `PR` discriminated union (Task 2) consumed in `PRList` (Task 2, same commit). ✅
   - `ExerciseTrendPoint` discriminated union (Task 3) consumed in `ExerciseTrendCard` (Task 3, same commit). ✅
   - `RecentSession` extended in Task 8; the only consumer (`app/page.tsx`) updated in the same task. ✅

4. **Placeholder scan:** No "TBD", "TODO", or "implement later". All code blocks contain runnable code. The smoke test step uses real concrete checks tied to the spec's verification list.
