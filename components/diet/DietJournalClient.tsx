// components/diet/DietJournalClient.tsx
"use client";

import { useMemo, useState } from "react";
import { NutritionView } from "./NutritionView";
import ChatPanel from "@/components/chat/ChatPanel";
import { HealthClient } from "@/components/health/HealthClient";
import { useRouter } from "next/navigation";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";
import { FoodEntryEditSheet } from "@/components/log/FoodEntryEditSheet";
import { HistoryPickerSheet } from "@/components/log/HistoryPickerSheet";
import { SummaryCard } from "./SummaryCard";
import { MealSlotCardCollapsed } from "./MealSlotCardCollapsed";
import { JournalLibraryStrip } from "./JournalLibraryStrip";
import { targetsForAllSlots } from "@/lib/food/meal-targets";
import { MEAL_SLOTS } from "@/lib/food/meal-slot";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

type DietView = "journal" | "nutrition" | "body" | "coach";

type Props = {
  userId: string;
  initialDate: string;
  initialView?: DietView;
  /** Today, ISO yyyy-mm-dd — passed through to HealthClient for the Body tab. */
  todayIso: string;
  /** 12 months before today, ISO — start of the body-comp Trend window. */
  trendFromIso: string;
};

export function DietJournalClient({ userId, initialDate, initialView, todayIso, trendFromIso }: Props) {
  const router = useRouter();
  const [view, setView] = useState<DietView>(initialView ?? "journal");
  const [loggerOpen, setLoggerOpen] = useState<MealSlot | null>(null);
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);
  const [historyPickerOpen, setHistoryPickerOpen] = useState<MealSlot | null>(null);

  // `initialDate` is the SSR-resolved date; the /diet page drives date via
  // the URL param, so navigation (prev/next day) uses router.push like
  // MealJournalClient does for /meal.
  const date = initialDate;

  const { data: entries = [] } = useFoodEntries(userId, date, date);
  const { data: targets } = useTodayTargets(userId, date);
  const { data: dailyLogs = [] } = useDailyLogs(userId, date, date);

  const dailyLog = dailyLogs[0] ?? null;

  const shift = (deltaDays: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    router.push(`/diet?date=${d.toISOString().slice(0, 10)}`);
  };

  const setViewAndUrl = (next: DietView) => {
    setView(next);
    const sp = new URLSearchParams();
    if (date !== todayInUserTz()) sp.set("date", date);
    if (next !== "journal") sp.set("view", next);
    const qs = sp.toString();
    router.replace(qs ? `/diet?${qs}` : "/diet", { scroll: false });
  };

  // Per-meal kcal targets — derive from day target + meal_ratios.
  // targetsForAllSlots takes (dayKcal, ratios) separately, not a targets obj.
  const slotTargets = useMemo(() => {
    if (!targets) return null;
    return targetsForAllSlots(targets.kcal, targets.meal_ratios);
  }, [targets]);

  const entriesBySlot = useMemo(() => {
    const grouped: Record<MealSlot, FoodLogEntry[]> = {
      breakfast: [], lunch: [], dinner: [], snack: [],
    };
    for (const e of entries) grouped[e.meal_slot].push(e);
    return grouped;
  }, [entries]);

  // Macro totals from committed food entries (mirrors MealJournalDay approach).
  const macroTotals = useMemo(
    () =>
      entries.reduce(
        (a, e) => ({
          kcal:      a.kcal      + e.totals.kcal,
          protein_g: a.protein_g + e.totals.protein_g,
          carbs_g:   a.carbs_g   + e.totals.carbs_g,
          fat_g:     a.fat_g     + e.totals.fat_g,
        }),
        { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
      ),
    [entries],
  );

  // Prefer the daily_log aggregated value (set by sum_food_entries on commit)
  // over the live sum — they should match; fall back to live sum for instant
  // optimistic feedback before reaggregation completes.
  const eaten  = dailyLog?.calories_eaten ?? macroTotals.kcal;
  const burned = dailyLog?.active_calories ?? null;
  const target = targets?.kcal ?? 0;

  // initialEatenAt: same logic as MealJournalClient.
  const initialEatenAtForLogger = (): string => {
    if (date === todayInUserTz()) return new Date().toISOString();
    return `${date}T12:00:00.000Z`;
  };

  // Derive display date parts for the inline scrubber.
  const d = new Date(`${date}T00:00:00`);
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  const monthDay = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const isToday = date === todayInUserTz();

  return (
    <main className="mx-auto max-w-md px-0 pt-6 pb-32">
      {/* Tab bar — Journal / Nutrition / Coach */}
      <div className="flex gap-2 px-4 pt-3 pb-1">
        <button
          type="button"
          onClick={() => setViewAndUrl("journal")}
          className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
          style={{
            background: view === "journal" ? COLOR.textStrong : "#f3f4f6",
            color: view === "journal" ? "#fff" : COLOR.textMuted,
            border: `1px solid ${view === "journal" ? COLOR.textStrong : "#d1d5db"}`,
          }}
        >
          Journal
        </button>
        <button
          type="button"
          onClick={() => setViewAndUrl("nutrition")}
          className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
          style={{
            background: view === "nutrition" ? COLOR.textStrong : "#f3f4f6",
            color: view === "nutrition" ? "#fff" : COLOR.textMuted,
            border: `1px solid ${view === "nutrition" ? COLOR.textStrong : "#d1d5db"}`,
          }}
        >
          Nutrition
        </button>
        <button
          type="button"
          onClick={() => setViewAndUrl("body")}
          className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
          style={{
            background: view === "body" ? COLOR.textStrong : "#f3f4f6",
            color: view === "body" ? "#fff" : COLOR.textMuted,
            border: `1px solid ${view === "body" ? COLOR.textStrong : "#d1d5db"}`,
          }}
        >
          Body
        </button>
        <button
          type="button"
          onClick={() => setViewAndUrl("coach")}
          className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
          style={{
            background: view === "coach" ? COLOR.textStrong : "#f3f4f6",
            color: view === "coach" ? "#fff" : COLOR.textMuted,
            border: `1px solid ${view === "coach" ? COLOR.textStrong : "#d1d5db"}`,
          }}
        >
          Coach
        </button>
      </div>

      {view === "journal" && (
        <>
          {/* Inline date scrubber — prev/next chevrons + formatted date display */}
          <div className="flex items-center justify-between px-4 py-3">
            <button
              type="button"
              onClick={() => shift(-1)}
              aria-label="Previous day"
              className="px-3 py-1 text-lg text-zinc-400 hover:text-zinc-100"
            >
              ‹
            </button>
            <div className="text-sm font-semibold text-zinc-100">
              {weekday}, {monthDay}
            </div>
            <button
              type="button"
              onClick={() => shift(1)}
              disabled={isToday}
              aria-label="Next day"
              className="px-3 py-1 text-lg text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
            >
              ›
            </button>
          </div>

          <JournalLibraryStrip userId={userId} date={date} />

          {/* kcal ring + macro bars */}
          <SummaryCard
            eaten={eaten}
            target={target}
            burned={burned}
            macros={{
              carbs: {
                eaten:  macroTotals.carbs_g,
                target: targets?.carb_g ?? 0,
              },
              protein: {
                eaten:  macroTotals.protein_g,
                target: targets?.protein_g ?? 0,
              },
              fat: {
                eaten:  macroTotals.fat_g,
                target: targets?.fat_g ?? 0,
              },
            }}
          />

          {/* Four collapsed meal-slot cards */}
          <div className="mt-5">
            <div
              className="mx-4 mb-2 text-[11px] uppercase tracking-wider"
              style={{ color: COLOR.textMuted }}
            >
              Meals
            </div>
            {MEAL_SLOTS.map((slot) => (
              <MealSlotCardCollapsed
                key={slot}
                slot={slot}
                entries={entriesBySlot[slot]}
                targetKcal={slotTargets?.[slot] ?? null}
                date={date}
                onLog={(s) => setLoggerOpen(s)}
                onTapEntry={setEditing}
                onPickFromHistory={() => setHistoryPickerOpen(slot)}
              />
            ))}
          </div>
        </>
      )}

      {view === "nutrition" && <NutritionView userId={userId} />}

      {view === "body" && (
        <HealthClient
          userId={userId}
          todayIso={todayIso}
          trendFromIso={trendFromIso}
          initialView="today"
        />
      )}

      {view === "coach" && (
        <div style={{ height: "calc(100dvh - 200px)", display: "flex", flexDirection: "column" }}>
          <ChatPanel
            userId={userId}
            embedded
            initialKind="coach"
            thread="nora"
            scopeHours={24}
          />
        </div>
      )}

      {/* Sheets — same trio as MealJournalClient; stay mounted regardless of view */}
      {loggerOpen && (
        <MealLoggerSheet
          open
          onClose={() => setLoggerOpen(null)}
          userId={userId}
          initialMealSlot={loggerOpen}
          initialEatenAt={initialEatenAtForLogger()}
        />
      )}
      {historyPickerOpen && (
        <HistoryPickerSheet
          open
          onClose={() => setHistoryPickerOpen(null)}
          userId={userId}
          initialDestinationSlot={historyPickerOpen}
          initialEatenAt={initialEatenAtForLogger()}
          onCommitted={() => setHistoryPickerOpen(null)}
        />
      )}
      {editing && (
        <FoodEntryEditSheet
          entry={editing}
          userId={userId}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}
