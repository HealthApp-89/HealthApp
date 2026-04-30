import { Card, SectionLabel } from "@/components/ui/Card";
import type { PR } from "@/lib/data/workouts";

export function PRList({ prs }: { prs: PR[] }) {
  if (!prs.length) return null;
  return (
    <Card>
      <SectionLabel>🏆 PERSONAL RECORDS (est. 1RM)</SectionLabel>
      {prs.map((pr) => (
        <div
          key={pr.name}
          className="flex justify-between items-center py-2"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
        >
          <div>
            <div className="text-xs text-white/75">{pr.name.split("(")[0].trim()}</div>
            <div className="text-[10px] text-white/30 mt-px">
              {pr.kg}kg × {pr.reps} · {pr.date}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[20px] font-bold font-mono" style={{ color: "#ffd93d" }}>
              {pr.est1rm}
            </div>
            <div className="text-[9px] text-white/25">kg 1RM</div>
          </div>
        </div>
      ))}
    </Card>
  );
}
