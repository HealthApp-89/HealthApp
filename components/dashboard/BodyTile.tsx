import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";

function isoNDaysAgo(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function BodyTile({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const todayIso = todayInUserTz();
  // Reach back 60 days so the 30d-prior baseline lookup (today-35 .. today-25)
  // has a chance of hitting a non-null reading even when Withings sync gaps.
  const lookbackFromIso = isoNDaysAgo(todayIso, 60);

  // Pull recent body-comp + latest measurement in parallel.
  const [{ data: logs }, { data: meas }] = await Promise.all([
    supabase
      .from("daily_logs")
      .select("date, weight_kg")
      .eq("user_id", userId)
      .gte("date", lookbackFromIso)
      .lte("date", todayIso)
      .not("weight_kg", "is", null)
      .order("date", { ascending: false })
      .limit(60),
    supabase
      .from("body_measurements")
      .select("measured_on, mid_waist_cm")
      .eq("user_id", userId)
      .order("measured_on", { ascending: false })
      .limit(2),
  ]);

  // Latest weight + 30d-prior baseline (nearest non-null in [today-35, today-25]).
  const weightLatest = logs && logs.length ? (logs[0].weight_kg as number | null) : null;
  let weightBaseline: number | null = null;
  if (logs && logs.length) {
    const lo = isoNDaysAgo(todayIso, 35);
    const hi = isoNDaysAgo(todayIso, 25);
    for (const r of logs) {
      const d = r.date as string;
      if (d >= lo && d <= hi && r.weight_kg != null) {
        weightBaseline = r.weight_kg as number;
        break;
      }
    }
  }
  const dWeight =
    weightLatest != null && weightBaseline != null ? weightLatest - weightBaseline : null;

  // Latest mid-waist + Δ vs prior measurement (any cadence).
  const mLatest = meas && meas.length ? meas[0] : null;
  const mPrev = meas && meas.length > 1 ? meas[1] : null;
  const waistLatest = mLatest?.mid_waist_cm ?? null;
  const dWaist =
    waistLatest != null && mPrev?.mid_waist_cm != null
      ? waistLatest - (mPrev.mid_waist_cm as number)
      : null;

  // Overdue chip
  let overdue = false;
  if (mLatest) {
    const last = new Date(mLatest.measured_on + "T00:00:00Z");
    const today = new Date(todayIso + "T00:00:00Z");
    overdue = (today.getTime() - last.getTime()) / 86_400_000 > 30;
  }

  return (
    <Link href="/diet?view=body" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Body
          </span>
          <span style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 600 }}>
            {overdue ? "30d+ overdue ›" : "Open ›"}
          </span>
        </div>

        <Row label="Weight" value={weightLatest} unit="kg" delta={dWeight} goodWhenLower />
        <Row
          label="Mid waist"
          value={waistLatest}
          unit="cm"
          delta={dWaist}
          goodWhenLower
          emptyHint={mLatest ? null : "Log first measurement"}
        />
      </Card>
    </Link>
  );
}

function Row({
  label,
  value,
  unit,
  delta,
  goodWhenLower,
  emptyHint,
}: {
  label: string;
  value: number | null;
  unit: string;
  delta: number | null;
  goodWhenLower: boolean;
  emptyHint?: string | null;
}) {
  if (value == null && emptyHint) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: `1px solid ${COLOR.divider}`, fontSize: "13px" }}>
        <span style={{ color: COLOR.textMid }}>{label}</span>
        <span style={{ color: COLOR.textFaint, fontStyle: "italic" }}>{emptyHint}</span>
      </div>
    );
  }
  const dColor =
    delta == null
      ? COLOR.textFaint
      : delta === 0
      ? COLOR.textFaint
      : (goodWhenLower ? delta < 0 : delta > 0)
      ? COLOR.success
      : COLOR.danger;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "10px", padding: "6px 0", borderTop: `1px solid ${COLOR.divider}`, alignItems: "baseline" }}>
      <span style={{ fontSize: "13px", color: COLOR.textMid }}>{label}</span>
      <span data-tnum style={{ fontSize: "14px", color: COLOR.textStrong, fontWeight: 700, textAlign: "right" }}>
        {fmtNum(value)} {unit}
      </span>
      <span data-tnum style={{ fontSize: "11px", color: dColor, fontWeight: 600, textAlign: "right" }}>
        {delta == null ? "—" : `${delta > 0 ? "+" : ""}${fmtNum(delta)}`}
      </span>
    </div>
  );
}
