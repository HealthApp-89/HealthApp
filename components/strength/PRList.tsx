import { Card, SectionLabel } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type { PR } from "@/lib/data/workouts";
import { COLOR } from "@/lib/ui/theme";

export function PRList({ prs }: { prs: PR[] }) {
  if (!prs.length) return null;
  return (
    <Card tint="nutrition">
      <SectionLabel>🏆 PERSONAL RECORDS (est. 1RM)</SectionLabel>
      {prs.map((pr) => (
        <div
          key={pr.name}
          className="flex justify-between items-center py-2"
          style={{ borderBottom: `1px solid ${COLOR.divider}` }}
        >
          <div>
            <div className="text-xs" style={{ color: COLOR.textStrong }}>{pr.name.split("(")[0].trim()}</div>
            <div className="text-[10px] mt-px" style={{ color: COLOR.textFaint }}>
              {pr.kg}kg × {pr.reps} · {pr.date}
            </div>
          </div>
          <div className="text-right flex flex-col items-end gap-1">
            <Pill tone="warning">{pr.est1rm} kg 1RM</Pill>
            <div className="text-[9px]" style={{ color: COLOR.textFaint }}>est. 1RM</div>
          </div>
        </div>
      ))}
    </Card>
  );
}
