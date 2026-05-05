import { Card, SectionLabel } from "@/components/ui/Card";
import { StatusRow } from "@/components/ui/StatusRow";
import { COLOR } from "@/lib/ui/theme";
import type { DailyLog } from "@/lib/data/types";
import { avg } from "@/lib/ui/score";

export function BaselinesPanel({ logs }: { logs: DailyLog[] }) {
  const window = 180;
  const recent = logs.slice(-window);
  const hrv = avg(recent.map((l) => l.hrv));
  const rhr = avg(recent.map((l) => l.resting_hr));
  const rec = avg(recent.map((l) => l.recovery));
  const slp = avg(recent.map((l) => l.sleep_score));
  const days = recent.length;
  const fmt = (v: number | null, fixed = 1) => (v === null ? "—" : v.toFixed(fixed));

  return (
    <Card>
      <SectionLabel>BASELINES (last 180 days)</SectionLabel>
      <div
        style={{
          borderRadius: "12px",
          overflow: "hidden",
          border: `1px solid ${COLOR.divider}`,
        }}
      >
        <StatusRow
          label="HRV baseline"
          value={
            <span style={{ fontFamily: "monospace", color: COLOR.textStrong }}>
              {fmt(hrv)}{" "}
              <span style={{ color: COLOR.textFaint, fontSize: "11px" }}>ms</span>
            </span>
          }
        />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <StatusRow
          label="Resting HR baseline"
          value={
            <span style={{ fontFamily: "monospace", color: COLOR.textStrong }}>
              {fmt(rhr, 0)}{" "}
              <span style={{ color: COLOR.textFaint, fontSize: "11px" }}>bpm</span>
            </span>
          }
        />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <StatusRow
          label="Recovery baseline"
          value={
            <span style={{ fontFamily: "monospace", color: COLOR.textStrong }}>
              {fmt(rec, 0)}{" "}
              <span style={{ color: COLOR.textFaint, fontSize: "11px" }}>%</span>
            </span>
          }
        />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <StatusRow
          label="Sleep score baseline"
          value={
            <span style={{ fontFamily: "monospace", color: COLOR.textStrong }}>
              {fmt(slp, 0)}{" "}
              <span style={{ color: COLOR.textFaint, fontSize: "11px" }}>/100</span>
            </span>
          }
        />
      </div>
      <div
        style={{
          fontSize: "10px",
          color: COLOR.textFaint,
          marginTop: "10px",
        }}
      >
        Based on {days} log days
      </div>
    </Card>
  );
}
