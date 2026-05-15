"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { useBodyMeasurements } from "@/lib/query/hooks/useBodyMeasurements";
import { useHealthTrend } from "@/lib/query/hooks/useHealthTrend";
import { HealthNav, type HealthView } from "@/components/health/HealthNav";
import { BodyCompCard } from "@/components/health/BodyCompCard";
import { MeasurementCard } from "@/components/health/MeasurementCard";
import { MeasurementHistory } from "@/components/health/MeasurementHistory";
import { TrendView } from "@/components/health/TrendView";
import { MeasurementForm } from "@/components/health/MeasurementForm";
import type { BodyMeasurement } from "@/lib/data/types";

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86_400_000);
}

export function HealthClient({
  userId,
  todayIso,
  trendFromIso,
  initialView,
}: {
  userId: string;
  todayIso: string;
  /** ymFrom — 12 months before todayIso, ISO date. */
  trendFromIso: string;
  initialView: HealthView;
}) {
  const [view, setView] = useState<HealthView>(initialView);
  const [editing, setEditing] = useState<BodyMeasurement | null | "new">(null);

  const meas = useBodyMeasurements(userId);
  const bodyComp = useHealthTrend(userId, trendFromIso, todayIso);

  const measRows = meas.data ?? [];
  const latest = measRows[0] ?? null;
  const prev = measRows[1] ?? null;

  const bodyCompPoints = bodyComp.data ?? [];

  // Map daily_logs date → weight_kg for the Log view's joined display.
  const weightByDate = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const p of bodyCompPoints) m.set(p.date, p.weight_kg);
    return m;
  }, [bodyCompPoints]);

  const existingDates = useMemo(() => measRows.map((r) => r.measured_on), [measRows]);

  const overdue =
    latest && daysBetween(latest.measured_on, todayIso) > 30
      ? daysBetween(latest.measured_on, todayIso)
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "12px", paddingBottom: "100px" }}>
      <HealthNav active={view} onChange={setView} />

      {view === "today" && (
        <>
          {overdue !== null && (
            <Card variant="compact">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "13px", color: COLOR.textMid }}>
                  Last measured {overdue} days ago
                </span>
                <button
                  type="button"
                  onClick={() => setEditing("new")}
                  style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                >
                  Log new
                </button>
              </div>
            </Card>
          )}

          <BodyCompCard points={bodyCompPoints} todayIso={todayIso} />

          <MeasurementCard
            latest={latest}
            prev={prev}
            onLogNew={() => setEditing("new")}
            onEdit={() => latest && setEditing(latest)}
          />

          {latest && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "12px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}
            >
              + Log new measurement
            </button>
          )}
        </>
      )}

      {view === "trend" && (
        <TrendView
          bodyComp={bodyCompPoints}
          measurements={measRows}
          todayIso={todayIso}
          trendFromIso={trendFromIso}
        />
      )}

      {view === "log" && (
        <>
          <MeasurementHistory
            userId={userId}
            rows={measRows}
            weightByDate={weightByDate}
            onEdit={(row) => setEditing(row)}
          />
          <button
            type="button"
            onClick={() => setEditing("new")}
            style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "12px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}
          >
            + Log new measurement
          </button>
        </>
      )}

      {editing !== null && (
        <MeasurementForm
          userId={userId}
          existing={editing === "new" ? null : editing}
          existingDates={existingDates}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
