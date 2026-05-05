import { Card, SectionLabel } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { COLOR } from "@/lib/ui/theme";
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

function priorityToTone(p: string): "danger" | "warning" | "success" | "neutral" {
  if (p === "high")   return "danger";
  if (p === "medium") return "warning";
  if (p === "low")    return "success";
  return "neutral";
}

export function WeeklyReview({ payload, weekStart, weekEnd, mode, daysRemaining }: Props) {
  const headlineRange = MODE_HEADLINE[mode]({ start: weekStart, end: weekEnd, daysRemaining });
  const recsHeadline = (payload.recommendationsHeadline?.trim() || DEFAULT_RECS_HEADLINE[mode]).toUpperCase();
  const recsFootnote =
    mode === "sunday-full"
      ? "Seeded into your Next week list — open that tab to check them off."
      : "Seeded into your Next week list (this-week scope) — open that tab to check them off as you go.";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card tint="coach">
        <SectionLabel>📅 {headlineRange}</SectionLabel>
        <p style={{ fontSize: "14px", color: COLOR.textMid, lineHeight: 1.6, whiteSpace: "pre-line" }}>
          {payload.summary}
        </p>
      </Card>

      {/* Legacy wins/misses — only render if a cached payload still has them. */}
      {payload.wins?.length ? (
        <ItemBlock title="✅ WINS" items={payload.wins} accent="rgba(74,222,128,0.6)" tint="recovery" />
      ) : null}
      {payload.misses?.length ? (
        <ItemBlock title="⚠ MISSES" items={payload.misses} accent="rgba(248,113,113,0.6)" tint="heart" />
      ) : null}

      {payload.patterns?.length ? (
        <ItemBlock title="🔍 PATTERNS" items={payload.patterns} accent="rgba(10,132,255,0.6)" tint="steps" />
      ) : null}

      {payload.recommendations?.length ? (
        <Card tint="coach">
          <SectionLabel>🎯 {recsHeadline}</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {payload.recommendations.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                <Pill tone={priorityToTone(r.priority)}>
                  {r.priority.toUpperCase()}
                </Pill>
                <div style={{ flex: 1 }}>
                  <span
                    style={{
                      fontSize: "10px",
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: COLOR.textFaint,
                      marginRight: "6px",
                    }}
                  >
                    {r.category}
                  </span>
                  <span style={{ fontSize: "12px", color: COLOR.textMid }}>{r.text}</span>
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              fontSize: "10px",
              color: COLOR.textFaint,
              marginTop: "10px",
              fontStyle: "italic",
            }}
          >
            {recsFootnote}
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
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {items.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: "10px" }}>
            <span style={{ fontSize: "16px", flexShrink: 0, color: accent }}>◈</span>
            <div>
              <div style={{ fontSize: "12px", fontWeight: 600, color: COLOR.textMid }}>{p.label}</div>
              <div style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "2px", lineHeight: 1.5 }}>
                {p.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
