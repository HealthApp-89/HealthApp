import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type RecentSession = {
  date: string;       // e.g. "MON 4"
  title: string;      // e.g. "Lower body · Squat"
  volumeKg: number;
  bwReps: number;     // total bodyweight reps for the session (working sets)
};

type RecentLiftsCardProps = {
  sessions: RecentSession[]; // pass at most 2; renders nothing if empty
};

export function RecentLiftsCard({ sessions }: RecentLiftsCardProps) {
  return (
    <Link href="/strength?view=recent" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Recent lifts
          </span>
          <span style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 600 }}>View all ›</span>
        </div>
        {sessions.length === 0 ? (
          <p style={{ fontSize: "13px", color: COLOR.textFaint, padding: "8px 0" }}>
            No recent sessions in the last 14 days.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {sessions.slice(0, 2).map((s) => (
              <div
                key={s.date}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: `1px solid ${COLOR.divider}` }}
              >
                <div>
                  <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.06em" }}>{s.date}</div>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: COLOR.textStrong, marginTop: "2px" }}>{s.title}</div>
                </div>
                <div data-tnum style={{ fontSize: "12px", color: COLOR.accent, fontWeight: 600 }}>
                  {s.volumeKg > 0 ? `${fmtNum(s.volumeKg)} kg` : `${s.bwReps} reps`}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Link>
  );
}
