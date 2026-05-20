"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ChatPanel from "@/components/chat/ChatPanel";
import { BodyCompCard } from "@/components/health/BodyCompCard";
import { useMarkThreadSeen } from "@/lib/chat/use-mark-thread-seen";
import { MealSlotCard } from "@/components/meal/MealSlotCard";
import { MealSlotEmptyCard } from "@/components/meal/MealSlotEmptyCard";
import { Glp1StatusPill } from "@/components/diet/Glp1StatusPill";
import { FoodEntryEditSheet } from "@/components/log/FoodEntryEditSheet";
import { HistoryPickerSheet } from "@/components/log/HistoryPickerSheet";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { useHealthTrend } from "@/lib/query/hooks/useHealthTrend";
import { targetsForAllSlots } from "@/lib/food/meal-targets";
import { MEAL_SLOTS } from "@/lib/food/meal-slot";
import { todayInUserTz, ymdInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

type Props = { userId: string };

export function DietCoachClient({ userId }: Props) {
  useMarkThreadSeen("nora");
  const router = useRouter();
  const today = todayInUserTz();

  // 35-day window for BodyCompCard's 30d-vs-baseline comparison
  const trendFrom = ymdInUserTz(
    new Date(Date.now() - 36 * 24 * 60 * 60 * 1000),
  );

  const { data: targets } = useTodayTargets(userId, today);
  const { data: entries = [] } = useFoodEntries(userId, today, today);
  const { data: trendPoints = [] } = useHealthTrend(userId, trendFrom, today);

  // Sheet state — inline sheets so the Coach tab has logging affordances
  const [loggerOpen, setLoggerOpen] = useState<MealSlot | null>(null);
  const [historyPickerOpen, setHistoryPickerOpen] = useState<MealSlot | null>(
    null,
  );
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);

  // Group entries by slot
  const entriesBySlot: Record<MealSlot, FoodLogEntry[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snack: [],
  };
  for (const e of entries) {
    if (e.meal_slot in entriesBySlot) {
      entriesBySlot[e.meal_slot].push(e);
    }
  }

  // Slot kcal targets derived from day-level target + optional meal ratios
  const slotTargets = targets
    ? targetsForAllSlots(targets.kcal, targets.meal_ratios)
    : null;

  // Day-level macro totals from committed entries
  const logged = entries.reduce(
    (acc, e) => ({
      kcal: acc.kcal + e.totals.kcal,
      p: acc.p + e.totals.protein_g,
      c: acc.c + e.totals.carbs_g,
      f: acc.f + e.totals.fat_g,
      fiber: acc.fiber + e.totals.fiber_g,
    }),
    { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 },
  );

  const initialEatenAt =
    today === todayInUserTz()
      ? new Date().toISOString()
      : `${today}T12:00:00.000Z`;

  const goToLog = () => router.push("/diet?tab=log");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100dvh - 88px)",
      }}
    >
      {/* ── Data block ─────────────────────────────────────────── */}
      <div
        style={{
          flex: "0 0 auto",
          padding: "8px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* Header line: kcal logged vs target + GLP-1 pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, color: COLOR.textMid }}>
            <strong style={{ color: COLOR.textStrong }}>
              {Math.round(logged.kcal)}
            </strong>
            {" / "}
            {targets != null ? targets.kcal : "—"} kcal
          </div>
          <Glp1StatusPill userId={userId} date={today} />
        </div>

        {/* Macro strip: P / C / F / Fiber */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 6,
          }}
        >
          <MacroTile
            label="Protein g"
            value={Math.round(logged.p)}
            target={targets?.protein_g ?? null}
          />
          <MacroTile
            label="Carbs g"
            value={Math.round(logged.c)}
            target={targets?.carb_g ?? null}
          />
          <MacroTile
            label="Fat g"
            value={Math.round(logged.f)}
            target={targets?.fat_g ?? null}
          />
          <MacroTile
            label="Fiber g"
            value={Math.round(logged.fiber)}
            target={null}
          />
        </div>

        {/* Per-slot summary cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {MEAL_SLOTS.map((slot) => {
            const slotEntries = entriesBySlot[slot];
            const slotTarget = slotTargets?.[slot] ?? null;
            if (slotEntries.length === 0) {
              return (
                <MealSlotEmptyCard
                  key={slot}
                  slot={slot}
                  targetKcal={slotTarget}
                  date={today}
                  onLog={() => setLoggerOpen(slot)}
                  onPickFromHistory={() => setHistoryPickerOpen(slot)}
                />
              );
            }
            return (
              <MealSlotCard
                key={slot}
                slot={slot}
                entries={slotEntries}
                targetKcal={slotTarget}
                onLog={() => setLoggerOpen(slot)}
                onTapEntry={setEditing}
              />
            );
          })}
        </div>

        {/* Body composition strip */}
        <BodyCompCard points={trendPoints} todayIso={today} />
      </div>

      {/* ── Chat block — Nora (nutrition specialist) ────────────── */}
      <div
        style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "column",
          minHeight: 320,
        }}
      >
        <ChatPanel
          userId={userId}
          embedded={true}
          initialKind="coach"
          thread="nora"
        />
      </div>

      {/* ── Inline sheets (same set as MealJournalClient) ────────── */}
      {loggerOpen && (
        <MealLoggerSheet
          open
          onClose={() => setLoggerOpen(null)}
          userId={userId}
          initialMealSlot={loggerOpen}
          initialEatenAt={initialEatenAt}
        />
      )}
      {historyPickerOpen && (
        <HistoryPickerSheet
          open={true}
          onClose={() => setHistoryPickerOpen(null)}
          userId={userId}
          initialDestinationSlot={historyPickerOpen}
          initialEatenAt={initialEatenAt}
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
    </div>
  );
}

function MacroTile({
  label,
  value,
  target,
}: {
  label: string;
  value: number;
  target: number | null;
}) {
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        padding: "8px 10px",
        borderRadius: 6,
        textAlign: "center",
      }}
    >
      <div
        style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}
        data-tnum
      >
        {fmtNum(value)}
      </div>
      <div style={{ fontSize: 9, color: COLOR.textMuted, marginTop: 2 }}>
        {label}
        {target != null ? ` (${Math.round(target)})` : ""}
      </div>
    </div>
  );
}
