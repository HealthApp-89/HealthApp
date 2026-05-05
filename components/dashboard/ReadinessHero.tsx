import { Card } from "@/components/ui/Card";
import { COLOR, SHADOW, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type ReadinessHeroProps = {
  /** 0–100, or null when no data. */
  score: number | null;
  /** Status label e.g. "Primed", "Ready", "Take it easy". */
  status: string;
  /** One-line plain-English subtitle. */
  subtitle: string;
};

export function ReadinessHero({ score, status, subtitle }: ReadinessHeroProps) {
  return (
    <Card
      background={COLOR.accent}
      shadow={SHADOW.heroAccent}
      style={{
        color: "#fff",
        borderRadius: RADIUS.cardHero,
        padding: "18px 20px 20px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: "12px", fontWeight: 600, opacity: 0.85, letterSpacing: "0.02em" }}>
          Readiness
        </span>
        <span
          style={{
            fontSize: "10px",
            fontWeight: 700,
            padding: "4px 8px",
            background: "rgba(255,255,255,0.18)",
            borderRadius: "9999px",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {status}
        </span>
      </div>
      <div
        data-tnum
        style={{
          fontSize: "56px",
          fontWeight: 800,
          letterSpacing: "-0.04em",
          lineHeight: 1,
          marginTop: "6px",
        }}
      >
        {score == null ? "—" : fmtNum(score)}
        {score != null && (
          <span style={{ fontSize: "20px", fontWeight: 600, opacity: 0.7, marginLeft: "4px" }}>/100</span>
        )}
      </div>
      <p style={{ fontSize: "12px", opacity: 0.85, marginTop: "8px", lineHeight: 1.4 }}>{subtitle}</p>
    </Card>
  );
}
