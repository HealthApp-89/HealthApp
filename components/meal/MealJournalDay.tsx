// components/meal/MealJournalDay.tsx
"use client";

import { fmtNum } from "@/lib/ui/score";
import type { FoodLogEntry } from "@/lib/food/types";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

export function MealJournalDay({
  entries,
  targets,
  date,
  onShiftDate,
}: {
  entries: FoodLogEntry[];
  targets: TodayTargets | null;
  date: string;
  onShiftDate: (delta: number) => void;
}) {
  const totals = entries.reduce(
    (a, e) => ({
      kcal: a.kcal + e.totals.kcal,
      p:    a.p    + e.totals.protein_g,
      c:    a.c    + e.totals.carbs_g,
      f:    a.f    + e.totals.fat_g,
      fb:   a.fb   + e.totals.fiber_g,
    }),
    { kcal: 0, p: 0, c: 0, f: 0, fb: 0 },
  );

  const targetKcal = targets?.kcal ?? null;
  const remaining = targetKcal !== null ? targetKcal - totals.kcal : null;

  const mealsLogged = new Set(entries.map((e) => e.meal_slot)).size;

  // Display date as weekday + month/day from the ISO string.
  const d = new Date(`${date}T00:00:00`);
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  const month = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <section className="rounded-lg border border-zinc-800 p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="text-lg font-semibold">{weekday} · {month}</div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">Daily journal</div>
        </div>
        <div className="flex gap-1 text-zinc-400">
          <button type="button" onClick={() => onShiftDate(-1)} aria-label="Previous day" className="px-2 py-1">‹</button>
          <button type="button" onClick={() => onShiftDate(1)}  aria-label="Next day"     className="px-2 py-1">›</button>
        </div>
      </header>

      <div className="mb-2 flex items-baseline justify-between text-xs uppercase tracking-wider text-zinc-500">
        <span>Eaten · Target · Remaining</span>
        <span>{mealsLogged} / 4 meals</span>
      </div>
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <span className="text-2xl font-semibold">{fmtNum(totals.kcal)}</span>
          <span className="ml-1 text-sm text-zinc-500">
            / {targetKcal !== null ? `${fmtNum(targetKcal)} kcal` : "—"}
          </span>
        </div>
        <div className="text-sm text-zinc-400">
          {remaining !== null ? `${fmtNum(remaining)} left` : ""}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs text-zinc-400">
        <MacroBar label="P"  eaten={totals.p}  target={targets?.protein_g} color="bg-green-500" />
        <MacroBar label="C"  eaten={totals.c}  target={targets?.carb_g}    color="bg-sky-500" />
        <MacroBar label="F"  eaten={totals.f}  target={targets?.fat_g}     color="bg-amber-500" />
        <MacroBar label="Fb" eaten={totals.fb} target={null}               color="bg-violet-500" />
      </div>
    </section>
  );
}

function MacroBar({
  label,
  eaten,
  target,
  color,
}: {
  label: string;
  eaten: number;
  target: number | null | undefined;
  color: string;
}) {
  const pct = target && target > 0 ? Math.min(100, (eaten / target) * 100) : 0;
  return (
    <div>
      <div className="mb-1">
        {label} {fmtNum(eaten)}{target ? ` / ${fmtNum(target)}` : ""}
      </div>
      <div className="h-1 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
