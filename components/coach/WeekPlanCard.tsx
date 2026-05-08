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
