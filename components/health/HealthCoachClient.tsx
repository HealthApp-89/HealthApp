"use client";

import ChatPanel from "@/components/chat/ChatPanel";
import { useMarkThreadSeen } from "@/lib/chat/use-mark-thread-seen";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";
import type { Checkin } from "@/lib/query/fetchers/checkin";
import { openMorningIntake } from "@/components/morning/MorningIntakeHost";

type Props = {
  userId: string;
  /** Pre-fetched HRV baseline from profiles.whoop_baselines.hrv_mean.
   *  Passed from the Server Component so we don't add an extra client hook. */
  hrvBaseline: number | null;
};

export function HealthCoachClient({ userId, hrvBaseline }: Props) {
  useMarkThreadSeen("remi");
  const today = todayInUserTz();

  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yIso = yesterday.toISOString().slice(0, 10);

  const sevenDaysAgo = new Date(`${today}T00:00:00Z`);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const sevenIso = sevenDaysAgo.toISOString().slice(0, 10);

  const { data: todayLogs } = useDailyLogs(userId, today, today);
  const { data: yesterdayLogs } = useDailyLogs(userId, yIso, yIso);
  const { data: weekLogs } = useDailyLogs(userId, sevenIso, yIso);
  const { data: checkin } = useCheckin(userId, today);

  const todayRow = todayLogs?.[0] ?? null;
  const yRow = yesterdayLogs?.[0] ?? null;

  // Recovery: prefer today's (WHOOP writes same-day), fall back to yesterday
  const recovery = todayRow?.recovery ?? yRow?.recovery ?? null;
  const recoveryTier =
    recovery == null
      ? null
      : recovery < 34
      ? "low"
      : recovery < 67
      ? "ok"
      : "high";

  // Stat tiles: yesterday's WHOOP values are the most recently completed data
  const hrv = yRow?.hrv ?? todayRow?.hrv ?? null;
  const rhr = yRow?.resting_hr ?? todayRow?.resting_hr ?? null;
  const sleepHours = yRow?.sleep_hours ?? null;
  // DailyLog has no sleep_efficiency column — use sleep_score (0-100) instead
  const sleepScore = yRow?.sleep_score ?? null;
  const strain = yRow?.strain ?? null;

  // HRV 7-day series (chronological, oldest first), used for the sparkline
  // and the 7d-avg subtitle. Filter out null rows; if the user has gaps, the
  // sparkline just shows fewer points.
  const hrvSeries: { date: string; hrv: number }[] = (weekLogs ?? [])
    .slice()
    .filter((r): r is typeof r & { hrv: number } => r.hrv != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ date: r.date, hrv: r.hrv }));
  const hrv7d = avg(hrvSeries.map((p) => p.hrv));
  const hrvDelta =
    hrv != null && hrvBaseline != null ? Math.round(hrv - hrvBaseline) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100dvh - 88px)",
      }}
    >
      {/* ── Summary cluster ── */}
      <div
        style={{
          flex: "0 0 auto",
          padding: "12px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* Recovery hero */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span
            style={{
              fontSize: 36,
              fontWeight: 700,
              color:
                recovery == null
                  ? COLOR.textMuted
                  : recovery >= 67
                  ? COLOR.success
                  : recovery >= 34
                  ? COLOR.warning
                  : COLOR.danger,
            }}
          >
            {recovery != null ? Math.round(recovery) : "—"}
          </span>
          <span style={{ fontSize: 13, color: COLOR.textMuted }}>
            recovery{recoveryTier ? ` · ${recoveryTier}` : ""}
          </span>
        </div>

        {/* Stat tiles row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 6,
          }}
        >
          <StatTile
            label="HRV"
            value={hrv != null ? `${Math.round(hrv)}` : "—"}
            unit="ms"
          />
          <StatTile
            label="RHR"
            value={rhr != null ? `${Math.round(rhr)}` : "—"}
            unit="bpm"
          />
          <StatTile
            label="Sleep"
            value={sleepHours != null ? sleepHours.toFixed(1) : "—"}
            unit="h"
          />
          <StatTile
            label="Score"
            value={sleepScore != null ? `${Math.round(sleepScore)}` : "—"}
            unit="/100"
          />
          <StatTile
            label="Strain"
            value={strain != null ? strain.toFixed(1) : "—"}
            unit="/21"
          />
        </div>

        {/* HRV trend: sparkline + text subtitle */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <HrvSparkline series={hrvSeries} baseline={hrvBaseline} todayHrv={hrv} />
          <div style={{ fontSize: 12, color: COLOR.textMid }}>
            HRV {hrv != null ? `${Math.round(hrv)} ms` : "—"}
            {hrv7d != null ? ` · 7d avg ${Math.round(hrv7d)}` : ""}
            {hrvBaseline != null ? ` · baseline ${Math.round(hrvBaseline)} ms` : ""}
            {hrvDelta != null
              ? ` · ${hrvDelta >= 0 ? "↑" : "↓"}${Math.abs(hrvDelta)} vs baseline`
              : ""}
          </div>
        </div>

        {/* Morning feel */}
        <MorningFeelRow checkin={checkin ?? null} />
      </div>

      {/* ── Remi chat (flex-grows to fill remaining vertical space) ── */}
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
          thread="remi"
        />
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function StatTile({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        padding: "8px 6px",
        borderRadius: 6,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: COLOR.textMuted, marginTop: 2 }}>
        {label}
        {unit ? ` (${unit})` : ""}
      </div>
    </div>
  );
}

function MorningFeelRow({ checkin }: { checkin: Checkin | null }) {
  // Haven't loaded or intake not started yet
  if (
    checkin == null ||
    checkin.intake_state === "pending" ||
    checkin.intake_state === "awaiting_feel" ||
    checkin.intake_state === "awaiting_sickness_notes" ||
    checkin.intake_state === "awaiting_whoop"
  ) {
    return (
      <button
        type="button"
        onClick={openMorningIntake}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: COLOR.surfaceAlt,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 6,
          padding: "10px 12px",
          fontSize: 12,
          color: COLOR.textMid,
          cursor: "pointer",
        }}
      >
        <span style={{ fontWeight: 600, color: COLOR.textStrong }}>
          Start morning intake →
        </span>
        <span style={{ marginLeft: 6 }}>not yet completed today</span>
      </button>
    );
  }

  const parts: string[] = [];

  // sick is boolean on CheckinRow
  if (checkin.sick) {
    parts.push(
      checkin.sickness_notes ? `sick: ${checkin.sickness_notes}` : "sick",
    );
  }
  if (checkin.fatigue && checkin.fatigue !== "none") {
    parts.push(`fatigue: ${checkin.fatigue}`);
  }
  if (checkin.bloating) {
    parts.push("bloating");
  }
  if (checkin.soreness_areas && checkin.soreness_areas.length > 0) {
    const areas = checkin.soreness_areas.join(", ");
    const sev = checkin.soreness_severity ? ` (${checkin.soreness_severity})` : "";
    parts.push(`sore: ${areas}${sev}`);
  }

  if (parts.length === 0) {
    return (
      <div style={{ fontSize: 12, color: COLOR.success }}>
        Morning feel: clean (no flags)
      </div>
    );
  }

  return (
    <div
      style={{
        fontSize: 12,
        color: COLOR.warningDeep,
        background: COLOR.warningSoft,
        padding: "6px 10px",
        borderRadius: 6,
      }}
    >
      {parts.join(" · ")}
    </div>
  );
}

/**
 * Tiny inline SVG sparkline for the 7-day HRV trend.
 *
 * - Polyline drawn through HRV points, oldest → newest left→right.
 * - Dashed horizontal reference line at the user's baseline (when known).
 * - Last point gets a filled dot.
 * - Color reflects the latest point vs baseline: success when ≥ baseline,
 *   warning when below by ≤10%, danger when further below.
 *
 * No chart library — recharts would add bundle weight + render overhead
 * disproportionate to ~7 points in a 24px-tall strip.
 */
function HrvSparkline({
  series,
  baseline,
  todayHrv,
}: {
  series: { date: string; hrv: number }[];
  baseline: number | null;
  todayHrv: number | null;
}) {
  // At least 2 points needed for a line; render nothing otherwise.
  if (series.length < 2) {
    return <div style={{ height: 24 }} />;
  }

  const W = 280;
  const H = 24;
  const PAD = 2;

  // Y-axis range includes the baseline so the dashed line is visible.
  const values = series.map((p) => p.hrv);
  const candidates = [...values, ...(baseline != null ? [baseline] : []), ...(todayHrv != null ? [todayHrv] : [])];
  const min = Math.min(...candidates);
  const max = Math.max(...candidates);
  const span = max - min || 1;

  const xFor = (i: number) =>
    PAD + (i / (series.length - 1)) * (W - 2 * PAD);
  const yFor = (v: number) =>
    PAD + (1 - (v - min) / span) * (H - 2 * PAD);

  const points = series
    .map((p, i) => `${xFor(i)},${yFor(p.hrv)}`)
    .join(" ");

  const last = series[series.length - 1];
  const baselineY = baseline != null ? yFor(baseline) : null;

  // Latest point tone vs baseline. Dots/lines color follow.
  const lineColor =
    baseline == null || todayHrv == null
      ? COLOR.accent
      : todayHrv >= baseline
      ? COLOR.success
      : todayHrv >= baseline * 0.9
      ? COLOR.warning
      : COLOR.danger;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={H}
      aria-label="HRV 7-day trend"
      role="img"
    >
      {baselineY != null && (
        <line
          x1={0}
          x2={W}
          y1={baselineY}
          y2={baselineY}
          stroke={COLOR.textFaint}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <polyline
        fill="none"
        stroke={lineColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
      <circle
        cx={xFor(series.length - 1)}
        cy={yFor(last.hrv)}
        r={2.5}
        fill={lineColor}
      />
    </svg>
  );
}
