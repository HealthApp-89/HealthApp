"use client";

import ChatPanel from "@/components/chat/ChatPanel";
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

  // HRV 7-day average (over the past week excluding today)
  const hrv7d = avg(
    weekLogs?.map((r) => r.hrv).filter((v): v is number => v != null) ?? [],
  );
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

        {/* HRV trend line */}
        <div
          style={{ fontSize: 12, color: COLOR.textMid, padding: "2px 0" }}
        >
          HRV {hrv != null ? `${Math.round(hrv)} ms` : "—"}
          {hrv7d != null ? ` · 7d avg ${Math.round(hrv7d)}` : ""}
          {hrvBaseline != null ? ` · baseline ${Math.round(hrvBaseline)} ms` : ""}
          {hrvDelta != null
            ? ` · ${hrvDelta >= 0 ? "↑" : "↓"}${Math.abs(hrvDelta)} vs baseline`
            : ""}
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
