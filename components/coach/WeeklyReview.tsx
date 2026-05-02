import { Card, SectionLabel } from "@/components/ui/Card";
import { PrioBox } from "@/components/ui/PrioBox";

type Item = { label: string; detail: string };
type Recommendation = {
  category: string;
  priority: "high" | "medium" | "low" | string;
  text: string;
};

export type WeeklyReviewPayload = {
  summary: string;
  wins: Item[];
  misses: Item[];
  patterns: Item[];
  recommendations: Recommendation[];
};

type Props = {
  payload: WeeklyReviewPayload;
  weekStart: string;
  weekEnd: string;
};

export function WeeklyReview({ payload, weekStart, weekEnd }: Props) {
  return (
    <div className="flex flex-col gap-3.5">
      <Card>
        <SectionLabel>📅 WEEK · {weekStart} → {weekEnd}</SectionLabel>
        <p className="text-sm text-white/70 leading-relaxed">{payload.summary}</p>
      </Card>

      {payload.wins?.length ? (
        <ItemBlock title="✅ WINS" items={payload.wins} accent="rgba(74,222,128,0.6)" />
      ) : null}
      {payload.misses?.length ? (
        <ItemBlock title="⚠ MISSES" items={payload.misses} accent="rgba(248,113,113,0.6)" />
      ) : null}
      {payload.patterns?.length ? (
        <ItemBlock title="🔍 PATTERNS" items={payload.patterns} accent="rgba(0,245,196,0.6)" />
      ) : null}

      {payload.recommendations?.length ? (
        <Card>
          <SectionLabel>🎯 NEXT WEEK · seeded</SectionLabel>
          <div className="flex flex-col gap-2">
            {payload.recommendations.map((r, i) => (
              <div key={i} className="flex gap-2 items-start">
                <PrioBox level={r.priority} />
                <div className="flex-1">
                  <span className="text-[9px] uppercase tracking-[0.1em] text-white/30 mr-1.5">
                    {r.category}
                  </span>
                  <span className="text-xs text-white/70">{r.text}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-white/25 mt-2.5 italic">
            These are seeded into your Next week list — open that tab to check them off.
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function ItemBlock({
  title,
  items,
  accent,
}: {
  title: string;
  items: Item[];
  accent: string;
}) {
  return (
    <Card>
      <SectionLabel color={accent}>{title}</SectionLabel>
      <div className="flex flex-col gap-2.5">
        {items.map((p, i) => (
          <div key={i} className="flex gap-2.5">
            <span className="text-base flex-shrink-0" style={{ color: accent }}>
              ◈
            </span>
            <div>
              <div className="text-xs font-semibold text-white/80">{p.label}</div>
              <div className="text-[11px] text-white/40 mt-0.5 leading-relaxed">{p.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
