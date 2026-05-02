import { Card, SectionLabel } from "@/components/ui/Card";
import { PrioBox } from "@/components/ui/PrioBox";
import type { TintKey } from "@/lib/ui/tints";
import type { ReviewMode } from "@/lib/coach/week";

type Item = { label: string; detail: string };
type Recommendation = {
  category: string;
  priority: "high" | "medium" | "low" | string;
  text: string;
};

export type WeeklyReviewPayload = {
  summary: string;
  patterns: Item[];
  recommendationsHeadline?: string;
  recommendations: Recommendation[];
  mode?: ReviewMode;
  /** Legacy fields from earlier prompt versions — render if present. */
  wins?: Item[];
  misses?: Item[];
};

type Props = {
  payload: WeeklyReviewPayload;
  weekStart: string;
  weekEnd: string;
  mode: ReviewMode;
  daysRemaining: number;
};

const MODE_HEADLINE: Record<ReviewMode, (args: { start: string; end: string; daysRemaining: number }) => string> = {
  "monday-recap": ({ start, end }) => `LAST WEEK · ${start} → ${end}`,
  "in-progress": ({ start, end, daysRemaining }) =>
    `WEEK SO FAR · ${start} → ${end} · ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`,
  "sunday-full": ({ start, end }) => `FULL WEEK · ${start} → ${end}`,
};

const DEFAULT_RECS_HEADLINE: Record<ReviewMode, string> = {
  "monday-recap": "WEEK AHEAD",
  "in-progress": "FINISH STRONG",
  "sunday-full": "NEXT WEEK",
};

export function WeeklyReview({ payload, weekStart, weekEnd, mode, daysRemaining }: Props) {
  const headlineRange = MODE_HEADLINE[mode]({ start: weekStart, end: weekEnd, daysRemaining });
  const recsHeadline = (payload.recommendationsHeadline?.trim() || DEFAULT_RECS_HEADLINE[mode]).toUpperCase();
  const recsFootnote =
    mode === "sunday-full"
      ? "Seeded into your Next week list — open that tab to check them off."
      : "Seeded into your Next week list (this-week scope) — open that tab to check them off as you go.";

  return (
    <div className="flex flex-col gap-3.5">
      <Card tint="coach">
        <SectionLabel>📅 {headlineRange}</SectionLabel>
        <p className="text-sm text-white/75 leading-relaxed whitespace-pre-line">{payload.summary}</p>
      </Card>

      {/* Legacy wins/misses — only render if a cached payload still has them. */}
      {payload.wins?.length ? (
        <ItemBlock title="✅ WINS" items={payload.wins} accent="rgba(74,222,128,0.6)" tint="recovery" />
      ) : null}
      {payload.misses?.length ? (
        <ItemBlock title="⚠ MISSES" items={payload.misses} accent="rgba(248,113,113,0.6)" tint="heart" />
      ) : null}

      {payload.patterns?.length ? (
        <ItemBlock title="🔍 PATTERNS" items={payload.patterns} accent="rgba(0,245,196,0.6)" tint="steps" />
      ) : null}

      {payload.recommendations?.length ? (
        <Card tint="coach">
          <SectionLabel>🎯 {recsHeadline}</SectionLabel>
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
          <div className="text-[10px] text-white/25 mt-2.5 italic">{recsFootnote}</div>
        </Card>
      ) : null}
    </div>
  );
}

function ItemBlock({
  title,
  items,
  accent,
  tint,
}: {
  title: string;
  items: Item[];
  accent: string;
  tint?: TintKey;
}) {
  return (
    <Card tint={tint}>
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
