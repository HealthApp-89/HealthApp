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
  if (!("block" in data)) {
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

  const p = data; // TypeScript narrows: "block" in data → active payload branch
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
