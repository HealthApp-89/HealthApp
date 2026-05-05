import type { DailyPlan } from "@/lib/coach/readiness";
import { Card } from "@/components/ui/Card";
import { RADIUS, modeColorLight } from "@/lib/ui/theme";

type Props = {
  plan: DailyPlan;
};

/** Light-theme session plan card for the strength page.
 *  Shows session type, mode intensity, description, and full exercise list. */
export function TodayPlanCard({ plan }: Props) {
  const accent = modeColorLight(plan.mode.color);

  return (
    <Card
      background={accent}
      shadow={`0 12px 24px -8px ${accent}55`}
      style={{ color: "#fff", borderRadius: RADIUS.cardHero, padding: "16px 18px" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div
            style={{
              fontSize: "10px",
              opacity: 0.85,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Today&apos;s session
          </div>
          <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "2px" }}>
            {plan.sessionType === "REST" ? "Rest day" : `💪 ${plan.sessionType}`}
          </div>
        </div>
        <span
          style={{
            fontSize: "10px",
            padding: "4px 8px",
            background: "rgba(255,255,255,0.18)",
            borderRadius: "9999px",
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {plan.mode.label.replace(/^[^\s]+\s/, "")}
        </span>
      </div>
      <p style={{ fontSize: "12px", opacity: 0.85, marginTop: "8px", lineHeight: 1.4 }}>
        {plan.mode.desc}
      </p>

      {plan.sessionType !== "REST" && plan.exercises.length > 0 && (
        <div style={{ marginTop: "12px" }}>
          {plan.exercises.map((ex) => (
            <div
              key={ex.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "6px 0",
                borderTop: "1px solid rgba(255,255,255,0.18)",
                fontSize: "12px",
              }}
            >
              <span style={{ opacity: 0.85 }}>{ex.name.split("(")[0].trim()}</span>
              <span data-tnum style={{ fontWeight: 600, opacity: 0.95 }}>
                {ex.target}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
